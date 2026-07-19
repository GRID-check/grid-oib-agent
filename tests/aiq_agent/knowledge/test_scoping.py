"""Tests for the collection-scope helper (scoping.py)."""

import base64
import json
from unittest.mock import MagicMock
from unittest.mock import patch

from aiq_agent.knowledge.scoping import _base64url_decode
from aiq_agent.knowledge.scoping import get_collection_scope_from_context


class TestBase64UrlDecode:
    """Tests for the _base64url_decode helper."""

    def test_standard_padded(self):
        assert _base64url_decode("SGVsbG8=") == b"Hello"

    def test_missing_padding(self):
        assert _base64url_decode("SGVsbG8") == b"Hello"

    def test_urlsafe_chars(self):
        # base64url uses - instead of +, _ instead of /
        encoded = base64.urlsafe_b64encode(b"\xfb\xff\xff\xff").decode().rstrip("=")
        assert "+" not in encoded and "/" not in encoded
        assert _base64url_decode(encoded) == b"\xfb\xff\xff\xff"

    def test_empty_string(self):
        assert _base64url_decode("") == b""

    def test_double_padding(self):
        val = base64.urlsafe_b64encode(b"ab").decode()
        assert _base64url_decode(val) == b"ab"


class _MockContext:
    """Minimal Context mock that returns a given header value."""

    def __init__(self, header_value: str | None):
        self.metadata = MagicMock()
        self.metadata.headers.get.return_value = header_value


