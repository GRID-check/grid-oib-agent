"""`list_files(fassungen_of=…)` renders one document's whole chain of Fassungen, newest first.

The questions it answers are „Welche Fassungen gibt es von X?“ and „Was hat sich zwischen Index B und C
geändert?“. The chain is joined two ways, a link a PERSON confirmed (`superseded_by`, across file
names) and the file name's own series (Index, Datum), and it reads only the rows and shelves the
turn may list: another shelf, a restricted folder's collection, or a file that is not in the
inventory is not in it. The change line is stored on the NEWER file and compares against a named basis.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.browse import _LIST_FILES_DESCRIPTION
from sources.knowledge_layer.src.browse import MAX_CHAIN_CHANGE_CHARS
from sources.knowledge_layer.src.browse import MAX_CHAIN_LINES
from sources.knowledge_layer.src.browse import ListFilesConfig
from sources.knowledge_layer.src.browse import file_rows
from sources.knowledge_layer.src.browse import list_files
from sources.knowledge_layer.src.browse import render_fassungen
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig


def _doc(name: str, *, shelf: str = "project", **extra) -> AvailableDocument:
    return AvailableDocument(
        file_name=name,
        collection="proj_1" if shelf == "project" else f"{shelf}_1",
        shelf=shelf,
        summary=f"Zusammenfassung von {name}",
        added_at=extra.pop("added_at", "2026-08-01"),
        **extra,
    )


def _grundriss():
    """The first state, Index B, and Index C with its change line."""
    return file_rows(
        [
            _doc("EG_Grundriss.pdf", added_at="2026-07-01"),
            _doc("EG_Grundriss_Index_B.pdf", added_at="2026-08-10"),
            _doc(
                "EG_Grundriss_Index_C_2026-08-14.pdf",
                added_at="2026-08-15",
                change_summary="- Wand in Achse 3 um 12 cm versetzt\n- Tür T3 neu",
                change_basis="EG_Grundriss_Index_B.pdf",
            ),
            _doc("Schnitt_AA.pdf"),
        ]
    )


def _numbered(text: str) -> list[str]:
    """The chain's lines: `1. name · …`."""
    return [line for line in text.splitlines() if line[:1].isdigit() and ". " in line[:4]]


def _names(text: str) -> list[str]:
    return [line.split(". ", 1)[1].split(" · ")[0] for line in _numbered(text)]


class TestTheChain:
    def test_it_lists_every_fassung_newest_first_whichever_one_is_named(self):
        for asked in ("EG_Grundriss.pdf", "EG_Grundriss_Index_B.pdf", "EG_Grundriss_Index_C_2026-08-14.pdf"):
            assert _names(render_fassungen(_grundriss(), asked)) == [
                "EG_Grundriss_Index_C_2026-08-14.pdf",
                "EG_Grundriss_Index_B.pdf",
                "EG_Grundriss.pdf",
            ]

    def test_each_line_carries_the_index_and_date_read_from_the_name_and_the_upload_date(self):
        lines = _numbered(render_fassungen(_grundriss(), "EG_Grundriss_Index_B.pdf"))

        assert "Index C · 14.08.2026" in lines[0] and "hochgeladen 2026-08-15" in lines[0]
        assert "Index B" in lines[1] and "hochgeladen 2026-08-10" in lines[1]
        assert "kein Index und kein Datum im Namen" in lines[2]

    def test_the_change_line_sits_on_the_newer_fassung_and_names_what_it_compares_against(self):
        lines = _numbered(render_fassungen(_grundriss(), "EG_Grundriss_Index_B.pdf"))

        assert "geändert gegenüber EG_Grundriss_Index_B.pdf: Wand in Achse 3 um 12 cm versetzt; Tür T3 neu" in lines[0]
        assert "keine Änderungsangabe gespeichert" in lines[1]

    def test_the_current_fassung_is_marked_and_a_name_reading_is_said_to_be_one(self):
        lines = _numbered(render_fassungen(_grundriss(), "EG_Grundriss.pdf"))

        assert "aktuelle Fassung (dem Namen nach)" in lines[0]
        assert "ältere Fassung (dem Namen nach)" in lines[1]

    def test_a_different_document_is_not_in_the_chain(self):
        assert "Schnitt_AA.pdf" not in render_fassungen(_grundriss(), "EG_Grundriss.pdf")

    def test_a_pdf_and_a_dwg_of_one_fassung_are_not_versions_of_each_other(self):
        rows = file_rows([_doc("Plan_Index_A.pdf"), _doc("Plan_Index_B.pdf"), _doc("Plan_Index_B.dwg")])

        assert _names(render_fassungen(rows, "Plan_Index_A.pdf")) == ["Plan_Index_B.pdf", "Plan_Index_A.pdf"]

    def test_the_change_is_long_enough_to_answer_from_and_still_bounded(self):
        rows = file_rows(
            [
                _doc("P_Index_A.pdf"),
                _doc("P_Index_B.pdf", change_summary="- " + "x" * 2000, change_basis="P_Index_A.pdf"),
            ]
        )

        line = _numbered(render_fassungen(rows, "P_Index_A.pdf"))[0]
        change = line.split("geändert gegenüber P_Index_A.pdf: ")[1].split(" · ")[0]
        assert 160 < len(change) <= MAX_CHAIN_CHANGE_CHARS and change.endswith("…")

    def test_a_long_chain_is_counted_not_dumped(self):
        names = [f"Plan_Index_{n}.pdf" for n in range(1, MAX_CHAIN_LINES + 6)]
        text = render_fassungen(file_rows([_doc(name) for name in names]), names[0])

        assert len(_numbered(text)) == MAX_CHAIN_LINES
        assert "und 5 weitere, ältere Fassungen" in text


