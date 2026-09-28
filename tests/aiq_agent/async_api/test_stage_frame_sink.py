"""The stage channel, from the agent tier's sink call to the socket (chat wire v2).

`aiq_agent` owns the graph and never learns what a WebSocket is; `aiq_api` owns
the socket and publishes an implementation of
``aiq_agent.stages.delivery.StageFrameSink`` to it at start-up. Nothing else
connects the two halves, so nothing else can say whether they are connected:
the runner tests stub the sink. This file is where the real sink meets the real
registry and the turn's own sequencer.

What is pinned is the crossing itself (a stage value handed to the published
sink arrives on the socket as a ``stage`` event on the turn's own ``seq``, after
its terminal) and the property the design calls non-negotiable at this
boundary: a send that cannot happen is reported, never raised.

See docs/architecture/post-answer-stages.md §2.7, §4, §7.1.
"""

from __future__ import annotations

from aiq_agent.common.wire_v2 import WIRE_EVENT
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import RunStartedBody
from aiq_agent.common.wire_v2 import StageValue
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.stages import delivery
from aiq_api import chat_socket
from aiq_api.chat_socket import ChatRegistry
from aiq_api.chat_socket import RunningTurn
from aiq_api.chat_socket import TurnWire

CONVERSATION_ID = "conv-stage-sink"
TURN_ID = "msg_1755600000000_3"
READY = StageValue(
    stage="follow_ups", status="ready", payload={"items": [{"question": "Wie wird das Fluchtniveau gemessen?"}]}
)


class _Socket:
    """Records the JSON frames the client would have received; each must parse as a v2 event."""

    def __init__(self, *, raise_on_send: bool = False) -> None:
        self.sent: list[dict] = []
        self.raise_on_send = raise_on_send

    async def send_json(self, frame: dict) -> None:
        if self.raise_on_send:
            raise RuntimeError("socket gone")
        WIRE_EVENT.validate_python(frame)
        self.sent.append(frame)


async def _answered_turn(monkeypatch, socket: _Socket | None) -> ChatRegistry:
    """A turn that already ended (RUN_STARTED, RUN_FINISHED) on a registry private to one test."""
    monkeypatch.setattr(chat_socket, "_persist_in_background", lambda *args: None)
    registry = ChatRegistry()
    if socket is not None:
        registry.set_socket(CONVERSATION_ID, socket)
    turn = RunningTurn(wire=TurnWire(CONVERSATION_ID, TURN_ID, registry.publish), asker_subject=None)
    registry.start_turn(turn)
    await turn.wire.send(RunStartedBody(message_id=turn.message_id))
    await turn.finish(RunFinishedBody(outcome="answered", result=TurnResult(message_id=turn.message_id, text="a")))
    registry.finish_turn(turn)
    return registry


class TestTheStageReachesTheSocket:
    async def test_the_published_sink_is_the_one_the_agent_tier_calls(self) -> None:
        import aiq_api.plugin  # noqa: F401 — registers the sink at import

        assert delivery.get_stage_frame_sink() is chat_socket.send_stage

    async def test_a_ready_stage_arrives_on_the_turn_s_seq_after_its_terminal(self, monkeypatch) -> None:
        socket = _Socket()
        registry = await _answered_turn(monkeypatch, socket)
        delivery.register_stage_frame_sink(registry.send_stage)
        try:
            delivered = await delivery.deliver_stage_frame(CONVERSATION_ID, TURN_ID, READY)
        finally:
            delivery.register_stage_frame_sink(None)

        assert delivered is True
        stage = socket.sent[-1]
        assert (stage["type"], stage["name"], stage["turn_id"], stage["seq"]) == ("CUSTOM", "stage", TURN_ID, 3)
        assert stage["value"] == READY.model_dump(mode="json")

    async def test_an_empty_stage_carries_no_payload_key_at_all(self, monkeypatch) -> None:
        socket = _Socket()
        registry = await _answered_turn(monkeypatch, socket)

        await registry.send_stage(CONVERSATION_ID, TURN_ID, StageValue(stage="follow_ups", status="empty"))

        assert socket.sent[-1]["value"] == {"stage": "follow_ups", "status": "empty"}


class TestTheSinkCannotDamageAnything:
    async def test_no_socket_for_the_conversation_is_reported_not_raised(self, monkeypatch) -> None:
        registry = await _answered_turn(monkeypatch, socket=None)

        assert await registry.send_stage(CONVERSATION_ID, TURN_ID, READY) is False

    async def test_a_socket_that_raises_on_write_is_reported_not_raised(self, monkeypatch) -> None:
        registry = await _answered_turn(monkeypatch, _Socket())
        registry.set_socket(CONVERSATION_ID, _Socket(raise_on_send=True))

        assert await registry.send_stage(CONVERSATION_ID, TURN_ID, READY) is False

    async def test_a_turn_this_process_never_ran_takes_nothing(self, monkeypatch) -> None:
        socket = _Socket()
        registry = await _answered_turn(monkeypatch, socket)
        sent = len(socket.sent)

        assert await registry.send_stage(CONVERSATION_ID, "msg-other", READY) is False
        assert len(socket.sent) == sent
