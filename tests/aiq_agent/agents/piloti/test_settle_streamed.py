"""Settling the streamed prose's citations before the cards arrive (ADR-0066)."""

from __future__ import annotations

from aiq_agent.agents.piloti.answer_pipeline import settle_streamed_citations
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry


def _registry() -> SourceRegistry:
    registry = SourceRegistry()
    for page in (12, 13):
        registry.add(
            SourceEntry(
                citation_key=f"oib-rl_2_ausgabe_mai_2023.pdf, p.{page}",
                source_type="knowledge_layer",
                collection="oib_knowledge",
                tool_name="knowledge_search",
            )
        )
    return registry


SOURCES = (
    "**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12\n- [2] erfunden.pdf, p.1\n"
    "- [3] oib-rl_2_ausgabe_mai_2023.pdf, p.13"
)


def test_an_unbacked_marker_goes_and_the_rest_take_the_numbers_the_terminal_will_give():
    settled = settle_streamed_citations("Fluchtweg 40 m [1], erfunden [2], Treppe [3].", SOURCES, _registry())
    body, _, section = settled.content.partition("\n\n")
    assert body == "Fluchtweg 40 m [1], erfunden, Treppe [2]."
    # The source list rides along, renumbered, the unbacked line gone.
    assert "[1]" in section and "[2]" in section and "erfunden.pdf" not in section and "[3]" not in section
    assert [(s["number"], s["citation_key"]) for s in settled.sources] == [
        (1, "oib-rl_2_ausgabe_mai_2023.pdf, p.12"),
        (2, "oib-rl_2_ausgabe_mai_2023.pdf, p.13"),
    ]


def test_prose_without_a_sources_section_or_a_registry_settles_nothing():
    assert settle_streamed_citations("Ohne Quellen.", "", _registry()) is None
    assert settle_streamed_citations("Text [1].", SOURCES, SourceRegistry()) is None
