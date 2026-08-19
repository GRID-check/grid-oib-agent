"""Cross-replica write-version for a knowledge collection (cache-invalidation key).

## The contract

``bump(collection)`` records that the collection was written (ingest, delete,
re-sync). ``current(collection)`` returns the version a reader must fold into
its cache key, or ``None`` when the version cannot be resolved.

``None`` means *unknown*, and the ONLY correct reaction to unknown is to skip
the cache — read through, and do not store the result under any key. It must
never be coerced to ``0`` or to "the last value I saw". Callers therefore
cannot treat this as ``int``; that is deliberate.

## Why this module exists at all

The retriever caches retrieval results for static collections for
``STATIC_RESULT_CACHE_TTL_SECONDS`` (1 hour) and keys them on the collection's
write version, so a write invalidates them immediately. That worked only while
"the process" and "the deployment" were the same thing. They are not: Chroma is
a shared server (``AIQ_CHROMA_URL``), the backend runs at ``backendReplicas: 2``
in production, and the deep-research worker tier runs 2-8 more — all reading and
writing ONE store. A version counter held in a module global is invisible to
every replica but its own, so an ingest or a delete on replica A would leave
replica B serving the superseded answer for the full hour of the TTL, with the
TTL as the only bound. On legal text ("welche Fassung gilt?") that is not a
performance detail, it is a wrong answer delivered confidently.

So the version lives in the shared cache (``aiq_agent.common.cache``, ADR-0020),
incremented server-side and atomically, and every replica reads the same number.

## Why unknown must not read as zero

``aiq_agent.common.cache`` is deliberately FAIL-OPEN: when Dragonfly is
unreachable, ``get_json``/``set_json`` silently fall back to a per-process map.
For a rate limiter or a caption cache that is the right trade. For a cache
*invalidation* key it is the worst possible one — a replica that cannot see the
shared counter would read its own private ``0``, match every result it cached
under ``0``, and serve stale legal text *because* the store went down. That is
precisely the failure this module exists to prevent.

Hence ``eval_script`` rather than ``get_json``: it is the one primitive in
``cache`` that does NOT fall back — it returns ``None`` when there is no shared
store or the call fails, leaving the failure policy to us. Our policy is
fail-safe on correctness and fail-open on availability: an unresolvable version
disables the result cache (correct but slower), it never disables invalidation
(wrong but fast).

## Numbering, and why reads may write

One counter per collection, monotonic, no TTL. An expiring — or LRU-evicted —
counter would restart at 1 and could collide with a number a live cache entry
was already keyed on, resurrecting a stale result: the counter must outlive
every entry keyed on it, and a 1-hour result TTL against any expiry policy is a
race not worth running. Because eviction cannot be ruled out on a cache-shaped
store, both scripts also lift the shared counter back to the highest value this
process has ever served (its "floor") in the same atomic call. That self-heals
an evicted counter, and it makes a bump that could not reach the store during an
outage take effect once the store returns, instead of being lost.

## Staleness bound

``current`` memoizes the resolved version in-process for
``MEMO_TTL_SECONDS`` (3s) so the hot retrieval path does not pay a Redis round
trip per query. That memo is the entire cross-replica staleness window: a write
on any replica becomes visible to every other replica's cache key within
MEMO_TTL_SECONDS (plus one round trip), after which entries keyed on the old
version can no longer be hit. Worst case 3 seconds, against 3600 before.

Writes are never memo-delayed on the writing replica: ``bump`` refreshes the
memo with the value it just wrote.

## Single-process deployments

With ``REDIS_URL`` unset there is no shared store and, by that same
configuration, no second replica — the in-process counter IS the authority, and
``current`` returns it exactly (staleness 0). This keeps local dev, the
single-node compose stack and the test suite behaving exactly as the old
module-global counter did. ``REDIS_URL`` set but unreachable is a different
situation entirely — other replicas are presumed to exist — and returns
``None``.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from aiq_agent.common import cache

logger = logging.getLogger(__name__)

# Same variable ``aiq_agent.common.cache`` keys off. Read here (rather than
# importing its private name) purely to tell "no shared store configured" apart
# from "shared store configured but not answering" — those two demand opposite
# answers from ``current``.
_REDIS_URL_ENV = "REDIS_URL"

_KEY_PREFIX = "knowledge:collection-version:"

# @environment_variable AIQ_COLLECTION_VERSION_MEMO_SECONDS
# @category Knowledge Layer
# @type float
# @default 3.0
# @required false
# How long a resolved collection write-version is reused in-process before it is
# re-read from the shared cache. This IS the cross-replica staleness window of
# the retrieval result cache: raising it saves round trips and lengthens the
# window in which one replica can still serve results a write on another replica
# has already superseded.
MEMO_TTL_SECONDS = float(os.environ.get("AIQ_COLLECTION_VERSION_MEMO_SECONDS", "3.0"))

# Don't repeat "cannot resolve the version" once per query while the store is
# down; once a minute per collection is enough to see it in the logs.
_UNKNOWN_LOG_INTERVAL_SECONDS = 60.0

# INCR is atomic on the server; the floor clause repairs a counter that was
# evicted (or a bump that never reached the store) without a second round trip.
_BUMP_LUA = """
local key = KEYS[1]
local floor = tonumber(ARGV[1])
local value = redis.call('INCR', key)
if value < floor then
  value = floor
  redis.call('SET', key, value)
