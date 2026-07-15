"""Tests for unified LLM cost capture + budget enforcement.

DRY-RUN NOTE: OpenRouter is not reachable from CI. These tests replay the
response shape documented by OpenRouter's usage accounting
(https://openrouter.ai/docs/guides/guides/usage-accounting — the `usage`
object with `cost` in USD, `prompt_tokens_details.cached_tokens`,
`completion_tokens_details.reasoning_tokens`) exactly as langchain-openai
surfaces it (`llm_output["token_usage"]`). Live verification against the API
is an ops step; every ledger row carries the generation id so it can be
reconciled via GET /api/v1/generation?id=.
"""

import base64
import json
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration
from langchain_core.outputs import LLMResult

from aiq_agent.common.cost_tracking import BudgetExceededError
from aiq_agent.common.cost_tracking import BudgetSnapshot
from aiq_agent.common.cost_tracking import GridCostTracker
from aiq_agent.common.cost_tracking import extract_usage_event
from aiq_agent.common.cost_tracking import grid_cost_tracker_var
from aiq_agent.common.cost_tracking import track_llm_costs

# The usage object exactly as OpenRouter documents it (usage accounting is
# always on; langchain-openai passes it through as llm_output["token_usage"]).
OPENROUTER_USAGE = {
    "prompt_tokens": 1204,
    "completion_tokens": 331,
    "total_tokens": 1535,
    "cost": 0.00214,
    "is_byok": False,
    "cost_details": {"upstream_inference_cost": None},
    "prompt_tokens_details": {"cached_tokens": 512},
    "completion_tokens_details": {"reasoning_tokens": 128},
}


def _openrouter_result(usage: dict | None = OPENROUTER_USAGE, model: str = "deepseek/deepseek-v4-flash") -> LLMResult:
    message = AIMessage(content="answer", id="gen-01HXYZOPENROUTER")
    generation = ChatGeneration(message=message)
    llm_output = {"model_name": model}
    if usage is not None:
        llm_output["token_usage"] = usage
    return LLMResult(generations=[[generation]], llm_output=llm_output)


