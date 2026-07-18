"""Tests for citation verification module."""

import pytest

from aiq_agent.common.citation_verification import _PARSER_REGISTRY
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import _format_registry_reference
from aiq_agent.common.citation_verification import _normalize_url
from aiq_agent.common.citation_verification import _parse_citation_key
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import register_source_parser
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import source_origin_token
from aiq_agent.common.citation_verification import verify_citations


@pytest.fixture(autouse=True)
def fixture_restore_parser_registry():
    """Restore the parser registry after each test to prevent leaks."""
    original = list(_PARSER_REGISTRY)
    yield
    _PARSER_REGISTRY.clear()
    _PARSER_REGISTRY.extend(original)


# ---------------------------------------------------------------------------
# URL normalization tests
# ---------------------------------------------------------------------------


class TestNormalizeUrl:
    """Tests for URL normalization."""

    def test_lowercase_scheme_and_host(self):
        assert _normalize_url("HTTPS://Example.COM/path") == "https://example.com/path"

    def test_strip_trailing_slash(self):
        assert _normalize_url("https://example.com/path/") == "https://example.com/path"

    def test_strip_fragment(self):
        assert _normalize_url("https://example.com/page#section") == "https://example.com/page"

    def test_remove_utm_params(self):
        result = _normalize_url("https://example.com/page?utm_source=twitter&key=val")
        assert "utm_source" not in result
        assert "key=val" in result

    def test_unescape_html_entities(self):
        assert _normalize_url("https://example.com/page?a=1&amp;b=2") == "https://example.com/page?a=1&b=2"

    def test_root_path_preserved(self):
        assert _normalize_url("https://example.com") == "https://example.com/"

    def test_identical_urls_match(self):
        url1 = "https://example.com/article?id=42"
        url2 = "https://example.com/article?id=42"
        assert _normalize_url(url1) == _normalize_url(url2)


# ---------------------------------------------------------------------------
# Citation key parsing tests
# ---------------------------------------------------------------------------


class TestParseCitationKey:
    """Tests for knowledge-layer citation key parsing."""

    def test_filename_with_page(self):
        filename, page = _parse_citation_key("report.pdf, p.15")
        assert filename == "report.pdf"
        assert page == 15

    def test_filename_with_page_word(self):
        filename, page = _parse_citation_key("report.pdf, page 15")
        assert filename == "report.pdf"
        assert page == 15

    def test_filename_only(self):
        filename, page = _parse_citation_key("report.pdf")
        assert filename == "report.pdf"
        assert page is None

    def test_filename_with_spaces(self):
        filename, page = _parse_citation_key("my report.pdf, p.3")
        assert filename == "my report.pdf"
        assert page == 3


# ---------------------------------------------------------------------------
# SourceRegistry tests
# ---------------------------------------------------------------------------


class TestSourceRegistry:
    """Tests for SourceRegistry."""

    @pytest.fixture(name="registry")
    def fixture_registry(self):
        return SourceRegistry()

    def test_add_and_has_url(self, registry):
        registry.add(SourceEntry(url="https://example.com/article", source_type="tavily"))
        assert registry.has_url("https://example.com/article")

    def test_url_normalization_on_lookup(self, registry):
        registry.add(SourceEntry(url="https://Example.COM/path/"))
        assert registry.has_url("https://example.com/path")

    def test_missing_url_returns_false(self, registry):
        registry.add(SourceEntry(url="https://example.com/a"))
        assert not registry.has_url("https://example.com/b")

    def test_has_citation_key_exact(self, registry):
        registry.add(SourceEntry(citation_key="report.pdf, p.15", source_type="knowledge_layer"))
        assert registry.has_citation_key("report.pdf, p.15")

    def test_has_citation_key_fuzzy_page_format(self, registry):
        registry.add(SourceEntry(citation_key="report.pdf, p.15"))
        assert registry.has_citation_key("report.pdf, page 15")

    def test_has_citation_key_case_insensitive(self, registry):
        registry.add(SourceEntry(citation_key="Report.PDF, p.15"))
        assert registry.has_citation_key("report.pdf, p.15")

    def test_has_citation_key_no_page(self, registry):
        registry.add(SourceEntry(citation_key="report.pdf"))
        assert registry.has_citation_key("report.pdf")

    def test_has_citation_key_different_page_matches(self, registry):
        """Same file, different page — still matches (lenient)."""
        registry.add(SourceEntry(citation_key="report.pdf, p.15"))
        assert registry.has_citation_key("report.pdf, p.5")

    def test_has_citation_key_different_file_no_match(self, registry):
        registry.add(SourceEntry(citation_key="report.pdf, p.15"))
        assert not registry.has_citation_key("other.pdf, p.15")

    def test_all_sources(self, registry):
        e1 = SourceEntry(url="https://a.com")
        e2 = SourceEntry(citation_key="doc.pdf")
        registry.add(e1)
        registry.add(e2)
        assert len(registry.all_sources()) == 2

    def test_clear(self, registry):
        registry.add(SourceEntry(url="https://a.com"))
        registry.clear()
        assert not registry.has_url("https://a.com")
        assert len(registry.all_sources()) == 0

    def test_deduplicates_urls(self, registry):
        registry.add(SourceEntry(url="https://example.com/page"))
        registry.add(SourceEntry(url="https://example.com/page"))
        assert registry.has_url("https://example.com/page")
        assert len(registry.all_sources()) == 1  # deduplicated by normalized URL

    def test_deduplicates_citation_keys_by_filename(self, registry):
        registry.add(SourceEntry(citation_key="report.pdf, p.5"))
        registry.add(SourceEntry(citation_key="report.pdf, p.10"))
        # Same file, different pages — deduplicated by filename
        assert len(registry.all_sources()) == 1
        assert registry.has_citation_key("report.pdf")

    def test_different_citation_key_files_not_deduped(self, registry):
        registry.add(SourceEntry(citation_key="report.pdf, p.5"))
        registry.add(SourceEntry(citation_key="other.pdf, p.5"))
        assert len(registry.all_sources()) == 2

    def test_resolve_url_exact_match(self, registry):
        registry.add(SourceEntry(url="https://arxiv.org/abs/1706.03762"))
        assert registry.resolve_url("https://arxiv.org/abs/1706.03762") == "https://arxiv.org/abs/1706.03762"

    def test_resolve_url_truncated_path(self, registry):
        """LLM truncated the URL path — resolve to full canonical URL."""
        registry.add(SourceEntry(url="https://arxiv.org/abs/1706.03762"))
        assert registry.resolve_url("https://arxiv.org/abs/1706") == "https://arxiv.org/abs/1706.03762"

    def test_resolve_url_domain_only(self, registry):
        """LLM kept domain but dropped entire path."""
        registry.add(SourceEntry(url="https://arxiv.org/abs/1706.03762"))
        assert registry.resolve_url("https://arxiv.org") == "https://arxiv.org/abs/1706.03762"

    def test_resolve_url_no_match(self, registry):
        registry.add(SourceEntry(url="https://arxiv.org/abs/1706.03762"))
        assert registry.resolve_url("https://totally-different.com") is None

    def test_resolve_url_with_ellipsis_truncation(self, registry):
        """LLM wrote URL with trailing '...' which gets stripped."""
        registry.add(SourceEntry(url="https://example.com/very/long/path/article"))
        # After stripping "...", the truncated URL should match
        resolved = registry.resolve_url("https://example.com/very/long")
        assert resolved == "https://example.com/very/long/path/article"

    def test_resolve_url_truncated_mid_query(self, registry):
        """Report URL cut mid-query (e.g. copy-paste); match by raw prefix."""
        full = "https://example.sharepoint.com/sites/foo/_layouts/15/Doc.aspx?sourcedoc=%7BGUID%7D&file=US%20Benefits%20Open%20Enrollment.pptx&action=edit"
        registry.add(SourceEntry(url=full))
        truncated = (
            "https://example.sharepoint.com/sites/foo/_layouts/15/Doc.aspx?sourcedoc=%7BGUID%7D&file=US%20Benefit"
        )
        resolved = registry.resolve_url(truncated)
        assert resolved == full

    def test_resolve_url_ambiguous_returns_none(self, registry):
        """Shallow ambiguous prefix (e.g. arxiv abs/1706) — reject."""
        registry.add(SourceEntry(url="https://arxiv.org/abs/1706.03762"))
        registry.add(SourceEntry(url="https://arxiv.org/abs/1706.08500"))
        # path "abs/1706" has only 2 segments — too shallow to treat as parent
        assert registry.resolve_url("https://arxiv.org/abs/1706") is None

    def test_resolve_url_prefix_ambiguous_rejected(self, registry):
        """Report URL is prefix of multiple registry URLs — ambiguous, reject."""
        registry.add(SourceEntry(url="https://example.sharepoint.com/sites/hr/Pages/New-Employees.aspx"))
        registry.add(SourceEntry(url="https://example.sharepoint.com/sites/hr/Pages/ourculture.aspx"))
        assert registry.resolve_url("https://example.sharepoint.com/sites/hr/") is None

    def test_resolve_url_unique_prefix_succeeds(self, registry):
        """Single registry URL matches the prefix — unambiguous, return it."""
        registry.add(SourceEntry(url="https://arxiv.org/abs/1706.03762"))
        registry.add(SourceEntry(url="https://arxiv.org/abs/2301.00001"))
        # "https://arxiv.org/abs/1706" only matches the first
        assert registry.resolve_url("https://arxiv.org/abs/1706") == "https://arxiv.org/abs/1706.03762"

    def test_resolve_url_child_path_single_match(self, registry):
        """LLM expanded a registry URL to a subpage — child-path match."""
        registry.add(SourceEntry(url="https://www.example.com/us/benefits/"))
        resolved = registry.resolve_url("https://www.example.com/us/benefits/healthcare/")
        assert resolved == "https://www.example.com/us/benefits/"

    def test_resolve_url_child_path_requires_depth(self, registry):
        """Domain-only registry URLs (< 2 path segments) should NOT child-match."""
        registry.add(SourceEntry(url="https://example.com/"))
        assert registry.resolve_url("https://example.com/us/benefits/") is None

    def test_resolve_url_child_path_single_parent(self, registry):
        """Report URL is a child of only one registry path — match succeeds."""
        registry.add(SourceEntry(url="https://example.com/us/benefits/"))
        registry.add(SourceEntry(url="https://example.com/us/benefits/time-off/"))
        # "healthcare/" is under "benefits/" but not under "time-off/"
        # Only one match, so this should succeed
        resolved = registry.resolve_url("https://example.com/us/benefits/healthcare/")
        assert resolved == "https://example.com/us/benefits/"

    def test_resolve_url_child_path_different_domain(self, registry):
        """Child-path match requires same domain."""
        registry.add(SourceEntry(url="https://example.com/us/benefits/"))
        assert registry.resolve_url("https://other.com/us/benefits/healthcare/") is None

    def test_resolve_url_query_subset_match(self, registry):
        """LLM dropped some query params — query-subset match recovers it."""
        full_url = (
            "https://example.sharepoint.com/:p:/r/sites/benefits/_layouts/15/Doc.aspx"
            "?sourcedoc=%7BGUID-AAA%7D&file=Benefits.pptx&action=edit&mobileredirect=true"
        )
        registry.add(SourceEntry(url=full_url))
        partial_url = (
            "https://example.sharepoint.com/:p:/r/sites/benefits/_layouts/15/Doc.aspx?sourcedoc=%7BGUID-AAA%7D"
        )
        assert registry.resolve_url(partial_url) == full_url

    def test_resolve_url_query_subset_disambiguates_by_params(self, registry):
        """Multiple SharePoint docs with same path — query-subset uses params to pick the right one."""
        url_a = (
            "https://example.sharepoint.com/:p:/r/sites/benefits/_layouts/15/Doc.aspx"
            "?sourcedoc=%7BGUID-AAA%7D&file=Benefits.pptx&action=edit"
        )
        url_b = (
            "https://example.sharepoint.com/:p:/r/sites/benefits/_layouts/15/Doc.aspx"
            "?sourcedoc=%7BGUID-BBB%7D&file=HSA.pptx&action=edit"
        )
        registry.add(SourceEntry(url=url_a))
        registry.add(SourceEntry(url=url_b))
        partial = "https://example.sharepoint.com/:p:/r/sites/benefits/_layouts/15/Doc.aspx?sourcedoc=%7BGUID-BBB%7D"
        assert registry.resolve_url(partial) == url_b

    def test_resolve_url_query_subset_no_match_wrong_value(self, registry):
        """Query-subset rejects when param values differ."""
        registry.add(SourceEntry(url="https://example.com/doc?id=123&mode=view"))
        assert registry.resolve_url("https://example.com/doc?id=999") is None

    def test_resolve_url_query_subset_reordered_params(self, registry):
        """Report URL has a subset of params in different order — only Strategy 5 can match."""
        full_url = (
            "https://example.sharepoint.com/sites/hr/_layouts/15/Doc.aspx"
            "?sourcedoc=%7BGUID-X%7D&file=Handbook.pptx&action=edit&mobileredirect=true"
        )
        registry.add(SourceEntry(url=full_url))
        # Reordered param (action before sourcedoc) — not a raw prefix, so Strategy 2 won't match.
        # Normalization sorts params, so if the subset params match, Strategy 5 picks it up.
        reordered = "https://example.sharepoint.com/sites/hr/_layouts/15/Doc.aspx?action=edit&sourcedoc=%7BGUID-X%7D"
        assert registry.resolve_url(reordered) == full_url

    def test_resolve_url_no_query_params_matched_by_prefix(self, registry):
        """Dropping ALL query params is handled by prefix match (step 2), not query-subset."""
        registry.add(SourceEntry(url="https://example.com/doc?id=123&mode=view"))
        # The path-only URL is a prefix of the full normalized URL → prefix match succeeds
        assert registry.resolve_url("https://example.com/doc") == "https://example.com/doc?id=123&mode=view"


