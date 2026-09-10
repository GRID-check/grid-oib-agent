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
        raw = _encode({"nonsense_group": "vendor/model", "shallow_research": "vendor/model"})
        assert parse_model_overrides(raw) == {"shallow_research": "vendor/model"}

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
        raw = _encode({"shallow_research": "gpt-4o", "clarifier": "ft:gpt-4o:acme::abc", "deep_research": "a/b/c"})
        assert parse_model_overrides(raw) == {"shallow_research": "gpt-4o", "clarifier": "ft:gpt-4o:acme::abc"}

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
        result = apply_model_override(llm, AgentGroup.RESEARCH, {"shallow_research": "vendor/other"})
        assert result.model_name == "vendor/other"

    def test_apply_without_matching_override_is_identity(self):
        llm = FakeChatModel()
        assert apply_model_override(llm, AgentGroup.RESEARCH, {"clarifier": "vendor/other"}) is llm

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


class FakeOpenRouterModel(BaseModel):
    """Pydantic stand-in for a ChatOpenAI pointed at OpenRouter (has extra_body)."""

    model_name: str = "deepseek/deepseek-v4-flash"
    openai_api_base: str = "https://openrouter.ai/api/v1"
    extra_body: dict = {}


class FakeNonOpenRouterModel(BaseModel):
    """Pydantic stand-in for a non-OpenRouter (e.g. NVIDIA-hosted) chat model."""

    model_name: str = "meta/llama-3.1"
    openai_api_base: str = "https://llm.example.test/v1"
    extra_body: dict = {}


class TestMergeZdrExtraBody:
    def test_sets_provider_zdr_and_data_collection(self):
        from aiq_agent.common.model_overrides import _merge_zdr_extra_body

        merged = _merge_zdr_extra_body(None)
        assert merged == {"provider": {"zdr": True, "data_collection": "deny"}}

    def test_preserves_other_provider_and_plugins(self):
        from aiq_agent.common.model_overrides import _merge_zdr_extra_body

        merged = _merge_zdr_extra_body({"plugins": [{"id": "response-healing"}], "provider": {"order": ["a"]}})
        assert merged["plugins"] == [{"id": "response-healing"}]
        assert merged["provider"] == {"order": ["a"], "zdr": True, "data_collection": "deny"}


