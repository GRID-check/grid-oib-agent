"""Ingestion that tells the truth about what it did.

- a PDF page pdfplumber cannot parse costs that page, not every page after it:
  the page is counted, the file keeps what could be read, and fails only when
  too much is missing (``_extract_text_from_pdf``, ``unreadable_pdf_verdict``);
- ``chunks_created`` is the number of nodes stored, not the number of
  Documents handed to the splitter;
- a job this process holds is found by its dispatch key while it is live
  (``find_live_job``), which is what makes ``POST /v1/ingest`` idempotent;
- a status row a dead process left at ``processing`` is answered as failed,
  reason ``interrupted``, through ``get_job_status``.
"""

import time
import uuid
from datetime import UTC
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.adapter import PdfTextPages
from knowledge_layer.llamaindex.adapter import unreadable_pdf_verdict

from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_agent.knowledge.schema import stable_file_id

# ---------------------------------------------------------------------------
# Per-page PDF reading
# ---------------------------------------------------------------------------


class _Page:
    def __init__(self, number: int, broken: bool) -> None:
        self._number = number
        self._broken = broken

    def extract_text(self):
        if self._broken:
            raise ValueError("unparseable content stream")
        return f"Seite {self._number}"


class _Pdf:
    def __init__(self, pages):
        self.pages = pages

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture()
def fake_pdf(monkeypatch):
    """``pdfplumber.open`` over pages numbered 1..n, the ones in ``broken`` raising."""
    import pdfplumber
    from knowledge_layer.llamaindex import captioned_tables

    monkeypatch.setattr(captioned_tables, "extract_page_tables", lambda *a, **k: [])

    def install(count: int, broken: set[int]):
        pages = [_Page(n, n in broken) for n in range(1, count + 1)]
        monkeypatch.setattr(pdfplumber, "open", lambda _path: _Pdf(pages))

    return install


def test_a_broken_page_costs_that_page_and_not_the_rest(fake_pdf):
    fake_pdf(60, broken={50})

    pages = adapter_module._extract_text_from_pdf("plan.pdf")

    assert [p["page_number"] for p in pages] == [n for n in range(1, 61) if n != 50]
    assert pages.failed_pages == [50]
    assert pages.page_count == 60


def test_an_unopenable_pdf_reads_as_no_pages(monkeypatch):
    import pdfplumber

    monkeypatch.setattr(pdfplumber, "open", MagicMock(side_effect=ValueError("not a PDF")))

    pages = adapter_module._extract_text_from_pdf("broken.pdf")

    assert list(pages) == [] and pages.failed_pages == [] and pages.page_count == 0


@pytest.mark.parametrize(
    ("failed", "total", "fails"),
    [
        (0, 10, False),
        (1, 10, False),
        (2, 10, False),  # 20% is the limit, inclusive
        (3, 10, True),
        (1, 1, True),  # every page
        (5, 5, True),
    ],
)
def test_the_file_fails_past_a_fifth_of_its_pages(failed, total, fails):
    pages = PdfTextPages([], failed_pages=list(range(1, failed + 1)), page_count=total)

    verdict = unreadable_pdf_verdict(pages)

    assert (verdict is not None) is fails
    if fails:
        assert verdict == f"pdf_pages_unreadable: {failed} of {total} pages could not be read"


def test_a_plain_page_list_has_nothing_to_report():
    assert unreadable_pdf_verdict([{"page_number": 1, "text": "x"}]) is None


# ---------------------------------------------------------------------------
# End to end through _run_ingestion
# ---------------------------------------------------------------------------


class _SplittingIndex:
    """Stands in for ``VectorStoreIndex``: every Document becomes three nodes, unembedded."""

    NODES_PER_DOCUMENT = 3

    @classmethod
    def from_documents(cls, documents, storage_context, **_kwargs):
        index = cls(storage_context.vector_store.client)
        for document in documents:
            index.insert(document)
        return index

    def __init__(self, collection):
        self._collection = collection

    def insert(self, document):
        metadata = {key: value for key, value in document.metadata.items() if value is not None}
        for part in range(self.NODES_PER_DOCUMENT):
            self._collection.add(
                ids=[str(uuid.uuid4())],
                documents=[f"{document.get_content()} ({part})"],
                metadatas=[metadata],
                embeddings=[[0.1, 0.2, 0.3]],
            )