# ---------------------------------------------------------------------------
# Parser tests
# ---------------------------------------------------------------------------


class TestGenericUrlExtractor:
    """Tests for the generic URL extractor (works for all tool output formats)."""

    def test_tavily_xml_format(self):
        content = (
            '<Document href="https://example.com/article">\n'
            "<title>\nTest Article\n</title>\n"
            "Some content here.\n</Document>"
        )
        entries = extract_sources_from_tool_result("tavily_web_search", content)
        assert len(entries) == 1
        assert entries[0].url == "https://example.com/article"

    def test_multiple_urls_deduplicated(self):
        content = (
            '<Document href="https://a.com">\nContent A\n</Document>'
            "\n\n---\n\n"
            '<Document href="https://b.com">\nContent B\n</Document>'
        )
        entries = extract_sources_from_tool_result("any_tool", content)
        assert len(entries) == 2
        assert entries[0].url == "https://a.com"
        assert entries[1].url == "https://b.com"

    def test_paper_search_markdown_format(self):
        content = (
            "1. **Attention Is All You Need** (2017)\n"
            "   - **Publication**: NeurIPS\n"
            "   - **Link**: https://arxiv.org/abs/1706.03762"
        )
        entries = extract_sources_from_tool_result("paper_search_tool", content)
        assert len(entries) == 1
        assert entries[0].url == "https://arxiv.org/abs/1706.03762"

    def test_plain_text_with_urls(self):
        """Generic extractor works even for unknown tool formats."""
        content = "Check out https://example.com/page and also https://other.com/doc for details."
        entries = extract_sources_from_tool_result("totally_new_tool", content)
        assert len(entries) == 2

    def test_config_tool_names_work(self):
        """Tools named 'web_search_tool' or 'advanced_web_search_tool' work."""
        content = '<Document href="https://example.com">\nContent\n</Document>'
        for name in ["web_search_tool", "advanced_web_search_tool", "my_custom_search"]:
            entries = extract_sources_from_tool_result(name, content)
            assert len(entries) == 1, f"Failed for tool name: {name}"

    def test_no_results_status_without_source_id_is_not_citable(self):
        """No-results status text is not evidence and should not produce a source."""
        entries = extract_sources_from_tool_result("any_tool", "Search returned no results")
        assert entries == []

    def test_no_results_status_with_source_id_is_not_citable(self):
        """source_id does not make source status text citable evidence."""
        entries = extract_sources_from_tool_result(
            "duckduckgo_news_search_tool",
            "News search returned no results",
            source_id="news_search",
        )
        assert entries == []

    def test_error_status_is_not_citable(self):
        entries = extract_sources_from_tool_result(
            "duckduckgo_news_search_tool",
            "Error: News search failed",
            source_id="news_search",
        )
        assert entries == []

    def test_ris_no_result_message_is_not_citable(self):
        """The RIS adapter's no-result text must not become a [RIS] citation."""
        content = (
            "No RIS documents found for query 'Stellplatzverpflichtung' in application "
            "'LrKons'. Try different German search terms, another application (e.g. LrKons "
            "for state building law with a bundesland), or drop filters."
        )
        entries = extract_sources_from_tool_result("ris_search_tool", content, source_id="ris_search")
        assert entries == []

    def test_generic_no_results_prefixes_are_not_citable(self):
        for text in ("No documents found for this query.", "No results found."):
            entries = extract_sources_from_tool_result("some_tool", text, source_id="some")
            assert entries == []

    def test_multiline_content_leading_with_no_results_prefix_survives(self):
        """Substantive content that merely LEADS with a no-result phrase stays citable.

        The prefix match must not swallow a real result block just because it
        opens with "No results found for the exact phrase, however: ...".
        """
        content = (
            "No results found for the exact phrase, however the following related "
            "records match:\n"
            "--- Result 1 ---\n"
            "Title: Bauordnung für Wien\n"
            "Source: https://www.ris.bka.gv.at/eli/lgbl/wi/1930/11\n"
        )
        entries = extract_sources_from_tool_result("ris_search_tool", content, source_id="ris_search")
        assert len(entries) >= 1
        assert any("ris.bka.gv.at" in (e.url or "") for e in entries)

    def test_genuine_ris_result_text_is_still_citable(self):
        """A real RIS result with a citation URL must still register a source."""
        content = (
            "--- Result 1 ---\n"
            "Title: Bauordnung für Wien\n"
            "Application: LrKons\n"
            "Document number: LWI40012345\n"
            "Source: https://www.ris.bka.gv.at/eli/lgbl/wi/1930/11\n"
        )
        entries = extract_sources_from_tool_result("ris_search_tool", content, source_id="ris_search")
        assert len(entries) >= 1
        assert any("ris.bka.gv.at" in (e.url or "") for e in entries)

    def test_all_error_batch_output_is_not_citable(self):
        """A batch source-tool output whose items all errored registers nothing."""
        content = (
            "## Query: oib richtlinie 2 brandschutz\n"
            "ERROR: request timed out\n\n"
            "---\n\n"
            "## Query: oib richtlinie 6 energie\n"
            "ERROR: upstream 502"
        )
        entries = extract_sources_from_tool_result("web_search_tool", content)
        assert entries == []

    def test_all_no_results_batch_output_is_not_citable(self):
        """A batch whose items all returned no results is status output, not evidence."""
        content = (
            "## Query: first query\n"
            "Search returned no results.\n\n"
            "---\n\n"
            "## Query: second query\n"
            "Search returned no results."
        )
        entries = extract_sources_from_tool_result("web_search_tool", content)
        assert entries == []

    def test_single_all_error_batch_section_is_not_citable(self):
        """A one-item batch output that errored registers nothing."""
        content = "## Query: only query\nERROR: connection refused"
        entries = extract_sources_from_tool_result("web_search_tool", content)
        assert entries == []

    def test_mixed_batch_output_registers_only_real_sources(self):
        """Partially failed batches still register the successful items' sources."""
        content = (
            "## Query: failing query\n"
            "ERROR: request timed out\n\n"
            "---\n\n"
            "## Query: working query\n"
            "Found result at https://example.com/real-source"
        )
        entries = extract_sources_from_tool_result("web_search_tool", content)
        assert [entry.url for entry in entries] == ["https://example.com/real-source"]

    def test_mixed_batch_with_url_less_success_falls_back_to_tool_result(self):
        """A batch with at least one substantive URL-less item stays citable."""
        content = (
            "## Query: failing query\n"
            "ERROR: request timed out\n\n"
            "---\n\n"
            "## Query: working query\n"
            "OIB Richtlinie 2 regelt den Brandschutz in Bauwerken."
        )
        entries = extract_sources_from_tool_result("some_registry_tool", content)
        assert len(entries) == 1
        assert entries[0].citation_key == "some_registry_tool"
        assert entries[0].source_type == "tool_result"

    def test_duplicate_urls_deduplicated(self):
        content = "See https://example.com/page and also https://example.com/page for reference."
        entries = extract_sources_from_tool_result("any_tool", content)
        assert len(entries) == 1

    def test_multiple_urls_in_same_block_get_correct_titles(self):
        """Each URL should get the title closest to it, not the first title in the block."""
        content = (
            "1. **Spider 2.0: Enterprise Text-to-SQL** (2024)\n"
            "   - Link: https://arxiv.org/abs/2411.07763\n"
            "\n"
            "2. **Spider: A Large-Scale Dataset** (2018)\n"
            "   - Link: https://arxiv.org/abs/2308.15363"
        )
        entries = extract_sources_from_tool_result("paper_search_tool", content)
        assert len(entries) == 2
        # Each URL should have its own title, not both sharing the first title
        titles = {e.url: e.title for e in entries}
        assert titles["https://arxiv.org/abs/2411.07763"] == "Spider 2.0: Enterprise Text-to-SQL"
        assert titles["https://arxiv.org/abs/2308.15363"] == "Spider: A Large-Scale Dataset"

    def test_title_extraction_prefers_preceding_title(self):
        """Title that appears before the URL is preferred over one after."""
        content = "<title>Correct Title</title>\nhttps://example.com/page\n<title>Wrong Title</title>"
        entries = extract_sources_from_tool_result("web_search", content)
        assert len(entries) == 1
        assert entries[0].title == "Correct Title"

    def test_url_with_commas_in_path(self):
        """Commas inside URL paths (e.g., lat/lon coordinates) must not truncate the URL.

        Regression: the generic URL regex previously excluded ``,`` from the
        character class, so an FAA cam URL like
        ``https://weathercams.faa.gov/map/-122.31167,47.22287,10/...`` was
        registered as ``https://weathercams.faa.gov/map/-122.31167``. The LLM
        would then cite the full URL, the verifier would compare full vs.
        truncated, and the citation would be silently removed as
        ``url_not_in_registry``.
        """
        full_url = "https://weathercams.faa.gov/map/-122.31167,47.22287,10/airport/SEA/details/weather"
        content = f'<Document href="{full_url}">\n<title>\nFAA Cam\n</title>\nObservation.\n</Document>'
        entries = extract_sources_from_tool_result("tavily_web_search", content)
        assert len(entries) == 1
        assert entries[0].url == full_url

    def test_trailing_comma_still_trimmed(self):
        """A comma immediately followed by whitespace is still treated as
        sentence punctuation and stripped from the captured URL."""
        content = "See https://example.com/page, then continue reading."
        entries = extract_sources_from_tool_result("any_tool", content)
        assert len(entries) == 1
        assert entries[0].url == "https://example.com/page"

    def test_markdown_bracket_still_terminates(self):
        """``]`` continues to terminate a URL match so markdown links don't
        leak the closing bracket into the captured URL."""
        content = "[See here](https://example.com/page) for details."
        entries = extract_sources_from_tool_result("any_tool", content)
        assert len(entries) == 1
        assert entries[0].url == "https://example.com/page"


