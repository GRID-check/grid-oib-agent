"""A document's stored chunks read back in the order the chunker cut them, against a real Qdrant.

Module under test: ``aiq_agent.knowledge.collection_pages``.

Point ids are the chunker's random node ids, so a scroll returns one page's
chunks in no meaningful order. The Fassung compare reads both files this way
and lines them up page by page; two identical Fassungen with several chunks on
a page must diff as unchanged. Each chunk carries its place in the file
(``chunk_ordinal``, written at ingest and by the import from Chroma), and the
readers order by page, then by it. A point written before the field existed
sorts after the numbered ones of its page, by chunk id: stable, never random.
"""

from __future__ import annotations

import pytest

from aiq_agent.knowledge.collection_pages import read_chunks
from aiq_agent.knowledge.collection_pages import read_pages
from aiq_agent.knowledge.fassung_diff import chunk_from_store
from aiq_agent.knowledge.fassung_diff import diff_fassungen
from sources.knowledge_layer.tests import qdrant_testing as qt

LINES = [f"Zeile {i}: Brandabschnitt {i} hat Feuerwiderstand REI {30 + i}" for i in range(12)]


def _ingested_records(file_name: str, lines: list[str], page: str = "1"):
    """The records ingestion writes for ``lines``: one LlamaIndex Document each, cut and embedded by the adapter."""
    from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
    from llama_index.core import Document

    ingestor = object.__new__(LlamaIndexIngestor)
    ingestor._embed_model = qt.FakeEmbedder()
    documents = [
        Document(text=line, metadata={"file_name": file_name, "page_label": page, "content_type": "text"})
        for line in lines
    ]
    return ingestor._embedded_records(documents, chunk_size=1024, chunk_overlap=128)


def _fassung(collection: str, file_name: str):
    stored = read_chunks(collection, file_name) or []
    return [chunk for text, meta in stored if (chunk := chunk_from_store(text, meta)) is not None]


def test_ingestion_numbers_each_chunk_by_its_place_in_the_file():
    records = _ingested_records("plan.pdf", LINES)

    assert [record.ordinal for record in records] == list(range(len(LINES)))


def test_two_identical_fassungen_with_twelve_chunks_on_one_page_diff_as_unchanged(qdrant_store):  # noqa: ARG001
    qt.write("proj_order", _ingested_records("plan_A.pdf", LINES))
    qt.write("proj_order", _ingested_records("plan_B.pdf", LINES))

    assert [text for text, _meta in read_chunks("proj_order", "plan_A.pdf")] == LINES
    diff = diff_fassungen(
        _fassung("proj_order", "plan_A.pdf"), _fassung("proj_order", "plan_B.pdf"), older_facts=None, newer_facts=None
    )
    assert diff.pages == ()
    assert diff.unchanged_pages == 1


def test_read_pages_orders_by_page_then_by_the_chunk_s_place(qdrant_store):  # noqa: ARG001
    page_two = _ingested_records("bericht.pdf", ["2a", "2b", "2c"], page="2")
    page_ten = _ingested_records("bericht.pdf", ["10a", "10b"], page="10")
    for offset, record in enumerate(page_ten):
        record.ordinal = 3 + offset
    # Written page ten first and in reverse, so neither write order nor point id can pass for the order.
    qt.write("proj_pages", list(reversed(page_ten)) + list(reversed(page_two)))

    assert read_pages("proj_pages", "bericht.pdf") == [
        ("2", "2a"),
        ("2", "2b"),
        ("2", "2c"),
        ("10", "10a"),
        ("10", "10b"),
    ]


def test_a_point_without_an_ordinal_sorts_after_the_numbered_ones_of_its_page_by_chunk_id(qdrant_store):  # noqa: ARG001
    numbered = _ingested_records("alt.pdf", ["erster", "zweiter"])
    unnumbered = [
        qt.record("ohne Nummer z", "alt.pdf", chunk_id="ffffffff-0000-4000-8000-000000000000"),
        qt.record("ohne Nummer a", "alt.pdf", chunk_id="00000000-0000-4000-8000-000000000000"),
    ]
    qt.write("proj_old", unnumbered + list(reversed(numbered)))

    assert [text for text, _meta in read_chunks("proj_old", "alt.pdf")] == [
        "erster",
        "zweiter",
        "ohne Nummer a",
        "ohne Nummer z",
    ]


def test_the_section_structure_read_passage_sorts_by_comes_before_the_ordinal(qdrant_store):  # noqa: ARG001
    """A tenant section („Zeilen 12-30“) carries its place itself, which orders points written without an ordinal."""
    sections = [
        qt.record("Abschnitt 2, Teil 2", "notizen.md", section_order=2, line_start=40, section_part=2),
        qt.record("Abschnitt 2, Teil 1", "notizen.md", section_order=2, line_start=40, section_part=1),
        qt.record("Abschnitt 1", "notizen.md", section_order=1, line_start=1),
    ]
    qt.write("proj_md", sections)

    assert [text for text, _meta in read_chunks("proj_md", "notizen.md")] == [
        "Abschnitt 1",
        "Abschnitt 2, Teil 1",
        "Abschnitt 2, Teil 2",
    ]


def test_the_ordinal_stays_out_of_the_chunk_metadata_a_reader_sees(qdrant_store):  # noqa: ARG001
    qt.write("proj_meta", _ingested_records("plan.pdf", LINES[:2]))

    for _text, meta in read_chunks("proj_meta", "plan.pdf"):
        assert "chunk_ordinal" not in meta


def test_a_file_the_store_holds_no_chunk_of_reads_as_none(qdrant_store):  # noqa: ARG001
    qt.write("proj_some", _ingested_records("da.pdf", LINES[:1]))

    assert read_chunks("proj_some", "weg.pdf") is None
    assert read_pages("proj_some", "weg.pdf") is None


@pytest.mark.parametrize("reader", [read_chunks, read_pages])
def test_an_unreachable_store_raises_rather_than_reading_as_no_chunks(reader, qdrant_store, monkeypatch):  # noqa: ARG001
    """„Nicht im Index“ is a claim about the document; an outage is not evidence for it (read_passage does the same)."""
    from knowledge_layer.qdrant import store as store_module

    qt.write("proj_down", _ingested_records("da.pdf", LINES[:1]))

    def down(*_args, **_kwargs):
        raise ConnectionError("qdrant down")

    monkeypatch.setattr(store_module.QdrantStore, "scroll", down)
    with pytest.raises(ConnectionError):
        reader("proj_down", "da.pdf")
