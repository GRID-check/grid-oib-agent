"""Structural reads on Qdrant: ``read_passage`` and the family overview by filter, never by embedding.

Against a real Qdrant (``test_qdrant_store.py`` says why and how). The corpus
is seeded through the write ingestion uses (``writes.write_chunks``), shaped like the OIB
corpus (Punkt chunks with ``punkt_id``/``punkt_depth``/``page_label``/
``page_end``, a split Punkt, a captioned table in row groups) next to a
page-chunked report, a workbook and a Markdown file.

What is pinned:

* every ``read_passage`` answer is the one the old path gave for the same
  chunks (the old path: ``retrieve`` with the probe embedded, reached by
  making ``fetch`` decline), apart from the ``Relevance Score:`` line, which
  was the cosine to the probe and is now 1.00;
* the structural path never calls the embedder;
* a fetch cut in reading order keeps the document's real opening, ties are
  never split, and points written before ``reading_order`` existed (or a
  collection without its index) are ordered client-side to the same answer.
"""

from __future__ import annotations

import importlib
import random
import re
import uuid
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
from knowledge_layer.qdrant import reads
from knowledge_layer.qdrant import schema
from knowledge_layer.qdrant import store as store_module
from knowledge_layer.qdrant import writes
from knowledge_layer.qdrant.payload import ChunkRecord
from knowledge_layer.qdrant.payload import build_payload
from knowledge_layer.qdrant.payload import chunk_metadata
from knowledge_layer.qdrant.search import Hit
from knowledge_layer.register import KnowledgeRetrievalConfig

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.base import READING_ORDER
from aiq_agent.knowledge.base import reading_order
from aiq_agent.knowledge.scoping import ScopedCollection

rp = importlib.import_module("knowledge_layer.read_passage")

DIM = 8
SCOPE = "oib_knowledge"
OIB = "oib-rl_2_ausgabe_mai_2023.pdf"
OIB_21 = "oib-rl_2.1_ausgabe_mai_2023.pdf"
REPORT = "Brandschutzkonzept.pdf"
SHEET = "Kostenaufstellung.xlsx"
MARKDOWN = "Baubeschreibung.md"
LONG = "Gutachten.pdf"
_IDS = random.Random(20261013)


def _vector(seed: str) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1, 1) for _ in range(DIM)]


def _row(text: str, file_name: str, **metadata: Any) -> dict[str, Any]:
    return {
        "id": str(uuid.UUID(int=_IDS.getrandbits(128), version=4)),
        "text": text,
        "embedding": _vector(text),
        "metadata": {"file_name": file_name, **metadata},
    }


def _punkt(file_name: str, punkt: str, depth: int, title: str, page: int, *, end: int | None = None, body: str = ""):
    return _row(
        f"{punkt} {title}\n\n{body or f'Text zu {title}. Weiterer Satz.'}",
        file_name,
        chunking="punkt",
        punkt_id=punkt,
        punkt_depth=depth,
        punkt_title=title,
        page_label=str(page),
        page_end=str(end if end is not None else page),
    )


def _oib(file_name: str = OIB) -> list[dict[str, Any]]:
    rows = [
        _punkt(file_name, "0", 1, "Vorbemerkungen", 3, body="Diese Richtlinie gilt für alle Gebäude."),
        _punkt(file_name, "0", 1, "Vorbemerkungen", 3, body="Sie ist so zu lesen."),
        _punkt(file_name, "1", 1, "Begriffsbestimmungen", 3),
        _punkt(file_name, "2", 1, "Allgemeine Anforderungen", 4),
        _punkt(file_name, "2.1", 2, "Abstände", 4, end=6),
        _punkt(file_name, "2.1.1", 3, "Abstand zur Nachbargrenze", 5),
        _punkt(file_name, "2.9", 2, "Löschwasser", 7),
        _punkt(file_name, "2.10", 2, "Blitzschutz", 7),
        _punkt(file_name, "3", 1, "Brandabschnitte", 8),
        _punkt(file_name, "3.5.2", 3, "Fluchtwege", 9, body="Erster Teil des Punktes."),
        _punkt(file_name, "3.5.2", 3, "Fluchtwege", 9, end=10, body="Zweiter Teil des Punktes."),
    ]
    for part in (3, 1, 2):
        rows.append(
            _row(
                f"[TABLE from page 11] Teil {part} von 3\n\n| a | b |",
                file_name,
                chunking="table",
                content_type="table",
                punkt_id="Tabelle 1a",
                table_part=part,
                page_label="11",
                page_end="11",
            )
        )
    return rows