class TestKnowledgeLayerParser:
    """Tests for knowledge layer output parser."""

    def test_parse_single_result(self):
        content = (
            "Found 1 relevant document(s):\n\n"
            "--- Result 1 ---\n"
            "Source: report.pdf\n"
            "Page: 15\n"
            "Citation: report.pdf, p.15\n"
            "Content Type: text\n"
            "Relevance Score: 0.85\n\n"
            "Some content from the document."
        )
        entries = extract_sources_from_tool_result("knowledge_retrieval", content)
        assert len(entries) == 1
        assert entries[0].citation_key == "report.pdf, p.15"
        assert entries[0].title == "report.pdf"
        assert entries[0].url is None
        assert entries[0].source_type == "knowledge_layer"

    def test_parse_multiple_results(self):
        content = (
            "Found 2 relevant document(s):\n\n"
            "--- Result 1 ---\n"
            "Source: doc1.pdf\n"
            "Citation: doc1.pdf\n\n"
            "Content 1.\n\n"
            "--- Result 2 ---\n"
            "Source: doc2.pdf\n"
            "Page: 3\n"
            "Citation: doc2.pdf, p.3\n\n"
            "Content 2."
        )
        entries = extract_sources_from_tool_result("knowledge_retrieval", content)
        assert len(entries) == 2
        assert entries[0].citation_key == "doc1.pdf"
        assert entries[1].citation_key == "doc2.pdf, p.3"


class TestParserDispatcher:
    """Tests for parser dispatcher and fallback behavior."""

    def test_tool_without_content_returns_empty(self):
        entries = extract_sources_from_tool_result("weather_observation_tool", "   ", source_id="weather")

        assert entries == []

    def test_data_source_tool_without_urls_registers_tool_result_source(self):
        entries = extract_sources_from_tool_result(
            "weather_observation_tool", "Visibility: 10 miles", source_id="weather"
        )

        assert len(entries) == 1
        assert entries[0].url is None
        assert entries[0].citation_key == "weather_observation_tool"
        assert entries[0].source_type == "tool_result"
        assert entries[0].tool_name == "weather_observation_tool"

    def test_unknown_tool_with_urls_extracts_them(self):
        """Generic fallback extracts URLs from any unknown tool."""
        entries = extract_sources_from_tool_result("future_tool", "See https://example.com for details")
        assert len(entries) == 1
        assert entries[0].url == "https://example.com"

    def test_custom_parser_takes_priority(self):
        """Registered parsers take priority over generic fallback."""

        def _parse_custom(content: str, tool_name: str) -> list[SourceEntry]:
            return [SourceEntry(url="https://custom.com", source_type="custom", tool_name=tool_name)]

        register_source_parser(lambda name: "my_custom" in name, _parse_custom)
        entries = extract_sources_from_tool_result("my_custom_tool", "anything")
        assert len(entries) == 1
        assert entries[0].url == "https://custom.com"
        assert entries[0].source_type == "custom"


# ---------------------------------------------------------------------------
# verify_citations tests
# ---------------------------------------------------------------------------


