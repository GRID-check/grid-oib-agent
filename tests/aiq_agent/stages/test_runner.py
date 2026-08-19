"""Contract tests for the post-answer stage runner.

No LLM, no socket, no request context: a matrix of ``TurnFacts`` against stub
handlers, asserting exactly one ``StageOutcome`` per declared stage and one
profiler span carrying that outcome — including for the stages that never ran,
which is the data the primitive exists to produce.
"""

import asyncio
from unittest.mock import patch

import pytest

from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.stages import registry
from aiq_agent.stages import runner
from aiq_agent.stages.spec import GateDecision
from aiq_agent.stages.spec import StageSpec
from aiq_agent.stages.spec import TurnFacts

_GROUP = AgentGroup.MEMORY_REFLECTION


@pytest.fixture(autouse=True)
def _isolated_registry():
    """Each test declares its own stages; the built-in ones stay out of the way."""
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


def _facts(**overrides) -> TurnFacts:
    base = {
        "conversation_id": "conv_1",
        "ws_parent_id": "msg_1755600000000_3",
        "organization_id": "org_1",
        "project_id": "proj_1",
        "query": "Wie hoch darf die Brüstung sein?",
        "answer": "Mindestens 100 cm nach OIB-Richtlinie 4.",
        "enabled_stages": frozenset({"probe"}),
    }
    base.update(overrides)
    return TurnFacts(**base)


def _spec(handler, *, stage_id="probe", gate=None, **overrides) -> StageSpec:
    kwargs = {
        "id": stage_id,
        "agent_group": _GROUP,
        "flag_slug": "probe-stage",
        "env_default": "GRID_STAGE_PROBE_ENABLED",
        "timeout_s": 5.0,
        "gate": gate or (lambda facts: GateDecision.proceed()),
        "handler": handler,
        "payload_model": None,
        "delivery": "silent",
        "max_output_tokens": None,
    }
    kwargs.update(overrides)
    return registry.register_stage(StageSpec(**kwargs))


async def _run_all(facts, *, llms=None):
    """Schedule every registered stage and collect the outcomes."""
    tasks = runner.schedule_post_answer_stages(facts, llms=llms if llms is not None else {_GROUP: object()})
    outcomes = await asyncio.gather(*tasks)
    return {outcome.stage_id: outcome for outcome in outcomes}


def _spans(post):
    """Every span posted to the ledger during the call, by name."""
    spans = []
    for call in post.call_args_list:
        spans.extend(call.args[0]["spans"])
    return spans


class TestTerminalStates:
    @pytest.mark.asyncio
    async def test_payload_is_ready(self):
        _spec(lambda ctx: _returns({"items": [1]}))
        outcomes = await _run_all(_facts())
        assert outcomes["probe"].status == "ready"
        assert outcomes["probe"].payload == {"items": [1]}

    @pytest.mark.asyncio
    async def test_none_is_empty_not_a_failure(self):
        _spec(lambda ctx: _returns(None))
        outcomes = await _run_all(_facts())
        assert outcomes["probe"].status == "empty"
        assert outcomes["probe"].payload is None

    @pytest.mark.asyncio
    async def test_handler_that_hangs_is_cut_off_at_the_declared_timeout(self):
        started = asyncio.Event()

        async def _hang(ctx):
            started.set()
            await asyncio.sleep(30)
            return {"never": True}

        _spec(_hang, timeout_s=0.05)
        outcomes = await _run_all(_facts())
        assert started.is_set()
        assert outcomes["probe"].status == "timeout"

    @pytest.mark.asyncio
    async def test_handler_that_raises_is_failed_and_names_the_exception(self):
        async def _boom(ctx):
            raise ValueError("provider said no")

        _spec(_boom)
        outcomes = await _run_all(_facts())
        assert outcomes["probe"].status == "failed"
        assert outcomes["probe"].reason == "ValueError"

    @pytest.mark.asyncio
    async def test_a_payload_its_own_model_rejects_is_failed(self):
        from pydantic import BaseModel

        class _Payload(BaseModel):
            items: list[str]

        _spec(lambda ctx: _returns({"items": "not a list"}), payload_model=_Payload)
        outcomes = await _run_all(_facts())
        assert outcomes["probe"].status == "failed"
        assert outcomes["probe"].reason == "invalid_payload"


