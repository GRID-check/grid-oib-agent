"""The checks every answer already passes through, as Langfuse scores (ADR-0089).

The answer pipeline grades every turn before the reader sees it: citation
verification drops what it cannot verify, the quote check finds wording no
passage holds and patches it, the dialect pass repairs blocks, a card that
misses its schema is repaired or dropped, and the overconfidence guard caps the
surfaced confidence. All of that was recorded somewhere (the citation-events
ledger, a wire status, a trace metadata blob) and none of it was a *score*, so
Langfuse could not chart it over time, put it next to the user's vote, compare
it across prompt versions or feed it to an annotation queue.

This module turns those runtime checks into scores on the turn's trace:

* :data:`SCORE_DEFINITIONS` is the one list of score names Grid writes, with
  their type and range. ``scripts/langfuse_provision.py`` creates a Langfuse
  score config from each, and ``docs/observability/langfuse.md`` documents them,
  so a name cannot exist in one place and not the others
  (``tests/aiq_agent/observability/test_langfuse_scores.py`` holds them together).
* The ``*_scores`` builders are pure: a check's outcome in, scores out.
* :func:`emit_scores` posts them to ``POST /api/public/scores`` on a small
  bounded pool, the way ``common.citation_events`` posts its batches: never
  raises, never waits, drops past a backlog ceiling rather than growing.

Each score's id is derived from (trace, writer, name[, item]), so a retried or
repeated post upserts rather than double-counts.

Availability is capability: without ``LANGFUSE_HOST`` and the key pair (the
deployment injects them where the Langfuse tier exists) every call is a no-op.
"""

from __future__ import annotations

import logging
import os
import uuid
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from dataclasses import field
from threading import Lock
from typing import Any
from typing import Literal

logger = logging.getLogger(__name__)

DataType = Literal["NUMERIC", "CATEGORICAL", "BOOLEAN"]

HOST_ENV = "LANGFUSE_HOST"
PUBLIC_KEY_ENV = "LANGFUSE_PUBLIC_KEY"
SECRET_KEY_ENV = "LANGFUSE_SECRET_KEY"  # pragma: allowlist secret


@dataclass(frozen=True)
class ScoreDefinition:
    """One score name Grid writes, and the Langfuse score config that describes it."""

    name: str
    data_type: DataType
    description: str
    #: Who writes it: the agent at runtime, the BFF from a vote, a reviewer in
    #: an annotation queue, or a Langfuse LLM-as-a-judge evaluator.
    writer: Literal["agent", "bff", "annotation", "judge"] = "agent"
    categories: tuple[str, ...] = ()
    min_value: float | None = None
    max_value: float | None = None


