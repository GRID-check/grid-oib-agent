"""Housekeeping as routes a scheduler calls, with the loops off (ADR-0082 step A1)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_api.routes import jobs as jobs_routes

TOKEN = "real-secret"  # pragma: allowlist secret
AUTH = {"x-grid-internal-token": TOKEN}
DB_URL = "postgresql://grid@db/grid"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.setenv("APP_ENV", "production")
    app = FastAPI()
    jobs_routes._add_housekeeping_routes(
        app, job_store=object(), db_url=DB_URL, scheduler_address="", expiry_seconds=86400
    )
    return TestClient(app)


@pytest.mark.parametrize("path", ["ghost-jobs", "job-events", "chat-checkpoints"])
def test_every_housekeeping_route_refuses_a_caller_without_the_internal_token(client: TestClient, path: str):
    assert client.post(f"/v1/maintenance/housekeeping/{path}").status_code == 403
    assert (
        client.post(f"/v1/maintenance/housekeeping/{path}", headers={"x-grid-internal-token": "wrong"}).status_code
        == 403
    )


def test_ghost_jobs_runs_one_reap_cycle_and_names_what_it_reaped(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    calls = []

    async def reap_once(job_store, db_url, scheduler_address=None):
        calls.append((db_url, scheduler_address))
        return ["job-1", "job-2"]

    monkeypatch.setattr(jobs_routes, "_reap_stale_jobs_once", reap_once)
    response = client.post("/v1/maintenance/housekeeping/ghost-jobs", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"reaped": ["job-1", "job-2"]}
    assert calls == [(DB_URL, "")]


def test_job_events_runs_the_loops_cycle_with_the_loops_settings(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    seen = {}

    async def cleanup(db_url, retention_seconds, is_postgres, expire_job_info=False, delete_grace_seconds=604800):
        seen.update(
            db_url=db_url,
            retention=retention_seconds,
            is_postgres=is_postgres,
            expire_job_info=expire_job_info,
            grace=delete_grace_seconds,
        )
        return {"old_events": 3}

    monkeypatch.setattr(jobs_routes, "_run_event_cleanup", cleanup)
    monkeypatch.setattr(jobs_routes, "_job_info_expiry", lambda: (True, 3600))
    response = client.post("/v1/maintenance/housekeeping/job-events", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"old_events": 3}
    assert seen == {"db_url": DB_URL, "retention": 86400, "is_postgres": True, "expire_job_info": True, "grace": 3600}


def test_chat_checkpoints_reports_threads_reaped(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    from aiq_api.jobs import checkpoint_retention

    monkeypatch.setenv("AIQ_CHECKPOINT_DB", "postgresql://grid@db/checkpoints")
    monkeypatch.setenv("GRID_CHAT_CHECKPOINT_RETENTION_SECONDS", "60")
    monkeypatch.setattr(checkpoint_retention, "reap_idle_threads", lambda dsn, retention: 7 if retention == 60 else -1)
    response = client.post("/v1/maintenance/housekeeping/chat-checkpoints", headers=AUTH)
    assert response.json() == {"threads_reaped": 7}


def test_chat_checkpoints_without_a_checkpoint_db_says_why_it_did_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("AIQ_CHECKPOINT_DB", raising=False)
    response = client.post("/v1/maintenance/housekeeping/chat-checkpoints", headers=AUTH)
    assert response.status_code == 200
    assert response.json()["threads_reaped"] == 0
    assert "AIQ_CHECKPOINT_DB" in response.json()["skipped"]


@pytest.mark.parametrize(
    ("value", "in_process"),
    [(None, True), ("in-process", True), ("external", False), (" External ", False), ("anything-else", True)],
)
def test_only_an_explicit_external_turns_the_loops_off(monkeypatch: pytest.MonkeyPatch, value, in_process):
    if value is None:
        monkeypatch.delenv("GRID_HOUSEKEEPING", raising=False)
    else:
        monkeypatch.setenv("GRID_HOUSEKEEPING", value)
    assert jobs_routes.housekeeping_in_process() is in_process


def test_periodic_cleanup_without_the_local_loop_starts_no_task(monkeypatch: pytest.MonkeyPatch):
    from aiq_api.jobs import submit

    monkeypatch.setattr(submit, "job_execution_mode", lambda: "db")
    started = []
    monkeypatch.setattr(jobs_routes.asyncio, "create_task", lambda coro: started.append(coro.close()))
    jobs_routes._start_periodic_cleanup(None, "", DB_URL, 86400, 20, True, local_loop=False)
    assert started == []