class TestGatingAndFlags:
    @pytest.mark.asyncio
    async def test_gate_skip_names_its_reason_and_never_calls_the_handler(self):
        called = False

        async def _handler(ctx):
            nonlocal called
            called = True

        _spec(_handler, gate=lambda facts: GateDecision.skip("research_truncated"))
        outcomes = await _run_all(_facts())
        assert outcomes["probe"].status == "skipped"
        assert outcomes["probe"].reason == "research_truncated"
        assert called is False

    @pytest.mark.asyncio
    async def test_flag_off_is_disabled_not_skipped(self):
        _spec(lambda ctx: _returns({"a": 1}))
        outcomes = await _run_all(_facts(enabled_stages=frozenset()))
        assert outcomes["probe"].status == "disabled"
        assert outcomes["probe"].reason == "flag_off"

    @pytest.mark.asyncio
    async def test_unknown_enabled_set_fails_closed(self):
        _spec(lambda ctx: _returns({"a": 1}))
        outcomes = await _run_all(_facts(enabled_stages=None))
        assert outcomes["probe"].status == "disabled"

    @pytest.mark.asyncio
    async def test_no_llm_for_the_agent_group_is_the_capability_bit(self):
        _spec(lambda ctx: _returns({"a": 1}))
        outcomes = await _run_all(_facts(), llms={})
        assert outcomes["probe"].status == "disabled"
        assert outcomes["probe"].reason == "no_llm"

    @pytest.mark.asyncio
    async def test_a_gate_that_raises_never_reaches_the_answer_path(self):
        def _explode(facts):
            raise RuntimeError("gate bug")

        _spec(lambda ctx: _returns({"a": 1}), gate=_explode)
        # The call site is on the answer path and calls this synchronously.
        assert runner.schedule_post_answer_stages(_facts(), llms={_GROUP: object()}) == []


class TestObservability:
    @pytest.mark.asyncio
    async def test_every_terminal_state_emits_a_span_carrying_its_outcome(self):
        _spec(lambda ctx: _returns(None), stage_id="ran")
        _spec(lambda ctx: _returns(None), stage_id="declined", gate=lambda f: GateDecision.skip("intent_meta"))
        facts = _facts(enabled_stages=frozenset({"ran", "declined"}))

        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            await _run_all(facts)

        by_name = {span["name"]: span for span in _spans(post)}
        assert by_name["stage:ran"]["metadata"] == {"stage": "ran", "outcome": "empty", "reason": None}
        assert by_name["stage:declined"]["metadata"] == {
            "stage": "declined",
            "outcome": "skipped",
            "reason": "intent_meta",
        }

    @pytest.mark.asyncio
    async def test_a_timeout_is_visible_as_an_outcome(self):
        async def _hang(ctx):
            await asyncio.sleep(30)

        _spec(_hang, timeout_s=0.05)
        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            await _run_all(_facts())
        span = next(s for s in _spans(post) if s["name"] == "stage:probe")
        assert span["metadata"]["outcome"] == "timeout"


