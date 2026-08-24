"""Tests for OpenRouter server-side tool search + deferred tool loading.

The failure every one of these guards is the same one: a request that LOOKS
configured and defers nothing. It is invisible from the outside — the model
still answers — so each rule that makes the deferral real has its own test.
"""

import asyncio
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.tools import tool

from aiq_agent.common.deferred_tool_loading import _MODEL_VERDICTS
from aiq_agent.common.deferred_tool_loading import KNOWN_DEFERRING_MODELS
from aiq_agent.common.deferred_tool_loading import DeferredToolBinding
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingError
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingModels
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import assert_deferred_payload
from aiq_agent.common.deferred_tool_loading import assert_request_defers_tools
from aiq_agent.common.deferred_tool_loading import bind_tools_deferred
from aiq_agent.common.deferred_tool_loading import build_deferred_tool_payload
from aiq_agent.common.deferred_tool_loading import cached_model_verdict
from aiq_agent.common.deferred_tool_loading import capability_verdict
from aiq_agent.common.deferred_tool_loading import ensure_model_verdict
from aiq_agent.common.deferred_tool_loading import model_supports_deferred_tool_loading
from aiq_agent.common.deferred_tool_loading import record_model_verdict
from aiq_agent.common.deferred_tool_loading import reset_model_capability_cache
from aiq_agent.common.deferred_tool_loading import supports_deferred_tool_loading
from aiq_agent.common.deferred_tool_loading import tool_payload_name
from aiq_agent.common.deferred_tool_loading import verify_deferred_tool_loading


@tool
def ifc_measure(operation: str) -> str:
    """Misst Bauteile am IFC-Modell: lichte Raumhöhe, Fläche, Brüstung."""
    return "2,42 m"


@tool
def ris_search(query: str) -> str:
    """Sucht österreichische Rechtsnormen im RIS."""
    return "OIB-RL 4"


TOOLS = [ifc_measure, ris_search]
ON = DeferredToolLoadingSettings(enabled=True)


class FakeOpenRouterLLM:
    """A ChatOpenAI stand-in on OpenRouter's Responses API.

    ``_get_request_payload`` mirrors langchain-openai's real behaviour for the
    shapes this module produces: top-level chat-shaped function tools are
    flattened, everything else (our namespace, the tool_search tool) is passed
    through verbatim.
    """

    def __init__(
        self,
        *,
        base_url="https://openrouter.ai/api/v1",
        use_responses_api=True,
        model_name="openai/gpt-5.6-luna",
    ):
        self.openai_api_base = base_url
        self.use_responses_api = use_responses_api
        self.model_name = model_name
        self.bound: dict | None = None
        self.bind_tools_calls: list = []
        self.root_async_client = SimpleNamespace()

    def bind_tools(self, tools, **kwargs):
        self.bind_tools_calls.append(list(tools))
        return SimpleNamespace(kind="plain_binding", tools=list(tools), kwargs=kwargs)

    def bind(self, **kwargs):
        self.bound = kwargs
        return SimpleNamespace(kind="deferred_binding", **kwargs)

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = {"model": "openai/gpt-5.6-luna", "input": "ping", **kwargs}
        tools = payload.get("tools")
        if isinstance(tools, list):
            payload["tools"] = [
                ({"type": "function", **t["function"]} if t.get("type") == "function" and "function" in t else t)
                for t in tools
            ]
        return payload


# ---------------------------------------------------------------- the payload


def test_the_payload_is_a_tool_search_tool_followed_by_one_namespace():
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    assert [t["type"] for t in payload] == ["tool_search", "namespace"]
    assert payload[0] == {"type": "tool_search"}
    assert payload[1]["name"] == "piloti"


def test_the_input_spelling_is_tool_search_not_the_output_item_type():
    # `openrouter:tool_search` is what comes BACK; sending it is a 400.
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    assert payload[0]["type"] == "tool_search"
    assert "openrouter:" not in json.dumps(payload)


def test_every_namespaced_function_carries_defer_loading():
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    functions = payload[1]["tools"]
    assert [f["name"] for f in functions] == ["ifc_measure", "ris_search"]
    assert all(f["defer_loading"] is True for f in functions)


def test_no_function_tool_is_left_at_the_top_level():
    # THE gotcha: OpenRouter's FunctionTool schema has no `defer_loading`, so a
    # top-level function silently drops it and the request 400s with
    # "tools.tool_search requires at least one deferred tool".
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    assert [t for t in payload if t["type"] == "function"] == []


