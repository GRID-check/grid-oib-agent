"""The shared cache's two contracts (ADR-0020): fail-open, and a cooldown that
is about the STORE, not about one key.

Only an unreachable/deploy-wide store (connection refused, socket timeout,
OOM, read-only, ACL, cluster down, auth, busy-loading, wedged protocol)
engages the global cooldown. A per-key rejection (WRONGTYPE, NOSCRIPT,
EXECABORT, DataError, MaxConnections pool leak, bad JSON) fails open for
that key only: reads return None (never stale local), writes skip the local
replica, and the breaker stays out.
"""

from __future__ import annotations

import json
import logging

import pytest
import redis
from redis.exceptions import AuthenticationError
from redis.exceptions import BusyLoadingError
from redis.exceptions import ClusterDownError
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import DataError
from redis.exceptions import ExecAbortError
from redis.exceptions import InvalidResponse
from redis.exceptions import MasterDownError
from redis.exceptions import MaxConnectionsError
from redis.exceptions import NoPermissionError
from redis.exceptions import NoScriptError
from redis.exceptions import OutOfMemoryError
from redis.exceptions import ReadOnlyError
from redis.exceptions import ResponseError
from redis.exceptions import TimeoutError as RedisTimeoutError

from aiq_agent.common import cache


def _store_down_cases() -> list[tuple[BaseException, str]]:
    return [
        (RedisConnectionError("refused"), "connection"),
        (RedisTimeoutError("slow"), "timeout"),
        (AuthenticationError("bad auth"), "auth"),
        (BusyLoadingError("loading"), "busy"),
        (NoPermissionError("NOPERM no perms"), "noperm"),
        (OutOfMemoryError("OOM full"), "oom"),
        (ReadOnlyError("READONLY replica"), "readonly"),
        (ClusterDownError("CLUSTERDOWN down"), "clusterdown"),
        (MasterDownError("MASTERDOWN down"), "masterdown"),
        (InvalidResponse("wedged"), "invalidresp"),
    ]


def _per_key_cases() -> list[tuple[BaseException, str]]:
    return [
        (ResponseError("WRONGTYPE Operation against a key"), "wrongtype"),
        (NoScriptError("NOSCRIPT missing"), "noscript"),
        (ExecAbortError("EXECABORT client bug"), "execabort"),
        (DataError("bad data"), "dataerror"),
        (MaxConnectionsError("pool exhausted"), "maxconn"),
        (ValueError("bad json"), "valueerror"),
    ]


_STORE_DOWN_IDS = [name for _, name in _store_down_cases()]
_PER_KEY_IDS = [name for _, name in _per_key_cases()]


class _FailingClient:
    def __init__(self, exc: BaseException) -> None:
        self.exc = exc

    def _raise(self, *_args, **_kwargs):
        raise self.exc

    get = set = delete = eval = _raise

    def pipeline(self):
        return self

    incr = expire = _raise
    execute = _raise


