"""The conversation bus over REAL Redis semantics (fakeredis), not the in-memory
double. Validates the RedisTransport wrapper — pub/sub and XADD/XRANGE replay —
the exact redis.asyncio calls the stateless chat tier makes in production. Two
RedisTransports over one shared FakeServer stand in for two replicas on one
Dragonfly.

fakeredis is a test-only dep; skipped where it is not installed.
"""

from __future__ import annotations

import asyncio

import pytest

fakeredis = pytest.importorskip("fakeredis")

import fakeredis.aioredis as fa  # noqa: E402
from fakeredis import FakeServer  # noqa: E402

from aiq_api.conversation_bus import FRAME  # noqa: E402
from aiq_api.conversation_bus import HITL_ANSWER  # noqa: E402
from aiq_api.conversation_bus import ConversationBus  # noqa: E402
from aiq_api.conversation_bus import RedisTransport  # noqa: E402

CONV = "conv-redis"


def _redis_replicas() -> tuple[ConversationBus, ConversationBus]:
    server = FakeServer()
    owner = RedisTransport(client=fa.FakeRedis(server=server, decode_responses=True))
    relay = RedisTransport(client=fa.FakeRedis(server=server, decode_responses=True))
    return ConversationBus(owner, "R1"), ConversationBus(relay, "R2")


def test_url_transport_uses_separate_subscribe_client_without_read_timeout():
    """Pub/sub reads BLOCK waiting for the next message, so the subscribe client
    must NOT carry the command client's 1s socket_timeout — that raised
    'Timeout reading from <host>' every second and tore down the relay loop.
    Regression for the Dragonfly relay-loop timeout. Redis.from_url is lazy, so
    this constructs the clients without needing a server."""
    t = RedisTransport(url="redis://localhost:6379/0")
    assert t._redis is not t._sub_redis
    cmd_kwargs = t._redis.connection_pool.connection_kwargs
    sub_kwargs = t._sub_redis.connection_pool.connection_kwargs
    # Commands fail fast; the subscribe read has no timeout (blocks for messages).
    assert cmd_kwargs.get("socket_timeout") == 1.0
    assert sub_kwargs.get("socket_timeout") is None


@pytest.mark.asyncio
async def test_frames_fan_out_over_real_pubsub():
    owner, relay = _redis_replicas()
    got: list = []

    async def _collect():
        async for env in relay.subscribe_frames(CONV):
            got.append(env)
            if len(got) >= 3:
                return

    task = asyncio.ensure_future(_collect())
    await asyncio.sleep(0.1)  # let the real pub/sub SUBSCRIBE land
    for i in range(3):
        await owner.publish_frame(CONV, {"i": i})
    await asyncio.wait_for(task, 3.0)
    assert [e.payload["i"] for e in got] == [0, 1, 2]
    assert all(e.type == FRAME for e in got)


@pytest.mark.asyncio
async def test_hitl_answer_over_real_pubsub():
    owner, relay = _redis_replicas()
    inbox: list = []

    async def _collect():
        async for env in owner.subscribe_input(CONV):
            inbox.append(env)
            return

    task = asyncio.ensure_future(_collect())
    await asyncio.sleep(0.1)
    await relay.publish_input(CONV, HITL_ANSWER, {"message": {"type": "interaction_response"}, "subject": "u1"})
    await asyncio.wait_for(task, 3.0)
    assert inbox[0].type == HITL_ANSWER
    assert inbox[0].payload["subject"] == "u1"


@pytest.mark.asyncio
async def test_attach_replay_via_real_xadd_xrange():
    owner, relay = _redis_replicas()
    for seq in (1, 2, 3):
        await owner.publish_frame(CONV, {"v": 2, "turn_id": "t1", "seq": seq})  # XADD to conv:*:stream
    replayed = await relay.replay_turn(CONV, "t1")  # XRANGE
    assert [frame["seq"] for frame in replayed] == [1, 2, 3]


@pytest.mark.asyncio
async def test_a_turn_id_is_claimed_once_over_real_set_nx():
    owner, relay = _redis_replicas()

    assert await owner.claim_turn(CONV, "t1")  # SET conv:*:turn:t1 NX EX
    assert not await relay.claim_turn(CONV, "t1")


@pytest.mark.asyncio
async def test_ready_is_set_by_the_server_s_subscribe_confirmation():
    owner, relay = _redis_replicas()
    ready = asyncio.Event()
    got: list = []

    async def _collect():
        async for env in relay.subscribe_frames(CONV, ready):
            got.append(env)
            return

    task = asyncio.ensure_future(_collect())
    await asyncio.wait_for(ready.wait(), 3.0)  # no sleep: the server's confirmation is the signal
    await owner.publish_frame(CONV, {"i": 0})
    await asyncio.wait_for(task, 3.0)
    assert got[0].payload == {"i": 0}


@pytest.mark.asyncio
async def test_the_running_marker_is_one_compare_and_write_over_real_redis():
    owner, relay = _redis_replicas()

    assert await owner.acquire_running(CONV, "t1")  # SET NX PX
    assert not await relay.acquire_running(CONV, "t2")
    assert (await relay.running_holder(CONV)).turn_id == "t1"
    assert not await relay.renew_running(CONV, "t1")  # WATCH sees another value: not the relay's
    assert not await relay.release_running(CONV, "t1")
    assert await owner.renew_running(CONV, "t1")
    assert await owner.release_running(CONV, "t1")
    assert await relay.running_holder(CONV) is None
    assert await relay.acquire_running(CONV, "t2")


@pytest.mark.asyncio
async def test_a_running_marker_expires_on_its_ttl_over_real_redis(monkeypatch):
    from aiq_api import conversation_bus

    monkeypatch.setattr(conversation_bus, "RUNNING_TTL_SECONDS", 0.1)
    owner, relay = _redis_replicas()
    await owner.acquire_running(CONV, "t1")

    await asyncio.sleep(0.25)

    assert await relay.running_holder(CONV) is None
    assert await relay.acquire_running(CONV, "t2")
