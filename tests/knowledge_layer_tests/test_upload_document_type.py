"""The document type a person chose at filing is a human-set field, and the classifier never overwrites it.

`POST /v1/ingest` carries it as `document_type` (the BFF's `ShelfUploadInput.documentType`);
the ingest job stores it as the row's type tag under the store's one person marker
(`tags_set_by = 'person'`), beside `_read_human_set_fields`. So:

- this read stores the chosen type, not the classifier's, and keeps the
  classifier's discipline tags beside it;
- a later read that carries no choice („Erneut lesen", a reindex) keeps it;
- a re-upload that chooses again replaces only the type, and a person's own
  discipline tags survive it;
- a filing that chose nothing is classified exactly as before.

`document-tags-update` (the tag editor's `PATCH`) cannot serve here: it needs the
metadata row, which exists only once this job has read the file, and a value set
before that would be overwritten by the job's own classification.

The unit tests drive the pure helpers; the end-to-end ones run `_run_ingestion`
over a real SQLite store and a real Qdrant collection. Every value is read from
the vocabulary, so a rename of its tokens touches nothing here.
"""

import time
import uuid

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from langchain_core.messages import AIMessage

from aiq_agent.knowledge.document_classification import DISCIPLINE_TAGS
from aiq_agent.knowledge.document_classification import DOCUMENT_TYPE_TAGS
from aiq_agent.knowledge.document_classification import MAX_TAGS

#: What the fake classifier reads, and what a person chooses instead.
CLASSIFIED_TYPE, SECOND_CLASSIFIED_TYPE, CHOSEN_TYPE, LATER_TYPE = DOCUMENT_TYPE_TAGS[2:6]
CLASSIFIED_DISCIPLINE, PERSON_DISCIPLINE = DISCIPLINE_TAGS[:2]


# ---------------------------------------------------------------------------
# The pure helpers
# ---------------------------------------------------------------------------


class TestWithDocumentType:
    def test_the_chosen_type_replaces_every_classified_type_and_leads(self):
        tags = [CLASSIFIED_TYPE, CLASSIFIED_DISCIPLINE, SECOND_CLASSIFIED_TYPE]

        assert adapter_module._with_document_type(tags, CHOSEN_TYPE) == [CHOSEN_TYPE, CLASSIFIED_DISCIPLINE]

    def test_no_tags_at_all_is_the_chosen_type_alone(self):
        assert adapter_module._with_document_type(None, CHOSEN_TYPE) == [CHOSEN_TYPE]
        assert adapter_module._with_document_type([], CHOSEN_TYPE) == [CHOSEN_TYPE]

    def test_the_chosen_type_is_never_stored_twice(self):
        assert adapter_module._with_document_type([CHOSEN_TYPE, CLASSIFIED_DISCIPLINE], CHOSEN_TYPE) == [
            CHOSEN_TYPE,
            CLASSIFIED_DISCIPLINE,
        ]

    def test_the_tag_cap_holds(self):
        result = adapter_module._with_document_type(list(DISCIPLINE_TAGS), CHOSEN_TYPE)

        assert result[0] == CHOSEN_TYPE
        assert len(result) == MAX_TAGS


class TestChosenDocumentType:
    @pytest.mark.parametrize("document_type", DOCUMENT_TYPE_TAGS)
    def test_a_type_of_the_vocabulary_is_honoured(self, document_type):
        assert adapter_module._chosen_document_type({"document_type": document_type}) == document_type

    @pytest.mark.parametrize("config", [{}, {"document_type": None}, {"document_type": ""}])
    def test_no_choice_is_none(self, config):
        assert adapter_module._chosen_document_type(config) is None

    def test_a_queued_value_outside_the_vocabulary_is_dropped_not_stored(self, caplog):
        assert adapter_module._chosen_document_type({"document_type": DISCIPLINE_TAGS[0]}) is None
        assert "outside the vocabulary" in caplog.text


