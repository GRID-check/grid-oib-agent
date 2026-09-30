"""The file browser and the project-wide phrase search.

``list_files`` and ``find_in_files`` exist because the agent could see only the
first fifty names of a project and could only find what ranked in a top-k
similarity search. These tests pin what makes them the Files pane and Ctrl+F:

* the listing is complete (no cap), filtered and paged, with the subfolders;
* the phrase search returns EVERY matching file with its count, matching case
  and umlaut spellings, and its passages are citable grounding hits;
* neither reads beyond the turn's scope, and neither guesses.
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
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.browse import FindInFilesConfig
from sources.knowledge_layer.src.browse import ListFilesConfig
from sources.knowledge_layer.src.browse import file_rows
from sources.knowledge_layer.src.browse import find_in_files
from sources.knowledge_layer.src.browse import group_matches
from sources.knowledge_layer.src.browse import list_files
from sources.knowledge_layer.src.browse import pick_passages
from sources.knowledge_layer.src.browse import render_listing
from sources.knowledge_layer.src.browse import select_files
from sources.knowledge_layer.src.browse import spellings
from sources.knowledge_layer.src.browse import split_alternatives
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig


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
        assert "2 Datei(en) auf Projektwissen und Büroarchiv und Private Sitzung" in text
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
        assert split_alternatives(" BA-03 | BA 03 |x| BA-03 ") == ["BA-03", "BA 03"]

    def test_spellings_cover_case_and_umlaut_transliteration(self):
        tried = spellings("Müller")
        assert {"Müller", "müller", "MÜLLER", "Mueller", "MUELLER"} <= set(tried)

    def test_candidates_are_rechecked_and_counted_per_file(self):
        chunks = [
            _chunk("a.pdf", "Firma MUELLER liefert; Müller haftet", page=2, chunk_id="1"),
            _chunk("b.pdf", "Die Firma Müller", page=5, chunk_id="2"),
            _chunk("b.pdf", "Müllerstraße 3, Firma Müller", page=1, chunk_id="3"),
            _chunk("c.pdf", "nichts davon", page=1, chunk_id="4"),
        ]
        groups = group_matches(chunks, ["Müller"])
        assert [(group.file_name, group.occurrences) for group in groups] == [("b.pdf", 3), ("a.pdf", 2)]
        assert groups[0].pages == [1, 5]

    def test_passages_round_robin_across_files(self):
        groups = group_matches(
            [
                _chunk("a.pdf", "X", page=1, chunk_id="1"),
                _chunk("a.pdf", "X", page=2, chunk_id="2"),
                _chunk("b.pdf", "X", page=1, chunk_id="3"),
            ],
            ["X"],
        )
        assert [chunk.chunk_id for chunk in pick_passages(groups, limit=2)] == ["1", "3"]


class _TextStore:
    def __init__(self, chunks):
        self.chunks = chunks
        self.calls: list[dict] = []

    async def find_text(self, collection_name, spellings, filters=None, limit=500):
        self.calls.append({"collection": collection_name, "spellings": spellings, "filters": filters})
        return [chunk for chunk in self.chunks if chunk.metadata["collection"] == collection_name]


class TestFindInFilesTool:
    async def _call(self, **kwargs) -> str:
        async with find_in_files(FindInFilesConfig(), _builder()) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_every_matching_file_is_listed_and_the_passages_are_citable(self, scope, monkeypatch):
        store = _TextStore(
            [
                _chunk("Grundriss_EG.pdf", "Tür T30-2 im Brandabschnitt BA-03", page=1, chunk_id="1"),
                _chunk("Schnitt_A-A.pdf", "Trennwand zu BA-03, ba-03 Nord", page=4, chunk_id="2"),
                _chunk("Leitfaden_Buero.pdf", "Beispiel BA-03", page=9, chunk_id="3", collection="archiv_1"),
            ]
        )
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: store)
        text = await self._call(text="BA-03")
        assert "Citation: Schnitt_A-A.pdf, p.4" in text
        assert "## Fundstellen für „BA-03“" in text
        assert "- Schnitt_A-A.pdf (Projektwissen): 2×, S. 4" in text
        assert "- Leitfaden_Buero.pdf (Büroarchiv): 1×, S. 9" in text
        # The reader's own shelves only: the base corpus is never asked.
        assert {call["collection"] for call in store.calls} == {"proj_1", "archiv_1"}

    async def test_a_folder_narrows_to_the_files_filed_under_it(self, scope, monkeypatch):
        store = _TextStore([])
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: store)
        text = await self._call(text="BA-03", folder="Plaene")
        assert "Keine Fundstelle" in text
        assert [call["collection"] for call in store.calls] == ["proj_1"]
        assert sorted(store.calls[0]["filters"]["file_name"]["$in"]) == [
            "Grundriss_EG.pdf",
            "Grundriss_OG1.pdf",
            "Schnitt_A-A.pdf",
        ]

    async def test_an_unsupported_backend_says_so_instead_of_reporting_no_match(self, scope, monkeypatch):
        backend = SimpleNamespace(find_text=None)

        async def _unsupported(*args, **kwargs):
            return None

        backend.find_text = _unsupported
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: backend)
        assert "nicht verfügbar" in await self._call(text="BA-03")

    async def test_too_short_a_phrase_is_refused(self, scope):
        assert "at least" in await self._call(text="E")