class TestVerifyCitations:
    """Tests for verify_citations()."""

    @pytest.fixture(name="registry")
    def fixture_registry(self):
        reg = SourceRegistry()
        reg.add(SourceEntry(url="https://valid.com/article1", title="Article 1", source_type="tavily"))
        reg.add(SourceEntry(url="https://valid.com/article2", title="Article 2", source_type="tavily"))
        reg.add(SourceEntry(citation_key="report.pdf, p.15", title="report.pdf", source_type="knowledge_layer"))
        return reg

    def test_empty_registry_returns_unchanged(self):
        registry = SourceRegistry()
        report = "Some report with [1] citations.\n\n## Sources\n[1] Fake: https://fake.com"
        result = verify_citations(report, registry)
        assert result.verified_report == report
        assert len(result.removed_citations) == 0

    def test_no_references_section_returns_unchanged(self, registry):
        report = "A report without any references section."
        result = verify_citations(report, registry)
        assert result.verified_report == report

    def test_missing_references_section_with_inline_citations_does_not_guess_from_registry_order(self, registry):
        report = "Finding one [1]. Finding two [2]."
        result = verify_citations(report, registry)

        assert result.verified_report == report
        assert not result.valid_citations
        assert not result.removed_citations

    def test_missing_references_section_with_reference_sources_appends_sources(self, registry):
        report = "Finding one [1]. Finding two [2]."
        result = verify_citations(report, registry, reference_sources=registry.all_sources())

        assert result.verified_report.startswith(report)
        assert "## Sources" in result.verified_report
        assert "[1] [Web] Article 1: https://valid.com/article1" in result.verified_report
        assert "[2] [Web] Article 2: https://valid.com/article2" in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_missing_references_section_strips_unresolved_inline_citations(self, registry):
        report = "Finding one [1]. Missing source [3]. Finding two [2]."
        result = verify_citations(report, registry, reference_sources=registry.all_sources()[:2])

        assert "Missing source ." in result.verified_report
        assert "[3]" not in result.verified_report
        assert "[1] [Web] Article 1: https://valid.com/article1" in result.verified_report
        assert "[2] [Web] Article 2: https://valid.com/article2" in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_missing_references_section_uses_reference_sources_not_registry_order(self):
        reg = SourceRegistry()
        unused = SourceEntry(url="https://valid.com/unused", title="Unused", source_type="tavily")
        compact_one = SourceEntry(url="https://valid.com/compact-one", title="Compact One", source_type="tavily")
        compact_two = SourceEntry(url="https://valid.com/compact-two", title="Compact Two", source_type="tavily")
        reg.add(unused)
        reg.add(compact_one)
        reg.add(compact_two)

        report = "Finding one [1]. Finding two [2]."
        result = verify_citations(report, reg, reference_sources=[compact_one, compact_two])

        assert "[1] [Web] Compact One: https://valid.com/compact-one" in result.verified_report
        assert "[2] [Web] Compact Two: https://valid.com/compact-two" in result.verified_report
        assert "Unused" not in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_footnote_inline_citations_are_normalized_before_appending_sources(self, registry):
        report = "Finding one [^1]. Finding two [^2]."
        result = verify_citations(report, registry, reference_sources=registry.all_sources())

        assert "Finding one [1]. Finding two [2]." in result.verified_report
        assert "[^1]" not in result.verified_report
        assert "## Sources" in result.verified_report
        assert "[1] [Web] Article 1: https://valid.com/article1" in result.verified_report
        assert "[2] [Web] Article 2: https://valid.com/article2" in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_footnote_reference_lines_are_normalized(self, registry):
        report = (
            "Finding one [^1]. Finding two [^2].\n\n"
            "## Sources\n"
            "[^1]: Article 1: https://valid.com/article1\n"
            "[^2]: Article 2: https://valid.com/article2"
        )
        result = verify_citations(report, registry)

        assert "Finding one [1]. Finding two [2]." in result.verified_report
        assert "[^" not in result.verified_report
        assert "[1] [Web] Article 1: https://valid.com/article1" in result.verified_report
        assert "[2] [Web] Article 2: https://valid.com/article2" in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_source_location_citations_are_normalized_before_appending_sources(self, registry):
        report = "Finding one \u30101\u2020L2-L4\u3011. Finding two \u30102\u2020L56-L60\u3011."
        result = verify_citations(report, registry, reference_sources=registry.all_sources())

        assert "Finding one [1]. Finding two [2]." in result.verified_report
        assert "\u2020" not in result.verified_report
        assert "## Sources" in result.verified_report
        assert "[1] [Web] Article 1: https://valid.com/article1" in result.verified_report
        assert "[2] [Web] Article 2: https://valid.com/article2" in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_source_location_reference_lines_are_normalized(self, registry):
        report = (
            "Finding one \u30101\u2020L2-L4\u3011. Finding two \u30102\u2020L56-L60\u3011.\n\n"
            "## Sources\n"
            "\u30101\u2020L2-L4\u3011 Article 1: https://valid.com/article1\n"
            "\u30102\u2020L56-L60\u3011 Article 2: https://valid.com/article2"
        )
        result = verify_citations(report, registry)

        assert "Finding one [1]. Finding two [2]." in result.verified_report
        assert "\u2020" not in result.verified_report
        assert "[1] [Web] Article 1: https://valid.com/article1" in result.verified_report
        assert "[2] [Web] Article 2: https://valid.com/article2" in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_valid_citations_preserved(self, registry):
        report = (
            "Finding one [1]. Finding two [2].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Article 2: https://valid.com/article2"
        )
        result = verify_citations(report, registry)
        assert "[1]" in result.verified_report
        assert "[2]" in result.verified_report
        assert len(result.valid_citations) == 2
        assert len(result.removed_citations) == 0

    def test_plain_sources_heading_and_collapsed_lines_are_normalized(self, registry):
        report = (
            "Finding one [1]. Finding two [2].\n\n"
            "Sources\n"
            "[1] Article 1: https://valid.com/article1 [2] Article 2: https://valid.com/article2"
        )
        result = verify_citations(report, registry)

        assert "## Sources\n[1] [Web] Article 1: https://valid.com/article1\n" in result.verified_report
        assert "[2] [Web] Article 2: https://valid.com/article2" in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_bracketed_year_in_source_title_is_not_split(self, registry):
        report = "Finding [1].\n\n## Sources\n[1] Semiconductor outlook [2024] update: https://valid.com/article1"
        result = verify_citations(report, registry)

        assert "[1] [Web] Semiconductor outlook [2024] update: https://valid.com/article1" in result.verified_report
        assert len(result.valid_citations) == 1
        assert not result.removed_citations

    def test_bare_sources_line_does_not_terminate_body_before_marked_sources(self, registry):
        report = (
            "Summary.\n"
            "Sources\n"
            "This sentence is part of the report body and should stay there [1].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1"
        )
        result = verify_citations(report, registry)

        assert result.verified_report.startswith(
            "Summary.\nSources\nThis sentence is part of the report body and should stay there [1]."
        )
        assert len(result.valid_citations) == 1
        assert not result.removed_citations

    def test_ordered_list_references_are_normalized_and_verified(self, registry):
        report = (
            "Finding one [1]. Finding two [2].\n\n"
            "## Sources\n"
            "1. Article 1: https://valid.com/article1\n"
            "2. Article 2: https://valid.com/article2"
        )
        result = verify_citations(report, registry)

        assert "[1] [Web] Article 1: https://valid.com/article1" in result.verified_report
        assert "[2] [Web] Article 2: https://valid.com/article2" in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_invalid_ordered_list_reference_is_removed(self, registry):
        report = (
            "Good finding [1]. Bad finding [2].\n\n"
            "## Sources\n"
            "1. Article 1: https://valid.com/article1\n"
            "2. Fake Source: https://fake.com/nonexistent"
        )
        result = verify_citations(report, registry)

        assert len(result.valid_citations) == 1
        assert len(result.removed_citations) == 1
        assert result.removed_citations[0]["number"] == 2
        assert result.removed_citations[0]["reason"] == "url_not_in_registry"
        assert "Good finding [1]. Bad finding ." in result.verified_report
        assert "Fake Source" not in result.verified_report

    def test_ordered_list_parenthesis_references_are_normalized_and_verified(self, registry):
        report = "Finding [1].\n\n## Sources\n1) Article 1: https://valid.com/article1"
        result = verify_citations(report, registry)

        assert "[1] [Web] Article 1: https://valid.com/article1" in result.verified_report
        assert len(result.valid_citations) == 1
        assert not result.removed_citations

    def test_url_in_markdown_brackets_still_verifies(self, registry):
        """Regression: when the LLM wraps a citation URL in markdown brackets
        (``[https://valid.com/article1]``), the verifier captured the trailing
        ``]`` as part of the URL and then failed to resolve it against the
        registry, silently removing an otherwise-valid citation."""
        report = "Finding [1].\n\n## Sources\n[1] Article 1: [https://valid.com/article1]"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1
        assert len(result.removed_citations) == 0

    def test_url_in_angle_brackets_still_verifies(self, registry):
        """Same idea as above for ``<https://...>`` Markdown-style autolinks."""
        report = "Finding [1].\n\n## Sources\n[1] Article 1: <https://valid.com/article1>"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1
        assert len(result.removed_citations) == 0

    def test_invalid_citation_removed(self, registry):
        report = (
            "Good finding [1]. Bad finding [2].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Fake Source: https://fake.com/nonexistent"
        )
        result = verify_citations(report, registry)
        assert len(result.removed_citations) == 1
        assert result.removed_citations[0]["number"] == 2
        assert result.removed_citations[0]["reason"] == "url_not_in_registry"
        # Body should have [2] removed
        assert "[2]" not in result.verified_report
        # [1] stays as [1]
        assert "[1]" in result.verified_report

    def test_unreferenced_inline_citation_removed(self, registry):
        report = "Good finding [1]. Missing reference [3].\n\n## Sources\n[1] Article 1: https://valid.com/article1"
        result = verify_citations(report, registry)

        assert "Missing reference ." in result.verified_report
        assert "[3]" not in result.verified_report
        assert len(result.valid_citations) == 1
        assert not result.removed_citations

    def test_unreferenced_inline_citation_removed_with_invalid_reference(self, registry):
        report = (
            "Good finding [1]. Bad finding [2]. Missing reference [3].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Fake Source: https://fake.com/nonexistent"
        )
        result = verify_citations(report, registry)

        assert "Bad finding ." in result.verified_report
        assert "Missing reference ." in result.verified_report
        assert "[2]" not in result.verified_report
        assert "[3]" not in result.verified_report
        assert len(result.valid_citations) == 1
        assert len(result.removed_citations) == 1

    def test_removal_leaves_gaps_for_sanitize(self, registry):
        """verify_citations removes invalid refs but does NOT renumber — gaps are left for sanitize_report."""
        report = (
            "A [1]. B [2]. C [3].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Fake: https://fake.com\n"
            "[3] Article 2: https://valid.com/article2"
        )
        result = verify_citations(report, registry)
        assert "A [1]" in result.verified_report
        assert "[2]" not in result.verified_report
        # [3] is NOT renumbered — gaps are closed by sanitize_report()
        assert "C [3]" in result.verified_report

    def test_knowledge_layer_citation_validated(self, registry):
        report = "Internal finding [1].\n\n## Sources\n[1] report.pdf, p.15"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1
        assert len(result.removed_citations) == 0

    def test_knowledge_layer_citation_fuzzy_match(self, registry):
        report = "Finding [1].\n\n## Sources\n[1] report.pdf, page 15"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1

    def test_all_citations_removed(self, registry):
        report = "Bad finding [1].\n\n## Sources\n[1] Totally Fake: https://fake.com/nothing"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 0
        assert len(result.removed_citations) == 1
        assert "[1]" not in result.verified_report

    def test_grouped_inline_citations(self, registry):
        report = (
            "Finding [1][2][3].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Fake: https://fake.com\n"
            "[3] Article 2: https://valid.com/article2"
        )
        result = verify_citations(report, registry)
        # [2] removed, [3] stays (renumbering deferred to sanitize_report)
        assert "Finding [1][3]." in result.verified_report

    def test_references_with_dashes(self, registry):
        """Shallow researcher uses '- [N] Title - URL' format."""
        report = "Finding [1].\n\n**References:**\n- [1] Article 1 - https://valid.com/article1"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1

    def test_references_bold_without_colon(self, registry):
        """Model sometimes outputs **References** without the colon."""
        report = "Finding [1].\n\n**References**\n- [1] Article 1 - https://valid.com/article1"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1

    def test_references_bold_with_trailing_spaces(self, registry):
        """Model outputs **References** followed by trailing spaces."""
        report = "Finding [1].\n\n**References**  \n- [1] Article 1 - https://valid.com/article1"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1

    def test_references_with_hash_header_variants(self, registry):
        """Test ### Sources header variant."""
        report = "Finding [1].\n\n### Sources\n[1] Article 1: https://valid.com/article1"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1

    def test_german_quellen_heading_is_treated_as_source_section(self, registry):
        """German reports with '## Quellen' verify in place — no duplicate English section."""
        report = (
            "Erkenntnis eins [1]. Erfundene Behauptung [2].\n\n"
            "## Quellen\n"
            "[1] Artikel 1: https://valid.com/article1\n"
            "[2] Erfundene Quelle: https://fake.com/nichts"
        )
        result = verify_citations(report, registry)

        assert "## Quellen" in result.verified_report
        assert "## Sources" not in result.verified_report
        assert len(result.valid_citations) == 1
        assert len(result.removed_citations) == 1
        assert result.removed_citations[0]["reason"] == "url_not_in_registry"
        assert "https://fake.com/nichts" not in result.verified_report
        assert "Erfundene Behauptung ." in result.verified_report

    @pytest.mark.parametrize(
        "heading",
        ["## Quellen", "### Quellenverzeichnis", "**Quellenangaben:**", "## Literaturverzeichnis", "Referenzen:"],
    )
    def test_german_heading_variants_are_recognized(self, registry, heading):
        """Common German source-section labels are all treated like English ones."""
        report = f"Erkenntnis [1].\n\n{heading}\n[1] Artikel 1: https://valid.com/article1"
        result = verify_citations(report, registry)

        assert len(result.valid_citations) == 1
        assert not result.removed_citations
        assert "## Quellen" in result.verified_report
        assert "## Sources" not in result.verified_report

    def test_german_knowledge_layer_citation_in_quellen_section(self, registry):
        """Internal document citations verify under a German heading too."""
        report = "Interner Befund [1].\n\n## Quellen\n[1] report.pdf, p.15"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1
        assert not result.removed_citations

    def test_unverifiable_citation_removed(self, registry):
        """Citation with no URL and no recognizable citation key is removed."""
        report = (
            "Finding [1]. Other [2].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Some vague reference with no URL"
        )
        result = verify_citations(report, registry)
        assert len(result.removed_citations) == 1
        assert result.removed_citations[0]["reason"] == "unverifiable"

    def test_knowledge_citation_with_internal_label(self, registry):
        """Knowledge citation with '(Internal)' suffix."""
        report = "Finding [1].\n\n**References:**\n- [1] report.pdf, p.15 (Internal)"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1

    def test_knowledge_citation_with_markdown_italics(self, registry):
        """LLM wraps citation in markdown italics *filename.pdf*."""
        report = "Finding [1].\n\n**References**\n- [1] *report.pdf*, p.15"
        result = verify_citations(report, registry)
        assert len(result.valid_citations) == 1
        assert len(result.removed_citations) == 0

    def test_garbled_url_repaired_to_canonical(self):
        """LLM truncated a URL — verify_citations repairs it to the full canonical URL."""
        reg = SourceRegistry()
        reg.add(SourceEntry(url="https://example.com/papers/deep-learning-2024", source_type="generic"))
        report = "Finding [1].\n\n## Sources\n[1] Paper: https://example.com/papers/deep-learning"
        result = verify_citations(report, reg)
        assert len(result.valid_citations) == 1
        # The truncated URL should be repaired to the full canonical URL
        assert "https://example.com/papers/deep-learning-2024" in result.verified_report

    def test_garbled_url_domain_only_repaired(self):
        """LLM dropped entire path — repair to full URL."""
        reg = SourceRegistry()
        reg.add(SourceEntry(url="https://arxiv.org/abs/1706.03762", source_type="generic"))
        report = "Finding [1].\n\n## Sources\n[1] Paper: https://arxiv.org"
        result = verify_citations(report, reg)
        assert len(result.valid_citations) == 1
        assert "https://arxiv.org/abs/1706.03762" in result.verified_report

    def test_url_repair_does_not_corrupt_prefix_sibling(self):
        """A repaired URL must not rewrite a different citation whose URL is a superstring.

        Garbled ``?id=1`` is repaired to ``?id=1&lang=en``; a bounded replace
        must leave the valid ``?id=10`` citation untouched (an unbounded
        str.replace would turn it into ``?id=1&lang=en0``).
        """
        reg = SourceRegistry()
        reg.add(SourceEntry(url="https://x.com/p?id=1&lang=en", source_type="generic"))
        reg.add(SourceEntry(url="https://x.com/p?id=10", source_type="generic"))
        report = "A [1] and B [2].\n\n## Sources\n[1] First: https://x.com/p?id=1\n[2] Second: https://x.com/p?id=10"
        result = verify_citations(report, reg)
        assert "https://x.com/p?id=10" in result.verified_report
        # The sibling must not have been mangled into id=1&lang=en0.
        assert "id=1&lang=en0" not in result.verified_report

    def test_duplicate_tool_result_refs_collapse_to_single_citation(self):
        """Two [N] lines that resolve to the same non-URL tool_result source are merged.

        The model often makes the same tool call twice (e.g. for two
        timezones) and emits two separate ``[N] mcp_time__get_current_time``
        reference lines. Both lines resolve to the single registered
        SourceEntry for that tool, so verify_citations should keep one and
        rewrite the body's ``[2]`` to ``[1]`` so the prose still cites the
        source.
        """
        reg = SourceRegistry()
        reg.add(
            SourceEntry(
                citation_key="mcp_time__get_current_time",
                source_type="tool_result",
                tool_name="mcp_time__get_current_time",
            )
        )
        report = (
            "Time in Mumbai [1].\n"
            "Time in Tokyo [2].\n\n"
            "**References**\n"
            "- [1] mcp_time__get_current_time\n"
            "- [2] mcp_time__get_current_time"
        )

        result = verify_citations(report, reg)

        assert len(result.valid_citations) == 1
        # The duplicate is recorded as removed for audit, with a clear reason.
        assert len(result.removed_citations) == 1
        assert result.removed_citations[0]["reason"].startswith("duplicate_of_citation_")
        # Body keeps a citation for both sentences — the second [2] is
        # rewritten to [1] rather than stripped, since the source is real.
        assert "Time in Mumbai [1]." in result.verified_report
        assert "Time in Tokyo [1]." in result.verified_report
        # Reference section keeps exactly one entry for the source.
        ref_section = result.verified_report.split("## Sources", 1)[1]
        assert ref_section.count("mcp_time__get_current_time") == 1
        assert "[2]" not in ref_section

    def test_duplicate_url_refs_collapse_to_single_citation(self):
        """Two [N] lines pointing at the same URL are merged.

        Latent variant of the tool_result case: even URL-based citations
        should collapse when the model emits the same source twice.
        """
        reg = SourceRegistry()
        reg.add(SourceEntry(url="https://valid.com/article1", title="Article 1", source_type="tavily"))
        report = (
            "Finding A [1]. Finding B [2].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Article 1: https://valid.com/article1"
        )

        result = verify_citations(report, reg)

        assert len(result.valid_citations) == 1
        assert len(result.removed_citations) == 1
        assert result.removed_citations[0]["reason"].startswith("duplicate_of_citation_")
        assert "Finding A [1]." in result.verified_report
        assert "Finding B [1]." in result.verified_report
        ref_section = result.verified_report.split("## Sources", 1)[1]
        assert ref_section.count("[1]") == 1
        assert "[2]" not in ref_section

    def test_dedup_keeps_lowest_number_when_duplicates_appear_after_unique(self):
        """Mixed: [1] valid URL A, [2] dup of [1], [3] valid URL B.

        After verify_citations, [2] should be merged into [1] and [3] should
        survive. Renumbering happens later in sanitize_report.
        """
        reg = SourceRegistry()
        reg.add(SourceEntry(url="https://valid.com/article1", title="Article 1", source_type="tavily"))
        reg.add(SourceEntry(url="https://valid.com/article2", title="Article 2", source_type="tavily"))
        report = (
            "A [1]. B [2]. C [3].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Article 1: https://valid.com/article1\n"
            "[3] Article 2: https://valid.com/article2"
        )

        result = verify_citations(report, reg)

        assert len(result.valid_citations) == 2
        assert len(result.removed_citations) == 1
        assert result.removed_citations[0]["number"] == 2
        # Body: B's [2] becomes [1]; A and C unchanged.
        assert "A [1]. B [1]. C [3]." in result.verified_report
        ref_section = result.verified_report.split("## Sources", 1)[1]
        assert ref_section.count("[1]") == 1
        assert "[2]" not in ref_section
        assert ref_section.count("[3]") == 1


