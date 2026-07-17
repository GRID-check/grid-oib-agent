"""Tests for the RIS fetched-document corpus adapter (norm-registry Phase 3)."""

from aiq_agent.common.norm_registry import Edition
from aiq_agent.common.norm_registry import EditionSource
from aiq_agent.common.norm_registry import Jurisdiction
from aiq_agent.common.norm_registry import NormEntry
from aiq_agent.common.norm_registry import NormRegistry
from aiq_agent.knowledge.corpus import build_corpus_chunks
from aiq_agent.knowledge.corpus.ris import build_ris_corpus_chunks
from aiq_agent.knowledge.corpus.ris import parse_paragraph_segments

WBTV_URL = "https://www.ris.bka.gv.at/Dokumente/Landesnormen/LWI40016790/LWI40016790.html"


def _wbtv() -> NormEntry:
    return NormEntry(
        id="wbtv",
        title="Wiener Bautechnikverordnung 2023",
        short="WBTV 2023",
        rank="verordnung",
        role="normativ",
        jurisdiction=Jurisdiction(country="at", state="wien"),
        editions=[
            Edition(
                id="konsolidiert",
                label="Konsolidierte Fassung (laufend)",
                status="current",
                source=EditionSource(kind="ris", application="LrKons", document_number="LWI40016790"),
            )
        ],
    )


def _registry(*entries) -> NormRegistry:
    return NormRegistry(entries=list(entries))


def _pages(text: str, url: str = WBTV_URL) -> list[dict]:
    return [{"text": f"Source: {url}\n\n{text}", "page_number": 1}]


def _text(*sections: str) -> str:
    return "\n".join(sections)


class TestParseParagraphSegments:
    def test_parses_paragraph_headings(self):
        segments = parse_paragraph_segments(_text("§ 1 Geltungsbereich\nText eins", "§ 2 Begriffe\nText zwei"))
        assert [s.punkt for s in segments] == ["1", "2"]
        assert segments[0].punkt_title == "Geltungsbereich"
        assert "Text eins" in segments[0].body

    def test_lettered_paragraphs(self):
        segments = parse_paragraph_segments(_text("§ 12a Besondere Regel\nInhalt"))
        assert segments[0].punkt == "12a"

    def test_lines_before_first_heading_dropped(self):
        segments = parse_paragraph_segments(_text("Präambel ohne Paragraphen", "§ 1 Erster\nText"))
        assert len(segments) == 1

    def test_no_headings_returns_empty(self):
        assert parse_paragraph_segments("Fließtext ohne Struktur") == []


class TestBuildRisCorpusChunks:
    def test_registry_known_document_stamps_metadata(self):
        pages = _pages(_text("§ 1 Geltung\nText", "§ 2 Begriffe\nMehr"))
        chunks = build_ris_corpus_chunks("RIS_WBTV.txt", pages, _registry(_wbtv()))
        assert chunks is not None
        meta = chunks[0].metadata
        assert meta["doc_id"] == "wbtv"
        assert meta["rank"] == "verordnung"
        assert meta["role"] == "normativ"
        assert meta["country"] == "at"
        assert meta["edition"] == "konsolidiert"
        assert meta["document_number"] == "LWI40016790"

    def test_paragraph_keyed_chunks_with_prefix(self):
        chunks = build_ris_corpus_chunks("RIS_WBTV.txt", _pages(_text("§ 1 Geltung\nText")), _registry(_wbtv()))
        assert chunks[0].metadata["paragraph"] == "1"
        expected = "WBTV 2023 - Wiener Bautechnikverordnung 2023 (Konsolidierte Fassung (laufend)), § 1, normativ\n"
        assert chunks[0].text.startswith(expected)

    def test_blind_document_gets_ris_id_without_rank(self):
        url = "https://www.ris.bka.gv.at/Dokumente/Bundesnormen/NOR99999999/NOR99999999.html"
        pages = _pages(_text("§ 1 Geltung\nText"), url)
        chunks = build_ris_corpus_chunks("RIS_Irgendwas.txt", pages, _registry(_wbtv()))
        meta = chunks[0].metadata
        assert meta["doc_id"] == "ris:NOR99999999"
        assert "rank" not in meta
        assert "role" not in meta

    def test_unstructured_text_falls_back_to_doc_level_chunk(self):
        chunks = build_ris_corpus_chunks("RIS_WBTV.txt", _pages("Nur Fließtext ohne Paragraphen"), _registry(_wbtv()))
        assert len(chunks) == 1
        assert chunks[0].metadata["doc_id"] == "wbtv"
        assert "paragraph" not in chunks[0].metadata

    def test_dispatched_through_build_corpus_chunks(self):
        chunks = build_corpus_chunks("RIS_WBTV.txt", _pages(_text("§ 1 Geltung\nText")), _registry(_wbtv()))
        assert chunks is not None
        assert chunks[0].metadata["doc_id"] == "wbtv"

    def test_oib_pdf_names_still_route_to_country_adapter(self):
        chunks = build_corpus_chunks("unknown.pdf", [{"text": "x", "page_number": 1}], _registry(_wbtv()))
        assert chunks is None

    def test_small_paragraphs_grouped(self):
        text = _text(*[f"§ {i} Abschnitt {i}\nKurzer Text {i}" for i in range(1, 6)])
        chunks = build_ris_corpus_chunks("RIS_WBTV.txt", _pages(text), _registry(_wbtv()))
        assert len(chunks) < 5
        assert chunks[0].metadata["paragraph"] == "1"
        assert "§ 3" in chunks[0].text