def test_namespaced_functions_are_in_the_flat_responses_shape():
    # langchain-openai flattens {"type": "function", "function": {...}} only at
    # the TOP level, so a chat-shaped tool nested in the namespace would reach
    # OpenRouter unflattened.
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    for function in payload[1]["tools"]:
        assert "function" not in function
        assert function["type"] == "function"
        assert isinstance(function["name"], str)
        assert isinstance(function["parameters"], dict)


def test_an_already_flat_dict_tool_is_accepted_and_not_double_wrapped():
    flat = {"type": "function", "name": "x", "description": "d", "parameters": {"type": "object", "properties": {}}}
    payload = build_deferred_tool_payload([flat], settings=ON)
    assert payload[1]["tools"] == [{**flat, "defer_loading": True}]
    assert "defer_loading" not in flat  # caller's dict untouched


def test_a_chat_shaped_dict_tool_is_flattened():
    chat = {"type": "function", "function": {"name": "y", "description": "d", "parameters": {"type": "object"}}}
    payload = build_deferred_tool_payload([chat], settings=ON)
    assert payload[1]["tools"][0]["name"] == "y"
    assert "function" not in payload[1]["tools"][0]


def test_an_empty_tool_set_cannot_be_deferred():
    with pytest.raises(DeferredToolLoadingError, match="at least one tool"):
        build_deferred_tool_payload([], settings=ON)


# -------------------------------------------------------------- the assertion


def test_assert_rejects_a_payload_with_no_tool_search_tool():
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    with pytest.raises(DeferredToolLoadingError, match="tool_search"):
        assert_deferred_payload(payload[1:])


def test_assert_rejects_a_function_that_lost_its_defer_loading_flag():
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    del payload[1]["tools"][1]["defer_loading"]
    with pytest.raises(DeferredToolLoadingError, match="not marked deferred"):
        assert_deferred_payload(payload)


def test_assert_rejects_a_function_tool_that_escaped_the_namespace():
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    payload.append({"type": "function", "name": "loose", "defer_loading": True})
    with pytest.raises(DeferredToolLoadingError, match="outside the namespace"):
        assert_deferred_payload(payload)


def test_assert_rejects_an_empty_namespace():
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    payload[1]["tools"] = []
    with pytest.raises(DeferredToolLoadingError, match="no functions"):
        assert_deferred_payload(payload)


def test_assert_rejects_two_namespaces():
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    payload.append(dict(payload[1]))
    with pytest.raises(DeferredToolLoadingError, match="exactly one"):
        assert_deferred_payload(payload)


def test_the_wire_payload_is_asserted_not_just_the_one_we_built():
    llm = FakeOpenRouterLLM()
    payload = build_deferred_tool_payload(TOOLS, settings=ON)
    wire = assert_request_defers_tools(llm, payload)
    assert [t["type"] for t in wire["tools"]] == ["tool_search", "namespace"]


def test_a_client_that_strips_the_namespace_is_caught_at_the_wire():
    llm = FakeOpenRouterLLM()
    llm._get_request_payload = lambda *a, **k: {"model": "m", "tools": [{"type": "function", "name": "ifc_measure"}]}
    with pytest.raises(DeferredToolLoadingError):
        assert_request_defers_tools(llm, build_deferred_tool_payload(TOOLS, settings=ON))


# ------------------------------------------------------------- applicability


def test_openrouter_plus_responses_api_supports_deferral():
    assert supports_deferred_tool_loading(FakeOpenRouterLLM()) is True


def test_chat_completions_does_not_support_deferral():
    # config_grid_oib.yml's Kimi endpoint: Chat Completions, no namespace tools.
    assert supports_deferred_tool_loading(FakeOpenRouterLLM(use_responses_api=False)) is False


def test_a_non_openrouter_endpoint_does_not_support_deferral():
    assert supports_deferred_tool_loading(FakeOpenRouterLLM(base_url="https://api.kimi.com/coding/v1")) is False


# ------------------------------------------------------------------- binding


def test_the_feature_is_inert_when_disabled():
    llm = FakeOpenRouterLLM()
    bound = bind_tools_deferred(llm, TOOLS, settings=None, parallel_tool_calls=True)
    assert bound.kind == "plain_binding"
    assert llm.bound is None
    assert llm.bind_tools_calls == [TOOLS]