class TestVerifyCitationsOriginTokens:
    """FB-2 cycle 3: verify_citations labels the LLM-written source section.

    The normal deep-research path preserves the writer's ``## Sources`` block,
    so those lines carry no origin token until verify_citations injects one
    (after the ``[N]`` marker) per validated source's registry identity.
    """

    @pytest.fixture(name="registry")
    def fixture_registry(self):
        reg = SourceRegistry()
        reg.add(
            SourceEntry(
                citation_key="OIB-Richtlinie-2.pdf, p.3",
                title="OIB-Richtlinie-2.pdf",
                source_type="knowledge_layer",
            )
        )
        reg.add(
            SourceEntry(
                url="https://example.com/article",
                title="Article",
                source_type="tavily",
                tool_name="web_search_tool",
            )
        )
        reg.add(
            SourceEntry(
                url="https://www.ris.bka.gv.at/eli/bgbl/1985/446",
                title="BauO",
                source_type="generic",
                tool_name="ris_search_tool",
            )
        )
        return reg

    def test_llm_written_kb_line_gets_kb_token(self, registry):
        report = "Interner Befund [1].\n\n## Sources\n[1] OIB-Richtlinie-2.pdf, p.3"
        result = verify_citations(report, registry)
        assert "[1] [KB] OIB-Richtlinie-2.pdf, p.3" in result.verified_report
        assert len(result.valid_citations) == 1
        assert not result.removed_citations

    def test_llm_written_web_line_gets_web_token(self, registry):
        report = "Finding [1].\n\n## Sources\n[1] Article: https://example.com/article"
        result = verify_citations(report, registry)
        assert "[1] [Web] Article: https://example.com/article" in result.verified_report
        assert len(result.valid_citations) == 1

    def test_llm_written_ris_line_gets_ris_token(self, registry):
        report = "Rechtslage [1].\n\n## Sources\n[1] BauO: https://www.ris.bka.gv.at/eli/bgbl/1985/446"
        result = verify_citations(report, registry)
        assert "[1] [RIS] BauO: https://www.ris.bka.gv.at/eli/bgbl/1985/446" in result.verified_report
        assert len(result.valid_citations) == 1

    def test_mixed_section_labels_each_line_by_type(self, registry):
        report = (
            "A [1]. B [2]. C [3].\n\n"
            "## Sources\n"
            "[1] OIB-Richtlinie-2.pdf, p.3\n"
            "[2] Article: https://example.com/article\n"
            "[3] BauO: https://www.ris.bka.gv.at/eli/bgbl/1985/446"
        )
        result = verify_citations(report, registry)
        assert "[1] [KB] OIB-Richtlinie-2.pdf, p.3" in result.verified_report
        assert "[2] [Web] Article: https://example.com/article" in result.verified_report
        assert "[3] [RIS] BauO: https://www.ris.bka.gv.at/eli/bgbl/1985/446" in result.verified_report
        assert len(result.valid_citations) == 3
        assert not result.removed_citations

    def test_dashed_list_kb_line_gets_token_after_marker(self, registry):
        """The token sits after ``[N]`` even for ``- [N] ...`` list lines."""
        report = "Befund [1].\n\n**References:**\n- [1] OIB-Richtlinie-2.pdf, p.3"
        result = verify_citations(report, registry)
        assert "- [1] [KB] OIB-Richtlinie-2.pdf, p.3" in result.verified_report

    def test_already_tokenized_lines_are_not_double_prefixed(self, registry):
        """Idempotence: a section that already carries tokens is unchanged."""
        report = (
            "A [1]. B [2].\n\n"
            "## Sources\n"
            "[1] [KB] OIB-Richtlinie-2.pdf, p.3\n"
            "[2] [Web] Article: https://example.com/article"
        )
        result = verify_citations(report, registry)
        assert "[1] [KB] OIB-Richtlinie-2.pdf, p.3" in result.verified_report
        assert "[2] [Web] Article: https://example.com/article" in result.verified_report
        assert "[KB] [KB]" not in result.verified_report
        assert "[Web] [Web]" not in result.verified_report
        assert len(result.valid_citations) == 2
        assert not result.removed_citations

    def test_removed_lines_are_dropped_not_tokenized(self, registry):
        """Invalid/unverifiable lines are dropped, never labeled."""
        report = (
            "Good [1]. Fake [2]. Vague [3].\n\n"
            "## Sources\n"
            "[1] Article: https://example.com/article\n"
            "[2] Fabricated: https://not-in-registry.example.com/x\n"
            "[3] Some vague reference with no target"
        )
        result = verify_citations(report, registry)
        assert "[1] [Web] Article: https://example.com/article" in result.verified_report
        assert "not-in-registry.example.com" not in result.verified_report
        assert "Some vague reference" not in result.verified_report
        assert len(result.valid_citations) == 1
        assert {c["reason"] for c in result.removed_citations} == {"url_not_in_registry", "unverifiable"}

    def test_tokens_survive_sanitize_report_renumbering(self, registry):
        """Non-numeric tokens are not renumbered; a removed gap still closes."""
        report = (
            "A [1]. B [2]. C [3].\n\n"
            "## Sources\n"
            "[1] OIB-Richtlinie-2.pdf, p.3\n"
            "[2] Fake: https://not-in-registry.example.com/x\n"
            "[3] Article: https://example.com/article"
        )
        verified = verify_citations(report, registry).verified_report
        sanitized = sanitize_report(verified).sanitized_report
        # [2] removed → [3] renumbered to [2]; both tokens intact.
        assert "[1] [KB] OIB-Richtlinie-2.pdf, p.3" in sanitized
        assert "[2] [Web] Article: https://example.com/article" in sanitized
        assert "[3]" not in sanitized
        assert "A [1]. B . C [2]." in sanitized

    def test_sanitize_report_leaves_existing_tokens_alone(self):
        """``_normalize_citation_syntax`` must not rewrite ``[KB]``/``[RIS]``/``[Web]``."""
        report = (
            "A [1]. B [2]. C [3].\n\n"
            "## Sources\n"
            "[1] [KB] OIB-Richtlinie-2.pdf, p.3\n"
            "[2] [Web] Article: https://example.com/article\n"
            "[3] [RIS] BauO: https://www.ris.bka.gv.at/eli/bgbl/1985/446"
        )
        sanitized = sanitize_report(report).sanitized_report
        assert "[1] [KB] OIB-Richtlinie-2.pdf, p.3" in sanitized
        assert "[2] [Web] Article: https://example.com/article" in sanitized
        assert "[3] [RIS] BauO: https://www.ris.bka.gv.at/eli/bgbl/1985/446" in sanitized


