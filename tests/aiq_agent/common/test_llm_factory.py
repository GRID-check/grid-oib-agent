"""Tests for fleet-wide OpenRouter structured-output defaults."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from aiq_agent.common.llm_factory import apply_openrouter_structured_defaults
from aiq_agent.common.llm_factory import get_langchain_llm


class FakeLLM:
    """Minimal stand-in for a LangChain ChatOpenAI (mutable extra_body)."""

    def __init__(self, base_url="https://openrouter.ai/api/v1", extra_body=None):
        self.openai_api_base = base_url
        self.extra_body = extra_body


def test_openrouter_llm_gets_response_healing():
    llm = FakeLLM()
    apply_openrouter_structured_defaults(llm)
    assert {"id": "response-healing"} in llm.extra_body["plugins"]


def test_require_parameters_is_not_set():
    # require_parameters is deliberately omitted: it 404s ("No endpoints found
    # that can handle the requested parameters") when a group is overridden to a
    # model whose endpoints don't support every param we send.
    llm = FakeLLM()
    apply_openrouter_structured_defaults(llm)
    assert "provider" not in llm.extra_body


def test_is_idempotent():
    llm = FakeLLM()
    apply_openrouter_structured_defaults(llm)
    apply_openrouter_structured_defaults(llm)
    healing = [p for p in llm.extra_body["plugins"] if p.get("id") == "response-healing"]
    assert len(healing) == 1


def test_preserves_existing_extra_body():
    llm = FakeLLM(extra_body={"provider": {"order": ["A"]}, "plugins": [{"id": "web"}]})
    apply_openrouter_structured_defaults(llm)
    # Pre-existing provider prefs are left untouched (we neither add nor remove).
    assert llm.extra_body["provider"] == {"order": ["A"]}
    ids = {p["id"] for p in llm.extra_body["plugins"]}
    assert ids == {"web", "response-healing"}


def test_non_openrouter_llm_is_untouched():
    llm = FakeLLM(base_url="https://llm.example.test/v1")
    apply_openrouter_structured_defaults(llm)
    assert llm.extra_body is None


def test_llm_without_extra_body_field_is_untouched():
    llm = SimpleNamespace(openai_api_base="https://openrouter.ai/api/v1")
    # No extra_body attribute at all -> returned unchanged, no crash.
    assert apply_openrouter_structured_defaults(llm) is llm
    assert not hasattr(llm, "extra_body")


def test_base_url_falls_back_to_client():
    llm = SimpleNamespace(
        openai_api_base=None,
        base_url=None,
        async_client=SimpleNamespace(base_url="https://openrouter.ai/api/v1"),
        extra_body=None,
    )
    apply_openrouter_structured_defaults(llm)
    assert {"id": "response-healing"} in llm.extra_body["plugins"]


@pytest.mark.asyncio
async def test_get_langchain_llm_resolves_and_hardens():
    llm = FakeLLM()
    builder = SimpleNamespace(get_llm=AsyncMock(return_value=llm))
    result = await get_langchain_llm(builder, "some_ref")
    assert result is llm
    assert result.extra_body["plugins"] == [{"id": "response-healing"}]
    builder.get_llm.assert_awaited_once()


# -- prompt-cache affinity on the outgoing request ----------------------------
#
# The seam these pin is `prepare_request`, which both the chat-completions and
# the Responses payload builders pass through. Asserting on the PAYLOAD rather
# than on the helper is the point: the fields have to survive langchain's
# per-API payload construction, and on the Responses path they ride in
# `extra_body` precisely because that is the one bag both builders forward.


def _openrouter_chat_model(**kwargs):
    from langchain_openai import ChatOpenAI

    from aiq_agent.common.llm_factory import enforce_chat_request_contract

    llm = ChatOpenAI(
        model="openai/gpt-5.6-luna",
        api_key="test-key",
        base_url="https://openrouter.ai/api/v1",
        **kwargs,
    )
    return enforce_chat_request_contract(apply_openrouter_structured_defaults(llm))


def _sent_payload(llm, messages, **bind_kwargs):
    """The request body one `invoke` would put on the wire, without the network."""
    captured = {}
    base = type(llm).__mro__[1]
    original = base._generate

    def _capture(self, msgs, stop=None, run_manager=None, **kwargs):
        captured["payload"] = self._get_request_payload(msgs, stop=stop, **kwargs)
        raise _Captured

    base._generate = _capture
    try:
        (llm.bind(**bind_kwargs) if bind_kwargs else llm).invoke(messages)
    except _Captured:
        pass
    finally:
        base._generate = original
    return captured["payload"]


class _Captured(Exception):
    """Stop the call once the payload exists; nothing should reach the network."""


def _messages(system="You are Piloti."):
    from langchain_core.messages import HumanMessage
    from langchain_core.messages import SystemMessage

    return [SystemMessage(content=system), HumanMessage(content="Wie hoch darf die Brüstung sein?")]


DEFERRED_TOOLS = [
    {"type": "tool_search"},
    {"type": "namespace", "name": "piloti", "tools": [{"type": "function", "name": "knowledge_search"}]},
]


def test_chat_completions_payload_carries_the_cache_routing_fields():
    payload = _sent_payload(_openrouter_chat_model(), _messages(), tools=DEFERRED_TOOLS)
    extra_body = payload["extra_body"]
    assert extra_body["session_id"] == extra_body["prompt_cache_key"]
    assert extra_body["session_id"].startswith("grid-")


def test_responses_payload_carries_the_cache_routing_fields():
    llm = _openrouter_chat_model(use_responses_api=True)
    payload = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    assert "input" in payload  # the Responses shape, not chat completions
    assert payload["extra_body"]["session_id"].startswith("grid-")


def test_cache_routing_does_not_displace_the_response_healing_plugin():
    payload = _sent_payload(_openrouter_chat_model(), _messages(), tools=DEFERRED_TOOLS)
    assert payload["extra_body"]["plugins"] == [{"id": "response-healing"}]


def test_usage_include_is_not_sent():
    # OpenRouter: "The `usage: { include: true }` … parameters are deprecated
    # and have no effect." Sending one would be cargo cult, not configuration.
    payload = _sent_payload(_openrouter_chat_model(), _messages(), tools=DEFERRED_TOOLS)
    assert "usage" not in payload
    assert "usage" not in payload["extra_body"]


def test_provider_order_is_not_pinned():
    # A manual provider order DISABLES OpenRouter's sticky routing, which is
    # the mechanism the cache key exists to drive.
    payload = _sent_payload(_openrouter_chat_model(), _messages(), tools=DEFERRED_TOOLS)
    assert "provider" not in payload["extra_body"]


def test_a_turns_iterations_share_one_key():
    from langchain_core.messages import AIMessage
    from langchain_core.messages import ToolMessage

    llm = _openrouter_chat_model(use_responses_api=True)
    first = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    later = _sent_payload(
        llm,
        [
            *_messages(),
            AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {}, "id": "call_1"}]),
            ToolMessage(content="a passage", tool_call_id="call_1"),
        ],
        tools=DEFERRED_TOOLS,
    )
    assert first["extra_body"]["session_id"] == later["extra_body"]["session_id"]


def test_a_different_system_prompt_gets_a_different_key():
    llm = _openrouter_chat_model()
    first = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    other = _sent_payload(llm, _messages(system="Du bist Piloti."), tools=DEFERRED_TOOLS)
    assert first["extra_body"]["session_id"] != other["extra_body"]["session_id"]


def test_a_non_openrouter_model_sends_no_cache_routing():
    # `session_id` is OpenRouter's own field; a direct OpenAI-compatible
    # endpoint would be handed a parameter it never declared.
    from langchain_openai import ChatOpenAI

    from aiq_agent.common.llm_factory import enforce_chat_request_contract

    llm = enforce_chat_request_contract(
        ChatOpenAI(model="gpt-5.6", api_key="test-key", base_url="https://api.openai.test/v1")
    )
    payload = _sent_payload(llm, _messages())
    assert "extra_body" not in payload


def test_cache_routing_composes_with_zdr_provider_routing():
    # The other extra_body writer is the per-request ZDR seam
    # (`model_overrides.apply_zdr_routing`), which sets `provider.zdr`. The two
    # must compose: a tenant on ZDR still gets a cache key, and the key must not
    # displace the routing policy that keeps its data out of training sets.
    from aiq_agent.common.model_overrides import apply_zdr_routing

    llm = apply_zdr_routing(_openrouter_chat_model())
    payload = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    extra_body = payload["extra_body"]
    assert extra_body["provider"] == {"zdr": True, "data_collection": "deny"}
    assert extra_body["session_id"].startswith("grid-")
    assert extra_body["plugins"] == [{"id": "response-healing"}]


def test_a_model_override_changes_the_key():
    # A re-pointed group (ADR-0014) is a different cache, so it must not be
    # pinned to the previous model's shard.
    from aiq_agent.common.model_overrides import override_model

    llm = _openrouter_chat_model()
    before = _sent_payload(llm, _messages(), tools=DEFERRED_TOOLS)
    after = _sent_payload(override_model(llm, "anthropic/claude-sonnet-5"), _messages(), tools=DEFERRED_TOOLS)
    assert before["extra_body"]["session_id"] != after["extra_body"]["session_id"]


# -- previous_response_id on the OpenRouter Responses path ---------------------
#
# NAT hands every `api_type: responses` client `use_previous_response_id=True`,
# which langchain-openai fills from the last `resp_…` AIMessage id. OpenRouter
# rejects the field outright, so `get_langchain_llm` must turn it off — and only
# for OpenRouter, where a direct OpenAI endpoint keeps the feature it supports.


def _responses_chat_model(base_url):
    """A client shaped exactly the way NAT builds an `api_type: responses` one."""
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model="openai/gpt-5.6-luna",
        api_key="test-key",
        base_url=base_url,
        use_responses_api=True,
        use_previous_response_id=True,
    )


async def _resolved(llm):
    builder = SimpleNamespace(get_llm=AsyncMock(return_value=llm))
    return await get_langchain_llm(builder, "some_ref")


def _turn_after_a_resp_id_answer():
    from langchain_core.messages import AIMessage
    from langchain_core.messages import HumanMessage

    return [
        *_messages(),
        AIMessage(content="Einen Meter.", response_metadata={"id": "resp_abc"}),
        HumanMessage(content="Und im Dachgeschoss?"),
    ]


@pytest.mark.asyncio
async def test_openrouter_responses_client_never_sends_previous_response_id():
    llm = await _resolved(_responses_chat_model("https://openrouter.ai/api/v1"))
    assert llm.use_previous_response_id is False

    payload = _sent_payload(llm, _turn_after_a_resp_id_answer())
    assert "input" in payload  # still the Responses shape, not chat completions
    assert "previous_response_id" not in payload
    assert "previous_response_id" not in payload.get("extra_body", {})


@pytest.mark.asyncio
async def test_the_whole_conversation_still_goes_without_the_server_side_handle():
    # Dropping the handle is only safe because the payload stops being truncated
    # to the messages *after* the resp_ id: OpenRouter is stateless, so the
    # history has to travel with every request.
    llm = await _resolved(_responses_chat_model("https://openrouter.ai/api/v1"))
    payload = _sent_payload(llm, _turn_after_a_resp_id_answer())
    sent = str(payload["input"])
    assert "Brüstung" in sent
    assert "Dachgeschoss" in sent


@pytest.mark.asyncio
async def test_a_non_openrouter_responses_client_is_untouched():
    llm = await _resolved(_responses_chat_model("https://api.openai.test/v1"))
    assert llm.use_previous_response_id is True

    payload = _sent_payload(llm, _turn_after_a_resp_id_answer())
    assert payload["previous_response_id"] == "resp_abc"