def test_the_feature_is_inert_when_settings_say_enabled_false():
    llm = FakeOpenRouterLLM()
    bound = bind_tools_deferred(llm, TOOLS, settings=DeferredToolLoadingSettings(), parallel_tool_calls=True)
    assert bound.kind == "plain_binding"
    assert llm.bound is None


def test_a_chat_completions_llm_falls_back_to_the_full_tool_set():
    llm = FakeOpenRouterLLM(use_responses_api=False)
    bound = bind_tools_deferred(llm, TOOLS, settings=ON, parallel_tool_calls=True)
    assert bound.kind == "plain_binding"
    assert llm.bound is None


def test_an_enabled_openrouter_llm_gets_the_deferred_payload():
    llm = FakeOpenRouterLLM()
    bound = bind_tools_deferred(llm, TOOLS, settings=ON, parallel_tool_calls=True)
    assert isinstance(bound, DeferredToolBinding)
    assert [t["type"] for t in llm.bound["tools"]] == ["tool_search", "namespace"]
    assert llm.bound["parallel_tool_calls"] is True
    # The fallback is built too — an unusable deferred path must never leave the
    # agent with no binding at all.
    assert bound.fallback.kind == "plain_binding"


def test_a_payload_that_would_not_defer_falls_back_instead_of_raising(caplog):
    llm = FakeOpenRouterLLM()
    llm._get_request_payload = lambda *a, **k: {"model": "m", "tools": [{"type": "function", "name": "x"}]}
    with caplog.at_level(logging.ERROR):
        bound = bind_tools_deferred(llm, TOOLS, settings=ON, parallel_tool_calls=True)
    assert bound.kind == "plain_binding"
    assert "DeferredToolLoading" in caplog.text


# ------------------------------------------------------------- the fallback


async def test_a_failed_deferred_call_degrades_to_the_full_binding(caplog):
    deferred = SimpleNamespace(ainvoke=AsyncMock(side_effect=RuntimeError("400 tool_search")))
    fallback = SimpleNamespace(ainvoke=AsyncMock(return_value="answer"))
    binding = DeferredToolBinding(deferred, fallback)
    with caplog.at_level(logging.ERROR):
        assert await binding.ainvoke(["msg"]) == "answer"
    assert "falling back to the full tool schemas" in caplog.text


async def test_the_degradation_latches_so_five_iterations_do_not_each_pay_for_it():
    deferred = SimpleNamespace(ainvoke=AsyncMock(side_effect=RuntimeError("boom")))
    fallback = SimpleNamespace(ainvoke=AsyncMock(return_value="answer"))
    binding = DeferredToolBinding(deferred, fallback)
    for _ in range(5):
        await binding.ainvoke(["msg"])
    assert deferred.ainvoke.await_count == 1
    assert fallback.ainvoke.await_count == 5
    assert binding.degraded is True


async def test_a_working_deferred_call_never_touches_the_fallback():
    deferred = SimpleNamespace(ainvoke=AsyncMock(return_value="deferred answer"))
    fallback = SimpleNamespace(ainvoke=AsyncMock())
    binding = DeferredToolBinding(deferred, fallback)
    assert await binding.ainvoke(["msg"]) == "deferred answer"
    assert fallback.ainvoke.await_count == 0


def test_the_sync_path_degrades_too():
    deferred = SimpleNamespace(invoke=MagicMock(side_effect=RuntimeError("boom")))
    fallback = SimpleNamespace(invoke=MagicMock(return_value="answer"))
    binding = DeferredToolBinding(deferred, fallback)
    assert binding.invoke(["msg"]) == "answer"
    assert binding.invoke(["msg"]) == "answer"
    assert deferred.invoke.call_count == 1


# --------------------------------------------------------- capability check


def _probe_client(body: dict) -> SimpleNamespace:
    raw = SimpleNamespace(text=json.dumps(body))
    create = AsyncMock(return_value=raw)
    return SimpleNamespace(responses=SimpleNamespace(with_raw_response=SimpleNamespace(create=create)))


def _accepted_body() -> dict:
    return {
        "tools": [
            {
                "type": "namespace",
                "name": "piloti",
                "tools": [
                    {"type": "function", "name": "grid_probe_alpha", "defer_loading": True},
                    {"type": "function", "name": "grid_probe_beta", "defer_loading": True},
                ],
            }
        ],
        "usage": {"input_tokens": 431},
    }


