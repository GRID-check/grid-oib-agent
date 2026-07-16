"""Tests for request-context header getters in aiq_agent.project_context."""

import base64
import json
from pathlib import Path

from aiq_agent import project_context as pc

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "grid_request_context.json"

# Camel-case JSON fixture field name -> GridRequestContext attribute name.
_INPUT_FIELD_MAP = {
    "organizationId": "organization_id",
    "userId": "user_id",
    "projectId": "project_id",
    "collectionScope": "collection_scope",
    "projectContext": "project_context",
    "projectMemory": "project_memory",
    "modelOverrides": "model_overrides",
    "budget": "budget",
    "disabledSources": "disabled_sources",
    "memoryReflectionEnabled": "memory_reflection_enabled",
}


class TestMemoryReflectionFlag:
    def test_true_header_enables(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: "true")
        assert pc.get_memory_reflection_enabled_from_context() is True

    def test_case_insensitive(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: "TRUE")
        assert pc.get_memory_reflection_enabled_from_context() is True

    def test_false_header_disables(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: "false")
        assert pc.get_memory_reflection_enabled_from_context() is False

    def test_absent_header_fails_closed(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: None)
        assert pc.get_memory_reflection_enabled_from_context() is False

    def test_reads_the_expected_header(self, monkeypatch):
        # get_memory_reflection_enabled_from_context() now delegates to
        # GridRequestContext.from_context(), which reads every X-Grid-*
        # header in one pass (backlog T3-9) — so _read_header is called
        # several times per invocation, not just once. Record every name
        # seen instead of asserting on a single overwritten value.
        seen = []

        def fake(name):
            seen.append(name)
            return "true"

        monkeypatch.setattr(pc, "_read_header", fake)
        pc.get_memory_reflection_enabled_from_context()
        assert pc.MEMORY_REFLECTION_FEATURE_HEADER in seen


class TestComposeProjectContext:
    def test_combines_profile_and_memory(self):
        assert pc.compose_project_context("PROFILE", "MEMORY") == "PROFILE\n\nMEMORY"

    def test_profile_only(self):
        assert pc.compose_project_context("PROFILE", None) == "PROFILE"

    def test_memory_only(self):
        assert pc.compose_project_context(None, "MEMORY") == "MEMORY"

    def test_neither(self):
        assert pc.compose_project_context(None, None) is None


