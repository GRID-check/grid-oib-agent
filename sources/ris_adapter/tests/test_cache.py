"""Unit tests for the RIS shared-cache facade (keys + TTL parsing)."""

from __future__ import annotations

import pytest
from ris_adapter.cache import doc_cache_key
from ris_adapter.cache import ingested_marker_key
from ris_adapter.cache import ris_cache_ttl_seconds
from ris_adapter.cache import search_cache_key

_DAY = 24 * 60 * 60


class TestTtl:
    def test_default_seven_days(self, monkeypatch):
        monkeypatch.delenv("GRID_RIS_CACHE_TTL_DAYS", raising=False)
        assert ris_cache_ttl_seconds() == 7 * _DAY

    def test_custom_days(self, monkeypatch):
        monkeypatch.setenv("GRID_RIS_CACHE_TTL_DAYS", "3")
        assert ris_cache_ttl_seconds() == 3 * _DAY

    @pytest.mark.parametrize("bad", ["0", "-1", "abc", "", "  ", "${GRID_RIS_CACHE_TTL_DAYS}"])
    def test_invalid_falls_back_to_default(self, monkeypatch, bad):
        monkeypatch.setenv("GRID_RIS_CACHE_TTL_DAYS", bad)
        assert ris_cache_ttl_seconds() == 7 * _DAY


class TestKeys:
    def test_doc_key_stable_and_url_scoped(self):
        assert doc_cache_key("https://x").startswith("ris:doc:")
        assert doc_cache_key("https://x") == doc_cache_key("https://x")
        assert doc_cache_key("https://x") != doc_cache_key("https://y")

    def test_the_doc_key_moves_with_the_text_conversion(self):
        # The cache holds converted text for a week. If this fails you changed
        # what html_to_text keeps: bump DOC_TEXT_VERSION, then update both
        # values here, or cached laws keep the old text until they expire.
        from ris_adapter.cache import DOC_TEXT_VERSION
        from ris_adapter.client import html_to_text

        markup = (
            "<html><head><title>T</title><script>x</script></head><body><div id='nav'>Nav</div>"
            "<div id='content'><span aria-hidden='true'>a)</span><span class='sr-only'>Litera a</span>"
            "<p>§ 63.</p><p>(1)\xa0 Text  hier</p></div></body></html>"
        )
        assert (DOC_TEXT_VERSION, html_to_text(markup)) == (2, ("T", "a)\n§ 63.\n(1) Text hier"))

    def test_search_key_prefixed_and_input_scoped(self):
        assert search_cache_key("a|b").startswith("ris:search:")
        assert search_cache_key("a|b") != search_cache_key("a|c")

    def test_ingested_marker_scoped_by_collection_and_url(self):
        assert ingested_marker_key("s_1", "https://x") != ingested_marker_key("s_2", "https://x")
        assert ingested_marker_key("s_1", "https://x") != ingested_marker_key("s_1", "https://y")
        assert ingested_marker_key("s_1", "https://x").startswith("ris:ingested:s_1:")
