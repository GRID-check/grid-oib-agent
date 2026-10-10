"""The file browser and the literal mode of the search.

``list_files`` and ``knowledge_search(match="exact")`` exist because the agent could see only the
first fifty names of a project and could only find what ranked in a top-k
similarity search. These tests pin what makes them the Files pane and Ctrl+F:

* the listing is complete (no cap), filtered and paged, with the subfolders;
* the phrase search returns EVERY matching file with its count, matching case,
  umlaut spellings and line breaks or hyphens between words, and its passages
  are citable grounding hits;
* neither reads beyond the turn's scope, and neither guesses.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.browse import ListFilesConfig
from sources.knowledge_layer.src.browse import file_rows
from sources.knowledge_layer.src.browse import group_matches
from sources.knowledge_layer.src.browse import list_files
from sources.knowledge_layer.src.browse import no_match_message
from sources.knowledge_layer.src.browse import phrase_pattern
from sources.knowledge_layer.src.browse import pick_passages
from sources.knowledge_layer.src.browse import render_listing
from sources.knowledge_layer.src.browse import select_files
from sources.knowledge_layer.src.browse import split_alternatives
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig
from sources.knowledge_layer.src.register import knowledge_retrieval


def _doc(name: str, folder: str | None = None, *, shelf: str = "project", **extra) -> AvailableDocument:
    return AvailableDocument(
        file_name=name,
        folder_path=folder,
        collection="proj_1" if shelf == "project" else f"{shelf}_1",
        shelf=shelf,
        summary=extra.pop("summary", f"Zusammenfassung von {name}"),
        **extra,
    )


PROJECT = [
    _doc("Grundriss_EG.pdf", "Plaene/Grundrisse", doc_class="plan", added_at="2026-09-01"),
    _doc("Grundriss_OG1.pdf", "Plaene/Grundrisse", doc_class="plan", added_at="2026-09-20"),
    _doc("Schnitt_A-A.pdf", "Plaene/Schnitte", doc_class="plan", added_at="2026-08-02"),
    _doc("Brandschutzkonzept.pdf", "Brandschutz", display_title="Brandschutzkonzept Müllerstraße"),
    _doc("Protokoll_Baubesprechung_03.docx", None, added_at="2026-09-28"),
    _doc("Leitfaden_Buero.pdf", None, shelf="archiv"),
    _doc("oib-rl_2.pdf", None, shelf="base"),
]


def _rows():
    return file_rows(PROJECT)


class TestSelectFiles:
    def test_default_lists_the_readers_own_shelves_never_the_base_corpus(self):
        listing = select_files(_rows())
        names = [row.file_name for row in listing.rows]
        assert "oib-rl_2.pdf" not in names
        assert "Leitfaden_Buero.pdf" in names
        assert listing.total == 6

    def test_no_cap_a_project_of_three_hundred_files_lists_all_of_them_paged(self):
        many = file_rows(_doc(f"Plan_{index:03}.pdf", "Plaene") for index in range(300))
        first = select_files(many, limit=100)
        last = select_files(many, offset=200, limit=100)
        assert first.total == 300
        assert [row.file_name for row in last.rows][-1] == "Plan_299.pdf"
        assert "offset=100" in render_listing(first)

    def test_a_folder_is_its_whole_subtree_and_is_matched_case_insensitively(self):
        listing = select_files(_rows(), folder="plaene")
        assert listing.folder == "Plaene"
        assert {row.file_name for row in listing.rows} == {"Grundriss_EG.pdf", "Grundriss_OG1.pdf", "Schnitt_A-A.pdf"}
        assert listing.subfolders == [("Plaene/Grundrisse", 2), ("Plaene/Schnitte", 1)]

    def test_the_top_level_names_every_folder_with_its_count(self):
        listing = select_files(_rows())
        assert ("Plaene", 3) in listing.subfolders
        assert ("Brandschutz", 1) in listing.subfolders
        assert listing.here == 2

    def test_an_unknown_folder_is_refused_not_guessed(self):
        text = render_listing(select_files(_rows(), folder="Statik"))
        assert "Kein Ordner „Statik“" in text

    def test_name_words_all_match_in_name_or_title_whatever_the_umlaut_spelling(self):
        listing = select_files(_rows(), name_contains="brandschutz muellerstrasse")
        assert [row.file_name for row in listing.rows] == ["Brandschutzkonzept.pdf"]

    def test_newest_first_puts_the_latest_upload_on_top_and_undated_last(self):
        listing = select_files(_rows(), sort="newest")
        names = [row.file_name for row in listing.rows]
        assert names[0] == "Protokoll_Baubesprechung_03.docx"
        assert names.index("Grundriss_OG1.pdf") < names.index("Grundriss_EG.pdf")
        assert names[-1] in {"Brandschutzkonzept.pdf", "Leitfaden_Buero.pdf"}

    def test_added_since_and_doc_class_filter(self):
        listing = select_files(_rows(), doc_class="plan", added_since="2026-09-01")
        assert {row.file_name for row in listing.rows} == {"Grundriss_EG.pdf", "Grundriss_OG1.pdf"}

    def test_base_is_listable_when_asked(self):
        assert [row.file_name for row in select_files(_rows(), shelf="base").rows] == ["oib-rl_2.pdf"]

    def test_the_listing_says_it_is_an_index_and_names_files_verbatim(self):
        text = render_listing(select_files(_rows(), folder="Brandschutz"))
        assert "- Brandschutzkonzept.pdf · „Brandschutzkonzept Müllerstraße“" in text
        assert "keine Quelle" in text

    def test_files_still_being_read_are_named(self):
        text = render_listing(select_files(_rows()), in_flight=["Neu.pdf"])
        assert "Noch in Verarbeitung" in text and "Neu.pdf" in text


def _builder() -> MagicMock:
    builder = MagicMock()
    builder.get_function_config = MagicMock(
        return_value=KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=True)
    )
    return builder


@pytest.fixture
def scope(monkeypatch):
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [
            ScopedCollection("oib_knowledge", Shelf.BASE),
            ScopedCollection("proj_1", Shelf.PROJECT),
            ScopedCollection("archiv_1", Shelf.ARCHIV),
        ],
    )
    monkeypatch.setattr("aiq_agent.knowledge.ingest_status_store.in_flight_files", lambda collections: {})
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    set_turn_documents(PROJECT)
    yield
    set_turn_documents(None)


class TestListFilesTool:
    async def _call(self, **kwargs) -> str:
        async with list_files(ListFilesConfig(), _builder()) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_reads_the_turns_uncapped_rows(self, scope):
        text = await self._call(folder="Plaene/Grundrisse")
        assert "2 Datei(en) auf Projektwissen und Büroablage und Private Sitzung" in text
        assert "Grundriss_OG1.pdf" in text

    async def test_falls_back_to_the_scope_when_no_rows_are_bound(self, scope, monkeypatch):
        set_turn_documents(None)

        async def _documents(collection: str):
            return [AvailableDocument(file_name=f"{collection}.pdf")]

        monkeypatch.setattr("aiq_agent.knowledge.get_available_documents_async", _documents)
        text = await self._call()
        assert "proj_1.pdf" in text and "archiv_1.pdf" in text
        assert "oib_knowledge.pdf" not in text

    async def test_rejects_arguments_it_cannot_honour(self, scope):
        assert "must be" in await self._call(shelf="alles")
        assert "YYYY-MM-DD" in await self._call(added_since="letzte Woche")
        assert "Invalid doc_class" in await self._call(doc_class="kein_typ")


def _chunk(file_name: str, content: str, *, page: int, chunk_id: str, collection: str = "proj_1") -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        content=content,
        score=1.0,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={"page_label": str(page), "collection": collection},
    )


class TestPhraseMatching:
    def test_alternatives_split_on_the_bar_and_drop_noise(self):
        assert split_alternatives(" BA-03 | BA 03 |x| BA-03 | -- ") == ["BA-03", "BA 03"]

    def test_one_pattern_covers_case_and_umlaut_transliteration(self):
        import re

        pattern = re.compile(phrase_pattern(["Müller"]))
        assert all(pattern.search(text) for text in ("Müller", "müller", "MÜLLER", "Mueller", "MUELLER"))
        assert not pattern.search("Muller")

    def test_candidates_are_rechecked_and_counted_per_file(self):
        chunks = [
            _chunk("a.pdf", "Firma MUELLER liefert; Müller haftet", page=2, chunk_id="1"),
            _chunk("b.pdf", "Die Firma Müller", page=5, chunk_id="2"),
            _chunk("b.pdf", "Müllerstraße 3, Firma Müller", page=1, chunk_id="3"),
            _chunk("c.pdf", "nichts davon", page=1, chunk_id="4"),
        ]
        groups = group_matches(chunks, phrase_pattern(["Müller"]))
        assert [(group.file_name, group.occurrences) for group in groups] == [("b.pdf", 3), ("a.pdf", 2)]
        assert groups[0].pages == [1, 5]

    def test_passages_round_robin_across_files(self):
        groups = group_matches(
            [
                _chunk("a.pdf", "X", page=1, chunk_id="1"),
                _chunk("a.pdf", "X", page=2, chunk_id="2"),
                _chunk("b.pdf", "X", page=1, chunk_id="3"),
            ],
            phrase_pattern(["X"]),
        )
        assert [chunk.chunk_id for chunk in pick_passages(groups, limit=2)] == ["1", "3"]


class _TextStore:
    """A retriever that only knows the literal lookup; a ranked search here is a bug."""

    def __init__(self, chunks):
        self.chunks = chunks
        self.calls: list[dict] = []

    async def find_text(self, collection_name, pattern, filters=None, limit=500):
        self.calls.append({"collection": collection_name, "pattern": pattern, "filters": filters})
        return [chunk for chunk in self.chunks if chunk.metadata["collection"] == collection_name]

    async def retrieve(self, *args, **kwargs):  # pragma: no cover - the exact mode never ranks
        raise AssertionError("match='exact' must not run the ranked search")


@pytest.fixture
def search_with(monkeypatch, scope):
    """Install a retriever into ``knowledge_search`` and neutralise its boot-time reach."""

    def install(retriever):
        monkeypatch.setattr("sources.knowledge_layer.src.register._get_retriever", lambda config: retriever)
        monkeypatch.setattr("sources.knowledge_layer.src.register._initialize_ingestor", lambda config, llm: None)
        monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
        monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
        return retriever

    return install


async def _exact(**kwargs) -> str:
    config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=True)
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(match="exact", **kwargs))


class TestExactSearch:
    async def test_every_matching_file_is_listed_and_the_passages_are_citable(self, search_with):
        store = search_with(
            _TextStore(
                [
                    _chunk("Grundriss_EG.pdf", "Tür T30-2 im Brandabschnitt BA-03", page=1, chunk_id="1"),
                    _chunk("Schnitt_A-A.pdf", "Trennwand zu BA-03, ba-03 Nord", page=4, chunk_id="2"),
                    _chunk("Leitfaden_Buero.pdf", "Beispiel BA-03", page=9, chunk_id="3", collection="archiv_1"),
                    _chunk("oib-rl_2.pdf", "BA-03 BA-03 BA-03", page=2, chunk_id="4", collection="oib_knowledge"),
                ]
            )
        )
        text = await _exact(query="BA-03")
        assert "Citation: Schnitt_A-A.pdf, p.4" in text
        assert "## Fundstellen für „BA-03“" in text
        assert "- Schnitt_A-A.pdf (Projektwissen): 2×, S. 4" in text
        assert "- Leitfaden_Buero.pdf (Büroablage): 1×, S. 9" in text
        # Same scope as the ranked search, but the reader's own files are listed first.
        table = text[text.index("## Fundstellen") :]
        assert table.index("Schnitt_A-A.pdf") < table.index("oib-rl_2.pdf")
        assert {call["collection"] for call in store.calls} == {"proj_1", "archiv_1", "oib_knowledge"}

    async def test_a_folder_narrows_to_the_files_filed_under_it(self, search_with):
        store = search_with(_TextStore([]))
        text = await _exact(query="BA-03", folder="Plaene")
        assert "Keine Fundstelle" in text
        assert [call["collection"] for call in store.calls] == ["proj_1"]
        assert store.calls[0]["filters"] == {
            "file_name": {"$in": ["Grundriss_EG.pdf", "Grundriss_OG1.pdf", "Schnitt_A-A.pdf"]}
        }

    async def test_a_narrowing_that_names_no_file_says_so(self, search_with):
        search_with(_TextStore([]))
        assert "list_files" in await _exact(query="BA-03", folder="Statik")

    async def test_an_unsupported_backend_says_so_instead_of_reporting_no_match(self, search_with):
        class _Ranked:
            async def find_text(self, *args, **kwargs):
                return None

        search_with(_Ranked())
        assert "nicht verfügbar" in await _exact(query="BA-03")

    async def test_too_short_a_phrase_is_refused(self, search_with):
        search_with(_TextStore([]))
        assert "at least" in await _exact(query="E")

    async def test_an_unknown_mode_is_refused(self, search_with):
        search_with(_TextStore([]))
        config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=True)
        async with knowledge_retrieval(config, MagicMock()) as info:
            out = await info.single_fn(info.input_schema(query="BA-03", match="fuzzy"))
        assert "`match` must be" in out


def test_the_exact_mode_is_never_withheld_as_a_repeat_of_the_ranked_one():
    from aiq_agent.common.turn_status import fetch_signature

    ranked = fetch_signature({"name": "knowledge_search", "args": {"query": "BA-03"}})
    exact = fetch_signature({"name": "knowledge_search", "args": {"query": "BA-03", "match": "exact"}})
    assert ranked != exact
    assert ranked == fetch_signature({"name": "knowledge_search", "args": {"query": "ba-03", "match": "meaning"}})


def test_the_store_query_finds_every_spelling_and_honours_a_file_filter():
    """Against a real Chroma: the `$regex` pattern and the file filter are what the store accepts."""
    chromadb = pytest.importorskip("chromadb")
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever

    client = chromadb.EphemeralClient()
    collection = client.get_or_create_collection(f"proj_{id(client)}")
    collection.add(
        ids=["a", "b", "c", "d"],
        documents=["Firma Müller liefert", "MUELLER haftet", "nichts", "Brandabschnitt BA-03"],
        metadatas=[
            {"file_name": "a.pdf", "page_label": "1"},
            {"file_name": "b.pdf", "page_label": "2"},
            {"file_name": "a.pdf", "page_label": "3"},
            {"file_name": "c.pdf", "page_label": "4"},
        ],
        embeddings=[[0.1, 0.2], [0.2, 0.1], [0.3, 0.3], [0.5, 0.1]],
    )
    retriever = LlamaIndexRetriever.__new__(LlamaIndexRetriever)
    retriever._chroma_client = client
    retriever._ensure_initialized = lambda: None

    found = retriever._find_text_sync(collection.name, phrase_pattern(["Müller"]), None, 50)
    assert sorted((chunk.file_name, chunk.page_number) for chunk in found) == [("a.pdf", 1), ("b.pdf", 2)]
    narrowed = retriever._find_text_sync(
        collection.name, phrase_pattern(["BA-03"]), {"file_name": {"$in": ["c.pdf"]}}, 50
    )
    assert [chunk.file_name for chunk in narrowed] == ["c.pdf"]
    assert retriever._find_text_sync("no_such_collection", "x", None, 5) == []


# ---------------------------------------------------------------------------
# Review regressions: each test failed before its fix.
# ---------------------------------------------------------------------------


@pytest.fixture
def turn_shelves(monkeypatch):
    """Restrict the turn to some shelves, as ``focus_file.set_turn_intent`` does for a focused turn."""

    def install(shelves):
        monkeypatch.setattr("aiq_agent.common.focus_file.get_turn_shelves", lambda: frozenset(shelves))

    return install


def _chroma_retriever():
    chromadb = pytest.importorskip("chromadb")
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever

    client = chromadb.EphemeralClient()
    retriever = LlamaIndexRetriever.__new__(LlamaIndexRetriever)
    retriever._chroma_client = client
    retriever._ensure_initialized = lambda: None
    return client, retriever


def _seed(client, name: str, rows: list[tuple[str, str, int, dict]]) -> None:
    collection = client.get_or_create_collection(name)
    collection.add(
        ids=[f"{name}-{index}" for index in range(len(rows))],
        documents=[row[1] for row in rows],
        metadatas=[{"file_name": row[0], "page_label": str(row[2]), **row[3]} for row in rows],
        embeddings=[[0.1, 0.2]] * len(rows),
    )


class TestExactSearchReadsTheBaseCorpusLikeTheRankedSearch:
    """An excluded edition and a cover page are not evidence in either mode."""

    @pytest.fixture
    def corpus(self, monkeypatch, search_with):
        import uuid

        client, retriever = _chroma_retriever()
        suffix = uuid.uuid4().hex[:8]
        base, project = f"base_{suffix}", f"proj_{suffix}"
        _seed(
            client,
            base,
            [
                ("oib-rl_2_2023.pdf", "Brandabschnitt EI 90 gilt", 3, {"chunking": "punkt"}),
                ("oib-rl_2_2019.pdf", "Brandabschnitt EI 90 alt", 4, {}),
                ("oib-rl_2_2023.pdf", "Deckblatt EI 90", 1, {"chunking": "page"}),
            ],
        )
        _seed(client, project, [("Notiz.docx", "Firma Müller, EI 90", 1, {})])
        monkeypatch.setattr(
            "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
            lambda: [ScopedCollection(base, Shelf.BASE), ScopedCollection(project, Shelf.PROJECT)],
        )
        search_with(retriever)
        set_turn_documents(
            [
                AvailableDocument(file_name="oib-rl_2_2023.pdf", collection=base, shelf="base"),
                AvailableDocument(file_name="oib-rl_2_2019.pdf", collection=base, shelf="base"),
                AvailableDocument(file_name="Notiz.docx", collection=project, shelf="project"),
            ]
        )
        return base

    async def _run(self, base: str, **kwargs) -> str:
        config = KnowledgeRetrievalConfig(
            collection_name=base, include_base_collection=True, exclude_file_names=["oib-rl_2_2019.pdf"]
        )
        async with knowledge_retrieval(config, MagicMock()) as info:
            return await info.single_fn(info.input_schema(match="exact", **kwargs))

    async def test_unnarrowed_search_drops_excluded_editions_and_page_chunks(self, corpus):
        text = await self._run(corpus, query="EI 90")
        assert "oib-rl_2_2019.pdf" not in text
        assert "- oib-rl_2_2023.pdf (Basiswissen): 1×, S. 3" in text
        assert "Deckblatt" not in text
        assert "Notiz.docx" in text  # user collections are never filtered

    async def test_narrowed_search_composes_the_file_list_with_the_base_filter(self, corpus):
        text = await self._run(corpus, query="EI 90", file_name="oib-rl_2")
        assert "oib-rl_2_2019.pdf" not in text
        assert "Deckblatt" not in text
        assert "- oib-rl_2_2023.pdf (Basiswissen): 1×, S. 3" in text

    async def test_the_callers_filters_reach_the_base_collection_only(self, search_with):
        store = search_with(_TextStore([]))
        await _exact(query="BA-03", filters={"doc_type": "richtlinie"})
        by_collection = {call["collection"]: call["filters"] for call in store.calls}
        assert by_collection["proj_1"] is None and by_collection["archiv_1"] is None
        assert {"doc_type": "richtlinie"} in by_collection["oib_knowledge"]["$and"]
        assert {"chunking": {"$ne": "page"}} in by_collection["oib_knowledge"]["$and"]


class _FailingStore(_TextStore):
    def __init__(self, chunks, failing: set[str]):
        super().__init__(chunks)
        self.failing = failing

    async def find_text(self, collection_name, pattern, filters=None, limit=500):
        if collection_name in self.failing:
            raise ConnectionError("chroma down")
        return await super().find_text(collection_name, pattern, filters, limit)


class TestAStoreOutageIsNeverANo:
    def test_the_adapter_raises_on_an_outage_and_answers_empty_for_a_missing_collection(self):
        _client, retriever = _chroma_retriever()
        assert retriever._find_text_sync("no_such_collection_xyz", "x", None, 5) == []

        class _Down:
            def get_collection(self, name):
                raise ConnectionError("chroma down")

        retriever._chroma_client = _Down()
        with pytest.raises(ConnectionError):
            retriever._find_text_sync("proj_1", "x", None, 5)

    async def test_every_collection_failing_says_the_search_did_not_run(self, search_with):
        search_with(_FailingStore([], {"proj_1", "archiv_1", "oib_knowledge"}))
        text = await _exact(query="BA-03")
        assert "konnte nicht laufen" in text
        assert "Keine Fundstelle" not in text and "belastbares Nein" not in text

    async def test_a_partial_failure_counts_only_what_answered_and_says_it_is_incomplete(self, search_with):
        search_with(_FailingStore([], {"archiv_1"}))
        text = await _exact(query="BA-03")
        assert "in 2 Sammlung(en)" in text
        assert "UNVOLLSTÄNDIG" in text and "archiv_1" in text
        assert "belastbares Nein" not in text

    async def test_a_partial_failure_beside_matches_flags_the_table(self, search_with):
        search_with(_FailingStore([_chunk("Grundriss_EG.pdf", "BA-03", page=1, chunk_id="1")], {"archiv_1"}))
        text = await _exact(query="BA-03")
        assert "- Grundriss_EG.pdf (Projektwissen): 1×" in text
        assert "UNVOLLSTÄNDIG" in text


class TestNarrowingLikeTheMeaningMode:
    async def test_a_file_name_without_its_extension_finds_the_file(self, search_with):
        set_turn_documents([*PROJECT, _doc("Notiz.docx")])
        store = search_with(_TextStore([]))
        text = await _exact(query="Müller", file_name="notiz")
        assert "No file in scope" not in text
        assert store.calls[0]["filters"] == {"file_name": {"$in": ["Notiz.docx"]}}

    async def test_the_display_title_still_narrows(self, search_with):
        store = search_with(_TextStore([]))
        await _exact(query="Müller", file_name="brandschutzkonzept muellerstrasse")
        assert store.calls[0]["filters"] == {"file_name": {"$in": ["Brandschutzkonzept.pdf"]}}

    async def test_a_narrowing_onto_a_shelf_the_turn_dropped_says_so(self, search_with, turn_shelves):
        turn_shelves({"archiv", "session", "base"})
        search_with(_TextStore([]))
        text = await _exact(query="BA-03", file_name="Grundriss_EG.pdf")
        assert "No file in scope matches that narrowing" in text


class TestListFilesHonoursTheTurn:
    async def _call(self, **kwargs) -> str:
        async with list_files(ListFilesConfig(), _builder()) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_a_turn_restricted_to_the_office_lists_the_office(self, scope, turn_shelves):
        turn_shelves({"archiv", "session", "base"})
        text = await self._call()
        assert "Leitfaden_Buero.pdf" in text
        assert "Grundriss_EG.pdf" not in text
        assert "1 Datei(en) auf Büroablage und Private Sitzung" in text

    async def test_a_restriction_that_would_leave_nothing_keeps_everything(self, scope, turn_shelves):
        set_turn_documents([_doc("Grundriss_EG.pdf", "Plaene")])
        turn_shelves({"session"})
        assert "Grundriss_EG.pdf" in await self._call()


def test_the_pattern_reverses_the_transliteration_and_bounds_its_length():
    import re

    assert re.search(phrase_pattern(["MUELLER"]), "Firma Müller") and re.search(phrase_pattern(["Strasse"]), "Straße")
    assert re.search(phrase_pattern(["müller strasse"]), "MÜLLER STRASSE")
    assert phrase_pattern(["ä" * 2000]) is None


def test_the_store_finds_the_umlaut_form_of_a_transliterated_phrase():
    import uuid

    client, retriever = _chroma_retriever()
    name = f"rev_{uuid.uuid4().hex[:8]}"
    _seed(client, name, [("a.pdf", "Firma Müller, Müllerstraße 3", 1, {}), ("b.pdf", "Müller Straße", 2, {})])

    def files(phrase: str) -> set[str]:
        return {chunk.file_name for chunk in retriever._find_text_sync(name, phrase_pattern([phrase]), None, 5)}

    assert files("MUELLER") == {"a.pdf", "b.pdf"}
    assert files("Strasse") == {"a.pdf", "b.pdf"}
    assert files("müller strasse") == {"b.pdf"}


# ---------------------------------------------------------------------------
# Review regressions: false „belastbares Nein“ from the byte-exact `$contains`.
# ---------------------------------------------------------------------------

#: One chunk per spelling a real PDF text layer carries.
_ORIGINALS = [
    ("oib.pdf", "Laut OIB-Richtlinie 2 gilt"),
    ("firma.pdf", "Firma Huber GmbH liefert"),
    ("umbruch.pdf", "im Brandabschnitt\n3 liegt"),
    ("nbsp.pdf", "Decke EI\u00a090 gefordert"),
    ("doppelt.pdf", "Wand EI  90 und T30"),
    ("mueller.pdf", "Firma Müller, Straße 3"),
    ("wege.pdf", "Weg und Steg nach der Regel"),
    ("geschoss.pdf", "Technikraum im EG, Schacht"),
    ("plan.pdf", "Der Brandschutzplan liegt vor"),
]


@pytest.fixture(scope="module")
def originals_store():
    import uuid

    client, retriever = _chroma_retriever()
    name = f"orig_{uuid.uuid4().hex[:8]}"
    _seed(client, name, [(file_name, text, 1, {}) for file_name, text in _ORIGINALS])
    return name, retriever


class TestTheStoreFindsWhatAPersonWouldFind:
    """Against a real Chroma: the store's `$regex` and the Python re-check agree on each case."""

    @pytest.fixture
    def store(self, originals_store):
        return originals_store

    def _files(self, store, query: str) -> set[str]:
        name, retriever = store
        pattern = phrase_pattern(split_alternatives(query))
        found = retriever._find_text_sync(name, pattern, None, 50)
        # What the store returned is what the Python side counts: no chunk is fetched and then dropped.
        assert all(group.occurrences for group in group_matches(found, pattern))
        return {chunk.file_name for chunk in found}

    @pytest.mark.parametrize(
        ("query", "expected"),
        [
            ("oib-richtlinie", {"oib.pdf"}),
            ("OIB Richtlinie", {"oib.pdf"}),
            ("gmbh", {"firma.pdf"}),
            ("Brandabschnitt 3", {"umbruch.pdf"}),
            ("EI 90", {"nbsp.pdf", "doppelt.pdf"}),
            ("MUELLER", {"mueller.pdf"}),
            ("Strasse", {"mueller.pdf"}),
            ("EG", {"geschoss.pdf"}),
        ],
    )
    def test_a_differently_written_original_is_found(self, store, query, expected):
        assert self._files(store, query) == expected

    def test_a_short_term_is_a_whole_word_not_part_of_weg_or_steg(self, store):
        assert "wege.pdf" not in self._files(store, "EG")
        assert self._files(store, "Weg") == {"wege.pdf"}

    def test_overlapping_alternatives_count_one_occurrence_once(self, store):
        name, retriever = store
        pattern = phrase_pattern(split_alternatives("Brandschutz | Brandschutzplan"))
        groups = group_matches(retriever._find_text_sync(name, pattern, None, 50), pattern)
        assert [(group.file_name, group.occurrences) for group in groups] == [("plan.pdf", 1)]


