"""The controls a reader has over a running deep research.

„Jetzt schreiben", and — since the Rechercheplan carries Unterlagen — a
document added to the Grundlage while the run goes.

A run used to offer a single lever, „Abbrechen", which threw the report away.
The reader watching the rounds land usually wants the opposite: stop
researching and write from what is there. The job runner sets the signal when
the reader asks (``routes/jobs.py`` records a ``job.write_now_requested``
event; the runner's monitor sees it), binds it here for the run, and the
research tool reads it before every batch. Per run, on a ``ContextVar`` bound
around ``agent.run`` and reset after, because the worker process is shared
across runs and tenants (ADR-0018).
"""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
from contextvars import Token

from aiq_agent.common.plan_documents import PlanDocument


class _AddedDocuments:
    """The monitor's append-only list, and how far the research tool has read it."""

    def __init__(self, queue: list[PlanDocument]) -> None:
        self.queue = queue
        self.taken = 0


_WRITE_NOW: ContextVar[asyncio.Event | None] = ContextVar("deep_research_write_now", default=None)
#: Whether the research tool refused a batch because the reader asked for the
#: report. Only that makes the report cut short: a request that lands after the
#: last batch finds a run already writing everything it researched. A mutable
#: record bound at the top of the run, because the tool runs in a copied
#: context and a ``ContextVar.set`` there would not reach ``_finalize``.
_WRITE_NOW_HONOURED: ContextVar[list[bool] | None] = ContextVar("deep_research_write_now_honoured", default=None)
#: Documents the reader added to the Grundlage while the run goes, in arrival
#: order. The job runner's monitor appends (``job.document_added`` events) and
#: never drains, so the list is also the run's whole account of its additions;
#: the research tool reads past a cursor before a batch and tells the
#: orchestrator.
_ADDED_DOCUMENTS: ContextVar[_AddedDocuments | None] = ContextVar("deep_research_added_documents", default=None)


def bind_write_now(signal: asyncio.Event | None) -> Token:
    """Bind the run's write-now signal; the caller resets with :func:`reset_write_now`."""
    return _WRITE_NOW.set(signal)


def reset_write_now(token: Token) -> None:
    _WRITE_NOW.reset(token)


def write_now_requested() -> bool:
    """Whether the reader asked for the report to be written from what is there."""
    signal = _WRITE_NOW.get()
    return signal is not None and signal.is_set()


def begin_write_now_record() -> Token:
    """Start recording whether this run refused a batch for the reader; pair with :func:`end_write_now_record`."""
    return _WRITE_NOW_HONOURED.set([])


def end_write_now_record(token: Token) -> None:
    _WRITE_NOW_HONOURED.reset(token)


def note_write_now_honoured() -> None:
    """Record that a batch was refused because the reader asked for the report."""
    record = _WRITE_NOW_HONOURED.get()
    if record is not None:
        record.append(True)


def write_now_honoured() -> bool:
    """Whether this run refused research because the reader asked for the report."""
    return bool(_WRITE_NOW_HONOURED.get())


def bind_added_documents(queue: list[PlanDocument] | None) -> Token:
    """Bind the run's list of live additions; the caller resets with :func:`reset_added_documents`."""
    return _ADDED_DOCUMENTS.set(_AddedDocuments(queue) if queue is not None else None)


def reset_added_documents(token: Token) -> None:
    _ADDED_DOCUMENTS.reset(token)


def take_added_documents() -> list[PlanDocument]:
    """The documents added since the last take, oldest first. The list itself is left whole."""
    added = _ADDED_DOCUMENTS.get()
    if added is None:
        return []
    taken = added.queue[added.taken :]
    added.taken = len(added.queue)
    return list(taken)


def all_added_documents() -> list[PlanDocument]:
    """Every document the reader added to this run, taken or not."""
    added = _ADDED_DOCUMENTS.get()
    return list(added.queue) if added is not None else []