end
return value
"""

# Same shape without the increment: read, and lift to the floor if the shared
# counter has fallen behind what this process already served.
_READ_LUA = """
local key = KEYS[1]
local floor = tonumber(ARGV[1])
local value = tonumber(redis.call('GET', key) or '0')
if value < floor then
  value = floor
  redis.call('SET', key, value)
end
return value
"""

_lock = threading.Lock()
# Highest version this process has ever served for a collection. Raised by every
# local bump and by every value read from the shared store, so the two numbering
# spaces stay one space.
_floors: dict[str, int] = {}
# collection -> (monotonic time of resolution, version)
_memo: dict[str, tuple[float, int]] = {}
_unknown_logged_at: dict[str, float] = {}


def reset_local_versions() -> None:
    """Drop the in-process floors and memo. Test-support only.

    These are module globals; without this a version bumped by one test leaks
    into the next. No effect on the shared store.
    """
    with _lock:
        _floors.clear()
        _memo.clear()
        _unknown_logged_at.clear()


def _shared_store_configured() -> bool:
    """True when a shared cache is configured — i.e. other replicas may exist."""
    return bool(os.environ.get(_REDIS_URL_ENV))


def _eval(script: str, collection: str, floor: int) -> int | None:
    """Run one version script; ``None`` when the shared store cannot answer.

    ``cache.eval_script`` already swallows store errors, so an exception here is
    a bug rather than an outage — it still resolves to ``None``, because a bug in
    the invalidation path must degrade to "do not cache", never to "cache
    anyway".
    """
    try:
        result = cache.eval_script(script, [_KEY_PREFIX + collection], [floor])
    except Exception:
        logger.warning("Collection version script failed for %s", collection, exc_info=True)
        return None
    if result is None:
        return None
    try:
        return int(result)
    except (TypeError, ValueError):
        logger.warning("Collection version for %s came back non-numeric: %r", collection, result)
        return None


def _observe(collection: str, version: int) -> None:
    """Record a version resolved from the shared store: raise the floor, memo it."""
    with _lock:
        if version > _floors.get(collection, 0):
            _floors[collection] = version
        _memo[collection] = (time.monotonic(), version)


def _log_unknown(collection: str) -> None:
    now = time.monotonic()
    with _lock:
        last = _unknown_logged_at.get(collection, 0.0)
        if last and now - last < _UNKNOWN_LOG_INTERVAL_SECONDS:
            return
        _unknown_logged_at[collection] = now
    logger.warning(
        "Collection write-version for %s is unresolvable (shared cache unavailable); "
        "retrieval result caching is disabled for it until the store answers again",
        collection,
    )


def bump(collection: str) -> None:
    """Record a write to ``collection``, invalidating every reader's cache entries.

    Never raises. Ingestion must not fail because an invalidation could not be
    published — and it does not have to, because the reader side refuses to
    serve a version it cannot vouch for.

    The floor handed to the script is ``highest seen + 1``, not a private bump
    count: the shared counter stays the authority on numbering, so concurrent
    bumps are just concurrent ``INCR``s and the floor only ever bites when the
    shared counter has actually fallen behind (eviction, or a bump lost to an
    outage).
    """
    configured = _shared_store_configured()
    with _lock:
        next_version = _floors.get(collection, 0) + 1
        # Drop the memo before the round trip: until the new version is
        # confirmed, this process must not keep serving the old one.
        _memo.pop(collection, None)
        if not configured:
            # No shared store: the local counter is the authority (module docs).
            _floors[collection] = next_version
            _memo[collection] = (time.monotonic(), next_version)
    if not configured:
        return

    shared = _eval(_BUMP_LUA, collection, next_version)
    if shared is None:
        with _lock:
            # Advance locally anyway, so this replica stops matching its own
            # entries at the old version, and so the floor clause re-applies the
            # lost bump to the shared counter once the store answers again.
            _floors[collection] = _floors.get(collection, 0) + 1
        logger.warning(
            "Could not publish the write-version bump for %s to the shared cache; "
            "other replicas keep their cached results until the store returns",
            collection,
        )
        return
    _observe(collection, shared)


def current(collection: str) -> int | None:
    """Return the collection's write-version, or ``None`` when it is unknown.

    ``None`` is NOT a version. A caller that receives it must read through and
    must not store the result — see the module docstring for why "unknown" can
    never be flattened to ``0``.
    """
    now = time.monotonic()
    with _lock:
        memo = _memo.get(collection)
        if memo is not None and now - memo[0] < MEMO_TTL_SECONDS:
            return memo[1]
        floor = _floors.get(collection, 0)

    if not _shared_store_configured():
        return floor

    shared = _eval(_READ_LUA, collection, floor)
    if shared is None:
        _log_unknown(collection)
        return None
    _observe(collection, shared)
    return shared
