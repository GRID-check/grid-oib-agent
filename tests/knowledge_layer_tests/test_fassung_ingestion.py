"""The two ingestion hooks that read Fassungen (``llamaindex/fassungen.py``, wired in ``adapter.py``).

A NEW file name may be a newer Fassung of another document: the summary model reads
a few candidates from the same collection and its answer is stored as a SUGGESTION.
A re-upload under a name the collection holds says what changed against the
previous upload. A person's confirmed link and a dismissed suggestion survive a
re-read. And no name of a held file reaches the model (ADR-0086).

The unit tests drive ``fassungen`` directly; the end-to-end ones run
``_run_ingestion`` over a real SQLite store and a real Qdrant collection with a
model that answers by the kind of prompt it is given.
"""

import tempfile
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex import fassungen
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.adapter import _PreviousVersion
from langchain_core.messages import AIMessage

from aiq_agent.knowledge.schema import AvailableDocument


def _row(name, summary="Beschreibung.", **kwargs) -> AvailableDocument:
    return AvailableDocument(file_name=name, summary=summary, **kwargs)


SUGGESTION = {"of": "B.pdf", "confidence": 0.9, "reason": "Gleicher Grundriss.", "basis": "name", "dismissed": False}


# ---------------------------------------------------------------------------
# Who may be a candidate
# ---------------------------------------------------------------------------


class TestCandidates:
    def test_a_row_is_a_candidate_with_its_name_class_tags_and_what_its_name_says(self):
        rows = [_row("Grundriss_EG_Index_B.pdf", doc_class="grundriss", tags=["Grundriss"])]

        (candidate,) = fassungen.candidate_documents("Grundriss_EG_Index_C.pdf", rows, held=set())

        assert candidate.file_name == "Grundriss_EG_Index_B.pdf"
        assert candidate.doc_class == "grundriss"
        assert candidate.tags == ("Grundriss",)
        assert candidate.revision == "Index B"
        assert candidate.series_key == fassungen.series_key_of("Grundriss_EG_Index_C.pdf")

    def test_the_file_itself_is_never_a_candidate(self):
        assert (
            fassungen.candidate_documents("C.pdf", [_row("C.pdf"), _row("B.pdf")], held=set())[0].file_name == "B.pdf"
        )

    def test_a_row_a_person_already_replaced_is_not_a_candidate(self):
        rows = [_row("A.pdf", superseded_by="B.pdf"), _row("B.pdf")]
        assert [c.file_name for c in fassungen.candidate_documents("C.pdf", rows, held=set())] == ["B.pdf"]

    def test_a_row_with_nothing_to_say_is_not_a_candidate(self):
        rows = [_row("leer.pdf", summary=""), _row("blank.pdf", summary="   "), _row("B.pdf")]
        assert [c.file_name for c in fassungen.candidate_documents("C.pdf", rows, held=set())] == ["B.pdf"]

    def test_a_held_name_is_not_a_candidate(self):
        rows = [_row("gehalten.pdf"), _row("B.pdf")]
        assert [c.file_name for c in fassungen.candidate_documents("C.pdf", rows, held={"gehalten.pdf"})] == ["B.pdf"]

    def test_the_file_a_person_already_refused_for_this_one_is_not_offered_again(self):
        own = _row("C.pdf", revision_suggestion={**SUGGESTION, "dismissed": True})
        rows = [own, _row("B.pdf"), _row("A.pdf")]
        assert [c.file_name for c in fassungen.candidate_documents("C.pdf", rows, held=set())] == ["A.pdf"]

    def test_an_open_suggestion_refuses_nobody(self):
        own = _row("C.pdf", revision_suggestion=SUGGESTION)
        rows = [own, _row("B.pdf")]
        assert [c.file_name for c in fassungen.candidate_documents("C.pdf", rows, held=set())] == ["B.pdf"]

    @pytest.mark.parametrize(
        "name",
        [
            "Grundriss EG.pdf",
            "Grundriss EG Index B.pdf",
            "Grundriss_EG_Index_C_2026-08-14.dwg",
            "260814_Grundriss EG.pdf",
        ],
    )
    def test_every_state_of_one_document_shares_the_series_key_whatever_its_extension(self, name):
        assert fassungen.series_key_of(name) == "grundriss eg"

    def test_another_document_has_another_series_key(self):
        assert fassungen.series_key_of("Schnitt AA Index B.pdf") != fassungen.series_key_of("Grundriss EG.pdf")

    def test_the_bare_first_state_of_a_document_shares_the_series_key_of_its_indexed_successor(self):
        first = fassungen.revision_document("Grundriss EG.pdf", summary="x", doc_class=None, tags=None)
        later = fassungen.revision_document("Grundriss EG Index B.pdf", summary="x", doc_class=None, tags=None)
        assert first.series_key == later.series_key
        assert first.revision is None and later.revision == "Index B"


# ---------------------------------------------------------------------------
# Held files (ADR-0086)
# ---------------------------------------------------------------------------


