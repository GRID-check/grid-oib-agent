"""Conversation pub/sub bus (ADR-0028 stateless-agent target).

The whole cross-replica protocol is exercised over the in-process transport with
two ConversationBus instances standing in for two replicas — no live Redis. This
is the same transport that serves the fail-open single-node path, so these tests
also cover that path.
"""

from __future__ import annotations

import asyncio

import pytest

from aiq_api.conversation_bus import CANCEL
from aiq_api.conversation_bus import FRAME
from aiq_api.conversation_bus import HITL_ANSWER
from aiq_api.conversation_bus import SUPERSEDE
from aiq_api.conversation_bus import TURN_END
from aiq_api.conversation_bus import ConversationBus
from aiq_api.conversation_bus import Envelope
from aiq_api.conversation_bus import InMemoryTransport
from aiq_api.conversation_bus import get_bus
from aiq_api.conversation_bus import is_multi_replica_bus
from aiq_api.conversation_bus import reset_bus_for_tests

CONV = "conv-123"


def _two_replicas() -> tuple[ConversationBus, ConversationBus]:
    """Two buses sharing ONE in-memory broker == two replicas on one Dragonfly."""
    transport = InMemoryTransport()
    return ConversationBus(transport, replica_id="R1"), ConversationBus(transport, replica_id="R2")


def _start_collector(aiter, n: int) -> tuple[asyncio.Task, list]:
    """Start consuming ``aiter`` in the background; returns (task, out-list).

    Returning the task lets the caller wait for the subscription to actually
    register (pub/sub is fire-and-forget) BEFORE publishing, then await results.
    """
    out: list = []

    async def _run():
        async for item in aiter:
            out.append(item)
            if len(out) >= n:
                return

    return asyncio.ensure_future(_run()), out


async def _await_collector(task: asyncio.Task, timeout: float = 1.0) -> None:
    await asyncio.wait_for(task, timeout=timeout)


def test_envelope_round_trips():
    env = Envelope(conv=CONV, type=FRAME, payload={"a": 1}, seq=7, origin="R1")
    assert Envelope.decode(env.encode()) == env


@pytest.mark.asyncio
async def test_owner_frames_reach_the_relay_in_order():
    owner, relay = _two_replicas()
    task, received = _start_collector(relay.subscribe_frames(CONV), 3)
    await asyncio.sleep(0.05)  # let the subscription register before publishing
    for i in range(3):
        await owner.publish_frame(CONV, {"i": i})
    await _await_collector(task)
    assert [e.payload["i"] for e in received] == [0, 1, 2]
    assert [e.seq for e in received] == [1, 2, 3]  # monotonic per conversation


@pytest.mark.asyncio
async def test_relay_ignores_its_own_published_frames():
    """owner==relay fast path writes the socket directly, so the subscriber must
    drop frames it published itself (no double delivery)."""
    (owner,) = (_two_replicas()[0],)
    got = []

    async def _run():
        async for e in owner.subscribe_frames(CONV):
            got.append(e)

    task = asyncio.ensure_future(_run())
    await asyncio.sleep(0)
    await owner.publish_frame(CONV, {"i": 0})  # published by R1, subscribed by R1
    await asyncio.sleep(0.05)
    task.cancel()
    assert got == []


@pytest.mark.asyncio
async def test_terminal_frame_is_typed_turn_end():
    owner, relay = _two_replicas()
    task, frames = _start_collector(relay.subscribe_frames(CONV), 1)
    await asyncio.sleep(0.05)
    await owner.publish_frame(CONV, {"final": True}, terminal=True)
    await _await_collector(task)
    assert frames[0].type == TURN_END


@pytest.mark.asyncio
async def test_hitl_answer_flows_relay_to_owner():
    owner, relay = _two_replicas()
    task, inbox = _start_collector(owner.subscribe_input(CONV), 1)
    await asyncio.sleep(0.05)
    await relay.publish_answer(CONV, {"type": "text", "text": "yes, proceed"})
    await _await_collector(task)
    assert inbox[0].type == HITL_ANSWER
    assert inbox[0].payload["text"] == "yes, proceed"


@pytest.mark.asyncio
async def test_control_messages_reach_owner():
    owner, relay = _two_replicas()
    task, inbox = _start_collector(owner.subscribe_input(CONV), 2)
    await asyncio.sleep(0.05)
    await relay.publish_control(CONV, SUPERSEDE)
    await relay.publish_control(CONV, CANCEL)
    await _await_collector(task)
    assert [e.type for e in inbox] == [SUPERSEDE, CANCEL]


@pytest.mark.asyncio
async def test_reconnect_replays_only_missed_frames():
    owner, relay = _two_replicas()
    for i in range(5):
        await owner.publish_frame(CONV, {"i": i})  # seq 1..5, buffered in the stream
    # A relay that last saw seq 2 reconnects and asks for the tail.
    missed = await relay.replay_frames(CONV, after_seq=2)
    assert [e.seq for e in missed] == [3, 4, 5]
    assert all(e.type == FRAME for e in missed)


@pytest.mark.asyncio
async def test_owner_election_is_exclusive():
    owner, other = _two_replicas()
    assert await owner.claim_owner(CONV) is True
    assert await other.claim_owner(CONV) is False  # already owned
    assert await owner.renew_owner(CONV) is True
    assert await other.renew_owner(CONV) is False
    await owner.release_owner(CONV)
    assert await other.claim_owner(CONV) is True  # free again after release


@pytest.mark.asyncio
async def test_stream_buffer_is_bounded(monkeypatch):
    import aiq_api.conversation_bus as bus_mod

    monkeypatch.setattr(bus_mod, "_STREAM_MAXLEN", 10)
    owner, relay = _two_replicas()
    for i in range(50):
        await owner.publish_frame(CONV, {"i": i})
    buffered = await relay.replay_frames(CONV, after_seq=0)
    assert len(buffered) == 10  # oldest trimmed, never grows unbounded


def test_bus_enabled_by_default(monkeypatch):
    monkeypatch.delenv("GRID_CONVERSATION_BUS", raising=False)
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
    reset_bus_for_tests()
    assert is_multi_replica_bus() is True  # default ON — the stateless architecture
    reset_bus_for_tests()


def test_bus_opt_out_via_env(monkeypatch):
    monkeypatch.setenv("GRID_CONVERSATION_BUS", "0")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379")
    reset_bus_for_tests()
    assert is_multi_replica_bus() is False  # explicit opt-out -> local fallback
    reset_bus_for_tests()


def test_bus_is_in_memory_without_redis(monkeypatch):
    monkeypatch.delenv("GRID_CONVERSATION_BUS", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)
    reset_bus_for_tests()
    assert is_multi_replica_bus() is False  # no REDIS_URL -> single-process in-memory
    bus = get_bus()
    assert bus is get_bus()  # cached singleton
    reset_bus_for_tests()
