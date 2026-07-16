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


class TestGridRequestContextEnvelopeContractFixture:
    """Cross-language wire contract for the signed envelope (T3-9 follow-up,
    2026-07-16). `envelopeCases` in the fixture carries {secret, input,
    envelopeJson, header, signature}; the TS side
    (`buildGridRequestContextEnvelope`) asserts building `input` with
    `secret` reproduces `header`/`signature`. This asserts the opposite
    direction: verifying+parsing `header`/`signature` with `secret`
    reproduces the `input`-equivalent fields.
    """

    @staticmethod
    def _load_fixture() -> dict:
        with FIXTURE_PATH.open(encoding="utf-8") as fh:
            return json.load(fh)

    def test_fixture_has_envelope_cases(self):
        fixture = self._load_fixture()
        assert len(fixture["envelopeCases"]) >= 2

    def test_each_envelope_case_round_trips(self):
        fixture = self._load_fixture()
        for case in fixture["envelopeCases"]:
            ctx = pc.GridRequestContext.from_envelope(case["header"], case["signature"], case["secret"])
            assert ctx is not None, f"case {case['name']!r}: valid signature must not be treated as absent"
            expected_input = case["input"]

            for json_field, attr_name in _INPUT_FIELD_MAP.items():
                expected = expected_input.get(json_field)
                actual = getattr(ctx, attr_name)
                assert actual == expected, (
                    f"case {case['name']!r}: field {json_field!r} -> expected {expected!r}, got {actual!r}"
                )

    def test_each_envelope_case_json_matches_decoded_header(self):
        """`envelopeJson` is documentation of the exact bytes header/signature
        were derived from — assert the header actually decodes to it, so the
        fixture cannot silently drift from its own documentation."""
        fixture = self._load_fixture()
        for case in fixture["envelopeCases"]:
            decoded = pc._base64url_decode_text(case["header"])
            assert decoded == case["envelopeJson"], f"case {case['name']!r}: header does not decode to envelopeJson"


class TestGridRequestContextFromEnvelope:
    """Unit tests for `GridRequestContext.from_envelope` — the single
    verify+parse function the enforcement middleware in
    `aiq_api.context_envelope` and `from_context`/`from_headers` (envelope
    precedence) all delegate to.
    """

    SECRET = "unit-test-secret"  # noqa: S105 - test fixture value, not a real credential

    @staticmethod
    def _sign(raw_json: str, secret: str) -> str:
        import hashlib
        import hmac

        return hmac.new(secret.encode("utf-8"), raw_json.encode("utf-8"), hashlib.sha256).hexdigest()

    def _envelope(self, payload: dict) -> tuple[str, str]:
        raw = json.dumps(payload)
        header = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
        sig = self._sign(raw, self.SECRET)
        return header, sig

    def test_none_header_is_absent(self):
        assert pc.GridRequestContext.from_envelope(None, "sig", self.SECRET) is None

    def test_empty_header_is_absent(self):
        assert pc.GridRequestContext.from_envelope("", "sig", self.SECRET) is None

    def test_valid_signature_parses_fields(self):
        header, sig = self._envelope({"organizationId": "org_1", "userId": "user_1", "memoryReflectionEnabled": True})
        ctx = pc.GridRequestContext.from_envelope(header, sig, self.SECRET)
        assert ctx is not None
        assert ctx.organization_id == "org_1"
        assert ctx.user_id == "user_1"
        assert ctx.memory_reflection_enabled is True

    def test_missing_signature_treated_as_absent_when_secret_configured(self):
        header, _sig = self._envelope({"organizationId": "org_1"})
        assert pc.GridRequestContext.from_envelope(header, None, self.SECRET) is None

    def test_tampered_signature_treated_as_absent(self):
        header, sig = self._envelope({"organizationId": "org_1"})
        tampered_sig = ("0" if sig[0] != "0" else "1") + sig[1:]
        assert pc.GridRequestContext.from_envelope(header, tampered_sig, self.SECRET) is None

    def test_wrong_secret_treated_as_absent(self):
        header, sig = self._envelope({"organizationId": "org_1"})
        assert pc.GridRequestContext.from_envelope(header, sig, "a-different-secret") is None

    def test_tamper_logs_a_warning(self, caplog):
        header, sig = self._envelope({"organizationId": "org_1"})
        tampered_sig = ("0" if sig[0] != "0" else "1") + sig[1:]
        with caplog.at_level("WARNING", logger="aiq_agent.project_context"):
            pc.GridRequestContext.from_envelope(header, tampered_sig, self.SECRET)
        assert any("signature" in record.message.lower() for record in caplog.records)

    def test_no_secret_configured_skips_signature_check_but_still_requires_header(self):
        header, _sig = self._envelope({"organizationId": "org_1"})
        # No secret (dev, GRID_INTERNAL_API_TOKEN unset) -> shape-only check;
        # signature is ignored entirely (even garbage/missing).
        ctx = pc.GridRequestContext.from_envelope(header, "garbage-signature", None)
        assert ctx is not None
        assert ctx.organization_id == "org_1"

        ctx_no_sig = pc.GridRequestContext.from_envelope(header, None, None)
        assert ctx_no_sig is not None
        assert ctx_no_sig.organization_id == "org_1"

    def test_malformed_base64_is_absent_not_an_exception(self):
        assert pc.GridRequestContext.from_envelope("not-valid-base64!!!", "sig", None) is None

    def test_non_object_json_is_absent(self):
        raw = json.dumps(["not", "an", "object"])
        header = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
        assert pc.GridRequestContext.from_envelope(header, None, None) is None

    def test_defaults_missing_fields_to_none_or_false(self):
        header, sig = self._envelope({})
        ctx = pc.GridRequestContext.from_envelope(header, sig, self.SECRET)
        assert ctx == pc.GridRequestContext()


