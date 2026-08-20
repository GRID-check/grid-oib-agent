"""The first non-negotiable, asserted rather than argued.

    "The answer is already written when a stage runs. A stage can therefore
    never delay, alter, block or fail an answer. If it can, it is not a stage."
    (docs/architecture/post-answer-stages.md §2.1)

Until slice 3 that was true by having nowhere to go: a `silent` stage touched no
socket, so no test had to say so. Wiring `delivery="frame"` is precisely the
change that makes it falsifiable — §11's second risk in its own words: *"the
delivery channel is new code on the answer path's process … a bug there could
write to a socket mid-turn."* This file is that risk turned into an assertion.

The run is the real one end to end: the real `schedule_post_answer_stages`, the
real `aiq_api` sink, the real `WebSocketSessionRegistry`, the real message
handler, and a socket that records exactly what a browser would receive. What is
compared is the bytes: a turn with a stage that raises, times out or is
rate-limited must put the SAME answer frames on the socket, in the same order, as
a turn with no stage at all.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

from aiq_agent.agents.chat_researcher.register import _response_to_chunks
from aiq_agent.common import _create_chat_response
from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.stages import registry
from aiq_agent.stages import runner
from aiq_agent.stages.spec import GateDecision
from aiq_agent.stages.spec import StageSpec
from aiq_agent.stages.spec import TurnFacts
from aiq_api import websocket_reconnect
from aiq_api.websocket_reconnect import ReconnectableWebSocketMessageHandler
from aiq_api.websocket_reconnect import WebSocketSessionRegistry
from aiq_api.websocket_reconnect import send_stage_frame
from nat.data_models.api_server import WebSocketMessageStatus
from nat.data_models.api_server import WebSocketMessageType

CONVERSATION_ID = "conv-fault-isolation"
PARENT_ID = "msg_1755600000000_3"
ANSWER = (
    "Die Brüstungshöhe beträgt nach OIB-Richtlinie 4 mindestens 100 cm, "
    "gemessen ab der Standfläche bis zur Oberkante der Umwehrung."
)


class _RateLimitError(RuntimeError):
    """A provider refusing the stage's call. Named, because the reason lands on
    the span as the exception's class name and that is what an operator groups
    by."""


class _Socket:
    """Records the JSON frames the client would have received, in order."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.scope: dict = {"headers": [], "type": "websocket"}

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _SessionManager:
    def get_workflow_single_output_schema(self):
        return None

    def get_workflow_streaming_output_schema(self):
        return None

    @asynccontextmanager
    async def session(self, **_kwargs):
        yield object()


class _StepAdaptor:
    pass


class _Worker:
    def set_conversation_handler(self, _conversation_id: str, _handler: object) -> None:
        return None

    def get_conversation_handler(self, _conversation_id: str) -> object | None:
        return None

    def remove_conversation_handler(self, _conversation_id: str) -> None:
        return None


@pytest.fixture(autouse=True)
def _isolated_registry():
    """Only the stage a test declares runs; the built-in ones stay out of the way."""
    saved = dict(registry._STAGES)
    registry._STAGES.clear()
    runner._claimed_keys.clear()
    runner._handler_tasks.clear()
    runner._background_tasks.clear()
    try:
        yield
    finally:
        registry._STAGES.clear()
        registry._STAGES.update(saved)
        runner._claimed_keys.clear()
        runner._handler_tasks.clear()
        runner._background_tasks.clear()


@pytest.fixture(autouse=True)
def _live_sink(monkeypatch):
    """The real sink over a socket private to one test."""
    from aiq_agent.stages import delivery

    session_registry = WebSocketSessionRegistry()
    monkeypatch.setattr(websocket_reconnect, "_registry", session_registry)
    delivery.register_stage_frame_sink(send_stage_frame)
    try:
        yield session_registry
    finally:
        delivery.register_stage_frame_sink(None)


def _facts() -> TurnFacts:
    return TurnFacts(
        conversation_id=CONVERSATION_ID,
        ws_parent_id=PARENT_ID,
        organization_id="org_1",
        project_id="proj_1",
        query="Wie hoch muss die Brüstung sein?",
        answer=ANSWER,
        enabled_stages=frozenset({"probe"}),
    )


def _spec(handler, **overrides) -> StageSpec:
    kwargs = {
        "id": "probe",
        "agent_group": AgentGroup.MEMORY_REFLECTION,
        "flag_slug": "probe-stage",
        "env_default": "GRID_STAGE_PROBE_ENABLED",
        "timeout_s": 5.0,
        "gate": lambda facts: GateDecision.proceed(),
        "handler": handler,
        "payload_model": None,
        "delivery": "frame",
        "max_output_tokens": None,
    }
    kwargs.update(overrides)
    return registry.register_stage(StageSpec(**kwargs))