def _report(file_name: str = REPORT, pages: int = 20) -> list[dict[str, Any]]:
    return [
        _row(f"Seite {page} des Berichts: Inhalt {page}.", file_name, chunking="page", page_label=str(page))
        for page in range(1, pages + 1)
    ]


def _sheet() -> list[dict[str, Any]]:
    return [
        _row(f"Blatt {name}: Positionen.", SHEET, chunking="table", page_label=name, punkt_id=f"{name}: Zeilen 2-41")
        for name in ("Übersicht", "Rohbau", "Ausbau")
    ]


def _markdown() -> list[dict[str, Any]]:
    sections = [("Allgemeines", 1, 1, 1), ("Geschoße", 1, 2, 12), ("Erdgeschoß", 2, 3, 20), ("Dach", 1, 4, 31)]
    return [
        _row(
            f"Digest › {title}\n\nText zu {title}.",
            MARKDOWN,
            chunking="section",
            punkt_id=title,
            punkt_depth=depth,
            punkt_title=title,
            section_order=order,
            line_start=line,
        )
        for title, depth, order, line in sections
    ]


@pytest.fixture
def qdrant_env(qdrant_store, monkeypatch):
    monkeypatch.setattr(writes, "facts_by_file", lambda scope, names=None: {})
    return qdrant_store


class EmbedSpy:
    """The query embedder, counting: the structural path must never reach it."""

    def __init__(self):
        self.queries: list[str] = []

    def __call__(self, query: str) -> list[float]:
        self.queries.append(query)
        return _vector(query)


@pytest.fixture
def embed_spy() -> EmbedSpy:
    return EmbedSpy()


@pytest.fixture
def retriever(qdrant_env, monkeypatch, embed_spy) -> LlamaIndexRetriever:
    instance = LlamaIndexRetriever({"embed_model": "test-model", "embed_base_url": "https://test"})
    instance._initialized = True
    monkeypatch.setattr(instance, "_embed_query_cached", embed_spy)
    store_module.reset_store()
    store_module.get_store(instance._identity())
    return instance


def _seed(retriever: LlamaIndexRetriever, rows: list[dict[str, Any]], scope: str = SCOPE) -> None:
    for file_name in sorted({row["metadata"]["file_name"] for row in rows}):
        records = [
            ChunkRecord(row["id"], row["text"], row["embedding"], row["metadata"])
            for row in rows
            if row["metadata"]["file_name"] == file_name
        ]
        written = writes.write_chunks(scope, file_name, records, identity=retriever._identity())
        assert written == len(records)


@pytest.fixture
def corpus(retriever, monkeypatch):
    """The seeded corpus, the documents registered for it, and ``read_passage`` pointed at both."""
    rows = [*_oib(), *_oib(OIB_21), *_report(), *_sheet(), *_markdown(), *_report(LONG, pages=200)]
    _seed(retriever, rows)
    documents = [
        SimpleNamespace(file_name=name, display_title=None, summary=None, tags=None, superseded_by=None)
        for name in (OIB, OIB_21, REPORT, SHEET, MARKDOWN, LONG)
    ]

    async def _documents(collection: str):
        return list(documents)

    monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: retriever)
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(SCOPE, Shelf.BASE)],
    )
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    return retriever


