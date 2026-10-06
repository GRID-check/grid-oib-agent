"""The write fence: how a chat turn stops writing its conversation once it may no longer own it.

With conversation affinity off (ADR-0079) a conversation's turns can run on
different replicas, and one turn at a time is kept by a marker in Dragonfly
that the running turn renews. A turn that loses the marker without noticing
(a renewal task that never ran, Dragonfly unreachable from this replica) would
go on writing the conversation's LangGraph thread while a newer turn on
another replica writes it too. The fence is how it notices: the front end
that owns the marker (``aiq_api.turn_fence``) hands each turn an object that
answers, synchronously and from the clock alone, whether the turn may still
write; every write the turn makes to shared conversation state asks it first.

This module is the seam between the two tiers. The agent tier holds the writes
(the checkpointer), the API tier holds the marker, and the API tier is not
imported from here: the fence travels in a :class:`~contextvars.ContextVar`
that the turn's task binds, which every task the graph spawns inherits.

A write already in flight when the fence closes cannot be called back, so
:func:`guarded_write` bounds each one with ``write_timeout``, and the fence's
safety margin is derived from that bound.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextvars import ContextVar
from contextvars import Token
from typing import Protocol

__all__ = [
    "TurnFenced",
    "WriteFence",
    "bind_write_fence",
    "check_write",
    "current_write_fence",
    "guarded_write",
    "unbind_write_fence",
]


class TurnFenced(RuntimeError):
    """The turn no longer owns its conversation, so the write was refused."""


class WriteFence(Protocol):
    """What a write path needs of a turn's fence."""

    #: The longest one guarded write may take, in seconds.
    write_timeout: float

    def fenced(self) -> bool:
        """Whether the turn may no longer write. Pure and synchronous: it reads the clock, never the network."""
        ...


_CURRENT: ContextVar[WriteFence | None] = ContextVar("write_fence", default=None)


def bind_write_fence(fence: WriteFence | None) -> Token[WriteFence | None]:
    """Make ``fence`` the current task's fence (and that of every task it spawns). ``None`` clears it."""
    return _CURRENT.set(fence)


def unbind_write_fence(token: Token[WriteFence | None]) -> None:
    _CURRENT.reset(token)


def current_write_fence() -> WriteFence | None:
    return _CURRENT.get()


def check_write(fence: WriteFence | None) -> None:
    """Refuse with :class:`TurnFenced` when ``fence`` says the turn may no longer write."""
    if fence is not None and fence.fenced():
        raise TurnFenced("the turn lost its conversation and may not write")


@contextlib.asynccontextmanager
async def guarded_write(fence: WriteFence | None = None) -> AsyncIterator[None]:
    """Around one write to the conversation: refuse it once the fence is closed, and bound its duration.

    The check comes first and reads the clock directly, so no task has to have
    run for a late turn to be told no. Without a fence (a job, a single
    process, affinity on) the write is untouched and unbounded, as before.
    ``fence`` defaults to the current task's.
    """
    fence = current_write_fence() if fence is None else fence
    if fence is None:
        yield
        return
    check_write(fence)
    async with asyncio.timeout(fence.write_timeout):
        yield
