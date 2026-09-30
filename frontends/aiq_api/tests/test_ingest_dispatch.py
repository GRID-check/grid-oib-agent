"""A job ``/v1/ingest`` accepts runs wherever a worker is free, and only as it was accepted.

The queue itself (fair claim, reclaim, reap) is
``tests/knowledge_layer_tests/test_ingest_queue.py``; these pin the half that
lives here: what the payload carries, that a worker reads back nothing the
route would have refused, and that a job the queue cannot take still runs.
"""

from __future__ import annotations

import base64
import os
from datetime import datetime

import pytest

from aiq_agent.knowledge import ingest_queue
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.base import PreparedIngestJob
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_api.jobs import ingest_dispatch
from aiq_api.routes.ingest import DeferredObjectDownload

_ORIGINAL = "http://seaweedfs.test/bucket/doc/plan.pdf?X-Amz-Signature=secret-original"
_RENDITION = "http://seaweedfs.test/bucket/doc/plan.rendition.pdf?X-Amz-Signature=secret-rendition"
_THUMBNAIL = "http://seaweedfs.test/bucket/doc/thumb.png?X-Amz-Signature=secret-put"


@pytest.fixture(autouse=True)
def object_store(monkeypatch):
    monkeypatch.setenv("SEAWEED_ENDPOINT", "http://seaweedfs.test")
    monkeypatch.setenv("SEAWEED_PUBLIC_ENDPOINT", "http://seaweedfs.test")
    monkeypatch.delenv("GRID_JOB_PAYLOAD_KEK", raising=False)
    monkeypatch.delenv("GRID_INGEST_QUEUE", raising=False)


