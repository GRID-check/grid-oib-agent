"""Tests for the per-turn agent execution profiler.

Mirrors tests/aiq_agent/common/test_cost_tracking.py's structure: unit tests
on the callback handler directly (no live LangChain run needed), plus the
context-manager activation contract.
"""

from unittest.mock import patch

import pytest

from aiq_agent.common.profiler import AgentProfiler
from aiq_agent.common.profiler import agent_profiler_var
from aiq_agent.common.profiler import current_span_var
from aiq_agent.common.profiler import profiled_node
from aiq_agent.common.profiler import track_agent_profile


class TestAgentProfilerSpans:
    def _profiler(self) -> AgentProfiler:
        return AgentProfiler(organization_id="org_1", conversation_id="conv_1", turn_id="turn_1")

    def test_start_end_span_records_duration_and_status(self):
        profiler = self._profiler()
        span_id = profiler.start_span("node", "intent_classifier")
        profiler.end_span(span_id, status="ok")
        assert profiler.spans_recorded == 1

    def test_nesting_via_current_span_var(self):
        profiler = self._profiler()
        root_id = profiler.start_span("turn", "chat_researcher")
        token = current_span_var.set(root_id)
        try:
            child_id = profiler.start_span("node", "intent_classifier")
        finally:
            current_span_var.reset(token)
        profiler.end_span(child_id, status="ok")
        profiler.end_span(root_id, status="ok")

        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            profiler.flush(wait=True)
        payload = post.call_args.args[0]
        spans = {span["spanId"]: span for span in payload["spans"]}
        assert spans[child_id]["parentSpanId"] == root_id
        assert spans[root_id]["parentSpanId"] is None

    def test_error_status_carries_message(self):
        profiler = self._profiler()
        span_id = profiler.start_span("llm", "vendor/model")
        profiler.end_span(span_id, status="error", error="boom")
        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            profiler.flush(wait=True)
        span = post.call_args.args[0]["spans"][0]
        assert span["status"] == "error"
        assert span["errorMessage"] == "boom"

    def test_end_span_unknown_id_is_a_noop(self):
        profiler = self._profiler()
        profiler.end_span("does-not-exist")
        assert profiler.spans_recorded == 0

    def test_llm_start_end_keyed_by_run_id(self):
        profiler = self._profiler()
        profiler.on_chat_model_start({}, [], run_id="A", invocation_params={"model": "vendor/model-a"})
        profiler.on_chat_model_start({}, [], run_id="B", invocation_params={"model": "vendor/model-b"})
        profiler.on_llm_end(None, run_id="A")
        profiler.on_llm_end(None, run_id="B")
        assert profiler.spans_recorded == 2

    def test_llm_error_marks_span_error(self):
        profiler = self._profiler()
        profiler.on_chat_model_start({}, [], run_id="A")
        profiler.on_llm_error(RuntimeError("rate limited"), run_id="A")
        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            profiler.flush(wait=True)
        span = post.call_args.args[0]["spans"][0]
        assert span["status"] == "error"
        assert "rate limited" in span["errorMessage"]

    def test_tool_start_end_keyed_by_run_id(self):
        profiler = self._profiler()
        profiler.on_tool_start({"name": "search_documents"}, "{}", run_id="T1")
        profiler.on_tool_end("result", run_id="T1")
        assert profiler.spans_recorded == 1

    def test_flush_posts_batch_with_identity(self):
        profiler = self._profiler()
        span_id = profiler.start_span("node", "clarifier")
        profiler.end_span(span_id)
        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            profiler.flush(wait=True)
        assert post.call_count == 1
        payload = post.call_args.args[0]
        assert payload["organizationId"] == "org_1"
        assert payload["conversationId"] == "conv_1"
        assert payload["turnId"] == "turn_1"
        assert len(payload["spans"]) == 1

    def test_flush_is_idempotent_when_empty(self):
        profiler = self._profiler()
        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            profiler.flush(wait=True)
        assert post.call_count == 0


class TestProfiledNode:
    async def test_wraps_and_records_success(self):
        async def fn(x):
            return x + 1

        wrapped = profiled_node("my_node", fn)
        with track_agent_profile(agent_name="test_agent", identity={"organization_id": "org_1"}) as profiler:
            result = await wrapped(41)
            assert result == 42
            assert profiler is not None
            # profiled_node() closes the span before returning the wrapped result.
            assert profiler.spans_recorded == 1

    async def test_noop_without_active_profiler(self):
        async def fn(x):
            return x * 2

        wrapped = profiled_node("my_node", fn)
        assert agent_profiler_var.get() is None
        assert await wrapped(21) == 42

    async def test_propagates_and_records_exception(self):
        async def fn():
            raise ValueError("node failed")

        wrapped = profiled_node("failing_node", fn)
        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            with pytest.raises(ValueError):
                with track_agent_profile(agent_name="test_agent", identity={"organization_id": "org_1"}):
                    await wrapped()
        payload = post.call_args.args[0]
        node_spans = [s for s in payload["spans"] if s["name"] == "failing_node"]
        assert len(node_spans) == 1
        assert node_spans[0]["status"] == "error"
        # The root turn span is also marked error since the exception propagated out of the block.
        turn_spans = [s for s in payload["spans"] if s["name"] == "test_agent"]
        assert turn_spans[0]["status"] == "error"


class TestTrackAgentProfile:
    def test_sets_and_resets_contextvars(self):
        assert agent_profiler_var.get() is None
        assert current_span_var.get() is None
        with track_agent_profile(agent_name="chat_researcher", identity={"organization_id": "org_1"}) as profiler:
            assert profiler is not None
            assert agent_profiler_var.get() is profiler
            assert current_span_var.get() is not None
        assert agent_profiler_var.get() is None
        assert current_span_var.get() is None

    def test_flushes_root_span_on_exit(self):
        with patch("aiq_agent.common.profiler._post_profiler_spans") as post:
            with track_agent_profile(agent_name="chat_researcher", identity={"organization_id": "org_1"}):
                pass
        assert post.call_count == 1
        spans = post.call_args.args[0]["spans"]
        assert len(spans) == 1
        assert spans[0]["kind"] == "turn"
        assert spans[0]["name"] == "chat_researcher"
        assert spans[0]["parentSpanId"] is None

    def test_configure_hook_attaches_handler_to_langchain_config(self):
        """The DRY seam: any callback manager configured inside the context
        must pick up the profiler without agent code opting in."""
        from langchain_core.callbacks.manager import CallbackManager

        with track_agent_profile(agent_name="chat_researcher", identity={"organization_id": "org_1"}) as profiler:
            manager = CallbackManager.configure(inheritable_callbacks=None, local_callbacks=None)
            assert any(handler is profiler for handler in manager.handlers)
