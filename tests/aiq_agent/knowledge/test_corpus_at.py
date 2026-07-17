"""Tests for the structure-aware OIB corpus adapter (norm-registry Phase 2)."""

import logging

import pytest

from aiq_agent.common.norm_registry import Edition
from aiq_agent.common.norm_registry import EditionSource
from aiq_agent.common.norm_registry import Jurisdiction
from aiq_agent.common.norm_registry import NormEntry
from aiq_agent.common.norm_registry import NormRegistry
from aiq_agent.knowledge.corpus import CorpusChunk
from aiq_agent.knowledge.corpus import build_corpus_chunks
from aiq_agent.knowledge.corpus import registry_corpus_resolver
from aiq_agent.knowledge.corpus import resolve_corpus_source
from aiq_agent.knowledge.corpus.at import AustriaCorpusAdapter


def _edition(
    file: str = "oib-rl_2_ausgabe_mai_2023.pdf",
    *,
    edition_id: str = "2023-05",
    status: str = "current",
    role: str | None = None,
) -> Edition:
    return Edition(
        id=edition_id,
        label="Ausgabe Mai 2023",
        status=status,
        role=role,
        source=EditionSource(kind="corpus", file=file),
    )


def _rl2(edition: Edition | None = None) -> NormEntry:
    return NormEntry(
        id="oib-rl-2",
        title="Brandschutz",
        short="OIB-RL 2",
        rank="oib_richtlinie",
        role="normativ",
        jurisdiction=Jurisdiction(country="at", state=None),
        editions=[edition or _edition()],
        verified_at="2026-07-17",
    )


def _registry(*entries: NormEntry) -> NormRegistry:
    return NormRegistry(entries=list(entries))


def _pages(*texts: str) -> list[dict]:
    return [{"text": t, "page_number": i + 1} for i, t in enumerate(texts)]


class TestResolveCorpusSource:
    def test_finds_entry_and_edition_by_file(self):
        edition = _edition()
        registry = _registry(_rl2(edition))
        entry, found = resolve_corpus_source(registry, "oib-rl_2_ausgabe_mai_2023.pdf")
        assert entry.id == "oib-rl-2"
        assert found is edition

    def test_unknown_file_returns_none(self):
        registry = _registry(_rl2())
        assert resolve_corpus_source(registry, "something_else.pdf") is None

    def test_ris_only_entry_not_matched(self):
        entry = NormEntry(
            id="bo-wien",
            title="Bauordnung für Wien",
            short="BO Wien",
            rank="landesgesetz",
            role="normativ",
            jurisdiction=Jurisdiction(country="at", state="wien"),
            editions=[
                Edition(
                    id="konsolidiert",
                    label="Konsolidierte Fassung",
                    status="current",
                    source=EditionSource(kind="ris", application="LrKons", document_number="LWI40000225"),
                )
            ],
        )
        assert resolve_corpus_source(_registry(entry), "LWI40000225.pdf") is None


class TestPunktParsing:
    def test_headings_split_into_segments_with_titles(self):
        adapter = AustriaCorpusAdapter()
        pages = _pages("1 Geltungsbereich\nDiese Richtlinie gilt.\n2 Begriffe\nBrandlast: siehe RL 1.")
        segments = adapter.parse_segments(pages)
        assert [(s.punkt, s.title) for s in segments] == [("1", "Geltungsbereich"), ("2", "Begriffe")]
        assert "Diese Richtlinie gilt." in segments[0].text

    def test_dotted_headings_and_page_tracking(self):
        adapter = AustriaCorpusAdapter()
        pages = _pages(
            "3 Anforderungen\n3.1 Erste\nText a",
            "3.1.1 Subpunkt\nText b",
        )
        segments = adapter.parse_segments(pages)
        assert [s.punkt for s in segments] == ["3", "3.1", "3.1.1"]
        assert segments[0].page_labels == [1]
        assert segments[2].page_labels == [2]

    def test_non_heading_lines_do_not_split(self):
        adapter = AustriaCorpusAdapter()
        pages = _pages("3.1 Erste\nVersion 2.0 ist maßgeblich.\nText 1.5 fach erhöht")
        segments = adapter.parse_segments(pages)
        assert len(segments) == 1
        assert "2.0" in segments[0].text

    def test_no_headings_returns_empty(self):
        adapter = AustriaCorpusAdapter()
        assert adapter.parse_segments(_pages("kein punkt hier\nnur text")) == []


class TestPacking:
    def test_small_subtree_merges_into_parent_chunk(self):
        adapter = AustriaCorpusAdapter(max_chunk_chars=500)
        pages = _pages("3 Allgemeines\n3.1 Erste\nText a\n3.1.1 Sub\nText b\n3.2 Zweite\nText c")
        chunks = adapter.build_chunks(_rl2(), _edition(), pages)
        assert [(c.metadata["punkt"], c.metadata["chunk_index"]) for c in chunks] == [("3", 0)]
        assert "Text b" in chunks[0].text and "Text c" in chunks[0].text

    def test_oversized_subtree_splits_at_child_boundaries(self):
        adapter = AustriaCorpusAdapter(max_chunk_chars=60)
        pages = _pages(
            "3 Allgemeines\n3.1 Erste\n" + "a" * 40 + "\n3.1.1 Sub\n" + "b" * 40 + "\n3.2 Zweite\n" + "c" * 40
        )
        chunks = adapter.build_chunks(_rl2(), _edition(), pages)
        punkte = [c.metadata["punkt"] for c in chunks]
        assert punkte == ["3.1", "3.1.1", "3.2"]
        for chunk in chunks:
            assert len(chunk.text) < 200

    def test_oversized_single_segment_hard_splits_with_chunk_index(self):
        adapter = AustriaCorpusAdapter(max_chunk_chars=100)
        body = "\n\n".join(["p" * 80, "q" * 80, "r" * 80])
        pages = _pages(f"4.1 Gross\n{body}")
        chunks = adapter.build_chunks(_rl2(), _edition(), pages)
        assert [c.metadata["punkt"] for c in chunks] == ["4.1", "4.1", "4.1"]
        assert [c.metadata["chunk_index"] for c in chunks] == [0, 1, 2]
        joined = "".join(c.text for c in chunks)
        assert "p" * 80 in joined and "r" * 80 in joined


