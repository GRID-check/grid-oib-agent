"""A source filed by its key keeps its citation when the answer adds its link.

Seen in the answer-suite sweep, on every Bauordnung question: the RIS tool
prints ``Source URL:`` beside ``Citation:``, the model writes ``Title - URL``
as the prompt asks, and the registry files RIS passages by key. The verifier
removed both sources as ``url_not_in_registry`` and paid a repair pass for it.
"""

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import verify_citations

LAW = "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006"


def _registry() -> SourceRegistry:
    registry = SourceRegistry()
    for punkt in ("§ 63", "§ 64"):
        registry.add(
            SourceEntry(
                citation_key=f"Bauordnung für Wien, {punkt}",
                source_type="knowledge_layer",
                tool_name="ris_lookup_tool",
                collection="ris/LrKons/Wien",
                punkt=punkt,
            )
        )
    return registry


def test_a_ris_passage_cited_with_its_law_link_survives():
    report = (
        "Einzureichen sind Baupläne [1] und die Belege nach § 64 [2].\n\n"
        f"## Quellen\n- [1] Bauordnung für Wien, § 63 - {LAW}\n- [2] Bauordnung für Wien, § 64 - {LAW}\n"
    )
    result = verify_citations(report, _registry())
    assert result.removed_citations == []
    assert "[1]" in result.verified_report and "[2]" in result.verified_report.split("## Quellen")[0]
    assert LAW not in result.verified_report
    assert "Bauordnung für Wien, § 64" in result.verified_report


def test_a_markdown_link_keeps_its_title():
    report = f"Baupläne [1].\n\n## Quellen\n- [1] [Bauordnung für Wien, § 63]({LAW})\n"
    result = verify_citations(report, _registry())
    assert result.removed_citations == []
    assert "Bauordnung für Wien, § 63" in result.verified_report and LAW not in result.verified_report


def test_an_unretrieved_paragraph_with_the_same_link_still_goes():
    report = f"Abstellplätze [1].\n\n## Quellen\n- [1] Bauordnung für Wien, § 99 - {LAW}\n"
    result = verify_citations(report, _registry())
    assert [c["reason"] for c in result.removed_citations] == ["url_not_in_registry"]


def test_an_error_that_links_somewhere_registers_nothing():
    from aiq_agent.common.citation_verification import extract_sources_from_tool_result

    error = (
        "Error: Web search is unavailable because TAVILY_API_KEY is not set.\n"
        "To enable this tool:\n1. Get an API key from https://tavily.com/\n"
        "2. Set the API key in your environment or in your .env file\n3. Restart the application"
    )
    assert extract_sources_from_tool_result("web_search_tool", error) == []


def test_a_leading_link_takes_its_separator_with_it():
    report = f"Abstand [1].\n\n## Quellen\n- [1] {LAW} - Bauordnung für Wien, § 63\n"
    result = verify_citations(report, _registry())
    assert result.removed_citations == []
    line = result.verified_report.split("## Quellen\n", 1)[1].strip()
    assert line == "- [1] [RIS] Bauordnung für Wien, § 63"


def test_a_link_label_goes_with_its_link():
    report = f"Abstand [1].\n\n## Quellen\n- [1] Bauordnung für Wien, § 63 – Source: <{LAW}>\n"
    result = verify_citations(report, _registry())
    assert result.removed_citations == []
    line = result.verified_report.split("## Quellen\n", 1)[1].strip()
    assert line == "- [1] [RIS] Bauordnung für Wien, § 63"


def test_drop_url_leaves_no_dangling_separator_or_label():
    from aiq_agent.common.citation_verification import _drop_url

    assert _drop_url(f"{LAW} - Wiener Bauordnung § 5", LAW) == "Wiener Bauordnung § 5"
    assert _drop_url(f"- [1] {LAW} - Wiener Bauordnung § 5", LAW) == "- [1] Wiener Bauordnung § 5"
    assert _drop_url(f"Titel – Source: <{LAW}>", LAW) == "Titel"
    assert _drop_url(f"Titel - URL: {LAW}", LAW) == "Titel"
    assert _drop_url(f"Titel - {LAW}", LAW) == "Titel"
    assert _drop_url(f"[Titel]({LAW})", LAW) == "Titel"
    assert _drop_url(f"- [1] Bauordnung für Wien, § 63 | {LAW}", LAW) == "- [1] Bauordnung für Wien, § 63"
    assert _drop_url(f"- [1] Bauordnung für Wien, § 63 (Source: {LAW})", LAW) == "- [1] Bauordnung für Wien, § 63"
    assert _drop_url(f"Titel ({LAW})", LAW) == "Titel"
    # A link in square brackets leaves no empty ``[]`` behind.
    assert _drop_url(f"- [1] Wiener Bauordnung, § 5 [{LAW}]", LAW) == "- [1] Wiener Bauordnung, § 5"
    assert _drop_url(f"- [1] [{LAW}] - Wiener Bauordnung", LAW) == "- [1] Wiener Bauordnung"
    # A link sharing its parentheses keeps them for what else they hold.
    link = "https://www.ris.bka.gv.at/x?a=1"
    assert _drop_url(f"BO-Wien § 5 ({link}, 2024)", link) == "BO-Wien § 5 (2024)"
    assert _drop_url(f"BO-Wien § 5 (2024, {link})", link) == "BO-Wien § 5 (2024)"