def _budget_header(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()


class TestExtractUsageEvent:
    def test_full_openrouter_usage_object(self):
        event = extract_usage_event(_openrouter_result())
        assert event is not None
        assert event.model == "deepseek/deepseek-v4-flash"
        assert event.generation_id == "gen-01HXYZOPENROUTER"
        assert event.prompt_tokens == 1204
        assert event.completion_tokens == 331
        assert event.total_tokens == 1535
        assert event.cached_tokens == 512
        assert event.reasoning_tokens == 128
        assert event.cost_usd == pytest.approx(0.00214)
        assert event.cost_source == "usage_field"
        assert event.is_byok is False

    def test_missing_cost_is_recorded_as_missing(self):
        usage = {k: v for k, v in OPENROUTER_USAGE.items() if k != "cost"}
        event = extract_usage_event(_openrouter_result(usage))
        assert event is not None
        assert event.cost_usd == 0.0
        assert event.cost_source == "missing"

    def test_no_usage_returns_none(self):
        assert extract_usage_event(_openrouter_result(usage=None)) is None

    def test_payload_shape_matches_internal_endpoint(self):
        event = extract_usage_event(_openrouter_result())
        payload = event.to_payload()
        assert set(payload) == {
            "model",
            "requestedModel",
            "generationId",
            "promptTokens",
            "completionTokens",
            "totalTokens",
            "cachedTokens",
            "reasoningTokens",
            "costUsd",
            "costSource",
            "isByok",
        }


class TestBudgetSnapshot:
    def test_from_header_round_trip(self):
        snapshot = BudgetSnapshot.from_header(
            _budget_header({"remainingOrgUsd": 1.5, "remainingUserUsd": 0.2, "remainingProjectUsd": None})
        )
        assert snapshot is not None
        assert snapshot.remaining_org_usd == 1.5
        assert snapshot.remaining_user_usd == 0.2
        assert snapshot.remaining_project_usd is None

    def test_malformed_header_fails_open(self):
        assert BudgetSnapshot.from_header("###") is None
        assert BudgetSnapshot.from_header(None) is None

    def test_exhausted_scope_order(self):
        snapshot = BudgetSnapshot(remaining_org_usd=1.0, remaining_user_usd=0.1)
        assert snapshot.exhausted_scope(0.05) is None
        assert snapshot.exhausted_scope(0.1) == "member"
        assert snapshot.exhausted_scope(1.0) == "organization"


class TestGridCostTracker:
    def _tracker(self, budget: BudgetSnapshot | None = None) -> GridCostTracker:
        return GridCostTracker(
            organization_id="org_1",
            user_id="user_1",
            project_id="proj_1",
            conversation_id="conv_1",
            budget=budget,
        )

    def test_accumulates_cost_across_calls(self):
        tracker = self._tracker()
        tracker.on_llm_end(_openrouter_result())
        tracker.on_llm_end(_openrouter_result())
        assert tracker.turn_cost_usd == pytest.approx(0.00428)
        assert tracker.events_recorded == 2

    def test_blocks_next_call_when_budget_exhausted(self):
        tracker = self._tracker(BudgetSnapshot(remaining_user_usd=0.003))
        tracker.on_chat_model_start({}, [])  # within budget: allowed
        tracker.on_llm_end(_openrouter_result())
        tracker.on_llm_end(_openrouter_result())  # cumulative 0.00428 > 0.003
        with pytest.raises(BudgetExceededError) as exc_info:
            tracker.on_chat_model_start({}, [])
        assert exc_info.value.scope == "member"

    def test_no_budget_never_blocks(self):
        tracker = self._tracker()
        for _ in range(10):
            tracker.on_llm_end(_openrouter_result())
            tracker.on_chat_model_start({}, [])

    def test_requested_model_captured_from_invocation_params(self):
        tracker = self._tracker()
        tracker.on_chat_model_start({}, [], invocation_params={"model": "vendor/override-model"})
        tracker.on_llm_end(_openrouter_result())
        tracker.flush(wait=False)  # moves pending out
        # requested model recorded on the event before flush
        # (validated through the posted payload below)

    def test_flush_posts_batch_with_identity(self):
        tracker = self._tracker()
        tracker.on_chat_model_start({}, [], invocation_params={"model": "vendor/override-model"})
        tracker.on_llm_end(_openrouter_result())
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            tracker.flush(wait=True)
        assert post.call_count == 1
        payload = post.call_args.args[0]
        assert payload["organizationId"] == "org_1"
        assert payload["userId"] == "user_1"
        assert payload["projectId"] == "proj_1"
        assert payload["conversationId"] == "conv_1"
        assert len(payload["events"]) == 1
        assert payload["events"][0]["costUsd"] == pytest.approx(0.00214)
        assert payload["events"][0]["requestedModel"] == "vendor/override-model"
        assert payload["events"][0]["generationId"] == "gen-01HXYZOPENROUTER"

    def test_flush_is_idempotent_when_empty(self):
        tracker = self._tracker()
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            tracker.flush(wait=True)
        assert post.call_count == 0

    def test_concurrent_runs_attribute_model_by_run_id(self):
        """Interleaved LLM calls must each record their own requested model.

        Deep research fires concurrent calls; keying the requested model by
        run_id (not a single shared slot) keeps model attribution correct when
        call B starts before call A ends.
        """
        tracker = self._tracker()
        tracker.on_chat_model_start({}, [], run_id="A", invocation_params={"model": "vendor/model-a"})
        # A second call on a different model starts before A finishes.
        tracker.on_chat_model_start({}, [], run_id="B", invocation_params={"model": "vendor/model-b"})
        tracker.on_llm_end(_openrouter_result(), run_id="A")
        tracker.on_llm_end(_openrouter_result(), run_id="B")
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            tracker.flush(wait=True)
        events = post.call_args.args[0]["events"]
        assert [e["requestedModel"] for e in events] == ["vendor/model-a", "vendor/model-b"]


class TestTrackLlmCosts:
    def test_sets_and_resets_contextvar(self):
        assert grid_cost_tracker_var.get() is None
        with track_llm_costs(identity={"organization_id": "org_1"}, budget=BudgetSnapshot()) as tracker:
            assert tracker is not None
            assert grid_cost_tracker_var.get() is tracker
            assert tracker.organization_id == "org_1"
        assert grid_cost_tracker_var.get() is None

    def test_flushes_on_exit(self):
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            with track_llm_costs(identity={"organization_id": "org_1"}, budget=BudgetSnapshot()) as tracker:
                tracker.on_llm_end(_openrouter_result())
            # exit flushes via the background executor; force it to drain
            from aiq_agent.common.cost_tracking import _flush_executor

            _flush_executor.submit(lambda: None).result()
        assert post.call_count == 1

    def test_configure_hook_attaches_handler_to_langchain_config(self):
        """The DRY seam: any callback manager configured inside the context
        must pick up the tracker without agent code opting in."""
        from langchain_core.callbacks.manager import CallbackManager

        with track_llm_costs(identity={"organization_id": "org_1"}, budget=BudgetSnapshot()) as tracker:
            manager = CallbackManager.configure(inheritable_callbacks=None, local_callbacks=None)
            assert any(handler is tracker for handler in manager.handlers)