class TestAConfirmedLinkAcrossFileNames:
    def _rows(self):
        return file_rows(
            [
                _doc("Statik alt.pdf", superseded_by="Statik neu.pdf"),
                _doc(
                    "Statik neu.pdf",
                    superseded_by="Statik final.pdf",
                    change_summary="- Bewehrung 12 mm",
                    change_basis="Statik alt.pdf",
                ),
                _doc("Statik final.pdf", change_summary="- Lift neu", change_basis="Statik neu.pdf"),
                _doc("Baubeschreibung.pdf"),
            ]
        )

    def test_it_joins_files_that_share_no_name_and_orders_them_by_the_links(self):
        for asked in ("Statik alt.pdf", "Statik neu.pdf", "Statik final.pdf"):
            assert _names(render_fassungen(self._rows(), asked)) == [
                "Statik final.pdf",
                "Statik neu.pdf",
                "Statik alt.pdf",
            ]

    def test_it_says_which_links_a_person_confirmed(self):
        lines = _numbered(render_fassungen(self._rows(), "Statik alt.pdf"))

        assert "ersetzt Statik neu.pdf (bestätigt)" in lines[0]
        assert (
            "ersetzt durch Statik final.pdf (bestätigt)" in lines[1]
            and "ersetzt Statik alt.pdf (bestätigt)" in lines[1]
        )
        assert "ersetzt durch Statik neu.pdf (bestätigt)" in lines[2]
        assert "geändert gegenüber Statik neu.pdf: Lift neu" in lines[0]

    def test_a_confirmed_link_beats_what_the_names_say(self):
        rows = file_rows(
            [
                _doc("Grundriss_Index_B.pdf", superseded_by="Grundriss_Index_A.pdf"),
                _doc("Grundriss_Index_A.pdf"),
            ]
        )

        assert _names(render_fassungen(rows, "Grundriss_Index_A.pdf")) == [
            "Grundriss_Index_A.pdf",
            "Grundriss_Index_B.pdf",
        ]

    def test_a_link_to_a_file_outside_the_rows_joins_nothing(self):
        text = render_fassungen(file_rows([_doc("alt.pdf", superseded_by="weg.pdf")]), "alt.pdf")

        assert "nur diese eine Fassung" in text
        assert "weg.pdf" not in text

    def test_a_loop_the_store_refuses_still_terminates(self):
        rows = file_rows([_doc("a.pdf", superseded_by="b.pdf"), _doc("b.pdf", superseded_by="a.pdf")])

        assert sorted(_names(render_fassungen(rows, "a.pdf"))) == ["a.pdf", "b.pdf"]

    def test_the_chain_crosses_folders(self):
        rows = file_rows(
            [
                _doc("Statik alt.pdf", folder_path="alt", superseded_by="Statik neu.pdf"),
                _doc("Statik neu.pdf", folder_path="Statik"),
            ]
        )

        assert len(_names(render_fassungen(rows, "Statik neu.pdf"))) == 2