class TestMetadataAndPrefix:
    def test_full_metadata_stamped(self):
        adapter = AustriaCorpusAdapter()
        chunks = adapter.build_chunks(_rl2(), _edition(), _pages("3.1 Erste\nText"))
        meta = chunks[0].metadata
        assert meta["doc_id"] == "oib-rl-2"
        assert meta["doc_short"] == "OIB-RL 2"
        assert meta["edition"] == "2023-05"
        assert meta["edition_label"] == "Ausgabe Mai 2023"
        assert meta["edition_status"] == "current"
        assert meta["rank"] == "oib_richtlinie"
        assert meta["role"] == "normativ"
        assert meta["country"] == "at"
        assert meta["punkt"] == "3.1"
        assert meta["punkt_title"] == "Erste"
        assert meta["file_name"] == "oib-rl_2_ausgabe_mai_2023.pdf"
        assert meta["page_label"] == "1"

    def test_context_prefix_prepended(self):
        adapter = AustriaCorpusAdapter()
        chunks = adapter.build_chunks(_rl2(), _edition(), _pages("3.1.2 Nutzungen\nText"))
        assert chunks[0].text.startswith("OIB-RL 2 - Brandschutz (Ausgabe Mai 2023), Pkt 3.1.2, normativ\n")

    def test_edition_role_override_wins(self):
        adapter = AustriaCorpusAdapter()
        edition = _edition(
            file="aenderungen_oib-rl_2_ausgabe_mai_2023.pdf", edition_id="2023-05-aenderungen", role="diff"
        )
        chunks = adapter.build_chunks(_rl2(edition), edition, _pages("3.1 Erste\nText"))
        assert chunks[0].metadata["role"] == "diff"
        assert ", diff\n" in chunks[0].text.split("\n", 1)[0] + "\n"


class TestFallback:
    def test_no_headings_falls_back_to_page_chunks_with_doc_metadata(self, caplog):
        adapter = AustriaCorpusAdapter()
        with caplog.at_level(logging.WARNING):
            chunks = adapter.build_chunks(_rl2(), _edition(), _pages("kein punkt", "nur text"))
        assert len(chunks) == 2
        meta = chunks[0].metadata
        assert meta["doc_id"] == "oib-rl-2"
        assert "punkt" not in meta
        assert not chunks[0].text.startswith("OIB-RL 2 -")
        assert meta["page_label"] == "1"
        assert any("punkt" in rec.message.lower() or "grammar" in rec.message.lower() for rec in caplog.records)


class TestDispatch:
    def test_unknown_file_returns_none(self):
        assert build_corpus_chunks("unknown.pdf", _pages("x"), _registry(_rl2())) is None

    def test_none_registry_returns_none(self):
        assert build_corpus_chunks("oib-rl_2_ausgabe_mai_2023.pdf", _pages("x"), None) is None

    def test_known_file_dispatches_to_country_adapter(self):
        chunks = build_corpus_chunks("oib-rl_2_ausgabe_mai_2023.pdf", _pages("3.1 Erste\nText"), _registry(_rl2()))
        assert chunks is not None
        assert isinstance(chunks[0], CorpusChunk)
        assert chunks[0].metadata["punkt"] == "3.1"

    def test_unknown_country_falls_back_with_doc_metadata(self, caplog):
        entry = NormEntry(
            id="din-4102",
            title="Brandverhalten",
            short="DIN 4102",
            rank="norm_extern",
            role="normativ",
            jurisdiction=Jurisdiction(country="de", state=None),
            editions=[_edition(file="din_4102.pdf")],
        )
        with caplog.at_level(logging.WARNING):
            chunks = build_corpus_chunks("din_4102.pdf", _pages("1 Scope\nText"), _registry(entry))
        assert chunks is not None
        assert chunks[0].metadata["doc_id"] == "din-4102"
        assert "punkt" not in chunks[0].metadata
        assert any("de" in rec.message for rec in caplog.records)


class TestRegistryCorpusResolver:
    def test_delegates_with_loaded_registry(self, monkeypatch):
        from aiq_agent.common import norm_registry as nr

        monkeypatch.setattr(nr, "load_registry", lambda norms_dir=None: _registry(_rl2()))
        resolver = registry_corpus_resolver()
        assert resolver("unknown.pdf", _pages("x")) is None
        chunks = resolver("oib-rl_2_ausgabe_mai_2023.pdf", _pages("3.1 Erste\nText"))
        assert chunks is not None
        assert chunks[0].metadata["doc_id"] == "oib-rl-2"


@pytest.fixture(autouse=True)
def _noop():
    yield
