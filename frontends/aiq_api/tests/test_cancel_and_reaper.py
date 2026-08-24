"""Tests for job cancellation states and the ghost-job reaper.

Covers: SUBMITTED jobs are cancellable, the reaper finds stale SUBMITTED jobs
(including zero-event ones) via job_info timestamps, and the reaper cancels the
Dask task of reaped jobs.
"""

from __future__ import annotations

from datetime import UTC
from datetime import datetime
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_agent.auth import Principal
from aiq_api.jobs import access as job_access
from aiq_api.jobs.event_store import EventStore
from aiq_api.routes.jobs import GHOST_JOB_TIMEOUT_SECONDS
from aiq_api.routes.jobs import _find_stale_jobs
from aiq_api.routes.jobs import _reap_stale_jobs_once


@pytest.fixture
def db_url(tmp_path):
    return f"sqlite+aiosqlite:///{tmp_path / 'test_cancel_and_reaper.db'}"


@pytest.fixture(autouse=True)
def clear_event_store_caches():
    EventStore._tables_initialized.clear()
    job_access._job_access_schema_initialized.clear()
    yield
    EventStore._tables_initialized.clear()
    job_access._job_access_schema_initialized.clear()


def _insert_job_info(
    db_url: str,
    job_id: str,
    *,
    status: str,
    age_seconds: int = 0,
) -> None:
    from sqlalchemy import text

    engine = EventStore._get_or_create_sync_engine(db_url)
    with engine.connect() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS job_info ("
                "  job_id TEXT PRIMARY KEY,"
                "  status TEXT,"
                "  config_file TEXT,"
                "  error TEXT,"
                "  output_path TEXT,"
                "  created_at DATETIME,"
                "  updated_at DATETIME,"
                "  expiry_seconds INTEGER,"
                "  output TEXT,"
                "  is_expired BOOLEAN DEFAULT 0"
                ")"
            )
        )
        ts = (datetime.now(UTC) - timedelta(seconds=age_seconds)).replace(tzinfo=None)
        conn.execute(
            text(
                "INSERT OR REPLACE INTO job_info "
                "(job_id, status, created_at, updated_at, expiry_seconds, is_expired) "
                "VALUES (:job_id, :status, :ts, :ts, 3600, 0)"
            ),
            {"job_id": job_id, "status": status, "ts": ts},
        )
        conn.commit()


def _backdate_events(db_url: str, job_id: str, age_seconds: int) -> None:
    from sqlalchemy import text

    engine = EventStore._get_or_create_sync_engine(db_url)
    ts = (datetime.now(UTC) - timedelta(seconds=age_seconds)).replace(tzinfo=None)
    with engine.connect() as conn:
        conn.execute(
            text("UPDATE job_events SET created_at = :ts WHERE job_id = :job_id"),
            {"ts": ts, "job_id": job_id},
        )
        conn.commit()


STALE_AGE = GHOST_JOB_TIMEOUT_SECONDS + 60
ACTIVE_STATUSES = ("running", "submitted")


class TestFindStaleJobs:
    def test_finds_running_job_with_stale_events(self, db_url):
        _insert_job_info(db_url, "job-stale", status="running", age_seconds=STALE_AGE)
        EventStore(db_url, "job-stale").store({"type": "job.heartbeat", "data": {}})
        _backdate_events(db_url, "job-stale", STALE_AGE)

        assert _find_stale_jobs(db_url, ACTIVE_STATUSES) == ["job-stale"]

    def test_skips_running_job_with_recent_events(self, db_url):
        _insert_job_info(db_url, "job-live", status="running", age_seconds=STALE_AGE)
        EventStore(db_url, "job-live").store({"type": "job.heartbeat", "data": {}})

        assert _find_stale_jobs(db_url, ACTIVE_STATUSES) == []

    def test_finds_stale_submitted_job_with_zero_events(self, db_url):
        """SUBMITTED jobs may have no events at all; the reaper must still find them."""
        _insert_job_info(db_url, "job-stuck", status="submitted", age_seconds=STALE_AGE)
        EventStore._ensure_table_exists(db_url)

        assert _find_stale_jobs(db_url, ACTIVE_STATUSES) == ["job-stuck"]

    def test_skips_recent_submitted_job(self, db_url):
        _insert_job_info(db_url, "job-new", status="submitted", age_seconds=0)
        EventStore._ensure_table_exists(db_url)

        assert _find_stale_jobs(db_url, ACTIVE_STATUSES) == []

    def test_skips_terminal_jobs_regardless_of_age(self, db_url):
        _insert_job_info(db_url, "job-done", status="success", age_seconds=STALE_AGE)
        _insert_job_info(db_url, "job-failed", status="failure", age_seconds=STALE_AGE)
        EventStore._ensure_table_exists(db_url)

        assert _find_stale_jobs(db_url, ACTIVE_STATUSES) == []

    def test_finds_stale_eventless_running_job(self, db_url):
        """Regression: RUNNING jobs whose worker died before the first event."""
        _insert_job_info(db_url, "job-crashed", status="running", age_seconds=STALE_AGE)
        EventStore._ensure_table_exists(db_url)

        assert _find_stale_jobs(db_url, ACTIVE_STATUSES) == ["job-crashed"]


