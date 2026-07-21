"""Tests for fleet-wide OpenRouter structured-output defaults."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from aiq_agent.common.llm_factory import apply_openrouter_structured_defaults
from aiq_agent.common.llm_factory import get_langchain_llm


class FakeLLM:
    """Minimal stand-in for a LangChain ChatOpenAI (mutable extra_body)."""

    def __init__(self, base_url="https://openrouter.ai/api/v1", extra_body=None, model_name="openai/gpt-4o"):
        self.openai_api_base = base_url
        self.extra_body = extra_body
        self.model_name = model_name


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


def test_deepseek_openrouter_llm_gets_first_party_provider_pin():
    # Live endpoints data: only the first-party "deepseek" host supports implicit
    # prompt caching, so deepseek/* is pinned to it while still keeping the
    # response-healing plugin. allow_fallbacks stays True so availability degrades
    # (to today's uncached routing) rather than hard-failing if it's unavailable.
    llm = FakeLLM(model_name="deepseek/deepseek-v4-flash")
    apply_openrouter_structured_defaults(llm)
    assert llm.extra_body["provider"] == {"order": ["deepseek"], "allow_fallbacks": True}
    assert {"id": "response-healing"} in llm.extra_body["plugins"]


def test_deepseek_pin_preserves_existing_provider_keys():
    # A pre-existing explicit order (and any other provider key) must be kept,
    # never clobbered; only absent keys are filled in.
    llm = FakeLLM(
        model_name="deepseek/deepseek-v4-flash",
        extra_body={"provider": {"order": ["deepseek", "fireworks"], "quantizations": ["fp8"]}},
    )
    apply_openrouter_structured_defaults(llm)
    assert llm.extra_body["provider"]["order"] == ["deepseek", "fireworks"]
    assert llm.extra_body["provider"]["quantizations"] == ["fp8"]
    assert llm.extra_body["provider"]["allow_fallbacks"] is True


def test_non_deepseek_openrouter_llm_gets_no_provider_key():
    # The pin is deepseek-only; other OpenRouter models must not gain a provider.
    llm = FakeLLM(model_name="anthropic/claude-sonnet-4.5")
    apply_openrouter_structured_defaults(llm)
    assert "provider" not in llm.extra_body
    assert {"id": "response-healing"} in llm.extra_body["plugins"]


def test_non_openrouter_deepseek_model_is_untouched():
    # Non-OpenRouter base_url: no OpenRouter defaults at all, even for deepseek/*.
    llm = FakeLLM(base_url="https://integrate.api.nvidia.com/v1", model_name="deepseek/deepseek-v4-flash")
    apply_openrouter_structured_defaults(llm)
    assert llm.extra_body is None


def test_deepseek_pin_is_idempotent():
    llm = FakeLLM(model_name="deepseek/deepseek-v4-flash")
    apply_openrouter_structured_defaults(llm)
    apply_openrouter_structured_defaults(llm)
    assert llm.extra_body["provider"] == {"order": ["deepseek"], "allow_fallbacks": True}
    healing = [p for p in llm.extra_body["plugins"] if p.get("id") == "response-healing"]
    assert len(healing) == 1


def test_non_openrouter_llm_is_untouched():
    llm = FakeLLM(base_url="https://integrate.api.nvidia.com/v1")
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