async def test_the_capability_check_is_a_no_op_when_the_feature_is_off():
    llm = FakeOpenRouterLLM(base_url="https://api.kimi.com/coding/v1", use_responses_api=False)
    await verify_deferred_tool_loading(llm, settings=DeferredToolLoadingSettings())


async def test_the_capability_check_passes_when_the_provider_echoes_the_deferral():
    llm = FakeOpenRouterLLM()
    llm.root_async_client = _probe_client(_accepted_body())
    await verify_deferred_tool_loading(llm, settings=ON)


async def test_the_capability_check_raises_when_the_provider_strips_defer_loading():
    body = _accepted_body()
    for function in body["tools"][0]["tools"]:
        del function["defer_loading"]
    llm = FakeOpenRouterLLM()
    llm.root_async_client = _probe_client(body)
    with pytest.raises(DeferredToolLoadingError, match="did NOT echo the deferred shape"):
        await verify_deferred_tool_loading(llm, settings=ON)


async def test_the_capability_check_raises_on_the_rejected_shape_400():
    llm = FakeOpenRouterLLM()
    create = AsyncMock(side_effect=RuntimeError("tools.tool_search requires at least one deferred tool"))
    llm.root_async_client = SimpleNamespace(responses=SimpleNamespace(with_raw_response=SimpleNamespace(create=create)))
    with pytest.raises(DeferredToolLoadingError, match="rejected the deferred tool shape"):
        await verify_deferred_tool_loading(llm, settings=ON)


async def test_the_capability_check_raises_on_a_deployment_that_cannot_defer_at_all():
    # An operator who wrote `enabled: true` under a Chat-Completions LLM must
    # find out at startup, not from the token bill.
    llm = FakeOpenRouterLLM(base_url="https://api.kimi.com/coding/v1", use_responses_api=False)
    with pytest.raises(DeferredToolLoadingError, match="api_type: responses"):
        await verify_deferred_tool_loading(llm, settings=ON)


async def test_an_unreachable_endpoint_is_not_evidence_and_does_not_fail_the_build(caplog):
    llm = FakeOpenRouterLLM()
    create = AsyncMock(side_effect=TimeoutError("connect timeout"))
    llm.root_async_client = SimpleNamespace(responses=SimpleNamespace(with_raw_response=SimpleNamespace(create=create)))
    with caplog.at_level(logging.WARNING):
        await verify_deferred_tool_loading(llm, settings=ON)
    assert "could not reach the endpoint" in caplog.text


# ------------------------------------------------------------------- helper


@pytest.mark.parametrize(
    "shape",
    [
        SimpleNamespace(name="ifc_measure"),
        {"name": "ifc_measure"},
        {"type": "function", "function": {"name": "ifc_measure"}},
    ],
)
def test_tool_payload_name_reads_every_shape_langchain_passes(shape):
    assert tool_payload_name(shape) == "ifc_measure"


def test_tool_payload_name_returns_none_for_an_unnameable_tool():
    assert tool_payload_name({"type": "tool_search"}) is None


def test_the_deep_researcher_middleware_shares_this_one_implementation():
    from aiq_agent.agents.deep_researcher.custom_middleware import _request_tool_name

    assert _request_tool_name({"type": "function", "function": {"name": "ifc_measure"}}) == "ifc_measure"
    assert _request_tool_name({"type": "tool_search"}) is None


# ------------------------------------------------- the per-model capability gate
#
# The gap these guard: OpenRouter + Responses says the CLIENT can express the
# deferred shape. It says nothing about the model on the other end, and the
# per-org override seam swaps that model per request. Without a model layer an
# override to gpt-4o-mini sends a deferred payload to a 400.


@pytest.fixture(autouse=True)
def _clean_capability_cache():
    """The probe cache is process-wide; no test may inherit another's verdicts."""
    reset_model_capability_cache()
    yield
    reset_model_capability_cache()


def _bind(llm, settings=None):
    return bind_tools_deferred(llm, TOOLS, settings=settings or ON)


def test_an_allowlisted_model_gets_the_deferred_payload():
    llm = FakeOpenRouterLLM(model_name="openai/gpt-5.6-luna")
    assert isinstance(_bind(llm), DeferredToolBinding)


