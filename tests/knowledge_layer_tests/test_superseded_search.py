"""Ranked `knowledge_search` leaves out the files a person replaced, unless a call names one.

A file a person confirmed is replaced by a newer Fassung (``superseded_by``) must not
outrank its replacement on similarity alone. The exclusion is a ``file_name NOT IN``
clause on the user shelves, resolved from the metadata store at search time (a link
made or lifted a minute ago applies to the next search), and the base corpus is never
touched. The result says which Fassungen were left out and how to read one.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig
from sources.knowledge_layer.src.register import knowledge_retrieval

PROJECT = "proj_1"
ARCHIV = "archiv_1"
BASE = "oib_knowledge"

DOCS = [
    AvailableDocument(file_name="Statik_Index_B.pdf", collection=PROJECT, shelf="project", folder_path="Statik"),
    AvailableDocument(file_name="Statik_Index_C.pdf", collection=PROJECT, shelf="project", folder_path="Statik"),
    AvailableDocument(file_name="Brandschutz.pdf", collection=PROJECT, shelf="project", folder_path="Statik"),
]


def _chunk(file_name: str, page: int = 1, collection: str = PROJECT) -> Chunk:
    return Chunk(
        chunk_id=f"{collection}-{file_name}-{page}",
        content="Die Bewehrung der Decke beträgt 12 mm.",
        score=0.9,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={"collection": collection, "page_label": str(page)},
    )


def _passes(chunk: Chunk, filters: dict | None) -> bool:
    """The metadata filter the store applies: `$in`, `$nin`, `$ne` and `$and` over `file_name` and `chunking`."""
    if not filters:
        return True
    for key, condition in filters.items():
        if key == "$and":
            if not all(_passes(chunk, clause) for clause in condition):
                return False
        elif key == "file_name":
            if "$in" in condition and chunk.file_name not in condition["$in"]:
                return False
            if "$nin" in condition and chunk.file_name in condition["$nin"]:
                return False
    return True


class _Store:
    backend_name = "fake"
    embed_model_name = "fake-embedder"

    def __init__(self, pools: dict[str, list[Chunk]]):
        self.pools = pools
        self.calls: list[dict] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.calls.append({"collection": collection_name, "filters": filters})
        pool = [chunk for chunk in self.pools.get(collection_name, []) if _passes(chunk, filters)]
        return RetrievalResult(
            chunks=[chunk.model_copy(deep=True) for chunk in pool[:top_k]], query=query, backend="fake", success=True
        )


@pytest.fixture
def search(monkeypatch):
    """Install a scope (base + project, optionally the Büroablage), the pools, and the store's replaced files."""
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.setattr("sources.knowledge_layer.src.register._initialize_ingestor", lambda config, llm: None)
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})

    def install(pools, replaced: dict[str, dict[str, str]] | None = None, scope=None, documents=DOCS):
        scope = scope or [ScopedCollection(BASE, Shelf.BASE), ScopedCollection(PROJECT, Shelf.PROJECT)]
        monkeypatch.setattr("aiq_agent.knowledge.scoping.get_scoped_collections_from_context", lambda: scope)
        asked: list[str] = []

        def get_superseded_files(collection):
            asked.append(collection)
            if isinstance(replaced, Exception):
                raise replaced
            return (replaced or {}).get(collection, {})

        monkeypatch.setattr("aiq_agent.knowledge.get_superseded_files", get_superseded_files)
        store = _Store(pools)
        set_turn_documents(documents)
        monkeypatch.setattr("sources.knowledge_layer.src.register._get_retriever", lambda config: store)
        store.asked = asked
        return store

    yield install
    set_turn_documents(None)


async def _ranked_search(**kwargs) -> str:
    config = KnowledgeRetrievalConfig(
        collection_name=BASE,
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=5,
        max_chunks_per_document=0,
    )
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


def _cited(out: str) -> list[str]:
    return [line.split("Citation: ", 1)[1] for line in out.splitlines() if line.startswith("Citation: ")]


def _project_filters(store: _Store) -> list:
    return [call["filters"] for call in store.calls if call["collection"] == PROJECT]


POOLS = {
    PROJECT: [_chunk("Statik_Index_B.pdf"), _chunk("Statik_Index_C.pdf"), _chunk("Brandschutz.pdf")],
    BASE: [_chunk("oib-rl_1.pdf", collection=BASE)],
}
REPLACED = {PROJECT: {"Statik_Index_B.pdf": "Statik_Index_C.pdf"}}