class TestTheTitleBlock:
    """Two files whose Plankopf prints the same number are Fassungen of one document, whatever their names say."""

    def _rows(self):
        return file_rows(
            [
                _doc("Schnitt final.pdf", revision_facts={"document_number": "A-201", "revision": "D"}),
                _doc(
                    "Schnitt Entwurf.pdf",
                    revision_facts={"document_number": "a 201", "revision": "C", "revision_date": "2026-05-02"},
                ),
                _doc("Schnitt anders.pdf", revision_facts={"document_number": "A-999", "revision": "A"}),
            ]
        )

    def test_files_that_share_no_name_are_joined_on_the_plan_number(self):
        assert _names(render_fassungen(self._rows(), "Schnitt Entwurf.pdf")) == [
            "Schnitt final.pdf",
            "Schnitt Entwurf.pdf",
        ]

    def test_the_sheet_decides_which_is_newer_and_the_line_says_so(self):
        lines = _numbered(render_fassungen(self._rows(), "Schnitt final.pdf"))

        assert "aktuelle Fassung (laut Plankopf)" in lines[0] and "ältere Fassung (laut Plankopf)" in lines[1]
        assert "Plankopf: Nr. a 201, Index C, Stand 02.05.2026" in lines[1]

    def test_the_sheet_beats_the_index_in_the_name(self):
        rows = file_rows(
            [
                _doc("Plan_Index_A.pdf", revision_facts={"document_number": "B-100", "revision": "C"}),
                _doc("Plan_Index_B.pdf", revision_facts={"document_number": "B-100", "revision": "A"}),
            ]
        )

        assert _names(render_fassungen(rows, "Plan_Index_B.pdf")) == ["Plan_Index_A.pdf", "Plan_Index_B.pdf"]

    def test_a_chain_without_complete_sheets_falls_back_to_the_names(self):
        rows = file_rows(
            [
                _doc("Plan_Index_A.pdf", revision_facts={"document_number": "B-100", "revision": "C"}),
                _doc("Plan_Index_B.pdf"),
            ]
        )

        text = render_fassungen(rows, "Plan_Index_B.pdf")
        assert _names(text) == ["Plan_Index_B.pdf", "Plan_Index_A.pdf"]
        assert "dem Namen nach" in text and "laut Plankopf" not in text


class TestAskingForTheName:
    def test_an_exact_name_is_found_whatever_its_case(self):
        rows = file_rows([_doc("Plan.pdf"), _doc("Plan_Index_B.pdf"), _doc("Plan_Index_C.pdf")])

        assert _names(render_fassungen(rows, "plan.PDF")) == ["Plan_Index_C.pdf", "Plan_Index_B.pdf", "Plan.pdf"]

    def test_the_title_a_reader_sees_finds_the_document_too(self):
        rows = file_rows([_doc("a_Index_A.pdf", display_title="Grundriss EG"), _doc("a_Index_B.pdf")])

        assert _names(render_fassungen(rows, "Grundriss EG")) == ["a_Index_B.pdf", "a_Index_A.pdf"]

    def test_the_words_of_a_name_find_the_document_whatever_the_umlaut_spelling(self):
        rows = file_rows([_doc("Müller_Statik_Index_A.pdf"), _doc("Müller_Statik_Index_B.pdf")])

        assert len(_names(render_fassungen(rows, "mueller statik"))) == 2

    def test_a_name_that_matches_two_documents_asks_for_the_exact_one(self):
        text = render_fassungen(_grundriss(), "pdf")

        assert "2 verschiedenen Dokumenten" in text
        assert "fassungen_of=" in text and not _numbered(text)

    def test_a_name_that_matches_nothing_points_at_the_name_filter(self):
        text = render_fassungen(_grundriss(), "Fundament")

        assert "name_contains" in text and not _numbered(text)

    def test_a_document_with_no_other_fassung_says_so_and_shows_its_one_line(self):
        text = render_fassungen(_grundriss(), "Schnitt_AA.pdf")

        assert "nur diese eine Fassung" in text
        assert _names(text) == ["Schnitt_AA.pdf"]

    def test_a_reupload_under_the_same_name_is_told_apart_from_another_file(self):
        rows = file_rows([_doc("Statik.pdf", change_summary="- Lift neu", change_basis="Statik.pdf")])

        line = _numbered(render_fassungen(rows, "Statik.pdf"))[0]
        assert "vorigen Hochladung (gleicher Dateiname): Lift neu" in line