def test_overlapping_alternatives_are_counted_once_in_python_too():
    chunk = _chunk("a.pdf", "Brandschutzplan und Brandschutz", page=1, chunk_id="1")
    for query in ("Brandschutz | Brandschutzplan", "Brandschutzplan | Brandschutz"):
        [group] = group_matches([chunk], phrase_pattern(split_alternatives(query)))
        assert group.occurrences == 2


def test_the_no_says_what_it_tolerated_and_that_a_short_term_is_a_whole_word():
    text = no_match_message(["EG", "Brandschutzplan"], 3)
    assert "Zeilenumbruch" in text and "ß/ss" in text
    assert "„EG“ nur als ganzes Wort" in text
    assert "Brandschutzplan“ nur als ganzes Wort" not in text


async def test_a_query_too_long_for_one_pattern_is_refused(search_with):
    store = search_with(_TextStore([]))
    query = " | ".join(f"Müllerstraße Brandabschnitt Süd {index} " * 8 for index in range(6))
    assert "too long" in await _exact(query=query)
    assert store.calls == []


class TestAShelfTheTurnRemoved:
    async def _call(self, **kwargs) -> str:
        async with list_files(ListFilesConfig(), _builder()) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_an_explicit_shelf_outside_the_selection_says_so_instead_of_no_files(self, scope, turn_shelves):
        turn_shelves({"archiv", "session", "base"})
        text = await self._call(shelf="project")
        assert "Keine Datei" not in text
        assert "auf Büroablage, Private Sitzung und Basiswissen beschränkt" in text
        assert "Projektwissen hier nicht gelistet" in text
        assert "Grundriss_EG.pdf" not in text

    async def test_an_explicit_shelf_inside_the_selection_still_lists(self, scope, turn_shelves):
        turn_shelves({"archiv", "session", "base"})
        assert "Leitfaden_Buero.pdf" in await self._call(shelf="archiv")