def _job(*files):
    return SimpleNamespace(file_details=[SimpleNamespace(file_name=n, screening=s) for n, s in files])


@pytest.fixture
def job_store(monkeypatch):
    from aiq_agent.knowledge import ingest_status_store

    state = SimpleNamespace(in_flight={}, jobs=[], error=None)

    def in_flight(collections):
        if state.error:
            raise state.error
        return state.in_flight

    def collection_jobs(collection, within_seconds):
        if state.error:
            raise state.error
        return state.jobs

    monkeypatch.setattr(ingest_status_store, "in_flight_files", in_flight)
    monkeypatch.setattr(ingest_status_store, "collection_jobs", collection_jobs)
    return state


class TestHeldNames:
    def test_a_quarantined_file_and_a_file_still_being_read_are_held(self, job_store):
        job_store.in_flight = {"coll": ["lese.pdf"]}
        job_store.jobs = [_job(("lohn.pdf", "quarantined"), ("ok.pdf", "clean"))]
        assert fassungen.held_file_names("coll") == {"lese.pdf", "lohn.pdf"}

    def test_the_newest_job_that_names_a_file_decides(self, job_store):
        # Quarantined first, released and indexed later: no longer held. The reverse is held.
        job_store.jobs = [
            _job(("frei.pdf", "quarantined"), ("neu.pdf", "clean")),
            _job(("frei.pdf", "clean"), ("neu.pdf", "quarantined")),
        ]
        assert fassungen.held_file_names("coll") == {"neu.pdf"}

    def test_nothing_held_is_an_empty_set_not_unknown(self, job_store):
        assert fassungen.held_file_names("coll") == set()

    def test_a_store_that_cannot_be_read_is_unknown(self, job_store):
        job_store.error = RuntimeError("db down")
        assert fassungen.held_file_names("coll") is None


class TestSuggestRevision:
    def _llm(self, answer):
        llm = MagicMock()
        llm.invoke.return_value = AIMessage(content=answer)
        return llm

    @pytest.fixture
    def stored(self, monkeypatch):
        from aiq_agent import knowledge

        calls = []
        monkeypatch.setattr(knowledge, "set_document_revision_suggestion", lambda *args: calls.append(args) or True)
        return calls

    def test_the_verdict_is_stored_as_a_suggestion_with_its_basis(self, job_store, stored):
        rows = [_row("B.pdf", summary="Grundriss EG.")]
        answer = '{"of": "B.pdf", "confidence": 0.9, "reason": "Gleicher Grundriss."}'

        suggestion = fassungen.suggest_revision(
            "coll", "C.pdf", rows=rows, summary="Grundriss EG, neu.", doc_class=None, tags=None, llm=self._llm(answer)
        )

        assert suggestion == {
            "of": "B.pdf",
            "confidence": 0.9,
            "reason": "Gleicher Grundriss.",
            "basis": "content",
            "dismissed": False,
        }
        assert stored == [("coll", "C.pdf", suggestion)]

    def test_a_series_in_the_names_is_the_basis_name(self, job_store, stored):
        rows = [_row("Grundriss_EG_Index_B.pdf")]
        answer = '{"of": "Grundriss_EG_Index_B.pdf", "confidence": 0.9, "reason": "Neuer Index."}'
        suggestion = fassungen.suggest_revision(
            "coll", "Grundriss_EG_Index_C.pdf", rows=rows, summary="x", doc_class=None, tags=None, llm=self._llm(answer)
        )
        assert suggestion["basis"] == "name"

    def test_no_name_of_a_held_file_reaches_the_model(self, job_store, stored):
        job_store.jobs = [_job(("gehalten.pdf", "quarantined"))]
        job_store.in_flight = {"coll": ["lese.pdf"]}
        rows = [_row("gehalten.pdf"), _row("lese.pdf"), _row("B.pdf")]
        llm = self._llm('{"of": null, "confidence": 0, "reason": ""}')

        fassungen.suggest_revision("coll", "C.pdf", rows=rows, summary="x", doc_class=None, tags=None, llm=llm)

        prompt = llm.invoke.call_args.args[0]
        assert "B.pdf" in prompt
        assert "gehalten.pdf" not in prompt and "lese.pdf" not in prompt

    def test_only_held_candidates_means_no_call_at_all(self, job_store, stored):
        job_store.jobs = [_job(("gehalten.pdf", "quarantined"))]
        llm = self._llm("{}")
        assert (
            fassungen.suggest_revision(
                "coll", "C.pdf", rows=[_row("gehalten.pdf")], summary="x", doc_class=None, tags=None, llm=llm
            )
            is None
        )
        llm.invoke.assert_not_called()

    def test_when_the_held_files_cannot_be_read_no_name_is_sent(self, job_store, stored):
        job_store.error = RuntimeError("db down")
        llm = self._llm("{}")
        assert (
            fassungen.suggest_revision(
                "coll", "C.pdf", rows=[_row("B.pdf")], summary="x", doc_class=None, tags=None, llm=llm
            )
            is None
        )
        llm.invoke.assert_not_called()
        assert stored == []

    def test_a_verdict_below_the_threshold_stores_nothing(self, job_store, stored):
        answer = '{"of": "B.pdf", "confidence": 0.5, "reason": "Vielleicht."}'
        assert (
            fassungen.suggest_revision(
                "coll", "C.pdf", rows=[_row("B.pdf")], summary="x", doc_class=None, tags=None, llm=self._llm(answer)
            )
            is None
        )
        assert stored == []


