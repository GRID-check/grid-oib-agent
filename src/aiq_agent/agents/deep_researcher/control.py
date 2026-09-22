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

_WRITE_NOW: ContextVar[asyncio.Event | None] = ContextVar("deep_research_write_now", default=None)
#: Documents the reader added to the Grundlage while the run goes, in arrival
#: order. The job runner's monitor appends (``job.document_added`` events);
#: the research tool drains the list before a batch and tells the orchestrator.
_ADDED_DOCUMENTS: ContextVar[list[PlanDocument] | None] = ContextVar("deep_research_added_documents", default=None)


def bind_write_now(signal: asyncio.Event | None) -> Token:
    """Bind the run's write-now signal; the caller resets with :func:`reset_write_now`."""
    return _WRITE_NOW.set(signal)


def reset_write_now(token: Token) -> None:
    _WRITE_NOW.reset(token)


def write_now_requested() -> bool:
    """Whether the reader asked for the report to be written from what is there."""
    signal = _WRITE_NOW.get()
    return signal is not None and signal.is_set()


def bind_added_documents(queue: list[PlanDocument] | None) -> Token:
    """Bind the run's queue of live additions; the caller resets with :func:`reset_added_documents`."""
    return _ADDED_DOCUMENTS.set(queue)


def reset_added_documents(token: Token) -> None:
    _ADDED_DOCUMENTS.reset(token)


def take_added_documents() -> list[PlanDocument]:
    """Drain the documents added since the last batch, oldest first."""
    queue = _ADDED_DOCUMENTS.get()
    if not queue:
        return []
    taken = list(queue)
    del queue[:]
    return taken
