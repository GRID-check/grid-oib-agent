"""Tests for SpanClosingProfilerHandler (src/aiq_agent/common/nat_step_repair.py).

Module under test fixes an upstream NAT gap: LangchainProfilerHandler pushes an
IntermediateStepManager START event from on_llm_start/on_tool_start but never
pushes the matching END when the call errors (no on_llm_error/on_tool_error
override), leaking a frame on the shared active_span_id_stack that corrupts
every later, legitimately-closing sibling/parent step. These tests exercise
the fix against the REAL nat.builder.intermediate_step_manager.IntermediateStepManager
and nat.builder.context.ContextState (a process-wide singleton), resetting the
span stack ContextVar directly before each test for isolation rather than
faking the manager, since there is no existing precedent in this repo for
mocking NAT's context/step-manager internals.
"""

from __future__ import annotations

import uuid

import pytest
from langchain_core.outputs import LLMResult

from aiq_agent.common.nat_step_repair import SpanClosingProfilerHandler
from nat.builder.context import Context
from nat.builder.context import ContextState
from nat.data_models.intermediate_step import IntermediateStepType


@pytest.fixture
def context_state() -> ContextState:
    """The (singleton) NAT ContextState, with its span stack reset to a clean root.

    ContextState is process-wide (Singleton metaclass), so tests must reset the
    relevant ContextVars themselves rather than constructing a "fresh" instance.
    """
    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    yield state
    state.active_span_id_stack.set(["root"])


@pytest.fixture
def handler(context_state: ContextState) -> SpanClosingProfilerHandler:
    """A SpanClosingProfilerHandler bound to the (reset) real IntermediateStepManager."""
    return SpanClosingProfilerHandler()


class TestForNewRun:
    def test_returns_fresh_instance(self, handler: SpanClosingProfilerHandler):
        fresh = handler.for_new_run()

        assert fresh is not handler
        assert isinstance(fresh, SpanClosingProfilerHandler)

    def test_fresh_instance_has_independent_bookkeeping(self, handler: SpanClosingProfilerHandler):
        run_id = uuid.uuid4()
        handler._run_id_to_model_name[str(run_id)] = "some-model"

        fresh = handler.for_new_run()

        assert fresh._run_id_to_model_name == {}
        # Mutating the fresh instance must not leak back into the original.
        fresh._run_id_to_model_name["other"] = "x"
        assert "other" not in handler._run_id_to_model_name


class TestOnLlmError:
    async def test_closes_span_and_balances_stack(
        self, handler: SpanClosingProfilerHandler, context_state: ContextState
    ):
        run_id = uuid.uuid4()

        await handler.on_llm_start(
            serialized={},
            prompts=["hello"],
            run_id=run_id,
            metadata={"ls_model_name": "test-model"},
        )
        assert context_state.active_span_id_stack.get() == ["root", str(run_id)]
        assert handler.step_manager.get_outstanding_step_count() == 1

        await handler.on_llm_error(RuntimeError("boom"), run_id=run_id)

        assert context_state.active_span_id_stack.get() == ["root"]
        assert handler.step_manager.get_outstanding_step_count() == 0

    async def test_no_stack_corruption_warning_for_next_sibling(
        self, handler: SpanClosingProfilerHandler, context_state: ContextState, caplog: pytest.LogCaptureFixture
    ):
        """Reproduces the audit-confirmed bug: an errored (then retried) attempt
        must not leave a frame that corrupts the stack for the retry's own
        START/END pair (each retry attempt gets its own run_id, per
        RunnableRetry / Runnable.with_retry()).
        """
        errored_run_id = uuid.uuid4()
        retry_run_id = uuid.uuid4()

        with caplog.at_level("WARNING", logger="nat.builder.intermediate_step_manager"):
            # Attempt 1: errors.
            await handler.on_llm_start(
                serialized={}, prompts=["hello"], run_id=errored_run_id, metadata={"ls_model_name": "test-model"}
            )
            await handler.on_llm_error(RuntimeError("transient"), run_id=errored_run_id)

            # Attempt 2 (the retry): succeeds, closed via the INHERITED on_llm_end.
            await handler.on_llm_start(
                serialized={}, prompts=["hello"], run_id=retry_run_id, metadata={"ls_model_name": "test-model"}
            )
            await handler.on_llm_end(LLMResult(generations=[]), run_id=retry_run_id)

        assert context_state.active_span_id_stack.get() == ["root"]
        # The IntermediateStepManager warning this fixes ("not the last step in
        # the stack") must not have fired for the retry's own, legitimate END.
        assert "not the last step in the stack" not in caplog.text
        assert "not found in outstanding start steps" not in caplog.text

    async def test_error_text_and_zeroed_usage_in_payload(
        self, handler: SpanClosingProfilerHandler, context_state: ContextState
    ):
        run_id = uuid.uuid4()
        captured: list = []
        handler.step_manager.subscribe(captured.append)

        await handler.on_llm_start(
            serialized={}, prompts=["hello"], run_id=run_id, metadata={"ls_model_name": "test-model"}
        )
        await handler.on_llm_error(ValueError("rate limited"), run_id=run_id)

        end_steps = [s for s in captured if s.event_type == IntermediateStepType.LLM_END]
        assert len(end_steps) == 1
        end_payload = end_steps[0].payload
        assert "rate limited" in str(end_payload.data.output)
        assert end_payload.usage_info.token_usage.prompt_tokens == 0
        assert end_payload.usage_info.token_usage.completion_tokens == 0
        assert end_payload.UUID == str(run_id)


