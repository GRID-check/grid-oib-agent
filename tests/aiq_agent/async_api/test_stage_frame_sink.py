"""The stage frame channel, from the agent tier's sink call to the socket.

`aiq_agent` owns the graph and never learns what a WebSocket is; `aiq_api` owns
the socket and publishes an implementation of
``aiq_agent.stages.delivery.StageFrameSink`` to it at start-up. Nothing else
connects the two halves, so nothing else can say whether they are connected:
the agent tier's runner tests stub the sink, and the frontend's wire spec reads
fixtures. This file is the only place the real sink meets the real registry.

What is pinned is the crossing itself — a frame handed to the published sink
arrives on the socket unchanged — plus the two properties the design calls
non-negotiable at this boundary: a send that cannot happen is reported, never
raised, and a frame the envelope does not permit is refused here rather than
forwarded to a client that would have to make sense of it.

See docs/architecture/post-answer-stages.md §2.7, §4.1, §7.1.
"""

from __future__ import annotations

import pytest

from aiq_api import websocket_reconnect
from aiq_api.websocket_reconnect import GridStageMessage
from aiq_api.websocket_reconnect import WebSocketSessionRegistry
from aiq_api.websocket_reconnect import send_stage_frame

CONVERSATION_ID = "conv-stage-sink"

READY_FRAME = {
    "type": "grid_stage_message",
    "v": 1,
    "conversation_id": CONVERSATION_ID,
    "parent_id": "msg_1755600000000_3",
    "stage": "follow_ups",
    "status": "ready",
    "payload": {"items": [{"question": "Wie wird das Fluchtniveau gemessen?"}]},
    "timestamp": "2026-08-19T10:31:02.114Z",
}

EMPTY_FRAME = {**{k: v for k, v in READY_FRAME.items() if k != "payload"}, "status": "empty"}


class _Socket:
    """Records the JSON frames the client would have received."""

    def __init__(self, *, raise_on_send: bool = False) -> None:
        self.sent: list[dict] = []
        self.raise_on_send = raise_on_send
        self.scope: dict = {"headers": [], "type": "websocket"}

    async def send_json(self, payload: dict) -> None:
        if self.raise_on_send:
            raise RuntimeError("socket gone")
        self.sent.append(payload)


async def _live_socket(monkeypatch) -> _Socket:
    """A socket registered for CONVERSATION_ID on a registry private to one test."""
    registry = WebSocketSessionRegistry()
    monkeypatch.setattr(websocket_reconnect, "_registry", registry)
    socket = _Socket()
    await registry.set_socket(CONVERSATION_ID, socket)
    return socket


class TestTheFrameReachesTheSocket:
    async def test_the_published_sink_is_the_one_the_agent_tier_calls(self, monkeypatch) -> None:
        """`deliver_stage_frame` — what the runner actually calls — reaches this socket.

        Asserted through the agent tier's own entry point rather than by calling
        `send_stage_frame` directly: importing `aiq_api.plugin` is what registers
        the sink, and a registration that silently stopped happening would leave
        every other test in this file green while no reader ever saw a chip.
        """
        import aiq_api.plugin  # noqa: F401 - imported for the sink registration side effect
        from aiq_agent.stages.delivery import deliver_stage_frame
        from aiq_agent.stages.delivery import get_stage_frame_sink

        assert get_stage_frame_sink() is not None, (
            "importing aiq_api.plugin did not register a stage frame sink: a delivery='frame' "
            "stage would run, be measured, and deliver nothing to anybody"
        )

        live = await _live_socket(monkeypatch)

        assert await deliver_stage_frame(CONVERSATION_ID, READY_FRAME) is True
        assert live.sent == [READY_FRAME]

    async def test_a_ready_frame_arrives_field_for_field(self, monkeypatch) -> None:
        live = await _live_socket(monkeypatch)

        assert await send_stage_frame(CONVERSATION_ID, READY_FRAME) is True
        assert live.sent == [READY_FRAME]

    async def test_an_empty_frame_carries_no_payload_key_at_all(self, monkeypatch) -> None:
        """Not ``"payload": null`` — no key.

        The contract says a payload rides a `ready` frame and nothing else, and
        the client tests for the key's presence. A model that serialised its own
        default would put a payload-shaped hole on every declined turn, which is
        the `payload-on-a-non-ready-frame` frame the client is required to drop.
        """
        live = await _live_socket(monkeypatch)

        await send_stage_frame(CONVERSATION_ID, EMPTY_FRAME)
        assert "payload" not in live.sent[0]
        assert live.sent == [EMPTY_FRAME]


class TestTheSinkCannotDamageAnything:
    async def test_no_socket_for_the_conversation_is_reported_not_raised(self, monkeypatch) -> None:
        """A reader who closed the tab is an undelivered frame, not a failure.

        §7.1: conflating the two would poison the exact GROUP BY the stage exists
        to produce.
        """
        monkeypatch.setattr(websocket_reconnect, "_registry", WebSocketSessionRegistry())
        assert await send_stage_frame(CONVERSATION_ID, READY_FRAME) is False

    async def test_a_socket_that_raises_on_write_is_reported_not_raised(self, monkeypatch) -> None:
        registry = WebSocketSessionRegistry()
        monkeypatch.setattr(websocket_reconnect, "_registry", registry)
        await registry.set_socket(CONVERSATION_ID, _Socket(raise_on_send=True))

        assert await send_stage_frame(CONVERSATION_ID, READY_FRAME) is False

    @pytest.mark.parametrize(
        ("why", "frame"),
        [
            ("a status the envelope does not permit", {**EMPTY_FRAME, "status": "timeout"}),
            ("a status that never leaves the runner", {**EMPTY_FRAME, "status": "skipped"}),
            ("no conversation on the frame", {**EMPTY_FRAME, "conversation_id": None}),
            ("no stage", {k: v for k, v in EMPTY_FRAME.items() if k != "stage"}),
            ("not a stage frame at all", {**EMPTY_FRAME, "type": "system_response_message"}),
        ],
    )
    async def test_a_frame_the_envelope_refuses_never_reaches_the_socket(self, monkeypatch, why, frame) -> None:
        """The producer's bug stops here rather than becoming the client's.

        `timeout` is the live case: the runner maps it onto `failed`, and if that
        mapping were ever removed this boundary would still refuse to put a
        status on the wire that no client knows how to render.
        """
        live = await _live_socket(monkeypatch)

        assert await send_stage_frame(CONVERSATION_ID, frame) is False, why
        assert live.sent == [], why


class TestTheModelIsTheEnvelope:
    def test_the_version_is_carried_from_the_producer_not_pinned_here(self) -> None:
        """Two halves each asserting their own version number is how they come to
        disagree silently. The envelope's version lives in the runner; this tier
        forwards whatever the producer stamped, and the client is what refuses a
        version it does not know."""
        assert GridStageMessage.model_validate({**EMPTY_FRAME, "v": 2}).model_dump()["v"] == 2

    def test_a_frame_with_no_parent_id_still_serialises(self) -> None:
        """A turn off the WebSocket path has no `ws_parent_id`. The frame is
        useless to a client and is dropped there; it must not blow up here."""
        dumped = GridStageMessage.model_validate({**EMPTY_FRAME, "parent_id": None}).model_dump()
        assert dumped["parent_id"] is None
