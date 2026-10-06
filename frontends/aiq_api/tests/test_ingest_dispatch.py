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

    def run_prepared(self, prepared: PreparedIngestJob, still_owner=None) -> None:
        self.ran.append(prepared)
        self.still_owner = still_owner

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
    assert ingest_queue.counts()["queued"] == 1


def test_a_job_with_a_local_file_runs_where_the_file_is(db, tmp_path):
    ingestor = FakeIngestor()
    local = _prepared(files=[str(tmp_path / "upload.pdf")])

    ingest_dispatch.dispatch(ingestor, local)

    assert ingestor.local == [local]
    assert ingest_queue.counts()["queued"] == 0


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
    assert ingest_queue.counts() == {"queued": 0, "claimed": 0, "dead": 0}
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
    assert ingest_queue.counts() == {"queued": 0, "claimed": 0, "dead": 1}  # kept, with its reason
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
    assert ingest_queue.counts() == {"queued": 0, "claimed": 0, "dead": 0}


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


def test_the_runs_guard_says_no_once_another_worker_holds_the_claim(db):
    from sqlalchemy import text

    from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

    ingest_dispatch.dispatch(FakeIngestor(), _prepared())
    worker = FakeIngestor()
    ingest_dispatch.attach(worker)
    worker.source()()
    guard = worker.still_owner

    # The run is over and its row gone: a stale guard says "not yours" rather than raising.
    assert guard() is False

    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-2"))
    held = []

    def run_and_probe(prepared, still_owner=None):
        held.append(still_owner())
        with DocumentMetadataStore._get_or_create_sync_engine(db).begin() as conn:
            conn.execute(text("UPDATE ingest_job_queue SET claimed_by = 'someone-else' WHERE job_id = 'job-2'"))
        held.append(still_owner())
        held.append(still_owner())  # stays lost

    worker.run_prepared = run_and_probe
    worker.source()()

    assert held == [True, False, False]


def test_a_waiting_status_says_how_many_of_its_offices_jobs_are_ahead(db):
    ingestor = FakeIngestor()
    ingest_dispatch.dispatch(ingestor, _prepared("job-1"))
    ingest_dispatch.dispatch(ingestor, _prepared("job-2"))
    statuses = {
        "job-1": {"status": "pending", "metadata": {}},
        "job-2": {"status": "pending"},
        "local": {"status": "pending", "metadata": {}},
        "done": {"status": "completed", "metadata": {}},
        "unknown": None,
    }

    ingest_dispatch.stamp_queue_ahead(statuses)

    assert statuses["job-1"]["metadata"]["queue_ahead"] == 0
    assert statuses["job-2"]["metadata"]["queue_ahead"] == 1
    # Pending but not in the queue: the key is there, empty, so a shown count clears.
    assert statuses["local"]["metadata"] == {"queue_ahead": None}
    assert statuses["done"]["metadata"] == {}


def _queue_rows(db) -> dict[str, tuple]:
    from sqlalchemy import text

    from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

    with DocumentMetadataStore._get_or_create_sync_engine(db).connect() as conn:
        rows = conn.execute(text("SELECT job_id, status, attempts, priority FROM ingest_job_queue")).all()
    return {row[0]: tuple(row[1:]) for row in rows}


def test_a_bulk_job_is_queued_behind_an_interactive_one_of_its_office(db):
    bulk = _prepared("bulk-1")
    bulk.config["priority"] = "bulk"
    ingest_dispatch.dispatch(FakeIngestor(), bulk)
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("upload-1"))
    worker = FakeIngestor()
    ingest_dispatch.attach(worker)

    worker.source()()

    assert [p.job_id for p in worker.ran] == ["upload-1"]
    assert _queue_rows(db)["bulk-1"][2] == 1  # still waiting, stored as bulk


def test_a_job_with_no_stated_priority_is_interactive():
    assert _prepared().priority == "interactive"
    bulk = _prepared()
    bulk.config["priority"] = "bulk"
    assert bulk.priority == "bulk"
    bulk.config["priority"] = "whenever"
    assert bulk.priority == "interactive"


# ------------------------------------------------------------------ drain