class _DictClient:
    """Minimal working shared store (no failures)."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    def get(self, key: str):
        return self.store.get(key)

    def set(self, key: str, value: str, px=None, **_kw):
        self.store[key] = value
        return True

    def delete(self, key: str):
        return self.store.pop(key, None) is not None

    def eval(self, *args, **kwargs):
        return 1

    def pipeline(self):
        return _DictPipeline(self)


class _DictPipeline:
    def __init__(self, client: _DictClient) -> None:
        self._client = client
        self._cmds: list[tuple] = []

    def incr(self, key: str):
        self._cmds.append(("incr", key))
        return self

    def expire(self, key: str, seconds: int, nx: bool = False):
        self._cmds.append(("expire", key))
        return self

    def execute(self, raise_on_error: bool = True):
        out: list = []
        for cmd in self._cmds:
            if cmd[0] == "incr":
                raw = self._client.store.get(cmd[1], "0")
                out.append(int(raw) + 1)
                self._client.store[cmd[1]] = str(out[-1])
            else:
                out.append(True)
        return out


class _PartialPipeline:
    """INCR landed on the server but EXPIRE did not."""

    def incr(self, _key: str):
        return self

    def expire(self, _key: str, _seconds: int, nx: bool = False):
        return self

    def execute(self, raise_on_error: bool = True):
        return [7, ResponseError("expire failed")]


class _PartialClient:
    """A server whose pipelined EXPIRE fails; the repair path is recorded.

    ``repair_fails`` stands for the deployment where EXPIRE is denied outright
    (an ACL, or Redis < 7.0 rejecting ``NX``) rather than blipping — the case
    where the counter would otherwise never get a TTL at all.
    """

    def __init__(self, ttl: int = -1, repair_fails: bool = False) -> None:
        self.ttl_calls: list[str] = []
        self.expire_calls: list[tuple[str, int]] = []
        self._ttl = ttl
        self._repair_fails = repair_fails

    def pipeline(self):
        return _PartialPipeline()

    def ttl(self, key: str):
        self.ttl_calls.append(key)
        return self._ttl

    def expire(self, key: str, seconds: int):
        self.expire_calls.append((key, seconds))
        if self._repair_fails:
            raise ResponseError("EXPIRE denied")
        return True


class _SelectiveClient(_DictClient):
    """Raise only for one bad key; every other key works normally."""

    def __init__(self, bad_key: str, exc: BaseException) -> None:
        super().__init__()
        self._bad_key = bad_key
        self._exc = exc

    def _check(self, key: str) -> None:
        if key == self._bad_key:
            raise self._exc

    def get(self, key: str):
        self._check(key)
        return super().get(key)

    def set(self, key: str, value: str, px=None, **kw):
        self._check(key)
        return super().set(key, value, px=px, **kw)

    def delete(self, key: str):
        self._check(key)
        return super().delete(key)


class _DeleteFailGetOkClient:
    """Shared delete always fails; shared reads still serve the old copy."""

    def __init__(self, exc: BaseException, value: str) -> None:
        self._exc = exc
        self._value = value
        self.get_calls = 0

    def get(self, _key: str):
        self.get_calls += 1
        return self._value

    def set(self, *_a, **_k):
        return True

    def delete(self, _key: str):
        raise self._exc

    def eval(self, *_a, **_k):
        raise self._exc

    def pipeline(self):
        raise self._exc


@pytest.fixture
def _shared_store(monkeypatch):
    """Route the module at an injected client, never touching the network."""
    monkeypatch.setenv("REDIS_URL", "redis://test:6379/0")
    from_url_calls: list = []
    orig_from_url = redis.Redis.from_url

    def _guarded_from_url(*args, **kwargs):
        from_url_calls.append((args, kwargs))
        raise AssertionError("test must not build a real client; install a mock first")

    monkeypatch.setattr(redis.Redis, "from_url", _guarded_from_url)
    cache.reset_local_store()
    cache._client = None
    cache._client_failed_at = None
    yield from_url_calls
    cache._client = None
    cache._client_failed_at = None
    cache.reset_local_store()
    assert orig_from_url is not None  # keep linters honest about the capture


def _install(client) -> None:
    cache._client = client


@pytest.mark.usefixtures("_shared_store")
class TestFailOpen:
    @pytest.mark.parametrize("exc", [c[0] for c in _store_down_cases()], ids=_STORE_DOWN_IDS)
    def test_transport_write_and_read_fall_back_to_local(self, exc):
        _install(_FailingClient(exc))
        cache.set_json("k", {"a": 1}, ttl_seconds=60)
        # Re-install: a transport failure engages the cooldown (client is None),
        # so the read below exercises the local fallback, not the mock.
        cache._client = _FailingClient(exc)
        assert cache.get_json("k") == {"a": 1}

    @pytest.mark.parametrize("exc", [c[0] for c in _per_key_cases()], ids=_PER_KEY_IDS)
    def test_per_key_read_returns_none_not_stale_local(self, exc):
        cache._local_set("k", json.dumps({"stale": True}), 60)
        _install(_FailingClient(exc))
        assert cache.get_json("k") is None

    @pytest.mark.parametrize("exc", [c[0] for c in _per_key_cases()], ids=_PER_KEY_IDS)
    def test_per_key_write_skips_local(self, exc):
        _install(_FailingClient(exc))
        cache.set_json("k", {"a": 1}, ttl_seconds=60)
        assert cache._local_store == {}
        assert isinstance(cache._client, _FailingClient), "per-key must not trip the breaker"

    def test_delete_reports_failure_and_tombstones(self, monkeypatch):
        now = [1000.0]
        monkeypatch.setattr(cache.time, "monotonic", lambda: now[0])
        client = _DeleteFailGetOkClient(ResponseError("nope"), json.dumps({"v": 1}))
        _install(client)
        assert cache.delete("k") is False
        # Tombstoned: the not-deleted server copy stays hidden.
        assert cache.get_json("k") is None
        assert client.get_calls == 0, "tombstone must hide the server copy without a read"
        # After expiry the server copy resurrects (delete really failed).
        now[0] += cache._TOMBSTONE_TTL_SECONDS + 1.0
        assert cache.get_json("k") == {"v": 1}

    def test_delete_success_returns_true(self):
        _install(_DictClient())
        cache.set_json("k", 1, ttl_seconds=60)
        assert cache.delete("k") is True
        assert cache.get_json("k") is None

    def test_incr_counts_locally_when_the_store_is_down(self):
        _install(_FailingClient(RedisTimeoutError("slow")))
        assert cache.incr_fixed_window("rl", 60) == 1
        cache._client = _FailingClient(RedisTimeoutError("slow"))
        assert cache.incr_fixed_window("rl", 60) == 2

    def test_incr_partial_apply_returns_server_count_without_local_fallback(self):
        client = _PartialClient()
        _install(client)
        assert cache.incr_fixed_window("rl", 60) == 7
        assert cache._local_store == {}
        # The count is authoritative, but the dropped EXPIRE left the key with
        # no TTL: without the repair it never rolls over and the limiter denies
        # this key permanently.
        assert client.expire_calls == [("rl", 60)]

    def test_incr_partial_apply_leaves_a_ticking_window_alone(self):
        client = _PartialClient(ttl=42)
        _install(client)
        assert cache.incr_fixed_window("rl", 60) == 7
        # EXPIRE ... NX correctly refuses a key that already has a TTL, so the
        # repair must not slide the window it is checking.
        assert client.expire_calls == []

    def test_incr_falls_back_locally_when_the_window_ttl_cannot_be_repaired(self):
        client = _PartialClient(repair_fails=True)
        _install(client)
        # A count that never resets is worse than an advisory per-process one.
        assert cache.incr_fixed_window("rl", 60) is None

    @pytest.mark.parametrize("exc", [c[0] for c in _per_key_cases()], ids=_PER_KEY_IDS)
    def test_incr_per_key_returns_none_without_tripping_breaker(self, exc):
        client = _FailingClient(exc)
        _install(client)
        assert cache.incr_fixed_window("rl", 60) is None
        assert cache._client is client

    def test_eval_returns_none_and_never_raises(self):
        _install(_FailingClient(ResponseError("compile error")))
        assert cache.eval_script("return 1", [], []) is None

    def test_a_non_json_value_is_refused_not_raised(self, monkeypatch):
        monkeypatch.setattr(cache, "_get_client", lambda: None)
        cache.set_json("k", object(), ttl_seconds=60)
        assert cache.get_json("k") is None

    def test_corrupt_local_value_never_raises(self, monkeypatch):
        monkeypatch.setattr(cache, "_get_client", lambda: None)
        with cache._local_lock:
            cache._local_store["k"] = (9999999999.0, "not-json{{{")
        assert cache.get_json("k") is None


@pytest.mark.usefixtures("_shared_store")
class TestCooldownIsAboutTheStore:
    @pytest.mark.parametrize("exc", [c[0] for c in _store_down_cases()], ids=_STORE_DOWN_IDS)
    @pytest.mark.parametrize("op", ["get", "set", "delete", "incr", "eval"])
    def test_store_down_engages_the_cooldown(self, exc, op):
        _install(_FailingClient(exc))
        _run_op(op)
        assert cache._client is None, f"{op} with store-down error must trip the breaker"

    @pytest.mark.parametrize("exc", [c[0] for c in _per_key_cases()], ids=_PER_KEY_IDS)
    @pytest.mark.parametrize("op", ["get", "set", "delete", "incr", "eval"])
    def test_per_key_never_engages_the_cooldown(self, exc, op):
        client = _FailingClient(exc)
        _install(client)
        _run_op(op)
        assert cache._client is client, f"{op} with per-key error must not cost the shared tier"

    def test_eval_draws_the_same_line(self):
        client = _FailingClient(ResponseError("compile error"))
        _install(client)
        cache.eval_script("return 1", [], [])
        assert cache._client is client
        _install(_FailingClient(RedisConnectionError("refused")))
        cache.eval_script("return 1", [], [])
        assert cache._client is None

    def test_eval_log_levels(self, caplog):
        _install(_FailingClient(RedisConnectionError("refused")))
        with caplog.at_level(logging.DEBUG, logger="aiq_agent.common.cache"):
            caplog.clear()
            cache.eval_script("return 1", [], [])
        assert any(r.levelno == logging.WARNING and "Shared cache eval failed" in r.message for r in caplog.records)
        _install(_FailingClient(ResponseError("compile error")))
        with caplog.at_level(logging.DEBUG, logger="aiq_agent.common.cache"):
            caplog.clear()
            cache.eval_script("return 1", [], [])
        assert any(
            r.levelno == logging.DEBUG and "Shared cache eval rejected by server" in r.message for r in caplog.records
        )
        assert not any(r.levelno == logging.WARNING for r in caplog.records)

    def test_transport_logs_warning_per_key_logs_debug(self, caplog):
        _install(_FailingClient(RedisConnectionError("refused")))
        with caplog.at_level(logging.DEBUG, logger="aiq_agent.common.cache"):
            caplog.clear()
            cache.get_json("k")
        assert any(r.levelno == logging.WARNING and r.exc_info for r in caplog.records)
        _install(_FailingClient(ResponseError("WRONGTYPE")))
        with caplog.at_level(logging.DEBUG, logger="aiq_agent.common.cache"):
            caplog.clear()
            cache.get_json("k")
        assert not any(r.levelno == logging.WARNING for r in caplog.records)

    def test_one_bad_key_does_not_poison_the_next_key(self):
        client = _SelectiveClient("bad", ResponseError("WRONGTYPE bad key"))
        _install(client)
        assert cache.get_json("bad") is None
        client.store["good"] = json.dumps({"ok": True})
        assert cache.get_json("good") == {"ok": True}
        assert cache._client is client

    def test_breaker_suppresses_reconnect(self, _shared_store):
        from_url_calls = _shared_store
        _install(_FailingClient(RedisConnectionError("refused")))
        cache.get_json("k")
        assert cache._client is None
        n_after_trip = len(from_url_calls)
        cache.get_json("k")
        cache.set_json("k2", 1, ttl_seconds=60)
        assert len(from_url_calls) == n_after_trip, "cooldown must skip the store without rebuilding"

    def test_redis_missing_never_trips_the_breaker(self, monkeypatch):
        monkeypatch.setattr(cache, "_redis_exceptions", None)
        assert cache._is_transport_error(RedisConnectionError("x")) is False
        assert cache._is_transport_error(Exception("x")) is False


def _run_op(op: str) -> None:
    if op == "get":
        cache.get_json("k")
    elif op == "set":
        cache.set_json("k", 1, ttl_seconds=60)
    elif op == "delete":
        cache.delete("k")
    elif op == "incr":
        cache.incr_fixed_window("rl", 60)
    elif op == "eval":
        cache.eval_script("return 1", [], [])
    else:  # pragma: no cover - test helper
        raise AssertionError(op)


def test_no_shared_url_uses_local_only(monkeypatch):
    """Without REDIS_URL there is no shared tier and no client is ever built."""
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setattr(redis.Redis, "from_url", _no_client_allowed)
    cache.reset_local_store()
    cache._client = None
    cache._client_failed_at = None
    try:
        assert cache._get_client() is None
        cache.set_json("k", {"a": 1}, ttl_seconds=60)
        assert cache.get_json("k") == {"a": 1}
        assert cache.delete("k") is True
        assert cache.get_json("k") is None
    finally:
        cache._client = None
        cache._client_failed_at = None
        cache.reset_local_store()


def _no_client_allowed(*_args, **_kwargs):
    raise AssertionError("must not build a real client without REDIS_URL")


@pytest.mark.parametrize("uptime", [1.0, 10_000.0], ids=["fresh-boot", "long-running"])
def test_cold_start_builds_the_client_whatever_the_uptime(monkeypatch, uptime):
    """A process that has never failed builds the client, however young the host.

    ``time.monotonic()`` is time since boot on Linux. While "never failed" was
    the float ``0.0``, ``now - 0.0 < _CLIENT_RETRY_SECONDS`` held for the first
    30 seconds of a fresh container: ``_get_client`` returned None and every
    call silently took the in-process tier, with nothing in the logs. The cold
    start is exactly when the shared cache is worth most.
    """
    built = []

    def _from_url(*args, **kwargs):
        built.append((args, kwargs))
        return object()

    monkeypatch.setenv("REDIS_URL", "redis://cache.test:6379/0")
    monkeypatch.setattr(redis.Redis, "from_url", _from_url)
    monkeypatch.setattr(cache.time, "monotonic", lambda: uptime)
    cache.reset_local_store()
    cache._client = None
    cache._client_failed_at = None
    try:
        assert cache._get_client() is not None
        assert len(built) == 1
    finally:
        cache._client = None
        cache._client_failed_at = None
        cache.reset_local_store()
