"""The title block (Plankopf) read during ingestion: index and date from the sheet, not from the name.

feld72 asked for exactly this („Index und Datum aus dem Plankopf auslesen"). The drawing analysis
carries ``document.title_block`` in the SAME vision call as everything else; the first drawing page
with a title block gives the document its ``revision_facts``; the store keeps them in an optional
column; the collection listing, ``list_files`` and the Fassung judge read them.

Covered here: the reply parsing (with and without a title block, through a fake client), the
chunk round trip and the page rule, the store round trip and its migration, the Fassung suggestion
decided by the number, and the ``list_files`` row and marks.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import fassungen
from knowledge_layer.llamaindex import visual_analysis as va
from knowledge_layer.llamaindex import visual_domains as vd

from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.schema import AvailableDocument
from sources.knowledge_layer.src.browse import file_row
from sources.knowledge_layer.src.browse import file_rows
from sources.knowledge_layer.src.browse import render_listing
from sources.knowledge_layer.src.browse import select_files


@pytest.fixture
def registry():
    return vd.resolve_registry("architecture,general")


FULL_BLOCK = {
    "document_number": "A-101",
    "revision": "C",
    "revision_date": "2026-08-14",
    "scale": "1:100",
    "title": "Grundriss Erdgeschoss",
}


def _reply(title_block=None, *, document=None):
    """A model reply: one floor plan, and the document facts with the given title block (or none at all)."""
    body = {
        "segments": [{"domain": "architecture", "segment_type": "floor_plan", "title": "EG", "summary": "Grundriss."}],
        "document": {"title": "Wohnbau Nord", "summary": "Ein Plan.", **(document or {})},
    }
    if title_block is not None:
        body["document"]["title_block"] = title_block
    return json.dumps(body)


# ---------------------------------------------------------------------------
# The vision call: one schema, one prompt, one response
# ---------------------------------------------------------------------------


class TestTheSchemaAndPrompt:
    def test_the_title_block_is_part_of_the_one_document_object_in_the_strict_subset(self, registry):
        document = va.json_schema(registry)["properties"]["document"]
        block = document["properties"]["title_block"]

        assert list(block["properties"]) == ["document_number", "revision", "revision_date", "scale", "title"]
        assert block["additionalProperties"] is False and set(block["required"]) == set(block["properties"])
        assert all(prop["type"] == ["string", "null"] for prop in block["properties"].values())

    def test_the_prompt_asks_for_it_in_the_same_call_and_forbids_guessing(self, registry):
        prompt = va.build_prompt(registry)

        for token in ("title_block", "document_number", "revision_date", "PLANKOPF", "LAST (newest) row"):
            assert token in prompt
        assert "null" in prompt and "Never guess" in prompt
        assert len(prompt) < 12000

    def test_a_changed_schema_does_not_serve_a_reading_cached_without_the_title_block(self, registry):
        assert va.SCHEMA_VERSION >= 5
        assert va.cache_prompt_type(registry).startswith(f"visual:v{va.SCHEMA_VERSION}:")


class TestParsingTheReply:
    def test_a_reply_with_a_title_block_yields_the_five_facts(self, registry):
        analysis = va.parse_visual_analysis(_reply(FULL_BLOCK), registry)

        assert analysis["document"]["title_block"] == FULL_BLOCK

    def test_a_reply_without_one_has_none_not_empty_strings(self, registry):
        assert va.parse_visual_analysis(_reply(), registry)["document"]["title_block"] is None
        nothing = {key: None for key in FULL_BLOCK}
        assert va.parse_visual_analysis(_reply(nothing), registry)["document"]["title_block"] is None

    def test_a_field_that_is_not_legible_stays_null_and_the_rest_is_kept(self, registry):
        block = {**FULL_BLOCK, "revision": None, "revision_date": None}
        parsed = va.parse_visual_analysis(_reply(block), registry)["document"]["title_block"]

        assert parsed == {"document_number": "A-101", "scale": "1:100", "title": "Grundriss Erdgeschoss"}

    def test_the_date_is_iso_or_nothing(self, registry):
        for printed, expected in [("14.08.2026", "2026-08-14"), ("08/2026", None), ("31.02.2026", None)]:
            block = va.parse_visual_analysis(_reply({**FULL_BLOCK, "revision_date": printed}), registry)["document"][
                "title_block"
            ]
            assert block.get("revision_date") == expected

    def test_the_index_loses_the_word_that_introduced_it_and_a_dash_is_no_index(self, registry):
        def read(printed):
            return va.parse_visual_analysis(_reply({**FULL_BLOCK, "revision": printed}), registry)["document"][
                "title_block"
            ].get("revision")

        assert read("Index C") == "C" and read("07") == "07"
        assert read("-") is None and read("") is None

    def test_a_malformed_title_block_never_fails_the_page(self, registry):
        for broken in ("A-101", ["A-101"], 5, {"document_number": {"x": 1}, "revision": [1]}):
            analysis = va.parse_visual_analysis(_reply(broken), registry)
            assert analysis is not None and analysis["document"]["title_block"] is None

    def test_a_page_number_a_reply_invents_is_not_taken_for_a_fact(self, registry):
        parsed = va.parse_visual_analysis(_reply({**FULL_BLOCK, "page": 9}), registry)["document"]["title_block"]
        assert "page" not in parsed

    def test_an_old_reply_without_the_key_still_parses(self, registry):
        # A weaker model, or a cached v4 reading: the document object just has no title_block.
        analysis = va.parse_visual_analysis(_reply(document={"summary": "x"}), registry)
        assert analysis["segments"] and analysis["document"]["title_block"] is None

    def test_the_title_block_is_indexed_text_so_a_plan_number_can_be_found(self, registry):
        analysis = va.parse_visual_analysis(_reply(FULL_BLOCK), registry)

        text = va.segment_payloads(analysis, registry)[0]["text"]

        assert "Title block: Nr. A-101, Index C, Stand 14.08.2026, Scale 1:100, Grundriss Erdgeschoss" in text

    def test_no_title_block_adds_no_line(self, registry):
        analysis = va.parse_visual_analysis(_reply(), registry)
        assert "Title block" not in va.render_analysis_text(analysis, registry)


class _FakeCompletions:
    def __init__(self, reply):
        self._reply = reply
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = MagicMock()
        message.content = self._reply
        choice = MagicMock()
        choice.message = message
        choice.finish_reason = "stop"
        response = MagicMock()
        response.choices = [choice]
        return response


def _fake_openai(completions):
    class _FakeClient:
        def __init__(self, *args, **kwargs):
            self.chat = MagicMock()
            self.chat.completions = completions

    return _FakeClient


class TestThroughTheVisionCall:
    def test_one_call_returns_the_analysis_with_the_title_block(self):
        import openai

        completions = _FakeCompletions(_reply(FULL_BLOCK))
        with patch.object(openai, "OpenAI", _fake_openai(completions)):
            content_type, _, fields = adapter.analyze_visual(b"title-block-page", vlm_api_key="k")

        assert content_type == "drawing"
        assert fields["analysis"]["document"]["title_block"] == FULL_BLOCK
        # The cost note: the facts ride the call that was made anyway.
        assert len(completions.calls) == 1
        prompt = completions.calls[0]["messages"][0]["content"][0]["text"]
        assert "document_number" in prompt

    def test_a_page_without_a_title_block_costs_the_same_one_call(self):
        import openai

        completions = _FakeCompletions(_reply())
        with patch.object(openai, "OpenAI", _fake_openai(completions)):
            _, _, fields = adapter.analyze_visual(b"detail-page", vlm_api_key="k")

        assert fields["analysis"]["document"]["title_block"] is None
        assert len(completions.calls) == 1


# ---------------------------------------------------------------------------
# From pages to the document's facts: the first page with a title block wins
# ---------------------------------------------------------------------------


def _chunk(page: int, title_block, registry):
    analysis = va.parse_visual_analysis(_reply(title_block), registry)
    (payload,) = va.segment_payloads(analysis, registry)
    return SimpleNamespace(metadata={"page_label": str(page), "drawing_data": payload["drawing_data"]})


class TestTheDocumentsFacts:
    def test_the_chunk_carries_the_title_block_in_its_drawing_data(self, registry):
        chunk = _chunk(1, FULL_BLOCK, registry)
        assert json.loads(chunk.metadata["drawing_data"])["document"]["title_block"] == FULL_BLOCK

    def test_the_first_page_with_a_title_block_wins_and_says_which_page(self, registry):
        later = {**FULL_BLOCK, "revision": "D"}
        chunks = [_chunk(3, later, registry), _chunk(2, FULL_BLOCK, registry), _chunk(1, None, registry)]

        assert fassungen.revision_facts_from_documents(chunks) == {**FULL_BLOCK, "page": 2}

    def test_a_cover_with_only_a_title_does_not_beat_the_sheet_that_names_the_number(self, registry):
        cover = {"title": "Deckblatt"}
        chunks = [_chunk(1, cover, registry), _chunk(2, FULL_BLOCK, registry)]

        assert fassungen.revision_facts_from_documents(chunks)["document_number"] == "A-101"

    def test_a_title_only_block_is_better_than_none(self, registry):
        assert fassungen.revision_facts_from_documents([_chunk(1, {"title": "Deckblatt"}, registry)]) == {
            "title": "Deckblatt",
            "page": 1,
        }

    def test_pages_are_not_merged(self, registry):
        chunks = [
            _chunk(1, {"document_number": "A-101"}, registry),
            _chunk(2, {"revision": "C", "revision_date": "14.08.2026"}, registry),
        ]
        assert fassungen.revision_facts_from_documents(chunks) == {"document_number": "A-101", "page": 1}

    def test_a_document_without_a_title_block_has_no_facts(self, registry):
        text_chunk = SimpleNamespace(metadata={"page_label": "1"})
        broken = SimpleNamespace(metadata={"page_label": "2", "drawing_data": "{not json"})
        no_page = SimpleNamespace(metadata={"drawing_data": _chunk(1, FULL_BLOCK, registry).metadata["drawing_data"]})
        assert fassungen.revision_facts_from_documents([text_chunk, broken, no_page]) is None
        assert fassungen.revision_facts_from_documents([_chunk(1, None, registry)]) is None
        assert fassungen.revision_facts_from_documents([]) is None


# ---------------------------------------------------------------------------
# Storage: an optional column, migrated like the others
# ---------------------------------------------------------------------------


@pytest.fixture
def temp_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'facts.db'}"
        yield db_url
        DocumentMetadataStore.dispose_engine(db_url)


@pytest.fixture
def store(temp_db):
    return DocumentMetadataStore(temp_db)


def _stored(store, name, collection="coll"):
    return {doc.file_name: doc for doc in store.get_all(collection)}[name]


class TestStorage:
    def test_the_facts_round_trip_through_the_row(self, store):
        store.register("coll", "A.pdf", "Grundriss.")

        assert store.set_revision_facts("coll", "A.pdf", {**FULL_BLOCK, "page": 2}) is True

        assert _stored(store, "A.pdf").revision_facts == {**FULL_BLOCK, "page": 2}

    def test_a_row_without_them_reads_none(self, store):
        store.register("coll", "A.pdf", "Text.")
        assert _stored(store, "A.pdf").revision_facts is None

    def test_what_is_stored_is_normalised_so_the_column_never_holds_a_loose_date(self, store):
        store.register("coll", "A.pdf", "x")
        store.set_revision_facts("coll", "A.pdf", {"revision": "Index B", "revision_date": "14.08.2026", "junk": 1})
        assert _stored(store, "A.pdf").revision_facts == {"revision": "B", "revision_date": "2026-08-14"}

    @pytest.mark.parametrize("empty", [None, {}, {"revision": "-"}])
    def test_nothing_printed_clears_the_column(self, store, empty):
        store.register("coll", "A.pdf", "x")
        store.set_revision_facts("coll", "A.pdf", FULL_BLOCK)

        assert store.set_revision_facts("coll", "A.pdf", empty) is True

        assert _stored(store, "A.pdf").revision_facts is None

    def test_no_row_means_false_and_nothing_is_created(self, store):
        assert store.set_revision_facts("coll", "ghost.pdf", FULL_BLOCK) is False
        assert store.get_all("coll") == []

    def test_a_re_register_keeps_them(self, store):
        store.register("coll", "A.pdf", "x")
        store.set_revision_facts("coll", "A.pdf", FULL_BLOCK)
        store.register("coll", "A.pdf", "Neu gelesen.")
        assert _stored(store, "A.pdf").revision_facts == FULL_BLOCK

    def test_they_do_not_cross_collections(self, store):
        store.register("one", "A.pdf", "x")
        store.register("two", "A.pdf", "x")
        store.set_revision_facts("one", "A.pdf", FULL_BLOCK)
        assert _stored(store, "A.pdf", "two").revision_facts is None

    def test_an_unreadable_column_is_none_not_a_failed_row(self):
        assert DocumentMetadataStore._decode_revision_facts("{broken") is None
        assert DocumentMetadataStore._decode_revision_facts('["x"]') is None
        assert DocumentMetadataStore._decode_revision_facts(None) is None

    def test_a_table_from_before_the_column_is_migrated_and_keeps_its_rows(self):
        from sqlalchemy import create_engine
        from sqlalchemy import inspect
        from sqlalchemy import text

        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite:///{Path(tmpdir) / 'before_facts.db'}"
            engine = create_engine(db_url)
            with engine.connect() as conn:
                conn.execute(
                    text(
                        "CREATE TABLE document_metadata ("
                        "collection VARCHAR(256) NOT NULL, filename VARCHAR(512) NOT NULL, "
                        "summary TEXT NOT NULL, tags TEXT, doc_class TEXT, display_title TEXT, folder_path TEXT, "
                        "provenance TEXT, doc_class_suggestion TEXT, tags_set_by TEXT, topics TEXT, capture TEXT, "
                        "superseded_by TEXT, revision_suggestion TEXT, change_summary TEXT, change_basis TEXT, "
                        "created_at DATETIME, PRIMARY KEY (collection, filename))"
                    )
                )
                conn.execute(
                    text(
                        "INSERT INTO document_metadata (collection, filename, summary) VALUES ('c', 'old.pdf', 'Alt.')"
                    )
                )
                conn.commit()
            assert "revision_facts" not in {c["name"] for c in inspect(engine).get_columns("document_metadata")}

            DocumentMetadataStore._tables_initialized.discard(db_url)
            migrated = DocumentMetadataStore(db_url)

            assert "revision_facts" in {c["name"] for c in inspect(engine).get_columns("document_metadata")}
            old = migrated.get_all("c")[0]
            assert old.summary == "Alt." and old.revision_facts is None
            assert migrated.set_revision_facts("c", "old.pdf", FULL_BLOCK) is True
            assert migrated.get_all("c")[0].revision_facts == FULL_BLOCK

            engine.dispose()
            DocumentMetadataStore.dispose_engine(db_url)

    def test_the_factory_seam_writes_and_the_available_documents_carry_it(self):
        from aiq_agent.knowledge import configure_summary_db
        from aiq_agent.knowledge import factory
        from aiq_agent.knowledge import get_available_documents
        from aiq_agent.knowledge import register_summary
        from aiq_agent.knowledge import set_document_revision_facts

        with tempfile.TemporaryDirectory() as tmpdir:
            url = f"sqlite:///{Path(tmpdir) / 'factory_facts.db'}"
            configure_summary_db(url)
            try:
                register_summary("coll", "A.pdf", "Grundriss.")
                assert set_document_revision_facts("coll", "A.pdf", FULL_BLOCK) is True
                assert get_available_documents("coll")[0].revision_facts == FULL_BLOCK
                assert set_document_revision_facts("coll", "A.pdf", None) is True
                assert get_available_documents("coll")[0].revision_facts is None
            finally:
                factory._document_metadata_store = None
                DocumentMetadataStore.dispose_engine(url)


# ---------------------------------------------------------------------------
# Fassung detection: the same number is the same document
# ---------------------------------------------------------------------------


@pytest.fixture
def job_store(monkeypatch):
    from aiq_agent.knowledge import ingest_status_store

    monkeypatch.setattr(ingest_status_store, "in_flight_files", lambda collections: {})
    monkeypatch.setattr(ingest_status_store, "collection_jobs", lambda collection, within: [])


def _row(name, facts=None, **kwargs) -> AvailableDocument:
    return AvailableDocument(
        file_name=name, summary=kwargs.pop("summary", "Beschreibung."), revision_facts=facts, **kwargs
    )


class TestSuggestionByNumber:
    @pytest.fixture
    def stored(self, monkeypatch):
        from aiq_agent import knowledge

        calls = []
        monkeypatch.setattr(knowledge, "set_document_revision_suggestion", lambda *args: calls.append(args) or True)
        return calls

    def test_a_candidate_with_the_same_number_is_found_though_the_names_share_nothing(self, job_store, stored):
        rows = [
            _row("Zeichnung 7.pdf", {"document_number": "A-101", "revision": "B"}),
            _row("Schnitt.pdf", {"document_number": "S-200", "revision": "A"}),
        ]
        llm = MagicMock()

        suggestion = fassungen.suggest_revision(
            "coll",
            "Entwurf neu.pdf",
            rows=rows,
            summary="Grundriss.",
            doc_class=None,
            tags=None,
            llm=llm,
            revision_facts={"document_number": "A 101", "revision": "C"},
        )

        assert (suggestion["of"], suggestion["basis"]) == ("Zeichnung 7.pdf", "title_block")
        assert suggestion["dismissed"] is False and "Index C statt B" in suggestion["reason"]
        assert stored == [("coll", "Entwurf neu.pdf", suggestion)]
        # Decided by the sheets: no model call, no cost.
        llm.invoke.assert_not_called()

    def test_the_index_on_the_sheet_beats_the_index_in_the_name(self, job_store, stored):
        rows = [_row("Grundriss_Index_C.pdf", {"document_number": "A-101", "revision": "B"})]

        suggestion = fassungen.suggest_revision(
            "coll",
            "Grundriss_Index_B.pdf",
            rows=rows,
            summary="x",
            doc_class=None,
            tags=None,
            llm=None,
            revision_facts={"document_number": "A-101", "revision": "C"},
        )

        assert suggestion is not None and suggestion["of"] == "Grundriss_Index_C.pdf"

    def test_an_older_sheet_uploaded_later_suggests_nothing_and_asks_no_model(self, job_store, stored):
        rows = [_row("neu.pdf", {"document_number": "A-101", "revision": "C"}), _row("anderes.pdf")]
        llm = MagicMock()

        assert (
            fassungen.suggest_revision(
                "coll",
                "alt.pdf",
                rows=rows,
                summary="x",
                doc_class=None,
                tags=None,
                llm=llm,
                revision_facts={"document_number": "A-101", "revision": "B"},
            )
            is None
        )
        llm.invoke.assert_not_called()
        assert stored == []

    def test_a_held_file_with_the_same_number_is_not_a_candidate(self, monkeypatch, stored):
        from aiq_agent.knowledge import ingest_status_store

        monkeypatch.setattr(ingest_status_store, "in_flight_files", lambda collections: {"coll": ["gehalten.pdf"]})
        monkeypatch.setattr(ingest_status_store, "collection_jobs", lambda collection, within: [])
        rows = [_row("gehalten.pdf", {"document_number": "A-101", "revision": "A"})]

        assert (
            fassungen.suggest_revision(
                "coll",
                "neu.pdf",
                rows=rows,
                summary="x",
                doc_class=None,
                tags=None,
                llm=None,
                revision_facts={"document_number": "A-101", "revision": "B"},
            )
            is None
        )

    def test_a_row_a_person_already_replaced_is_skipped_so_the_newest_state_is_replaced(self, job_store, stored):
        rows = [
            _row("A.pdf", {"document_number": "A-101", "revision": "A"}, superseded_by="B.pdf"),
            _row("B.pdf", {"document_number": "A-101", "revision": "B"}),
        ]
        suggestion = fassungen.suggest_revision(
            "coll",
            "C.pdf",
            rows=rows,
            summary="x",
            doc_class=None,
            tags=None,
            llm=None,
            revision_facts={"document_number": "A-101", "revision": "C"},
        )
        assert suggestion["of"] == "B.pdf"

    def test_candidates_carry_the_stored_facts_to_the_judge(self):
        (candidate,) = fassungen.candidate_documents(
            "neu.pdf", [_row("alt.pdf", {"document_number": "A-101"})], held=set()
        )
        assert candidate.revision_facts == {"document_number": "A-101"}


# ---------------------------------------------------------------------------
# What the agent reads: list_files
# ---------------------------------------------------------------------------


def _doc(name, facts=None, **kwargs):
    return AvailableDocument(
        file_name=name,
        collection="proj_1",
        shelf="project",
        summary=f"Zusammenfassung von {name}",
        revision_facts=facts,
        **kwargs,
    )


def _line(text: str, name: str) -> str:
    return next(line for line in text.splitlines() if line.startswith(f"- {name}"))


class TestListFiles:
    def test_a_row_names_number_index_and_stand_from_the_title_block(self):
        rows = file_rows([_doc("Zeichnung 7.pdf", {**FULL_BLOCK, "page": 1}), _doc("Bericht.pdf")])

        text = render_listing(select_files(rows, shelf="project"))

        assert "Plankopf: Nr. A-101, Index C, Stand 14.08.2026" in _line(text, "Zeichnung 7.pdf")
        assert "Plankopf" not in _line(text, "Bericht.pdf")

    def test_scale_and_title_stay_off_the_row(self):
        text = render_listing(select_files(file_rows([_doc("a.pdf", FULL_BLOCK)]), shelf="project"))
        assert "1:100" not in _line(text, "a.pdf") and "Grundriss Erdgeschoss" not in _line(text, "a.pdf")

    def test_a_title_only_block_adds_no_plankopf_bit(self):
        text = render_listing(select_files(file_rows([_doc("a.pdf", {"title": "Deckblatt"})]), shelf="project"))
        assert "Plankopf" not in _line(text, "a.pdf")

    def test_the_facts_are_read_off_a_row_or_a_dict(self):
        assert file_row(_doc("a.pdf", FULL_BLOCK)).revision_facts == FULL_BLOCK
        assert file_row({"file_name": "a.pdf", "revision_facts": FULL_BLOCK}).revision_facts == FULL_BLOCK
        assert file_row({"file_name": "a.pdf", "revision_facts": "kaputt"}).revision_facts is None

    def test_two_files_with_the_same_number_are_marked_current_and_older_whatever_their_names(self):
        rows = file_rows(
            [
                _doc("Zeichnung 7.pdf", {"document_number": "A-101", "revision": "B"}),
                _doc("Entwurf neu.pdf", {"document_number": "a 101", "revision": "C"}),
                _doc("Zeichnung 9.pdf", {"document_number": "A-102", "revision": "A"}),
            ]
        )

        listing = select_files(rows, shelf="project")
        text = render_listing(listing)

        assert "aktuelle Fassung laut Plankopf (Index C; 1 ältere)" in _line(text, "Entwurf neu.pdf")
        older = _line(text, "Zeichnung 7.pdf")
        assert "ältere Fassung laut Plankopf (Index B)" in older and "aktuell laut Plankopf: Entwurf neu.pdf" in older
        assert "laut Plankopf" not in _line(text, "Zeichnung 9.pdf")
        assert listing.title_block_series == 1
        assert "Fassungen (Plankopf): 1 Dokument(e)" in text

    def test_the_title_block_outranks_the_name_in_which_is_current(self):
        rows = file_rows(
            [
                _doc("Grundriss Index C.pdf", {"document_number": "A-101", "revision": "B"}),
                _doc("Grundriss Index B.pdf", {"document_number": "A-101", "revision": "C"}),
            ]
        )
        text = render_listing(select_files(rows, shelf="project"))

        assert "aktuelle Fassung laut Plankopf" in _line(text, "Grundriss Index B.pdf")
        assert "laut Plankopf" in _line(text, "Grundriss Index C.pdf")
        assert "dem Namen nach" not in text

    def test_the_same_number_and_the_same_state_twice_is_a_copy_not_a_series(self):
        rows = file_rows(
            [
                _doc("a.pdf", {"document_number": "A-101", "revision": "B"}),
                _doc("b.pdf", {"document_number": "A-101", "revision": "B"}),
            ]
        )
        listing = select_files(rows, shelf="project")
        assert listing.title_block_series == 0 and "laut Plankopf" not in render_listing(listing)

    def test_a_series_never_crosses_collections(self):
        rows = file_rows(
            [
                _doc("a.pdf", {"document_number": "A-101", "revision": "B"}),
                AvailableDocument(
                    file_name="b.pdf",
                    collection="proj_2",
                    shelf="project",
                    summary="x",
                    revision_facts={"document_number": "A-101", "revision": "C"},
                ),
            ]
        )
        assert select_files(rows, shelf="project").title_block_series == 0

    def test_a_confirmed_link_beats_the_reading_of_the_sheets(self):
        rows = file_rows(
            [
                _doc("alt.pdf", {"document_number": "A-101", "revision": "B"}, superseded_by="neu.pdf"),
                _doc("neu.pdf", {"document_number": "A-101", "revision": "C"}, supersedes=["alt.pdf"]),
            ]
        )
        text = render_listing(select_files(rows, shelf="project"))

        assert "ersetzt durch neu.pdf (bestätigt)" in _line(text, "alt.pdf")
        assert "laut Plankopf" not in _line(text, "alt.pdf")
        assert "Fassungen (Plankopf)" not in text


# ---------------------------------------------------------------------------
# Wired into the ingest: the facts are stored beside the summary and decide the suggestion
# ---------------------------------------------------------------------------

from tests.knowledge_layer_tests.test_fassung_ingestion import _documents  # noqa: E402
from tests.knowledge_layer_tests.test_fassung_ingestion import _ingest  # noqa: E402
from tests.knowledge_layer_tests.test_fassung_ingestion import live_ingestor  # noqa: E402, F401
from tests.knowledge_layer_tests.test_fassung_ingestion import model  # noqa: E402, F401
from tests.knowledge_layer_tests.test_fassung_ingestion import stores  # noqa: E402, F401


@pytest.fixture
def ingest(request, tmp_path):
    """``ingest(collection, name)`` over a real SQLite store and Qdrant collection; ``.model`` is the summary model."""
    request.getfixturevalue("stores")
    ingestor = request.getfixturevalue("live_ingestor")
    summary_model = request.getfixturevalue("model")

    def run(collection, file_name):
        _ingest(ingestor, tmp_path, collection, file_name)

    run.model = summary_model
    return run


class TestIngestWiring:
    def _reads(self, monkeypatch, facts):
        seen = []

        def read(documents):
            seen.append(len(documents))
            return facts

        monkeypatch.setattr(fassungen, "revision_facts_from_documents", read)
        return seen

    def test_the_facts_read_from_the_pages_are_stored_on_the_documents_row(self, ingest, monkeypatch):
        seen = self._reads(monkeypatch, {**FULL_BLOCK, "page": 1})

        ingest("proj_facts", "Zeichnung 7.txt")

        assert seen and _documents("proj_facts")["Zeichnung 7.txt"].revision_facts == {**FULL_BLOCK, "page": 1}

    def test_a_new_name_with_the_same_number_is_suggested_by_the_title_block_without_the_judge(
        self, ingest, monkeypatch
    ):
        self._reads(monkeypatch, {"document_number": "A-101", "revision": "B"})
        ingest("proj_number", "Zeichnung 7.txt")
        self._reads(monkeypatch, {"document_number": "A-101", "revision": "C"})

        ingest("proj_number", "Entwurf neu.txt")

        suggestion = _documents("proj_number")["Entwurf neu.txt"].revision_suggestion
        assert (suggestion["of"], suggestion["basis"]) == ("Zeichnung 7.txt", "title_block")
        assert ingest.model.asked("NEWER FASSUNG") == []

    def test_a_re_upload_without_a_title_block_clears_the_old_sheets_facts(self, ingest, monkeypatch):
        self._reads(monkeypatch, FULL_BLOCK)
        ingest("proj_clear", "Zeichnung 7.txt")
        assert _documents("proj_clear")["Zeichnung 7.txt"].revision_facts == FULL_BLOCK
        self._reads(monkeypatch, None)

        ingest("proj_clear", "Zeichnung 7.txt")

        assert _documents("proj_clear")["Zeichnung 7.txt"].revision_facts is None

    def test_a_file_without_a_title_block_writes_nothing(self, ingest, monkeypatch):
        self._reads(monkeypatch, None)
        ingest("proj_plain", "Bericht.txt")
        assert _documents("proj_plain")["Bericht.txt"].revision_facts is None