def test_an_unlisted_model_does_not_get_a_deferred_payload():
    # The whole point: OpenRouter + Responses both hold, and it still must not
    # defer, because nobody has established that THIS model accepts the shape.
    llm = FakeOpenRouterLLM(model_name="some-vendor/brand-new-model")
    bound = _bind(llm)
    assert not isinstance(bound, DeferredToolBinding)
    assert bound.kind == "plain_binding"
    assert llm.bound is None  # never even built the payload


def test_a_denylisted_model_does_not_get_a_deferred_payload():
    llm = FakeOpenRouterLLM(model_name="openai/gpt-4o-mini")
    assert not isinstance(_bind(llm), DeferredToolBinding)


def test_a_model_the_llm_cannot_name_is_treated_as_unknown():
    llm = FakeOpenRouterLLM(model_name="")
    assert not isinstance(_bind(llm), DeferredToolBinding)


def test_the_gate_is_per_model_id_not_per_vendor_prefix():
    # Anthropic ships its own tool search, so Claude carries the shape while an
    # OpenAI model does not. A vendor-prefix allowlist would get BOTH wrong, in
    # opposite directions — this is the assertion that forbids one.
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="anthropic/claude-opus-5"), ON) is True
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="openai/gpt-4o-mini"), ON) is False
    # ...and from the other side: openai/* is on the allowlist too, so neither
    # vendor is uniformly good or bad.
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="openai/gpt-5.6-sol"), ON) is True


def test_capability_does_not_track_model_quality():
    # grok-4.6 scores 60.9 — higher than all but two allowlisted models — and
    # still 422s on the deferred shape. Quality is not capability.
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="x-ai/grok-4.6"), ON) is False


def test_a_deny_covers_the_models_variant_suffixes_but_an_allow_does_not():
    # Asymmetric on purpose: a variant is a routing choice, so it inherits the
    # operator's "never" but not their measurement. Both err towards NOT
    # deferring, which is always a correct answer.
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="openai/gpt-4o-mini:free"), ON) is False
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="openai/gpt-5.6-luna:free"), ON) is False


def test_an_explicit_glob_admits_a_family_when_the_operator_asks_for_one():
    settings = DeferredToolLoadingSettings(
        enabled=True, models=DeferredToolLoadingModels(allow=["openai/gpt-5.6-*"], deny=[])
    )
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="openai/gpt-5.6-terra"), settings) is True


def test_the_feature_stays_inert_when_disabled_whatever_the_model_is():
    # Off is off: a denylisted model must not even be consulted, let alone
    # change what an untouched deployment binds.
    llm = FakeOpenRouterLLM(model_name="openai/gpt-4o-mini")
    bound = bind_tools_deferred(llm, TOOLS, settings=DeferredToolLoadingSettings())
    assert bound.kind == "plain_binding"
    assert llm.bind_tools_calls == [list(TOOLS)]


# -------------------------------------------------------- the intelligence floor


def test_the_floor_excludes_a_capable_model_that_scores_below_it():
    # Both are capability-verified — claude-sonnet-4.6 was even seen emitting a
    # real function_call. They are excluded on SCORE, and only on score.
    for model in ("anthropic/claude-sonnet-4.6", "minimax/minimax-m3"):
        llm = FakeOpenRouterLLM(model_name=model)
        assert capability_verdict(model, ON.models) is not False
        assert model_supports_deferred_tool_loading(llm, ON) is False


def test_lowering_the_threshold_admits_exactly_those_models():
    # The proof that capability and score are independent conditions rather
    # than accidentally coupled: nothing about capability changed here.
    lowered = DeferredToolLoadingSettings(
        enabled=True,
        min_intelligence_index=45,
        models=DeferredToolLoadingModels(
            allow=[*KNOWN_DEFERRING_MODELS, "anthropic/claude-sonnet-4.6", "minimax/minimax-m3"]
        ),
    )
    for model in ("anthropic/claude-sonnet-4.6", "minimax/minimax-m3"):
        assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name=model), lowered) is True