async def _emit_answer(session_registry: WebSocketSessionRegistry, socket: _Socket) -> None:
    """Stream one finished answer to the socket exactly as the handler's own loop
    does: deltas IN_PROGRESS, the terminal chunk COMPLETE."""
    await session_registry.set_socket(CONVERSATION_ID, socket)
    handler = ReconnectableWebSocketMessageHandler(
        socket=socket,
        session_manager=_SessionManager(),
        step_adaptor=_StepAdaptor(),
        worker=_Worker(),
    )
    handler._conversation_id = CONVERSATION_ID
    handler._message_parent_id = PARENT_ID

    response = _create_chat_response(ANSWER, response_id="r1", model="chat_researcher")
    chunks = _response_to_chunks(response, stream=True)
    for chunk in chunks[:-1]:
        await handler.create_websocket_message(
            data_model=chunk,
            status=WebSocketMessageStatus.IN_PROGRESS,
            persist_on_drop=False,
        )
    await handler.create_websocket_message(
        data_model=chunks[-1],
        message_type=WebSocketMessageType.RESPONSE_MESSAGE,
        status=WebSocketMessageStatus.COMPLETE,
    )


def _answer_frames(socket: _Socket) -> list[dict]:
    return [frame for frame in socket.sent if frame.get("type") != "grid_stage_message"]


def _stage_frames(socket: _Socket) -> list[dict]:
    return [frame for frame in socket.sent if frame.get("type") == "grid_stage_message"]


async def _turn(session_registry, handler=None, **spec_overrides) -> tuple[_Socket, dict]:
    """One whole turn: schedule the stages, stream the answer, then let the
    stages finish. Returns the socket and the outcomes by stage id.

    The ordering is the call site's ordering (`register.py`: schedule, then yield
    the chunks), and the stage tasks are deliberately left in flight while the
    answer is being written — which is the only arrangement in which a stage
    COULD corrupt the stream. Nothing here asserts on the ORDER the two kinds of
    frame arrive in: that is a genuine race and the design is explicit that
    nothing may depend on it (§7.7). What is asserted is that the answer's own
    frames are unchanged by it.
    """
    if handler is not None:
        _spec(handler, **spec_overrides)
    facts = _facts()
    socket = _Socket()

    tasks = runner.schedule_post_answer_stages(facts, llms={AgentGroup.MEMORY_REFLECTION: object()})
    await _emit_answer(session_registry, socket)
    outcomes = await asyncio.gather(*tasks)
    return socket, {outcome.stage_id: outcome for outcome in outcomes}


async def _turn_with_a_late_stage(session_registry, handler, **spec_overrides) -> tuple[_Socket, dict]:
    """The production timing: the stage finishes seconds after the turn closed.

    The handler is held until the whole answer is on the socket, so the frame's
    position is a fact rather than a race — which is what lets the tests below
    say the frame lands AFTER the closed turn instead of merely alongside it.
    """
    answer_done = asyncio.Event()

    async def _held(ctx):
        await answer_done.wait()
        return await handler(ctx)

    _spec(_held, **spec_overrides)
    socket = _Socket()
    tasks = runner.schedule_post_answer_stages(_facts(), llms={AgentGroup.MEMORY_REFLECTION: object()})
    await _emit_answer(session_registry, socket)
    answer_done.set()
    outcomes = await asyncio.gather(*tasks)
    return socket, {outcome.stage_id: outcome for outcome in outcomes}


async def _returns(value):
    return value