# ---------------------------------------------------------------------------
# source origin token tests (FB-2: knowledge base vs web vs RIS labeling)
# ---------------------------------------------------------------------------


class TestSourceOriginToken:
    """Tests for the deterministic per-source origin token."""

    def test_knowledge_layer_source_gets_kb_token(self):
        entry = SourceEntry(citation_key="OIB-Richtlinie-2.pdf, p.3", source_type="knowledge_layer")
        assert source_origin_token(entry) == "[KB]"

    def test_web_source_gets_web_token(self):
        entry = SourceEntry(url="https://example.com/article", source_type="generic", tool_name="web_search_tool")
        assert source_origin_token(entry) == "[Web]"

    def test_tavily_web_source_gets_web_token(self):
        entry = SourceEntry(url="https://example.com/a", source_type="tavily", tool_name="tavily_web_search")
        assert source_origin_token(entry) == "[Web]"

    def test_ris_source_by_tool_name_gets_ris_token(self):
        # RIS hits arrive via the generic URL parser, so source_type == "generic";
        # the RIS tool name is what keeps them cleanly identifiable.
        entry = SourceEntry(
            url="https://www.ris.bka.gv.at/eli/bgbl/1985/446",
            source_type="generic",
            tool_name="ris_search_tool",
        )
        assert source_origin_token(entry) == "[RIS]"

    def test_ris_source_by_fetch_tool_name_gets_ris_token(self):
        entry = SourceEntry(
            url="https://www.ris.bka.gv.at/Dokument.wxe",
            source_type="generic",
            tool_name="ris_fetch_tool",
        )
        assert source_origin_token(entry) == "[RIS]"

    def test_ris_source_by_host_gets_ris_token_even_without_tool_name(self):
        entry = SourceEntry(url="https://ris.bka.gv.at/GeltendeFassung.wxe", source_type="generic")
        assert source_origin_token(entry) == "[RIS]"

    def test_non_ris_web_source_is_not_labeled_ris(self):
        # A URL that merely contains "ris" elsewhere must not be mislabeled.
        entry = SourceEntry(url="https://paris-example.com/law", source_type="generic", tool_name="web_search_tool")
        assert source_origin_token(entry) == "[Web]"

    def test_non_url_tool_result_gets_no_token(self):
        entry = SourceEntry(citation_key="mcp_time__get_current_time", source_type="tool_result")
        assert source_origin_token(entry) == ""

    def test_format_registry_reference_prepends_kb_token(self):
        entry = SourceEntry(citation_key="OIB-Richtlinie-2.pdf, p.3", source_type="knowledge_layer")
        assert _format_registry_reference(4, entry) == "[4] [KB] OIB-Richtlinie-2.pdf, p.3"

    def test_format_registry_reference_prepends_web_token(self):
        entry = SourceEntry(url="https://example.com/a", title="Article A", source_type="tavily")
        assert _format_registry_reference(1, entry) == "[1] [Web] Article A: https://example.com/a"

    def test_format_registry_reference_prepends_ris_token(self):
        entry = SourceEntry(
            url="https://www.ris.bka.gv.at/eli/bgbl/1985/446",
            title="BauO",
            source_type="generic",
            tool_name="ris_search_tool",
        )
        assert _format_registry_reference(2, entry) == "[2] [RIS] BauO: https://www.ris.bka.gv.at/eli/bgbl/1985/446"

    def test_format_registry_reference_tool_result_has_no_token(self):
        entry = SourceEntry(citation_key="mcp_time__get_current_time", source_type="tool_result")
        assert _format_registry_reference(1, entry) == "[1] mcp_time__get_current_time"


# ---------------------------------------------------------------------------
# Norm-registry verification pass (Phase 5)
# ---------------------------------------------------------------------------


