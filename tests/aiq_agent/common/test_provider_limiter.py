"""The provider limiter: class order, FIFO inside a class, AIMD, fail-open, and the 429 path.

The Lua runs for real: ``fakeredis`` with ``lupa`` executes the very scripts
Dragonfly will, so an ordering bug in them cannot hide behind a Python
re-implementation of what they were meant to do.
"""

from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace

import fakeredis
import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from aiq_agent.common import provider_limiter as pl


class Clock:
    """Time the limiter reads, moved by hand."""

    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def store(monkeypatch):
    """A Redis with Lua, standing in for Dragonfly, behind the cache's one script primitive."""
    client = fakeredis.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True)

    def eval_script(script, keys, args):
        return client.eval(script, len(keys), *keys, *args)

    monkeypatch.setattr(pl.cache, "eval_script", eval_script)
    monkeypatch.setenv(pl._CEILING_ENV, "1")
    monkeypatch.setenv(pl._FLOOR_ENV, "1")
    monkeypatch.setattr(pl, "POLL_SECONDS", 0.01)
    return client


@pytest.fixture
def clock(monkeypatch):
    fake = Clock()
    monkeypatch.setattr(pl, "_now", fake)
    return fake


def poll(member: str, cls: str) -> bool:
    """One poll of one waiter: did it get the slot."""
    attempt = pl._attempt(member, cls)
    assert attempt is not None
    return attempt.taken


def leases(store) -> dict[str, float]:
    return dict(store.zrange(pl._keys(pl.POOL)["leases"], 0, -1, withscores=True))


def limit_of(store) -> int:
    return int(store.hget(pl._keys(pl.POOL)["state"], "limit"))


# ---------------------------------------------------------------- class order


def test_a_free_pool_takes_a_caller_at_once(store, clock):
    assert poll("a", pl.BULK)
    assert set(leases(store)) == {"a"}


def test_a_full_pool_refuses_the_next_caller(store, clock):
    assert poll("a", pl.CHAT)
    assert not poll("b", pl.CHAT)


def test_a_freed_slot_goes_to_chat_then_interactive_then_research_then_bulk(store, clock):
    assert poll("holder", pl.BULK)
    waiters = [("bulk", pl.BULK), ("research", pl.RESEARCH), ("interactive", pl.INTERACTIVE), ("chat", pl.CHAT)]
    for member, cls in waiters:  # arrival order is the reverse of priority
        clock.advance(0.01)
        assert not poll(member, cls)

    served = []
    pending = dict(waiters)
    pl.cache.eval_script(pl.lease_slots.RELEASE_LUA, [pl._keys(pl.POOL)["leases"]], ["holder"])
    while pending:
        clock.advance(0.01)
        for member, cls in list(pending.items()):  # bulk polls first, every round
            if poll(member, cls):
                served.append(member)
                del pending[member]
                pl.cache.eval_script(pl.lease_slots.RELEASE_LUA, [pl._keys(pl.POOL)["leases"]], [member])
    assert served == ["chat", "interactive", "research", "bulk"]


def test_inside_a_class_the_longest_waiter_goes_first(store, clock):
    assert poll("holder", pl.INTERACTIVE)
    for member in ("first", "second", "third"):
        clock.advance(0.01)
        assert not poll(member, pl.INTERACTIVE)
    pl.cache.eval_script(pl.lease_slots.RELEASE_LUA, [pl._keys(pl.POOL)["leases"]], ["holder"])

    clock.advance(0.01)
    assert not poll("third", pl.INTERACTIVE)  # polling first does not jump the queue
    assert not poll("second", pl.INTERACTIVE)
    assert poll("first", pl.INTERACTIVE)


def test_a_later_chat_caller_goes_before_an_earlier_bulk_waiter(store, clock):
    assert poll("holder", pl.BULK)
    assert not poll("bulk", pl.BULK)
    clock.advance(5)
    assert not poll("chat", pl.CHAT)
    pl.cache.eval_script(pl.lease_slots.RELEASE_LUA, [pl._keys(pl.POOL)["leases"]], ["holder"])
    clock.advance(0.01)
    assert not poll("bulk", pl.BULK)
    assert poll("chat", pl.CHAT)