class TestOnToolError:
    async def test_closes_span_and_balances_stack(
        self, handler: SpanClosingProfilerHandler, context_state: ContextState
    ):
        run_id = uuid.uuid4()

        await handler.on_tool_start(
            serialized={"name": "web_search"},
            input_str="query",
            run_id=run_id,
        )
        assert context_state.active_span_id_stack.get() == ["root", str(run_id)]

        # Mirrors the real call site (langchain_core.tools.base): on_tool_error
        # is invoked with only `tool_call_id`, never `name`.
        await handler.on_tool_error(RuntimeError("tool failed"), run_id=run_id, tool_call_id="call-1")

        assert context_state.active_span_id_stack.get() == ["root"]
        assert handler.step_manager.get_outstanding_step_count() == 0

    async def test_error_text_and_zeroed_usage_in_payload(
        self, handler: SpanClosingProfilerHandler, context_state: ContextState
    ):
        run_id = uuid.uuid4()
        captured: list = []
        handler.step_manager.subscribe(captured.append)

        await handler.on_tool_start(serialized={"name": "web_search"}, input_str="query", run_id=run_id)
        await handler.on_tool_error(RuntimeError("boom"), run_id=run_id)

        end_steps = [s for s in captured if s.event_type == IntermediateStepType.TOOL_END]
        assert len(end_steps) == 1
        end_payload = end_steps[0].payload
        assert "boom" in str(end_payload.data.output)
        assert end_payload.usage_info.token_usage.total_tokens == 0
        assert end_payload.UUID == str(run_id)


class TestOnRetry:
    async def test_does_not_push_or_close_the_open_span(
        self, handler: SpanClosingProfilerHandler, context_state: ContextState
    ):
        """on_retry (legacy create_base_retry_decorator path) fires with the SAME
        run_id as the still-open on_llm_start span, mid-attempt. Pushing an END
        here would pop it prematurely, so on_retry must be a pure log/no-op.
        """
        run_id = uuid.uuid4()

        await handler.on_llm_start(
            serialized={}, prompts=["hello"], run_id=run_id, metadata={"ls_model_name": "test-model"}
        )
        assert context_state.active_span_id_stack.get() == ["root", str(run_id)]

        await handler.on_retry(retry_state=object(), run_id=run_id)

        # Stack and outstanding steps are untouched: the span is still open.
        assert context_state.active_span_id_stack.get() == ["root", str(run_id)]
        assert handler.step_manager.get_outstanding_step_count() == 1

        # The real on_llm_end (inherited, unmodified) can still close it cleanly.
        await handler.on_llm_end(LLMResult(generations=[]), run_id=run_id)
        assert context_state.active_span_id_stack.get() == ["root"]


class TestContextGetCreatesFreshStepManagerPerHandler:
    def test_new_handler_gets_its_own_outstanding_steps_dict(self):
        """Sanity check on the Context.get().intermediate_step_manager contract
        SpanClosingProfilerHandler relies on: each handler instance captures its
        own IntermediateStepManager (fresh _outstanding_start_steps), while
        sharing the same underlying ContextState span stack.
        """
        state = ContextState.get()
        state.active_span_id_stack.set(["root"])
        try:
            manager_a = Context.get().intermediate_step_manager
            manager_b = Context.get().intermediate_step_manager
            assert manager_a is not manager_b
        finally:
            state.active_span_id_stack.set(["root"])
