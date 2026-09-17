"""One run's events, folded into the account the reader is given.

A job already tells the world what it is doing: phase transitions
(``jobs/phase_events.py``), the sources its tools returned and the todos it kept
(``jobs/callbacks.py``), and the three terminal facts the runner writes
(``job.error``, ``job.cancelled``, ``job.degraded``). Each of those is a row in
``job_events`` that a live client can watch and nobody can read tomorrow. This
module turns the same stream into the run's LEDGER — phases, steps described by
the intent the runner stated, the documents each step reached, and how it ended
— and flushes it to the one place a ledger is stored, the run's own message
(``jobs/run_ledger_client.py``, ADR-0055, ADR-0062).

**One fold, one truth.** Every flush does two things with the SAME snapshot: it
posts the new part of it to the BFF, and it emits a ``run.ledger`` event into
the job's own stream carrying the whole thing. So a live client replaces its
copy instead of folding a second one from the raw events, and „what the stream
showed" and „what the thread shows tomorrow" cannot be two different accounts of
one run.

**Per run, never module-level (ADR-0018).** A worker process is reused across
jobs and tenants. An accumulator that outlived a run would put one office's
documents on another office's report, which is the failure this rule exists for.

## What is folded from what

``job.phase``
    the five phases, and a step each. The deep researcher's research phase gets
    ONE STEP PER BATCH, and that step's intent is the batch's own ``conclusion``
    — what the run says this round still has to close. That sentence rides the
    ``job.phase`` event because it is the EARLIEST carrier that reaches this
    tier: the run's ``retrieval_ledger`` says the same thing more completely,
    but only once the graph has finished, and a step that appears at the end has
    told the reader nothing while they were waiting.
``artifact.update`` (``citation_source``)
    the documents the open step reached, with the locus spelled exactly as the
    knowledge layer spells it in a lane hit, so a run ledger and a Herleitung
    name the same passage the same way.
``artifact.update`` (``todo``)
    what the open step has NOT settled. The open points of a step, because a
    todo written while researching is about the research.
``job.error`` / ``job.cancelled`` / ``job.degraded``
    how it ended. A failure carries its sanitized reason; a cancellation IS its
    status (there is neither a result nor an error to state, and the finish op
    carries exactly one of those); a degraded run is one that was cut off and
    salvaged — ``unterbrochen`` — and still has a report, so it finishes with a
    RESULT and carries its caveat in the message's transparency keys, where the
    reader's banner already reads it.

## Why a step is sent once, when it is sealed

``append`` is append-only at the BFF: sending a step twice appends it twice,
because the op set is closed at two and there is no „update this step" verb to
abuse. So a step is posted when it is SEALED — when the next step opens, or when
the run ends — while the live snapshot carries the open one from the moment it
starts. The reader watching the stream sees a step immediately; the stored
ledger gets it once, complete.

**Nothing here may fail a run.** Every ingest is guarded, every flush is
best-effort, and a BFF that is down costs the account a flush, never the report.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass
from dataclasses import field
from datetime import UTC
from datetime import datetime
from typing import Any

from aiq_agent.common.run_ledger import MAX_DOCS_PER_STEP
from aiq_agent.common.run_ledger import MAX_ERROR_REASON_CHARS
from aiq_agent.common.run_ledger import MAX_INTENT_CHARS
from aiq_agent.common.run_ledger import MAX_LOCI_PER_DOC
from aiq_agent.common.run_ledger import MAX_LOCUS_CHARS
from aiq_agent.common.run_ledger import MAX_NAME_CHARS
from aiq_agent.common.run_ledger import MAX_OPEN_POINT_CHARS
from aiq_agent.common.run_ledger import MAX_OPEN_POINTS
from aiq_agent.common.run_ledger import MAX_REFERENCE_ID_CHARS
from aiq_agent.common.run_ledger import MAX_SHELF_CHARS
from aiq_agent.common.run_ledger import MAX_STEPS
from aiq_agent.common.run_ledger import MAX_TITLE_CHARS
from aiq_agent.common.run_ledger import RunError
from aiq_agent.common.run_ledger import RunFinishError
from aiq_agent.common.run_ledger import RunLedger
from aiq_agent.common.run_ledger import RunLedgerAppendRequest
from aiq_agent.common.run_ledger import RunLedgerDoc
from aiq_agent.common.run_ledger import RunLedgerFinishRequest
from aiq_agent.common.run_ledger import RunPhaseEntry
from aiq_agent.common.run_ledger import RunResult
from aiq_agent.common.run_ledger import RunStep
from aiq_agent.common.run_ledger import to_wire

from .phase_events import JOB_PHASE_EVENT_TYPE
from .phase_events import PHASE_CITATION_VERIFICATION_STARTED
from .phase_events import PHASE_DONE
from .phase_events import PHASE_PLANNING_STARTED
from .phase_events import PHASE_RESEARCH_STARTED
from .phase_events import PHASE_WRITING_STARTED
from .run_ledger_client import RunLedgerClient

logger = logging.getLogger(__name__)

#: The snapshot event. Its data is ``{"ledger": <the whole ledger>}`` — a live
#: client REPLACES what it holds with it rather than merging, which is what makes
#: one fold the only fold.
RUN_LEDGER_EVENT_TYPE = "run.ledger"

#: The events this fold READS, in the spelling the runner and the callbacks
#: already write them in (``runner.JOB_DEGRADED_EVENT_TYPE`` and the literals
#: beside it). Named here rather than imported from the runner, which imports
#: this module; the test asserts the fold answers to each one, so a rename that
#: only moved the producer's side fails there rather than in a quiet run.
ARTIFACT_EVENT_TYPE = "artifact.update"
JOB_ERROR_EVENT_TYPE = "job.error"
JOB_CANCELLED_EVENT_TYPE = "job.cancelled"
JOB_DEGRADED_EVENT_TYPE = "job.degraded"

#: ``job.phase`` name → ledger phase. Citation verification maps to ``pruefen``
#: and the writer to ``schreiben`` although the deep researcher enters them the
#: other way round (verification is inferred when the writer returns): a phase
#: list is the order things HAPPENED, not the order they are listed in.
PHASE_KEYS: dict[str, str] = {
    PHASE_PLANNING_STARTED: "planen",
    PHASE_RESEARCH_STARTED: "recherchieren",
    PHASE_CITATION_VERIFICATION_STARTED: "pruefen",
    PHASE_WRITING_STARTED: "schreiben",
    PHASE_DONE: "abgelegt",
}

#: What a phase's own step is for, when the run did not say it itself. German
#: prose, like the intent field it fills: this contract carries the runner's
#: WORDS (``RunStep.intent``), not a key a dictionary resolves — see
#: ``run-ledger-types.ts``. The research phase has no default here because every
#: one of its steps states its own.
DEFAULT_INTENTS: dict[str, str] = {
    "planen": "Rechercheplan erstellen",
    "pruefen": "Zitate gegen die belegten Quellen prüfen",
    "schreiben": "Bericht schreiben",
}

#: What a cut-off, salvaged run is called. The transparency key the runner emits
#: alongside it is what the reader's banner renders; this only moves the status.
TRUNCATED_KEY = "research_truncated"


def _now() -> str:
    """The instant, ISO-8601 in UTC — the one spelling the contract stores."""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _clip(value: Any, limit: int) -> str:
    """A wire string, cut to length before it is sent rather than after it is refused."""
    text = str(value or "").strip()
    return text[:limit]


def _locus(source: dict[str, Any]) -> str | None:
    """Where in the document, spelled as the knowledge layer spells a lane hit.

    ``Pkt. 3.5.2 p.12``: the law's own numbering first, because that is the locus
    a reader can act on, and the page after it because a preview opens on it.
    Deliberately the same derivation as ``knowledge_layer._lane_detail`` — two
    spellings of one passage is how a Herleitung and a run ledger start naming
    the same page differently.
    """
    page = source.get("page")
    punkt = source.get("punkt")
    page_text = f"p.{page}" if page is not None else ""
    if not punkt:
        return page_text or None
    return f"Pkt. {punkt} {page_text}".strip()


@dataclass
class _Doc:
    """One document an open step has reached, accumulating its loci."""

    name: str
    title: str | None = None
    shelf: str | None = None
    loci: list[str] = field(default_factory=list)

    def add_locus(self, locus: str | None) -> None:
        if not locus or locus in self.loci or len(self.loci) >= MAX_LOCI_PER_DOC:
            return
        self.loci.append(locus)

    def wire(self) -> RunLedgerDoc:
        return RunLedgerDoc(name=self.name, title=self.title, shelf=self.shelf, loci=list(self.loci))


@dataclass
class _Step:
    """One step of the run, open until the next one starts."""

    id: str
    phase: str
    intent: str
    started_at: str
    docs: dict[str, _Doc] = field(default_factory=dict)
    open_points: list[str] = field(default_factory=list)

    def add_doc(self, source: dict[str, Any]) -> bool:
        """Fold one ``citation_source`` into this step's documents."""
        name = _clip(source.get("file_name") or source.get("citation_key") or source.get("url"), MAX_NAME_CHARS)
        if not name:
            return False
        key = name.casefold()
        doc = self.docs.get(key)
        if doc is None and len(self.docs) >= MAX_DOCS_PER_STEP:
            return False
        if doc is None:
            title = _clip(source.get("title"), MAX_TITLE_CHARS)
            doc = _Doc(name=name, title=title if title and title != name else None)
            doc.shelf = _clip(source.get("shelf"), MAX_SHELF_CHARS) or None
            self.docs[key] = doc
        before = len(doc.loci)
        doc.add_locus(_clip(_locus(source), MAX_LOCUS_CHARS) or None)
        return before != len(doc.loci) or before == 0

    def wire(self) -> RunStep:
        docs = [doc.wire() for doc in self.docs.values()]
        points = self.open_points[:MAX_OPEN_POINTS] or None
        return RunStep(
            id=self.id,
            phase=self.phase,
            intent=self.intent,
            startedAt=self.started_at,
            docs=docs,
            openPoints=points,
        )


