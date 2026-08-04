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

import logging
import os
import threading
import time
import uuid
from collections.abc import Iterator
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
    if cache.eval_script(_RELEASE_LUA, [key], [member]) is None:
        _local_release(key, member)


@contextmanager
def admit_turn(organization_id: str | None) -> Iterator[None]:
    """Hold an interactive-turn slot for the duration of the block.

    Raises `TurnAdmissionError` when the global or the organization's pool is
    full. Both pools are acquired in that order, and the global slot is returned
    immediately if the per-org one is refused — otherwise a tenant at its own
    limit would slowly drain the shared pool with turns that never ran.
    """
    member = uuid.uuid4().hex
    held: list[str] = []

    try:
        if MAX_ACTIVE_TURNS > 0:
            if not _acquire(_GLOBAL_KEY, MAX_ACTIVE_TURNS, member):
                raise TurnAdmissionError("The assistant is busy right now. Please send your message again in a moment.")
            held.append(_GLOBAL_KEY)

        if MAX_ACTIVE_TURNS_PER_ORG > 0 and organization_id:
            if not _acquire(_org_key(organization_id), MAX_ACTIVE_TURNS_PER_ORG, member):
                raise TurnAdmissionError(
                    "Your organization already has several answers in progress. Please wait for one to finish."
                )
            held.append(_org_key(organization_id))

        yield
    finally:
        for key in held:
            try:
                _release(key, member)
            except Exception:  # pragma: no cover - release must never mask the turn's own error
                logger.warning("Failed to release turn slot on %s", key, exc_info=True)
