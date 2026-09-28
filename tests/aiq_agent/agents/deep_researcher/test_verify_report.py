"""Deep research's citation pass: ``finalize.verify_report`` and the removal summary."""

from __future__ import annotations

from aiq_agent.agents.deep_researcher import finalize
from aiq_agent.agents.deep_researcher.finalize import _summarize_removed_citations
from aiq_agent.agents.deep_researcher.finalize import verify_report
from aiq_agent.common.citation_verification import DUPLICATE_REASON_PREFIX
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

MERGED = {"number": 5, "line": "- [5] a.pdf, p.4", "reason": f"{DUPLICATE_REASON_PREFIX}1"}
PASSAGE = "Die lichte Durchgangshöhe von Treppen muss mindestens 2,10 m betragen."


def _registry() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="oib.pdf, p.3", chunk_text=PASSAGE, source_type="knowledge_layer"))
    registry.add(SourceEntry(citation_key="oib.pdf, p.4", chunk_text="Podeste.", source_type="knowledge_layer"))
    return registry


def test_a_range_naming_a_removed_source_no_longer_names_it():
    registry = _registry()
    report = (
        "## Ergebnis\n\nEs gilt X [1–3].\n\n## Sources\n"
        "- [1] oib.pdf, p.3\n- [2] oib.pdf, p.4\n- [3] erfunden.pdf, p.9\n"
    )

    verified = verify_report(report, registry, registry.all_sources())

    assert "[1–3]" not in verified.report
    assert "Es gilt X [1][2]." in verified.report
    assert [c["number"] for c in verified.removed_citations] == [3]


def test_deep_research_asks_for_no_nearest_passage(monkeypatch):
    # It annotates and never patches; a closeness pass per cited page is waste.
    calls: list[dict] = []
    real = finalize.verify_quoted_spans

    def spy(*args, **kwargs):
        calls.append(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(finalize, "verify_quoted_spans", spy)
    registry = _registry()
    quote = "„Die lichte Höhe bei Treppen muss wenigstens 2,10 m betragen“"
    report = f"Es gilt: {quote} [1].\n\n## Sources\n- [1] oib.pdf, p.3\n"

    verified = verify_report(report, registry, registry.all_sources())

    assert verified.unverified_quote_count == 1
    assert calls == [{"with_nearest": False}]


def test_a_merged_duplicate_is_not_reported_as_removed():
    assert _summarize_removed_citations([MERGED]) is None
