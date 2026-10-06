"""A draining research worker gives its jobs back; it does not lose them or fail them (ADR-0078).

On SIGTERM the worker stops claiming and waits for the jobs it holds. A job still
running when the drain budget ends goes back to the queue at no cost in attempts,
waits there as ``submitted`` (so the ghost-job reaper leaves it alone), and the
run in this process stops without publishing a verdict. The next worker claims it
at once instead of after the stale window.
"""

from __future__ import annotations

import asyncio
from datetime import UTC
from datetime import datetime

import pytest
from sqlalchemy import text

from aiq_api.jobs import queue
from aiq_api.jobs import worker as worker_mod
from aiq_api.jobs.event_store import EventStore


def _seed_job_info(db_url: str, job_id: str, status: str) -> None:
    engine = EventStore._get_or_create_sync_engine(db_url)
    with engine.connect() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS job_info ("
                "  job_id TEXT PRIMARY KEY, status TEXT, config_file TEXT, error TEXT, output_path TEXT,"
                "  created_at DATETIME, updated_at DATETIME, expiry_seconds INTEGER, output TEXT,"
                "  is_expired BOOLEAN DEFAULT 0)"
            )
        )
        ts = datetime.now(UTC).replace(tzinfo=None)
        conn.execute(
            text(
                "INSERT OR REPLACE INTO job_info (job_id, status, created_at, updated_at, expiry_seconds, is_expired) "
                "VALUES (:job_id, :status, :ts, :ts, 3600, 0)"
            ),
            {"job_id": job_id, "status": status, "ts": ts},
        )
        conn.commit()


@pytest.fixture
def fleet(tmp_path, monkeypatch):
    db_url = f"sqlite:///{tmp_path}/jobs.db"
    async_url = f"sqlite+aiosqlite:///{tmp_path}/jobs.db"
    queue.ensure_research_queue_table(db_url)
    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", async_url)
    monkeypatch.setenv("GRID_WORKER_LIVENESS_FILE", str(tmp_path / "alive"))
    monkeypatch.delenv("AIQ_DEEP_CHECKPOINT_DB", raising=False)
    monkeypatch.delenv("GRID_JOB_PAYLOAD_KEK", raising=False)
    yield db_url, async_url
    queue._queues.pop(db_url, None)


def _job_status(db_url: str, job_id: str) -> str:
    engine = EventStore._get_or_create_sync_engine(db_url)
    with engine.connect() as conn:
        return conn.execute(text("SELECT status FROM job_info WHERE job_id = :j"), {"j": job_id}).scalar()


async def test_a_job_that_outlasts_the_drain_goes_back_to_the_queue_without_an_attempt(fleet, monkeypatch):
    db_url, async_url = fleet
    queue.enqueue(db_url, "job-1", {"input_text": "long"}, "org-a")
    _seed_job_info(db_url, "job-1", "running")
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def run_forever(**_kwargs):
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(worker_mod, "run_agent_job", run_forever)
    worker = worker_mod.ResearchWorker()
    worker.poll_seconds = 0.01
    worker.drain_seconds = 0.1

    task = asyncio.create_task(worker.run())
    await asyncio.wait_for(started.wait(), timeout=10)
    worker.request_stop()
    await asyncio.wait_for(task, timeout=15)  # returns: a worker that cannot drain must still exit

    assert cancelled.is_set(), "the run in this process stopped"
    # The claim is back, spent no attempt, and is another worker's to take at once.
    assert queue.claim_state(db_url, "job-1") == (queue.QUEUED, None)
    assert queue.counts(db_url) == {"queued": 1, "claimed": 0, "dead": 0}
    taken = queue.claim_next(db_url, "worker-B", 90, 3)
    assert (taken["job_id"], taken["attempts"]) == ("job-1", 1)
    # It waits as submitted, not running, so the ghost reaper does not fail it, and nothing says "cancelled".
    assert _job_status(async_url, "job-1") == "submitted"


