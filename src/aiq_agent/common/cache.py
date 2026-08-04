"""Shared cache for cross-replica state (ADR-0020).

Backed by a Redis-protocol store (Dragonfly in the compose stack) when
``REDIS_URL`` is set; falls back to an in-process TTL map otherwise, so all
call sites behave identically on a single replica with no cache container.

Values round-trip through JSON — anything that only works in-process would
silently break the moment a second replica appears.

All operations are synchronous with tight socket timeouts and degrade to the
fallback on any error: a cache outage must never take a request down. Call
from async code via ``asyncio.to_thread`` when on the event loop.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

# @environment_variable REDIS_URL
# @category Server
# @type str
# @required false
# Redis-protocol URL of the shared cache (Dragonfly), e.g.
# redis://dragonfly:6379/0. Unset = per-process in-memory fallback.
_REDIS_URL_ENV = "REDIS_URL"

_MAX_LOCAL_ENTRIES = 2048

_local_store: dict[str, tuple[float, str]] = {}
_local_lock = threading.Lock()

_client: Any | None = None
_client_failed_at: float = 0.0
_client_lock = threading.Lock()

# After a connection failure, skip Redis for a short window instead of paying
# the connect timeout on every call.
_CLIENT_RETRY_SECONDS = 30.0


def _get_client() -> Any | None:
    """Lazily build the Redis client; None when unset, unavailable, or cooling down."""
    global _client, _client_failed_at
    url = os.environ.get(_REDIS_URL_ENV)
    if not url:
        return None
    with _client_lock:
        if _client is not None:
            return _client
        if time.monotonic() - _client_failed_at < _CLIENT_RETRY_SECONDS:
            return None
        try:
            import redis

            _client = redis.Redis.from_url(
                url,
                decode_responses=True,
                socket_timeout=0.5,
                socket_connect_timeout=0.5,
            )
            return _client
        except Exception:
            logger.warning("Shared cache unavailable; using in-process fallback", exc_info=True)
            _client_failed_at = time.monotonic()
            return None


def _mark_client_failed() -> None:
    global _client, _client_failed_at
    with _client_lock:
        _client = None
        _client_failed_at = time.monotonic()


def _local_get(key: str) -> str | None:
    with _local_lock:
        entry = _local_store.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if time.monotonic() >= expires_at:
            _local_store.pop(key, None)
            return None
        return value


def _local_set(key: str, value: str, ttl_seconds: float) -> None:
    with _local_lock:
        if len(_local_store) >= _MAX_LOCAL_ENTRIES:
            # Drop the entries closest to expiry rather than growing unbounded.
            for stale in sorted(_local_store, key=lambda k: _local_store[k][0])[: len(_local_store) // 4]:
                _local_store.pop(stale, None)
        _local_store[key] = (time.monotonic() + ttl_seconds, value)


def reset_local_store() -> None:
    """Clear the in-process fallback store. Test-support only.

    The fallback (`REDIS_URL` unset) is a module-global map that otherwise leaks
    cached values across tests. No effect on a real Redis backend.
    """
    with _local_lock:
        _local_store.clear()


def get_json(key: str) -> Any | None:
    """Fetch and JSON-decode a value; None on miss or any store error."""
    client = _get_client()
    if client is not None:
        try:
            raw = client.get(key)
            return json.loads(raw) if raw is not None else None
        except Exception:
            logger.warning("Shared cache read failed for %s; falling back", key, exc_info=True)
            _mark_client_failed()
    raw = _local_get(key)
    return json.loads(raw) if raw is not None else None


def set_json(key: str, value: Any, ttl_seconds: float) -> None:
    """JSON-encode and store a value with a TTL; errors are swallowed."""
    try:
        raw = json.dumps(value)
    except (TypeError, ValueError):
        logger.warning("Refusing to cache non-JSON-serializable value for %s", key)
        return
    client = _get_client()
    if client is not None:
        try:
            client.set(key, raw, px=int(ttl_seconds * 1000))
            return
        except Exception:
            logger.warning("Shared cache write failed for %s; falling back", key, exc_info=True)
            _mark_client_failed()
    _local_set(key, raw, ttl_seconds)


def delete(key: str) -> None:
    """Drop a key from the shared cache (and the local fallback)."""
    client = _get_client()
    if client is not None:
        try:
            client.delete(key)
        except Exception:
            logger.warning("Shared cache delete failed for %s", key, exc_info=True)
            _mark_client_failed()
    with _local_lock:
        _local_store.pop(key, None)


def incr_fixed_window(key: str, window_seconds: int) -> int | None:
    """Increment a fixed-window counter (rate limiting).

    Returns the counter value within the current window, or None when only
    the in-process fallback is available AND the caller should treat the
    limiter as best-effort (the local counter is still returned — it simply
    only sees this process's traffic).
    """
    client = _get_client()
    if client is not None:
        try:
            pipe = client.pipeline()
            pipe.incr(key)
            pipe.expire(key, window_seconds, nx=True)
            count, _ = pipe.execute()
            return int(count)
        except Exception:
            logger.warning("Shared cache incr failed for %s", key, exc_info=True)
            _mark_client_failed()
    # Per-process fixed window fallback.
    with _local_lock:
        entry = _local_store.get(key)
        now = time.monotonic()
        if entry is None or now >= entry[0]:
            _local_store[key] = (now + window_seconds, "1")
            return 1
        count = int(entry[1]) + 1
        _local_store[key] = (entry[0], str(count))
        return count


def eval_script(script: str, keys: list[str], args: list[Any]) -> Any | None:
    """Run a Lua script on the shared store; None when it is unavailable.

    The one primitive the JSON helpers above cannot express: a read-modify-write
    that is atomic on the server. `turn_admission` needs it — a semaphore built
    from separate count and add calls admits more than its limit under exactly
    the concurrency it exists to bound.

    Returns None (never raises) when there is no shared store or the call fails,
    so callers decide their own failure policy rather than inheriting one.
    """
    client = _get_client()
    if client is None:
        return None
    try:
        return client.eval(script, len(keys), *keys, *args)
    except Exception:
        logger.warning("Shared cache eval failed", exc_info=True)
        _mark_client_failed()
        return None