class TestTheAnswerIsByteIdentical:
    """The control run is the measurement: a turn with no stage at all."""

    @pytest.mark.parametrize(
        ("why", "handler", "overrides", "expected_status", "expected_reason"),
        [
            (
                "a stage that raises",
                lambda ctx: _boom(RuntimeError("the model refused")),
                {},
                "failed",
                "RuntimeError",
            ),
            (
                "a stage that is rate-limited",
                lambda ctx: _boom(_RateLimitError("429")),
                {},
                "failed",
                "_RateLimitError",
            ),
            (
                "a stage that times out",
                lambda ctx: asyncio.sleep(10),
                {"timeout_s": 0.05},
                "timeout",
                None,
            ),
            (
                "a stage whose payload its own model rejects",
                lambda ctx: _returns("not a payload"),
                {},
                "failed",
                "invalid_payload",
            ),
        ],
    )
    async def test_the_answer_frames_are_the_same_as_with_no_stage(
        self, _live_sink, why, handler, overrides, expected_status, expected_reason
    ) -> None:
        control, _ = await _turn(_live_sink)
        assert _stage_frames(control) == [], "the control run declared no stage and must produce no stage frame"

        runner._claimed_keys.clear()
        observed, outcomes = await _turn(_live_sink, handler=handler, **overrides)

        assert outcomes["probe"].status == expected_status, why
        assert outcomes["probe"].reason == expected_reason, why
        assert _answer_frames(observed) == _answer_frames(control), (
            f"{why} changed the answer the reader receives. The answer is written before any stage "
            f"runs and no stage holds a reference to it, so any difference here means the stage path "
            f"reached the answer path — which is the one thing a stage may never do."
        )


class TestTheStagePathCannotBlockTheAnswerPath:
    async def test_scheduling_returns_before_any_handler_has_run(self, _live_sink) -> None:
        """The answer's first token waits behind this call, and nothing else."""
        started = asyncio.Event()

        async def _handler(ctx):
            started.set()
            await asyncio.sleep(10)

        _spec(_handler)
        tasks = runner.schedule_post_answer_stages(_facts(), llms={AgentGroup.MEMORY_REFLECTION: object()})

        assert not started.is_set(), (
            "schedule_post_answer_stages ran a handler synchronously: the answer path is now "
            "waiting on stage work, which is the definition of not being a stage"
        )
        for task in tasks:
            task.cancel()

    async def test_a_stage_that_never_finishes_does_not_hold_up_the_answer(self, _live_sink) -> None:
        """The whole answer reaches the socket while the stage is still running."""
        _spec(lambda ctx: asyncio.sleep(10))
        tasks = runner.schedule_post_answer_stages(_facts(), llms={AgentGroup.MEMORY_REFLECTION: object()})

        socket = _Socket()
        await _emit_answer(_live_sink, socket)

        assert any(frame.get("status") == "complete" for frame in _answer_frames(socket)), (
            "the turn was never closed while a stage was still in flight"
        )
        assert _stage_frames(socket) == []
        for task in tasks:
            task.cancel()

    async def test_a_sink_that_raises_reaches_neither_the_answer_nor_the_outcome(self, _live_sink) -> None:
        """§11's second risk: new code on the answer path's process.

        A sink that throws must be a recorded non-delivery, not an exception that
        escapes into the turn and not a stage marked failed.
        """
        from aiq_agent.stages import delivery

        async def _exploding_sink(conversation_id, frame):
            raise RuntimeError("the socket blew up")

        delivery.register_stage_frame_sink(_exploding_sink)
        socket, outcomes = await _turn(_live_sink, handler=lambda ctx: _returns({"items": []}))

        assert outcomes["probe"].status == "ready"
        assert _stage_frames(socket) == []
        assert _answer_frames(socket), "the answer never reached the socket at all"


class TestTheFrameArrivesAfterTheAnswer:
    async def test_a_failing_stage_adds_one_frame_and_it_carries_no_answer(self, _live_sink) -> None:
        """A `failed` frame is still sent — the client needs it to stop reserving
        space — but it carries no reason and no payload, and it lands on a turn
        that was closed before the stage finished."""
        socket, outcomes = await _turn_with_a_late_stage(_live_sink, lambda ctx: _boom(RuntimeError("nope")))

        frames = _stage_frames(socket)
        assert len(frames) == 1
        assert frames[0]["status"] == "failed"
        assert "payload" not in frames[0]
        assert "reason" not in frames[0], "failure reasons are machine keys for the ledger, not user-facing text (§4.1)"
        assert frames[0]["parent_id"] == PARENT_ID
        assert socket.sent[-1] is frames[0], (
            "the stage frame did not arrive after the closed turn: the turn's own frames "
            "were still being written when the stage delivered"
        )

    async def test_a_ready_stage_delivers_its_payload_and_nothing_else(self, _live_sink) -> None:
        payload = {"items": [{"question": "Wie wird die Standfläche bestimmt?"}]}
        socket, outcomes = await _turn_with_a_late_stage(_live_sink, lambda ctx: _returns(payload))

        assert outcomes["probe"].status == "ready"
        frames = _stage_frames(socket)
        assert len(frames) == 1
        assert frames[0]["status"] == "ready"
        assert frames[0]["payload"] == payload
        assert socket.sent[-1] is frames[0]


async def _boom(exc: Exception):
    raise exc