def test_a_caller_does_not_pass_a_waiting_higher_class_even_into_a_free_slot(store, clock, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "2")
    monkeypatch.setenv(pl._FLOOR_ENV, "2")
    assert poll("a", pl.CHAT)
    assert poll("b", pl.CHAT)
    assert not poll("waiting-chat", pl.CHAT)
    pl.cache.eval_script(pl.lease_slots.RELEASE_LUA, [pl._keys(pl.POOL)["leases"]], ["a"])
    assert not poll("bulk", pl.BULK)  # the slot is for the chat caller that was there first
    assert poll("waiting-chat", pl.CHAT)


def test_a_waiter_that_stopped_polling_stops_holding_back_the_classes_below(store, clock):
    assert poll("holder", pl.CHAT)
    assert not poll("gone", pl.CHAT)  # then its task is cancelled and it never polls again
    pl.cache.eval_script(pl.lease_slots.RELEASE_LUA, [pl._keys(pl.POOL)["leases"]], ["holder"])

    clock.advance(0.5)
    assert not poll("bulk", pl.BULK)
    clock.advance(pl.TICKET_SECONDS)
    assert poll("bulk", pl.BULK)


def test_a_holder_that_died_loses_its_slot_when_its_lease_ages_out(store, clock):
    assert poll("dead", pl.CHAT)
    clock.advance(pl.LEASE_SECONDS / 2)
    assert not poll("next", pl.CHAT)
    clock.advance(pl.LEASE_SECONDS)
    assert poll("next", pl.CHAT)
    assert set(leases(store)) == {"next"}


# ----------------------------------------------------------------------- AIMD


def test_a_429_halves_the_limit_down_to_the_floor(store, clock, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "32")
    monkeypatch.setenv(pl._FLOOR_ENV, "5")
    pl.throttle("m")
    assert limit_of(store) == 16
    for expected in (8, 5, 5):
        clock.advance(pl.CUT_COOLDOWN_SECONDS + 1)
        pl.throttle("m")
        assert limit_of(store) == expected


def test_429s_that_arrive_together_count_once(store, clock, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "32")
    monkeypatch.setenv(pl._FLOOR_ENV, "1")
    for _ in range(12):
        pl.throttle("m")
        clock.advance(0.05)
    assert limit_of(store) == 16


def test_each_quiet_interval_adds_one_up_to_the_ceiling(store, clock, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "10")
    monkeypatch.setenv(pl._FLOOR_ENV, "2")
    monkeypatch.setenv(pl._INTERVAL_ENV, "5")
    pl.throttle("m")
    assert limit_of(store) == 5

    seen = []
    for _ in range(8):
        clock.advance(5)
        attempt = pl._attempt("probe", pl.CHAT)
        seen.append(attempt.limit)
        pl._abandon("probe")
    assert seen == [6, 7, 8, 9, 10, 10, 10, 10]


def test_no_quiet_interval_means_no_recovery(store, clock, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "10")
    monkeypatch.setenv(pl._INTERVAL_ENV, "5")
    pl.throttle("m")
    for _ in range(4):  # one second short of the interval
        clock.advance(1)
        assert pl._attempt("probe", pl.CHAT).limit == 5
        pl._abandon("probe")


def test_the_limit_gates_admission(store, clock, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "8")
    monkeypatch.setenv(pl._FLOOR_ENV, "1")
    pl.throttle("m")  # 8 -> 4
    taken = [poll(f"m{i}", pl.INTERACTIVE) for i in range(6)]
    assert taken == [True, True, True, True, False, False]


def test_a_restarted_fleet_member_reads_the_fleets_limit_not_the_ceiling(store, clock, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "64")
    pl.throttle("m")
    assert pl._attempt("fresh", pl.CHAT).limit == 32