# ---------------------------------------------------------------------------
# End to end through _run_ingestion
# ---------------------------------------------------------------------------


class _SummaryModel:
    """Answers every prompt with one sentence: the summary is all these tests need from it."""

    def invoke(self, prompt):
        return AIMessage(content="A letter to the building authority.")


@pytest.fixture()
def stores(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture()
def classified(monkeypatch):
    """The classifier's reading, which a test may change between reads."""
    from aiq_agent.knowledge import document_classification

    reading = [CLASSIFIED_TYPE, CLASSIFIED_DISCIPLINE]
    monkeypatch.setattr(document_classification, "classify_document_tags", lambda *_a, **_k: list(reading))
    return reading


@pytest.fixture()
def ingestor(qdrant_store, classified):
    from sources.knowledge_layer.tests.qdrant_testing import FakeEmbedder

    ing = LlamaIndexIngestor({"generate_summary": True, "summary_llm": _SummaryModel()})
    ing._embed_model = FakeEmbedder()
    ing._initialized = True
    return ing


def _ingest(ing, tmp_path, collection, file_name, **extra):
    upload = tmp_path / f"tmp_{uuid.uuid4().hex[:8]}.txt"
    upload.write_text("Dear Sir or Madam, please find the documents enclosed.", encoding="utf-8")
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
    deadline = time.time() + 30
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            assert status.file_details[0].status.value == "success"
            return
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _tags(collection, file_name):
    from aiq_agent.knowledge import get_available_documents

    return {doc.file_name: doc for doc in get_available_documents(collection)}[file_name].tags


def _person_tags(collection, file_name):
    from aiq_agent.knowledge import get_document_person_tags

    return get_document_person_tags(collection, [file_name]).get(file_name)


class TestTheChosenTypeIsAPersonsChoice:
    def test_the_chosen_type_is_stored_as_the_persons_beside_the_classified_disciplines(
        self, tmp_path, ingestor, stores
    ):
        _ingest(ingestor, tmp_path, "proj_a", "letter.txt", document_type=CHOSEN_TYPE)

        assert _tags("proj_a", "letter.txt") == [CHOSEN_TYPE, CLASSIFIED_DISCIPLINE]
        assert _person_tags("proj_a", "letter.txt") == [CHOSEN_TYPE, CLASSIFIED_DISCIPLINE]

    def test_a_later_read_without_a_choice_keeps_it(self, tmp_path, ingestor, stores, classified):
        _ingest(ingestor, tmp_path, "proj_b", "letter.txt", document_type=CHOSEN_TYPE)
        classified[:] = [SECOND_CLASSIFIED_TYPE]

        _ingest(ingestor, tmp_path, "proj_b", "letter.txt")

        assert _tags("proj_b", "letter.txt") == [CHOSEN_TYPE, CLASSIFIED_DISCIPLINE]

    def test_a_new_choice_replaces_the_type_and_keeps_a_persons_disciplines(self, tmp_path, ingestor, stores):
        from aiq_agent.knowledge import set_document_tags_by_person

        _ingest(ingestor, tmp_path, "proj_c", "letter.txt", document_type=CHOSEN_TYPE)
        set_document_tags_by_person("proj_c", "letter.txt", [CHOSEN_TYPE, PERSON_DISCIPLINE])

        _ingest(ingestor, tmp_path, "proj_c", "letter.txt", document_type=LATER_TYPE)

        assert _tags("proj_c", "letter.txt") == [LATER_TYPE, PERSON_DISCIPLINE]

    def test_a_filing_that_chose_nothing_is_classified_as_before(self, tmp_path, ingestor, stores):
        _ingest(ingestor, tmp_path, "proj_d", "letter.txt")

        assert _tags("proj_d", "letter.txt") == [CLASSIFIED_TYPE, CLASSIFIED_DISCIPLINE]
        assert _person_tags("proj_d", "letter.txt") is None
