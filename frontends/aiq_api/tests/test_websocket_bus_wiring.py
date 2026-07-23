"""Registry ⇆ conversation-bus wiring (ADR-0028 stateless chat tier).

Exercises the cross-replica flows the WebSocketSessionRegistry gains in
multi-replica mode — outbound frame publish, relay-onto-socket, and the HITL
answer back-channel — with a peer ConversationBus (sharing one in-memory
transport) standing in for the other replica. Gated: with the bus disabled
(default) none of this runs and the registry behaves exactly as before (covered
by test_websocket_reconnect.py).
"""

from __future__ import annotations

import asyncio

import pytest
from pydantic import BaseModel

from aiq_api.conversation_bus import HITL_ANSWER
from aiq_api.conversation_bus import ConversationBus
from aiq_api.conversation_bus import force_multi_replica_for_tests
from aiq_api.conversation_bus import reset_bus_for_tests
from aiq_api.websocket_reconnect import WebSocketSessionRegistry
from nat.data_models.api_server import TextContent

CONV = "conv-abc"


class _Frame(BaseModel):
    text: str


class _DummySocket:
    def __init__(self) -> None:
        self.sent: list = []

    async def send_json(self, data) -> None:
        self.sent.append(data)


@pytest.fixture
def bus_and_peer():
    """Process bus (the 'owner' replica) + a peer bus (another replica) sharing
    one in-memory transport."""
    bus = force_multi_replica_for_tests()
    peer = ConversationBus(bus._t, replica_id="peer-replica")
    yield bus, peer
    reset_bus_for_tests()


async def _wait(pred, timeout: float = 1.0) -> None:
    async def _run():
        while not pred():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(_run(), timeout=timeout)


@pytest.mark.asyncio
async def test_send_publishes_frame_to_the_bus(bus_and_peer):
    _bus, peer = bus_and_peer
    got: list = []

    async def _collect():
        async for env in peer.subscribe_frames(CONV):
            got.append(env)
            return

    task = asyncio.ensure_future(_collect())
    await asyncio.sleep(0.05)  # let the peer subscription register
    reg = WebSocketSessionRegistry()
    await reg.send(CONV, _Frame(text="hello"))  # no local socket; publishes to bus
    await asyncio.wait_for(task, 1.0)
    assert got[0].payload == {"text": "hello"}


@pytest.mark.asyncio
async def test_relay_writes_bus_frames_onto_the_local_socket(bus_and_peer):
    _bus, peer = bus_and_peer
    reg = WebSocketSessionRegistry()
    sock = _DummySocket()
    await reg.set_socket(CONV, sock)  # starts the relay subscriber
    await asyncio.sleep(0.05)
    await peer.publish_frame(CONV, {"chunk": "abc"})  # a turn on another replica
    await _wait(lambda: len(sock.sent) == 1)
    assert sock.sent == [{"chunk": "abc"}]
    await reg.clear_socket(CONV, sock)  # stops the relay


@pytest.mark.asyncio
async def test_owner_input_loop_resolves_future_from_a_bus_answer(bus_and_peer):
    _bus, peer = bus_and_peer
    reg = WebSocketSessionRegistry()
    future: asyncio.Future = asyncio.get_event_loop().create_future()
    await reg.register_pending_interaction(CONV, future)  # owner subscribes to :input
    await asyncio.sleep(0.05)
    await peer.publish_answer(CONV, TextContent(text="proceed").model_dump())  # answer on another replica
    result = await asyncio.wait_for(future, 1.0)
    assert result.text == "proceed"


@pytest.mark.asyncio
async def test_submit_hitl_answer_publishes_when_no_local_future(bus_and_peer):
    _bus, peer = bus_and_peer
    got: list = []

    async def _collect():
        async for env in peer.subscribe_input(CONV):
            got.append(env)
            return

    task = asyncio.ensure_future(_collect())
    await asyncio.sleep(0.05)
    reg = WebSocketSessionRegistry()  # this replica holds NO pending interaction
    delivered = await reg.submit_hitl_answer(CONV, TextContent(text="yes"))
    assert delivered is True  # published to the owner over the bus
    await asyncio.wait_for(task, 1.0)
    assert got[0].type == HITL_ANSWER
    assert got[0].payload["text"] == "yes"