def test_the_ceiling_can_be_lowered_under_a_stored_limit(store, clock, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "64")
    pl.throttle("m")
    monkeypatch.setenv(pl._CEILING_ENV, "10")
    monkeypatch.setenv(pl._FLOOR_ENV, "1")
    assert pl._attempt("fresh", pl.CHAT).limit == 10


# ------------------------------------------------------------------ fail open


def test_without_a_store_every_call_proceeds(monkeypatch):
    monkeypatch.setattr(pl.cache, "eval_script", lambda *_: None)
    with pl.slot(cls=pl.BULK) as lease:
        assert not lease.held
    pl.throttle("m")  # and recording a 429 does not raise


def test_a_reply_it_cannot_read_fails_open(monkeypatch):
    monkeypatch.setattr(pl.cache, "eval_script", lambda *_: "garbage")
    with pl.slot() as lease:
        assert not lease.held


def test_switched_off_it_never_touches_the_store(monkeypatch):
    def refuse(*_):
        raise AssertionError("the store was used")

    monkeypatch.setattr(pl.cache, "eval_script", refuse)
    monkeypatch.setenv(pl._ENABLED_ENV, "off")
    with pl.slot():
        pass
    pl.throttle("m")


def test_it_fails_open_the_moment_the_store_goes_while_a_caller_waits(store, clock, monkeypatch):
    assert poll("holder", pl.CHAT)
    real = pl.cache.eval_script
    calls = {"n": 0}

    def store_dies(script, keys, args):
        calls["n"] += 1
        return real(script, keys, args) if calls["n"] < 3 else None

    monkeypatch.setattr(pl.cache, "eval_script", store_dies)
    with pl.slot(cls=pl.BULK) as lease:
        assert not lease.held


# --------------------------------------------------------- waiting for real


def test_a_bulk_waiter_yields_to_a_chat_waiter_that_came_later(store):
    holder = pl.acquire(cls=pl.BULK)
    assert holder.held
    order: list[str] = []

    def wait_for(cls: str) -> None:
        lease = pl.acquire(cls=cls)
        order.append(cls)
        time.sleep(0.05)
        lease.release()

    bulk = threading.Thread(target=wait_for, args=(pl.BULK,))
    bulk.start()
    time.sleep(0.1)  # the bulk waiter is queued first
    chat = threading.Thread(target=wait_for, args=(pl.CHAT,))
    chat.start()
    time.sleep(0.1)
    assert order == []  # both are waiting on the one slot

    holder.release()
    bulk.join(5)
    chat.join(5)
    assert order == [pl.CHAT, pl.BULK]
    assert leases(store) == {}


def test_a_bulk_waiter_yields_to_a_chat_waiter_in_async_code(store):
    async def scenario() -> list[str]:
        holder = await pl.aacquire(cls=pl.BULK)
        order: list[str] = []

        async def wait_for(cls: str) -> None:
            async with pl.aslot(cls=cls):
                order.append(cls)
                await asyncio.sleep(0.02)

        bulk = asyncio.create_task(wait_for(pl.BULK))
        await asyncio.sleep(0.1)
        chat = asyncio.create_task(wait_for(pl.CHAT))
        await asyncio.sleep(0.1)
        assert order == []
        await holder.arelease()
        await asyncio.wait_for(asyncio.gather(bulk, chat), 5)
        return order

    assert asyncio.run(scenario()) == [pl.CHAT, pl.BULK]
    assert leases(store) == {}


def test_a_caller_with_a_deadline_gives_up_and_leaves_no_ticket(store):
    holder = pl.acquire(cls=pl.CHAT)
    with pytest.raises(pl.ProviderWaitTimeout):
        pl.acquire(cls=pl.CHAT, max_wait_seconds=0.05)
    keys = pl._keys(pl.POOL)
    assert store.zcard(keys["polls"]) == 0
    assert all(store.zcard(key) == 0 for key in keys["tickets"])
    holder.release()