class TestCarriedLinks:
    def test_the_link_and_the_suggestion_come_back_decoded(self):
        import json

        link, suggestion = fassungen.carried_links(
            {"superseded_by": "C.pdf", "revision_suggestion": json.dumps(SUGGESTION)}
        )
        assert link == "C.pdf"
        assert suggestion == SUGGESTION

    def test_nothing_preserved_carries_nothing(self):
        assert fassungen.carried_links({}) == (None, None)

    def test_an_unreadable_suggestion_is_dropped_not_raised(self):
        assert fassungen.carried_links({"revision_suggestion": "{not json"}) == (None, None)
        assert fassungen.carried_links({"revision_suggestion": "[1]"}) == (None, None)


# ---------------------------------------------------------------------------
# A Fassung a person chose at upload (ADR-0099)
# ---------------------------------------------------------------------------


@pytest.fixture
def real_store():
    """A real metadata store behind the factory seams, so a link goes through the one locked step."""
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory
    from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

    with tempfile.TemporaryDirectory() as tmpdir:
        url = f"sqlite:///{Path(tmpdir) / 'confirm_fassung.db'}"
        configure_summary_db(url)
        yield factory._get_document_metadata_store()
        factory._document_metadata_store = None
        DocumentMetadataStore.dispose_engine(url)


def _stored(store, name, collection="coll"):
    return {doc.file_name: doc for doc in store.get_all(collection)}.get(name)


class TestConfirmFassung:
    def _llm(self, answer="- Stiege nach Norden verschoben"):
        llm = MagicMock()
        llm.invoke.return_value = AIMessage(content=answer)
        return llm

    def _confirm(self, llm, older="B.pdf"):
        return fassungen.confirm_fassung(
            "coll", "C.pdf", older, summary="Neu.", doc_class=None, tags=["Grundriss"], llm=llm
        )

    def test_the_link_is_written_the_way_the_put_route_writes_it(self, real_store):
        real_store.register("coll", "B.pdf", "Alt.")
        real_store.register("coll", "C.pdf", "Neu.")
        llm = self._llm()

        assert self._confirm(llm) is True

        assert _stored(real_store, "B.pdf").superseded_by == "C.pdf"
        assert _stored(real_store, "C.pdf").change_summary == "- Stiege nach Norden verschoben"
        assert _stored(real_store, "C.pdf").change_basis == "B.pdf"
        prompt = llm.invoke.call_args.args[0]
        assert "Alt." in prompt and "Neu." in prompt

    def test_a_suggestion_that_pointed_at_the_older_file_is_cleared(self, real_store):
        real_store.register("coll", "B.pdf", "Alt.")
        real_store.register("coll", "C.pdf", "Neu.")
        real_store.set_revision_suggestion("coll", "C.pdf", {**SUGGESTION, "of": "B.pdf"})

        self._confirm(self._llm())

        assert _stored(real_store, "C.pdf").revision_suggestion is None

    def test_a_suggestion_about_another_file_is_left_alone(self, real_store):
        for name in ("A.pdf", "B.pdf", "C.pdf"):
            real_store.register("coll", name, "Beschreibung.")
        real_store.set_revision_suggestion("coll", "C.pdf", {**SUGGESTION, "of": "A.pdf"})

        self._confirm(self._llm())

        assert _stored(real_store, "C.pdf").revision_suggestion["of"] == "A.pdf"

    def test_a_failed_model_leaves_the_link_and_no_change_line(self, real_store):
        real_store.register("coll", "B.pdf", "Alt.")
        real_store.register("coll", "C.pdf", "Neu.")
        llm = MagicMock()
        llm.invoke.side_effect = RuntimeError("model down")

        assert self._confirm(llm) is True

        assert _stored(real_store, "B.pdf").superseded_by == "C.pdf"
        assert _stored(real_store, "C.pdf").change_summary is None

    def test_without_a_model_the_link_is_written_and_no_change_line(self, real_store):
        real_store.register("coll", "B.pdf", "Alt.")
        real_store.register("coll", "C.pdf", "Neu.")

        assert self._confirm(None) is True

        assert _stored(real_store, "B.pdf").superseded_by == "C.pdf"
        assert _stored(real_store, "C.pdf").change_summary is None

    def test_the_new_file_needs_no_row_yet_and_the_link_waits_for_it(self, real_store):
        real_store.register("coll", "B.pdf", "Alt.")

        assert self._confirm(None) is True
        assert _stored(real_store, "B.pdf").superseded_by is None  # read as nothing while C has no row

        real_store.register("coll", "C.pdf", "Neu.")
        assert _stored(real_store, "B.pdf").superseded_by == "C.pdf"

    def test_an_older_file_the_collection_does_not_hold_links_nothing(self, real_store, caplog):
        real_store.register("coll", "A.pdf", "Beschreibung.")
        real_store.register("coll", "C.pdf", "Neu.")

        with caplog.at_level("WARNING"):
            assert self._confirm(self._llm()) is False

        assert _stored(real_store, "C.pdf").change_summary is None
        assert "missing" in caplog.text

    def test_a_link_that_would_close_a_loop_is_refused(self, real_store, caplog):
        # C is already replaced by B: B cannot be replaced by C in turn.
        real_store.register("coll", "B.pdf", "Alt.")
        real_store.register("coll", "C.pdf", "Neu.")
        real_store.set_superseded_by("coll", "C.pdf", "B.pdf")

        with caplog.at_level("WARNING"):
            assert self._confirm(self._llm()) is False

        assert _stored(real_store, "B.pdf").superseded_by is None
        assert _stored(real_store, "C.pdf").change_summary is None
        assert "loop" in caplog.text

    def test_a_loop_through_other_files_is_refused_too(self, real_store):
        for name in ("B.pdf", "C.pdf", "D.pdf"):
            real_store.register("coll", name, "Beschreibung.")
        real_store.set_superseded_by("coll", "C.pdf", "D.pdf")
        real_store.set_superseded_by("coll", "D.pdf", "B.pdf")

        assert self._confirm(self._llm()) is False
        assert _stored(real_store, "B.pdf").superseded_by is None

    def test_a_file_cannot_replace_itself(self, real_store):
        real_store.register("coll", "C.pdf", "Neu.")
        assert self._confirm(self._llm(), older="C.pdf") is False
        assert _stored(real_store, "C.pdf").superseded_by is None