#: Every score Grid writes. Adding a score means adding it here first.
SCORE_DEFINITIONS: tuple[ScoreDefinition, ...] = (
    ScoreDefinition(
        "user-feedback",
        "NUMERIC",
        "The asker's vote: 1 helpful, 0 not. Its mean is the helpful rate.",
        writer="bff",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "user-feedback-reason",
        "CATEGORICAL",
        "Why a down-voted answer was not helpful, as the asker chose it.",
        writer="bff",
        categories=("inaccurate", "wrong_source", "too_slow", "other"),
    ),
    ScoreDefinition(
        "piloti-decision",
        "CATEGORICAL",
        "A person's decision on something Piloti produced in this turn: a proposal or a proposed mark taken "
        "over (accepted) or dismissed, an applied change undone, a held mail's part filed where Piloti "
        "suggested (accepted) or not (dismissed). Metadata names the subject and its id.",
        writer="bff",
        categories=("accepted", "dismissed", "undone"),
    ),
    ScoreDefinition(
        "mail-thread-match",
        "CATEGORICAL",
        "What a person did with the E-Mail-Verlauf a held mail matched (ADR-0134): appended it to the strongest "
        "match (followed), to another Verlauf (other_thread), or started a new one (new_thread). One per decided "
        "mail text with a match; a follow's append is followed with metadata via follow. The precision of "
        "thread matching, by strength and sender trust.",
        writer="bff",
        categories=("followed", "other_thread", "new_thread"),
    ),
    ScoreDefinition(
        "revision-notice",
        "NUMERIC",
        "How many marks Piloti proposed when it compared a new Fassung on its own (ADR-0130); 0 is compared, "
        "nothing visible. On the trace of the first page's vision call; with piloti-decision on those marks, "
        "the precision of noticing.",
        writer="bff",
        min_value=0,
    ),
    ScoreDefinition(
        "document-check",
        "NUMERIC",
        "How many marks Piloti proposed when it checked a new document against the project's other documents "
        "on its own (ADR-0130); 0 is checked, everything agrees. On the trace of the headless turn that ran "
        "the check; with piloti-decision on those marks, the precision of the check.",
        writer="bff",
        min_value=0,
    ),
    ScoreDefinition(
        "citation-health",
        "BOOLEAN",
        "True when citation verification found nothing to remove, patch or flag on this turn.",
    ),
    ScoreDefinition(
        "answer-grounded",
        "BOOLEAN",
        "False when sources were retrieved but no citation the answer made survived verification.",
    ),
    ScoreDefinition(
        "citations-removed",
        "NUMERIC",
        "How many citations verification dropped because they did not hold.",
        min_value=0,
    ),
    ScoreDefinition(
        "quotes-unverified",
        "NUMERIC",
        "Quoted spans no retrieved passage holds, after any patch.",
        min_value=0,
    ),
    ScoreDefinition(
        "retrieval-precision",
        "NUMERIC",
        "Share of the distinct sources retrieval returned that the answer cited.",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "citation-fallback",
        "BOOLEAN",
        "Retired with the single-source fallback (ADR-0125); no longer written. Kept so older traces chart.",
    ),
    ScoreDefinition(
        "sources-empty",
        "BOOLEAN",
        "True when a lookup ran and retrieved nothing, so the turn could not answer from sources.",
    ),
    ScoreDefinition(
        "answer-confidence",
        "CATEGORICAL",
        "The confidence the reader saw on the answer.",
        categories=("low", "medium", "high"),
    ),
    ScoreDefinition(
        "confidence-capped",
        "CATEGORICAL",
        "Which guard lowered the surfaced confidence, or none.",
        categories=(
            "none",
            "ungrounded",
            "quote_unverified",
            "normative_claim_uncited",
            "measurement_only",
            "citation_fallback",
        ),
    ),
    ScoreDefinition(
        "quotes-verbatim-rate",
        "NUMERIC",
        "Share of the checked quote lines whose wording a passage holds verbatim.",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "quotes-patched",
        "NUMERIC",
        "Misremembered quotes the repair pass corrected in place (ADR-0067).",
        min_value=0,
    ),
    ScoreDefinition(
        "dialect-repairs",
        "NUMERIC",
        "Answer-dialect blocks the pipeline had to repair before the reader saw them.",
        min_value=0,
    ),
    ScoreDefinition(
        "steer-count",
        "NUMERIC",
        "How many notes the asker typed into this turn while it ran; written only on a steered turn.",
        min_value=0,
    ),
    ScoreDefinition(
        "file-tools-used",
        "CATEGORICAL",
        "Which of the office-file moves a turn used (ADR-0127), as the files eval's arms define them: search "
        "(knowledge_search ranked by meaning, round 0 included), navigate (list_files, read_passage, and "
        "knowledge_search in a literal mode, exact or regex), both, or none. Written on every turn that called "
        "a tool.",
        categories=("none", "search", "navigate", "both"),
    ),
    ScoreDefinition(
        "folder-card-fresh",
        "NUMERIC",
        "Share of the folders one folder-card pass claimed whose written card is fresh afterwards (ADR-0127): "
        "built, or unchanged because nothing it reads changed. Below 1 is a pass that hit the monthly budget "
        "or a failed build. Written on the pass's first folder-card generation.",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "card-validity",
        "CATEGORICAL",
        "Each envelope card that missed its schema: repaired, or dropped.",
        categories=("repaired", "dropped"),
    ),
    ScoreDefinition(
        "work-report-matches",
        "BOOLEAN",
        "On a work turn (kind work, ADR-0123): true when the report lists as many proposals as the turn put "
        "in front of the person as proposal cards. A reported proposal no write filed is dropped before this "
        "is counted (work-proposals-unfiled), so false is mostly a turn that filed a proposal it did not report.",
    ),
    ScoreDefinition(
        "work-proposals-unfiled",
        "NUMERIC",
        "On a work turn (kind work, ADR-0123): the report's proposed lines whose ref named no proposal this "
        "turn filed, dropped before the person saw them. Above zero is a turn that claimed a proposal it did not make.",
        min_value=0,
    ),
    ScoreDefinition(
        "claims-by-class",
        "CATEGORICAL",
        "One score per provenance class present in the answer (ADR-0125): where its sentences come from. "
        "The comment and metadata carry how many sentences of that class.",
        categories=(
            "quoted",
            "cited",
            "cited_dropped",
            "record",
            "action",
            "measured",
            "observed",
            "reasoning",
            "model_knowledge",
        ),
    ),
    ScoreDefinition(
        "claims-normative-uncited",
        "NUMERIC",
        "Sentences about the law (the normative detector) with no quoted or cited passage behind them.",
        min_value=0,
    ),
    ScoreDefinition(
        "look-count",
        "NUMERIC",
        "Looks Piloti made in the turn (ADR-0128): renders of a page, a region of it or an embedded image, "
        "whether or not the answer relies on them. Zero is a measurement.",
        min_value=0,
    ),
    ScoreDefinition(
        "looked-before-measurement",
        "BOOLEAN",
        "On a turn whose answer states a value read off a drawing (ADR-0128): true when Piloti had made a "
        "region look (not only an overview) at that drawing before it answered. Not written on a turn that "
        "states no such value.",
    ),
    ScoreDefinition(
        "citations-dropped-labelled",
        "NUMERIC",
        "Places the answer cited something that did not resolve, labelled in the text instead of removed.",
        min_value=0,
    ),
    ScoreDefinition(
        "thread-answered-in-place",
        "BOOLEAN",
        "On a turn asked to answer in an Anmerkung's thread: true when the model replied there itself, false "
        "when the socket had to post the answer for it. Not written when the turn may not post there.",
    ),
)

