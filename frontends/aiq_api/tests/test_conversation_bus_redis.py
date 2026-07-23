"""The conversation bus over REAL Redis semantics (fakeredis), not the in-memory
double. Validates the RedisTransport wrapper — pub/sub, XADD/XRANGE replay, and
SET NX EX owner election — the exact redis.asyncio calls the stateless chat tier
makes in production. Two RedisTransports over one shared FakeServer stand in for
two replicas on one Dragonfly.

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
    assert [e.seq for e in got] == [1, 2, 3]
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
    await relay.publish_answer(CONV, {"type": "text", "text": "go ahead"})
    await asyncio.wait_for(task, 3.0)
    assert inbox[0].type == HITL_ANSWER
    assert inbox[0].payload["text"] == "go ahead"


@pytest.mark.asyncio
async def test_reconnect_replay_via_real_xadd_xrange():
    owner, relay = _redis_replicas()
    for i in range(4):
        await owner.publish_frame(CONV, {"i": i})  # XADD to conv:*:stream
    missed = await relay.replay_frames(CONV, after_seq=1)  # XRANGE
    assert [e.seq for e in missed] == [2, 3, 4]


@pytest.mark.asyncio
async def test_owner_election_via_real_set_nx_ex():
    owner, other = _redis_replicas()
    assert await owner.claim_owner(CONV) is True
    assert await other.claim_owner(CONV) is False  # SET NX fails — already owned
    assert await owner.renew_owner(CONV) is True  # owner renews (EXPIRE)
    await owner.release_owner(CONV)
    assert await other.claim_owner(CONV) is True  # free after DELETE
