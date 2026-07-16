"""Tests for per-org runtime model overrides (X-Grid-Model-Overrides)."""

import base64
import functools
import json
import types

import pytest
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


class RetryPatchedChatModel(FakeChatModel):
    """Stand-in for a NAT-built ChatOpenAI (patch_with_retry applied)."""

    def invoke_model(self) -> str:
        """Returns the model the request would actually go out with (self-bound)."""
        return self.model_name


def _patch_with_retry_like_nat(llm: RetryPatchedChatModel) -> RetryPatchedChatModel:
    """Replicate NAT's patch_with_retry: wrap every public method and store it
    in the instance __dict__ as a types.MethodType bound to THIS instance."""
    original_fn = type(llm).invoke_model

    @functools.wraps(original_fn)
    def wrapper(*args, **kwargs):
        return original_fn(*args, **kwargs)

    object.__setattr__(llm, "invoke_model", types.MethodType(wrapper, llm))
    return llm


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

    def test_override_rebinds_instance_patched_methods(self):
        """Regression: NAT's patch_with_retry stores public methods in the
        instance __dict__ as MethodTypes bound to the ORIGINAL instance.
        model_copy shallow-copies __dict__, so the override copy kept invoking
        the original model (wire payload carried the old model name while logs
        showed the override)."""
        llm = _patch_with_retry_like_nat(RetryPatchedChatModel())
        result = override_model(llm, "x-ai/grok-4.5")
        assert result.model_name == "x-ai/grok-4.5"
        # The call must execute against the copy, not the original instance.
        assert result.invoke_model() == "x-ai/grok-4.5"
        # Original keeps its own binding and model.
        assert llm.invoke_model() == "deepseek/deepseek-v4-flash"


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


class TestOrgScopedFallbackResolution:
    """Header absent -> resolve the org's overrides via the internal endpoint."""

    def setup_method(self):
        from aiq_agent.common.model_overrides import reset_overrides_cache

        reset_overrides_cache()

    def test_header_takes_precedence_over_fetch(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        encoded = base64.urlsafe_b64encode(json.dumps({"intent": "vendor/x"}).encode()).decode()
        monkeypatch.setattr("aiq_agent.project_context._read_header", lambda name: encoded)
        monkeypatch.setattr(M, "_fetch_org_overrides", lambda org: pytest.fail("must not fetch when header present"))

        assert M.get_model_overrides_from_context() == {"intent": "vendor/x"}

    def test_absent_header_falls_back_to_org_resolution(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        monkeypatch.setattr("aiq_agent.project_context._read_header", lambda name: None)
        monkeypatch.setattr("aiq_agent.project_context.get_organization_id_from_context", lambda: "org_ABC123")
        monkeypatch.setattr(M, "_fetch_org_overrides", lambda org: {"deep_research": "x-ai/grok-4.5"})

        assert M.get_model_overrides_from_context() == {"deep_research": "x-ai/grok-4.5"}

    def test_no_org_in_context_returns_empty_without_fetch(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        monkeypatch.setattr("aiq_agent.project_context._read_header", lambda name: None)
        monkeypatch.setattr("aiq_agent.project_context.get_organization_id_from_context", lambda: None)
        monkeypatch.setattr(M, "_fetch_org_overrides", lambda org: pytest.fail("must not fetch without an org"))

        assert M.get_model_overrides_from_context() == {}

    def test_resolution_is_cached(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        calls = []

        def fake_fetch(org):
            calls.append(org)
            return {"intent": "vendor/x"}

        monkeypatch.setattr(M, "_fetch_org_overrides", fake_fetch)
        assert M.resolve_org_model_overrides("org_A") == {"intent": "vendor/x"}
        assert M.resolve_org_model_overrides("org_A") == {"intent": "vendor/x"}
        assert calls == ["org_A"]

    def test_fetch_failure_fails_open_to_empty(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        def boom(org):
            raise RuntimeError("bff down")

        monkeypatch.setattr(M, "_fetch_org_overrides", boom)
        assert M.resolve_org_model_overrides("org_A") == {}
        # Negative-cached: the failure is not retried within the TTL.
        monkeypatch.setattr(M, "_fetch_org_overrides", lambda org: pytest.fail("negative cache must hold"))
        assert M.resolve_org_model_overrides("org_A") == {}

    def test_fetch_sanitizes_payload(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        class FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {"overrides": {"deep_research": "x-ai/grok-4.5", "bogus_group": "x/y", "intent": "bad id!!"}}

        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        monkeypatch.setattr("httpx.get", lambda *a, **k: FakeResponse())
        assert M._fetch_org_overrides("org_A") == {"deep_research": "x-ai/grok-4.5"}

    def test_no_internal_token_returns_empty(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        assert M._fetch_org_overrides("org_A") == {}
