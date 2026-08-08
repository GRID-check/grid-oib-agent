"""Tests for the platform-tunable reasoning effort ("thinking level") resolver.

The property that matters most here is the distinction between "the platform
owner has not pinned this group" and "the platform owner pinned it to `none`":
the first must leave the role's configured effort alone, the second must
actively disable reasoning. A resolver that conflates them silently re-tunes
every role the owner never touched.
"""

import httpx
import pytest

from aiq_agent.common import reasoning_settings
from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.common.model_overrides import apply_model_override
from aiq_agent.common.model_overrides import override_reasoning_effort
from aiq_agent.common.reasoning_settings import get_reasoning_effort
from aiq_agent.common.reasoning_settings import reset_reasoning_settings_cache
from aiq_agent.common.reasoning_settings import sanitize_reasoning_efforts


@pytest.fixture(autouse=True)
def _clean_cache(monkeypatch):
    reset_reasoning_settings_cache()
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
    yield
    reset_reasoning_settings_cache()


def _mock_bff(monkeypatch, payload: object = None, error: Exception | None = None) -> dict:
    """Patch httpx.get; returns a call counter."""
    calls = {"n": 0}

    class FakeResponse:
        def __init__(self, body: object) -> None:
            self._body = body

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return self._body

    def fake_get(url, **kwargs):
        calls["n"] += 1
        if error is not None:
            raise error
        return FakeResponse(payload)

    monkeypatch.setattr(httpx, "get", fake_get)
    return calls


class TestSanitize:
    def test_round_trip_known_groups(self):
        raw = {"intent": "none", "deep_research": "medium", "clarifier": "xhigh"}
        assert sanitize_reasoning_efforts(raw) == raw

    def test_non_object_fails_open(self):
        assert sanitize_reasoning_efforts([1, 2]) == {}
        assert sanitize_reasoning_efforts("nope") == {}
        assert sanitize_reasoning_efforts(None) == {}

    def test_unknown_groups_dropped(self):
        assert sanitize_reasoning_efforts({"intent": "low", "nonsense": "low"}) == {"intent": "low"}

    def test_unknown_levels_dropped(self):
        # "max" is DeepSeek's provider-native tier name. OpenRouter rejects it,
        # so it must never survive into a request even from a hand-edited row.
        raw = {"intent": "max", "deep_research": "ludicrous", "clarifier": "high"}
        assert sanitize_reasoning_efforts(raw) == {"clarifier": "high"}

    def test_non_strings_dropped(self):
        assert sanitize_reasoning_efforts({"intent": 3, "clarifier": None, "deep_research": "low"}) == {
            "deep_research": "low"
        }


class TestResolution:
    def test_no_token_means_no_network_call(self, monkeypatch):
        calls = _mock_bff(monkeypatch, {"efforts": {"intent": "high"}})
        assert get_reasoning_effort("intent") is None
        assert calls["n"] == 0

    def test_resolves_and_caches(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"efforts": {"intent": "high", "deep_research": "low"}})

        assert get_reasoning_effort("intent") == "high"
        assert get_reasoning_effort("deep_research") == "low"
        # Second lookup is served from the TTL cache, not a second round-trip.
        assert calls["n"] == 1

    def test_unpinned_group_is_none_not_a_level(self, monkeypatch):
        """`None` means "leave the YAML value alone" and must not be confused
        with the level "none", which disables reasoning."""
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"efforts": {"intent": "none"}})

        assert get_reasoning_effort("intent") == "none"
        assert get_reasoning_effort("deep_research") is None

    def test_bff_failure_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, error=httpx.ConnectError("boom"))
        assert get_reasoning_effort("intent") is None

    def test_malformed_payload_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"efforts": "not-a-map"})
        assert get_reasoning_effort("intent") is None


class _FakeLlm:
    """Minimal pydantic-ish stand-in exposing the fields the transforms read."""

    def __init__(self, model_name: str = "vendor/model", reasoning_effort: str | None = "medium") -> None:
        self.model_name = model_name
        self.reasoning_effort = reasoning_effort

    def model_copy(self, update: dict) -> "_FakeLlm":
        clone = _FakeLlm(self.model_name, self.reasoning_effort)
        for key, value in update.items():
            setattr(clone, key, value)
        return clone


class TestOverrideReasoningEffort:
    def test_returns_a_copy_with_the_new_effort(self):
        llm = _FakeLlm(reasoning_effort="medium")
        result = override_reasoning_effort(llm, "xhigh")
        assert result is not llm
        assert result.reasoning_effort == "xhigh"
        # The shared build-time instance must never be mutated.
        assert llm.reasoning_effort == "medium"

    def test_no_op_when_already_at_that_level(self):
        llm = _FakeLlm(reasoning_effort="low")
        assert override_reasoning_effort(llm, "low") is llm

    def test_model_without_the_field_is_untouched(self):
        class NoEffort:
            model_name = "vendor/model"

        llm = NoEffort()
        assert override_reasoning_effort(llm, "high") is llm


class TestApplyModelOverride:
    def test_applies_effort_alongside_the_model(self):
        llm = _FakeLlm(model_name="vendor/old", reasoning_effort="medium")
        result = apply_model_override(
            llm,
            AgentGroup.DEEP_RESEARCH,
            overrides={"deep_research": "vendor/new"},
            zdr_only=False,
            reasoning_effort="low",
        )
        assert result.model_name == "vendor/new"
        assert result.reasoning_effort == "low"

    def test_effort_applies_even_without_a_model_override(self):
        """The two layers are independent: the platform can re-tune thinking for
        a group no org has re-modelled."""
        llm = _FakeLlm(model_name="vendor/yaml", reasoning_effort="medium")
        result = apply_model_override(llm, AgentGroup.INTENT, overrides={}, zdr_only=False, reasoning_effort="none")
        assert result.model_name == "vendor/yaml"
        assert result.reasoning_effort == "none"

    def test_unpinned_effort_leaves_the_configured_value(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"efforts": {}})
        llm = _FakeLlm(reasoning_effort="medium")

        result = apply_model_override(llm, AgentGroup.INTENT, overrides={}, zdr_only=False)

        assert result.reasoning_effort == "medium"

    def test_resolves_from_the_platform_when_not_passed(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"efforts": {"intent": "xhigh"}})
        llm = _FakeLlm(reasoning_effort="none")

        result = apply_model_override(llm, AgentGroup.INTENT, overrides={}, zdr_only=False)

        assert result.reasoning_effort == "xhigh"


class TestCatalogParity:
    """The backend vocabulary must match the BFF catalog exactly (fixture
    exported from frontends/ui/src/lib/reasoning-settings/catalog.ts)."""

    def test_efforts_match_frontend_catalog(self):
        import json
        from pathlib import Path

        fixture = Path(__file__).parents[2] / "fixtures" / "reasoning_efforts_catalog.json"
        catalog = json.loads(fixture.read_text(encoding="utf-8"))
        assert frozenset(catalog) == reasoning_settings._EFFORTS