def test_a_cancelled_waiter_withdraws_its_ticket(store):
    async def scenario() -> None:
        holder = await pl.aacquire(cls=pl.CHAT)
        waiter = asyncio.create_task(pl.aacquire(cls=pl.CHAT))
        await asyncio.sleep(0.1)
        assert store.zcard(pl._keys(pl.POOL)["tickets"][0]) == 1
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        await asyncio.sleep(0.1)  # the withdrawal runs off the loop
        await holder.arelease()

    asyncio.run(scenario())
    keys = pl._keys(pl.POOL)
    assert store.zcard(keys["polls"]) == 0
    assert all(store.zcard(key) == 0 for key in keys["tickets"])
    assert leases(store) == {}


def test_a_released_slot_is_given_back_once(store):
    lease = pl.acquire()
    assert set(leases(store)) == {lease.member}
    lease.release()
    lease.release()
    assert leases(store) == {}


def test_a_held_slot_is_renewed_while_it_is_held(store, clock):
    lease = pl.acquire()
    clock.advance(pl.LEASE_SECONDS - 1)
    pl._renew_held()
    clock.advance(pl.LEASE_SECONDS - 1)
    assert not poll("other", pl.CHAT)  # it would have aged out unrenewed
    lease.release()
    assert poll("other", pl.CHAT)


def test_a_slot_nobody_gave_back_is_not_renewed_forever(store, clock, monkeypatch):
    lease = pl.acquire()
    real_monotonic = time.monotonic
    monkeypatch.setattr(pl.time, "monotonic", lambda: real_monotonic() + pl.MAX_HOLD_SECONDS + 1)
    pl._renew_held()
    assert lease.member not in pl._held


# ------------------------------------------------------------------------ 429


class RateLimited(Exception):
    def __init__(self, headers: dict[str, str] | None = None, status: int = 429) -> None:
        super().__init__("Too many requests")
        self.status_code = status
        self.response = SimpleNamespace(headers=headers or {}, status_code=status)


def test_a_429_is_recognised_wherever_it_hides():
    assert pl.is_rate_limited(RateLimited())
    assert pl.is_rate_limited(ValueError("rate_limit_exceeded: slow down"))
    wrapped = RuntimeError("retries exhausted")
    wrapped.__cause__ = RateLimited()
    assert pl.is_rate_limited(wrapped)
    assert not pl.is_rate_limited(RateLimited(status=500))
    assert not pl.is_rate_limited(ValueError("boom"))


def test_retry_after_is_read_in_seconds_or_milliseconds_and_capped():
    assert pl.retry_after_seconds(RateLimited({"retry-after": "7"})) == 7
    assert pl.retry_after_seconds(RateLimited({"retry-after-ms": "1500"})) == 1.5
    assert pl.retry_after_seconds(RateLimited({"retry-after": "9999"})) == pl.RETRY_AFTER_CAP_SECONDS
    assert pl.retry_after_seconds(RateLimited({"retry-after": "Wed, 21 Oct 2015 07:28:00 GMT"})) == 0
    assert pl.retry_after_seconds(RateLimited()) == 0
    assert pl.retry_after_seconds(ValueError("no response at all")) == 0


def test_a_429_gives_the_slot_back_before_it_waits_out_the_retry_after(store, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "16")
    slept: list[tuple[float, dict[str, float]]] = []
    monkeypatch.setattr(pl.time, "sleep", lambda seconds: slept.append((seconds, leases(store))))

    with pytest.raises(RateLimited):
        with pl.slot(model="m"):
            assert len(leases(store)) == 1
            raise RateLimited({"retry-after": "10"})

    assert len(slept) == 1
    waited, held_while_waiting = slept[0]
    assert 9 <= waited <= 11
    assert held_while_waiting == {}  # outside the slot
    assert limit_of(store) == 8  # and the fleet's limit was halved