@dataclass
class _Phase:
    """One phase the run entered, and — once it is over — left."""

    phase: str
    started_at: str
    ended_at: str | None = None

    def wire(self) -> RunPhaseEntry:
        return RunPhaseEntry(phase=self.phase, startedAt=self.started_at, endedAt=self.ended_at)


class RunLedgerFold:
    """One run's accumulator. Thread-safe to feed, best-effort to flush."""

    #: A run narrates itself about once a second. Faster would post more often
    #: than a reader can read; slower and a phase transition would sit unseen
    #: behind a minute of writing. A transition and the terminal flush ignore it.
    DEBOUNCE_SECONDS = 1.0

    def __init__(
        self,
        *,
        job_id: str,
        run_id: str | None = None,
        event_store: Any | None = None,
        client: RunLedgerClient | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
        autoflush: bool = True,
    ) -> None:
        """
        Args:
            job_id: The backend job. Names the ledger when no run id is known,
                so the live snapshot is still a valid payload.
            run_id: The ``task_runs`` row this run is. The ONLY identity the
                ledger route has, and without it nothing is posted — a doomed
                POST is not better than no POST (``conversation_output`` keeps
                the same rule for a message with no organization).
            event_store: Where the ``run.ledger`` snapshots go — the job's own
                stream, the same one ``job.phase`` uses.
            client: The ledger primitive's client. Injected in tests.
            loop: The loop a flush is scheduled on. Defaults to the running one,
                because this is built in the runner's per-run setup while the
                events that feed it arrive from LangChain's worker threads.
            autoflush: Whether an ingest may schedule its own flush. False hands
                the timing to the caller, which is what a test wants and what a
                caller with no loop of its own has anyway.
        """
        self._job_id = job_id
        self._run_id = run_id
        self._event_store = event_store
        self._client = client if client is not None else RunLedgerClient()
        self._loop = (loop if loop is not None else _running_loop()) if autoflush else None
        self._lock = threading.RLock()

        started = _now()
        self._started_at = started
        self._status = "angelegt"
        self._phases: list[_Phase] = []
        self._steps: list[_Step] = []
        self._open_step: _Step | None = None
        self._current_phase: str | None = None
        self._rounds = 0
        self._result: RunResult | None = None
        self._error_reason: str | None = None
        self._finished_at: str | None = None
        self._updated_at = started

        self._dirty = False
        self._flush_now = False
        self._last_flush = 0.0
        self._sent_steps: set[str] = set()
        self._sent_phases: dict[str, str | None] = {}
        self._sent_status: str | None = None

    # -- ingest ---------------------------------------------------------------

    def observing(self, event_store: Any) -> FoldingEventStore:
        """The job's event store, with everything stored also folded in here."""
        return FoldingEventStore(event_store, self)

    def observe(self, event: dict[str, Any]) -> None:
        """Fold ONE job event. Called from any thread; never raises."""
        try:
            with self._lock:
                changed = self._ingest(event)
        except Exception:  # noqa: BLE001 — best-effort by contract; see the module docstring
            logger.warning("Job %s: could not fold an event into the run ledger", self._job_id, exc_info=True)
            return
        if changed:
            self._schedule_flush()

    def _ingest(self, event: dict[str, Any]) -> bool:
        """Apply one event. Returns whether the ledger changed."""
        kind = event.get("type")
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        if kind == JOB_PHASE_EVENT_TYPE:
            return self._ingest_phase(data)
        if kind == ARTIFACT_EVENT_TYPE:
            return self._ingest_artifact(data)
        if kind == JOB_ERROR_EVENT_TYPE:
            return self._ingest_error(data)
        if kind == JOB_CANCELLED_EVENT_TYPE:
            return self._ingest_cancelled()
        if kind == JOB_DEGRADED_EVENT_TYPE:
            return self._ingest_degraded(data)
        return False

    def _ingest_phase(self, data: dict[str, Any]) -> bool:
        phase = PHASE_KEYS.get(str(data.get("phase") or ""))
        if phase is None:
            return False
        if phase == "recherchieren":
            return self._open_round(data)
        self._enter_phase(phase)
        if phase == "abgelegt":
            # Filing is the run's last act and has no step of its own: what it
            # produced is the result, which the terminal flush states.
            self._seal_open_step()
            return True
        self._begin_step(phase, phase, DEFAULT_INTENTS[phase])
        return True

    def _open_round(self, data: dict[str, Any]) -> bool:
        """One research batch: its own step, carrying the batch's stated conclusion."""
        self._enter_phase("recherchieren")
        index = data.get("batch_index")
        self._rounds = index if isinstance(index, int) and index > 0 else self._rounds + 1
        intent = _clip(data.get("conclusion"), MAX_INTENT_CHARS) or f"Recherche-Runde {self._rounds}"
        self._begin_step(f"runde-{self._rounds}", "recherchieren", intent)
        return True

    def _ingest_artifact(self, data: dict[str, Any]) -> bool:
        step = self._open_step
        if step is None:
            # Before the first phase event there is no step to attribute
            # anything to, and inventing one would put a document under an
            # intent nobody stated.
            return False
        if data.get("type") == "citation_source":
            return step.add_doc(data)
        if data.get("type") == "todo":
            return _set_open_points(step, data.get("content"))
        return False

    def _ingest_error(self, data: dict[str, Any]) -> bool:
        reason = _clip(data.get("error"), MAX_ERROR_REASON_CHARS)
        self._error_reason = reason or "Der Lauf ist fehlgeschlagen."
        self._status = "fehlgeschlagen"
        self._flush_now = True
        return True

    def _ingest_cancelled(self) -> bool:
        # No finish op: that one carries a result or an error, and a cancelled
        # run has neither. „abgebrochen" IS the terminal fact, and it travels as
        # the status of the last append.
        self._status = "abgebrochen"
        self._flush_now = True
        return True

    def _ingest_degraded(self, data: dict[str, Any]) -> bool:
        if not data.get(TRUNCATED_KEY):
            return False
        # Cut off and salvaged: the run still has a report to show, so this moves
        # the status and nothing else. The caveat itself is already on the
        # message (``_TRANSPARENCY_METADATA_KEYS``), in the product's voice.
        self._status = "unterbrochen"
        return True

    def note_result(self, *, report_message_id: str | None = None, file_id: str | None = None) -> None:
        """What the run left behind, stated by the runner once the answer is stored."""
        with self._lock:
            self._result = RunResult(
                fileId=_clip(file_id, MAX_REFERENCE_ID_CHARS) or None,
                reportMessageId=_clip(report_message_id, MAX_REFERENCE_ID_CHARS) or None,
                filedAt=_now(),
            )
            self._flush_now = True
            self._dirty = True

    # -- the running shape ----------------------------------------------------

    def _enter_phase(self, phase: str) -> None:
        """Enter a phase, closing the one the run was in. Entering twice is a no-op."""
        if self._current_phase == phase:
            return
        # A run that has entered a phase is running. The BFF's own moves make the
        # same inference (``openPhase``); making it here too is what keeps the
        # live snapshot and the stored ledger from telling the reader two
        # different things about the same instant.
        if self._status == "angelegt":
            self._status = "laeuft"
        now = _now()
        for entry in self._phases:
            if entry.phase == self._current_phase and entry.ended_at is None:
                entry.ended_at = now
        self._current_phase = phase
        self._flush_now = True
        if any(entry.phase == phase for entry in self._phases):
            return
        self._phases.append(_Phase(phase=phase, started_at=now))

    def _begin_step(self, step_id: str, phase: str, intent: str) -> None:
        """Seal the open step and open this one. A repeated id is not reopened."""
        self._seal_open_step()
        if any(step.id == step_id for step in self._steps):
            return
        if len(self._steps) >= MAX_STEPS:
            # The sanitiser keeps the FIRST fifty, so stopping here is what the
            # store would do anyway — and it keeps the snapshot honest about it.
            return
        step = _Step(id=step_id, phase=phase, intent=intent, started_at=_now())
        self._steps.append(step)
        self._open_step = step

    def _seal_open_step(self) -> None:
        """No more can be added to the open step; the next flush may send it."""
        self._open_step = None

    # -- flushing -------------------------------------------------------------

    def _schedule_flush(self) -> None:
        """Ask the run's loop to flush. Called from callback threads."""
        with self._lock:
            self._dirty = True
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(self.flush(), loop)
        except Exception:  # noqa: BLE001 — a loop that will not take work costs a flush, not a run
            logger.debug("Job %s: could not schedule a run-ledger flush", self._job_id, exc_info=True)

    async def flush(self, *, force: bool = False) -> None:
        """Emit the snapshot and post what the store has not seen. Never raises."""
        try:
            await self._flush(force=force)
        except Exception:  # noqa: BLE001 — best-effort by contract; see the module docstring
            logger.warning("Job %s: a run-ledger flush failed", self._job_id, exc_info=True)

    async def _flush(self, *, force: bool) -> None:
        with self._lock:
            if not self._dirty and not force:
                return
            if not (force or self._flush_now or self._debounce_elapsed()):
                return
            self._dirty = False
            self._flush_now = False
            self._last_flush = time.monotonic()
            self._updated_at = _now()
            snapshot = self._ledger_wire()
            body = self._pending_append()

        self._emit_snapshot(snapshot)
        if body is None or not self._run_id:
            return
        if await self._client.append(self._run_id, body):
            self._mark_sent(body)

    def _debounce_elapsed(self) -> bool:
        return (time.monotonic() - self._last_flush) >= self.DEBOUNCE_SECONDS

    async def close(self, *, status: str | None = None) -> None:
        """Seal the run, flush everything, and state how it ended. Never raises."""
        with self._lock:
            self._seal_open_step()
            if status is not None:
                self._status = status
            elif self._result is not None and self._status not in ("unterbrochen", "abgebrochen"):
                self._status = "fertig"
            self._finished_at = _now()
            self._flush_now = True
        await self.flush(force=True)
        await self._send_finish()

    async def _send_finish(self) -> None:
        """The terminal op, when there is one to send."""
        with self._lock:
            run_id, result, reason = self._run_id, self._result, self._error_reason
        if not run_id or (result is None and reason is None):
            return
        error = RunFinishError(reason=reason) if result is None else None
        try:
            await self._client.finish(run_id, RunLedgerFinishRequest(result=result, error=error))
        except Exception:  # noqa: BLE001 — best-effort by contract
            logger.warning("Job %s: the run ledger could not be finished", self._job_id, exc_info=True)

    # -- payloads -------------------------------------------------------------

    def snapshot(self) -> dict[str, Any] | None:
        """The whole ledger as the wire carries it, or None if it cannot be built."""
        with self._lock:
            return self._ledger_wire()

    def _ledger_wire(self) -> dict[str, Any] | None:
        try:
            return to_wire(self._ledger())
        except Exception:  # noqa: BLE001 — a payload this tier cannot build is a log line, not a failure
            logger.warning("Job %s: the run ledger could not be built", self._job_id, exc_info=True)
            return None

    def _ledger(self) -> RunLedger:
        """The model, with the error's ``completedBefore`` derived here too.

        Derived, not remembered: it is the phases that genuinely ENDED, which is
        what makes „beim Prüfen gescheitert" a different sentence from „failed".
        The BFF derives its own on write; this one is for the live reader, who
        has only the snapshot.
        """
        error = None
        if self._error_reason is not None:
            completed = [entry.phase for entry in self._phases if entry.ended_at]
            error = RunError(reason=self._error_reason, completedBefore=completed)
        return RunLedger(
            runId=self._run_id or self._job_id,
            status=self._status,
            phases=[entry.wire() for entry in self._phases],
            steps=[step.wire() for step in self._steps],
            result=self._result,
            error=error,
            startedAt=self._started_at,
            updatedAt=self._updated_at,
            finishedAt=self._finished_at,
        )

    def _pending_append(self) -> RunLedgerAppendRequest | None:
        """What the store has not been told yet, or None when it is up to date."""
        phases = [entry.wire() for entry in self._phases if self._sent_phases.get(entry.phase, "") != entry.ended_at]
        steps = [step.wire() for step in self._steps if step is not self._open_step and step.id not in self._sent_steps]
        status = self._status if self._status != self._sent_status else None
        if not phases and not steps and status is None:
            return None
        return RunLedgerAppendRequest(steps=steps or None, phases=phases or None, status=status)

    def _mark_sent(self, body: RunLedgerAppendRequest) -> None:
        """Remember what the store accepted, so the next append does not repeat it.

        Marked on ACCEPTANCE, not on send: a flush the BFF refused is retried by
        the next one, which is the difference between a reader missing the middle
        of a run and a reader missing nothing. The cost of that choice is a POST
        that timed out AFTER the store took it, which appends one step twice —
        visible noise, where the other way round the step is simply gone.
        """
        with self._lock:
            for step in body.steps or []:
                self._sent_steps.add(step.id)
            for entry in body.phases or []:
                self._sent_phases[entry.phase] = entry.ended_at
            if body.status is not None:
                self._sent_status = body.status

    def _emit_snapshot(self, ledger: dict[str, Any] | None) -> None:
        """Put the whole ledger on the job's own stream, for whoever is watching."""
        if ledger is None or self._event_store is None:
            return
        try:
            self._event_store.store({"type": RUN_LEDGER_EVENT_TYPE, "data": {"ledger": ledger}})
        except Exception:  # noqa: BLE001 — best-effort by contract
            logger.warning("Job %s: could not emit the run.ledger snapshot", self._job_id, exc_info=True)