def _norm_registry_fixture():
    from aiq_agent.common.norm_registry import Edition
    from aiq_agent.common.norm_registry import EditionSource
    from aiq_agent.common.norm_registry import Jurisdiction
    from aiq_agent.common.norm_registry import NormEntry
    from aiq_agent.common.norm_registry import NormRegistry

    def _corpus_edition(edition_id="2023-05", label="Ausgabe Mai 2023", file="oib-rl_2_ausgabe_mai_2023.pdf"):
        return Edition(
            id=edition_id,
            label=label,
            status="current",
            source=EditionSource(kind="corpus", file=file),
        )

    rl2 = NormEntry(
        id="oib-rl-2",
        title="OIB-Richtlinie 2 Brandschutz",
        short="OIB-RL 2",
        rank="oib_richtlinie",
        role="normativ",
        jurisdiction=Jurisdiction(country="at"),
        editions=[_corpus_edition()],
    )
    leitfaden = NormEntry(
        id="oib-rl-2-leitfaden",
        title="Leitfaden zur OIB-Richtlinie 2",
        short="OIB-RL 2 Leitfaden",
        rank="oib_leitfaden",
        role="anwendend",
        jurisdiction=Jurisdiction(country="at"),
        editions=[_corpus_edition(file="oib-rl_2_leitfaden_ausgabe_mai_2023.pdf")],
    )
    return NormRegistry(entries=[rl2, leitfaden])


class TestRegistryVerification:
    """Registry pass: document/edition validity + guidance-as-requirement notes."""

    @pytest.fixture(autouse=True)
    def _patch_norm_registry(self, monkeypatch):
        from aiq_agent.common import citation_verification

        self._registry = _norm_registry_fixture()
        monkeypatch.setattr(citation_verification, "_load_norm_registry_for_verification", lambda: self._registry)

    def _sources_registry(self, *keys):
        reg = SourceRegistry()
        for key in keys:
            reg.add(SourceEntry(citation_key=key, title=key.split(",")[0], source_type="knowledge_layer"))
        return reg

    def _report(self, body, lines):
        return body + "\n\n## Sources\n" + "\n".join(lines)

    def test_result_has_notes_field_empty_for_clean_citation(self):
        sources = self._sources_registry("OIB-RL 2, Pkt 3.1.2, Ausgabe Mai 2023")
        report = self._report(
            "Die Wände müssen feuerbeständig sein [1].",
            ["[1] OIB-RL 2, Pkt 3.1.2, Ausgabe Mai 2023"],
        )
        result = verify_citations(report, sources)
        assert result.notes == []

    def test_unresolved_document_yields_note(self):
        sources = self._sources_registry("OIB-RL 99, Pkt 1, Ausgabe Mai 2023")
        report = self._report(
            "Anforderung [1].",
            ["[1] OIB-RL 99, Pkt 1, Ausgabe Mai 2023"],
        )
        result = verify_citations(report, sources)
        assert [n["type"] for n in result.notes] == ["document_unresolved"]
        assert result.notes[0]["number"] == 1

    def test_unresolved_edition_yields_note(self):
        sources = self._sources_registry("OIB-RL 2, Pkt 3.1.2, Ausgabe Mai 1999")
        report = self._report(
            "Anforderung [1].",
            ["[1] OIB-RL 2, Pkt 3.1.2, Ausgabe Mai 1999"],
        )
        result = verify_citations(report, sources)
        assert [n["type"] for n in result.notes] == ["edition_unresolved"]
        assert result.notes[0]["norm_id"] == "oib-rl-2"

    def test_guidance_cited_as_requirement_yields_note(self):
        sources = self._sources_registry("OIB-RL 2 Leitfaden, Pkt 2.1, Ausgabe Mai 2023")
        report = self._report(
            "Die Wände müssen feuerbeständig ausgeführt werden [1].",
            ["[1] OIB-RL 2 Leitfaden, Pkt 2.1, Ausgabe Mai 2023"],
        )
        result = verify_citations(report, sources)
        assert [n["type"] for n in result.notes] == ["guidance_cited_as_requirement"]
        assert result.notes[0]["norm_id"] == "oib-rl-2-leitfaden"

    def test_guidance_in_non_requirement_sentence_not_flagged(self):
        sources = self._sources_registry("OIB-RL 2 Leitfaden, Pkt 2.1, Ausgabe Mai 2023")
        report = self._report(
            "Zur Anwendung siehe die Ausführungen [1].",
            ["[1] OIB-RL 2 Leitfaden, Pkt 2.1, Ausgabe Mai 2023"],
        )
        result = verify_citations(report, sources)
        assert result.notes == []

    def test_normative_role_never_flagged_even_with_keywords(self):
        sources = self._sources_registry("OIB-RL 2, Pkt 3.1.2, Ausgabe Mai 2023")
        report = self._report(
            "Die Anforderung muss erfüllt werden [1].",
            ["[1] OIB-RL 2, Pkt 3.1.2, Ausgabe Mai 2023"],
        )
        result = verify_citations(report, sources)
        assert result.notes == []

    def test_corpus_file_citation_resolves_entry(self):
        sources = self._sources_registry("oib-rl_2_ausgabe_mai_2023.pdf, p.5")
        report = self._report(
            "Die Wände müssen feuerbeständig sein [1].",
            ["[1] oib-rl_2_ausgabe_mai_2023.pdf, p.5"],
        )
        result = verify_citations(report, sources)
        assert result.notes == []

    def test_registry_unavailable_yields_empty_notes(self, monkeypatch):
        from aiq_agent.common import citation_verification

        monkeypatch.setattr(citation_verification, "_load_norm_registry_for_verification", lambda: None)
        sources = self._sources_registry("OIB-RL 99, Pkt 1, Ausgabe Mai 2023")
        report = self._report(
            "Anforderung [1].",
            ["[1] OIB-RL 99, Pkt 1, Ausgabe Mai 2023"],
        )
        result = verify_citations(report, sources)
        assert result.notes == []


# ---------------------------------------------------------------------------
# sanitize_report tests
# ---------------------------------------------------------------------------