def test_the_floor_is_per_settings_object_not_global():
    # Two thresholds alive in ONE process. If either leaked into the other the
    # floor would be module-level policy, which it must never be — this feature
    # belongs to the shallow researcher, not to the fleet.
    strict = DeferredToolLoadingSettings(
        enabled=True,
        min_intelligence_index=50,
        models=DeferredToolLoadingModels(allow=["anthropic/claude-sonnet-4.6"]),
    )
    lenient = strict.model_copy(update={"min_intelligence_index": 45})
    llm = FakeOpenRouterLLM(model_name="anthropic/claude-sonnet-4.6")
    assert model_supports_deferred_tool_loading(llm, strict) is False
    assert model_supports_deferred_tool_loading(llm, lenient) is True
    assert model_supports_deferred_tool_loading(llm, strict) is False


def test_an_unscored_model_fails_the_floor_rather_than_slipping_under_it():
    settings = DeferredToolLoadingSettings(
        enabled=True, models=DeferredToolLoadingModels(allow=["mystery/unscored-model"], deny=[])
    )
    assert (
        model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="mystery/unscored-model"), settings) is False
    )


def test_a_zero_floor_disables_the_check_and_gates_on_capability_alone():
    settings = DeferredToolLoadingSettings(
        enabled=True, min_intelligence_index=0, models=DeferredToolLoadingModels(allow=["mystery/unscored-model"])
    )
    assert (
        model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="mystery/unscored-model"), settings) is True
    )


def test_a_score_the_operator_supplies_overrides_the_pinned_table():
    settings = DeferredToolLoadingSettings(
        enabled=True,
        models=DeferredToolLoadingModels(
            allow=["anthropic/claude-sonnet-4.6"], intelligence_index={"anthropic/claude-sonnet-4.6": 99.0}
        ),
    )
    assert (
        model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="anthropic/claude-sonnet-4.6"), settings)
        is True
    )


def test_a_floor_miss_binds_full_schemas_and_never_fails_the_request():
    # The floor decides "should this agent defer", never "may this model be
    # used". A sub-floor model must run exactly as it did before this existed.
    llm = FakeOpenRouterLLM(model_name="anthropic/claude-sonnet-4.6")
    bound = _bind(llm)
    assert bound.kind == "plain_binding"
    assert llm.bind_tools_calls == [list(TOOLS)]


async def test_a_floor_miss_does_not_fail_the_build_either():
    llm = FakeOpenRouterLLM(model_name="anthropic/claude-sonnet-4.6")
    llm.root_async_client = _probe_client(_accepted_body())
    await verify_deferred_tool_loading(llm, settings=ON)  # warns, does not raise


async def test_denying_the_workflows_own_model_is_a_contradiction_caught_at_build():
    llm = FakeOpenRouterLLM(model_name="openai/gpt-4o-mini")
    llm.root_async_client = _probe_client(_accepted_body())
    with pytest.raises(DeferredToolLoadingError, match="configured and dead"):
        await verify_deferred_tool_loading(llm, settings=ON)


# --------------------------------------------------------- the provisional tier


def test_a_provisional_model_is_deferred_to_before_anyone_has_verified_it():
    # muse-spark-1.1: capability unknown (403 age gate fired before the payload
    # was read), permitted on the operator's instruction, score 53.2 clears 50.
    llm = FakeOpenRouterLLM(model_name="meta/muse-spark-1.1")
    assert isinstance(_bind(llm), DeferredToolBinding)


def test_a_provisional_model_yields_to_a_negative_verdict_but_an_allowed_one_does_not():
    # This is the whole difference between the two tiers. `allow` asserts a
    # measurement and outranks observation; `provisional` states an intent.
    record_model_verdict("meta/muse-spark-1.1", False, source="test")
    record_model_verdict("openai/gpt-5.6-luna", False, source="test")
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="meta/muse-spark-1.1"), ON) is False
    assert model_supports_deferred_tool_loading(FakeOpenRouterLLM(model_name="openai/gpt-5.6-luna"), ON) is True


# ------------------------------------------------------------ probe and cache


def _failing_client(exc):
    create = AsyncMock(side_effect=exc)
    return SimpleNamespace(responses=SimpleNamespace(with_raw_response=SimpleNamespace(create=create)))


class _Status(Exception):
    """Stand-in for openai's APIStatusError, which carries the status code."""

    def __init__(self, status_code, message=""):
        super().__init__(message or f"HTTP {status_code}")
        self.status_code = status_code


async def test_the_probe_classifies_a_capable_model_and_caches_it():
    llm = FakeOpenRouterLLM(model_name="brand/new-model")
    llm.root_async_client = _probe_client(_accepted_body())
    assert await ensure_model_verdict(llm, settings=ON) is True
    assert cached_model_verdict("brand/new-model") is True