async def test_a_given_back_run_stops_before_any_status_write_and_a_new_owners_running_stands(fleet, monkeypatch):
    db_url, async_url = fleet
    queue.enqueue(db_url, "job-1", {"input_text": "long"}, "org-a")
    _seed_job_info(db_url, "job-1", "running")
    started, cancelled = asyncio.Event(), asyncio.Event()
    real_release = queue.release_claims

    async def run_forever(**_kwargs):
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    def release_then_another_worker_claims(db, job_ids, worker_id):
        released = real_release(db, job_ids, worker_id)
        assert queue.claim_next(db, "worker-B", 90, 3)["job_id"] == "job-1"  # an idle worker's next poll
        return released

    real_mark_waiting = worker_mod.ResearchWorker._mark_waiting
    order: list[str] = []

    async def mark_waiting(self, job_ids):
        order.append("cancelled" if cancelled.is_set() else "still running")
        await real_mark_waiting(self, job_ids)

    monkeypatch.setattr(worker_mod, "run_agent_job", run_forever)
    monkeypatch.setattr(worker_mod.queue, "release_claims", release_then_another_worker_claims)
    monkeypatch.setattr(worker_mod.ResearchWorker, "_mark_waiting", mark_waiting)
    worker = worker_mod.ResearchWorker()
    worker.poll_seconds = 0.01
    worker.drain_seconds = 0.1

    task = asyncio.create_task(worker.run())
    await asyncio.wait_for(started.wait(), timeout=10)
    worker.request_stop()
    await asyncio.wait_for(task, timeout=15)

    assert order == ["cancelled"]  # the old run had stopped before the status was touched
    assert queue.claim_state(db_url, "job-1") == (queue.CLAIMED, "worker-B")
    assert _job_status(async_url, "job-1") == "running"  # worker-B's run: not set back to waiting


async def test_a_job_that_finishes_inside_the_drain_is_not_given_back(fleet, monkeypatch):
    db_url, async_url = fleet
    queue.enqueue(db_url, "job-1", {"input_text": "short"}, "org-a")
    _seed_job_info(db_url, "job-1", "running")
    started, release = asyncio.Event(), asyncio.Event()
    finished: list[str] = []

    async def finish_when_told(**kwargs):
        started.set()
        await release.wait()
        finished.append(kwargs["input_text"])

    monkeypatch.setattr(worker_mod, "run_agent_job", finish_when_told)
    worker = worker_mod.ResearchWorker()
    worker.poll_seconds = 0.01
    worker.drain_seconds = 30

    task = asyncio.create_task(worker.run())
    await asyncio.wait_for(started.wait(), timeout=10)
    worker.request_stop()
    await asyncio.sleep(0.1)
    assert not task.done(), "the worker waits for the job it holds"
    release.set()
    await asyncio.wait_for(task, timeout=15)

    assert finished == ["short"]
    assert queue.counts(db_url) == {"queued": 0, "claimed": 0, "dead": 0}  # done: the row is gone
    assert _job_status(async_url, "job-1") == "running"  # the worker's own verdict is the runner's to write


async def test_the_worker_claims_with_the_per_organization_cap(fleet, monkeypatch):
    db_url, _ = fleet
    monkeypatch.setenv("GRID_MAX_ACTIVE_JOBS_PER_ORG", "1")
    for n in range(2):
        queue.enqueue(db_url, f"a{n}", {"input_text": "x"}, "org-a")
    seen: list[int] = []
    real = queue.claim_next

    def spy(db, worker_id, stale, attempts, per_lane_cap=0):
        seen.append(per_lane_cap)
        return real(db, worker_id, stale, attempts, per_lane_cap)

    monkeypatch.setattr(worker_mod.queue, "claim_next", spy)
    started = asyncio.Event()
    ran: list[str] = []

    async def hold(**kwargs):
        ran.append(kwargs["input_text"])
        started.set()
        await asyncio.sleep(60)

    monkeypatch.setattr(worker_mod, "run_agent_job", hold)
    worker = worker_mod.ResearchWorker()
    worker.concurrency = 2  # room for both, so only the cap can keep the second one waiting
    worker.poll_seconds = 0.01
    worker.drain_seconds = 0.1

    task = asyncio.create_task(worker.run())
    await asyncio.wait_for(started.wait(), timeout=10)
    await asyncio.sleep(0.2)
    worker.request_stop()
    await asyncio.wait_for(task, timeout=15)

    assert set(seen) == {1}
    # Only one of the organization's two jobs ran, though the worker had a free slot for both.
    assert len(ran) == 1
    assert queue.counts(db_url)["queued"] == 2  # the one that ran went back with the drain