#: Scores a person or a judge writes inside Langfuse. Grid never writes these;
#: they are defined here so the provisioning script, the docs and the queue
#: agree on one name each.
REVIEW_AND_JUDGE_DEFINITIONS: tuple[ScoreDefinition, ...] = (
    ScoreDefinition(
        "review-correctness",
        "CATEGORICAL",
        "A domain reviewer's verdict on the answer's substance.",
        writer="annotation",
        categories=("correct", "partly_correct", "incorrect"),
    ),
    ScoreDefinition(
        "review-sources",
        "CATEGORICAL",
        "A domain reviewer's verdict on the sources the answer relied on.",
        writer="annotation",
        categories=("right_sources", "missing_sources", "wrong_sources"),
    ),
    ScoreDefinition(
        "judge-answers-question",
        "NUMERIC",
        "LLM judge: how directly the answer addresses what was asked, 0 to 1.",
        writer="judge",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "judge-uncited-claims",
        "BOOLEAN",
        "LLM judge: true when the answer states a normative requirement without a [N] citation.",
        writer="judge",
    ),
    ScoreDefinition(
        "judge-clarity",
        "CATEGORICAL",
        "LLM judge: whether a planner could act on the answer as written.",
        writer="judge",
        categories=("clear", "partly_clear", "unclear"),
    ),
)

SCORE_DEFINITIONS = SCORE_DEFINITIONS + REVIEW_AND_JUDGE_DEFINITIONS

_DEFINITIONS_BY_NAME = {definition.name: definition for definition in SCORE_DEFINITIONS}

#: Severities of ``common.citation_events`` that make a turn unhealthy.
_UNHEALTHY_SEVERITIES = frozenset({"warn", "error"})


@dataclass(frozen=True)
class RuntimeScore:
    """One score to write on a trace."""

    name: str
    value: float | str
    comment: str | None = None
    #: Distinguishes several scores of one name on one trace (one per card).
    item: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def data_type(self) -> DataType:
        return _DEFINITIONS_BY_NAME[self.name].data_type