@pytest.fixture(autouse=True)
def no_active_source():
    ingest_dispatch._active = None
    yield
    ingest_dispatch._active = None


def test_the_claims_a_process_still_holds_go_back_without_costing_an_attempt(db):
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-1"))
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-2"))
    worker = FakeIngestor()
    ingest_dispatch.attach(worker)
    running = worker.source()  # claimed, and not finished: the drain ran out of time
    unstarted = worker.source()

    assert ingest_dispatch.release_held() == 2

    assert _queue_rows(db) == {"job-1": ("queued", 0, 0), "job-2": ("queued", 0, 0)}
    assert running is not None and unstarted is not None


def test_a_released_run_is_told_it_no_longer_owns_the_job(db):
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-1"))
    worker = FakeIngestor()
    ingest_dispatch.attach(worker)
    job = worker.source()
    seen = []

    def run_then_get_released(prepared, still_owner=None):
        seen.append(still_owner())
        ingest_dispatch.release_held()
        seen.append(still_owner())

    worker.run_prepared = run_then_get_released
    job()

    assert seen == [True, False]
    # The finished run did not delete the row another worker may now hold.
    assert _queue_rows(db) == {"job-1": ("queued", 0, 0)}


def test_nothing_held_releases_nothing(db):
    assert ingest_dispatch.release_held() == 0
    ingest_dispatch.attach(FakeIngestor())
    assert ingest_dispatch.release_held() == 0


def test_a_claimed_job_the_scheduler_gives_back_is_requeued_unrun(db):
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-1"))
    worker = FakeIngestor()
    ingest_dispatch.attach(worker)

    worker.source().release()

    assert worker.ran == []
    assert _queue_rows(db) == {"job-1": ("queued", 0, 0)}


async def test_the_ingest_worker_gives_back_what_it_still_runs_when_the_drain_ends(db, monkeypatch, tmp_path):
    import asyncio
    import contextlib

    from aiq_agent.knowledge import factory
    from aiq_api.jobs import ingest_worker
    from nat.builder import workflow_builder
    from nat.runtime import loader

    class Stuck(FakeIngestor):
        busy_workers = 1  # a job that never finishes inside the budget

        def detach_job_source(self) -> None:
            pass

    ingestor = Stuck()

    @contextlib.asynccontextmanager
    async def fake_build(config):
        yield object()

    monkeypatch.setattr(loader, "load_config", lambda path: {"path": path})
    monkeypatch.setattr(
        workflow_builder.WorkflowBuilder, "from_config", staticmethod(lambda config: fake_build(config))
    )
    monkeypatch.setattr(factory, "get_active_ingestor", lambda: ingestor)
    monkeypatch.setenv("GRID_INGEST_WORKER_DRAIN_SECONDS", "1")
    monkeypatch.setenv("GRID_WORKER_LIVENESS_FILE", str(tmp_path / "alive"))
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-1"))

    stop = asyncio.Event()
    task = asyncio.create_task(ingest_worker.run(stop))
    for _ in range(100):
        if ingestor.source is not None:
            break
        await asyncio.sleep(0.02)
    claimed = ingestor.source()  # the job the worker is "running" when SIGTERM lands
    assert claimed is not None and _queue_rows(db)["job-1"][0] == "claimed"
    stop.set()
    await asyncio.wait_for(task, 10)

    assert _queue_rows(db) == {"job-1": ("queued", 0, 0)}


# --------------------------------------------------------------- watchdog


def _run(started_ago: float, progress_ago: float) -> ingest_dispatch._Run:
    import time

    run = ingest_dispatch._Run()
    now = time.monotonic()
    run.started, run.last_progress = now - started_ago, now - progress_ago
    return run


def _verdict(run, max_job: int = 100, progress: int = 10) -> str:
    import time

    return ingest_dispatch.beat_verdict(
        run, now=time.monotonic(), max_job_seconds=max_job, progress_timeout_seconds=progress
    )


def test_a_job_that_keeps_moving_keeps_its_claim():
    assert _verdict(_run(started_ago=50, progress_ago=2)) == "beat"


