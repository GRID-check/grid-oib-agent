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
from aiq_agent.common.cost_tracking import UsageEvent
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


def _usage_event(*, cost_source: str, cost_usd: float = 0.0) -> UsageEvent:
    """One bespoke (non-callback) event, the way the reranker records one."""
    return UsageEvent(
        model=None,
        requested_model=None,
        generation_id=None,
        prompt_tokens=10,
        completion_tokens=5,
        total_tokens=15,
        cached_tokens=0,
        reasoning_tokens=0,
        cost_usd=cost_usd,
        cost_source=cost_source,
        is_byok=None,
    )


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

    def test_token_family_round_trips_and_enforces(self):
        # An organization on its own key is limited in tokens, never in cost
        # (ADR-0053): the USD family is absent and the token family decides.
        snapshot = BudgetSnapshot.from_header(
            _budget_header({"remainingOrgUsd": None, "remainingOrgTokens": 5000, "remainingUserTokens": 800})
        )
        assert snapshot is not None
        assert snapshot.remaining_org_usd is None
        assert snapshot.remaining_org_tokens == 5000
        assert snapshot.exhausted_scope(0.0, 799) is None
        assert snapshot.exhausted_scope(0.0, 800) == "member"
        assert snapshot.exhausted_scope(0.0, 5000) == "organization"
        # Older BFFs send only the USD family; the token side stays unlimited.
        legacy = BudgetSnapshot.from_header(_budget_header({"remainingOrgUsd": 1.0}))
        assert legacy is not None and legacy.remaining_org_tokens is None
        assert legacy.exhausted_scope(0.5, 10**9) is None


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

    def test_cost_source_reports_the_events_provenance(self):
        # The rollup must be able to say whether its dollar number was
        # reported or estimated; a positive cost alone does not tell it.
        tracker = self._tracker()
        assert tracker.cost_source is None

        tracker.on_llm_end(_openrouter_result())
        assert tracker.cost_source == "usage_field"

        tracker.record(_usage_event(cost_source="estimate"))
        assert tracker.cost_source == "mixed"

    def test_blocks_next_call_when_budget_exhausted(self):
        tracker = self._tracker(BudgetSnapshot(remaining_user_usd=0.003))
        tracker.on_chat_model_start({}, [])  # within budget: allowed
        tracker.on_llm_end(_openrouter_result())
        tracker.on_llm_end(_openrouter_result())  # cumulative 0.00428 > 0.003
        with pytest.raises(BudgetExceededError) as exc_info:
            tracker.on_chat_model_start({}, [])
        assert exc_info.value.scope == "member"

    def test_blocks_next_call_when_token_budget_exhausted(self):
        # Each replayed generation is 1,535 tokens; the cap trips on the second.
        tracker = self._tracker(BudgetSnapshot(remaining_org_tokens=2000))
        tracker.on_chat_model_start({}, [])
        tracker.on_llm_end(_openrouter_result())
        tracker.on_chat_model_start({}, [])  # 1,535 < 2,000: allowed
        tracker.on_llm_end(_openrouter_result())
        with pytest.raises(BudgetExceededError) as exc_info:
            tracker.on_chat_model_start({}, [])
        assert exc_info.value.scope == "organization"

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


class TestDeferredFlush:
    def test_inline_flush_false_leaves_the_batch_pending(self):
        """The chat turn posts the usage batch after the deltas, not before."""
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            with track_llm_costs(
                identity={"organization_id": "org_1"}, budget=BudgetSnapshot(), inline_flush=False
            ) as tracker:
                tracker.on_llm_end(_openrouter_result())
            assert post.call_count == 0
            tracker.flush(wait=True)
        assert post.call_count == 1
        assert len(post.call_args.args[0]["events"]) == 1

    def test_flush_without_wait_returns_the_workers_future(self):
        tracker = self_tracker = GridCostTracker(
            organization_id="org_1",
            user_id=None,
            project_id=None,
            conversation_id="conv_1",
            budget=BudgetSnapshot(),
        )
        self_tracker.on_llm_end(_openrouter_result())
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            future = tracker.flush(wait=False)
            assert future is not None
            future.result(timeout=5)
        assert post.call_count == 1
        assert tracker.flush(wait=False) is None


# The shape an `api_type: responses` role actually leaves behind. langchain-openai's
# `_construct_lc_result_from_responses_api` builds a ChatResult with NO llm_output
# and a response_metadata that excludes `usage`, so the provider object — the only
# carrier of `cost` and `cache_discount` — never reaches this process; what survives
# is LangChain's normalized usage_metadata, in which OpenRouter's
# `input_tokens_details.cached_tokens` has become `input_token_details.cache_read`.
RESPONSES_USAGE_METADATA = {
    "input_tokens": 41883,
    "output_tokens": 514,
    "total_tokens": 42397,
    "input_token_details": {"cache_read": 35072},
    "output_token_details": {"reasoning": 192},
}


def _responses_result(usage_metadata=RESPONSES_USAGE_METADATA) -> LLMResult:
    message = AIMessage(content="answer", id="resp_01HXYZ", usage_metadata=usage_metadata)
    return LLMResult(generations=[[ChatGeneration(message=message)]], llm_output=None)


class TestResponsesApiUsage:
    """The Responses path must still land cached tokens on the ledger."""

    def test_cached_and_reasoning_tokens_survive_the_normalized_shape(self):
        event = extract_usage_event(_responses_result())
        assert event is not None
        assert event.prompt_tokens == 41883
        assert event.completion_tokens == 514
        assert event.cached_tokens == 35072
        assert event.reasoning_tokens == 192

    def test_cost_is_reported_missing_rather_than_invented(self):
        # OpenRouter's `cost` is genuinely absent on this path. A zero that
        # claimed to be a measurement would be worse than one that says so.
        event = extract_usage_event(_responses_result())
        assert event is not None
        assert event.cost_usd == 0.0
        assert event.cost_source == "missing"

    def test_cached_tokens_reach_the_ledger_payload(self):
        event = extract_usage_event(_responses_result())
        assert event is not None
        assert event.to_payload()["cachedTokens"] == 35072

    def test_a_call_without_cache_details_reports_zero(self):
        usage = {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}
        event = extract_usage_event(_responses_result(usage))
        assert event is not None
        assert event.cached_tokens == 0
        assert event.reasoning_tokens == 0


class TestPromptCacheSummary:
    def test_summary_counts_cached_against_total_input(self, caplog):
        tracker = GridCostTracker(organization_id="org_1")
        tracker.on_llm_end(_responses_result(), run_id="run-1")
        assert tracker.cached_tokens == 35072
        with caplog.at_level("INFO", logger="aiq_agent.common.cost_tracking"):
            tracker.log_prompt_cache_summary()
        line = next(r.getMessage() for r in caplog.records if "[PromptCache]" in r.getMessage())
        assert "35072/41883" in line
        assert "6811 uncached" in line

    def test_nothing_recorded_logs_nothing(self, caplog):
        tracker = GridCostTracker(organization_id="org_1")
        with caplog.at_level("INFO", logger="aiq_agent.common.cost_tracking"):
            tracker.log_prompt_cache_summary()
        assert not [r for r in caplog.records if "[PromptCache]" in r.getMessage()]

    def test_the_turn_scope_summarises_on_exit(self, caplog):
        with caplog.at_level("INFO", logger="aiq_agent.common.cost_tracking"):
            with track_llm_costs(inline_flush=False) as tracker:
                tracker.on_llm_end(_responses_result(), run_id="run-1")
        assert [r for r in caplog.records if "[PromptCache]" in r.getMessage()]