class TestApplyZdrRouting:
    def test_copies_openrouter_model_with_zdr(self):
        from aiq_agent.common.model_overrides import apply_zdr_routing

        llm = FakeOpenRouterModel(extra_body={"plugins": [{"id": "response-healing"}]})
        result = apply_zdr_routing(llm)
        assert result is not llm
        assert result.extra_body["provider"] == {"zdr": True, "data_collection": "deny"}
        assert result.extra_body["plugins"] == [{"id": "response-healing"}]
        # Original untouched — the policy is request-scoped.
        assert "provider" not in llm.extra_body

    def test_non_openrouter_model_unchanged(self):
        from aiq_agent.common.model_overrides import apply_zdr_routing

        llm = FakeNonOpenRouterModel()
        assert apply_zdr_routing(llm) is llm

    def test_idempotent_when_already_zdr(self):
        from aiq_agent.common.model_overrides import apply_zdr_routing

        llm = FakeOpenRouterModel(extra_body={"provider": {"zdr": True, "data_collection": "deny"}})
        assert apply_zdr_routing(llm) is llm

    def test_unrecognized_object_returned_unchanged(self):
        from aiq_agent.common.model_overrides import apply_zdr_routing

        sentinel = object()
        assert apply_zdr_routing(sentinel) is sentinel

    def test_apply_model_override_applies_zdr_without_model_change(self):
        llm = FakeOpenRouterModel()
        # No model override for this group, but ZDR is on -> still a ZDR copy.
        result = apply_model_override(llm, AgentGroup.RESEARCH, {}, zdr_only=True)
        assert result is not llm
        assert result.model_name == "deepseek/deepseek-v4-flash"
        assert result.extra_body["provider"]["zdr"] is True

    def test_apply_model_override_applies_both_model_and_zdr(self):
        llm = FakeOpenRouterModel()
        result = apply_model_override(llm, AgentGroup.RESEARCH, {"shallow_research": "x-ai/grok-4.5"}, zdr_only=True)
        assert result.model_name == "x-ai/grok-4.5"
        assert result.extra_body["provider"]["zdr"] is True

    def test_apply_model_override_zdr_off_is_identity(self):
        llm = FakeOpenRouterModel()
        assert apply_model_override(llm, AgentGroup.RESEARCH, {}, zdr_only=False) is llm


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
        assert provider.with_model_overrides({"shallow_research": "vendor/x"}) is provider

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

        encoded = base64.urlsafe_b64encode(json.dumps({"shallow_research": "vendor/x"}).encode()).decode()
        monkeypatch.setattr("aiq_agent.project_context._read_header", lambda name: encoded)
        monkeypatch.setattr(M, "_fetch_org_config", lambda org: pytest.fail("must not fetch when header present"))

        assert M.get_model_overrides_from_context() == {"shallow_research": "vendor/x"}

    def test_absent_header_falls_back_to_org_resolution(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        monkeypatch.setattr("aiq_agent.project_context._read_header", lambda name: None)
        monkeypatch.setattr("aiq_agent.project_context.get_organization_id_from_context", lambda: "org_ABC123")
        monkeypatch.setattr(M, "_fetch_org_config", lambda org: ({"deep_research": "x-ai/grok-4.5"}, False))

        assert M.get_model_overrides_from_context() == {"deep_research": "x-ai/grok-4.5"}

    def test_no_org_in_context_returns_empty_without_fetch(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        monkeypatch.setattr("aiq_agent.project_context._read_header", lambda name: None)
        monkeypatch.setattr("aiq_agent.project_context.get_organization_id_from_context", lambda: None)
        monkeypatch.setattr(M, "_fetch_org_config", lambda org: pytest.fail("must not fetch without an org"))

        assert M.get_model_overrides_from_context() == {}

    def test_resolution_is_cached(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        calls = []

        def fake_fetch(org):
            calls.append(org)
            return {"shallow_research": "vendor/x"}, True

        monkeypatch.setattr(M, "_fetch_org_config", fake_fetch)
        # A single fetch populates BOTH the overrides and the ZDR flag.
        assert M.resolve_org_model_overrides("org_A") == {"shallow_research": "vendor/x"}
        assert M.resolve_org_zdr_only("org_A") is True
        assert M.resolve_org_model_overrides("org_A") == {"shallow_research": "vendor/x"}
        assert calls == ["org_A"]

    def test_fetch_failure_fails_open_to_empty(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        def boom(org):
            raise RuntimeError("bff down")

        monkeypatch.setattr(M, "_fetch_org_config", boom)
        assert M.resolve_org_model_overrides("org_A") == {}
        assert M.resolve_org_zdr_only("org_A") is False
        # Negative-cached: the failure is not retried within the TTL.
        monkeypatch.setattr(M, "_fetch_org_config", lambda org: pytest.fail("negative cache must hold"))
        assert M.resolve_org_model_overrides("org_A") == {}

    def test_fetch_sanitizes_payload_and_reads_zdr(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        class FakeResponse:
            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "overrides": {
                        "deep_research": "x-ai/grok-4.5",
                        "bogus_group": "x/y",
                        "shallow_research": "bad id!!",
                    },
                    "zdrOnly": True,
                }

        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "t")
        monkeypatch.setattr("httpx.get", lambda *a, **k: FakeResponse())
        assert M._fetch_org_config("org_A") == ({"deep_research": "x-ai/grok-4.5"}, True)

    def test_no_internal_token_returns_empty(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        assert M._fetch_org_config("org_A") == ({}, False)

    def test_zdr_only_resolves_via_org_id(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        monkeypatch.setattr("aiq_agent.project_context.get_organization_id_from_context", lambda: "org_ZDR")
        monkeypatch.setattr(M, "_fetch_org_config", lambda org: ({}, True))
        assert M.get_zdr_only_from_context() is True

    def test_zdr_only_defaults_false_without_org(self, monkeypatch):
        import aiq_agent.common.model_overrides as M

        monkeypatch.setattr("aiq_agent.project_context.get_organization_id_from_context", lambda: None)
        assert M.get_zdr_only_from_context() is False


class TestCacheTtlConstants:
    """The propagation bounds docs/architecture/org-model-configuration.md promises."""

    def test_ttls(self):
        from aiq_agent.common import model_overrides as M

        assert M._POSITIVE_TTL_SECONDS == 10
        assert M._NEGATIVE_TTL_SECONDS == 1
        assert M._SHARED_TTL_SECONDS == 60


class TestSharedTier:
    """The org's config lives in the shared cache between replicas, and the BFF's
    deletion of that key is what an admin save propagates through."""

    @pytest.fixture(autouse=True)
    def _fresh(self):
        from aiq_agent.common import cache
        from aiq_agent.common.model_overrides import reset_overrides_cache

        cache.reset_local_store()
        reset_overrides_cache()
        yield
        cache.reset_local_store()
        reset_overrides_cache()

    def test_a_fresh_process_reads_the_shared_copy_instead_of_fetching(self, monkeypatch):
        from aiq_agent.common import model_overrides as M

        fetches = []

        def fake_fetch(org):
            fetches.append(org)
            return {"deep_research": "x-ai/grok-4.5"}, True

        monkeypatch.setattr(M, "_fetch_org_config", fake_fetch)
        first = M._resolve_org_config("org_1")
        # Another replica: no in-process memo, the shared tier still holds it.
        M.reset_overrides_cache()
        second = M._resolve_org_config("org_1")

        assert fetches == ["org_1"]
        assert second.overrides == first.overrides == {"deep_research": "x-ai/grok-4.5"}
        assert second.zdr_only is True

    def test_the_bff_deleting_the_key_forces_a_refetch(self, monkeypatch):
        from aiq_agent.common import cache
        from aiq_agent.common import model_overrides as M

        answers = iter([({"deep_research": "old/model"}, False), ({"deep_research": "new/model"}, False)])
        monkeypatch.setattr(M, "_fetch_org_config", lambda org: next(answers))
        assert M._resolve_org_config("org_1").overrides == {"deep_research": "old/model"}

        # What `invalidateBackendModelConfig` does on the BFF after a save.
        cache.delete(M.shared_model_config_key("org_1"))
        M.reset_overrides_cache()  # the in-process memo expiring

        assert M._resolve_org_config("org_1").overrides == {"deep_research": "new/model"}

    def test_a_failed_fetch_is_never_written_to_the_shared_tier(self, monkeypatch):
        from aiq_agent.common import cache
        from aiq_agent.common import model_overrides as M

        def boom(org):
            raise RuntimeError("bff down")

        monkeypatch.setattr(M, "_fetch_org_config", boom)
        entry = M._resolve_org_config("org_1")
        assert entry.overrides == {} and entry.zdr_only is False
        assert cache.get_json(M.shared_model_config_key("org_1")) is None

    def test_missing_token_resolution_writes_nothing_to_the_shared_tier(self, monkeypatch):
        """No GRID_INTERNAL_API_TOKEN -> ({}, False) with no L2 write, so an
        unconfigured backend cannot shadow a real config for a full TTL."""
        from aiq_agent.common import cache
        from aiq_agent.common import model_overrides as M

        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        entry = M._resolve_org_config("org_1")
        assert entry.overrides == {} and entry.zdr_only is False
        assert cache.get_json(M.shared_model_config_key("org_1")) is None

    def test_empty_success_writes_L1_only(self, monkeypatch):
        """A genuine ({}, False) answer memoises in-process (no refetch storm)
        but stays out of L2, where it would shadow a concurrent admin save."""
        from aiq_agent.common import cache
        from aiq_agent.common import model_overrides as M

        calls = []

        def empty(org):
            calls.append(org)
            return {}, False

        monkeypatch.setattr(M, "_fetch_org_config", empty)
        assert M.resolve_org_model_overrides("org_1") == {}
        assert M.resolve_org_zdr_only("org_1") is False
        assert calls == ["org_1"]
        assert cache.get_json(M.shared_model_config_key("org_1")) is None

    def test_an_authoritative_empty_config_is_cached_in_l2(self, monkeypatch):
        """An unconfigured org is the DEFAULT state, and it is a real answer.

        While only populated records reached L2, the majority case never
        populated it at all: every replica went back to the BFF every L1 TTL
        for every unconfigured org, which is exactly what L2 exists to stop.
        """
        from aiq_agent.common import cache
        from aiq_agent.common import model_overrides as M

        calls = []

        def empty(org):
            calls.append(org)
            return {}, False

        # A trust channel means `_fetch_org_config` actually ASKED the BFF, so
        # ({}, False) is the BFF's answer rather than "we never asked".
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "test-token")
        monkeypatch.setattr(M, "_fetch_org_config", empty)
        assert M.resolve_org_model_overrides("org_1") == {}
        assert cache.get_json(M.shared_model_config_key("org_1")) == {"overrides": {}, "zdr_only": False}

    def test_concurrent_turns_for_one_org_share_a_single_fetch(self, monkeypatch):
        """The ~1s negative TTL is affordable only because the fetch is coalesced.

        Without it every concurrent turn raced past the expired entry and opened
        its own request, each paying the full timeout while the BFF is down —
        the retry-thunder the negative cache exists to prevent. The fetch is
        held open here so every thread really is in flight at once; otherwise
        the first one returns, populates the tiers, and the race never happens.
        """
        import threading
        import time as stdlib_time

        from aiq_agent.common import cache
        from aiq_agent.common import model_overrides as M

        cache.reset_local_store()
        calls = []
        entered = threading.Event()
        proceed = threading.Event()

        def slow(org):
            calls.append(org)
            entered.set()
            proceed.wait(timeout=5)
            return {"deep_research": "x-ai/grok-4.5"}, False

        monkeypatch.setattr(M, "_fetch_org_config", slow)
        results = []
        threads = [
            threading.Thread(target=lambda: results.append(M.resolve_org_model_overrides("org_1"))) for _ in range(8)
        ]
        for thread in threads:
            thread.start()
        # The first fetch is now parked inside `slow`. Give the other seven time
        # to reach the resolver: they either queue on the org lock (coalesced)
        # or open their own request (thunder), and that is the whole assertion.
        assert entered.wait(timeout=5)
        stdlib_time.sleep(0.25)
        proceed.set()
        for thread in threads:
            thread.join(timeout=10)

        assert calls == ["org_1"], f"one fetch for eight concurrent turns, got {len(calls)}"
        assert all(r == {"deep_research": "x-ai/grok-4.5"} for r in results)

    def test_error_negative_cache_expires_in_about_one_second(self, monkeypatch):
        """A failed fetch fails open but retries quickly: held within the 1s
        negative TTL, retried past it — so a transient BFF outage (and its ZDR
        bit) never pins the fleet, and recovery is a second away, not ten."""
        import time as stdlib_time

        from aiq_agent.common import model_overrides as M

        now = [1000.0]
        monkeypatch.setattr(stdlib_time, "monotonic", lambda: now[0])

        calls = []

        def boom(org):
            calls.append(org)
            raise RuntimeError("bff down")

        monkeypatch.setattr(M, "_fetch_org_config", boom)
        assert M.resolve_org_model_overrides("org_1") == {}
        assert calls == ["org_1"]
        now[0] += 0.5
        assert M.resolve_org_model_overrides("org_1") == {}
        assert calls == ["org_1"]
        now[0] += 0.6
        assert M.resolve_org_model_overrides("org_1") == {}
        assert calls == ["org_1", "org_1"]

    def test_a_malformed_shared_value_is_ignored(self, monkeypatch):
        from aiq_agent.common import cache
        from aiq_agent.common import model_overrides as M

        cache.set_json(M.shared_model_config_key("org_1"), {"overrides": "nope"}, 60)
        monkeypatch.setattr(M, "_fetch_org_config", lambda org: ({"deep_research": "x-ai/grok-4.5"}, False))
        assert M._resolve_org_config("org_1").overrides == {"deep_research": "x-ai/grok-4.5"}