class TestTheExclusion:
    async def test_a_replaced_file_is_asked_for_by_exclusion_and_never_cited(self, search):
        store = search(POOLS, REPLACED)

        out = await _ranked_search(query="Bewehrung der Decke")

        assert _project_filters(store) == [{"file_name": {"$nin": ["Statik_Index_B.pdf"]}}]
        assert "Statik_Index_B.pdf, p.1" not in _cited(out)
        assert {"Statik_Index_C.pdf, p.1", "Brandschutz.pdf, p.1"} <= set(_cited(out))

    async def test_the_result_says_which_fassungen_were_left_out_and_how_to_read_one(self, search):
        search(POOLS, REPLACED)

        out = await _ranked_search(query="Bewehrung der Decke")

        assert "Ältere Fassungen ausgeblendet: Statik_Index_B.pdf" in out
        assert "file_name=" in out.split("Ältere Fassungen ausgeblendet", 1)[1].splitlines()[0]

    async def test_naming_the_file_reads_it_and_hides_nothing(self, search):
        store = search(POOLS, REPLACED)

        out = await _ranked_search(query="Bewehrung der Decke", file_name="Statik_Index_B.pdf")

        assert not any("$nin" in repr(call["filters"]) for call in store.calls)
        assert "Statik_Index_B.pdf, p.1" in _cited(out)
        assert "Ältere Fassungen ausgeblendet" not in out
        # Nothing was resolved: a call that names a file has no use for the list.
        assert store.asked == []

    async def test_the_base_corpus_is_never_asked_about_and_never_filtered(self, search):
        store = search(POOLS, REPLACED)

        await _ranked_search(query="Bewehrung der Decke")

        assert store.asked == [PROJECT]
        [base_call] = [call for call in store.calls if call["collection"] == BASE]
        assert base_call["filters"] == {"chunking": {"$ne": "page"}}

    async def test_each_user_shelf_gets_its_own_exclusion(self, search):
        scope = [
            ScopedCollection(BASE, Shelf.BASE),
            ScopedCollection(ARCHIV, Shelf.ARCHIV),
            ScopedCollection(PROJECT, Shelf.PROJECT),
        ]
        pools = {**POOLS, ARCHIV: [_chunk("Altbau.pdf", collection=ARCHIV)]}
        store = search(pools, {**REPLACED, ARCHIV: {"Altbau.pdf": "Neubau.pdf"}}, scope=scope)

        out = await _ranked_search(query="Bewehrung der Decke")

        by_collection = {call["collection"]: call["filters"] for call in store.calls}
        assert by_collection[ARCHIV] == {"file_name": {"$nin": ["Altbau.pdf"]}}
        assert by_collection[PROJECT] == {"file_name": {"$nin": ["Statik_Index_B.pdf"]}}
        assert "Altbau.pdf" in out.split("Ältere Fassungen ausgeblendet", 1)[1].splitlines()[0]

    async def test_a_folder_narrowing_and_the_exclusion_hold_together(self, search):
        store = search(POOLS, REPLACED)

        out = await _ranked_search(query="Bewehrung der Decke", folder="Statik")

        [filters] = _project_filters(store)
        clauses = filters["$and"]
        assert {"file_name": {"$in": sorted(doc.file_name for doc in DOCS)}} in clauses
        assert {"file_name": {"$nin": ["Statik_Index_B.pdf"]}} in clauses
        assert "Statik_Index_B.pdf, p.1" not in _cited(out)

    async def test_with_nothing_replaced_the_search_is_as_it_was(self, search):
        store = search(POOLS, {})

        out = await _ranked_search(query="Bewehrung der Decke")

        assert _project_filters(store) == [None]
        assert "Ältere Fassungen ausgeblendet" not in out
        assert "Statik_Index_B.pdf, p.1" in _cited(out)

    async def test_a_store_that_cannot_be_read_hides_nothing(self, search):
        store = search(POOLS, RuntimeError("store down"))

        out = await _ranked_search(query="Bewehrung der Decke")

        assert _project_filters(store) == [None]
        assert "Statik_Index_B.pdf, p.1" in _cited(out)

    async def test_the_notice_names_a_few_files_and_counts_the_rest(self, search):
        names = {f"alt_{i:02d}.pdf": "neu.pdf" for i in range(9)}
        search({PROJECT: [_chunk("neu.pdf")], BASE: []}, {PROJECT: names})

        out = await _ranked_search(query="Bewehrung der Decke")

        line = next(line for line in out.splitlines() if "Ältere Fassungen ausgeblendet" in line)
        assert "alt_00.pdf" in line and "alt_04.pdf" in line
        assert "alt_05.pdf" not in line
        assert "und 4 weitere" in line

    async def test_a_search_that_finds_only_replaced_files_still_tells_the_model_where_they_went(self, search):
        search({PROJECT: [_chunk("Statik_Index_B.pdf")], BASE: []}, REPLACED)

        out = await _ranked_search(query="Bewehrung der Decke")

        assert _cited(out) == []
        assert "Ältere Fassungen ausgeblendet: Statik_Index_B.pdf" in out