class TestSanitizeReport:
    """Tests for deterministic report sanitization."""

    def test_body_url_not_in_refs_stripped(self):
        """Bare body URL with no matching reference is removed."""
        report = (
            "NVIDIA is great (see https://nvidia.com/gpus for details) [1].\n\n"
            "## Sources\n"
            "[1] NVIDIA: https://nvidia.com/article"
        )
        result = sanitize_report(report)
        assert "https://nvidia.com/gpus" not in result.sanitized_report
        # URL in references preserved
        assert "https://nvidia.com/article" in result.sanitized_report
        assert result.body_urls_removed == 1
        assert result.body_urls_replaced == 0

    def test_german_quellen_section_sanitized_like_english(self):
        """A German '## Quellen' section gets the same URL hygiene as '## Sources'."""
        report = (
            "Siehe https://nvidia.com/artikel im Text [1]. Verkuerzt [2].\n\n"
            "## Quellen\n"
            "[1] NVIDIA: https://nvidia.com/artikel\n"
            "[2] Kurzlink: https://bit.ly/abc123"
        )
        result = sanitize_report(report)

        assert "## Quellen" in result.sanitized_report
        assert "## Sources" not in result.sanitized_report
        # Body URL matching a reference is replaced with [1].
        assert "Siehe [1] im Text [1]" in result.sanitized_report
        assert result.body_urls_replaced == 1
        # Shortened URL removed and citations renumbered as in the English case.
        assert "bit.ly" not in result.sanitized_report
        assert result.shortened_urls_removed == ["https://bit.ly/abc123"]
        assert "[2]" not in result.sanitized_report

    def test_body_url_with_commas_matched_to_reference(self):
        """Regression: ``_BODY_URL_RE`` previously stopped at the first comma,
        so a bare body URL with commas in its path was truncated, only the
        prefix got replaced with ``[N]``, and the rest of the URL was left as
        dangling text in the sanitized report."""
        full_url = "https://weathercams.faa.gov/map/-122.31167,47.22287,10/airport/SEA/details/weather"
        report = f"Live cam at {full_url} confirms it [1].\n\n## Sources\n[1] FAA cam: {full_url}"
        result = sanitize_report(report)
        assert "Live cam at [1] confirms it [1]" in result.sanitized_report
        # No fragment of the URL should be left dangling in the body
        assert ",47.22287" not in result.sanitized_report.split("## Sources", 1)[0]
        assert result.body_urls_replaced == 1

    def test_body_url_matching_ref_replaced_with_citation(self):
        """Bare body URL matching a reference is replaced with [N]."""
        report = (
            "Visit https://arxiv.org/abs/1706.03762 for the paper [1].\n\n"
            "## Sources\n"
            "[1] Paper: https://arxiv.org/abs/1706.03762"
        )
        result = sanitize_report(report)
        # Body URL replaced with citation number
        assert "Visit [1] for the paper [1]" in result.sanitized_report
        # Reference section URL preserved
        assert "[1] Paper: https://arxiv.org/abs/1706.03762" in result.sanitized_report
        assert result.body_urls_replaced == 1
        assert result.body_urls_removed == 0

    def test_markdown_links_collapsed_to_text_in_body(self):
        """Markdown hyperlinks [text](url) should be collapsed to display text."""
        report = (
            "Read the [NVIDIA docs](https://nvidia.com/docs/guide) for details [1].\n\n"
            "## Sources\n"
            "[1] Article: https://example.com/article"
        )
        result = sanitize_report(report)
        assert "NVIDIA docs" in result.sanitized_report
        assert "https://nvidia.com/docs/guide" not in result.sanitized_report

    def test_body_without_urls_unchanged(self):
        report = (
            "Finding [1]. Another finding [2].\n\n"
            "## Sources\n"
            "[1] Title: https://example.com/article\n"
            "[2] Title: https://other.com/page"
        )
        result = sanitize_report(report)
        assert result.body_urls_removed == 0
        assert "Finding [1]" in result.sanitized_report

    def test_plain_sources_heading_and_collapsed_lines_are_sanitized(self):
        report = (
            "Finding [1]. Another finding [2].\n\n"
            "Sources\n"
            "[1] Title: https://example.com/article [2] Title: https://other.com/page"
        )
        result = sanitize_report(report)

        assert "## Sources\n[1] Title: https://example.com/article\n" in result.sanitized_report
        assert "[2] Title: https://other.com/page" in result.sanitized_report

    def test_bracketed_year_in_sanitized_source_title_is_not_split(self):
        report = "Finding [1].\n\n## Sources\n[1] Semiconductor outlook [2024] update: https://example.com/article"
        result = sanitize_report(report)

        assert "[1] Semiconductor outlook [2024] update: https://example.com/article" in result.sanitized_report

    def test_bare_sources_line_does_not_terminate_sanitized_body_before_marked_sources(self):
        report = (
            "Summary.\n"
            "Sources\n"
            "This sentence is part of the report body and should stay there [1].\n\n"
            "## Sources\n"
            "[1] Title: https://example.com/article"
        )
        result = sanitize_report(report)

        assert result.sanitized_report.startswith(
            "Summary.\nSources\nThis sentence is part of the report body and should stay there [1]."
        )
        assert "## Sources\n[1] Title: https://example.com/article" in result.sanitized_report

    def test_shortened_url_removed_from_references(self):
        report = "Finding [1].\n\n## Sources\n[1] Article: https://bit.ly/abc123"
        result = sanitize_report(report)
        assert "bit.ly" not in result.sanitized_report
        assert len(result.shortened_urls_removed) == 1
        assert "bit.ly" in result.shortened_urls_removed[0]

    def test_tco_shortened_url_removed(self):
        report = "Finding [1].\n\n## Sources\n[1] Tweet: https://t.co/xyz789"
        result = sanitize_report(report)
        assert "t.co" not in result.sanitized_report
        assert len(result.shortened_urls_removed) == 1

    def test_ip_address_url_removed(self):
        report = "Finding [1].\n\n## Sources\n[1] Suspicious: https://192.168.1.1/malware"
        result = sanitize_report(report)
        assert "192.168.1.1" not in result.sanitized_report
        assert len(result.unsafe_urls_removed) == 1

    def test_legitimate_urls_preserved(self):
        report = (
            "Finding [1] and [2].\n\n"
            "## Sources\n"
            "[1] Paper: https://arxiv.org/abs/1706.03762\n"
            "[2] News: https://www.reuters.com/technology/nvidia-2026"
        )
        result = sanitize_report(report)
        assert "arxiv.org" in result.sanitized_report
        assert "reuters.com" in result.sanitized_report
        assert result.body_urls_removed == 0
        assert len(result.shortened_urls_removed) == 0
        assert len(result.unsafe_urls_removed) == 0

    def test_multiple_shorteners_all_removed(self):
        report = (
            "Finding [1][2][3].\n\n"
            "## Sources\n"
            "[1] A: https://bit.ly/abc\n"
            "[2] B: https://tinyurl.com/def\n"
            "[3] C: https://arxiv.org/real-paper"
        )
        result = sanitize_report(report)
        assert "bit.ly" not in result.sanitized_report
        assert "tinyurl.com" not in result.sanitized_report
        assert "arxiv.org" in result.sanitized_report
        assert len(result.shortened_urls_removed) == 2

    def test_no_references_section(self):
        """Report without references — only body URL stripping applies."""
        report = "Check https://example.com for more info."
        result = sanitize_report(report)
        assert "https://example.com" not in result.sanitized_report
        assert result.body_urls_removed == 1

    def test_truncated_url_with_ellipsis_removed(self):
        """URL ending in ... is truncated/garbled — entire reference line removed."""
        report = "Finding [1].\n\n## Sources\n[1] Paper: https://arxiv.org/abs/1706.037..."
        result = sanitize_report(report)
        # The entire reference line with the truncated URL should be gone
        assert "[1] Paper:" not in result.sanitized_report
        assert len(result.truncated_urls_removed) == 1

    def test_domain_only_url_preserved(self):
        """Domain-only URLs are legitimate if they came from tool results."""
        report = "Finding [1].\n\n## Sources\n[1] Weather API: https://www.weatherapi.com/"
        result = sanitize_report(report)
        assert "weatherapi.com" in result.sanitized_report
        assert len(result.truncated_urls_removed) == 0

    def test_full_url_not_flagged_as_truncated(self):
        """URLs with actual paths are fine."""
        report = "Finding [1].\n\n## Sources\n[1] Paper: https://arxiv.org/abs/1706.03762"
        result = sanitize_report(report)
        assert "arxiv.org/abs/1706.03762" in result.sanitized_report
        assert len(result.truncated_urls_removed) == 0

    def test_renumbering_closes_gaps_from_verify(self):
        """sanitize_report renumbers to close gaps left by verify_citations."""
        # Simulate output of verify_citations that removed [2]: gaps [1], [3]
        report = (
            "A [1]. C [3].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[3] Article 2: https://valid.com/article2"
        )
        result = sanitize_report(report)
        assert "A [1]" in result.sanitized_report
        assert "C [2]" in result.sanitized_report
        assert "[3]" not in result.sanitized_report

    def test_full_pipeline_verify_then_sanitize(self):
        """End-to-end: verify removes invalid, sanitize renumbers and cleans."""
        registry = SourceRegistry()
        registry.add(SourceEntry(url="https://valid.com/article1", source_type="tavily"))
        registry.add(SourceEntry(url="https://valid.com/article2", source_type="tavily"))
        report = (
            "A [1]. B [2]. C [3].\n\n"
            "## Sources\n"
            "[1] Article 1: https://valid.com/article1\n"
            "[2] Fake: https://fake.com\n"
            "[3] Article 2: https://valid.com/article2"
        )
        verified = verify_citations(report, registry).verified_report
        sanitized = sanitize_report(verified).sanitized_report
        assert "A [1]" in sanitized
        assert "C [2]" in sanitized
        assert "[3]" not in sanitized

    def test_mixed_issues(self):
        """Body URL + shortened reference + valid references."""
        report = (
            "See https://nvidia.com/gpus inline [1][2].\n\n"
            "## Sources\n"
            "[1] Good: https://arxiv.org/abs/paper\n"
            "[2] Short: https://bit.ly/short"
        )
        result = sanitize_report(report)
        assert "https://nvidia.com" not in result.sanitized_report
        assert "arxiv.org/abs/paper" in result.sanitized_report
        assert "bit.ly" not in result.sanitized_report
        # nvidia.com/gpus doesn't match any reference → removed
        assert result.body_urls_removed == 1
        assert len(result.shortened_urls_removed) == 1

    def test_mixed_body_urls_some_match_some_not(self):
        """Body has two URLs: one matches a reference, one doesn't."""
        report = (
            "See https://arxiv.org/abs/paper and https://unknown.com for details [1].\n\n"
            "## Sources\n"
            "[1] Paper: https://arxiv.org/abs/paper"
        )
        result = sanitize_report(report)
        # Matching URL replaced with [1], unknown URL stripped
        assert "See [1] and for details [1]" in result.sanitized_report
        assert "https://unknown.com" not in result.sanitized_report
        assert result.body_urls_replaced == 1
        assert result.body_urls_removed == 1


# ---------------------------------------------------------------------------
# EmptySourceRegistryError
# ---------------------------------------------------------------------------


class TestEmptySourceRegistryError:
    """Tests for EmptySourceRegistryError."""

    def test_default_message(self):
        err = EmptySourceRegistryError()
        assert "no sources were captured" in str(err)
        assert "research" in str(err)

    def test_custom_agent_type(self):
        err = EmptySourceRegistryError("deep research")
        assert "deep research" in str(err)
        assert err.agent_type == "deep research"

    def test_is_exception(self):
        with pytest.raises(EmptySourceRegistryError):
            raise EmptySourceRegistryError("test")


# ---------------------------------------------------------------------------
# Session Registry
# ---------------------------------------------------------------------------


class TestSessionRegistry:
    """Tests for session-scoped registry management."""

    def setup_method(self):
        """Clear session registries before each test."""
        from aiq_agent.common.citation_verification import _session_registries
        from aiq_agent.common.citation_verification import _session_registries_lock

        with _session_registries_lock:
            _session_registries.clear()

    def test_get_or_create_returns_same_instance(self):
        from aiq_agent.common.citation_verification import get_or_create_session_registry

        r1 = get_or_create_session_registry("session-1")
        r2 = get_or_create_session_registry("session-1")
        assert r1 is r2

    def test_different_sessions_different_registries(self):
        from aiq_agent.common.citation_verification import get_or_create_session_registry

        r1 = get_or_create_session_registry("session-a")
        r2 = get_or_create_session_registry("session-b")
        assert r1 is not r2

    def test_contextvar_set_and_get(self):
        from aiq_agent.common.citation_verification import get_session_registry
        from aiq_agent.common.citation_verification import set_session_registry

        assert get_session_registry() is None
        reg = SourceRegistry()
        set_session_registry(reg)
        assert get_session_registry() is reg
        set_session_registry(None)
        assert get_session_registry() is None

    def test_lru_eviction(self):
        from aiq_agent.common.citation_verification import _MAX_SESSION_REGISTRIES
        from aiq_agent.common.citation_verification import _session_registries
        from aiq_agent.common.citation_verification import _session_registries_lock
        from aiq_agent.common.citation_verification import get_or_create_session_registry

        # Fill to max + 10
        for i in range(_MAX_SESSION_REGISTRIES + 10):
            get_or_create_session_registry(f"evict-{i}")
        with _session_registries_lock:
            assert len(_session_registries) == _MAX_SESSION_REGISTRIES

    def test_sources_persist_across_calls(self):
        """Sources added to a session registry persist when retrieved again."""
        from aiq_agent.common.citation_verification import get_or_create_session_registry

        reg = get_or_create_session_registry("persist-test")
        reg.add(SourceEntry(url="https://example.com/first"))

        reg2 = get_or_create_session_registry("persist-test")
        assert reg2.has_url("https://example.com/first")
        assert len(reg2.all_sources()) == 1
