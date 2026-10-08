"""Concurrency admission for interactive chat turns — ADR-0040 layer L3.

## The gap this closes

Async research jobs have had admission control since the scaling review
(``GRID_MAX_ACTIVE_JOBS_PER_ORG`` in ``aiq_api.jobs.queue``): a deliberate ceiling
on how many long runs one organization may run at once. Interactive chat turns
had none. A single shared conversation with ten members answering at once starts
ten multi-agent runs, and the only thing that
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

## Leases, renewed while the turn runs

Slots are held in a sorted set scored by when the holder last vouched for them,
and a slot older than ``GRID_TURN_LEASE_SECONDS`` is dropped on the next
acquire. A plain increment/decrement pair leaks a slot forever whenever a
replica is OOM-killed mid-turn, and the pool shrinks silently until nobody can
chat. A lease self-heals.

The lease is RENEWED, every third of it, for as long as the turn runs
(:func:`admit_turn_async`). It used to be taken once, which made the lease carry
two jobs that pull opposite ways: it had to outlast the longest turn (a deep
research fallback runs 40 minutes, the chat deadline is 45) or a live turn's
slot was reclaimed and the pool over-admitted, and it had to be short so a
killed replica's slots came back soon. 900 s did neither. Renewed, the lease
only has to outlast a few missed renewals, so it is short, and no turn is too
long for it.

Fails OPEN, like every other layer except the budget: a cache outage must never
be the reason chat stops.
"""

from __future__ import annotations

import asyncio
import contextlib
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
from aiq_agent.common.lease_slots import ACQUIRE_LUA
from aiq_agent.common.lease_slots import RELEASE_LUA
from aiq_agent.common.lease_slots import RENEW_LUA

logger = logging.getLogger(__name__)

# @environment_variable GRID_MAX_ACTIVE_TURNS
# @category Server
# @type int
# @default 24
# @required false
# Maximum interactive chat turns running concurrently across all organizations.
# Its own pool, never shared with the research queue — that separation is what
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
# @default 120
# @required false
# How long an admission slot survives without its turn renewing it. A running
# turn renews every third of this, so it bounds only how long a replica killed
# mid-turn keeps its slots, not how long a turn may run.
TURN_LEASE_SECONDS = int(os.environ.get("GRID_TURN_LEASE_SECONDS", "120"))


def _renew_interval() -> float:
    """Renew three times per lease, so two missed renewals still hold the slot."""
    return max(TURN_LEASE_SECONDS / 3, 0.01)


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


# The lease scripts are shared with every fleet-wide slot pool (lease_slots).
_ACQUIRE_LUA = ACQUIRE_LUA
_RELEASE_LUA = RELEASE_LUA
_RENEW_LUA = RENEW_LUA

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


def _local_renew(key: str, member: str, now: float) -> bool:
    with _local_lock:
        held = _local_slots.get(key)
        if held is None or member not in held:
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


def _renew_all(held: list[str], member: str) -> None:
    """Re-stamp every slot this turn holds, in the store and the local table.

    Both, for the reason `_release` runs both: the store may have come or gone
    since the acquire. A slot that is no longer there was reclaimed, which means
    renewals stopped for a whole lease; that is logged, never re-taken.
    """
    now = time.time()
    for key in held:
        try:
            renewed = cache.eval_script(_RENEW_LUA, [key], [now, TURN_LEASE_SECONDS, member])
        except Exception:  # pragma: no cover - renewal must never break the turn
            logger.warning("Failed to renew turn slot on %s", key, exc_info=True)
            continue
        local = _local_renew(key, member, now)
        if renewed is not None and int(renewed) == 0 and not local:
            logger.warning("Turn slot on %s was reclaimed while the turn still ran", key)


async def _keep_renewing(held: list[str], member: str) -> None:
    """Renew the turn's slots until cancelled. A failed round is logged, not fatal."""
    while True:
        await asyncio.sleep(_renew_interval())
        try:
            await asyncio.to_thread(_renew_all, held, member)
        except Exception:  # pragma: no cover - _renew_all already contains its errors
            logger.warning("Turn slot renewal failed", exc_info=True)


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


# Drop expired leases, then count what is left: the fleet's running turns.
# One script so the count never includes a lease that has already aged out.
_COUNT_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - lease)
return redis.call('ZCARD', key)
"""


def _local_count(key: str, now: float) -> int:
    with _local_lock:
        held = _local_slots.get(key, {})
        return sum(1 for at in held.values() if at > now - TURN_LEASE_SECONDS)


def active_turns() -> int | None:
    """How many chat turns are running fleet-wide right now, or None when that cannot be known.

    The scaling signal for the chat tier (ADR-0080): KEDA reads it, through
    ``GET /v1/internal/chat-occupancy``, and sizes the tier to it. It is the
    size of the global admission pool, the one number every replica already
    keeps for the cap, so no replica needs to report its own.

    With no shared store configured (``REDIS_URL`` unset: a single process)
    this replica's own table is the whole fleet. With one configured but
    unreachable the answer is None, not this replica's share: a quarter of the
    real number would read as a quiet fleet and scale it in under its turns.
    Only the global pool is counted, so ``GRID_MAX_ACTIVE_TURNS`` of 0 or less
    (admission off) reads as 0.
    """
    now = time.time()
    if not os.environ.get("REDIS_URL"):
        return _local_count(_GLOBAL_KEY, now)
    try:
        count = cache.eval_script(_COUNT_LUA, [_GLOBAL_KEY], [now, TURN_LEASE_SECONDS])
    except Exception:  # pragma: no cover - eval_script contains its own errors
        logger.warning("Active-turn count failed", exc_info=True)
        return None
    return None if count is None else int(count)


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
    full. Synchronous, and it does not renew the lease, so it suits only a block
    shorter than `GRID_TURN_LEASE_SECONDS`. A chat turn wants `admit_turn_async`.
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
    runs, until the lease expires. A few of those at once and the pool is gone.

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
    renewing = asyncio.create_task(_keep_renewing(held, member)) if held else None
    try:
        yield
    finally:
        if renewing is not None:
            renewing.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await renewing
        await asyncio.to_thread(_release_all, held, member)
