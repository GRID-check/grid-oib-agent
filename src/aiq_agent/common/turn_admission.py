"""Concurrency admission for interactive chat turns — ADR-0040 layer L3.

## The gap this closes

Async research jobs have had admission control since the scaling review
(``GRID_MAX_ACTIVE_JOBS`` / ``…_PER_ORG`` in ``aiq_api.jobs.submit``): a
deliberate ceiling on how many long runs may be in flight, per organization and
overall. Interactive chat turns had none. A single shared conversation with ten
members answering at once starts ten multi-agent runs, and the only thing that
ever said no was the ADR-0015 euro budget — that is, after the money was spent.

## Why concurrency and not a rate

A rate limit is the wrong shape for work that lasts. "Thirty turns per five
minutes" happily admits a fourth, fifth and sixth simultaneous research run at a
steady trickle, because it counts arrivals rather than occupancy. What actually
runs out here is *capacity*: LLM concurrency, Postgres connections, the agent
worker's CPU. So this is a semaphore — slots held for the duration of the turn
and returned when it ends. The rate limits upstream (ADR-0040 L2/L2b) bound how
fast turns may *arrive*; this bounds how many may be *running*.

## Partitioning

The interactive pool is deliberately SEPARATE from the async-job pool rather
than a share of one total. That is the partition: a queue full of deep-research
jobs cannot consume the capacity interactive chat needs, and a busy chat hour
cannot block scheduled research. It is the same idea as
``Netflix/concurrency-limits`` partitions and Kubernetes' API Priority &
Fairness levels — reserve for the latency-sensitive work rather than hoping it
wins the race.

## Leases, not counters

Slots are held in a sorted set scored by acquisition time, and a slot older than
``GRID_TURN_LEASE_SECONDS`` is dropped on the next acquire. A plain
increment/decrement pair leaks a slot forever whenever a replica is OOM-killed
mid-turn, and the pool shrinks silently until nobody can chat. A lease
self-heals: the worst case is that a genuinely long turn's slot is reclaimed
early, which over-admits by one rather than under-admitting forever.

Fails OPEN, like every other layer except the budget: a cache outage must never
be the reason chat stops.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
import uuid
from collections.abc import AsyncIterator
from collections.abc import Iterator
from contextlib import asynccontextmanager
from contextlib import contextmanager

from aiq_agent.common import cache

logger = logging.getLogger(__name__)

# @environment_variable GRID_MAX_ACTIVE_TURNS
# @category Server
# @type int
# @default 24
# @required false
# Maximum interactive chat turns running concurrently across all organizations.
# Its own pool, never shared with GRID_MAX_ACTIVE_JOBS — that separation is what
# stops background research from starving chat. 0 or negative disables.
MAX_ACTIVE_TURNS = int(os.environ.get("GRID_MAX_ACTIVE_TURNS", "24"))

# @environment_variable GRID_MAX_ACTIVE_TURNS_PER_ORG
# @category Server
# @type int
# @default 6
# @required false
# Maximum concurrent interactive chat turns per organization, so one tenant
# cannot occupy the interactive pool. 0 or negative disables the per-org cap.
MAX_ACTIVE_TURNS_PER_ORG = int(os.environ.get("GRID_MAX_ACTIVE_TURNS_PER_ORG", "6"))

# @environment_variable GRID_TURN_LEASE_SECONDS
# @category Server
# @type int
# @default 900
# @required false
# How long a turn may hold its admission slot before the slot is reclaimed as
# stale. Must exceed the longest plausible chat turn: too low over-admits, too
# high leaves slots stranded after a replica is killed mid-turn.
TURN_LEASE_SECONDS = int(os.environ.get("GRID_TURN_LEASE_SECONDS", "900"))

_GLOBAL_KEY = "turns:active:_global"


def _org_key(organization_id: str) -> str:
    return f"turns:active:{organization_id}"


class TurnAdmissionError(RuntimeError):
    """Raised when a chat turn is refused for lack of a concurrency slot.

    The caller turns this into a friendly chat response — the same treatment
    ``BudgetExceededError`` gets. A refused turn has started nothing, so
    retrying is safe.
    """

    def __init__(self, message: str, retry_after_seconds: int = 15):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


# Drop expired leases, refuse if the pool is full, otherwise take a slot.
# One script because the three steps must be atomic: split apart, two turns
# both read "one slot left" and both take it, which is precisely the
# concurrency this exists to bound.
_ACQUIRE_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - lease)
if redis.call('ZCARD', key) >= limit then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, lease)
return 1
"""

