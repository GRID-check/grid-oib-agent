"""Tests for the platform-lessons digest resolver."""

import httpx
import pytest

from aiq_agent.common.platform_lessons import get_platform_lessons_digest
from aiq_agent.common.platform_lessons import reset_platform_lessons_cache
from aiq_agent.common.platform_lessons import sanitize_lessons_digest

DIGEST = 'PLATFORM_LESSONS v1\n- [wrong_source | 3x] "Vor dem Zitieren die Richtlinie prüfen."'


@pytest.fixture(autouse=True)
def _clean_cache(monkeypatch):
    reset_platform_lessons_cache()
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
    yield
    reset_platform_lessons_cache()


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
        calls["url"] = url
        calls["token"] = kwargs.get("headers", {}).get("x-grid-internal-token")
        if error is not None:
            raise error
        return FakeResponse(payload)

    monkeypatch.setattr(httpx, "get", fake_get)
    return calls


class TestSanitize:
    def test_well_formed_digest_passes(self):
        assert sanitize_lessons_digest(DIGEST) == DIGEST

    def test_non_string_rejected(self):
        assert sanitize_lessons_digest(None) is None
        assert sanitize_lessons_digest(["x"]) is None
        assert sanitize_lessons_digest(42) is None

    def test_missing_header_rejected(self):
        # A payload that does not open with the versioned header is not a
        # digest this module produced — never inject arbitrary text.
        assert sanitize_lessons_digest('- [x | 1x] "no header"') is None
        assert sanitize_lessons_digest("") is None
        assert sanitize_lessons_digest("   ") is None

    def test_oversized_digest_clipped(self):
        oversized = "PLATFORM_LESSONS v1\n" + ("x" * 10_000)
        result = sanitize_lessons_digest(oversized)
        assert result is not None
        assert len(result) <= 2400


class TestResolution:
    def test_no_token_yields_none_without_fetch(self, monkeypatch):
        calls = _mock_bff(monkeypatch, {"digest": DIGEST})
        assert get_platform_lessons_digest() is None
        assert calls["n"] == 0

    def test_digest_resolves(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": DIGEST})
        assert get_platform_lessons_digest() == DIGEST

    def test_null_digest_resolves_to_none(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"digest": None})
        assert get_platform_lessons_digest() is None

    def test_http_error_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, error=httpx.ConnectError("down"))
        assert get_platform_lessons_digest() is None

    def test_malformed_payload_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, ["not", "a", "dict"])
        assert get_platform_lessons_digest() is None

    def test_cache_avoids_repeat_fetch(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"digest": DIGEST})
        assert get_platform_lessons_digest() == DIGEST
        assert get_platform_lessons_digest() == DIGEST
        assert calls["n"] == 1

    def test_negative_result_cached(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"digest": None})
        assert get_platform_lessons_digest() is None
        assert get_platform_lessons_digest() is None
        assert calls["n"] == 1

    def test_frontend_internal_url_and_token_respected(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff:3000/")
        calls = _mock_bff(monkeypatch, {"digest": None})
        get_platform_lessons_digest()
        assert calls["url"] == "http://bff:3000/api/internal/platform-lessons/digest"
        assert calls["token"] == "tok"
