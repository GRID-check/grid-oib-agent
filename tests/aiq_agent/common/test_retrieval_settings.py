"""Tests for the platform-tunable retrieval settings resolver."""

import httpx
import pytest

from aiq_agent.common import retrieval_settings
from aiq_agent.common.retrieval_settings import get_retrieval_setting
from aiq_agent.common.retrieval_settings import reset_retrieval_settings_cache
from aiq_agent.common.retrieval_settings import sanitize_retrieval_settings


@pytest.fixture(autouse=True)
def _clean_cache(monkeypatch):
    reset_retrieval_settings_cache()
    monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
    monkeypatch.delenv("FRONTEND_INTERNAL_URL", raising=False)
    yield
    reset_retrieval_settings_cache()


def _mock_bff(monkeypatch, payload: object = None, error: Exception | None = None) -> int:
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
    def test_round_trip_known_keys(self):
        raw = {"knowledge.top_k": 12, "ris.page_size": 50, "surface.max_files": 5}
        assert sanitize_retrieval_settings(raw) == raw

    def test_non_object_fails_open(self):
        assert sanitize_retrieval_settings([1, 2]) == {}
        assert sanitize_retrieval_settings("nope") == {}
        assert sanitize_retrieval_settings(None) == {}

    def test_unknown_keys_dropped(self):
        assert sanitize_retrieval_settings({"knowledge.top_k": 8, "nonsense.key": 3}) == {"knowledge.top_k": 8}

    def test_non_integers_dropped(self):
        raw = {"knowledge.top_k": "8", "web.max_results": True, "ris.max_results": 4}
        assert sanitize_retrieval_settings(raw) == {"ris.max_results": 4}

    def test_out_of_bounds_dropped(self):
        raw = {"knowledge.top_k": 0, "surface.chunk_top_k": 500, "ris.max_results": 25}
        assert sanitize_retrieval_settings(raw) == {"ris.max_results": 25}

    def test_page_size_discrete_set_enforced(self):
        assert sanitize_retrieval_settings({"ris.page_size": 30}) == {}
        assert sanitize_retrieval_settings({"ris.page_size": 100}) == {"ris.page_size": 100}


class TestResolution:
    def test_no_token_fails_open_to_fallback(self, monkeypatch):
        assert get_retrieval_setting("knowledge.top_k", 8) == 8

    def test_admin_value_wins(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"settings": {"knowledge.top_k": 20}})
        assert get_retrieval_setting("knowledge.top_k", 8) == 20

    def test_unset_key_uses_fallback(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"settings": {"web.max_results": 7}})
        assert get_retrieval_setting("knowledge.top_k", 8) == 8
        assert get_retrieval_setting("web.max_results", 5) == 7

    def test_http_error_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, error=httpx.ConnectError("down"))
        assert get_retrieval_setting("knowledge.top_k", 8) == 8

    def test_malformed_payload_fails_open(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, ["not", "a", "dict"])
        assert get_retrieval_setting("knowledge.top_k", 8) == 8

    def test_out_of_bounds_row_never_reaches_caller(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        _mock_bff(monkeypatch, {"settings": {"knowledge.top_k": 9999}})
        assert get_retrieval_setting("knowledge.top_k", 8) == 8

    def test_cache_avoids_repeat_fetch(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"settings": {"knowledge.top_k": 20}})
        assert get_retrieval_setting("knowledge.top_k", 8) == 20
        assert get_retrieval_setting("knowledge.top_k", 8) == 20
        assert calls["n"] == 1

    def test_negative_result_cached_briefly(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"settings": {}})
        assert get_retrieval_setting("knowledge.top_k", 8) == 8
        assert get_retrieval_setting("knowledge.top_k", 8) == 8
        assert calls["n"] == 1

    def test_unknown_key_uses_fallback_without_fetch(self, monkeypatch):
        calls = _mock_bff(monkeypatch, {"settings": {}})
        assert get_retrieval_setting("made.up.key", 3) == 3
        assert calls["n"] == 0

    def test_reset_cache_refetches(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        calls = _mock_bff(monkeypatch, {"settings": {"knowledge.top_k": 20}})
        assert get_retrieval_setting("knowledge.top_k", 8) == 20
        reset_retrieval_settings_cache()
        assert get_retrieval_setting("knowledge.top_k", 8) == 20
        assert calls["n"] == 2

    def test_frontend_internal_url_respected(self, monkeypatch):
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "tok")
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff:3000/")
        seen = {}

        class FakeResponse:
            def raise_for_status(self) -> None:
                return None

            def json(self) -> object:
                return {"settings": {}}

        def fake_get(url, **kwargs):
            seen["url"] = url
            seen["token"] = kwargs["headers"]["x-grid-internal-token"]
            return FakeResponse()

        monkeypatch.setattr(httpx, "get", fake_get)
        get_retrieval_setting("knowledge.top_k", 8)
        assert seen["url"] == "http://bff:3000/api/internal/retrieval-settings"
        assert seen["token"] == "tok"


class TestCatalogParity:
    """The backend bounds must match the BFF catalog exactly (fixture exported
    from frontends/ui/src/lib/retrieval-settings/catalog.ts)."""

    def test_bounds_match_frontend_catalog(self):
        import json
        from pathlib import Path

        fixture = Path(__file__).parents[2] / "fixtures" / "retrieval_settings_catalog.json"
        catalog = {entry["key"]: entry for entry in json.loads(fixture.read_text(encoding="utf-8"))}
        assert set(catalog) == set(retrieval_settings._BOUNDS)
        for key, entry in catalog.items():
            assert retrieval_settings._BOUNDS[key] == (entry["min"], entry["max"]), key
            allowed = retrieval_settings._ALLOWED_VALUES.get(key)
            if "allowedValues" in entry:
                assert allowed == frozenset(entry["allowedValues"]), key
            else:
                assert allowed is None, key
