"""Which passage a flagged quote is held against: the sources its own sentence cites.

``verify_quoted_spans`` reads the quote's ``[N]`` off its sentence and the
sources off those source lines, and picks the closest cited passage
(``UnverifiedQuote.nearest``), which the quote patch corrects against (ADR-0067).
"""

from __future__ import annotations

from aiq_agent.common import citation_verification
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import verify_quoted_spans

PASSAGE = (
    "Vorher steht ein Satz über Geländer und Brüstungen. Die lichte Durchgangshöhe von Treppen muss "
    "mindestens 2,10 m betragen. Danach ein Satz über Podeste und Stufen in Gebäudeklasse 4."
)
VERBATIM = "Die lichte Durchgangshöhe von Treppen muss mindestens 2,10 m betragen"
MISQUOTE = "Die lichte Durchgangshöhe bei Treppen muss wenigstens 2,10 m betragen"


def test_a_cited_link_is_resolved_as_the_source_line_check_resolves_it():
    # The line's link carries a tracking parameter and sits in angle brackets:
    # the registry files it as `?id=5`, and the line check resolves it there.
    registry = SourceRegistry()
    registry.add(SourceEntry(url="https://example.org/norm?id=5", title="Norm", chunk_text=PASSAGE, source_type="web"))
    answer = f"Es gilt: „{MISQUOTE}“ [1].\n\n## Quellen\n- [1] Web <https://example.org/norm?id=5&utm_source=x>\n"

    [flagged] = verify_quoted_spans(answer, registry)

    assert flagged.nearest is not None and flagged.nearest.url == "https://example.org/norm?id=5"


def test_a_verified_quote_never_reads_the_source_lines(monkeypatch):
    calls: list[str] = []
    real = citation_verification.cited_document_entries
    monkeypatch.setattr(
        citation_verification, "cited_document_entries", lambda text, reg: calls.append(text) or real(text, reg)
    )
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="oib.pdf, p.3", chunk_text=PASSAGE, source_type="knowledge_layer"))
    answer = f"Es gilt: „{VERBATIM}“ [1].\n\n## Quellen\n- [1] oib.pdf, p.3\n"

    assert verify_quoted_spans(answer, registry) == []
    assert calls == []


def test_quotes_citing_the_same_sources_resolve_them_once(monkeypatch):
    calls: list[str] = []
    real = citation_verification.cited_document_entries
    monkeypatch.setattr(
        citation_verification, "cited_document_entries", lambda text, reg: calls.append(text) or real(text, reg)
    )
    registry = SourceRegistry()
    registry.add(SourceEntry(citation_key="oib.pdf, p.3", chunk_text=PASSAGE, source_type="knowledge_layer"))
    other = MISQUOTE.replace("wenigstens", "zumindest")
    answer = f"Es gilt: „{MISQUOTE}“ [1]. Auch: „{other}“ [1].\n\n## Quellen\n- [1] oib.pdf, p.3\n"

    flagged = verify_quoted_spans(answer, registry)

    assert len(flagged) == 2 and all(quote.nearest is not None for quote in flagged)
    assert len(calls) == 1