def test_a_job_that_stopped_making_progress_is_no_longer_heartbeat():
    assert _verdict(_run(started_ago=50, progress_ago=11)) == "stalled"


def test_a_job_past_its_maximum_runtime_is_expired_whatever_its_progress():
    assert _verdict(_run(started_ago=101, progress_ago=1)) == "expired"


def test_a_zero_limit_switches_its_check_off():
    stuck = _run(started_ago=10_000, progress_ago=10_000)

    assert _verdict(stuck, max_job=0, progress=0) == "beat"


def _slow_beats(monkeypatch, *, max_job: float, progress: float):
    monkeypatch.setattr(ingest_dispatch, "_max_job_seconds", lambda: max_job)
    monkeypatch.setattr(ingest_dispatch, "_progress_timeout_seconds", lambda: progress)


def test_a_run_past_its_deadline_stops_and_leaves_its_row_for_another_worker(db, monkeypatch):
    import threading

    _slow_beats(monkeypatch, max_job=0.2, progress=0)
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-1"))
    worker = FakeIngestor()
    source = ingest_dispatch.QueueSource(worker, heartbeat_seconds=0.05)
    stopped = threading.Event()

    def hung(prepared, still_owner=None):
        for _ in range(200):
            if not still_owner():
                stopped.set()
                return
            threading.Event().wait(0.02)

    worker.run_prepared = hung
    source()()

    assert stopped.is_set()
    # Not deleted: it stays claimed with a heartbeat that goes stale, and is claimed again.
    assert _queue_rows(db)["job-1"][0] == "claimed"


def test_a_stalled_run_stops_being_heartbeat_and_resumes_when_it_moves(db, monkeypatch):
    import threading

    _slow_beats(monkeypatch, max_job=0, progress=0.15)
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-1"))
    worker = FakeIngestor()
    source = ingest_dispatch.QueueSource(worker, heartbeat_seconds=0.03)
    beats: list[float] = []
    real = ingest_queue.heartbeat

    def counting(job_id, who):
        beats.append(threading.get_ident())
        return real(job_id, who)

    monkeypatch.setattr(ingest_queue, "heartbeat", counting)
    counts = {}

    def hangs_then_moves(prepared, still_owner=None):
        still_owner()  # progress at t=0
        threading.Event().wait(0.4)
        counts["stalled_at"] = len(beats)
        threading.Event().wait(0.2)
        counts["still_stalled"] = len(beats)
        still_owner()  # moves again
        threading.Event().wait(0.1)
        counts["resumed"] = len(beats)

    worker.run_prepared = hangs_then_moves
    source()()

    assert counts["still_stalled"] == counts["stalled_at"]  # no beat while it made no progress
    assert counts["resumed"] > counts["still_stalled"]


def test_a_finished_job_is_forgotten_and_its_duration_recorded(db, monkeypatch):
    recorded = []
    monkeypatch.setattr(ingest_queue.QUEUE, "record_duration", lambda seconds, kind: recorded.append(kind))
    ingest_dispatch.dispatch(FakeIngestor(), _prepared("job-1"))
    worker = FakeIngestor()
    ingest_dispatch.attach(worker)

    worker.source()()

    assert recorded == ["ingest"]
    assert _queue_rows(db) == {}


def test_the_dead_retention_is_in_days_and_never_zero(monkeypatch):
    monkeypatch.setenv("GRID_INGEST_DEAD_RETENTION_DAYS", "0")
    assert ingest_dispatch._dead_retention_seconds() == 86400
    monkeypatch.setenv("GRID_INGEST_DEAD_RETENTION_DAYS", "3")
    assert ingest_dispatch._dead_retention_seconds() == 3 * 86400


def test_a_failed_count_leaves_the_statuses_alone(db, monkeypatch):
    def broken(_ids):
        raise RuntimeError("database gone")

    monkeypatch.setattr(ingest_queue, "ahead_in_lane", broken)
    statuses = {"job-1": {"status": "pending", "metadata": {}}}

    ingest_dispatch.stamp_queue_ahead(statuses)

    assert statuses == {"job-1": {"status": "pending", "metadata": {}}}
