"""Tests for OpenRouter server-side tool search + deferred tool loading.

The failure every one of these guards is the same one: a request that LOOKS
configured and defers nothing. It is invisible from the outside — the model
still answers — so each rule that makes the deferral real has its own test.
"""

import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.tools import tool

from aiq_agent.common.deferred_tool_loading import DeferredToolBinding
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingError
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import assert_deferred_payload
from aiq_agent.common.deferred_tool_loading import assert_request_defers_tools
from aiq_agent.common.deferred_tool_loading import bind_tools_deferred
from aiq_agent.common.deferred_tool_loading import build_deferred_tool_payload
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

    def __init__(self, *, base_url="https://openrouter.ai/api/v1", use_responses_api=True):
        self.openai_api_base = base_url
        self.use_responses_api = use_responses_api
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