_RELEASE_LUA = "return redis.call('ZREM', KEYS[1], ARGV[1])"

# Per-process fallback, used only when there is no shared store (local dev, a
# single-replica compose stack, tests). It bounds this replica honestly and says
# nothing about the fleet — with N replicas the effective ceiling is N x the
# configured one. The same trade every other layer makes without a store.
_local_slots: dict[str, dict[str, float]] = {}
_local_lock = threading.Lock()


def reset_local_slots() -> None:
    """Clear the in-process slot table. Test-support only."""
    with _local_lock:
        _local_slots.clear()


def _local_acquire(key: str, limit: int, member: str, now: float) -> bool:
    with _local_lock:
        held = _local_slots.setdefault(key, {})
        for stale in [m for m, at in held.items() if at <= now - TURN_LEASE_SECONDS]:
            held.pop(stale, None)
        if len(held) >= limit:
            return False
        held[member] = now
        return True


def _local_release(key: str, member: str) -> None:
    with _local_lock:
        held = _local_slots.get(key)
        if held is not None:
            held.pop(member, None)


def _acquire(key: str, limit: int, member: str) -> bool:
    """Take one slot from `key`, or report the pool full.

    Fails OPEN: when the shared store cannot answer, `eval_script` returns None
    and we admit the turn. An admission control that turns a cache blip into
    "chat is down" is worse than one that occasionally over-admits.
    """
    now = time.time()
    try:
        result = cache.eval_script(_ACQUIRE_LUA, [key], [now, TURN_LEASE_SECONDS, limit, member])
    except Exception:
        # `eval_script` already swallows store errors; reaching here means
        # something unexpected. Admit anyway — this is a protective control, and
        # a bug in it must not become an outage.
        logger.warning("Turn admission check failed on %s; admitting", key, exc_info=True)
        return True
    if result is None:
        # No shared store: bound this replica honestly rather than not at all.
        return _local_acquire(key, limit, member, now)
    return int(result) == 1


def _release(key: str, member: str) -> None:
    """Return one slot, to whichever pool is actually holding it.

    Both paths run unconditionally, because the store's availability can change
    between acquire and release: a turn admitted against the LOCAL table while
    Dragonfly was down would otherwise never hand its slot back once Dragonfly
    recovered (the script returns a ZREM count of 0, not None), and the replica
    pool would shrink by one for a full lease every time the store flapped.
    `_local_release` is a no-op when the member is absent, so running both is
    free.
    """
    cache.eval_script(_RELEASE_LUA, [key], [member])
    _local_release(key, member)


# The two pools a turn is admitted against, in acquisition order. Global first,
# so a tenant sitting at its own limit cannot drain the shared pool with turns
# that never ran: if the per-org slot is refused, the global one is handed back
# on the way out.
def _pools(organization_id: str | None) -> list[tuple[str, int, str]]:
    """`(key, limit, refusal message)` for each pool that applies to this turn."""
    pools: list[tuple[str, int, str]] = []
    if MAX_ACTIVE_TURNS > 0:
        pools.append(
            (
                _GLOBAL_KEY,
                MAX_ACTIVE_TURNS,
                "The assistant is busy right now. Please send your message again in a moment.",
            )
        )
    if MAX_ACTIVE_TURNS_PER_ORG > 0 and organization_id:
        pools.append(
            (
                _org_key(organization_id),
                MAX_ACTIVE_TURNS_PER_ORG,
                "Your organization already has several answers in progress. Please wait for one to finish.",
            )
        )
    return pools


def _release_all(held: list[str], member: str) -> None:
    for key in held:
        try:
            _release(key, member)
        except Exception:  # pragma: no cover - release must never mask the turn's own error
            logger.warning("Failed to release turn slot on %s", key, exc_info=True)


