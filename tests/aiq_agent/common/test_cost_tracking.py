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
import re
from pathlib import Path
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

_ROUTE = Path(__file__).resolve().parents[3] / "frontends/ui/src/app/api/internal/usage/route.ts"


def _route_keys(schema_name: str) -> set[str]:
    """The top-level keys one zod object in the internal usage route declares."""
    source = _ROUTE.read_text()
    body = re.search(rf"const {schema_name} = z\.object\(\{{(.*?)\n\}}\)", source, re.S)
    assert body is not None, schema_name
    return set(re.findall(r"^  (\w+):", body.group(1), re.M))


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

    @pytest.mark.parametrize(
        "cost",
        [True, "0.0421", float("nan"), float("inf"), -1.0],
        ids=["bool", "string", "nan", "inf", "negative"],
    )
    def test_a_malformed_cost_is_never_booked(self, cost, caplog):
        # `True` is an int in Python and would book $1.00; NaN would switch the
        # budget gate off; the BFF rejects a non-finite or negative cost with
        # the whole batch. Recorded as missing, and said so in the log.
        with caplog.at_level("WARNING", logger="aiq_agent.common.cost_tracking"):
            event = extract_usage_event(_openrouter_result({**OPENROUTER_USAGE, "cost": cost}))
        assert event is not None
        assert event.cost_usd == 0.0
        assert event.cost_source == "missing"
        assert any("malformed provider cost" in r.getMessage() for r in caplog.records)

    def test_a_zero_cost_is_a_reported_zero(self):
        event = extract_usage_event(_openrouter_result({**OPENROUTER_USAGE, "cost": 0}))
        assert event is not None
        assert event.cost_usd == 0.0
        assert event.cost_source == "usage_field"

    def test_no_usage_returns_none(self):
        assert extract_usage_event(_openrouter_result(usage=None)) is None

    def test_payload_shape_matches_internal_endpoint(self):
        # Read from the route itself: a key it does not declare is dropped by
        # zod without an error, so the two must be equal, not merely overlap.
        event = extract_usage_event(_openrouter_result())
        assert set(event.to_payload()) == _route_keys("usageEventSchema")

    def test_batch_shape_matches_internal_endpoint(self, monkeypatch):
        posted = []
        monkeypatch.setattr("aiq_agent.common.cost_tracking._post_usage_events", posted.append)
        tracker = GridCostTracker(organization_id="org_1", activity="ingest")
        tracker.record(extract_usage_event(_openrouter_result()))
        tracker.flush(wait=True)
        assert set(posted[0]) == _route_keys("usageBatchSchema")
        assert posted[0]["activity"] == "ingest"


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

    def test_the_batch_names_the_answer_it_paid_for(self):
        from aiq_agent.common.cost_tracking import track_llm_costs

        identity = {"organization_id": "org_1", "conversation_id": "conv_1", "message_id": "answer_1"}
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            with track_llm_costs(identity=identity, budget=BudgetSnapshot()) as tracker:
                tracker.on_llm_end(_openrouter_result())
        payload = post.call_args.args[0]
        # The batch keys the internal endpoint declares, read from the route.
        assert set(payload) == _route_keys("usageBatchSchema")
        assert payload["messageId"] == "answer_1"
        assert payload["activity"] is None

    def test_a_tracker_off_the_chat_path_names_no_answer(self):
        tracker = self._tracker()
        tracker.on_llm_end(_openrouter_result())
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            tracker.flush(wait=True)
        assert post.call_args.args[0]["messageId"] is None

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


# The shape an `api_type: responses` role leaves behind when nothing carries the
# provider's accounting. langchain-openai's `_construct_lc_result_from_responses_api`
# builds a ChatResult with NO llm_output and a response_metadata that excludes
# `usage`; what survives is LangChain's normalized usage_metadata, in which
# OpenRouter's `input_tokens_details.cached_tokens` has become
# `input_token_details.cache_read`. `install_responses_cost_carrier` puts the
# provider's `cost` back beside it (TestResponsesApiCost below).
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

    def test_without_the_carried_cost_it_is_reported_missing(self):
        # A zero that claimed to be a measurement would be worse than one that
        # says so.
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