class FoldingEventStore:
    """The job's event store, with every event it stores folded into the ledger.

    A decorator rather than a call at each producer: the events a ledger is made
    of are written from four modules and two threads, and a fold wired at one of
    them is a fold that silently misses whatever is added at the next. It wraps
    the store the runner already built and hands the SAME object back to
    everything downstream, so nothing else in the runner knows this exists.

    The fold's own ``run.ledger`` snapshots go to the wrapped store directly and
    never come back through here.
    """

    def __init__(self, event_store: Any, fold: RunLedgerFold) -> None:
        self._event_store = event_store
        self._fold = fold

    @property
    def job_id(self) -> str | None:
        return getattr(self._event_store, "job_id", None)

    def store(self, event: dict[str, Any]) -> None:
        self._fold.observe(event)
        self._event_store.store(event)

    def store_batch(self, events: list[dict[str, Any]]) -> None:
        for event in events:
            self._fold.observe(event)
        self._event_store.store_batch(events)

    def flush(self) -> None:
        flush = getattr(self._event_store, "flush", None)
        if flush is not None:
            flush()


def _set_open_points(step: _Step, todos: Any) -> bool:
    """The step's open points: the todos it has not completed, in their own words.

    Replaced rather than appended, because ``write_todos`` re-states the whole
    list every time — appending would show a reader the same open point four
    times and never show them one being closed.
    """
    if not isinstance(todos, list):
        return False
    points: list[str] = []
    for todo in todos:
        text = _open_point_text(todo)
        if text and text not in points and len(points) < MAX_OPEN_POINTS:
            points.append(text)
    if points == step.open_points:
        return False
    step.open_points = points
    return True


def _open_point_text(todo: Any) -> str | None:
    """One unfinished todo as a sentence, or None for anything finished or empty."""
    if not isinstance(todo, dict):
        return _clip(todo, MAX_OPEN_POINT_CHARS) or None
    if str(todo.get("status") or "").lower() == "completed":
        return None
    return _clip(todo.get("content") or todo.get("task") or todo.get("title"), MAX_OPEN_POINT_CHARS) or None


def _running_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        # Built outside a loop (a test, a sync path): flushes then happen only
        # when somebody awaits one, which is exactly what those callers do.
        return None