class TestBackpressureAndIdempotency:
    @pytest.mark.asyncio
    async def test_beyond_the_pending_cap_stages_are_dropped_not_queued(self, monkeypatch):
        monkeypatch.setattr(runner, "_MAX_PENDING", 1)
        release = asyncio.Event()

        async def _wait(ctx):
            await release.wait()

        _spec(_wait, stage_id="first")
        _spec(_wait, stage_id="second")
        facts = _facts(enabled_stages=frozenset({"first", "second"}))
        tasks = runner.schedule_post_answer_stages(facts, llms={_GROUP: object()})
        release.set()
        outcomes = {o.stage_id: o for o in await asyncio.gather(*tasks)}
        assert outcomes["second"].status == "skipped"
        assert outcomes["second"].reason == "pending_cap"

    @pytest.mark.asyncio
    async def test_the_same_turn_runs_a_stage_once(self):
        runs = 0

        async def _count(ctx):
            nonlocal runs
            runs += 1

        _spec(_count)
        facts = _facts()
        assert (await _run_all(facts))["probe"].status == "empty"
        second = await _run_all(facts)
        assert second["probe"].status == "skipped"
        assert second["probe"].reason == "duplicate"
        assert runs == 1

    @pytest.mark.asyncio
    async def test_two_turns_of_one_conversation_both_run(self):
        _spec(lambda ctx: _returns(None))
        first = await _run_all(_facts(ws_parent_id="msg_1"))
        second = await _run_all(_facts(ws_parent_id="msg_2"))
        assert first["probe"].status == "empty"
        assert second["probe"].status == "empty"

    @pytest.mark.asyncio
    async def test_without_a_turn_identity_nothing_is_suppressed(self):
        """A CLI/REST turn has no ws_parent_id. Keying on the conversation alone
        would silence every turn after the first."""
        _spec(lambda ctx: _returns(None))
        first = await _run_all(_facts(ws_parent_id=None))
        second = await _run_all(_facts(ws_parent_id=None))
        assert first["probe"].status == "empty"
        assert second["probe"].status == "empty"

    @pytest.mark.asyncio
    async def test_the_semaphore_is_shared_across_stages(self, monkeypatch):
        monkeypatch.setattr(runner, "_MAX_CONCURRENCY", 1)
        runner._semaphores.clear()
        concurrent = 0
        peak = 0

        async def _observe(ctx):
            nonlocal concurrent, peak
            concurrent += 1
            peak = max(peak, concurrent)
            await asyncio.sleep(0.01)
            concurrent -= 1

        _spec(_observe, stage_id="a")
        _spec(_observe, stage_id="b")
        await _run_all(_facts(enabled_stages=frozenset({"a", "b"})))
        assert peak == 1


class TestFrameDelivery:
    @pytest.mark.asyncio
    async def test_a_frame_stage_hands_its_payload_to_the_registered_sink(self):
        sent = []

        async def _sink(conversation_id, frame):
            sent.append((conversation_id, frame))
            return True

        from aiq_agent.stages import delivery

        delivery.register_stage_frame_sink(_sink)
        try:
            _spec(lambda ctx: _returns({"items": []}), delivery="frame")
            await _run_all(_facts())
        finally:
            delivery.register_stage_frame_sink(None)

        assert len(sent) == 1
        conversation_id, frame = sent[0]
        assert conversation_id == "conv_1"
        assert frame["type"] == "grid_stage_message"
        assert frame["v"] == 1
        assert frame["stage"] == "probe"
        assert frame["status"] == "ready"
        assert frame["parent_id"] == "msg_1755600000000_3"
        assert frame["payload"] == {"items": []}

    @pytest.mark.asyncio
    async def test_a_sink_that_raises_cannot_take_the_stage_down(self):
        async def _sink(conversation_id, frame):
            raise RuntimeError("socket gone")

        from aiq_agent.stages import delivery

        delivery.register_stage_frame_sink(_sink)
        try:
            _spec(lambda ctx: _returns({"items": []}), delivery="frame")
            outcomes = await _run_all(_facts())
        finally:
            delivery.register_stage_frame_sink(None)
        assert outcomes["probe"].status == "ready"

    @pytest.mark.asyncio
    async def test_a_silent_stage_never_touches_the_sink(self):
        sent = []

        async def _sink(conversation_id, frame):
            sent.append(frame)
            return True

        from aiq_agent.stages import delivery

        delivery.register_stage_frame_sink(_sink)
        try:
            _spec(lambda ctx: _returns({"items": []}))
            await _run_all(_facts())
        finally:
            delivery.register_stage_frame_sink(None)
        assert sent == []


class TestSpecValidation:
    def test_a_stage_without_a_timeout_does_not_construct(self):
        with pytest.raises(ValueError, match="timeout_s"):
            StageSpec(
                id="no_bound",
                agent_group=_GROUP,
                flag_slug="x",
                env_default="X",
                timeout_s=0,
                gate=lambda facts: GateDecision.proceed(),
                handler=lambda ctx: _returns(None),
                payload_model=None,
                delivery="silent",
                max_output_tokens=None,
            )

    def test_a_skip_must_name_a_reason(self):
        with pytest.raises(ValueError):
            GateDecision.skip("")

    def test_two_stages_may_not_share_an_id(self):
        _spec(lambda ctx: _returns(None))
        with pytest.raises(ValueError, match="already registered"):
            _spec(lambda ctx: _returns(None))


async def _returns(value):
    return value