@pytest.fixture()
def stores(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory
    from aiq_agent.knowledge.chunk_text_store import configure_chunk_text_store
    from aiq_agent.knowledge.chunk_text_store import reset_chunk_text_store

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    mirror = configure_chunk_text_store(f"sqlite:///{tmp_path / 'mirror.db'}")
    yield mirror
    factory._document_metadata_store = None
    reset_chunk_text_store()


@pytest.fixture()
def live_ingestor(tmp_path, monkeypatch):
    ing = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma"), "generate_summary": False})
    ing._embed_model = MagicMock()
    ing._initialized = True
    monkeypatch.setattr("llama_index.core.VectorStoreIndex", _SplittingIndex)
    monkeypatch.setattr("llama_index.core.Settings", MagicMock())
    return ing


@pytest.fixture()
def quiet_pdf_pipeline(monkeypatch):
    """No images, no rendered pages, no VLM: only the text stage speaks."""
    import knowledge_layer.llamaindex.processing as processing_module

    from aiq_agent.common.credential_resolution import ResolvedCredential

    none = ResolvedCredential(api_key="", base_url="https://vlm.test/v1", model="test-vlm", source="none")
    monkeypatch.setattr(adapter_module, "resolve_vlm_credential", lambda organization_id=None: none)
    monkeypatch.setattr(adapter_module, "_extract_images_from_pdf", lambda *a, **k: [])
    monkeypatch.setattr(processing_module, "render_visual_pages_no_vlm", lambda *a, **k: [])


def _wait_terminal(ing, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


def _pdf_upload(tmp_path):
    upload = tmp_path / "tmp_upload.pdf"
    upload.write_bytes(b"%PDF-1.7\n%test\n")
    return upload


def _text_pages(count: int, failed: list[int]) -> PdfTextPages:
    read = [n for n in range(1, count + 1) if n not in failed]
    pages = [{"page_number": n, "text": f"Brandabschnitt Seite {n}.", "tables": [], "table_boxes": []} for n in read]
    return PdfTextPages(pages, failed_pages=failed, page_count=count)


def test_chunks_created_counts_the_nodes_stored(tmp_path, live_ingestor, stores):
    upload = tmp_path / "tmp_upload.txt"
    upload.write_text("Eine Statik mit Bewehrung.", encoding="utf-8")

    job_id = live_ingestor.submit_job([str(upload)], "proj_count", config={"original_filenames": ["statik.txt"]})
    status = _wait_terminal(live_ingestor, job_id)

    assert status.file_details[0].status == FileStatus.SUCCESS
    # One Document, three nodes: the count is the three.
    assert status.file_details[0].chunks_created == _SplittingIndex.NODES_PER_DOCUMENT
    assert status.metadata["total_chunks"] == _SplittingIndex.NODES_PER_DOCUMENT


def test_a_few_unreadable_pages_are_recorded_on_a_successful_file(
    tmp_path, monkeypatch, live_ingestor, stores, quiet_pdf_pipeline
):
    monkeypatch.setattr(adapter_module, "_extract_text_from_pdf", lambda _path: _text_pages(10, [4]))

    job_id = live_ingestor.submit_job(
        [str(_pdf_upload(tmp_path))], "proj_pages", config={"original_filenames": ["plan.pdf"]}
    )
    status = _wait_terminal(live_ingestor, job_id)

    detail = status.file_details[0]
    assert detail.status == FileStatus.SUCCESS
    assert detail.pages_failed == 1


def test_too_many_unreadable_pages_fail_the_file(tmp_path, monkeypatch, live_ingestor, stores, quiet_pdf_pipeline):
    monkeypatch.setattr(adapter_module, "_extract_text_from_pdf", lambda _path: _text_pages(10, [2, 3, 4]))

    job_id = live_ingestor.submit_job(
        [str(_pdf_upload(tmp_path))], "proj_holes", config={"original_filenames": ["plan.pdf"]}
    )
    status = _wait_terminal(live_ingestor, job_id)

    detail = status.file_details[0]
    assert detail.status == FileStatus.FAILED
    assert detail.error_message == "pdf_pages_unreadable: 3 of 10 pages could not be read"
    assert status.status == JobState.FAILED


# ---------------------------------------------------------------------------
# Live jobs: found by dispatch key, and not trusted after their owner is gone
# ---------------------------------------------------------------------------


@pytest.fixture()
def held_ingestor(tmp_path):
    """An ingestor whose pool never runs anything, so a submitted job stays pending."""
    ing = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma")})
    ing._ingest_pool = MagicMock()
    return ing


def test_a_live_job_is_found_by_its_dispatch_key(tmp_path, held_ingestor):
    upload = tmp_path / "a.txt"
    upload.write_text("x", encoding="utf-8")

    job_id = held_ingestor.submit_job([str(upload)], "proj_1", config={"dispatch_key": "k1", "document_id": "doc-1"})

    assert held_ingestor.find_live_job("k1") == job_id
    assert held_ingestor.find_live_job("k2") is None
    assert held_ingestor.get_job_status(job_id).metadata == {"dispatch_key": "k1", "document_id": "doc-1"}
    assert held_ingestor._live_job_ids() == [job_id]

    held_ingestor._jobs[job_id].status = JobState.COMPLETED
    assert held_ingestor.find_live_job("k1") is None
    assert held_ingestor._live_job_ids() == []


def test_a_job_a_dead_process_left_processing_reads_interrupted(tmp_path, monkeypatch, held_ingestor):
    from sqlalchemy import create_engine
    from sqlalchemy import text

    url = f"sqlite:///{tmp_path / 'jobs.db'}"
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    try:
        stranded = IngestionJobStatus(
            job_id="stranded",
            status=JobState.PROCESSING,
            submitted_at="2026-09-29T10:00:00",
            total_files=1,
            collection_name="proj_1",
            backend="llamaindex",
            file_details=[FileProgress(file_name="plan.pdf", status=FileStatus.INGESTING)],
        )
        ingest_status_store.put(stranded)
        engine = create_engine(url)
        with engine.begin() as conn:
            conn.execute(text("UPDATE ingest_jobs SET heartbeat_at = '2000-01-01 00:00:00', owner = 'gone'"))
        engine.dispose()

        status = held_ingestor.get_job_status("stranded")

        assert status.status == JobState.FAILED
        assert status.error_message.startswith("interrupted:")
        assert status.metadata["retryable"] is True
    finally:
        ingest_status_store._initialized.discard(url)


def test_startup_settles_and_each_beat_vouches_for_live_jobs_only(monkeypatch, held_ingestor):
    calls: list[object] = []
    monkeypatch.setattr(ingest_status_store, "fail_interrupted", lambda: calls.append("sweep") or 0)
    monkeypatch.setattr(ingest_status_store, "heartbeat", lambda ids: calls.append(list(ids)))
    held_ingestor._jobs["live"] = SimpleNamespace(status=JobState.PROCESSING)
    held_ingestor._jobs["queued"] = SimpleNamespace(status=JobState.PENDING)
    held_ingestor._jobs["done"] = SimpleNamespace(status=JobState.COMPLETED)

    held_ingestor._settle_stranded_jobs()
    held_ingestor._beat()

    assert calls == ["sweep", ["live", "queued"]]


# ---------------------------------------------------------------------------
# A status write that did not land is written again by the heartbeat
# ---------------------------------------------------------------------------


@pytest.fixture()
def status_db(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'jobs.db'}"
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    yield url
    ingest_status_store._initialized.discard(url)


def _age_row(url: str, job_id: str) -> None:
    from sqlalchemy import create_engine
    from sqlalchemy import text

    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE ingest_jobs SET heartbeat_at = '2000-01-01 00:00:00' WHERE job_id = :j"), {"j": job_id}
        )
    engine.dispose()


def _tracked_job(ingestor, job_id: str, state: JobState) -> IngestionJobStatus:
    job = IngestionJobStatus(
        job_id=job_id,
        status=state,
        submitted_at="2026-09-29T10:00:00",
        total_files=1,
        collection_name="proj_1",
        backend="llamaindex",
        file_details=[FileProgress(file_name="plan.pdf", status=FileStatus.INGESTING)],
    )
    ingestor._jobs[job_id] = job
    return job


def _finish(ingestor, job: IngestionJobStatus) -> None:
    with ingestor._lock:
        job.status = JobState.COMPLETED
        # Naive UTC, as the adapter writes it; recent, so retention keeps it.
        job.completed_at = datetime.now(UTC).replace(tzinfo=None).isoformat()
        job.file_details[0].status = FileStatus.SUCCESS


def test_a_lost_terminal_write_is_retried_until_it_lands(status_db, monkeypatch, held_ingestor):
    """The chunks are indexed; the row must not age into `failed: interrupted`."""
    job = _tracked_job(held_ingestor, "job-1", JobState.PROCESSING)
    held_ingestor._persist(job)
    _finish(held_ingestor, job)

    real_put = ingest_status_store.put
    monkeypatch.setattr(ingest_status_store, "put", lambda status: False)
    held_ingestor._persist(job)
    assert held_ingestor._unpersisted == {"job-1"}

    held_ingestor._beat()  # the database is still unreachable: kept for the next beat
    assert held_ingestor._unpersisted == {"job-1"}

    monkeypatch.setattr(ingest_status_store, "put", real_put)
    held_ingestor._beat()

    assert held_ingestor._unpersisted == set()
    _age_row(status_db, "job-1")  # long after: a finished row is never settled
    assert ingest_status_store.get("job-1").status == JobState.COMPLETED


def test_a_job_settled_while_its_owner_could_not_beat_is_written_back(status_db, held_ingestor):
    """Another replica read the stale row as interrupted; the owner, alive, restores it within one beat."""
    job = _tracked_job(held_ingestor, "job-1", JobState.PROCESSING)
    held_ingestor._persist(job)
    _age_row(status_db, "job-1")
    assert ingest_status_store.get("job-1").status == JobState.FAILED

    held_ingestor._beat()

    assert ingest_status_store.get("job-1").status == JobState.PROCESSING
    assert ingest_status_store.heartbeat(["job-1"]) == 1


def test_a_live_job_whose_first_write_never_landed_is_written_by_the_beat(status_db, held_ingestor):
    _tracked_job(held_ingestor, "job-1", JobState.PENDING)

    held_ingestor._beat()

    assert ingest_status_store.get("job-1").status == JobState.PENDING


def test_a_job_no_longer_tracked_is_not_retried(monkeypatch, held_ingestor):
    """Retention bounds the retry set: a pruned job has nothing left to write."""
    monkeypatch.setattr(ingest_status_store, "heartbeat", lambda ids: None)
    puts: list[str] = []
    monkeypatch.setattr(ingest_status_store, "put", lambda status: puts.append(status.job_id) or False)
    held_ingestor._unpersisted.add("pruned")

    held_ingestor._beat()

    assert puts == [] and held_ingestor._unpersisted == set()


def test_a_retry_writes_the_job_as_it_is_now(status_db, monkeypatch, held_ingestor):
    """The retry stores the latest status, never the one whose write failed."""
    job = _tracked_job(held_ingestor, "job-1", JobState.PROCESSING)
    real_put = ingest_status_store.put
    monkeypatch.setattr(ingest_status_store, "put", lambda status: False)
    held_ingestor._persist(job)
    monkeypatch.setattr(ingest_status_store, "put", real_put)
    _finish(held_ingestor, job)

    held_ingestor._beat()

    assert ingest_status_store.get("job-1").status == JobState.COMPLETED


# ---------------------------------------------------------------------------
# Fair share, and a job that runs in another process than the one that took it
# ---------------------------------------------------------------------------


def test_a_submitted_job_waits_in_its_organisations_lane(tmp_path, held_ingestor):
    upload = tmp_path / "a.txt"
    upload.write_text("x", encoding="utf-8")

    held_ingestor.submit_job([str(upload)], "proj_1", config={"organization_id": "org-1"})

    lane = held_ingestor._ingest_pool.submit.call_args.args[0]
    assert lane == "org-1"


def test_a_prepared_job_is_vouched_for_by_the_process_that_runs_it(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'jobs.db'}"
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    upload = tmp_path / "a.txt"
    upload.write_text("x", encoding="utf-8")
    accepting = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma")})
    try:
        prepared = accepting.prepare_job([str(upload)], "proj_1", config={"organization_id": "org-1"})

        # Recorded for every replica to read, but not this process's to beat for:
        # the durable queue may hand it to any worker.
        assert accepting._live_job_ids() == []
        assert accepting.get_job_status(prepared.job_id).status == JobState.PENDING
        assert prepared.organization_id == "org-1"

        running = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma")})
        ran = []
        monkeypatch.setattr(running, "_run_ingestion", lambda job_id, *_: ran.append(job_id))
        running.run_prepared(prepared)

        assert ran == [prepared.job_id]
        assert running._live_job_ids() == [prepared.job_id]
        # The file's id is derived, so the process that runs the job and the one
        # that prepared it name the file alike.
        assert [(d.file_name, d.file_id) for d in running._jobs[prepared.job_id].file_details] == [
            ("a.txt", stable_file_id("proj_1", "a.txt"))
        ]
    finally:
        ingest_status_store._initialized.discard(url)


def test_a_job_that_fails_validation_is_final_at_once(tmp_path, held_ingestor):
    prepared = held_ingestor.prepare_job([str(tmp_path / "missing.pdf")], "proj_1")

    assert prepared.status.status == JobState.FAILED
    assert held_ingestor.get_job_status(prepared.job_id).status == JobState.FAILED
    held_ingestor._ingest_pool.submit.assert_not_called()


def test_a_job_the_pool_refuses_reads_failed_not_pending(tmp_path):
    ing = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma")})
    ing._ingest_pool.shutdown(wait=True)
    upload = tmp_path / "a.txt"
    upload.write_text("x", encoding="utf-8")

    with pytest.raises(RuntimeError):
        ing.submit_job([str(upload)], "proj_1", config={"organization_id": "org-1"})

    (job_id,) = ing._jobs
    status = ing.get_job_status(job_id)
    assert status.status == JobState.FAILED
    assert status.error_message.startswith("interrupted:")
    assert ing._live_job_ids() == []
