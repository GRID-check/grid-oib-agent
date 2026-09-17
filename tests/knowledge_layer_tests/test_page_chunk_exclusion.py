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
so these tests run the real filter dict through the real translation into a
real Chroma collection.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from knowledge_layer.llamaindex.adapter import _to_chroma_where
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import _base_collection_filters
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.retrieval_settings import reset_retrieval_settings_cache

chromadb = pytest.importorskip("chromadb", reason="the filter semantics can only be measured against the real store")

BASE = "oib_knowledge"
PROJECT = "proj_abc"

#: One dimension is enough: every record gets the same vector, so `query` ranks
#: by nothing and what comes back is decided purely by the `where` clause.
_VECTOR = [1.0, 0.0]


def _record(chunk_id: str, chunking: str | None, file_name: str = "oib-rl_2.pdf") -> dict:
    """One stored chunk. ``chunking=None`` means the key is ABSENT, not empty."""
    metadata = {"file_name": file_name, "page_label": "1", "content_type": "text"}
    if chunking is not None:
        metadata["chunking"] = chunking
    return {"id": chunk_id, "text": f"{chunk_id} body", "metadata": metadata}


def _collection(name: str, records: list[dict]):
    # An EphemeralClient is shared per settings, so the name must be unique per
    # call or the second test to build the same one gets "already exists".
    collection = chromadb.EphemeralClient().create_collection(f"{name}_{uuid4().hex}")
    collection.add(
        ids=[record["id"] for record in records],
        embeddings=[_VECTOR] * len(records),
        documents=[record["text"] for record in records],
        metadatas=[record["metadata"] for record in records],
    )
    return collection


class TestChromaNeSemantics:
    """(d) The measurement the store filter is built on, pinned against the real store.

    A chromadb bump that made ``$ne`` exclude keyless records would empty the
    corpus of every non-Punkt document, and nothing else in the suite would
    notice: retrieval would simply return less.
    """

    def test_ne_keeps_records_that_lack_the_key(self):
        collection = _collection(
            "test_ne_keeps_keyless",
            [_record("cover", "page"), _record("punkt", "punkt"), _record("glossar", None)],
        )

        kept = collection.get(where={"chunking": {"$ne": "page"}})["ids"]

        assert sorted(kept) == ["glossar", "punkt"]

    def test_the_assembled_base_filter_keeps_keyless_records(self):
        """End to end: the real filter dict, the real translation, the real store."""
        collection = _collection(
            "test_assembled_base_filter",
            [
                _record("cover", "page"),
                _record("punkt", "punkt"),
                _record("glossar", None, file_name="begriffsbestimmungen.pdf"),
                _record("excluded", None, file_name="drop_me.pdf"),
            ],
        )
        config = KnowledgeRetrievalConfig(collection_name=BASE, exclude_file_names=["drop_me.pdf"])

        where = _to_chroma_where(_base_collection_filters(config, {"content_type": "text"}))
        kept = collection.get(where=where)["ids"]

        assert sorted(kept) == ["glossar", "punkt"]

    def test_the_filter_survives_the_query_path_too(self):
        """The lexical channel calls ``collection.query``/``get`` with the same ``where``."""
        collection = _collection("test_query_path_filter", [_record("cover", "page"), _record("glossar", None)])
        where = _to_chroma_where(_base_collection_filters(KnowledgeRetrievalConfig(collection_name=BASE), None))

        queried = collection.query(query_embeddings=[_VECTOR], n_results=10, where=where)["ids"][0]

        assert queried == ["glossar"]


class _ChromaBackedRetriever:
    """A retriever whose answers the FILTER decides, because a real store applies it.

    A hand-written double would have to re-implement ``$ne`` to answer these
    tests, and its guess at the semantics is the thing under test. This one
    stores the records and hands the filter dict to Chroma through the same
    translation the adapter's vector and lexical channels both use.
    """

    backend_name = "fake"

    def __init__(self, records_by_collection: dict[str, list[dict]]):
        self.collections = {
            name: _collection(f"test_backed_{name}", records) for name, records in records_by_collection.items()
        }
        self.filters_seen: list[tuple[str, dict | None]] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.filters_seen.append((collection_name, filters))
        collection = self.collections[collection_name]
        raw = collection.get(where=_to_chroma_where(filters))
        chunks = [
            _chunk(chunk_id, document, metadata, collection_name)
            for chunk_id, document, metadata in zip(raw["ids"], raw["documents"], raw["metadatas"], strict=True)
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
        metadata=dict(metadata) | {"collection": collection_name},
    )


@pytest.fixture
def search_harness(monkeypatch):
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
        retriever = _ChromaBackedRetriever({BASE: [_record("cover", "page"), _record("punkt", "punkt")]})
        search_harness(retriever)

        out = await _search(_config())

        assert "cover body" not in out
        assert "punkt body" in out

    async def test_a_chunk_with_no_chunking_key_still_reaches_the_answer(self, search_harness):
        """(b) The whole corpus outside the Punkt-structured Richtlinien has no such key."""
        retriever = _ChromaBackedRetriever(
            {BASE: [_record("cover", "page"), _record("glossar", None, file_name="begriffsbestimmungen.pdf")]}
        )
        search_harness(retriever)

        out = await _search(_config())

        assert "glossar body" in out
        assert "cover body" not in out

    async def test_a_page_chunk_in_a_project_collection_is_untouched(self, search_harness):
        """(c) Session and project collections are user content and are never filtered."""
        retriever = _ChromaBackedRetriever(
            {
                BASE: [_record("punkt", "punkt")],
                PROJECT: [_record("uploaded", "page", file_name="Konzept.pdf")],
            }
        )
        search_harness(retriever)

        out = await _search(_config(project_collections=[PROJECT]))

        assert "uploaded body" in out
        assert (PROJECT, None) in retriever.filters_seen

    async def test_only_the_base_collection_carries_the_clause(self, search_harness):
        retriever = _ChromaBackedRetriever({BASE: [_record("punkt", "punkt")], PROJECT: [_record("p", None)]})
        search_harness(retriever)

        await _search(_config(project_collections=[PROJECT]))

        seen = dict(retriever.filters_seen)
        assert seen[BASE] == {"chunking": {"$ne": "page"}}
        assert seen[PROJECT] is None