# OpenRouter's Responses `usage`, as its API reference documents it
# (https://openrouter.ai/docs/api/api-reference/responses/create-a-response):
# token counts in the Responses spelling, plus `cost` in USD and `is_byok`.
OPENROUTER_RESPONSES_USAGE = {
    "input_tokens": 41883,
    "input_tokens_details": {"cached_tokens": 35072},
    "output_tokens": 514,
    "output_tokens_details": {"reasoning_tokens": 192},
    "total_tokens": 42397,
    "cost": 0.0421,
    "cost_details": {
        "upstream_inference_cost": None,
        "upstream_inference_input_cost": 0.0371,
        "upstream_inference_output_cost": 0.005,
    },
    "is_byok": False,
}


def _openrouter_response(usage: dict = OPENROUTER_RESPONSES_USAGE) -> dict:
    return {
        "id": "gen-1759140000-RESPONSES",
        "object": "response",
        "created_at": 1759140000,
        "model": "openai/gpt-6-luna",
        "status": "completed",
        "output": [
            {
                "type": "message",
                "id": "msg_1",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": "Antwort", "annotations": []}],
            }
        ],
        "parallel_tool_calls": True,
        "tool_choice": "auto",
        "tools": [],
        "usage": usage,
    }


def _responses_llm(*, streaming: bool, usage: dict = OPENROUTER_RESPONSES_USAGE):
    """A real Responses-API ChatOpenAI whose HTTP is answered in-process."""
    import httpx
    from langchain_openai import ChatOpenAI

    body = _openrouter_response(usage)

    def handler(request: httpx.Request) -> httpx.Response:
        if not streaming:
            return httpx.Response(200, json=body)
        in_progress = {**body, "status": "in_progress", "output": [], "usage": None}
        events = [
            {"type": "response.created", "sequence_number": 0, "response": in_progress},
            {
                "type": "response.output_text.delta",
                "sequence_number": 1,
                "item_id": "msg_1",
                "output_index": 0,
                "content_index": 0,
                "delta": "Antwort",
                "logprobs": [],
            },
            {"type": "response.completed", "sequence_number": 2, "response": body},
        ]
        sse = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    return ChatOpenAI(
        model="openai/gpt-6-luna",
        api_key="test",  # pragma: allowlist secret
        base_url="https://openrouter.ai/api/v1",
        use_responses_api=True,
        streaming=streaming,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


class TestResponsesApiCost:
    """The main answer role runs on the Responses API; its cost must reach the ledger.

    Before the carrier every `research_llm` call was recorded at cost 0, so an
    answer's details showed only its post-answer stages (~0.1 credits) and the
    budget was never charged for the answer itself.
    """

    def test_the_carrier_is_installed(self):
        from langchain_openai.chat_models import base as lc_openai

        from aiq_agent.common import cost_tracking

        assert cost_tracking._RESPONSES_COST_CARRIER_INSTALLED
        assert getattr(lc_openai._construct_lc_result_from_responses_api, "__grid_cost_carrier__", False)
        assert cost_tracking.install_responses_cost_carrier() is True  # idempotent

    @pytest.mark.parametrize("streaming", [False, True], ids=["invoke", "stream"])
    def test_a_responses_call_records_the_providers_cost(self, streaming):
        tracker = GridCostTracker(organization_id="org_1")
        _responses_llm(streaming=streaming).invoke("Frage", config={"callbacks": [tracker]})
        assert tracker.events_recorded == 1
        event = tracker._pending[0]
        assert event.cost_usd == pytest.approx(0.0421)
        assert event.cost_source == "usage_field"
        assert event.is_byok is False
        assert event.prompt_tokens == 41883
        assert event.cached_tokens == 35072
        assert event.reasoning_tokens == 192
        assert event.model == "openai/gpt-6-luna"
        assert tracker.turn_cost_usd == pytest.approx(0.0421)

    def test_a_byok_responses_call_is_marked_byok(self):
        tracker = GridCostTracker(organization_id="org_1")
        usage = {**OPENROUTER_RESPONSES_USAGE, "cost": 0, "is_byok": True}
        _responses_llm(streaming=False, usage=usage).invoke("Frage", config={"callbacks": [tracker]})
        assert tracker._pending[0].is_byok is True

    def test_a_reply_without_cost_still_says_missing(self):
        tracker = GridCostTracker(organization_id="org_1")
        usage = {k: v for k, v in OPENROUTER_RESPONSES_USAGE.items() if k not in ("cost", "is_byok")}
        _responses_llm(streaming=False, usage=usage).invoke("Frage", config={"callbacks": [tracker]})
        event = tracker._pending[0]
        assert event.cost_usd == 0.0
        assert event.cost_source == "missing"

    def test_the_budget_gate_sees_the_answers_cost(self):
        tracker = GridCostTracker(organization_id="org_1", budget=BudgetSnapshot(remaining_org_usd=0.04))
        llm = _responses_llm(streaming=False)
        llm.invoke("Frage", config={"callbacks": [tracker]})
        with pytest.raises(BudgetExceededError):
            llm.invoke("Noch eine", config={"callbacks": [tracker]})


class TestCallsOutsideLangChain:
    """Ingestion's vision, transcription and embedding calls use the raw SDK: no callback sees them."""

    @staticmethod
    def _client(response):
        from types import SimpleNamespace

        completions = SimpleNamespace(create=lambda **_kwargs: response)
        embeddings = SimpleNamespace(create=lambda **_kwargs: response)
        return SimpleNamespace(chat=SimpleNamespace(completions=completions), embeddings=embeddings)

    @staticmethod
    def _response(**usage):
        from types import SimpleNamespace

        return SimpleNamespace(id="gen-1", model="vendor/vision-1", usage=usage)

    def test_a_metered_client_books_each_call_with_its_role_and_reported_cost(self):
        from aiq_agent.common.cost_tracking import meter_openai_client

        response = self._response(prompt_tokens=1200, completion_tokens=80, total_tokens=1280, cost=0.0031)
        client = meter_openai_client(self._client(response), role="ingest_vision")
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            with track_llm_costs(identity={"organization_id": "org_1"}, budget=BudgetSnapshot(), activity="ingest"):
                assert client.chat.completions.create(model="vendor/vision-1", messages=[]) is response
                client.embeddings.create(model="vendor/vision-1", input=["x"])
        payload = post.call_args.args[0]
        assert payload["activity"] == "ingest"
        first = payload["events"][0]
        assert (first["role"], first["promptTokens"], first["costUsd"], first["costSource"]) == (
            "ingest_vision",
            1200,
            0.0031,
            "usage_field",
        )
        assert len(payload["events"]) == 2

    def test_a_call_without_a_reported_cost_is_booked_as_missing_not_free(self):
        from aiq_agent.common.cost_tracking import meter_openai_client

        client = meter_openai_client(self._client(self._response(prompt_tokens=10, total_tokens=10)), role="embedding")
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            with track_llm_costs(identity={"organization_id": "org_1"}, budget=BudgetSnapshot()):
                client.embeddings.create(model="m", input=["x"])
        assert post.call_args.args[0]["events"][0]["costSource"] == "missing"

    def test_without_a_tracker_a_metered_call_books_nothing_and_still_answers(self):
        from aiq_agent.common.cost_tracking import meter_openai_client

        response = self._response(prompt_tokens=10, total_tokens=10, cost=0.1)
        client = meter_openai_client(self._client(response), role="embedding")
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            assert client.embeddings.create(model="m", input=["x"]) is response
        post.assert_not_called()

    def test_metering_twice_books_a_call_once(self):
        from aiq_agent.common.cost_tracking import meter_openai_client

        client = self._client(self._response(prompt_tokens=10, total_tokens=10, cost=0.1))
        meter_openai_client(meter_openai_client(client, role="embedding"), role="embedding")
        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            with track_llm_costs(identity={"organization_id": "org_1"}, budget=BudgetSnapshot()):
                client.embeddings.create(model="m", input=["x"])
        assert len(post.call_args.args[0]["events"]) == 1

    def test_work_handed_to_a_pool_lands_on_the_callers_ledger(self):
        # A pool thread starts with an empty context: without the copy, every
        # vision call an ingestion job fanned out ran with no tracker at all.
        from concurrent.futures import ThreadPoolExecutor

        from aiq_agent.common.cost_tracking import record_usage_event
        from aiq_agent.common.cost_tracking import submit_in_context

        def call() -> bool:
            return record_usage_event(model="m", role="ingest_vision", prompt_tokens=5, cost_usd=0.01)

        with patch("aiq_agent.common.cost_tracking._post_usage_events") as post:
            with track_llm_costs(identity={"organization_id": "org_1"}, budget=BudgetSnapshot()):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    assert pool.submit(call).result() is False
                    assert [f.result() for f in [submit_in_context(pool, call) for _ in range(3)]] == [True] * 3
        assert len(post.call_args.args[0]["events"]) == 3