def _boolean(name: str, value: bool, comment: str | None = None) -> RuntimeScore:
    return RuntimeScore(name, 1.0 if value else 0.0, comment=comment)


# ---------------------------------------------------------------------------
# Builders: one check's outcome in, scores out. Pure.
# ---------------------------------------------------------------------------


def _count(by_kind: dict[str, Any], kind: str) -> float:
    event = by_kind.get(kind)
    return float(event.count) if event is not None else 0.0


def citation_scores(events: Iterable[Any]) -> list[RuntimeScore]:
    """Scores for one turn's ``common.citation_events``.

    ``events`` are ``CitationEvent`` objects. A batch with no ``turn_verified``
    row and no ``registry_empty`` row is not a turn's verification outcome and
    yields nothing.
    """
    by_kind = {event.kind: event for event in events}
    if "registry_empty" in by_kind:
        return [_boolean("sources-empty", True), _boolean("citation-health", False, "registry_empty")]
    if "turn_verified" not in by_kind:
        return []
    from aiq_agent.common.citation_events import SEVERITY_BY_KIND

    unhealthy = sorted(kind for kind in by_kind if SEVERITY_BY_KIND.get(kind) in _UNHEALTHY_SEVERITIES)
    scores = [
        _boolean("citation-health", not unhealthy, ", ".join(unhealthy) or None),
        _boolean("answer-grounded", "answer_ungrounded" not in by_kind),
        _boolean("sources-empty", False),
        RuntimeScore("citations-removed", _count(by_kind, "citations_removed")),
        RuntimeScore("quotes-unverified", _count(by_kind, "quote_unverified")),
    ]
    precision = by_kind.get("retrieval_precision")
    retrieved = int((precision.detail or {}).get("retrieved_count") or 0) if precision is not None else 0
    if retrieved > 0:
        cited = int(precision.detail.get("cited_count") or 0)
        scores.append(RuntimeScore("retrieval-precision", round(cited / retrieved, 4)))
    return scores


def turn_outcome_scores(result: Any) -> list[RuntimeScore]:
    """Scores from a finished turn's ``TurnResult``: what the reader was shown."""
    scores: list[RuntimeScore] = []
    confidence = getattr(result, "answer_confidence", None)
    if confidence:
        scores.append(RuntimeScore("answer-confidence", confidence))
        capped = getattr(result, "answer_confidence_capped_reason", None)
        scores.append(RuntimeScore("confidence-capped", capped or "none"))
    statuses = [getattr(stamp, "status", None) for stamp in getattr(result, "quote_stamps", None) or []]
    checked = [status for status in statuses if status in ("verbatim", "not_found")]
    if checked:
        scores.append(RuntimeScore("quotes-verbatim-rate", round(checked.count("verbatim") / len(checked), 4)))
    scores.extend(work_report_scores(result))
    return scores


def proposal_cards(cards: Iterable[Any]) -> int:
    """How many of a turn's cards show a stored proposal (they carry its ``proposal_id``)."""
    count = 0
    for keyed in cards:
        card = getattr(keyed, "card", keyed)
        if isinstance(card, dict) and card.get("proposal_id"):
            count += 1
    return count


def work_report_scores(result: Any) -> list[RuntimeScore]:
    """A work turn's report against what the turn filed; nothing on any other turn."""
    meta = getattr(result, "answer_meta", None) or {}
    if not isinstance(meta, dict) or meta.get("kind") != "work":
        return []
    reported = len(((meta.get("work") or {}).get("proposed")) or [])
    filed = proposal_cards(getattr(result, "cards", None) or [])
    return [_boolean("work-report-matches", reported == filed, f"reported {reported}, filed {filed}")]


def work_unfiled_scores(dropped: int) -> list[RuntimeScore]:
    """How many of a work report's ``proposed`` lines named no proposal this turn filed; zero included."""
    return [RuntimeScore("work-proposals-unfiled", float(max(0, dropped)))]


