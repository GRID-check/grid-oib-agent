"""A file's state is the same in every process that asks, not the one that ran the job.

Ingestion runs only in the `ingest-worker` (ADR-0076); the HTTP routes run in the
`api` process (ADR-0082). Per-file state used to live in a dict on the ingestor
that ran the job (`_files`), so the `api` process listed a failed file nowhere,
gave a chunk-only file a new random id on every call, and could not delete a file
by the id the worker had issued. The BFF treats a name absent from the listing as
"the backend never heard of it" and lets the document be dispatched again.

Two ingestors stand for the two processes: they share one SQLite status store and
one Chroma directory, and nothing else. The worker ingests; the api never ran a job.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter as adapter_module
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_agent.knowledge.schema import stable_file_id
from tests.knowledge_layer_tests import test_reingest_replaces_versions as reingest

COLLECTION = "proj_two_processes"

# The metadata store and lexical mirror a job writes to, on temp SQLite files.
stores = reingest.stores


@pytest.fixture()
def processes(tmp_path, monkeypatch, stores):
    """``(worker, api)``: two ingestors over one status store and one Chroma directory."""
    url = f"sqlite:///{tmp_path / 'jobs.db'}"
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    monkeypatch.setattr("llama_index.core.VectorStoreIndex", reingest._IndexIntoChroma)
    monkeypatch.setattr("llama_index.core.Settings", MagicMock())

    def encrypted(_path):
        raise ValueError("PDF is encrypted")

    monkeypatch.setattr(adapter_module, "_extract_text_from_pdf", encrypted)

    def process() -> LlamaIndexIngestor:
        ingestor = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma"), "generate_summary": False})
        ingestor._embed_model = MagicMock()
        ingestor._initialized = True
        return ingestor

    yield process(), process()
    ingest_status_store._initialized.discard(url)


def _upload(tmp_path, name: str, body: bytes = b"Brandschutz im Treppenhaus.") -> str:
    path = tmp_path / f"upload_{name}"
    path.write_bytes(body)
    return str(path)


@pytest.fixture()
def worked(processes, tmp_path):
    """The worker has run one job: ``ok.txt`` indexed, ``bad.pdf`` failed. The api prepared it and ran nothing."""
    worker, api = processes
    prepared = api.prepare_job(
        [_upload(tmp_path, "ok.txt"), _upload(tmp_path, "bad.pdf", b"%PDF-1.7\n%encrypted\n")],
        COLLECTION,
        config={"original_filenames": ["ok.txt", "bad.pdf"]},
    )
    worker.run_prepared(prepared)
    assert reingest._wait_terminal(worker, prepared.job_id).status == JobState.COMPLETED
    return worker, api


def _by_name(ingestor: LlamaIndexIngestor) -> dict:
    return {f.file_name: f for f in ingestor.list_files(COLLECTION)}


def test_the_api_lists_what_the_worker_indexed_and_what_failed_with_its_reason(worked):
    _worker, api = worked

    listed = _by_name(api)

    assert set(listed) == {"ok.txt", "bad.pdf"}
    assert listed["ok.txt"].status == FileStatus.SUCCESS
    assert listed["ok.txt"].chunk_count == 1
    assert listed["bad.pdf"].status == FileStatus.FAILED
    assert listed["bad.pdf"].chunk_count == 0
    assert "PDF is encrypted" in listed["bad.pdf"].error_message


def test_both_processes_give_the_same_answer(worked):
    worker, api = worked

    assert _by_name(api) == _by_name(worker)


def test_ids_are_the_same_on_every_call_and_in_both_processes(worked):
    worker, api = worked

    first = {name: f.file_id for name, f in _by_name(api).items()}
    second = {name: f.file_id for name, f in _by_name(api).items()}

    assert first == second == {name: f.file_id for name, f in _by_name(worker).items()}
    assert first == {name: stable_file_id(COLLECTION, name) for name in ("ok.txt", "bad.pdf")}
    assert len(set(first.values())) == 2


def test_the_id_an_upload_response_carries_is_the_id_the_listing_hands_out(processes, tmp_path):
    _worker, api = processes
    prepared = api.prepare_job([_upload(tmp_path, "x.txt")], COLLECTION, config={"original_filenames": ["x.txt"]})

    assert [d.file_id for d in prepared.status.file_details] == [stable_file_id(COLLECTION, "x.txt")]


def test_a_status_lookup_by_listed_id_answers_in_either_process(worked):
    worker, api = worked
    bad_id = _by_name(api)["bad.pdf"].file_id

    from_api = api.get_file_status(bad_id, COLLECTION)
    from_worker = worker.get_file_status(bad_id, COLLECTION)

    assert from_api == from_worker
    assert from_api.status == FileStatus.FAILED
    assert api.get_file_status("not-an-id", COLLECTION) is None


def test_the_api_deletes_a_failed_file_by_the_id_it_listed(worked):
    worker, api = worked
    bad_id = _by_name(api)["bad.pdf"].file_id

    result = api.delete_files([bad_id], COLLECTION)

    assert result["successful"] == [bad_id]
    assert result["failed"] == []
    assert set(_by_name(api)) == {"ok.txt"}
    # Gone for the process that ran the job too: it is not a private record.
    assert set(_by_name(worker)) == {"ok.txt"}
    assert api.get_file_status(bad_id, COLLECTION) is None


def test_the_api_deletes_an_indexed_file_by_the_id_it_listed(worked):
    _worker, api = worked
    ok_id = _by_name(api)["ok.txt"].file_id

    assert api.delete_file(ok_id, COLLECTION) is True

    assert set(_by_name(api)) == {"bad.pdf"}
    assert api.get_collection(COLLECTION).chunk_count == 0


def test_a_file_is_still_deleted_by_its_name(worked):
    _worker, api = worked

    assert api.delete_file("bad.pdf", COLLECTION) is True
    assert set(_by_name(api)) == {"ok.txt"}


def test_a_file_waiting_for_the_worker_is_listed_as_in_flight(worked, tmp_path):
    worker, api = worked
    api.prepare_job([_upload(tmp_path, "later.txt")], COLLECTION, config={"original_filenames": ["later.txt"]})

    listed = _by_name(worker)

    assert listed["later.txt"].status == FileStatus.UPLOADING
    assert listed["later.txt"].file_id == stable_file_id(COLLECTION, "later.txt")


def test_a_failed_reupload_is_listed_failed_and_keeps_the_version_it_could_not_replace(processes, stores, tmp_path):
    worker, api = processes
    reingest._seed_previous_version(worker, stores, COLLECTION, "plan.pdf")
    prepared = api.prepare_job(
        [_upload(tmp_path, "plan.pdf", b"%PDF-1.7\n%encrypted\n")],
        COLLECTION,
        config={"original_filenames": ["plan.pdf"]},
    )
    worker.run_prepared(prepared)

    listed = _by_name(api)["plan.pdf"]

    assert listed.status == FileStatus.FAILED
    assert listed.chunk_count == 2
    assert "PDF is encrypted" in listed.error_message


def _job(job_id: str, submitted: datetime, state: JobState, status: FileStatus) -> IngestionJobStatus:
    return IngestionJobStatus(
        job_id=job_id,
        status=state,
        submitted_at=submitted,
        total_files=1,
        collection_name=COLLECTION,
        backend="llamaindex",
        file_details=[FileProgress(file_name="x.pdf", status=status, chunks_created=3)],
    )


def test_the_newest_job_that_names_a_file_decides_its_status(processes):
    _worker, api = processes
    # Written newest first: the order of the writes is not the order of the jobs.
    ingest_status_store.put(_job("newer", datetime(2026, 7, 2), JobState.COMPLETED, FileStatus.SUCCESS))
    ingest_status_store.put(_job("older", datetime(2026, 7, 1), JobState.FAILED, FileStatus.FAILED))

    assert api._recorded_files(COLLECTION)["x.pdf"].status == FileStatus.SUCCESS


def test_a_job_that_failed_before_it_reached_a_file_fails_that_file(processes):
    _worker, api = processes
    job = _job("stopped", datetime(2026, 7, 1), JobState.FAILED, FileStatus.UPLOADING)
    job.error_message = "the pool is shutting down"
    ingest_status_store.put(job)

    record = api._recorded_files(COLLECTION)["x.pdf"]

    assert record.status == FileStatus.FAILED
    assert record.error_message == "the pool is shutting down"


def test_a_finished_job_whose_chunks_are_gone_lists_nothing(processes):
    _worker, api = processes
    ingest_status_store.put(_job("done", datetime(2026, 7, 1), JobState.COMPLETED, FileStatus.SUCCESS))
    api._get_chroma_client().get_or_create_collection(COLLECTION)

    assert api.list_files(COLLECTION) == []


def test_a_file_of_the_same_name_in_another_collection_has_another_id():
    assert stable_file_id("proj_a", "plan.pdf") != stable_file_id("proj_b", "plan.pdf")
    assert stable_file_id("proj_a", "plan.pdf") == stable_file_id("proj_a", "plan.pdf")
