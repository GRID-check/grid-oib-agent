"""Interactive-turn admission control (ADR-0040 layer L3).

Exercised against the per-process fallback (no ``REDIS_URL``), which runs the
same acquire/release/lease logic the Lua script does. What matters here is the
behaviour, not the transport: slots are held for the duration of a turn, the
per-org pool is separate from the global one, a slot is always returned, and a
store that cannot answer admits rather than refuses.
"""

from __future__ import annotations

import contextlib

import pytest

from aiq_agent.common import turn_admission
from aiq_agent.common.turn_admission import TurnAdmissionError
from aiq_agent.common.turn_admission import admit_turn
from aiq_agent.common.turn_admission import admit_turn_async


@pytest.fixture(autouse=True)
def _clean_slots(monkeypatch: pytest.MonkeyPatch):
    """A fresh slot table per test, with no shared store behind it."""
    monkeypatch.delenv("REDIS_URL", raising=False)
    turn_admission.reset_local_slots()
    yield
    turn_admission.reset_local_slots()


def _limits(monkeypatch: pytest.MonkeyPatch, *, total: int, per_org: int) -> None:
    monkeypatch.setattr(turn_admission, "MAX_ACTIVE_TURNS", total)
    monkeypatch.setattr(turn_admission, "MAX_ACTIVE_TURNS_PER_ORG", per_org)


def test_admits_turns_up_to_the_per_org_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=10, per_org=2)

    with contextlib.ExitStack() as stack:
        stack.enter_context(admit_turn("org_1"))
        stack.enter_context(admit_turn("org_1"))

        # The third concurrent turn for this tenant has nowhere to run.
        with pytest.raises(TurnAdmissionError):
            stack.enter_context(admit_turn("org_1"))


def test_releases_the_slot_when_a_turn_finishes(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=10, per_org=1)

    with admit_turn("org_1"):
        pass

    # A pool that only ever fills up is a pool that stops working after one turn.
    with admit_turn("org_1"):
        pass


def test_releases_the_slot_when_a_turn_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=10, per_org=1)

    with pytest.raises(ValueError), admit_turn("org_1"):
        raise ValueError("the agent blew up mid-turn")

    # An answer that failed must not leave its capacity stranded — that is how a
    # pool silently shrinks to nothing over a day.
    with admit_turn("org_1"):
        pass


def test_one_tenant_cannot_exhaust_another(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=10, per_org=1)

    with admit_turn("org_busy"):
        # The whole point of a per-org pool: a noisy tenant is contained.
        with admit_turn("org_quiet"):
            pass


def test_global_pool_bounds_everyone(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=2, per_org=10)

    with contextlib.ExitStack() as stack:
        stack.enter_context(admit_turn("org_1"))
        stack.enter_context(admit_turn("org_2"))

        with pytest.raises(TurnAdmissionError):
            stack.enter_context(admit_turn("org_3"))


def test_a_refused_org_slot_returns_the_global_one(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=3, per_org=1)

    with admit_turn("org_busy"):
        for _ in range(5):
            with pytest.raises(TurnAdmissionError):
                with admit_turn("org_busy"):
                    pass

        # Each refusal above took a global slot first. If it were not handed
        # back, a tenant sitting at its own limit would drain the shared pool
        # with turns that never ran — and everyone else would be refused.
        with admit_turn("org_other"):
            pass


def test_turns_without_a_tenant_still_hit_the_global_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=1, per_org=2)

    with admit_turn(None):
        with pytest.raises(TurnAdmissionError):
            with admit_turn(None):
                pass


def test_disabled_limits_admit_everything(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=0, per_org=0)

    with contextlib.ExitStack() as stack:
        for _ in range(25):
            stack.enter_context(admit_turn("org_1"))


def test_stale_slots_are_reclaimed(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=10, per_org=1)
    monkeypatch.setattr(turn_admission, "TURN_LEASE_SECONDS", 0)

    with admit_turn("org_1"):
        # A replica OOM-killed mid-turn never releases its slot. With a lease,
        # the next acquire reclaims it; with a bare counter the pool would
        # shrink by one, permanently, every time it happened.
        with admit_turn("org_1"):
            pass


def test_falls_back_to_per_replica_pools_without_a_shared_store(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _limits(monkeypatch, total=10, per_org=1)
    # `eval_script` returns None when there is no store to talk to.
    monkeypatch.setattr(turn_admission.cache, "eval_script", lambda *_a, **_k: None)

    with admit_turn("org_1"):
        # Still bounded — just per replica, which is the documented trade rather
        # than a silent absence of any limit.
        with pytest.raises(TurnAdmissionError):
            with admit_turn("org_1"):
                pass


def test_admits_when_the_check_itself_breaks(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=1, per_org=1)

    def _boom(*_args, **_kwargs):
        raise RuntimeError("dragonfly is down")

    monkeypatch.setattr(turn_admission.cache, "eval_script", _boom)

    # Admission control is protective, not load-bearing: a bug in it must never
    # be the reason chat stops answering.
    with admit_turn("org_1"):
        with admit_turn("org_1"):
            pass


@pytest.mark.asyncio
async def test_async_manager_enforces_the_same_pools(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=10, per_org=1)

    async with admit_turn_async("org_1"):
        # The async manager exists so the store round trips leave the event loop,
        # not to relax anything: same pools, same refusal.
        with pytest.raises(TurnAdmissionError):
            async with admit_turn_async("org_1"):
                pass


@pytest.mark.asyncio
async def test_async_manager_returns_the_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    _limits(monkeypatch, total=10, per_org=1)

    async with admit_turn_async("org_1"):
        pass

    async with admit_turn_async("org_1"):
        pass


@pytest.mark.asyncio
async def test_async_manager_returns_the_slot_when_the_turn_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _limits(monkeypatch, total=10, per_org=1)

    with pytest.raises(ValueError):
        async with admit_turn_async("org_1"):
            raise ValueError("the agent blew up mid-turn")

    async with admit_turn_async("org_1"):
        pass


def test_a_slot_taken_locally_is_returned_after_the_store_recovers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A store flap between acquire and release must not strand a slot.

    Acquire while the store is unreachable (local table), then release once it
    answers again. `eval_script` then returns a ZREM count of 0 rather than
    None, so a release that only fell back on `None` would leave the local slot
    held for the whole 900s lease — and every flap would shrink the replica pool
    by one, permanently.
    """
    _limits(monkeypatch, total=10, per_org=1)

    monkeypatch.setattr(turn_admission.cache, "eval_script", lambda *_a, **_k: None)
    manager = admit_turn("org_1")
    manager.__enter__()

    # The store comes back: every call now answers, including the release.
    monkeypatch.setattr(turn_admission.cache, "eval_script", lambda *_a, **_k: 0)
    manager.__exit__(None, None, None)

    monkeypatch.setattr(turn_admission.cache, "eval_script", lambda *_a, **_k: None)
    with admit_turn("org_1"):
        pass
