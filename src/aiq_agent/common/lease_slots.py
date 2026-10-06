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

A third user, ``provider_limiter``, adds an order to the wait: waiters hold a
ticket in a sorted set per priority class, and a free slot goes to the oldest
ticket of the highest class waiting (``RANKED_ADMISSION_LUA``). The ranked
admission is a fragment, not a script, because the limit that gates it is the
caller's to compute (a fixed number here, an adaptive one there).

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

# Drop the leases that are no longer vouched for. Shared by every script that
# counts a pool, so they all age a holder out the same way. A function of the
# pool's key; expects the locals `now` and `lease`.
#
# A lease stamped more than one lease into the future is dropped too: only a
# holder whose clock runs that far ahead writes one, and it would otherwise
# hold its slot until our clocks caught up, which `hold` would wait out.
PRUNE_LUA = """
local function prune(pool)
  redis.call('ZREMRANGEBYSCORE', pool, '-inf', now - lease)
  redis.call('ZREMRANGEBYSCORE', pool, '(' .. (now + lease), '+inf')
end
"""

# Drop expired leases, refuse if the pool is full, otherwise take a slot.
# One script because the three steps must be atomic: split apart, two turns
# both read "one slot left" and both take it, which is precisely the
# concurrency this exists to bound. Returns 1 when a slot was taken.
ACQUIRE_LUA = (
    """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
"""
    + PRUNE_LUA
    + """
prune(key)
if redis.call('ZCARD', key) >= limit then
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('EXPIRE', key, lease)
return 1
"""
)

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


# Admission by rank, under two limits: the slot goes to the oldest waiter of
# the highest class waiting, never to whoever polls first, and only while BOTH
# the key's pool and the caller's scoped pool (one model's) have room.
#
# A fragment, because the limits belong to the caller. It expects these locals
# (numbers, except `member`): now, lease, ticket_ttl, member, rank (1 is served
# first), classes (how many ticket sets), limit (the key pool's), scoped (1 when
# the caller also holds a slot in a scoped pool) and scoped_limit; and these
# keys: KEYS[1] the key pool's leases, KEYS[2] the waiters' last poll, KEYS[3]
# the waiters a full scoped pool is holding, KEYS[4 .. 3 + classes] one ticket
# set per class (scored by arrival, highest class first), KEYS[4 + classes] the
# scoped pool's leases. Further keys are the caller's.
#
# A waiter whose scoped pool is full is marked blocked on every poll and does
# not count as "ahead" of anyone, so one model at its limit never holds back the
# others; it counts again as soon as its own poll finds room. A waiter that
# stops polling is dropped after `ticket_ttl`, from every set at once: its ticket
# would otherwise hold back every class below it.
#
# Returns {taken, limit, in flight, scoped limit, scoped in flight}.
RANKED_ADMISSION_LUA = (
    """
local key = KEYS[1]
local seen = KEYS[2]
local blocked = KEYS[3]
local scoped_key = KEYS[4 + classes]
"""
    + PRUNE_LUA
    + """
prune(key)
if scoped == 1 then prune(scoped_key) end
local gone = redis.call('ZRANGEBYSCORE', seen, '-inf', now - ticket_ttl)
for _, waiter in ipairs(gone) do
  redis.call('ZREM', seen, waiter)
  redis.call('ZREM', blocked, waiter)
  for i = 1, classes do
    redis.call('ZREM', KEYS[3 + i], waiter)
  end
end
redis.call('ZADD', KEYS[3 + rank], 'NX', now, member)
redis.call('ZADD', seen, now, member)
local inflight = redis.call('ZCARD', key)
local scoped_inflight = 0
if scoped == 1 then scoped_inflight = redis.call('ZCARD', scoped_key) end

local function keep_alive()
  redis.call('EXPIRE', seen, ticket_ttl * 4)
  redis.call('EXPIRE', blocked, ticket_ttl * 4)
  for i = 1, classes do
    redis.call('EXPIRE', KEYS[3 + i], ticket_ttl * 4)
  end
end

if scoped == 1 and scoped_inflight >= scoped_limit then
  redis.call('ZADD', blocked, now, member)
  keep_alive()
  return {0, limit, inflight, scoped_limit, scoped_inflight}
end
redis.call('ZREM', blocked, member)

local function head_of(class_index)
  local ids = redis.call('ZRANGE', KEYS[3 + class_index], 0, 31)
  for _, id in ipairs(ids) do
    local since = redis.call('ZSCORE', blocked, id)
    if not since or tonumber(since) < now - ticket_ttl then
      return id
    end
  end
  return nil
end
local first = true
for i = 1, rank - 1 do
  if head_of(i) then first = false end
end
if first and head_of(rank) == member and inflight < limit then
  redis.call('ZREM', KEYS[3 + rank], member)
  redis.call('ZREM', seen, member)
  redis.call('ZADD', key, now, member)
  redis.call('EXPIRE', key, lease)
  if scoped == 1 then
    redis.call('ZADD', scoped_key, now, member)
    redis.call('EXPIRE', scoped_key, lease)
  end
  return {1, limit, inflight + 1, scoped_limit, scoped_inflight + 1}
end
keep_alive()
return {0, limit, inflight, scoped_limit, scoped_inflight}
"""
)

# Take a member out of every key given: a waiter that gives up (the poll set and
# every ticket set) and a holder that is done (every pool it holds a slot in).
# Returns how many keys held it.
WITHDRAW_LUA = """
local removed = 0
for i = 1, #KEYS do
  removed = removed + redis.call('ZREM', KEYS[i], ARGV[1])
end
return removed
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
