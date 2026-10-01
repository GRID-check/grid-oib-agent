"""Fleet-wide slot pools on the shared store: leases a holder vouches for.

A pool is a sorted set in Dragonfly, one member per holder, scored by when the
holder last vouched for it. Taking a slot drops the leases older than the lease
and refuses when the pool is full, in ONE script, because split into count and
add two holders both read "one slot left" and both take it. A holder that dies
never releases its slot; the lease ages it out instead, so a pool never shrinks
for good.

Two users: chat admission (``turn_admission``), which refuses a turn it has no
slot for, and ``hold``, for short calls that should WAIT for a slot rather than
be refused, such as the ingest tier's calls to the vision model: however many
ingest workers Kubernetes starts, no more than the pool's size of those calls
are in flight across the fleet, so scaling out adds queueing, not upstream 429s.

Fails open: without the shared store every call proceeds. A capacity guard
that turns a cache outage into stalled ingestion is worse than one that
over-admits for as long as the outage lasts.
"""

from __future__ import annotations

import logging
import random
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager

from aiq_agent.common import cache

logger = logging.getLogger(__name__)

# Drop expired leases, refuse if the pool is full, otherwise take a slot.
# One script because the three steps must be atomic: split apart, two turns
# both read "one slot left" and both take it, which is precisely the
# concurrency this exists to bound. Returns 1 when a slot was taken.
#
# A lease stamped more than one lease into the future is dropped too: only a
# holder whose clock runs that far ahead writes one, and it would otherwise
# hold its slot until our clocks caught up, which `hold` would wait out.
ACQUIRE_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - lease)
redis.call('ZREMRANGEBYSCORE', key, '(' .. (now + lease), '+inf')
if redis.call('ZCARD', key) >= limit then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, lease)
return 1
"""

RELEASE_LUA = "return redis.call('ZREM', KEYS[1], ARGV[1])"

# Re-stamp a slot this turn still holds. A slot that was already reclaimed
# stays gone: adding it back could take the pool past its limit, which is the
# over-admission a renewal exists to prevent. Returns 1 when renewed.
RENEW_LUA = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local member = ARGV[3]

if not redis.call('ZSCORE', key, member) then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, lease)
return 1
"""


@contextmanager
def hold(key: str, limit: int, *, lease_seconds: int, max_wait_seconds: float) -> Iterator[None]:
    """Hold one of ``limit`` fleet-wide slots in ``key`` for the ``with`` body, waiting for one.

    The lease must outlast the body (a call's own timeout is the natural
    value): the slot is not renewed. ``limit`` of 0 or less disables the pool.

    It waits for as long as the pool stays full, saying so every
    ``max_wait_seconds``. Running without a slot after a deadline (as this
    first did) broke the ceiling exactly when it mattered: under sustained
    load every late waiter ran at once, which is the burst of upstream 429s
    the pool exists to prevent. The wait is bounded all the same, because
    every lease ages out: a holder that died frees its slot ``lease_seconds``
    later. Only a missing store lets the body run without one.
    """
    if limit <= 0:
        yield
        return
    member = uuid.uuid4().hex
    started = time.monotonic()
    next_warning = started + max_wait_seconds
    delay = 0.05
    held = False
    while True:
        taken = cache.eval_script(ACQUIRE_LUA, [key], [time.time(), lease_seconds, limit, member])
        if taken is None:
            break  # no shared store: fail open
        if int(taken) == 1:
            held = True
            break
        if time.monotonic() >= next_warning:
            logger.warning("Still waiting for a slot in %s after %.0fs", key, time.monotonic() - started)
            next_warning = time.monotonic() + max_wait_seconds
        # Jittered so a fleet of waiters does not retry in lockstep.
        time.sleep(delay * (0.5 + random.random()))
        delay = min(delay * 2, 2.0)
    try:
        yield
    finally:
        if held:
            cache.eval_script(RELEASE_LUA, [key], [member])
