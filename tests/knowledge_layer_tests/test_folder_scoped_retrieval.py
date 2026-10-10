"""Scoping `knowledge_search` to a project folder — and to its subtree (ADR-0049).

The folder is resolved from ``document_metadata.folder_path`` at retrieve time,
not read out of chunk metadata, for the same reason ``doc_class`` and
``display_title`` are: a rename must apply with nothing re-ingested. These tests
pin the boundary (``Brandschutz`` covers ``Brandschutz/Fluchtwege`` but never
``Brandschutzkonzepte``), the fail-open behaviour when the store is unreachable,
and the ``Ordner:`` line that lets a cited passage say where its document lives.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.register import _KNOWLEDGE_SEARCH_DESCRIPTION
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig
from sources.knowledge_layer.src.register import _apply_agent_filters
from sources.knowledge_layer.src.register import _empty_search_message
from sources.knowledge_layer.src.register import _folder_matches
from sources.knowledge_layer.src.register import _format_results
from sources.knowledge_layer.src.register import knowledge_retrieval


def _chunk(file_name: str, collection: str = "proj_abc") -> SimpleNamespace:
    return SimpleNamespace(
        chunk_id=f"{file_name}-1",
        file_name=file_name,
        content="Fluchtwege sind freizuhalten.",
        score=0.9,
        page_number=3,
        content_type=SimpleNamespace(value="text"),
        metadata={"collection": collection},
    )


def _folders(monkeypatch, mapping: dict[str, str]) -> None:
    """Stub the batched store read the folder filter and the Ordner line use."""
    monkeypatch.setattr(
        "aiq_agent.knowledge.factory.get_document_folder_paths",
        lambda collection, file_names: {k: v for k, v in mapping.items() if k in file_names},
    )


class TestFolderMatch:
    """A path, not an id — so the subtree is a prefix, with a `/` boundary."""

    def test_the_folder_itself_matches(self) -> None:
        assert _folder_matches("Brandschutz", "Brandschutz") is True

    def test_a_subfolder_matches(self) -> None:
        assert _folder_matches("Brandschutz/Fluchtwege", "Brandschutz") is True

    def test_a_deeper_subfolder_matches(self) -> None:
        assert _folder_matches("Brandschutz/Fluchtwege/EG", "Brandschutz") is True

    def test_a_sibling_that_merely_starts_with_the_name_does_not(self) -> None:
        # The whole reason the boundary is `/` and not a bare startswith.
        assert _folder_matches("Brandschutzkonzepte", "Brandschutz") is False

    def test_a_parent_does_not_match_a_request_for_its_child(self) -> None:
        assert _folder_matches("Brandschutz", "Brandschutz/Fluchtwege") is False

    def test_a_document_at_the_root_matches_no_folder(self) -> None:
        assert _folder_matches(None, "Brandschutz") is False

    def test_matching_is_case_insensitive_and_slash_tolerant(self) -> None:
        # The agent retypes the folder out of the inventory; a capital letter or
        # a stray slash is not a different folder.
        assert _folder_matches("Brandschutz/Fluchtwege", "brandschutz") is True
        assert _folder_matches("Brandschutz", "/Brandschutz/") is True


class TestFolderFilter:
    """`folder=` narrows the merged candidate list, post-merge like its siblings."""

    def test_it_keeps_only_what_is_filed_in_the_folder_or_beneath_it(self, monkeypatch) -> None:
        chunks = [_chunk("in.pdf"), _chunk("nested.pdf"), _chunk("elsewhere.pdf"), _chunk("root.pdf")]
        _folders(
            monkeypatch,
            {
                "in.pdf": "Brandschutz",
                "nested.pdf": "Brandschutz/Fluchtwege",
                "elsewhere.pdf": "Statik",
            },
        )

        kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None, folder="Brandschutz")

        assert [c.file_name for c in kept] == ["in.pdf", "nested.pdf"]

    def test_a_sibling_folder_with_a_shared_prefix_is_not_swept_in(self, monkeypatch) -> None:
        chunks = [_chunk("in.pdf"), _chunk("sibling.pdf")]
        _folders(monkeypatch, {"in.pdf": "Brandschutz", "sibling.pdf": "Brandschutzkonzepte"})

        kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None, folder="Brandschutz")

        assert [c.file_name for c in kept] == ["in.pdf"]

    def test_omitting_the_folder_leaves_every_hit_alone(self, monkeypatch) -> None:
        chunks = [_chunk("in.pdf"), _chunk("root.pdf")]
        _folders(monkeypatch, {"in.pdf": "Brandschutz"})

        kept = _apply_agent_filters(chunks, doc_class=None, title_contains=None, folder=None)

        assert [c.file_name for c in kept] == ["in.pdf", "root.pdf"]

    def test_it_combines_with_the_other_agent_filters(self, monkeypatch) -> None:
        chunks = [_chunk("plan.pdf"), _chunk("schnitt.pdf")]
        _folders(monkeypatch, {"plan.pdf": "Brandschutz", "schnitt.pdf": "Brandschutz"})

        kept = _apply_agent_filters(
            chunks,
            doc_class=None,
            title_contains="plan",
            folder="Brandschutz",
        )

        assert [c.file_name for c in kept] == ["plan.pdf"]

    def test_an_unreachable_store_drops_everything_rather_than_answering_wrongly(self, monkeypatch) -> None:
        # Fail-open on the READ (empty map), fail-closed on the ANSWER: a folder
        # question whose filing cannot be read must return nothing, so the model
        # is told to retry, rather than a shelf-wide result presented as "the
        # documents in Brandschutz".
        def _boom(collection, file_names):
            raise RuntimeError("store down")

        monkeypatch.setattr("aiq_agent.knowledge.factory.get_document_folder_paths", _boom)

        kept = _apply_agent_filters([_chunk("in.pdf")], doc_class=None, title_contains=None, folder="Brandschutz")

        assert kept == []


class TestFolderReachesTheModel:
    """What the agent is told: the parameter, the miss, and where a hit lives."""

    def test_the_tool_description_offers_the_folder_parameter(self) -> None:
        assert "`folder=`" in _KNOWLEDGE_SEARCH_DESCRIPTION
        assert "Ordner" in _KNOWLEDGE_SEARCH_DESCRIPTION

    def test_an_empty_folder_scoped_search_names_the_folder_and_the_way_out(self) -> None:
        message = _empty_search_message("Fluchtwege", folder="Brandschutz")
        assert "folder='Brandschutz'" in message
        assert "drop `folder=`" in message
        assert "Do not invent a citation." in message

    def test_a_hit_states_the_folder_its_document_is_filed_in(self, monkeypatch) -> None:
        _folders(monkeypatch, {"plan.pdf": "Brandschutz/Fluchtwege"})
        result = SimpleNamespace(success=True, chunks=[_chunk("plan.pdf")])

        rendered = _format_results(result, "Fluchtwege")

        assert "Ordner: Brandschutz/Fluchtwege" in rendered

    def test_a_document_at_the_root_gets_no_ordner_line_at_all(self, monkeypatch) -> None:
        # Absence must read as absence. An "Ordner: /" or "Ordner: -" would be a
        # folder the user never made.
        _folders(monkeypatch, {})
        result = SimpleNamespace(success=True, chunks=[_chunk("plan.pdf")])

        rendered = _format_results(result, "Fluchtwege")

        assert "Ordner:" not in rendered


# ---------------------------------------------------------------------------
# Ranked search with `folder=`: the folder narrows BEFORE the ranking.
#
# Before this, the folder was a post-filter over the top `3 × top_k` of the
# whole shelf, so a folder whose passages ranked below that pool came back
# empty. The store is now asked for the folder's files only.
# ---------------------------------------------------------------------------

PROJECT = "proj_1"
BASE = "oib_knowledge"

PLAN_DOCS = [
    AvailableDocument(file_name="x.pdf", folder_path="03_Einreichung/Pläne", collection=PROJECT, shelf="project"),
    AvailableDocument(file_name="Anschreiben.pdf", folder_path="03_Einreichung", collection=PROJECT, shelf="project"),
    AvailableDocument(file_name="y.pdf", folder_path="02_Entwurf", collection=PROJECT, shelf="project"),
    AvailableDocument(file_name="Projektbeschreibung.docx", folder_path=None, collection=PROJECT, shelf="project"),
]


def _ranked_chunk(file_name: str, page: int, collection: str = PROJECT) -> Chunk:
    return Chunk(
        chunk_id=f"{collection}-{file_name}-{page}",
        content="Fluchtwege sind freizuhalten.",
        score=0.9,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={"collection": collection, "page_label": str(page)},
    )


class _RankedStore:
    """A ranking retriever. It honours ``file_name $in`` the way the store does, and otherwise returns best-first."""

    backend_name = "fake"
    embed_model_name = "fake-embedder"

    def __init__(self, pools: dict[str, list[Chunk]]):
        self.pools = pools
        self.calls: list[dict] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.calls.append({"collection": collection_name, "top_k": top_k, "filters": filters})
        pool = self.pools.get(collection_name, [])
        allowed = ((filters or {}).get("file_name") or {}).get("$in")
        if allowed is not None:
            pool = [chunk for chunk in pool if chunk.file_name in allowed]
        return RetrievalResult(
            chunks=[chunk.model_copy(deep=True) for chunk in pool[:top_k]],
            query=query,
            backend="fake",
            success=True,
        )


@pytest.fixture
def ranked(monkeypatch):
    """A project shelf beside the base corpus, the turn's inventory, and the store's folder map."""
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(BASE, Shelf.BASE), ScopedCollection(PROJECT, Shelf.PROJECT)],
    )
    for name in ("get_document_doc_classes", "get_document_display_titles"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.setattr("sources.knowledge_layer.src.register._initialize_ingestor", lambda config, llm: None)

    def install(documents: list[AvailableDocument], pools: dict[str, list[Chunk]]) -> _RankedStore:
        store = _RankedStore(pools)
        set_turn_documents(documents)
        monkeypatch.setattr("sources.knowledge_layer.src.register._get_retriever", lambda config: store)
        _folders(monkeypatch, {doc.file_name: doc.folder_path for doc in documents if doc.folder_path})
        return store

    yield install
    set_turn_documents(None)


async def _ranked_search(**kwargs) -> str:
    config = KnowledgeRetrievalConfig(
        collection_name=BASE,
        include_base_collection=True,
        include_session_collection=False,
        generate_summary=False,
        top_k=3,
        max_chunks_per_document=0,
    )
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


def _cited(out: str) -> list[str]:
    return [line.split("Citation: ", 1)[1] for line in out.splitlines() if line.startswith("Citation: ")]


class TestRankedSearchNarrowsBeforeRanking:
    async def test_the_project_is_asked_for_exactly_the_files_of_the_folder_subtree(self, ranked):
        store = ranked(
            PLAN_DOCS,
            {PROJECT: [_ranked_chunk("y.pdf", 1), _ranked_chunk("x.pdf", 3), _ranked_chunk("Anschreiben.pdf", 1)]},
        )

        await _ranked_search(query="Fluchtwege", folder="03_Einreichung")

        project_calls = [call for call in store.calls if call["collection"] == PROJECT]
        assert [call["filters"] for call in project_calls] == [{"file_name": {"$in": ["Anschreiben.pdf", "x.pdf"]}}]
        assert {call["collection"] for call in store.calls} == {PROJECT}

    async def test_a_folder_outranked_on_the_whole_shelf_still_returns_its_passages(self, ranked):
        # top_k=3, so the unfiltered pool is 9 passages (3 × top_k). Nine of y.pdf
        # outrank the one passage of x.pdf, which sits in the folder asked for. An
        # unfiltered ranking returns only y.pdf, and the folder post-filter then
        # drops every hit: this is the regression the narrowing fixes.
        others = [_ranked_chunk("y.pdf", page) for page in range(1, 13)]
        ranked(PLAN_DOCS, {PROJECT: [*others, _ranked_chunk("x.pdf", 3)]})

        out = await _ranked_search(query="Fluchtwege", folder="03_Einreichung")

        assert "x.pdf, p.3" in _cited(out)
        assert not any(citation.startswith("y.pdf") for citation in _cited(out))

    async def test_a_folder_with_no_file_in_scope_says_so_and_never_asks_the_store(self, ranked):
        store = ranked(PLAN_DOCS, {PROJECT: [_ranked_chunk("y.pdf", 1)]})

        out = await _ranked_search(query="Fluchtwege", folder="Statik")

        assert out.startswith("No file in scope is filed in the folder 'Statik'")
        assert store.calls == []

    async def test_without_a_folder_the_search_carries_no_file_narrowing(self, ranked):
        store = ranked(PLAN_DOCS, {PROJECT: [_ranked_chunk("y.pdf", 1)]})

        out = await _ranked_search(query="Fluchtwege")

        assert [call["filters"] for call in store.calls if call["collection"] == PROJECT] == [None]
        assert all("$in" not in repr(call["filters"]) for call in store.calls)
        assert "y.pdf, p.1" in _cited(out)

    async def test_a_base_document_in_the_folder_keeps_the_page_exclusion_beside_the_narrowing(self, ranked):
        base_doc = AvailableDocument(
            file_name="oib-rl_3.pdf", folder_path="03_Einreichung", collection=BASE, shelf="base"
        )
        store = ranked(
            [*PLAN_DOCS, base_doc],
            {BASE: [_ranked_chunk("oib-rl_3.pdf", 2, collection=BASE)], PROJECT: []},
        )

        out = await _ranked_search(query="Fluchtwege", folder="03_Einreichung")

        [base_call] = [call for call in store.calls if call["collection"] == BASE]
        assert base_call["filters"]["chunking"] == {"$ne": "page"}
        assert base_call["filters"]["file_name"] == {"$in": ["oib-rl_3.pdf"]}
        assert "oib-rl_3.pdf, p.2" in _cited(out)