def claim_scores(stamps: Iterable[Any], *, dropped: int) -> list[RuntimeScore]:
    """The answer's per-sentence provenance (``common/claim_provenance.py``), zeros included.

    ``stamps`` are ``ClaimStamp`` objects; ``dropped`` is how many labels the
    final text carries where a citation did not resolve.
    """
    from aiq_agent.common.claim_provenance import class_counts
    from aiq_agent.common.claim_provenance import normative_uncited

    stamps = list(stamps)
    scores = [
        RuntimeScore("claims-by-class", name, comment=str(count), item=name, metadata={"count": count})
        for name, count in class_counts(stamps).items()
    ]
    scores.append(RuntimeScore("claims-normative-uncited", float(normative_uncited(stamps))))
    scores.append(RuntimeScore("citations-dropped-labelled", float(max(0, dropped))))
    return scores


def look_scores(*, looks: int, drawing_value: bool, region_look_first: bool) -> list[RuntimeScore]:
    """The turn's looks (ADR-0128): how many, and whether a region look came before a stated drawing value."""
    scores = [RuntimeScore("look-count", float(max(0, looks)))]
    if drawing_value:
        scores.append(_boolean("looked-before-measurement", region_look_first))
    return scores


def dialect_scores(repairs: list[dict[str, str]]) -> list[RuntimeScore]:
    """The dialect pass's repairs on one answer, zero included: a clean answer is a measurement too."""
    kinds = sorted({repair.get("repair", "") for repair in repairs if repair.get("repair")})
    return [RuntimeScore("dialect-repairs", float(len(repairs)), comment=", ".join(kinds) or None)]


def quote_patch_scores(patched: int) -> list[RuntimeScore]:
    """How many quotes the repair pass corrected on one answer."""
    return [RuntimeScore("quotes-patched", float(max(0, patched)))]


#: The tool basenames that navigate the office's files (ADR-0127). ``knowledge_search`` is the search
#: move when it ranks by meaning and a navigate move in a literal mode (``match="exact"`` or ``"regex"``),
#: as the files eval's ``navigate`` arm defines it (``scripts/turn_census/files_eval.py``).
NAVIGATE_TOOLS = frozenset({"list_files", "read_passage"})
SEARCH_TOOLS = frozenset({"knowledge_search"})


def file_tool_scores(tools: Iterable[str], literal_searches: int = 0) -> list[RuntimeScore]:
    """Which office-file moves a turn used, from the basenames of the tools it called, one per call.

    ``literal_searches`` is how many of the ``knowledge_search`` calls ran in a literal mode
    (``turn_status.emit_literal_search``): those count as navigation, the rest as search, so the
    score separates the eval's arms. Nothing for a turn that called no tool at all; ``none`` for a
    turn that called tools but none of these.
    """
    calls = list(tools)
    if not calls:
        return []
    searches = sum(1 for tool in calls if tool in SEARCH_TOOLS)
    literal = min(max(0, literal_searches), searches)
    searched = searches > literal
    navigated = literal > 0 or any(tool in NAVIGATE_TOOLS for tool in calls)
    value = "both" if searched and navigated else "search" if searched else "navigate" if navigated else "none"
    named = set(calls) & NAVIGATE_TOOLS
    if searched:
        named.add("knowledge_search")
    if literal:
        named.add("knowledge_search (literal)")
    return [RuntimeScore("file-tools-used", value, comment=", ".join(sorted(named)) or None)]


def steer_scores(inbox: Any) -> list[RuntimeScore]:
    """A steered turn's count of notes (``common.steering.SteerInbox``): taken, and how many the turn read."""
    received = int(getattr(inbox, "received", 0) or 0)
    if received <= 0:
        return []
    applied = len(getattr(inbox, "applied", None) or [])
    return [RuntimeScore("steer-count", float(received), comment=f"applied {applied}")]


def card_validity_score(*, outcome: str, card_type: str, index: int) -> RuntimeScore:
    """One envelope card's schema miss, repaired or dropped."""
    return RuntimeScore("card-validity", outcome, comment=card_type, item=str(index), metadata={"card_type": card_type})


def thread_reply_scores(verdict: str) -> list[RuntimeScore]:
    """A thread turn's ``thread_reply`` verdict as a score: ``replied`` true, ``skipped`` false, else none."""
    if verdict not in ("replied", "skipped"):
        return []
    return [_boolean("thread-answered-in-place", verdict == "replied")]


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------