class TestOnlyWhatTheTurnMayList:
    def _rows(self):
        return file_rows(
            [
                _doc("Plan_Index_A.pdf"),
                _doc("Plan_Index_B.pdf"),
                _doc("Plan_Index_C.pdf", shelf="archiv"),
                _doc("Plan_Index_D.pdf", shelf="base"),
            ]
        )

    def test_a_fassung_on_another_collection_is_not_joined(self):
        assert _names(render_fassungen(self._rows(), "Plan_Index_A.pdf")) == ["Plan_Index_B.pdf", "Plan_Index_A.pdf"]

    def test_the_base_corpus_is_listed_only_when_asked_for(self):
        assert not _numbered(render_fassungen(self._rows(), "Plan_Index_D.pdf"))
        assert _names(render_fassungen(self._rows(), "Plan_Index_D.pdf", shelf="base")) == ["Plan_Index_D.pdf"]

    def test_a_turn_restricted_to_one_shelf_chains_only_that_shelf(self):
        text = render_fassungen(self._rows(), "Plan_Index_C.pdf", default_shelves=("archiv",))

        assert _names(text) == ["Plan_Index_C.pdf"]


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
        lambda: [ScopedCollection("proj_1", Shelf.PROJECT), ScopedCollection("archiv_1", Shelf.ARCHIV)],
    )
    monkeypatch.setattr("aiq_agent.knowledge.ingest_status_store.in_flight_files", lambda collections: {})
    set_turn_documents(
        [
            _doc("Plan_Index_A.pdf"),
            _doc("Plan_Index_B.pdf", change_summary="- Wand neu", change_basis="Plan_Index_A.pdf"),
            _doc("Plan_Index_A.pdf", shelf="archiv"),
        ]
    )
    yield
    set_turn_documents(None)


class TestTheTool:
    async def _call(self, **kwargs) -> str:
        async with list_files(ListFilesConfig(), _builder()) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_the_argument_is_in_the_schema(self, scope):
        async with list_files(ListFilesConfig(), _builder()) as info:
            assert "fassungen_of" in info.input_schema.model_fields

    async def test_it_returns_the_chain_instead_of_a_listing(self, scope):
        text = await self._call(fassungen_of="Plan_Index_A.pdf", shelf="project")

        assert _names(text) == ["Plan_Index_B.pdf", "Plan_Index_A.pdf"]
        assert "geändert gegenüber Plan_Index_A.pdf: Wand neu" in text
        assert "Datei(en) auf" not in text

    async def test_every_other_filter_is_ignored(self, scope):
        text = await self._call(
            fassungen_of="Plan_Index_A.pdf",
            shelf="project",
            folder="gibt-es-nicht",
            doc_class="ungueltig",
            sort="egal",
            added_since="gestern",
        )

        assert _names(text) == ["Plan_Index_B.pdf", "Plan_Index_A.pdf"]

    async def test_a_name_on_two_shelves_is_two_documents_and_is_not_merged(self, scope):
        text = await self._call(fassungen_of="Plan_Index_A.pdf")

        assert "2 verschiedenen Dokumenten" in text

    async def test_a_shelf_the_turn_did_not_ask_for_is_refused_as_the_listing_does(self, scope, monkeypatch):
        monkeypatch.setattr("aiq_agent.common.focus_file.get_turn_shelves", lambda: frozenset({"project"}))

        text = await self._call(fassungen_of="Plan_Index_A.pdf", shelf="archiv")

        assert "beschränkt" in text and not _numbered(text)

    async def test_a_restricted_folders_fassung_is_not_named(self, scope):
        restricted = "proj_1_r0123456789ab"
        set_turn_documents(
            [
                _doc("Gehalt_Index_A.pdf"),
                AvailableDocument(file_name="Gehalt_Index_B.pdf", collection=restricted, shelf="project"),
            ]
        )

        text = await self._call(fassungen_of="Gehalt_Index_A.pdf", shelf="project")

        assert _names(text) == ["Gehalt_Index_A.pdf"]
        assert "Gehalt_Index_B.pdf" not in text

    async def test_a_blank_argument_is_an_ordinary_listing(self, scope):
        text = await self._call(fassungen_of="  ", shelf="project")

        assert "2 Datei(en) auf Projektwissen" in text

    def test_the_description_says_when_to_call_it(self):
        assert "fassungen_of" in _LIST_FILES_DESCRIPTION
        assert "Index B und C" in _LIST_FILES_DESCRIPTION


def _page(file_name: str, n: int, text: str):
    from sources.knowledge_layer.tests.qdrant_testing import record

    return record(text, file_name, page_label=str(n), content_type="text")