class TestRecordFassungenWithAChoice:
    @pytest.fixture
    def calls(self, monkeypatch):
        state = SimpleNamespace(confirm=True, ran=[])
        monkeypatch.setattr(fassungen, "confirm_fassung", lambda *a, **k: state.ran.append("confirm") or state.confirm)
        monkeypatch.setattr(fassungen, "record_change", lambda *a, **k: state.ran.append("change"))
        monkeypatch.setattr(fassungen, "suggest_revision", lambda *a, **k: state.ran.append("suggest"))
        return state

    def _record(self, **kwargs):
        fassungen.record_fassungen(
            "coll", "C.pdf", rows=[], previous=None, summary="x", doc_class=None, tags=None, llm=None, **kwargs
        )

    def test_a_made_link_replaces_the_suggestion(self, calls):
        self._record(replaced=False, confirmed_older="B.pdf")
        assert calls.ran == ["confirm"]

    def test_a_made_link_replaces_the_change_against_the_previous_upload(self, calls):
        self._record(replaced=True, confirmed_older="B.pdf")
        assert calls.ran == ["confirm"]

    def test_a_link_that_could_not_be_made_falls_back_to_a_suggestion(self, calls):
        calls.confirm = False
        self._record(replaced=False, confirmed_older="B.pdf")
        assert calls.ran == ["confirm", "suggest"]

    def test_a_link_that_could_not_be_made_falls_back_to_the_change_line_of_a_reupload(self, calls):
        calls.confirm = False
        self._record(replaced=True, confirmed_older="B.pdf")
        assert calls.ran == ["confirm", "change"]

    def test_no_choice_is_the_ordinary_path(self, calls):
        self._record(replaced=False)
        assert calls.ran == ["suggest"]


# ---------------------------------------------------------------------------
# End to end through _run_ingestion
# ---------------------------------------------------------------------------


class _Model:
    """A summary model that answers by the kind of prompt it is given, and remembers them."""

    def __init__(self, judge='{"of": null, "confidence": 0.0, "reason": ""}', change="- Stiege nach Norden verschoben"):
        self.judge = judge
        self.change = change
        self.prompts: list[str] = []
        self.fail_on: str | None = None
        self._lock = threading.Lock()

    def invoke(self, prompt):
        with self._lock:
            self.prompts.append(prompt)
        if self.fail_on and self.fail_on in prompt:
            raise RuntimeError("model down")
        if "NEWER FASSUNG" in prompt:
            return AIMessage(content=self.judge)
        if "replaced one Fassung" in prompt:
            return AIMessage(content=self.change)
        if "EINEM Satz" in prompt:
            return AIMessage(content="Neue Statik mit anderer Bewehrung.")
        return AIMessage(content="[]")

    def asked(self, marker: str) -> list[str]:
        return [prompt for prompt in self.prompts if marker in prompt]