async def test_the_probe_runs_at_most_once_per_model():
    # A probe per request would be the very cost this gate exists to remove.
    llm = FakeOpenRouterLLM(model_name="brand/new-model")
    llm.root_async_client = _probe_client(_accepted_body())
    create = llm.root_async_client.responses.with_raw_response.create
    for _ in range(5):
        await ensure_model_verdict(llm, settings=ON)
    assert create.await_count == 1


async def test_a_400_rejection_is_a_durable_unsupported_verdict():
    llm = FakeOpenRouterLLM(model_name="brand/rejecting-model")
    llm.root_async_client = _failing_client(_Status(400, "Invalid value: 'tool_search'."))
    assert await ensure_model_verdict(llm, settings=ON) is False
    assert cached_model_verdict("brand/rejecting-model") is False


async def test_a_422_rejection_is_a_durable_unsupported_verdict():
    llm = FakeOpenRouterLLM(model_name="brand/deserialize-model")
    llm.root_async_client = _failing_client(_Status(422, "Failed to deserialize the JSON body"))
    assert await ensure_model_verdict(llm, settings=ON) is False


async def test_a_provider_that_accepts_but_strips_the_deferral_is_unsupported():
    # 200 is NOT the criterion. A provider that normalizes defer_loading away
    # would look configured and pay full price forever — the silent failure.
    body = _accepted_body()
    for function in body["tools"][0]["tools"]:
        del function["defer_loading"]
    llm = FakeOpenRouterLLM(model_name="brand/stripping-model")
    llm.root_async_client = _probe_client(body)
    assert await ensure_model_verdict(llm, settings=ON) is False


@pytest.mark.parametrize(
    "exc",
    [
        _Status(500, "internal server error"),
        _Status(502, "bad gateway"),
        _Status(503, "service unavailable"),
        _Status(429, "rate limited"),
        _Status(408, "request timeout"),
        TimeoutError("connect timeout"),
        ConnectionError("connection reset"),
    ],
)
async def test_a_transient_failure_never_poisons_the_cache_as_unsupported(exc):
    # Caching a blip as a capability verdict would disable the feature for the
    # life of the process, for a model that is perfectly capable.
    llm = FakeOpenRouterLLM(model_name="brand/flaky-model")
    llm.root_async_client = _failing_client(exc)
    assert await ensure_model_verdict(llm, settings=ON) is None
    assert cached_model_verdict("brand/flaky-model") is None


async def test_an_account_gate_403_is_not_a_capability_verdict():
    # meta/muse-spark-1.1 answers 403 "requires 18+ age confirmation" — an
    # ACCOUNT gate that fires before the payload is read. Caching that as
    # "unsupported" would leave the model degraded even after it is cleared,
    # which is exactly the model the operator is actively enabling.
    llm = FakeOpenRouterLLM(model_name="meta/muse-spark-1.1")
    llm.root_async_client = _failing_client(
        _Status(403, "This model requires you to complete the following before use: 18+ age confirmation.")
    )
    assert await ensure_model_verdict(llm, settings=ON) is None
    assert cached_model_verdict("meta/muse-spark-1.1") is None
    # ...and it therefore still defers, on the operator's provisional listing.
    assert model_supports_deferred_tool_loading(llm, ON) is True


async def test_an_unreachable_model_is_given_up_on_rather_than_probed_forever():
    llm = FakeOpenRouterLLM(model_name="brand/unreachable-model")
    llm.root_async_client = _failing_client(TimeoutError("connect timeout"))
    create = llm.root_async_client.responses.with_raw_response.create
    for _ in range(10):
        await ensure_model_verdict(llm, settings=ON)
    assert create.await_count == 3


async def test_a_listed_model_is_never_probed_at_all():
    llm = FakeOpenRouterLLM(model_name="openai/gpt-5.6-luna")
    llm.root_async_client = _probe_client(_accepted_body())
    await ensure_model_verdict(llm, settings=ON)
    assert llm.root_async_client.responses.with_raw_response.create.await_count == 0