_REQUEST_TIMEOUT_SECONDS = 5.0
#: Ceiling on posts queued but not sent. A hung Langfuse must cost dropped
#: scores, never a replica's memory (the same trade ``citation_events`` makes).
_MAX_PENDING = 500
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="langfuse-scores")
_pending = 0
_pending_lock = Lock()

#: Namespace for score ids: stable across processes and restarts.
_SCORE_ID_NAMESPACE = uuid.UUID("6f1c2a52-4f7e-4f43-9c39-2f0f8a8f6d5e")


def score_id(*, trace_id: str, writer: str, name: str, item: str | None = None) -> str:
    """The id a score is upserted under: one per (trace, writer, name, item)."""
    return str(uuid.uuid5(_SCORE_ID_NAMESPACE, f"{trace_id}:{writer}:{name}:{item or ''}"))


def _credentials() -> tuple[str, str, str] | None:
    host = os.environ.get(HOST_ENV, "").strip().rstrip("/")
    public_key = os.environ.get(PUBLIC_KEY_ENV, "").strip()
    secret_key = os.environ.get(SECRET_KEY_ENV, "").strip()
    if not (host and public_key and secret_key):
        return None
    return host, public_key, secret_key


def scores_enabled() -> bool:
    """Whether this process can write scores: the Langfuse tier is deployed and its keys reached us."""
    return _credentials() is not None


def score_body(score: RuntimeScore, *, trace_id: str, writer: str, environment: str | None) -> dict[str, Any]:
    """The ``POST /api/public/scores`` body for one score. Pure."""
    body: dict[str, Any] = {
        "id": score_id(trace_id=trace_id, writer=writer, name=score.name, item=score.item),
        "traceId": trace_id,
        "name": score.name,
        "value": score.value,
        "dataType": score.data_type,
        "metadata": {"writer": writer, **score.metadata},
    }
    if score.comment:
        body["comment"] = score.comment[:500]
    if environment:
        body["environment"] = environment
    return body


def _release(_future: Any) -> None:
    global _pending
    with _pending_lock:
        _pending = max(0, _pending - 1)


def _post(host: str, auth: tuple[str, str], body: dict[str, Any]) -> None:
    import httpx

    try:
        response = httpx.post(f"{host}/api/public/scores", json=body, auth=auth, timeout=_REQUEST_TIMEOUT_SECONDS)
        if response.status_code >= 400:
            logger.debug("Langfuse refused score %s: HTTP %s", body.get("name"), response.status_code)
    except Exception:
        logger.debug("Could not post score %s to Langfuse", body.get("name"), exc_info=True)


def emit_scores(scores: Iterable[RuntimeScore], *, writer: str, trace_id: str | None = None) -> int:
    """Queue ``scores`` for the current turn's trace; how many were queued. Never raises, never waits.

    ``trace_id`` defaults to the trace this context runs in
    (``observability.turn_trace.current_trace_id_hex``).
    """
    global _pending
    try:
        credentials = _credentials()
        if credentials is None:
            return 0
        if trace_id is None:
            from aiq_agent.observability.turn_trace import current_trace_id_hex

            trace_id = current_trace_id_hex()
        if not trace_id:
            return 0
        from aiq_agent.observability.trace_context import langfuse_environment

        host, public_key, secret_key = credentials
        environment = langfuse_environment()
        queued = 0
        for score in scores:
            definition = _DEFINITIONS_BY_NAME.get(score.name)
            if definition is None or definition.writer != "agent":
                logger.debug("Refusing a score the agent does not own: %s", score.name)
                continue
            with _pending_lock:
                if _pending >= _MAX_PENDING:
                    logger.debug("Langfuse score backlog full; dropping %s", score.name)
                    continue
                _pending += 1
            body = score_body(score, trace_id=trace_id, writer=writer, environment=environment)
            _executor.submit(_post, host, (public_key, secret_key), body).add_done_callback(_release)
            queued += 1
        return queued
    except Exception:
        logger.debug("Could not queue Langfuse scores", exc_info=True)
        return 0
