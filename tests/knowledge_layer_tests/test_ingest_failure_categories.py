"""A failed file says why on the job, and the job says which reader read it.

The BFF decides whether reading a failed document again is worth anything from
``FileProgress.failure_category`` / ``retryable`` and the job's
``reader_version`` (``frontends/ui/src/lib/documents/retry-policy.ts``). These
run real jobs through the adapter, with the embedder faked and a real Qdrant
(the shared ``qdrant_store`` fixture), and read what the job reports: what the
BFF's reconcile reads.
"""

import time

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.reader_version import INGEST_READER_VERSION

from aiq_agent.common.credential_resolution import ResolvedCredential
from aiq_agent.knowledge.ingest_status_store import interrupted
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState


@pytest.fixture
def summary_db(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture
def ingestor(monkeypatch, summary_db, qdrant_store):
    from sources.knowledge_layer.tests.qdrant_testing import FakeEmbedder

    ing = LlamaIndexIngestor({"generate_summary": False})
    ing._embed_model = FakeEmbedder()
    ing._initialized = True
    cred = ResolvedCredential(api_key="", base_url="https://vlm.test/v1", model="test-vlm", source="none")
    monkeypatch.setattr(adapter, "resolve_vlm_credential", lambda organization_id=None: cred)
    return ing


def _run(ing: LlamaIndexIngestor, path, name: str) -> IngestionJobStatus:
    job_id = ing.submit_job([str(path)], "coll_retry", config={"original_filenames": [name]})
    deadline = time.time() + 30
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def test_a_missing_vision_model_is_configuration_and_the_job_names_its_reader(tmp_path, ingestor):
    from PIL import Image

    img = tmp_path / "foto.png"
    Image.new("RGB", (40, 30), "red").save(img, format="PNG")

    status = _run(ingestor, img, "foto.png")

    detail = status.file_details[0]
    assert detail.status == FileStatus.FAILED
    assert (detail.failure_category, detail.retryable) == ("configuration", True)
    assert status.reader_version == INGEST_READER_VERSION


def test_an_exception_of_the_moment_is_transient(tmp_path, ingestor, monkeypatch):
    def times_out(_path):
        raise TimeoutError("read timed out")

    monkeypatch.setattr(adapter, "_extract_text_from_pdf", times_out)
    pdf = tmp_path / "plan.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")

    detail = _run(ingestor, pdf, "plan.pdf").file_details[0]

    assert detail.status == FileStatus.FAILED
    assert detail.error_message == "read timed out"
    assert (detail.failure_category, detail.retryable) == ("transient", True)


def test_a_file_whose_bytes_cannot_be_read_is_deterministic(tmp_path, ingestor, monkeypatch):
    def refuses(_path):
        raise ValueError("Raw PDF/binary content detected; refusing to index")

    monkeypatch.setattr(adapter, "_extract_text_from_pdf", refuses)
    pdf = tmp_path / "kaputt.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")

    detail = _run(ingestor, pdf, "kaputt.pdf").file_details[0]

    assert (detail.failure_category, detail.retryable) == ("deterministic", False)


def test_an_empty_file_is_deterministic(tmp_path, ingestor, monkeypatch):
    # Nothing on any page, and nothing to transcribe: the adapter's own "no content" verdict.
    monkeypatch.setattr(adapter, "_extract_text_from_pdf", lambda _path: [])
    pdf = tmp_path / "leer.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")

    detail = _run(ingestor, pdf, "leer.pdf").file_details[0]

    assert detail.status == FileStatus.FAILED
    assert (detail.failure_category, detail.retryable) == ("deterministic", False)


def test_a_file_that_reads_carries_no_failure(tmp_path, ingestor):
    doc = tmp_path / "notiz.txt"
    doc.write_text("Brandschutzkonzept für das Gebäude.", encoding="utf-8")

    status = _run(ingestor, doc, "notiz.txt")

    detail = status.file_details[0]
    assert detail.status == FileStatus.SUCCESS
    assert (detail.failure_category, detail.retryable) == (None, None)
    assert status.reader_version == INGEST_READER_VERSION


def test_a_job_whose_owner_died_fails_its_unfinished_files_as_transient():
    job = IngestionJobStatus(
        job_id="j1",
        status=JobState.PROCESSING,
        submitted_at="2026-10-13T00:00:00",
        collection_name="c",
        backend="llamaindex",
        file_details=[
            FileProgress(file_name="a.pdf", status=FileStatus.INGESTING),
            FileProgress(file_name="b.pdf", status=FileStatus.SUCCESS),
        ],
    )

    failed = interrupted(job)

    unfinished, finished = failed.file_details
    assert (unfinished.failure_category, unfinished.retryable) == ("transient", True)
    assert (finished.failure_category, finished.retryable) == (None, None)