def _acquire_all(organization_id: str | None, member: str) -> tuple[list[str], str | None]:
    """Take every pool this turn needs, or none of them.

    Returns `(held, refusal)`: the keys actually held, and the refusal message
    when a pool was full. On refusal the partial acquisition is rolled back
    before returning, so `held` is empty and the caller has nothing to clean up
    — a tenant sitting at its own limit must not leave the global slot it took
    on the way in.

    One function rather than a loop at each call site because the async manager
    runs this in a worker thread: acquisition has to be atomic from the event
    loop's point of view, or a cancellation landing between two acquires leaves
    a slot held by a turn that will never run.
    """
    held: list[str] = []
    for key, limit, message in _pools(organization_id):
        if not _acquire(key, limit, member):
            _release_all(held, member)
            return [], message
        held.append(key)
    return held, None


def _release_abandoned(acquisition: asyncio.Task, member: str) -> None:
    """Hand back slots taken by an acquisition nobody is waiting for any more.

    Runs as the done-callback of a shielded `_acquire_all` whose awaiter was
    cancelled — a client that hung up while the store round trip was in flight.
    The worker could not be stopped, so it may well have taken the slots; this
    is the only code left that knows about them.
    """
    if acquisition.cancelled():
        return
    if acquisition.exception() is not None:
        # `_acquire_all` swallows store errors and admits; an exception here is
        # a bug, and it means no slot was recorded to give back.
        return
    held, _refusal = acquisition.result()
    if not held:
        return
    logger.info("Releasing %d turn slot(s) from a cancelled admission", len(held))
    try:
        asyncio.get_running_loop().run_in_executor(None, _release_all, held, member)
    except RuntimeError:  # pragma: no cover - loop already closed during shutdown
        _release_all(held, member)


@contextmanager
def admit_turn(organization_id: str | None) -> Iterator[None]:
    """Hold an interactive-turn slot for the duration of the block.

    Raises `TurnAdmissionError` when the global or the organization's pool is
    full. Synchronous — callers on an event loop want `admit_turn_async`.
    """
    member = uuid.uuid4().hex
    held, refusal = _acquire_all(organization_id, member)
    if refusal is not None:
        raise TurnAdmissionError(refusal)
    try:
        yield
    finally:
        _release_all(held, member)


@asynccontextmanager
async def admit_turn_async(organization_id: str | None) -> AsyncIterator[None]:
    """`admit_turn`, off the event loop.

    The store calls underneath are the synchronous `redis` client, and a chat
    turn runs inside an async generator serving a live WebSocket. Up to four
    blocking round trips (two acquires, two releases) at the 500 ms socket
    timeout would stall EVERY other conversation this replica is streaming, not
    just this one — the classic way a protective control becomes the outage.

    `asyncio.to_thread` keeps the semantics identical (same ordering, same
    partial-acquisition rollback, same `finally`) and moves the waiting to a
    worker thread.

    One asymmetry with the sync version, and it drives the shape below:
    `asyncio.to_thread` cannot cancel the worker. A client that hangs up
    mid-acquire cancels this coroutine while the thread runs on and quite
    possibly takes the slot — which would then be held by a turn that never
    runs, until the lease expires 15 minutes later. A few of those and the pool
    is gone.

    Two things prevent that. Acquisition is ONE thread hop (`_acquire_all`), so
    there is no half-acquired state for a cancellation to land in. And the task
    is shielded, so on cancellation the release is chained onto its completion
    rather than raced against it: the slots go back whenever the worker
    finishes, in the right order, without this coroutine having to survive to
    see it.
    """
    member = uuid.uuid4().hex
    acquisition = asyncio.create_task(asyncio.to_thread(_acquire_all, organization_id, member))
    try:
        held, refusal = await asyncio.shield(acquisition)
    except asyncio.CancelledError:
        # Cannot reliably await anything once cancelled, so hand the cleanup to
        # the task itself. `add_done_callback` fires after the worker returns,
        # which is the ordering that matters: releasing before the acquire lands
        # would ZREM nothing and strand the slot anyway.
        acquisition.add_done_callback(lambda task: _release_abandoned(task, member))
        raise
    if refusal is not None:
        raise TurnAdmissionError(refusal)
    try:
        yield
    finally:
        await asyncio.to_thread(_release_all, held, member)