class TestGetCollectionScopeFromContext:
    """Tests for get_collection_scope_from_context."""

    def test_valid_header(self):
        scope = ["oib_knowledge", "proj_test", "s_conv123"]
        encoded = base64.urlsafe_b64encode(json.dumps(scope).encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result == scope

    def test_missing_header(self):
        ctx = _MockContext(None)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result is None

    def test_context_get_returns_none(self):
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=None):
            result = get_collection_scope_from_context()
            assert result is None

    def test_context_metadata_none(self):
        ctx = MagicMock()
        ctx.metadata = None
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result is None

    def test_context_get_raises(self):
        with patch("aiq_agent.knowledge.scoping.Context.get", side_effect=RuntimeError("boom")):
            result = get_collection_scope_from_context()
            assert result is None

    def test_malformed_base64(self):
        ctx = _MockContext("!!!not-valid-base64!!!")
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result is None

    def test_malformed_json(self):
        encoded = base64.urlsafe_b64encode(b"not json").decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result is None

    def test_non_list_json(self):
        encoded = base64.urlsafe_b64encode(json.dumps({"key": "value"}).encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result is None

    def test_json_string_not_list(self):
        encoded = base64.urlsafe_b64encode(json.dumps("just a string").encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result is None

    def test_json_list_with_non_strings(self):
        encoded = base64.urlsafe_b64encode(json.dumps(["good", 42, "also good"]).encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result is None

    def test_duplicates_preserve_order(self):
        scope = ["oib_knowledge", "proj_x", "oib_knowledge", "s_conv1", "proj_x"]
        encoded = base64.urlsafe_b64encode(json.dumps(scope).encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result == ["oib_knowledge", "proj_x", "s_conv1"]

    def test_double_prefixed_session_collection_is_normalized(self):
        scope = ["oib_knowledge", "proj_x", "s_s_conv1"]
        encoded = base64.urlsafe_b64encode(json.dumps(scope).encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result == ["oib_knowledge", "proj_x", "s_conv1"]

    def test_empty_list(self):
        encoded = base64.urlsafe_b64encode(json.dumps([]).encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result == []

    def test_single_item(self):
        encoded = base64.urlsafe_b64encode(json.dumps(["only_one"]).encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()
            assert result == ["only_one"]


class _HeaderContext:
    """Context mock backed by a real per-name header map."""

    def __init__(self, headers: dict[str, str]):
        self.metadata = MagicMock()
        self.metadata.headers.get.side_effect = lambda name, default=None: headers.get(name, default)


class TestSignedEnvelopePrecedence:
    """Collection scope is an authz boundary: the signed request-context
    envelope must win over the raw X-Grid-Collection-Scope header, so a forged
    header cannot widen a turn's collection access (cross-tenant/cross-conv IDOR).
    """

    @staticmethod
    def _envelope(scope, secret):
        import hashlib
        import hmac

        json_text = json.dumps({"collectionScope": scope})
        header = base64.urlsafe_b64encode(json_text.encode()).decode()
        sig = hmac.new(secret.encode(), json_text.encode(), hashlib.sha256).hexdigest()
        return header, sig

    def test_signed_envelope_scope_wins_over_forged_raw_header(self, monkeypatch):
        secret = "unit-test-internal-token"
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", secret)

        trusted = ["oib_knowledge", "s_my_conversation"]
        envelope, sig = self._envelope(trusted, secret)

        forged = ["s_victim_conversation", "another_tenant_corpus"]
        forged_header = base64.urlsafe_b64encode(json.dumps(forged).encode()).decode()

        ctx = _HeaderContext(
            {
                "x-grid-request-context": envelope,
                "x-grid-request-context-sig": sig,
                "x-grid-collection-scope": forged_header,
            }
        )
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()

        assert result == trusted
        assert "s_victim_conversation" not in result
        assert "another_tenant_corpus" not in result

    def test_tampered_envelope_signature_is_not_honored(self, monkeypatch):
        secret = "unit-test-internal-token"
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", secret)

        privileged = ["another_tenant_corpus"]
        envelope, _good_sig = self._envelope(privileged, secret)

        # Envelope present but signed with the wrong key → treated as ABSENT.
        # With no raw header either, no scope is honored (safe default).
        ctx = _HeaderContext(
            {
                "x-grid-request-context": envelope,
                "x-grid-request-context-sig": "deadbeef" * 8,
            }
        )
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()

        assert result is None

    def test_raw_header_honored_when_no_envelope(self, monkeypatch):
        # Anonymous / internal-service / legacy path: no envelope present, so the
        # raw header is still used (parity with pre-envelope behavior).
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        scope = ["oib_knowledge", "s_conv"]
        header = base64.urlsafe_b64encode(json.dumps(scope).encode()).decode()
        ctx = _HeaderContext({"x-grid-collection-scope": header})
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context()

        assert result == scope


class TestGetCollectionScopeFromContextOr:
    """Tests for get_collection_scope_from_context_or."""

    def test_context_scope_takes_precedence(self):
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context_or

        scope = ["oib_knowledge", "proj_test"]
        encoded = base64.urlsafe_b64encode(json.dumps(scope).encode()).decode()
        ctx = _MockContext(encoded)
        with patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx):
            result = get_collection_scope_from_context_or(None, None)
            assert result == scope

    def test_context_empty_list_falls_back(self):
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context_or

        encoded = base64.urlsafe_b64encode(json.dumps([]).encode()).decode()
        ctx = _MockContext(encoded)

        mock_config = MagicMock()
        mock_config.use_fixed_collection = False
        mock_config.collection_name = "oib_knowledge"
        mock_config.include_base_collection = True
        mock_config.include_session_collection = False
        mock_config.project_collections = []

        with (
            patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx),
            patch(
                "knowledge_layer.register._resolve_target_collections",
                return_value=["oib_knowledge"],
            ),
        ):
            result = get_collection_scope_from_context_or(mock_config, None)
            assert result == ["oib_knowledge"]

    def test_missing_header_falls_back(self):
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context_or

        ctx = _MockContext(None)

        mock_config = MagicMock()
        mock_config.use_fixed_collection = False
        mock_config.collection_name = "oib_knowledge"
        mock_config.include_base_collection = True
        mock_config.include_session_collection = True
        mock_config.project_collections = ["proj_extra"]

        with (
            patch("aiq_agent.knowledge.scoping.Context.get", return_value=ctx),
            patch(
                "knowledge_layer.register._resolve_target_collections",
                return_value=["oib_knowledge", "s_abc", "proj_extra"],
            ),
        ):
            result = get_collection_scope_from_context_or(mock_config, "s_abc")
            assert result == ["oib_knowledge", "s_abc", "proj_extra"]