@pytest.fixture()
def stores(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture()
def model():
    return _Model()


@pytest.fixture()
def live_ingestor(tmp_path, monkeypatch, model, qdrant_store):
    from aiq_agent.knowledge import document_classification
    from sources.knowledge_layer.tests.qdrant_testing import FakeEmbedder

    ing = LlamaIndexIngestor({"generate_summary": True, "summary_llm": model})
    ing._embed_model = FakeEmbedder()
    ing._initialized = True
    monkeypatch.setattr(document_classification, "classify_document_tags", lambda *_a, **_k: ["Grundriss"])
    return ing


def _wait_terminal(ing, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _ingest(ing, tmp_path, collection, file_name, text="Neue Fassung der Statik mit anderer Bewehrung.", **extra):
    upload = tmp_path / f"tmp_{uuid.uuid4().hex[:8]}.txt"
    upload.write_text(text, encoding="utf-8")
    job_id = ing.submit_job(
        [str(upload)],
        collection,
        config={
            "original_filenames": [file_name],
            "extract_tables": False,
            "extract_images": False,
            "extract_charts": False,
            **extra,
        },
    )
    status = _wait_terminal(ing, job_id)
    assert status.file_details[0].status.value == "success"


def _documents(collection):
    from aiq_agent.knowledge import get_available_documents

    return {doc.file_name: doc for doc in get_available_documents(collection)}


def _seed_previous_version(ing, stores, collection_name, file_name):
    from aiq_agent.knowledge import register_summary
    from sources.knowledge_layer.tests.qdrant_testing import record
    from sources.knowledge_layer.tests.qdrant_testing import write

    write(collection_name, [record("Alte Fassung Seite eins", file_name, chunk_id="old-1")])
    register_summary(collection_name, file_name, "Die alte Statik.")


class TestANewNameMayBeANewerFassung:
    def test_a_confident_judgement_is_stored_as_a_suggestion_and_links_nothing(
        self, tmp_path, live_ingestor, stores, model
    ):
        from aiq_agent.knowledge import register_summary

        register_summary("proj_new", "Grundriss_EG_Index_B.txt", "Grundriss Erdgeschoss, Stiege im Süden.")
        model.judge = (
            '{"of": "Grundriss_EG_Index_B.txt", "confidence": 0.92, "reason": "Gleicher Grundriss, neuerer Index."}'
        )

        _ingest(live_ingestor, tmp_path, "proj_new", "Grundriss_EG_Index_C.txt")

        docs = _documents("proj_new")
        assert docs["Grundriss_EG_Index_C.txt"].revision_suggestion == {
            "of": "Grundriss_EG_Index_B.txt",
            "confidence": 0.92,
            "reason": "Gleicher Grundriss, neuerer Index.",
            "basis": "name",
            "dismissed": False,
            "dismissed_of": [],
        }
        # Nothing is linked, hidden or marked until a person confirms.
        assert all(doc.superseded_by is None and not doc.supersedes for doc in docs.values())
        (prompt,) = model.asked("NEWER FASSUNG")
        assert "Grundriss_EG_Index_B.txt" in prompt and "Grundriss Erdgeschoss, Stiege im Süden." in prompt

    def test_a_reading_of_the_content_alone_has_the_basis_content(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary

        register_summary("proj_content", "Tragwerk Bericht.txt", "Statik des Bauteils B.")
        model.judge = '{"of": "Tragwerk Bericht.txt", "confidence": 0.8, "reason": "Gleicher Bericht, neu bewehrt."}'

        _ingest(live_ingestor, tmp_path, "proj_content", "Statik Bauteil B final.txt")

        assert _documents("proj_content")["Statik Bauteil B final.txt"].revision_suggestion["basis"] == "content"

    def test_a_judgement_below_the_threshold_stores_nothing(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary

        register_summary("proj_low", "B.txt", "Statik.")
        model.judge = '{"of": "B.txt", "confidence": 0.6, "reason": "Vielleicht."}'

        _ingest(live_ingestor, tmp_path, "proj_low", "C.txt")

        assert _documents("proj_low")["C.txt"].revision_suggestion is None

    def test_a_failing_judge_never_fails_the_ingest(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary

        register_summary("proj_boom", "B.txt", "Statik.")
        model.fail_on = "NEWER FASSUNG"

        _ingest(live_ingestor, tmp_path, "proj_boom", "C.txt")

        assert _documents("proj_boom")["C.txt"].revision_suggestion is None

    def test_a_collection_with_no_other_document_asks_nothing(self, tmp_path, live_ingestor, stores, model):
        _ingest(live_ingestor, tmp_path, "proj_alone", "C.txt")
        assert model.asked("NEWER FASSUNG") == []

    def test_a_document_a_person_already_replaced_is_not_offered(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary
        from aiq_agent.knowledge import set_document_superseded_by

        register_summary("proj_done", "A.txt", "Statik, Stand eins.")
        register_summary("proj_done", "B.txt", "Statik, Stand zwei.")
        set_document_superseded_by("proj_done", "A.txt", "B.txt")

        _ingest(live_ingestor, tmp_path, "proj_done", "C.txt")

        (prompt,) = model.asked("NEWER FASSUNG")
        assert "B.txt" in prompt and "A.txt" not in prompt

    def test_a_quarantined_file_in_the_collection_is_not_named_to_the_model(
        self, tmp_path, live_ingestor, stores, model, job_store
    ):
        from aiq_agent.knowledge import register_summary

        register_summary("proj_held", "gehalten.txt", "Eine Datei, die gerade gesperrt ist.")
        register_summary("proj_held", "B.txt", "Statik.")
        job_store.jobs = [_job(("gehalten.txt", "quarantined"))]

        _ingest(live_ingestor, tmp_path, "proj_held", "C.txt")

        (prompt,) = model.asked("NEWER FASSUNG")
        assert "B.txt" in prompt and "gehalten.txt" not in prompt

    def test_the_base_corpus_is_never_asked(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary

        register_summary("oib_knowledge", "B.txt", "Statik.")

        _ingest(live_ingestor, tmp_path, "oib_knowledge", "C.txt")

        assert model.asked("NEWER FASSUNG") == []
        assert model.asked("replaced one Fassung") == []

    def test_without_a_summary_model_nothing_is_asked_and_nothing_breaks(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary

        live_ingestor.generate_summary_enabled = False
        register_summary("proj_off", "B.txt", "Statik.")

        _ingest(live_ingestor, tmp_path, "proj_off", "C.txt")

        assert model.prompts == []
        assert _documents("proj_off")["C.txt"].revision_suggestion is None


class TestAFassungChosenAtUpload:
    def test_the_link_and_its_change_line_are_written_once_the_file_has_been_read(
        self, tmp_path, live_ingestor, stores, model
    ):
        from aiq_agent.knowledge import register_summary

        register_summary("proj_chosen", "Grundriss_EG_Index_B.txt", "Grundriss Erdgeschoss, Stiege im Süden.")

        _ingest(
            live_ingestor, tmp_path, "proj_chosen", "Grundriss_EG_Index_C.txt", fassung_of="Grundriss_EG_Index_B.txt"
        )

        docs = _documents("proj_chosen")
        assert docs["Grundriss_EG_Index_B.txt"].superseded_by == "Grundriss_EG_Index_C.txt"
        assert docs["Grundriss_EG_Index_C.txt"].supersedes == ["Grundriss_EG_Index_B.txt"]
        assert docs["Grundriss_EG_Index_C.txt"].change_summary == "- Stiege nach Norden verschoben"
        assert docs["Grundriss_EG_Index_C.txt"].change_basis == "Grundriss_EG_Index_B.txt"
        # A person decided; the model is not asked whether this is a newer Fassung.
        assert model.asked("NEWER FASSUNG") == []
        assert docs["Grundriss_EG_Index_C.txt"].revision_suggestion is None

    def test_without_the_summary_model_the_link_is_still_written(self, tmp_path, live_ingestor, stores, model):
        # The person's choice does not wait for the model: only the change line needs it.
        from aiq_agent.knowledge import register_summary

        live_ingestor.generate_summary_enabled = False
        register_summary("proj_nomodel", "B.txt", "Statik.")

        _ingest(live_ingestor, tmp_path, "proj_nomodel", "C.txt", fassung_of="B.txt")

        docs = _documents("proj_nomodel")
        assert docs["B.txt"].superseded_by == "C.txt"
        assert docs["C.txt"].change_summary is None
        assert model.prompts == []

    def test_without_a_summary_the_link_is_written_and_waits_for_the_row(
        self, tmp_path, live_ingestor, stores, model, monkeypatch
    ):
        from aiq_agent.knowledge import document_classification
        from aiq_agent.knowledge import get_document_superseded_by
        from aiq_agent.knowledge import register_summary

        live_ingestor.generate_summary_enabled = False
        monkeypatch.setattr(document_classification, "fallback_summary_from_text", lambda _text: "")
        register_summary("proj_nosummary", "B.txt", "Statik.")

        _ingest(live_ingestor, tmp_path, "proj_nosummary", "C.txt", fassung_of="B.txt")

        assert get_document_superseded_by("proj_nosummary", ["B.txt"]) == {"B.txt": "C.txt"}
        # The listing's reconciliation backfill writes C's row („Indexed document: C.txt“), and the
        # link that waited for it is live.
        docs = _documents("proj_nosummary")
        assert docs["B.txt"].superseded_by == "C.txt"
        assert docs["C.txt"].supersedes == ["B.txt"]

    def test_the_backstop_row_is_written_before_the_job_reads_as_terminal(
        self, tmp_path, live_ingestor, stores, model, monkeypatch
    ):
        # A caller that waits for COMPLETED and then lists the collection (the BFF's settle,
        # the test above) must find the row the reconciliation writes. It once ran after the
        # terminal status, and CI's slower runner listed in between.
        from aiq_agent.knowledge import factory

        seen: list[str] = []
        reconcile = factory.reconcile_collection_summaries

        def watching(ingestor, collection, **kwargs):
            seen.extend(str(job.status) for job in ingestor._jobs.values())
            return reconcile(ingestor, collection, **kwargs)

        monkeypatch.setattr(factory, "reconcile_collection_summaries", watching)

        _ingest(live_ingestor, tmp_path, "proj_backstop", "C.txt")

        assert seen
        assert not any("COMPLETED" in status.upper() or "FAILED" in status.upper() for status in seen)

    def test_an_older_file_that_is_gone_falls_back_to_the_ordinary_suggestion(
        self, tmp_path, live_ingestor, stores, model
    ):
        from aiq_agent.knowledge import register_summary

        register_summary("proj_gone", "B.txt", "Statik.")
        model.judge = '{"of": "B.txt", "confidence": 0.9, "reason": "Gleiche Statik."}'

        _ingest(live_ingestor, tmp_path, "proj_gone", "C.txt", fassung_of="Weg.txt")

        docs = _documents("proj_gone")
        assert all(doc.superseded_by is None for doc in docs.values())
        assert docs["C.txt"].revision_suggestion["of"] == "B.txt"

    def test_a_loop_is_not_closed(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary
        from aiq_agent.knowledge import set_document_superseded_by

        register_summary("proj_loop", "B.txt", "Statik.")
        register_summary("proj_loop", "C.txt", "Statik, neu.")
        set_document_superseded_by("proj_loop", "C.txt", "B.txt")

        _ingest(live_ingestor, tmp_path, "proj_loop", "C.txt", fassung_of="B.txt")

        docs = _documents("proj_loop")
        assert docs["B.txt"].superseded_by is None
        assert docs["C.txt"].superseded_by == "B.txt"

    def test_a_choice_for_a_name_already_in_the_collection_still_links(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary

        register_summary("proj_again", "B.txt", "Die alte Statik.")
        _seed_previous_version(live_ingestor, stores, "proj_again", "C.txt")

        _ingest(live_ingestor, tmp_path, "proj_again", "C.txt", fassung_of="B.txt")

        docs = _documents("proj_again")
        assert docs["B.txt"].superseded_by == "C.txt"
        # The change is told against the file the person named, not against the earlier upload of C.
        assert docs["C.txt"].change_basis == "B.txt"

    def test_the_base_corpus_ignores_it(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary

        register_summary("oib_knowledge", "B.txt", "Statik.")

        _ingest(live_ingestor, tmp_path, "oib_knowledge", "C.txt", fassung_of="B.txt")

        assert _documents("oib_knowledge")["B.txt"].superseded_by is None


class TestAPurgeThatCanBeUndone:
    """Archive and restore, the folder bin, a publish: the BFF purges, then reads the document again."""

    def _linked(self, live_ingestor, tmp_path, collection):
        from aiq_agent.knowledge import register_summary

        register_summary(collection, "B.txt", "Statik.")
        _ingest(live_ingestor, tmp_path, collection, "C.txt", fassung_of="B.txt")
        assert _documents(collection)["B.txt"].superseded_by == "C.txt"

    def test_the_link_comes_back_when_the_newer_file_is_read_again(self, tmp_path, live_ingestor, stores, model):
        self._linked(live_ingestor, tmp_path, "proj_archive")

        assert live_ingestor.delete_file("C.txt", "proj_archive") is True
        assert _documents("proj_archive")["B.txt"].superseded_by is None  # C is gone: B answers again

        _ingest(live_ingestor, tmp_path, "proj_archive", "C.txt")

        docs = _documents("proj_archive")
        assert docs["B.txt"].superseded_by == "C.txt"
        assert docs["C.txt"].change_basis == "B.txt"

    def test_the_link_comes_back_when_the_older_file_is_read_again(self, tmp_path, live_ingestor, stores, model):
        self._linked(live_ingestor, tmp_path, "proj_bin")
        live_ingestor.delete_file("B.txt", "proj_bin")  # B has no chunks here; its row goes all the same

        _ingest(live_ingestor, tmp_path, "proj_bin", "B.txt")

        assert _documents("proj_bin")["B.txt"].superseded_by == "C.txt"

    def test_a_permanent_delete_does_not_come_back(self, tmp_path, live_ingestor, stores, model):
        self._linked(live_ingestor, tmp_path, "proj_erase")

        live_ingestor.delete_file("C.txt", "proj_erase", permanent=True)
        _ingest(live_ingestor, tmp_path, "proj_erase", "C.txt")

        docs = _documents("proj_erase")
        assert docs["B.txt"].superseded_by is None
        assert docs["C.txt"].change_basis != "B.txt"


class TestAReuploadSaysWhatChanged:
    def test_the_change_is_told_against_the_summary_read_before_it_was_overwritten(
        self, tmp_path, live_ingestor, stores, model
    ):
        _seed_previous_version(live_ingestor, stores, "proj_same", "statik.txt")

        _ingest(live_ingestor, tmp_path, "proj_same", "statik.txt")

        doc = _documents("proj_same")["statik.txt"]
        assert doc.change_summary == "- Stiege nach Norden verschoben"
        assert doc.change_basis == "statik.txt"
        (prompt,) = model.asked("replaced one Fassung")
        assert "Die alte Statik." in prompt
        assert "Neue Statik mit anderer Bewehrung." in prompt
        # A name already in the collection is not a new document: no suggestion is sought.
        assert model.asked("NEWER FASSUNG") == []
        assert doc.revision_suggestion is None

    def test_a_failed_comparison_clears_the_line_of_the_upload_before(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import set_document_change_summary

        _seed_previous_version(live_ingestor, stores, "proj_stale", "statik.txt")
        set_document_change_summary("proj_stale", "statik.txt", "- Alt, gegenüber der Upload davor", "statik.txt")
        model.fail_on = "replaced one Fassung"

        _ingest(live_ingestor, tmp_path, "proj_stale", "statik.txt")

        doc = _documents("proj_stale")["statik.txt"]
        assert doc.change_summary is None and doc.change_basis is None

    def test_the_first_upload_of_a_name_has_no_change_line(self, tmp_path, live_ingestor, stores, model):
        _ingest(live_ingestor, tmp_path, "proj_first", "statik.txt")
        assert _documents("proj_first")["statik.txt"].change_summary is None
        assert model.asked("replaced one Fassung") == []

    def test_identical_descriptions_are_no_change_and_cost_no_call(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary

        _seed_previous_version(live_ingestor, stores, "proj_same_text", "statik.txt")
        register_summary("proj_same_text", "statik.txt", "Neue Statik mit anderer Bewehrung.")

        _ingest(live_ingestor, tmp_path, "proj_same_text", "statik.txt")

        from aiq_agent.knowledge.document_revisions import NO_CHANGE_TEXT

        assert _documents("proj_same_text")["statik.txt"].change_summary == NO_CHANGE_TEXT
        assert model.asked("replaced one Fassung") == []


class TestAPersonsDecisionsSurviveTheReread:
    def test_a_confirmed_link_survives_a_same_name_reupload(self, tmp_path, live_ingestor, stores, model):
        from aiq_agent.knowledge import register_summary
        from aiq_agent.knowledge import set_document_superseded_by

        _seed_previous_version(live_ingestor, stores, "proj_keep", "statik.txt")
        register_summary("proj_keep", "statik_neu.txt", "Die neue Statik.")
        set_document_superseded_by("proj_keep", "statik.txt", "statik_neu.txt")

        _ingest(live_ingestor, tmp_path, "proj_keep", "statik.txt")

        docs = _documents("proj_keep")
        assert docs["statik.txt"].superseded_by == "statik_neu.txt"
        assert docs["statik_neu.txt"].supersedes == ["statik.txt"]

    def test_a_link_and_a_dismissal_are_carried_from_another_spelling_of_the_name(
        self, tmp_path, live_ingestor, stores, model
    ):
        from aiq_agent.knowledge import register_summary
        from aiq_agent.knowledge import set_document_revision_suggestion
        from aiq_agent.knowledge import set_document_superseded_by

        _seed_previous_version(live_ingestor, stores, "proj_tmp", "tmpa1b2c3d4_statik.txt")
        register_summary("proj_tmp", "statik_neu.txt", "Die neue Statik.")
        set_document_superseded_by("proj_tmp", "tmpa1b2c3d4_statik.txt", "statik_neu.txt")
        set_document_revision_suggestion("proj_tmp", "tmpa1b2c3d4_statik.txt", {**SUGGESTION, "dismissed": True})

        _ingest(live_ingestor, tmp_path, "proj_tmp", "statik.txt")

        docs = _documents("proj_tmp")
        assert "tmpa1b2c3d4_statik.txt" not in docs
        assert docs["statik.txt"].superseded_by == "statik_neu.txt"
        assert docs["statik.txt"].revision_suggestion["dismissed"] is True

    def test_the_previous_versions_link_and_suggestion_are_read_with_the_other_person_set_fields(self, monkeypatch):
        from aiq_agent import knowledge

        monkeypatch.setattr(knowledge, "get_document_superseded_by", lambda coll, names: {"statik.pdf": "neu.pdf"})
        monkeypatch.setattr(
            knowledge, "get_document_revision_suggestions", lambda coll, names: {"statik.pdf": '{"of": "x"}'}
        )
        found = {"statik.pdf": _PreviousVersion(chunk_ids=["c1"], stored_names=["statik.pdf"])}

        adapter_module._read_human_set_fields("proj_1", found)

        assert found["statik.pdf"].preserved["superseded_by"] == "neu.pdf"
        assert found["statik.pdf"].preserved["revision_suggestion"] == '{"of": "x"}'