def _builder() -> MagicMock:
    builder = MagicMock()
    builder.get_function_config = MagicMock(
        return_value=KnowledgeRetrievalConfig(collection_name=SCOPE, include_base_collection=True)
    )
    return builder


async def _read(**kwargs) -> str:
    async with rp.read_passage(rp.ReadPassageConfig(), _builder()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


def _old_path(monkeypatch, retriever: LlamaIndexRetriever) -> None:
    """The path before this change: ``fetch`` declines, so ``read_passage`` embeds its probe and retrieves."""

    async def _declines(*args, **kwargs):
        return None

    monkeypatch.setattr(retriever, "fetch", _declines)


_SCORE_LINE = re.compile(r"^Relevance Score: .*$", re.MULTILINE)


def _without_scores(text: str) -> str:
    return _SCORE_LINE.sub("Relevance Score: <score>", text)


#: Every shape of read the locator has: outline, Punkt (split, table row groups,
#: depth 2), page (a chunk running onto it), the whole-document fallback for a
#: page-chunked report and a workbook, a Markdown outline and section, and the misses.
READS = [
    {"document": OIB},
    {"document": OIB, "punkt": "3.5.2"},
    {"document": OIB, "punkt": "Tabelle 1a"},
    {"document": OIB, "punkt": "2.1"},
    {"document": OIB, "page": 5},
    {"document": OIB, "punkt": "9.9"},
    {"document": REPORT},
    {"document": REPORT, "page": 3},
    {"document": SHEET},
    {"document": MARKDOWN},
    {"document": MARKDOWN, "punkt": "Geschoße"},
    {"document": "OIB-Richtlinie 7"},
]


async def test_read_passage_answers_exactly_as_the_old_path_for_the_same_chunks(corpus, embed_spy, monkeypatch):
    new = [await _read(**kwargs) for kwargs in READS]
    assert embed_spy.queries == [], "a structural read reached the embedder"

    _old_path(monkeypatch, corpus)
    old = [await _read(**kwargs) for kwargs in READS]
    # The comparison is not vacuous: the old path did embed its probes.
    assert embed_spy.queries

    for kwargs, before, after in zip(READS, old, new, strict=True):
        assert _without_scores(after) == _without_scores(before), kwargs
    # The one line that differs: a located passage matches, it is not ranked.
    assert "Relevance Score: 1.00" in new[1]
    assert "Teil 1 von 3" in new[2] and new[2].index("Teil 1 von 3") < new[2].index("Teil 3 von 3")


async def test_the_family_overview_reads_every_member_without_embedding(corpus, embed_spy, monkeypatch):
    entries = [ScopedCollection(SCOPE, Shelf.BASE)]
    new = await rp.family_overview(entries, "2")
    assert embed_spy.queries == []
    assert new is not None and new.structural
    assert [member.number for member in new.members] == ["2", "2.1"]

    _old_path(monkeypatch, corpus)
    old = await rp.family_overview(entries, "2")
    assert old is not None and not old.structural
    assert new.trailer == old.trailer and new.preamble == old.preamble
    assert [(chunk.chunk_id, chunk.content, chunk.metadata) for chunk in new.chunks] == [
        (chunk.chunk_id, chunk.content, chunk.metadata) for chunk in old.chunks
    ]


async def test_the_whole_document_fallback_opens_a_long_document_at_its_first_pages(corpus):
    """200 page chunks, more than the fetch bound (160): the cut is in reading order, so page 1 opens it."""
    out = await _read(document=LONG)
    pages = [int(number) for number in re.findall(r"^Page: (\d+)$", out, re.MULTILINE)]
    assert pages == list(range(1, rp._MAX_PASSAGE_CHUNKS + 1))


def _seed_pages(retriever: LlamaIndexRetriever, pages: list[int]) -> None:
    _seed(
        retriever,
        [_row(f"Absatz {index} auf Seite {page}.", REPORT, page_label=str(page)) for index, page in enumerate(pages)],
    )


def _pages(hits) -> list[int]:
    return sorted(int(hit.payload["page_label"]) for hit in hits)


async def test_a_cut_in_reading_order_never_splits_a_tie(retriever):
    _seed_pages(retriever, [2, 1, 1, 3, 1, 2, 1, 1])
    file_filter = {"file_name": REPORT}

    assert _pages(reads.fetch(SCOPE, file_filter, 3, READING_ORDER)) == [1, 1, 1, 1, 1]
    assert _pages(reads.fetch(SCOPE, file_filter, 6, READING_ORDER)) == [1, 1, 1, 1, 1, 2, 2]
    assert _pages(reads.fetch(SCOPE, file_filter, 50, READING_ORDER)) == [1, 1, 1, 1, 1, 2, 2, 3]
    assert len(reads.fetch(SCOPE, file_filter, 3)) == 3


async def test_points_written_before_reading_order_are_ordered_client_side(retriever):
    _seed_pages(retriever, [4, 2, 1, 3, 1, 5])
    store = store_module.get_store()
    alias = store.alias(SCOPE)
    # An older release wrote no `reading_order`: strip it from two points.
    some = store.client.scroll(alias, limit=2, with_payload=False)[0]
    store.client.delete_payload(alias, keys=[READING_ORDER], points=[point.id for point in some], wait=True)

    assert _pages(reads.fetch(SCOPE, {"file_name": REPORT}, 2, READING_ORDER)) == [1, 1]
    assert _pages(reads.fetch(SCOPE, {"file_name": REPORT}, 3, READING_ORDER)) == [1, 1, 2]


async def test_a_collection_without_the_index_is_read_client_side_until_a_writer_adds_it(retriever):
    _seed_pages(retriever, [3, 1, 2])
    alias = store_module.get_store().alias(SCOPE)
    store_module.get_store().client.delete_payload_index(alias, READING_ORDER, wait=True)
    store_module.reset_store()

    assert not store_module.get_store().has_index(SCOPE, READING_ORDER)
    assert _pages(reads.fetch(SCOPE, {"file_name": REPORT}, 1, READING_ORDER)) == [1]

    # The next write puts the index back.
    schema.ensure_collection(store_module.get_store().client, schema.Physical.CORPUS, DIM, retriever._identity())
    store_module.reset_store()
    assert store_module.get_store().has_index(SCOPE, READING_ORDER)


async def test_fetch_needs_no_embedder_and_no_start_up(retriever, embed_spy):
    _seed(retriever, _oib())
    cold = LlamaIndexRetriever({"embed_model": "test-model", "embed_base_url": "https://test"})
    chunks = await cold.fetch(SCOPE, {"file_name": OIB}, 3, READING_ORDER)
    assert chunks and not cold._initialized and embed_spy.queries == []


@pytest.mark.parametrize("label", ["3", " 12 ", "0", "-1", "Übersicht", "3.5", "", None])
def test_reading_order_is_the_page_number_a_reader_sorts_by(label):
    """The order a fetch cuts by is the leading term of ``read_passage``'s sort: ``Chunk.page_number or 0``."""
    metadata = {"file_name": REPORT} if label is None else {"file_name": REPORT, "page_label": label}
    payload = build_payload(SCOPE, ChunkRecord("c1", "text", [0.1] * DIM, metadata))
    chunk = LlamaIndexRetriever({"embed_model": "m", "embed_base_url": "u"})._chunk_from_hit(
        Hit("c1", "text", payload, 0.0, 1.0)
    )
    assert payload[READING_ORDER] == (chunk.page_number or 0) == reading_order(label)
    # A reader never sees the field: the chunk's metadata is what the chunker wrote.
    assert READING_ORDER not in chunk_metadata(payload)
