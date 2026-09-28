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
    env = Envelope(conv=CONV, type=FRAME, payload={"a": 1}, origin="R1")
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
async def test_hitl_answer_flows_relay_to_owner():
    owner, relay = _two_replicas()
    task, inbox = _start_collector(owner.subscribe_input(CONV), 1)
    await asyncio.sleep(0.05)
    await relay.publish_input(CONV, HITL_ANSWER, {"message": {"type": "interaction_response"}, "subject": "u1"})
    await _await_collector(task)
    assert inbox[0].type == HITL_ANSWER
    assert inbox[0].payload["subject"] == "u1"


@pytest.mark.asyncio
async def test_control_messages_reach_owner():
    owner, relay = _two_replicas()
    task, inbox = _start_collector(owner.subscribe_input(CONV), 1)
    await asyncio.sleep(0.05)
    await relay.publish_input(CONV, CANCEL, {"message": {"type": "cancel_turn"}, "subject": "u1"})
    await _await_collector(task)
    assert [e.type for e in inbox] == [CANCEL]


def _frame(turn_id: str, seq: int) -> dict:
    return {"v": 2, "type": "CUSTOM", "turn_id": turn_id, "seq": seq}


@pytest.mark.asyncio
async def test_a_turn_is_read_back_by_its_own_turn_id_in_seq_order():
    """`attach` reads one turn from the stream by the frame's own cursor, from any replica."""
    owner, relay = _two_replicas()
    for turn_id, seq in [("t1", 1), ("t2", 1), ("t1", 3), ("t1", 2)]:
        await owner.publish_frame(CONV, _frame(turn_id, seq))

    replayed = await relay.replay_turn(CONV, "t1")

    assert [(frame["turn_id"], frame["seq"]) for frame in replayed] == [("t1", 1), ("t1", 2), ("t1", 3)]
    assert await relay.replay_turn(CONV, "t9") == []


@pytest.mark.asyncio
async def test_stream_buffer_is_bounded(monkeypatch):
    import aiq_api.conversation_bus as bus_mod

    monkeypatch.setattr(bus_mod, "_STREAM_MAXLEN", 10)
    owner, relay = _two_replicas()
    for i in range(50):
        await owner.publish_frame(CONV, _frame("t1", i + 1))
    buffered = await relay.replay_turn(CONV, "t1")
    assert [frame["seq"] for frame in buffered] == list(range(41, 51))  # oldest trimmed, never grows unbounded


@pytest.mark.asyncio
async def test_the_in_process_stream_keeps_a_bounded_number_of_conversations(monkeypatch):
    """It has no TTL, so a long-lived single node would otherwise keep every conversation it served."""
    import aiq_api.conversation_bus as bus_mod

    monkeypatch.setattr(bus_mod, "_IN_MEMORY_STREAMS", 2)
    owner, _ = _two_replicas()
    for conv in ("a", "b", "c"):
        await owner.publish_frame(conv, _frame("t1", 1))

    assert await owner.replay_turn("a", "t1") == []
    assert [frame["seq"] for frame in await owner.replay_turn("c", "t1")] == [1]


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