@pytest.fixture
def db(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/jobs.db"
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    yield url
    ingest_queue._initialized.discard(url)
    ingest_status_store._initialized.discard(url)


def _prepared(job_id: str = "job-1", *, files=None, org: str | None = "org-1") -> PreparedIngestJob:
    config = {
        "original_filenames": ["plan.pdf"],
        "document_id": "doc-1",
        "thumbnail_upload_url": _THUMBNAIL,
        "extraction_paths": [DeferredObjectDownload(_RENDITION, suffix=".pdf")],
    }
    if org:
        config["organization_id"] = org
    return PreparedIngestJob(
        job_id=job_id,
        status=IngestionJobStatus(
            job_id=job_id,
            status=JobState.PENDING,
            submitted_at=datetime(2026, 9, 30, 10, 0, 0),
            total_files=1,
            collection_name="proj_1",
            backend="llamaindex",
        ),
        file_paths=files if files is not None else [DeferredObjectDownload(_ORIGINAL)],
        collection_name="proj_1",
        config=config,
    )


class FakeIngestor:
    supports_durable_jobs = True

    def __init__(self) -> None:
        self.local: list[PreparedIngestJob] = []
        self.ran: list[PreparedIngestJob] = []
        self.source = None

    def submit_prepared(self, prepared: PreparedIngestJob) -> None:
        self.local.append(prepared)

    def run_prepared(self, prepared: PreparedIngestJob) -> None:
        self.ran.append(prepared)

    def attach_job_source(self, source) -> None:
        self.source = source


def test_the_payload_round_trips_with_its_downloads():
    decoded = ingest_dispatch.decode(ingest_dispatch.encode(_prepared()))

    assert decoded.job_id == "job-1"
    assert decoded.organization_id == "org-1"
    assert decoded.status.status == JobState.PENDING
    assert [d.to_payload() for d in decoded.file_paths] == [{"url": _ORIGINAL, "suffix": None}]
    assert decoded.config["extraction_paths"][0].to_payload() == {"url": _RENDITION, "suffix": ".pdf"}
    assert decoded.config["thumbnail_upload_url"] == _THUMBNAIL


def test_the_stored_payload_is_encrypted_when_a_key_is_set(monkeypatch):
    monkeypatch.setenv("GRID_JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(32)).decode())

    stored = ingest_dispatch.encode(_prepared())

    assert stored.startswith("enc:")
    assert "secret-original" not in stored
    assert ingest_dispatch.decode(stored).job_id == "job-1"


@pytest.mark.parametrize(
    "forged",
    [
        {"file_paths": [{"__object_download__": {"url": "http://169.254.169.254/latest/meta-data", "suffix": None}}]},
        {"file_paths": ["/etc/passwd"]},
        {"thumbnail_upload_url": "http://internal-admin.test/upload"},
    ],
)
def test_a_worker_refuses_what_the_route_would_have_refused(forged):
    """Without a KEK a row is plaintext anyone who can write the table can forge."""
    import json

    from aiq_api.jobs import payload_crypto

    data = payload_crypto.deserialize(ingest_dispatch.encode(_prepared()))
    if "thumbnail_upload_url" in forged:
        data["config"].update(forged)
    else:
        data.update(forged)
    stored = "json:" + base64.b64encode(json.dumps(data).encode()).decode()

    with pytest.raises(Exception):  # noqa: B017 - the gate's HTTPException or the shape check
        ingest_dispatch.decode(stored)


def test_an_accepted_job_goes_to_the_queue(db):
    ingestor = FakeIngestor()

    ingest_dispatch.dispatch(ingestor, _prepared())

    assert ingestor.local == []
    assert ingest_queue.depth() == 1


def test_a_job_with_a_local_file_runs_where_the_file_is(db, tmp_path):
    ingestor = FakeIngestor()
    local = _prepared(files=[str(tmp_path / "upload.pdf")])

    ingest_dispatch.dispatch(ingestor, local)

    assert ingestor.local == [local]
    assert ingest_queue.depth() == 0


def test_without_a_database_the_job_runs_here(monkeypatch):
    monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
    monkeypatch.delenv("NAT_JOB_STORE_DB_URL", raising=False)
    ingestor = FakeIngestor()

    ingest_dispatch.dispatch(ingestor, _prepared())

    assert len(ingestor.local) == 1


def test_the_queue_can_be_switched_off(db, monkeypatch):
    monkeypatch.setenv("GRID_INGEST_QUEUE", "off")
    ingestor = FakeIngestor()

    ingest_dispatch.dispatch(ingestor, _prepared())

    assert len(ingestor.local) == 1


def test_a_job_the_queue_cannot_store_still_runs(db, monkeypatch):
    def refuse(*_args):
        raise ConnectionError("database restarting")

    monkeypatch.setattr(ingest_queue, "enqueue", refuse)
    ingestor = FakeIngestor()

    ingest_dispatch.dispatch(ingestor, _prepared())

    assert len(ingestor.local) == 1


def test_a_worker_claims_runs_and_forgets_the_job(db):
    accepting = FakeIngestor()
    ingest_dispatch.dispatch(accepting, _prepared())
    worker = FakeIngestor()

    assert ingest_dispatch.attach(worker) is True
    run = worker.source()
    run()

    assert [p.job_id for p in worker.ran] == ["job-1"]
    assert worker.ran[0].file_paths[0].to_payload()["url"] == _ORIGINAL
    assert ingest_queue.depth() == 0
    assert worker.source() is None


def test_a_process_told_not_to_claim_does_not(db, monkeypatch):
    monkeypatch.setenv("GRID_INGEST_QUEUE_CLAIM", "false")
    worker = FakeIngestor()

    assert ingest_dispatch.attach(worker) is False
    assert worker.source is None


def test_an_unreadable_job_is_dropped_and_reads_failed(db):
    status = _prepared().status
    ingest_status_store.put(status)
    ingest_queue.enqueue("job-1", "org-1", "enc:not-a-payload")
    worker = FakeIngestor()
    ingest_dispatch.attach(worker)

    worker.source()()

    assert worker.ran == []
    assert ingest_queue.depth() == 0
    failed = ingest_status_store.get("job-1")
    assert failed.status == JobState.FAILED
    assert failed.error_message.startswith("unreadable_job:")


def test_another_ingestors_free_worker_claims_and_runs_the_job(db, tmp_path, monkeypatch):
    """The whole path: accepted on one replica, run by another's fair scheduler."""
    import threading

    from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

    accepting = LlamaIndexIngestor({"persist_dir": str(tmp_path / "a")})
    prepared = accepting.prepare_job([DeferredObjectDownload(_ORIGINAL)], "proj_1", {"organization_id": "org-1"})
    ingest_dispatch.dispatch(accepting, prepared)
    assert accepting._live_job_ids() == []

    worker = LlamaIndexIngestor({"persist_dir": str(tmp_path / "b")})
    done = threading.Event()
    ran = []

    def run_ingestion(job_id, files, collection, config):
        ran.append((job_id, collection, config["organization_id"], worker.config is not config))
        done.set()

    monkeypatch.setattr(worker, "_run_ingestion", run_ingestion)
    try:
        assert ingest_dispatch.attach(worker)
        assert done.wait(5)
    finally:
        worker._ingest_pool.shutdown(wait=True, timeout=5)

    assert ran == [(prepared.job_id, "proj_1", "org-1", True)]
    assert ingest_queue.depth() == 0


async def test_the_ingest_worker_claims_until_told_to_stop_then_drains(db, monkeypatch, tmp_path):
    import asyncio
    import contextlib

    from aiq_agent.knowledge import factory
    from aiq_api.jobs import ingest_worker
    from nat.builder import workflow_builder
    from nat.runtime import loader

    class Draining(FakeIngestor):
        busy_workers = 0
        detached = False

        def detach_job_source(self) -> None:
            self.detached = True

    ingestor = Draining()

    @contextlib.asynccontextmanager
    async def fake_build(config):
        yield object()

    monkeypatch.setattr(loader, "load_config", lambda path: {"path": path})
    monkeypatch.setattr(
        workflow_builder.WorkflowBuilder, "from_config", staticmethod(lambda config: fake_build(config))
    )
    monkeypatch.setattr(factory, "get_active_ingestor", lambda: ingestor)
    monkeypatch.setenv("GRID_INGEST_QUEUE_CLAIM", "false")  # the web tier's env; the worker claims anyway
    monkeypatch.setenv("GRID_WORKER_LIVENESS_FILE", str(tmp_path / "alive"))

    stop = asyncio.Event()
    task = asyncio.create_task(ingest_worker.run(stop))
    for _ in range(100):
        if ingestor.source is not None and (tmp_path / "alive").exists():
            break
        await asyncio.sleep(0.02)
    stop.set()
    await asyncio.wait_for(task, 5)

    assert ingestor.source is not None
    assert ingestor.detached is True
