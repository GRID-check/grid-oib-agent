"""The locator: opening a passage the agent can already NAME.

``read_passage`` exists because the only way to reach a passage used to be a
semantic search, so a second round that already knew what it wanted paid a full
search — reranker, requery judge and all — for a lookup it could address. These
tests pin the four properties that make it a lookup rather than a second search:

* it resolves a document by NAME (indexed name, stored display title, derived
  OIB title) and refuses anything else instead of guessing the nearest;
* the store sees a hard metadata filter, so what comes back is the Punkt or the
  page that was asked for and nothing that merely resembles it;
* the grounding block is byte-for-byte the one ``knowledge_search`` produces, so
  citations, the ``Punkt:`` line and the ``## Trace-Lanes`` fan-out keep working
  with nothing downstream taught about a second shape;
* no LLM is involved anywhere on the path.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.read_passage import _MAX_PASSAGE_CHUNKS
from sources.knowledge_layer.src.read_passage import _READ_PASSAGE_DESCRIPTION
from sources.knowledge_layer.src.read_passage import ReadPassageConfig
from sources.knowledge_layer.src.read_passage import _document_names
from sources.knowledge_layer.src.read_passage import _matches
from sources.knowledge_layer.src.read_passage import _passage_filters
from sources.knowledge_layer.src.read_passage import _punkt_sort_key
from sources.knowledge_layer.src.read_passage import read_passage
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig

OIB = "oib-rl_2_ausgabe_mai_2023.pdf"


def _document(file_name: str, display_title: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(file_name=file_name, display_title=display_title, summary=None, tags=None)


def _chunk(*, punkt: str | None = None, page: int | None = None, content: str = "Text", chunk_id: str = "c1") -> Chunk:
    """A real :class:`Chunk`, because that is what the store hands back.

    A SimpleNamespace would pass every assertion here and hide the one thing
    worth pinning about the plumbing: the located chunks are re-wrapped in a
    ``RetrievalResult``, which validates them.
    """
    metadata: dict[str, object] = {}
    if punkt:
        metadata["punkt_id"] = punkt
    if page is not None:
        metadata["page_label"] = str(page)
    return Chunk(
        chunk_id=chunk_id,
        content=content,
        score=0.71,
        file_name=OIB,
        page_number=page,
        display_citation=f"{OIB}, p.{page}",
        content_type=ContentType.TEXT,
        metadata=metadata,
    )


class _Store:
    """A stand-in for the retriever and the document metadata store."""

    def __init__(self, chunks, documents):
        self.chunks = chunks
        self.documents = documents
        self.calls: list[dict] = []

    async def retrieve(self, query, collection_name, top_k, filters):
        self.calls.append({"query": query, "collection": collection_name, "top_k": top_k, "filters": filters})
        return SimpleNamespace(chunks=list(self.chunks), success=True, error_message=None)


@pytest.fixture
def store(monkeypatch):
    """One project-scoped OIB document with two Punkte on two pages."""
    chunks = [
        _chunk(punkt="3.5.2", page=12, content="Fluchtweglänge …", chunk_id="a"),
        _chunk(punkt="3.5.3", page=12, content="Notwendiger Treppenraum …", chunk_id="b"),
        _chunk(punkt="4.1", page=13, content="Rauchabzug …", chunk_id="c"),
    ]
    handle = _Store(chunks, [_document(OIB, "OIB-Richtlinie 2, Ausgabe Mai 2023")])

    async def _documents(collection: str):
        return list(handle.documents)

    monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: handle)
    monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection("oib_knowledge", Shelf.BASE)],
    )
    # The formatter's three store lookups are not what these tests are about;
    # an empty map is the documented fail-open and keeps the run database-free.
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    return handle


def _builder() -> MagicMock:
    builder = MagicMock()
    builder.get_function_config = MagicMock(
        return_value=KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=True)
    )
    return builder


async def _read(**kwargs) -> str:
    async with read_passage(ReadPassageConfig(), _builder()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


class TestResolution:
    """A name resolves or it is refused. There is no third answer."""

    def test_a_document_answers_to_its_file_name_title_and_derived_title(self):
        names = _document_names(_document(OIB, "Hausname 2"))
        assert names == [OIB, "Hausname 2", "OIB-Richtlinie 2, Ausgabe Mai 2023"]

    @pytest.mark.parametrize(
        "wanted",
        [OIB, OIB.upper(), "  OIB-Richtlinie 2, Ausgabe Mai 2023  "],
    )
    def test_any_of_its_names_resolves_it(self, wanted: str):
        assert _matches(_document(OIB), wanted.strip().casefold())

    def test_a_near_name_does_not(self):
        """The trap a fuzzy locator walks into: 2 is not 2.3."""
        assert not _matches(_document("oib-rl_2.3_ausgabe_mai_2023.pdf"), "oib-richtlinie 2, ausgabe mai 2023")

    async def test_an_unknown_document_is_refused_and_names_no_substitute(self, store):
        out = await _read(document="Brandschutzkonzept Wien.pdf", punkt="3.5.2")

        assert "No document in scope is named" in out
        assert "knowledge_search" in out
        # The refusal must not have fetched anything: a locator that falls back
        # to a search is a search with a confident label.
        assert store.calls == []
        assert "--- Result 1 ---" not in out

    async def test_a_document_with_no_such_punkt_says_so_rather_than_returning_a_neighbour(self, store):
        store.chunks = []

        out = await _read(document=OIB, punkt="9.9.9")

        assert "carries no passage at" in out
        assert "Pkt. 9.9.9" in out


class TestTheFilterIsTheAnswer:
    """What comes back is what was addressed, decided by the store, not by rank."""

    def test_a_punkt_request_filters_on_file_and_punkt(self):
        assert _passage_filters(OIB, "3.5.2", None) == {
            "$and": [{"file_name": {"$eq": OIB}}, {"punkt_id": {"$eq": "3.5.2"}}]
        }

    def test_a_page_request_compares_page_label_as_a_STRING(self):
        """Every writer in the ingest path stores `page_label` as a string; an
        int here matches nothing and reads as an empty document."""
        assert _passage_filters(OIB, None, 12) == {"$and": [{"file_name": {"$eq": OIB}}, {"page_label": {"$eq": "12"}}]}

    def test_both_together_read_that_punkt_on_that_page(self):
        clauses = _passage_filters(OIB, "3.5.2", 12)["$and"]
        assert clauses == [
            {"file_name": {"$eq": OIB}},
            {"punkt_id": {"$eq": "3.5.2"}},
            {"page_label": {"$eq": "12"}},
        ]

    async def test_the_punkt_reaches_the_store_as_a_filter(self, store):
        await _read(document="OIB-Richtlinie 2, Ausgabe Mai 2023", punkt="3.5.2")

        (call,) = store.calls
        assert call["collection"] == "oib_knowledge"
        assert call["top_k"] == _MAX_PASSAGE_CHUNKS
        assert {"punkt_id": {"$eq": "3.5.2"}} in call["filters"]["$and"]

    async def test_a_page_reaches_the_store_as_a_filter(self, store):
        await _read(document=OIB, page=12)

        (call,) = store.calls
        assert {"page_label": {"$eq": "12"}} in call["filters"]["$and"]

    async def test_neither_punkt_nor_page_is_refused_before_any_fetch(self, store):
        out = await _read(document=OIB)

        assert "Provide `punkt=`" in out
        assert store.calls == []

    def test_the_order_is_page_then_punkt_numerically(self):
        """`3.10` after `3.9`, which a string sort gets backwards."""
        chunks = [
            _chunk(punkt="3.10", page=5, chunk_id="x"),
            _chunk(punkt="3.9", page=5, chunk_id="y"),
            _chunk(punkt="1.1", page=4, chunk_id="z"),
        ]
        assert [c.chunk_id for c in sorted(chunks, key=_punkt_sort_key)] == ["z", "y", "x"]


class TestFormatParity:
    """The block is the search's block. Nothing downstream learns a second shape."""

    async def test_the_located_passage_renders_exactly_as_a_searched_one(self, store):
        from sources.knowledge_layer.src.register import _format_results

        out = await _read(document=OIB, punkt="3.5.2")

        located = _chunk(punkt="3.5.2", page=12, content="Fluchtweglänge …", chunk_id="a")
        located.metadata["collection"] = "oib_knowledge"
        located.metadata["shelf"] = str(Shelf.BASE)
        expected = _format_results(
            RetrievalResult(
                chunks=[located],
                query="Pkt. 3.5.2",
                backend="read_passage",
                success=True,
            ),
            f"{OIB}, Pkt. 3.5.2",
        )
        assert out == expected

    async def test_the_block_carries_the_citation_the_punkt_and_the_trace_lanes(self, store):
        out = await _read(document=OIB, punkt="3.5.2")

        assert f"Citation: {OIB}, p.12" in out
        assert "Punkt: 3.5.2" in out
        assert "## Trace-Lanes" in out

    async def test_only_the_addressed_punkt_is_returned(self, store):
        """The stub store ignores filters, so the tool must not.

        A real store applies the metadata filter; this one hands back all three
        chunks, which is the honest worst case for a locator that trusted rank.
        """
        out = await _read(document=OIB, punkt="3.5.2")

        assert "Fluchtweglänge" in out
        assert "Rauchabzug" not in out


class TestTheContract:
    def test_the_description_says_when_not_to_call_it(self):
        assert "WHEN NOT TO CALL" in _READ_PASSAGE_DESCRIPTION
        assert "knowledge_search" in _READ_PASSAGE_DESCRIPTION

    def test_it_names_the_search_as_the_tool_for_an_unknown_document(self):
        when_not = _READ_PASSAGE_DESCRIPTION.split("WHEN NOT TO CALL")[1]
        assert "do not know WHICH document" in when_not

    def test_it_asks_for_the_checkpoint_sentence_in_an_argument(self):
        """The slot, not a hope that the model narrates."""
        assert "`conclusion=`" in _READ_PASSAGE_DESCRIPTION

    async def test_a_conclusion_changes_nothing_about_what_is_opened(self, store):
        """It is a checkpoint channel. A sentence that steered retrieval would
        make the Herleitung a cause rather than a record of one."""
        with_sentence = await _read(document=OIB, punkt="3.5.2", conclusion="Ich brauche den Treppenraum.")
        without = await _read(document=OIB, punkt="3.5.2")

        assert with_sentence == without
        assert all("conclusion" not in str(call["filters"]) for call in store.calls)
