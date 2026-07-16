"""Tests for per-org runtime model overrides (X-Grid-Model-Overrides)."""

import base64
import json

from pydantic import BaseModel

from aiq_agent.common.llm_provider import LLMProvider
from aiq_agent.common.llm_provider import LLMRole
from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.common.model_overrides import apply_model_override
from aiq_agent.common.model_overrides import override_model
from aiq_agent.common.model_overrides import parse_model_overrides
from aiq_agent.common.model_overrides import sanitize_model_overrides


def _encode(payload: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()


class FakeChatModel(BaseModel):
    """Pydantic stand-in for ChatOpenAI: has model_name + model_copy."""

    model_name: str = "deepseek/deepseek-v4-flash"
    max_tokens: int = 4096


class TestParseModelOverrides:
    def test_round_trip(self):
        raw = _encode({"shallow_research": "anthropic/claude-sonnet-4.5"})
        assert parse_model_overrides(raw) == {"shallow_research": "anthropic/claude-sonnet-4.5"}

    def test_none_and_empty(self):
        assert parse_model_overrides(None) == {}
        assert parse_model_overrides("") == {}

    def test_malformed_base64_and_json_fail_open(self):
        assert parse_model_overrides("!!!not-base64!!!") == {}
        assert parse_model_overrides(base64.urlsafe_b64encode(b"not json").decode()) == {}

    def test_non_object_payload_fails_open(self):
        assert parse_model_overrides(_encode(["a", "b"])) == {}

    def test_unknown_groups_dropped(self):
        raw = _encode({"nonsense_group": "vendor/model", "intent": "vendor/model"})
        assert parse_model_overrides(raw) == {"intent": "vendor/model"}

    def test_invalid_model_ids_dropped(self):
        raw = _encode(
            {
                "clarifier": "vendor/model with spaces",
                "shallow_research": 42,
                "deep_research": "vendor/ok-model:free",
            }
        )
        assert parse_model_overrides(raw) == {"deep_research": "vendor/ok-model:free"}

    def test_provider_native_ids_accepted_for_byok(self):
        # BYOK orgs (ADR-0022) may run provider-native ids without a slash;
        # multi-slash ids are still rejected.
        raw = _encode({"intent": "gpt-4o", "clarifier": "ft:gpt-4o:acme::abc", "deep_research": "a/b/c"})
        assert parse_model_overrides(raw) == {"intent": "gpt-4o", "clarifier": "ft:gpt-4o:acme::abc"}

    def test_sanitize_rejects_non_dict(self):
        assert sanitize_model_overrides("x") == {}
        assert sanitize_model_overrides(None) == {}


class TestOverrideModel:
    def test_copies_with_new_model_and_keeps_params(self):
        llm = FakeChatModel()
        result = override_model(llm, "qwen/qwen-3.5-72b")
        assert result is not llm
        assert result.model_name == "qwen/qwen-3.5-72b"
        assert result.max_tokens == 4096
        # Original untouched — overrides must be request-scoped.
        assert llm.model_name == "deepseek/deepseek-v4-flash"

    def test_unrecognized_object_returned_unchanged(self):
        sentinel = object()
        assert override_model(sentinel, "vendor/model") is sentinel

    def test_apply_with_explicit_overrides(self):
        llm = FakeChatModel()
        result = apply_model_override(llm, AgentGroup.INTENT, {"intent": "vendor/other"})
        assert result.model_name == "vendor/other"

    def test_apply_without_matching_override_is_identity(self):
        llm = FakeChatModel()
        assert apply_model_override(llm, AgentGroup.INTENT, {"clarifier": "vendor/other"}) is llm


class TestProviderWithModelOverrides:
    def _provider(self) -> LLMProvider:
        provider = LLMProvider()
        provider.set_default(FakeChatModel(model_name="default/model"), group=AgentGroup.DEEP_RESEARCH)
        provider.configure(
            LLMRole.ROUTER, FakeChatModel(model_name="router/model"), group=AgentGroup.DEEP_RESEARCH_ROUTER
        )
        provider.configure(LLMRole.PLANNER, FakeChatModel(model_name="planner/model"), group=AgentGroup.DEEP_RESEARCH)
        return provider

    def test_identity_when_no_relevant_override(self):
        provider = self._provider()
        assert provider.with_model_overrides({}) is provider
        assert provider.with_model_overrides({"intent": "vendor/x"}) is provider

    def test_overrides_apply_per_group(self):
        provider = self._provider()
        derived = provider.with_model_overrides(
            {"deep_research": "vendor/deep", "deep_research_router": "vendor/router"}
        )
        assert derived is not provider
        assert derived.get(LLMRole.ROUTER).model_name == "vendor/router"
        assert derived.get(LLMRole.PLANNER).model_name == "vendor/deep"
        # Default falls back through get() for unconfigured roles.
        assert derived.get(LLMRole.ORCHESTRATOR).model_name == "vendor/deep"

    def test_applied_overrides_are_logged(self, caplog):
        provider = self._provider()
        with caplog.at_level("INFO", logger="aiq_agent.common.llm_provider"):
            provider.with_model_overrides({"deep_research": "vendor/deep", "unknown_group": "x/y"})
        assert "Applying model overrides" in caplog.text
        assert "deep_research" in caplog.text and "vendor/deep" in caplog.text
        # Untagged/unknown groups are not reported as applied.
        assert "unknown_group" not in caplog.text

    def test_partial_override_leaves_other_groups_untouched(self):
        provider = self._provider()
        derived = provider.with_model_overrides({"deep_research_router": "vendor/router"})
        assert derived.get(LLMRole.ROUTER).model_name == "vendor/router"
        assert derived.get(LLMRole.PLANNER).model_name == "planner/model"

    def test_original_provider_never_mutated(self):
        provider = self._provider()
        provider.with_model_overrides({"deep_research": "vendor/deep"})
        assert provider.get(LLMRole.PLANNER).model_name == "planner/model"
        assert provider.get(LLMRole.ORCHESTRATOR).model_name == "default/model"

    def test_untagged_provider_is_never_derived(self):
        provider = LLMProvider()
        provider.set_default(FakeChatModel())
        assert provider.with_model_overrides({"deep_research": "vendor/deep"}) is provider