def test_the_429_wait_outside_the_slot_in_async_code(store, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "16")
    held_while_waiting: list[dict[str, float]] = []
    real_sleep = asyncio.sleep

    async def watching_sleep(seconds, *args):
        if seconds >= 1:
            held_while_waiting.append(leases(store))
            seconds = 0
        await real_sleep(seconds)

    monkeypatch.setattr(pl.asyncio, "sleep", watching_sleep)

    async def scenario() -> None:
        with pytest.raises(RateLimited):
            async with pl.aslot(model="m"):
                raise RateLimited({"retry-after": "10"})

    asyncio.run(scenario())
    assert held_while_waiting == [{}]
    assert limit_of(store) == 8


def test_other_errors_give_the_slot_back_without_touching_the_limit(store):
    with pytest.raises(ValueError):
        with pl.slot():
            raise ValueError("boom")
    assert leases(store) == {}
    assert store.exists(pl._keys(pl.POOL)["state"]) == 0


# ---------------------------------------------------------------------- class


def test_the_default_class_is_interactive():
    assert pl.current_class() == pl.INTERACTIVE


def test_a_class_scopes_a_block_and_the_tasks_it_starts():
    with pl.provider_class(pl.CHAT):
        assert pl.current_class() == pl.CHAT

        async def child() -> str:
            return pl.current_class()

        assert asyncio.run(child()) == pl.CHAT
        with pl.provider_class(pl.BULK):
            assert pl.current_class() == pl.BULK
        assert pl.current_class() == pl.CHAT
    assert pl.current_class() == pl.INTERACTIVE


def test_an_unknown_class_is_refused_at_once():
    with pytest.raises(ValueError):
        with pl.provider_class("vip"):
            pass


def test_a_class_set_by_a_decorator_reaches_the_awaited_work():
    @pl.with_provider_class(pl.RESEARCH)
    async def job(value: int) -> tuple[int, str]:
        return value, pl.current_class()

    assert asyncio.run(job(3)) == (3, pl.RESEARCH)
    assert pl.current_class() == pl.INTERACTIVE


def test_a_job_priority_maps_to_its_class():
    assert pl.class_for_priority("bulk") == pl.BULK
    assert pl.class_for_priority("interactive") == pl.INTERACTIVE
    assert pl.class_for_priority(None) == pl.INTERACTIVE
    with pl.priority_scope("bulk"):
        assert pl.current_class() == pl.BULK
    with pl.provider_class(pl.BULK), pl.priority_scope(None):
        assert pl.current_class() == pl.BULK  # a job naming no priority leaves its caller's class


def test_acquire_without_a_class_reads_the_tasks_class(store):
    with pl.provider_class(pl.RESEARCH):
        lease = pl.acquire()
    assert lease.cls == pl.RESEARCH
    lease.release()


# --------------------------------------------------------------------- meters


@pytest.fixture
def metrics(monkeypatch):
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    monkeypatch.setattr(pl, "_meter", lambda: provider.get_meter("test"))
    pl._reset_meters()
    yield reader
    pl._reset_meters()


def collected(reader: InMemoryMetricReader) -> dict[str, list]:
    found: dict[str, list] = {}
    data = reader.get_metrics_data()
    for resource in data.resource_metrics if data else []:
        for scope in resource.scope_metrics:
            for metric in scope.metrics:
                found[metric.name] = list(metric.data.data_points)
    return found


def test_the_limiter_emits_its_meters(store, metrics, monkeypatch):
    monkeypatch.setenv(pl._CEILING_ENV, "16")
    first = pl.acquire(cls=pl.CHAT)
    second = pl.acquire(cls=pl.BULK)
    pl.throttle("vendor/model")
    first.release()

    points = collected(metrics)
    assert points["grid.provider.inflight"][0].value == 1  # one released, one still held
    waits = {tuple(p.attributes.items()): p.count for p in points["grid.provider.wait_seconds"]}
    assert waits == {(("class", "chat"),): 1, (("class", "bulk"),): 1}
    assert [(p.attributes["model"], p.value) for p in points["grid.provider.throttled_total"]] == [("vendor/model", 1)]
    assert [p.value for p in points["grid.provider.limit"]] == [8]
    second.release()
