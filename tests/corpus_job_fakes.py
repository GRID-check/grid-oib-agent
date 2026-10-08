"""Stand-ins for the vector store and the ingest worker, for tests of the base corpus's ingest jobs.

:class:`FakeIngestor` can only PREPARE a job, as the real one does (a PENDING status in the ingest status
store); it raises on anything that would ingest in the calling process. :func:`run_worker` plays the ingest
worker: it claims what is queued, runs the job's download for real, and writes the outcome as the ingestor
does. Both sit on the real ingest queue and status store, which ``tests.object_corpus_fakes.install`` points
at the test database.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime

from sqlalchemy import text

from aiq_agent.knowledge import ingest_queue
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.base import PreparedIngestJob
from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_api.jobs import ingest_dispatch


@dataclass
class FakeCollection:
    chunk_count: int = 1
    file_count: int = 1


class FakeIngestor:
    """Can prepare a job, as the real one does (a PENDING status), and nothing else: it never ingests."""

    supports_durable_jobs = True
    backend_name = "fake"

    def __init__(self) -> None:
        self.prepared: list[PreparedIngestJob] = []
        self.deleted: list[str] = []
        self.indexed: set[str] = set()
        self.collection: FakeCollection | None = FakeCollection()

    def prepare_job(self, file_paths, collection_name, config=None, job_id=None) -> PreparedIngestJob:
        config = dict(config or {})
        status = IngestionJobStatus(
            job_id=job_id,
            status=JobState.PENDING,
            submitted_at=datetime.now(UTC).replace(tzinfo=None),
            total_files=len(file_paths),
            collection_name=collection_name,
            backend=self.backend_name,
            file_details=[
                FileProgress(file_id=f"{job_id}-{i}", file_name=name, status=FileStatus.UPLOADING)
                for i, name in enumerate(config["original_filenames"])
            ],
        )
        ingest_status_store.put(status)
        prepared = PreparedIngestJob(job_id, status, list(file_paths), collection_name, config)
        self.prepared.append(prepared)
        return prepared

    def upload_file(self, *_args, **_kwargs):
        raise AssertionError("the base corpus must not be ingested in this process")

    submit_job = submit_prepared = run_prepared = upload_file

    def get_collection(self, _name: str):
        return self.collection

    def create_collection(self, name: str, description: str = "") -> None:
        self.collection = FakeCollection()

    def list_files(self, _collection: str):
        return [type("Info", (), {"file_name": name})() for name in sorted(self.indexed)]

    def delete_file(self, name: str, _collection: str) -> bool:
        self.deleted.append(name)
        self.indexed.discard(name)
        return True


def _engine():
    return DocumentMetadataStore._get_or_create_sync_engine(ingest_queue.db_url())


def run_worker(*, succeed: bool = True) -> list[PreparedIngestJob]:
    """What an ingest worker does with the queue, minus the pipeline: claim, download, write the outcome."""
    ran: list[PreparedIngestJob] = []
    while claim := ingest_queue.claim_next("worker-1", stale_seconds=180, max_attempts=3):
        prepared = ingest_dispatch.decode(claim.payload)
        path = prepared.file_paths[0]()  # the job's own download, for real
        os.unlink(path)
        status = prepared.status.model_copy(deep=True)
        status.status = JobState.COMPLETED if succeed else JobState.FAILED
        for detail in status.file_details:
            detail.status = FileStatus.SUCCESS if succeed else FileStatus.FAILED
        ingest_status_store.put(status)
        ingest_queue.mark_done(claim.job_id, "worker-1")
        ran.append(prepared)
    return ran


def lose_the_workers_for(job_id: str) -> None:
    """Every claim of the job died: its queue row is dead and its owner stopped beating."""
    ingest_queue.mark_dead(job_id, "claimed 3 times without finishing")
    with _engine().begin() as conn:
        conn.execute(
            text("UPDATE ingest_jobs SET heartbeat_at = :old WHERE job_id = :id"),
            {"old": datetime(2020, 1, 1), "id": job_id},
        )
