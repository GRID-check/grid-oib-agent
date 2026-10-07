"""The write fence: how a chat turn stops writing its conversation once it may no longer own it.

With conversation affinity off (ADR-0080) a conversation's turns can run on
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
:func:`guarded_write` bounds each one: it must end within ``write_timeout`` of
the fence's deadline, and the fence's safety margin is derived from that bound.
The bound is measured from the deadline, not from the write's start, so a slow
write (a large state, a pool wait under load) that begins with runway left is
not cut off while the turn still owns its conversation; and it moves out with
the deadline each time a renewal extends it. A write the bound does cut off is
:class:`TurnFenced`, because by then the fence has closed.
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

    def remaining(self) -> float:
        """Seconds until the fence closes, 0 once it has. Read on the event loop's clock (monotonic)."""
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
    run for a late turn to be told no. The write may then run until
    ``write_timeout`` past the fence's deadline, a bound that moves out with
    every renewal; one cut off there raises :class:`TurnFenced`. Without a
    fence (a job, a single process, affinity on) the write is untouched and
    unbounded, as before. ``fence`` defaults to the current task's.
    """
    fence = current_write_fence() if fence is None else fence
    if fence is None:
        yield
        return
    check_write(fence)
    loop = asyncio.get_running_loop()
    scope = asyncio.timeout(_runway(fence))
    keeper: asyncio.Task[None] | None = None
    try:
        async with scope:
            keeper = asyncio.create_task(_follow_the_deadline(scope, fence, loop))
            yield
    except TimeoutError as exc:
        # Only the bound's own expiry is a fenced write: a TimeoutError the write raised itself passes through.
        if scope.expired() and fence.fenced():
            raise TurnFenced("a write outlived the turn's hold on its conversation and was cut off") from exc
        raise
    finally:
        if keeper is not None:
            keeper.cancel()


def _runway(fence: WriteFence) -> float:
    """How long a write starting now may take: up to the deadline, plus one write's bound."""
    return fence.remaining() + fence.write_timeout


async def _follow_the_deadline(scope: asyncio.Timeout, fence: WriteFence, loop: asyncio.AbstractEventLoop) -> None:
    """Move the write's bound out each time a renewal moves the deadline; stop once the deadline has held.

    A deadline that has passed without the fence tripping (the turn ended on its
    own and released it) is also held: there is nothing left to follow.
    """
    while True:
        remaining = fence.remaining()
        if remaining <= 0.0 or fence.fenced():
            return  # the bound stands: write_timeout past the deadline that held
        await asyncio.sleep(remaining)
        if scope.expired():
            return  # the loop was starved past the old bound: the write is already being cut off
        if fence.remaining() > 0.0 and not fence.fenced():  # a renewal moved the deadline while we slept
            scope.reschedule(loop.time() + _runway(fence))