class TestGridRequestContextEnvelopePrecedence:
    """`from_context`/`from_headers` prefer a valid envelope over the
    individual headers; an invalid envelope falls back to them.
    """

    SECRET = "precedence-secret"  # noqa: S105 - test fixture value, not a real credential

    def _envelope_headers(self, payload: dict) -> dict[str, str]:
        raw = json.dumps(payload)
        header = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
        sig = TestGridRequestContextFromEnvelope._sign(raw, self.SECRET)
        return {
            pc.REQUEST_CONTEXT_ENVELOPE_HEADER: header,
            pc.REQUEST_CONTEXT_ENVELOPE_SIG_HEADER: sig,
        }

    def test_from_context_prefers_valid_envelope_over_individual_headers(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", self.SECRET)
        envelope_headers = self._envelope_headers({"organizationId": "org_from_envelope"})
        individual_headers = {pc.ORGANIZATION_ID_HEADER: "org_from_individual_header"}
        merged = {**individual_headers, **envelope_headers}
        monkeypatch.setattr(pc, "_read_header", lambda name: merged.get(name))

        ctx = pc.GridRequestContext.from_context()
        assert ctx.organization_id == "org_from_envelope"

    def test_from_context_falls_back_to_individual_headers_when_envelope_invalid(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", self.SECRET)
        envelope_headers = self._envelope_headers({"organizationId": "org_from_envelope"})
        # Tamper the signature.
        sig = envelope_headers[pc.REQUEST_CONTEXT_ENVELOPE_SIG_HEADER]
        envelope_headers[pc.REQUEST_CONTEXT_ENVELOPE_SIG_HEADER] = ("0" if sig[0] != "0" else "1") + sig[1:]
        individual_headers = {pc.ORGANIZATION_ID_HEADER: "org_from_individual_header"}
        merged = {**individual_headers, **envelope_headers}
        monkeypatch.setattr(pc, "_read_header", lambda name: merged.get(name))

        ctx = pc.GridRequestContext.from_context()
        assert ctx.organization_id == "org_from_individual_header"

    def test_from_headers_prefers_valid_envelope(self):
        envelope_headers = self._envelope_headers({"organizationId": "org_from_envelope"})
        headers = {pc.ORGANIZATION_ID_HEADER: "org_from_individual_header", **envelope_headers}

        ctx = pc.GridRequestContext.from_headers(headers, secret=self.SECRET)
        assert ctx.organization_id == "org_from_envelope"

    def test_from_headers_without_secret_ignores_signature_and_still_prefers_envelope(self):
        envelope_headers = self._envelope_headers({"organizationId": "org_from_envelope"})
        headers = {pc.ORGANIZATION_ID_HEADER: "org_from_individual_header", **envelope_headers}

        ctx = pc.GridRequestContext.from_headers(headers)
        assert ctx.organization_id == "org_from_envelope"