@pytest.fixture
def stored(monkeypatch, qdrant_store):  # noqa: ARG001 - the store the compare reads
    """Index A and Index B as the index holds them, in a real Qdrant: one value moved on page 2."""
    from sources.knowledge_layer.tests.qdrant_testing import write

    write(
        "proj_1",
        [
            _page("Plan_Index_A.pdf", 1, "Deckblatt"),
            _page("Plan_Index_A.pdf", 2, "Fluchtweglänge 38 m"),
            _page("Plan_Index_B.pdf", 1, "Deckblatt"),
            _page("Plan_Index_B.pdf", 2, "Fluchtweglänge 42 m"),
        ],
    )
    noted: list[set[str]] = []
    monkeypatch.setattr(
        "aiq_agent.knowledge.restricted_use.note_collections_read", lambda collections: noted.append(set(collections))
    )
    return noted


class TestComparing:
    """`compare_to` turns the chain into a compare of two of its Fassungen (ADR-0104)."""

    async def _call(self, **kwargs) -> str:
        async with list_files(ListFilesConfig(), _builder()) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_the_previous_fassung_by_default_says_what_moved(self, scope, stored):
        text = await self._call(fassungen_of="Plan_Index_B.pdf", compare_to="vorige", shelf="project")

        assert "„Plan_Index_A.pdf“ (älter) → „Plan_Index_B.pdf“ (neuer)" in text
        assert "Seite 2: Werte: Fluchtweglänge 38 m → 42 m." in text
        # The stored change line was written against exactly this older file, so it rides along.
        assert "Wand neu" in text

    async def test_the_order_follows_the_chain_not_the_arguments(self, scope, stored):
        text = await self._call(fassungen_of="Plan_Index_A.pdf", compare_to="Plan_Index_B.pdf", shelf="project")
        assert "„Plan_Index_A.pdf“ (älter) → „Plan_Index_B.pdf“ (neuer)" in text

    async def test_reading_both_files_is_reported_for_the_admission(self, scope, stored):
        await self._call(fassungen_of="Plan_Index_B.pdf", compare_to="vorige", shelf="project")
        assert stored == [{"proj_1"}]

    async def test_a_file_outside_the_chain_is_refused_with_the_chain(self, scope, stored):
        text = await self._call(fassungen_of="Plan_Index_B.pdf", compare_to="Schnitt.pdf", shelf="project")
        assert "ist keine Fassung dieses Dokuments" in text
        assert "Plan_Index_A.pdf" in text
        assert stored == []

    async def test_a_document_with_one_fassung_has_nothing_to_compare(self, scope, stored):
        text = await self._call(fassungen_of="Plan_Index_A.pdf", compare_to="vorige", shelf="archiv")
        assert "nichts zu vergleichen" in text

    async def test_identical_fassungen_with_several_chunks_on_a_page_compare_as_unchanged(
        self,
        scope,
        qdrant_store,  # noqa: ARG002
    ):
        """Point ids are random node ids, so only the chunk's place in the file orders a page's chunks.

        One chunk per page (the fixture above) cannot see a shuffled page; the
        Sentence splitter cuts several from a real one.
        """
        from sources.knowledge_layer.tests.qdrant_testing import write

        lines = [f"Zeile {i}: Brandabschnitt {i} hat Feuerwiderstand REI {30 + i}" for i in range(8)]
        for name in ("Plan_Index_A.pdf", "Plan_Index_B.pdf"):
            records = [_page(name, 1, line) for line in lines]
            for ordinal, record in enumerate(records):
                record.ordinal = ordinal
            write("proj_1", records)

        text = await self._call(fassungen_of="Plan_Index_B.pdf", compare_to="vorige", shelf="project")

        assert "Seiten: 1 → 1; 1 unverändert, 0 geändert." in text
        assert "Im gelesenen Inhalt unterscheiden sich die beiden Dateien nicht." in text

    async def test_an_unreachable_index_is_said_as_one_never_as_not_in_the_index(self, scope, stored, monkeypatch):
        from knowledge_layer.qdrant import store as store_module

        from aiq_agent.common.turn_status import FETCH_FAILED_MARKER

        def down(*_args, **_kwargs):
            raise ConnectionError("qdrant down")

        monkeypatch.setattr(store_module.QdrantStore, "scroll", down)

        text = await self._call(fassungen_of="Plan_Index_B.pdf", compare_to="vorige", shelf="project")

        assert text.startswith(FETCH_FAILED_MARKER)
        assert "nicht erreichbar" in text
        assert "nicht im Index" not in text
        assert stored == []

    async def test_a_file_the_index_does_not_hold_is_said_not_compared(self, scope, qdrant_store):  # noqa: ARG002
        text = await self._call(fassungen_of="Plan_Index_B.pdf", compare_to="vorige", shelf="project")
        assert "nicht im Index" in text
