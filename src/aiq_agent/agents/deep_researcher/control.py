"""The one control a reader has over a running deep research: „Jetzt schreiben".

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

_WRITE_NOW: ContextVar[asyncio.Event | None] = ContextVar("deep_research_write_now", default=None)


def bind_write_now(signal: asyncio.Event | None) -> Token:
    """Bind the run's write-now signal; the caller resets with :func:`reset_write_now`."""
    return _WRITE_NOW.set(signal)


def reset_write_now(token: Token) -> None:
    _WRITE_NOW.reset(token)


def write_now_requested() -> bool:
    """Whether the reader asked for the report to be written from what is there."""
    signal = _WRITE_NOW.get()
    return signal is not None and signal.is_set()