class TestGridRequestContextFromContext:
    """`GridRequestContext.from_context()` reads every X-Grid-* header from
    NAT Context metadata in one pass; drive it via the same `_read_header`
    monkeypatch seam the rest of this file uses.
    """

    def test_full_context(self, monkeypatch):
        headers = {
            pc.ORGANIZATION_ID_HEADER: "org_1",
            pc.USER_ID_HEADER: "user_1",
            pc.PROJECT_ID_HEADER: "proj_1",
            pc.COLLECTION_SCOPE_HEADER: base64.urlsafe_b64encode(
                json.dumps(["oib_knowledge", "proj_proj_1"]).encode("utf-8")
            )
            .decode("ascii")
            .rstrip("="),
            pc.PROJECT_CONTEXT_HEADER: base64.urlsafe_b64encode(b"ctx text").decode("ascii").rstrip("="),
            pc.PROJECT_MEMORY_HEADER: base64.urlsafe_b64encode(b"memory text").decode("ascii").rstrip("="),
            pc.MODEL_OVERRIDES_HEADER: base64.urlsafe_b64encode(
                json.dumps({"deep_research": "vendor/model"}).encode("utf-8")
            )
            .decode("ascii")
            .rstrip("="),
            pc.BUDGET_HEADER: base64.urlsafe_b64encode(json.dumps({"remainingOrgUsd": 1.5}).encode("utf-8"))
            .decode("ascii")
            .rstrip("="),
            pc.DISABLED_SOURCES_HEADER: base64.urlsafe_b64encode(json.dumps(["web_search"]).encode("utf-8"))
            .decode("ascii")
            .rstrip("="),
            pc.MEMORY_REFLECTION_FEATURE_HEADER: "true",
        }
        monkeypatch.setattr(pc, "_read_header", lambda name: headers.get(name))

        ctx = pc.GridRequestContext.from_context()

        assert ctx.organization_id == "org_1"
        assert ctx.user_id == "user_1"
        assert ctx.project_id == "proj_1"
        assert ctx.collection_scope == ["oib_knowledge", "proj_proj_1"]
        assert ctx.project_context == "ctx text"
        assert ctx.project_memory == "memory text"
        assert ctx.model_overrides == {"deep_research": "vendor/model"}
        assert ctx.budget == {"remainingOrgUsd": 1.5}
        assert ctx.disabled_sources == ["web_search"]
        assert ctx.memory_reflection_enabled is True

    def test_empty_context(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: None)
        assert pc.GridRequestContext.from_context() == pc.GridRequestContext()

    def test_malformed_json_headers_degrade_to_none_not_an_exception(self, monkeypatch):
        monkeypatch.setattr(pc, "_read_header", lambda name: "not-valid-base64url-json!!!")
        ctx = pc.GridRequestContext.from_context()
        assert ctx.collection_scope is None
        assert ctx.model_overrides is None
        assert ctx.budget is None
        assert ctx.disabled_sources is None

    def test_accessors_delegate_to_from_context(self, monkeypatch):
        """get_project_id_from_context / get_organization_id_from_context /
        get_memory_reflection_enabled_from_context / get_profile_context_from_context
        / get_memory_digest_from_context must all agree with the equivalent
        GridRequestContext field for the same underlying headers.
        """
        headers = {
            pc.ORGANIZATION_ID_HEADER: "org_9",
            pc.PROJECT_ID_HEADER: "proj_9",
            pc.PROJECT_CONTEXT_HEADER: base64.urlsafe_b64encode(b"profile blob").decode("ascii").rstrip("="),
            pc.PROJECT_MEMORY_HEADER: base64.urlsafe_b64encode(b"memory blob").decode("ascii").rstrip("="),
            pc.MEMORY_REFLECTION_FEATURE_HEADER: "true",
        }
        monkeypatch.setattr(pc, "_read_header", lambda name: headers.get(name))

        ctx = pc.GridRequestContext.from_context()
        assert pc.get_organization_id_from_context() == ctx.organization_id == "org_9"
        assert pc.get_project_id_from_context() == ctx.project_id == "proj_9"
        assert pc.get_profile_context_from_context() == ctx.project_context == "profile blob"
        assert pc.get_memory_digest_from_context() == ctx.project_memory == "memory blob"
        assert pc.get_memory_reflection_enabled_from_context() == ctx.memory_reflection_enabled is True
        assert pc.get_project_context_from_context() == "profile blob\n\nmemory blob"


class TestGridRequestContextContractFixture:
    """Cross-language wire contract (backlog T3-9): parsing the fixture's
    `headers` must reproduce the fixture's `input`-equivalent values. The TS
    side (`frontends/ui/src/lib/request-context.spec.ts`) asserts the
    opposite direction — building `input` reproduces `headers` — against a
    byte-identical twin at `frontends/ui/tests/fixtures/grid_request_context.json`.
    """

    @staticmethod
    def _load_fixture() -> dict:
        with FIXTURE_PATH.open(encoding="utf-8") as fh:
            return json.load(fh)

    def test_fixture_has_cases(self):
        fixture = self._load_fixture()
        assert len(fixture["cases"]) >= 2

    def test_each_case_round_trips(self):
        fixture = self._load_fixture()
        for case in fixture["cases"]:
            ctx = pc.GridRequestContext.from_headers(case["headers"])
            expected_input = case["input"]

            for json_field, attr_name in _INPUT_FIELD_MAP.items():
                expected = expected_input.get(json_field)
                actual = getattr(ctx, attr_name)
                assert actual == expected, (
                    f"case {case['name']!r}: field {json_field!r} -> expected {expected!r}, got {actual!r}"
                )
