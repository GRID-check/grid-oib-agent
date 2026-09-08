"""The shared cache's two contracts (ADR-0020): fail-open, and a cooldown that
is about the STORE, not about one key.

Both tiers lean on fail-open harder than on anything else in the module, and
until now nothing asserted it. The cooldown test pins the asymmetry that made
one WRONGTYPE key take the whole shared cache offline for every consumer for
thirty seconds: only an unreachable store (connection refused, socket timeout)
engages it.
"""

from __future__ import annotations

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import ResponseError
from redis.exceptions import TimeoutError as RedisTimeoutError

from aiq_agent.common import cache


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


@pytest.fixture
def _shared_store(monkeypatch):
    """Route the module at an injected client, and undo everything after."""
    monkeypatch.setenv("REDIS_URL", "redis://test:6379/0")
    cache.reset_local_store()
    cache._client = None
    cache._client_failed_at = 0.0
    yield
    cache._client = None
    cache._client_failed_at = 0.0
    cache.reset_local_store()


def _install(client) -> None:
    cache._client = client


@pytest.mark.usefixtures("_shared_store")
class TestFailOpen:
    @pytest.mark.parametrize("exc", [RedisConnectionError("refused"), ResponseError("WRONGTYPE"), ValueError("x")])
    def test_a_write_and_a_read_survive_any_store_error(self, exc):
        _install(_FailingClient(exc))
        cache.set_json("k", {"a": 1}, ttl_seconds=60)
        _install(_FailingClient(exc))
        assert cache.get_json("k") == {"a": 1}

    def test_delete_drops_the_local_copy_even_when_the_store_fails(self):
        cache.set_json("k", 1, ttl_seconds=60)
        _install(_FailingClient(ResponseError("nope")))
        cache.delete("k")
        assert cache.get_json("k") is None

    def test_incr_counts_locally_when_the_store_fails(self):
        _install(_FailingClient(RedisTimeoutError("slow")))
        assert cache.incr_fixed_window("rl", 60) == 1
        assert cache.incr_fixed_window("rl", 60) == 2

    def test_eval_returns_none_and_never_raises(self):
        _install(_FailingClient(ResponseError("compile error")))
        assert cache.eval_script("return 1", [], []) is None

    def test_a_non_json_value_is_refused_not_raised(self):
        cache.set_json("k", object(), ttl_seconds=60)
        assert cache.get_json("k") is None


@pytest.mark.usefixtures("_shared_store")
class TestCooldownIsAboutTheStore:
    def test_an_unreachable_store_engages_the_cooldown(self):
        _install(_FailingClient(RedisConnectionError("refused")))
        cache.get_json("k")
        assert cache._client is None
        assert cache._get_client() is None, "the cooldown should skip the store"

    def test_a_socket_timeout_engages_the_cooldown(self):
        _install(_FailingClient(RedisTimeoutError("slow")))
        cache.set_json("k", 1, ttl_seconds=60)
        assert cache._client is None

    @pytest.mark.parametrize("exc", [ResponseError("WRONGTYPE Operation against a key"), ValueError("bad json")])
    def test_one_bad_key_does_not_take_the_store_offline(self, exc):
        client = _FailingClient(exc)
        _install(client)
        cache.get_json("k")
        assert cache._client is client, "a per-key error must not cost every consumer the shared tier"

    def test_eval_draws_the_same_line(self):
        client = _FailingClient(ResponseError("compile error"))
        _install(client)
        cache.eval_script("return 1", [], [])
        assert cache._client is client
        _install(_FailingClient(RedisConnectionError("refused")))
        cache.eval_script("return 1", [], [])
        assert cache._client is None
