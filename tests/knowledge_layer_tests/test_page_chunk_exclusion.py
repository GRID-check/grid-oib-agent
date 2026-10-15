"""The base corpus never answers with a cover page or an Impressum.

``punkt_documents`` tags the Punkt body chunks ``chunking: "punkt"`` and the
matter around them — the cover page, the Impressum — ``chunking: "page"``.
Neither of the latter is citable evidence, and a title-shaped query
("OIB-Richtlinie 2 Ausgabe Mai 2023") matched exactly them, so an overview
question came back as four garbled cover pages at page 1.

``_base_collection_filters`` now carries ``chunking != "page"`` on every
base-corpus search. The load-bearing claim is that ``$ne`` KEEPS records that
have no ``chunking`` key at all — Begriffsbestimmungen, Zitierte Normen,
project uploads and office files never carry one, and a filter that dropped
them would delete most of the searchable world. Only the store can answer that,
so these tests run the real filter dict through the real translation
(``qdrant.scope.translate``) into a real Qdrant.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.qdrant import store as store_module
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import _base_collection_filters
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.retrieval_settings import reset_retrieval_settings_cache
from sources.knowledge_layer.tests.qdrant_testing import record
from sources.knowledge_layer.tests.qdrant_testing import write

BASE = "oib_knowledge"
PROJECT = "proj_abc"


def _record(chunk_id: str, chunking: str | None, file_name: str = "oib-rl_2.pdf"):
    """One stored chunk. ``chunking=None`` means the key is ABSENT, not empty."""
    metadata = {"page_label": "1", "content_type": "text"}
    if chunking is not None:
        metadata["chunking"] = chunking
    return record(f"{chunk_id} body", file_name, chunk_id=chunk_id, **metadata)


def _kept(scope: str, filters: dict | None) -> list[str]:
    return sorted(str(point.payload["chunk_id"]) for point in store_module.get_store().scroll(scope, filters))


class TestQdrantNeSemantics:
    """(d) The measurement the store filter is built on, pinned against the real store.

    A change that made ``$ne`` exclude keyless points would empty the corpus of
    every non-Punkt document, and nothing else in the suite would notice:
    retrieval would simply return less.
    """

    def test_ne_keeps_records_that_lack_the_key(self, qdrant_store):
        write(BASE, [_record("cover", "page"), _record("punkt", "punkt"), _record("glossar", None)])

        assert _kept(BASE, {"chunking": {"$ne": "page"}}) == ["glossar", "punkt"]

    def test_the_assembled_base_filter_keeps_keyless_records(self, qdrant_store):
        """End to end: the real filter dict, the real translation, the real store."""
        write(
            BASE,
            [
                _record("cover", "page"),
                _record("punkt", "punkt"),
                _record("glossar", None, file_name="begriffsbestimmungen.pdf"),
                _record("excluded", None, file_name="drop_me.pdf"),
            ],
        )
        config = KnowledgeRetrievalConfig(collection_name=BASE, exclude_file_names=["drop_me.pdf"])

        assert _kept(BASE, _base_collection_filters(config, {"content_type": "text"})) == ["glossar", "punkt"]


class _StoreBackedRetriever:
    """A retriever whose answers the FILTER decides, because a real store applies it.

    A hand-written double would have to re-implement ``$ne`` to answer these
    tests, and its guess at the semantics is the thing under test. This one
    writes the records to Qdrant and hands the filter dict to it through the
    same translation the adapter uses.
    """

    backend_name = "fake"

    def __init__(self, records_by_collection: dict[str, list]):
        for name, records in records_by_collection.items():
            write(name, records)
        self.filters_seen: list[tuple[str, dict | None]] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.filters_seen.append((collection_name, filters))
        chunks = [
            _chunk(str(point.payload["chunk_id"]), point.payload["text"], point.payload, collection_name)
            for point in store_module.get_store().scroll(collection_name, filters)
        ]
        return SimpleNamespace(chunks=chunks, query=query, backend="fake", success=True, error_message=None)


def _chunk(chunk_id: str, content: str, metadata: dict, collection_name: str):
    from aiq_agent.knowledge.schema import Chunk

    return Chunk(
        chunk_id=chunk_id,
        content=content,
        file_name=metadata["file_name"],
        page_number=int(metadata["page_label"]),
        score=0.5,
        display_citation=f"{metadata['file_name']} p.{metadata['page_label']}",
        content_type="text",
        metadata={key: metadata[key] for key in ("file_name", "page_label")} | {"collection": collection_name},
    )


@pytest.fixture
def search_harness(monkeypatch, qdrant_store):
    """Install a retriever and neutralise everything the search reaches outside itself."""

    def install(retriever):
        monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: retriever)
        monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
        monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
        monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        reset_retrieval_settings_cache()

    return install


def _config(**overrides) -> KnowledgeRetrievalConfig:
    return KnowledgeRetrievalConfig(
        collection_name=BASE,
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=8,
        max_chunks_per_document=0,
        **overrides,
    )


async def _search(config, query="OIB-Richtlinie 2 Ausgabe Mai 2023"):
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(query=query))


class TestSearchNeverAnswersWithAPageChunk:
    async def test_a_page_chunk_from_the_base_corpus_never_reaches_the_answer(self, search_harness):
        """(a) The cover page is in the store and out of the result."""
        retriever = _StoreBackedRetriever({BASE: [_record("cover", "page"), _record("punkt", "punkt")]})
        search_harness(retriever)

        out = await _search(_config())

        assert "cover body" not in out
        assert "punkt body" in out

    async def test_a_chunk_with_no_chunking_key_still_reaches_the_answer(self, search_harness):
        """(b) The whole corpus outside the Punkt-structured Richtlinien has no such key."""
        retriever = _StoreBackedRetriever(
            {BASE: [_record("cover", "page"), _record("glossar", None, file_name="begriffsbestimmungen.pdf")]}
        )
        search_harness(retriever)

        out = await _search(_config())

        assert "glossar body" in out
        assert "cover body" not in out

    async def test_a_page_chunk_in_a_project_collection_is_untouched(self, search_harness):
        """(c) Session and project collections are user content and are never filtered."""
        retriever = _StoreBackedRetriever(
            {
                BASE: [_record("punkt", "punkt")],
                PROJECT: [_record("uploaded", "page", file_name="Konzept.pdf")],
            }
        )
        search_harness(retriever)

        out = await _search(_config(project_collections=[PROJECT]))

        assert "uploaded body" in out
        assert not any("chunking" in repr(flt) for coll, flt in retriever.filters_seen if coll == PROJECT)

    async def test_only_the_base_collection_carries_the_clause(self, search_harness):
        retriever = _StoreBackedRetriever({BASE: [_record("punkt", "punkt")], PROJECT: [_record("p", None)]})
        search_harness(retriever)

        await _search(_config(project_collections=[PROJECT]))

        seen = dict(retriever.filters_seen)
        assert seen[BASE] == {"chunking": {"$ne": "page"}}
        assert "chunking" not in repr(seen[PROJECT])
