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

try:
    from redis import exceptions as _redis_exceptions
except ImportError:  # pragma: no cover - redis is optional; no client either
    _redis_exceptions = None  # type: ignore[assignment]

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

# Delete tombstones: key -> monotonic expiry. A failed shared delete leaves the
# old value on the server; the tombstone hides it from get_json for a short
# window instead of popping local and claiming success while the server copy
# resurrects on the next read.
_TOMBSTONE_TTL_SECONDS = 30.0
_local_tombstones: dict[str, float] = {}

_client: Any | None = None
#: ``None`` means "the client has never failed in this process". A float
#: sentinel cannot say that: ``time.monotonic()`` is time since boot on Linux,
#: so ``now - 0.0 < _CLIENT_RETRY_SECONDS`` held for the first 30s of a fresh
#: container and every call silently took the in-process tier -- the cold start
#: is exactly when the shared cache is worth most.
_client_failed_at: float | None = None
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
        if _client_failed_at is not None and time.monotonic() - _client_failed_at < _CLIENT_RETRY_SECONDS:
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


def _exc_type(name: str) -> Any | None:
    return getattr(_redis_exceptions, name, None) if _redis_exceptions is not None else None


# Exception types that say the STORE is down (every consumer backs off).
# Built dynamically so a missing name on an older redis-py never crashes.
_STORE_DOWN_ERRORS: tuple[type, ...] = tuple(
    t
    for t in (
        _exc_type("ConnectionError"),
        _exc_type("TimeoutError"),
        _exc_type("AuthenticationError"),  # subclass of ConnectionError; persistent misconfig
        _exc_type("BusyLoadingError"),  # subclass of ConnectionError; server starting
        _exc_type("NoPermissionError"),  # ACL rejection is per-deployment, not per-key
        _exc_type("OutOfMemoryError"),  # store full: every write fails, not this key
        _exc_type("ReadOnlyError"),  # replica/failover: every write fails
        _exc_type("ClusterDownError"),
        _exc_type("MasterDownError"),
        # Wedged connection decoding garbage: treat as store-down to be safe.
        _exc_type("InvalidResponse"),
    )
    if isinstance(t, type)
)
# AuthorizationError (sibling of AuthenticationError under ConnectionError) is
# store-down via the ConnectionError base; not listed separately on purpose.
_MAX_CONNECTIONS_ERROR: Any | None = _exc_type("MaxConnectionsError")


def _is_transport_error(exc: BaseException) -> bool:
    """Whether ``exc`` says the STORE is unreachable, as opposed to this call.

    Store-down (global cooldown + local fallback): ConnectionError, TimeoutError
    and the deployment-wide rejections above (OOM, read-only, ACL, cluster
    down, busy-loading, auth, wedged-protocol InvalidResponse).

    Per-call (fail open for this key only, no cooldown, no local replica):
    ResponseError incl. WRONGTYPE, NoScriptError, ExecAbortError, DataError,
    ValueError / JSON decode errors. ``MaxConnectionsError`` is explicitly
    per-call despite inheriting ConnectionError: it is a client-side pool leak,
    and a global cooldown would hide it for 30s.

    Redis missing means unclassifiable: return False (fail-open, never engage
    the global cooldown for something we cannot identify).
    """
    if _redis_exceptions is None:
        return False
    if _MAX_CONNECTIONS_ERROR is not None and isinstance(exc, _MAX_CONNECTIONS_ERROR):
        return False
    return isinstance(exc, _STORE_DOWN_ERRORS) if _STORE_DOWN_ERRORS else False


def _on_store_error(operation: str, key: str, exc: BaseException) -> None:
    if _is_transport_error(exc):
        logger.warning("Shared cache %s failed for %s; falling back", operation, key, exc_info=True)
        _mark_client_failed()
    else:
        # Per-key rejection: debug without traceback to avoid one traceback
        # per turn when a single bad key is hot.
        logger.debug("Shared cache %s rejected for %s: %s", operation, key, exc)


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
        _local_tombstones.clear()


def _tombstone_active(key: str) -> bool:
    with _local_lock:
        expires_at = _local_tombstones.get(key)
        if expires_at is None:
            return False
        if time.monotonic() >= expires_at:
            _local_tombstones.pop(key, None)
            return False
        return True


