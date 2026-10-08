"""How long a file's record lives, and how it is removed, in the shared status store.

A file that failed has no chunks; the job row that names it is the only record
of it, and every process lists it from there (`ingest_status_store.collection_jobs`).
The row used to be backed by a per-process dict (`LlamaIndexIngestor._files`)
that grew for the life of the process and was pruned by age. With the store the
only record, the same bounds live in the store: a retention window that ends a
failed file's listing and bounds the table, a delete that forgets the file, and
a collection delete that forgets all of them.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import text

from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState

DAY = 86400
LONG_AGO = "2000-01-01 00:00:00"


@pytest.fixture
def sqlite_db(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/jobs.db"
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    yield url
    ingest_status_store._initialized.discard(url)


def _job(job_id: str, state: JobState, files: dict[str, FileStatus], collection: str = "proj_a"):
    return IngestionJobStatus(
        job_id=job_id,
        status=state,
        submitted_at=datetime(2026, 7, 22, 12, 0, 0),
        total_files=len(files),
        collection_name=collection,
        backend="llamaindex",
        file_details=[FileProgress(file_name=name, status=status) for name, status in files.items()],
    )


def _write_back(url: str, job_id: str) -> None:
    """Make the row look last written, and last vouched for, long ago."""
    engine = DocumentMetadataStore._get_or_create_sync_engine(url)
    with engine.connect() as conn:
        conn.execute(
            text("UPDATE ingest_jobs SET updated_at = :t, heartbeat_at = :t WHERE job_id = :j"),
            {"t": LONG_AGO, "j": job_id},
        )
        conn.commit()


def _names(collection: str, within: int = DAY) -> set[str]:
    jobs = ingest_status_store.collection_jobs(collection, within)
    return {detail.file_name for job in jobs for detail in job.file_details}


class TestRetention:
    def test_a_finished_job_outside_the_window_is_not_listed_and_is_pruned(self, sqlite_db):
        ingest_status_store.put(_job("old", JobState.FAILED, {"b.pdf": FileStatus.FAILED}))
        ingest_status_store.put(_job("new", JobState.FAILED, {"c.pdf": FileStatus.FAILED}))
        _write_back(sqlite_db, "old")

        assert _names("proj_a") == {"c.pdf"}

        assert ingest_status_store.prune_expired(DAY) == 1
        assert ingest_status_store.get("old") is None
        assert ingest_status_store.get("new") is not None

    def test_a_live_job_is_never_pruned_however_long_it_runs(self, sqlite_db):
        ingest_status_store.put(_job("running", JobState.PROCESSING, {"big.pdf": FileStatus.INGESTING}))
        engine = DocumentMetadataStore._get_or_create_sync_engine(sqlite_db)
        with engine.connect() as conn:
            conn.execute(text("UPDATE ingest_jobs SET updated_at = :t"), {"t": LONG_AGO})
            conn.commit()

        # Its owner still beats, so it is not stale, and so not expired.
        assert ingest_status_store.prune_expired(DAY) == 0
        assert ingest_status_store.get("running") is not None

    def test_a_job_the_queue_still_holds_is_never_pruned(self, sqlite_db):
        from aiq_agent.knowledge import ingest_queue

        ingest_status_store.put(_job("queued", JobState.PENDING, {"wait.pdf": FileStatus.UPLOADING}))
        ingest_queue.enqueue("queued", None, "payload")
        _write_back(sqlite_db, "queued")

        assert ingest_status_store.prune_expired(DAY) == 0

    def test_without_a_database_nothing_is_stored_and_nothing_is_listed(self, monkeypatch):
        monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
        monkeypatch.delenv("NAT_JOB_STORE_DB_URL", raising=False)

        assert ingest_status_store.collection_jobs("proj_a", DAY) == []
        assert ingest_status_store.forget_file("proj_a", "a.pdf") == 0
        assert ingest_status_store.prune_expired(DAY) == 0


class TestForget:
    def test_forgetting_a_file_keeps_the_other_files_of_its_job(self, sqlite_db):
        ingest_status_store.put(
            _job("j", JobState.COMPLETED, {"keep.pdf": FileStatus.SUCCESS, "gone.pdf": FileStatus.FAILED})
        )

        assert ingest_status_store.forget_file("proj_a", "gone.pdf") == 1

        assert _names("proj_a") == {"keep.pdf"}

    def test_a_job_left_with_no_file_is_deleted(self, sqlite_db):
        ingest_status_store.put(_job("j", JobState.FAILED, {"gone.pdf": FileStatus.FAILED}))

        assert ingest_status_store.forget_file("proj_a", "gone.pdf") == 1

        assert ingest_status_store.get("j") is None

    def test_a_job_still_running_keeps_its_files(self, sqlite_db):
        ingest_status_store.put(_job("j", JobState.PROCESSING, {"busy.pdf": FileStatus.INGESTING}))

        assert ingest_status_store.forget_file("proj_a", "busy.pdf") == 0

        assert _names("proj_a") == {"busy.pdf"}

    def test_another_collection_is_not_touched(self, sqlite_db):
        ingest_status_store.put(_job("a", JobState.FAILED, {"same.pdf": FileStatus.FAILED}, "proj_a"))
        ingest_status_store.put(_job("b", JobState.FAILED, {"same.pdf": FileStatus.FAILED}, "proj_b"))

        ingest_status_store.forget_file("proj_a", "same.pdf")

        assert _names("proj_a") == set()
        assert _names("proj_b") == {"same.pdf"}

    def test_forgetting_a_collection_removes_every_job_of_it(self, sqlite_db):
        ingest_status_store.put(_job("a", JobState.FAILED, {"x.pdf": FileStatus.FAILED}, "proj_a"))
        ingest_status_store.put(_job("a2", JobState.PROCESSING, {"y.pdf": FileStatus.INGESTING}, "proj_a"))
        ingest_status_store.put(_job("b", JobState.FAILED, {"x.pdf": FileStatus.FAILED}, "proj_b"))

        ingest_status_store.forget_collection("proj_a")

        assert _names("proj_a") == set()
        assert _names("proj_b") == {"x.pdf"}