async def test_probing_can_be_switched_off_entirely():
    llm = FakeOpenRouterLLM(model_name="brand/new-model")
    llm.root_async_client = _probe_client(_accepted_body())
    settings = DeferredToolLoadingSettings(enabled=True, models=DeferredToolLoadingModels(probe_unknown=False))
    assert await ensure_model_verdict(llm, settings=settings) is None
    assert llm.root_async_client.responses.with_raw_response.create.await_count == 0


async def test_a_probed_model_then_binds_deferred_without_another_round_trip():
    llm = FakeOpenRouterLLM(model_name="google/gemini-3.7-flash")
    llm.root_async_client = _probe_client(_accepted_body())
    settings = DeferredToolLoadingSettings(enabled=True, models=DeferredToolLoadingModels(allow=[], deny=[]))
    assert not isinstance(_bind(llm, settings), DeferredToolBinding)
    await ensure_model_verdict(llm, settings=settings)
    assert isinstance(_bind(llm, settings), DeferredToolBinding)


def test_the_verdict_cache_is_bounded():
    for i in range(200):
        record_model_verdict(f"vendor/model-{i}", True, source="test")
    assert len(_MODEL_VERDICTS) <= 64
    # Eviction is oldest-first, so the most recent verdicts survive.
    assert cached_model_verdict("vendor/model-199") is True
    assert cached_model_verdict("vendor/model-0") is None


# ------------------------------- request-time rejection demotes the MODEL


async def test_a_real_tool_payload_rejection_demotes_the_model_process_wide():
    # The latch is per bound tool SET, so without this a rejecting model costs a
    # wasted round trip once per narrowed binding. Recording the model verdict
    # makes it cost one, once.
    deferred = MagicMock()
    deferred.ainvoke = AsyncMock(side_effect=_Status(400, "Invalid value: 'tool_search'."))
    fallback = MagicMock()
    fallback.ainvoke = AsyncMock(return_value="answered")
    binding = DeferredToolBinding(deferred, fallback, model_id="brand/rejecting-model")
    assert await binding.ainvoke("x") == "answered"
    assert cached_model_verdict("brand/rejecting-model") is False


@pytest.mark.parametrize(
    "exc",
    [
        _Status(503, "service unavailable"),
        _Status(400, "This request exceeds the maximum context length"),
        TimeoutError("read timeout"),
    ],
)
async def test_a_failure_that_is_not_about_our_payload_latches_but_does_not_demote(exc):
    # A content 400 or a 5xx says nothing about the model's tool grammar. The
    # binding still degrades — it just must not outlive the incident.
    deferred = MagicMock()
    deferred.ainvoke = AsyncMock(side_effect=exc)
    fallback = MagicMock()
    fallback.ainvoke = AsyncMock(return_value="answered")
    binding = DeferredToolBinding(deferred, fallback, model_id="brand/innocent-model")
    assert await binding.ainvoke("x") == "answered"
    assert binding.degraded is True
    assert cached_model_verdict("brand/innocent-model") is None


async def test_the_gate_schedules_its_probe_off_the_request_path():
    # The turn that DISCOVERS an unknown model must not wait for the probe:
    # blocking a live request on an HTTP round trip, to learn whether a
    # different round trip is worth making, is the latency this gate removes.
    # So the first binding is full-schema and non-blocking, and the probe lands
    # behind it.
    llm = FakeOpenRouterLLM(model_name="brand/scheduled-model")
    llm.root_async_client = _probe_client(_accepted_body())
    settings = DeferredToolLoadingSettings(enabled=True, models=DeferredToolLoadingModels(allow=[], deny=[]))

    bound = bind_tools_deferred(llm, TOOLS, settings=settings)
    assert not isinstance(bound, DeferredToolBinding)
    assert cached_model_verdict("brand/scheduled-model") is None  # not awaited inline

    await asyncio.sleep(0)  # let the scheduled probe run
    await asyncio.sleep(0)
    assert cached_model_verdict("brand/scheduled-model") is True


async def test_concurrent_bindings_of_one_unknown_model_cost_a_single_probe():
    llm = FakeOpenRouterLLM(model_name="brand/busy-model")
    llm.root_async_client = _probe_client(_accepted_body())
    settings = DeferredToolLoadingSettings(enabled=True, models=DeferredToolLoadingModels(allow=[], deny=[]))
    for _ in range(5):
        bind_tools_deferred(llm, TOOLS, settings=settings)
    for _ in range(4):
        await asyncio.sleep(0)
    assert llm.root_async_client.responses.with_raw_response.create.await_count == 1