def get_json(key: str) -> Any | None:
    """Fetch and JSON-decode a value; None on miss or any store error."""
    if _tombstone_active(key):
        return None
    client = _get_client()
    if client is not None:
        try:
            raw = client.get(key)
            return json.loads(raw) if raw is not None else None
        except Exception as exc:
            _on_store_error("read", key, exc)
            if not _is_transport_error(exc):
                # Per-key rejection (WRONGTYPE, bad JSON): miss -> recompute.
                # Do NOT serve a stale local copy of a key the store refused.
                return None
    raw = _local_get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


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
            with _local_lock:
                _local_tombstones.pop(key, None)
            return
        except Exception as exc:
            _on_store_error("write", key, exc)
            if not _is_transport_error(exc):
                # Per-key rejection: skip _local_set so we never create a
                # replica-only value the shared tier does not have.
                return
    _local_set(key, raw, ttl_seconds)
    with _local_lock:
        _local_tombstones.pop(key, None)


def delete(key: str) -> bool:
    """Drop a key from the shared cache (and the local fallback).

    Returns True when the shared delete succeeded (or there is no shared
    client); False when the shared delete failed. A failure sets a
    short-lived tombstone so get_json hides the not-deleted server copy
    instead of resurrecting it on the next read.
    """
    client = _get_client()
    if client is not None:
        try:
            client.delete(key)
        except Exception as exc:
            _on_store_error("delete", key, exc)
            with _local_lock:
                _local_store.pop(key, None)
                _local_tombstones[key] = time.monotonic() + _TOMBSTONE_TTL_SECONDS
            return False
        with _local_lock:
            _local_store.pop(key, None)
            _local_tombstones.pop(key, None)
        return True
    with _local_lock:
        _local_store.pop(key, None)
    return True


def _repair_window_ttl(client: Any, key: str, window_seconds: int, cause: BaseException) -> None:
    """Give a fixed-window counter a TTL when the pipelined ``EXPIRE`` was dropped.

    ``EXPIRE ... NX`` needs Redis >= 7.0, and an ACL can deny EXPIRE outright,
    so this is a standing deployment property rather than a blip: every INCR on
    that key lands on a key with no expiry until someone notices. Retrying with
    a plain EXPIRE covers both causes, and it is issued only when the key really
    has no TTL, so it cannot slide a window that is already ticking.

    Raises on failure, which puts the caller on the local per-process window —
    an advisory count is a better answer than a count that never resets.
    """
    ttl = client.ttl(key)
    if isinstance(ttl, int) and ttl >= 0:
        return
    logger.warning(
        "Shared cache dropped EXPIRE on %s (%s); repairing the window TTL",
        key,
        type(cause).__name__,
    )
    client.expire(key, window_seconds)


def incr_fixed_window(key: str, window_seconds: int) -> int | None:
    """Increment a fixed-window counter (rate limiting).

    Returns the counter value within the current window, or None when only
    the in-process fallback is available AND the caller should treat the
    limiter as best-effort (the local counter is still returned — it simply
    only sees this process's traffic).

    NOTE: the local fallback is advisory — with N replicas each counting
    locally, the effective limit is N x the nominal one. Callers enforcing
    hard budgets (money, quota) must treat a local/advisory count as such
    and never as a globally enforced ceiling.
    """
    client = _get_client()
    if client is not None:
        try:
            pipe = client.pipeline()
            pipe.incr(key)
            pipe.expire(key, window_seconds, nx=True)
            try:
                results = pipe.execute(raise_on_error=False)
            except TypeError:
                # Older redis-py without the kwarg: plain execute raises on
                # the first failed command instead of returning partials.
                results = pipe.execute()
            count = results[0] if isinstance(results, (list, tuple)) else results
            if isinstance(count, BaseException):
                raise count
            # INCR landed but EXPIRE did not. `raise_on_error=False` reports
            # that as an exception IN the results list, which this used to
            # drop on the floor -- and a counter with no TTL is not a window
            # counter: it grows without bound, never rolls over, and the
            # limiter denies that key permanently, silently. Repair it.
            expire = results[1] if isinstance(results, (list, tuple)) and len(results) > 1 else None
            if isinstance(expire, BaseException):
                _repair_window_ttl(client, key, window_seconds, expire)
            return int(count)
        except Exception as exc:
            _on_store_error("incr", key, exc)
            if not _is_transport_error(exc):
                return None
    # Per-process fixed window fallback.
    with _local_lock:
        entry = _local_store.get(key)
        now = time.monotonic()
        if entry is None or now >= entry[0]:
            _local_store[key] = (now + window_seconds, "1")
            return 1
        try:
            count = int(entry[1]) + 1
        except (TypeError, ValueError):
            _local_store[key] = (now + window_seconds, "1")
            return 1
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
    except Exception as exc:
        # A Lua compile error, WRONGTYPE key, or NOSCRIPT is this call, not
        # the store (see _is_transport_error): the cooldown is for an
        # unreachable store.
        if _is_transport_error(exc):
            logger.warning("Shared cache eval failed", exc_info=True)
            _mark_client_failed()
        else:
            logger.debug("Shared cache eval rejected by server: %s", exc)
        return None
