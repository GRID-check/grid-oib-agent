"""A fleet-wide slot pool: at most `limit` holders, waiting rather than refused."""

from __future__ import annotations

import pytest

from aiq_agent.common import lease_slots


class FakeStore:
    """Dragonfly's sorted-set semantics for the three lease scripts, in memory."""

    def __init__(self) -> None:
        self.pools: dict[str, dict[str, float]] = {}
        self.acquires = 0

    def eval_script(self, script, keys, args):
        pool = self.pools.setdefault(keys[0], {})
        if script == lease_slots.ACQUIRE_LUA:
            self.acquires += 1
            now, lease, limit, member = args
            for stale in [m for m, at in pool.items() if at <= now - lease]:
                del pool[stale]
            if len(pool) >= limit:
                return 0
            pool[member] = now
            return 1
        if script == lease_slots.RELEASE_LUA:
            return 1 if pool.pop(args[0], None) is not None else 0
        raise AssertionError("unexpected script")


@pytest.fixture
def store(monkeypatch):
    fake = FakeStore()
    monkeypatch.setattr(lease_slots.cache, "eval_script", fake.eval_script)
    monkeypatch.setattr(lease_slots.time, "sleep", lambda _s: None)
    return fake


def test_a_holder_takes_a_slot_and_gives_it_back(store):
    with lease_slots.hold("pool", 2, lease_seconds=60, max_wait_seconds=1):
        assert len(store.pools["pool"]) == 1
    assert store.pools["pool"] == {}


def test_a_full_pool_makes_the_next_holder_wait_for_a_release(store, monkeypatch):
    store.pools["pool"] = {"other": 9e18}  # held, and fresh for the length of the test
    released_after = 3

    real = store.eval_script

    def release_eventually(script, keys, args):
        if script == lease_slots.ACQUIRE_LUA and store.acquires == released_after:
            store.pools["pool"].pop("other", None)
        return real(script, keys, args)

    monkeypatch.setattr(lease_slots.cache, "eval_script", release_eventually)
    with lease_slots.hold("pool", 1, lease_seconds=60, max_wait_seconds=60):
        assert "other" not in store.pools["pool"]
    assert store.acquires > released_after


def test_a_dead_holders_slot_ages_out(store):
    store.pools["pool"] = {"dead": 0.0}
    with lease_slots.hold("pool", 1, lease_seconds=60, max_wait_seconds=0):
        assert "dead" not in store.pools["pool"]


def test_without_a_store_every_call_proceeds(monkeypatch):
    monkeypatch.setattr(lease_slots.cache, "eval_script", lambda *_: None)
    with lease_slots.hold("pool", 1, lease_seconds=60, max_wait_seconds=0):
        pass


def test_a_pool_that_never_frees_gives_up_waiting_and_proceeds(store):
    store.pools["pool"] = {"stuck": 9e18}
    with lease_slots.hold("pool", 1, lease_seconds=60, max_wait_seconds=0):
        pass
    assert store.pools["pool"] == {"stuck": 9e18}