class TestReapStaleJobsOnce:
    @pytest.mark.asyncio
    async def test_reaps_stale_submitted_job_and_cancels_dask_task(self, db_url, monkeypatch):
        import aiq_api.routes.jobs as jobs_routes
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        _insert_job_info(db_url, "job-stuck", status="submitted", age_seconds=STALE_AGE)
        EventStore._ensure_table_exists(db_url)

        cancel_dask = AsyncMock(return_value=True)
        monkeypatch.setattr(jobs_routes, "_cancel_dask_task", cancel_dask)
        job_store = SimpleNamespace(update_status=AsyncMock())

        reaped = await _reap_stale_jobs_once(job_store, db_url, "tcp://localhost:8786")

        assert reaped == ["job-stuck"]
        job_store.update_status.assert_awaited_once_with(
            "job-stuck",
            JobStatus.FAILURE,
            error="Job timed out (no heartbeat received from worker)",
        )
        cancel_dask.assert_awaited_once_with("tcp://localhost:8786", "job-stuck")

        events = EventStore.get_events(db_url, "job-stuck")
        assert [event["type"] for event in events] == ["job.error"]
        assert events[0]["data"]["error_type"] == "GhostJobTimeout"

    @pytest.mark.asyncio
    async def test_no_stale_jobs_is_a_no_op(self, db_url, monkeypatch):
        import aiq_api.routes.jobs as jobs_routes

        _insert_job_info(db_url, "job-live", status="running", age_seconds=0)
        EventStore(db_url, "job-live").store({"type": "job.heartbeat", "data": {}})

        cancel_dask = AsyncMock(return_value=True)
        monkeypatch.setattr(jobs_routes, "_cancel_dask_task", cancel_dask)
        job_store = SimpleNamespace(update_status=AsyncMock())

        reaped = await _reap_stale_jobs_once(job_store, db_url, "tcp://localhost:8786")

        assert reaped == []
        job_store.update_status.assert_not_awaited()
        cancel_dask.assert_not_awaited()


@pytest.fixture
async def cancel_app(db_url, monkeypatch):
    """Minimal app with the async job routes and a controllable job store."""
    import aiq_api.routes.jobs as jobs_routes

    monkeypatch.setattr(jobs_routes, "_start_periodic_cleanup", MagicMock())

    async def _no_op_reaper(*_args, **_kwargs):
        return None

    monkeypatch.setattr(jobs_routes, "_reap_ghost_jobs", _no_op_reaper)
    monkeypatch.setattr(jobs_routes, "_cancel_dask_task", AsyncMock(return_value=True))
    monkeypatch.setattr(
        jobs_routes,
        "require_verified_principal",
        lambda: Principal(type="jwt", sub="user-1", email="user@example.com"),
    )

    job_store = SimpleNamespace(get_job=AsyncMock(), update_status=AsyncMock())
    worker = SimpleNamespace(
        _dask_available=True,
        _job_store=job_store,
        _scheduler_address="tcp://localhost:8786",
        _db_url=db_url,
        _config_file_path="config.yml",
        _log_level=20,
        _use_dask_threads=False,
        _front_end_config=SimpleNamespace(expiry_seconds=86400),
    )

    app = FastAPI()
    await jobs_routes.register_job_routes(app, MagicMock(), worker)
    return app, job_store


def _job(status: str) -> SimpleNamespace:
    return SimpleNamespace(job_id="job-1", status=status, error=None, created_at=None)


class TestCancelRoute:
    @pytest.mark.asyncio
    async def test_cancel_submitted_job_is_allowed(self, cancel_app, db_url):
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        app, job_store = cancel_app
        job_store.get_job.return_value = _job("submitted")

        with TestClient(app) as client:
            response = client.post("/v1/jobs/async/job/job-1/cancel")

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "interrupted"
        job_store.update_status.assert_awaited_once_with("job-1", JobStatus.INTERRUPTED, error="cancelled by user")

        events = EventStore.get_events(db_url, "job-1")
        assert [event["type"] for event in events] == ["job.cancellation_requested"]
        assert events[0]["data"]["reason"] == "cancelled by user"

    @pytest.mark.asyncio
    async def test_cancel_running_job_is_allowed(self, cancel_app):
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        app, job_store = cancel_app
        job_store.get_job.return_value = _job("running")

        with TestClient(app) as client:
            response = client.post("/v1/jobs/async/job/job-1/cancel")

        assert response.status_code == 200
        job_store.update_status.assert_awaited_once_with("job-1", JobStatus.INTERRUPTED, error="cancelled by user")

    @pytest.mark.asyncio
    @pytest.mark.parametrize("terminal_status", ["success", "failure", "interrupted"])
    async def test_cancel_terminal_job_rejected_with_400(self, cancel_app, terminal_status):
        app, job_store = cancel_app
        job_store.get_job.return_value = _job(terminal_status)

        with TestClient(app) as client:
            response = client.post("/v1/jobs/async/job/job-1/cancel")

        assert response.status_code == 400
        job_store.update_status.assert_not_awaited()
