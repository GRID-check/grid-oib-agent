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
    jobs_routes._add_housekeeping_routes(app, job_store=object(), db_url=DB_URL, expiry_seconds=86400)
    return TestClient(app)


@pytest.mark.parametrize("path", ["ghost-jobs", "job-events", "chat-checkpoints", "base-corpus"])
def test_every_housekeeping_route_refuses_a_caller_without_the_internal_token(client: TestClient, path: str):
    assert client.post(f"/v1/maintenance/housekeeping/{path}").status_code == 403
    assert (
        client.post(f"/v1/maintenance/housekeeping/{path}", headers={"x-grid-internal-token": "wrong"}).status_code
        == 403
    )


def test_ghost_jobs_runs_one_reap_cycle_and_names_what_it_reaped(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    calls = []

    async def reap_once(job_store, db_url):
        calls.append(db_url)
        return ["job-1", "job-2"]

    monkeypatch.setattr(jobs_routes, "_reap_stale_jobs_once", reap_once)
    response = client.post("/v1/maintenance/housekeeping/ghost-jobs", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"reaped": ["job-1", "job-2"]}
    assert calls == [DB_URL]


def test_job_events_runs_one_cleanup_cycle_with_the_expiry_settings(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    seen = {}

    async def cleanup(db_url, retention_seconds, is_postgres, delete_grace_seconds=604800):
        seen.update(db_url=db_url, retention=retention_seconds, is_postgres=is_postgres, grace=delete_grace_seconds)
        return {"old_events": 3}

    monkeypatch.setattr(jobs_routes, "_run_event_cleanup", cleanup)
    monkeypatch.setenv("GRID_JOB_INFO_DELETE_GRACE_SECONDS", "3600")
    response = client.post("/v1/maintenance/housekeeping/job-events", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"old_events": 3}
    assert seen == {"db_url": DB_URL, "retention": 86400, "is_postgres": True, "grace": 3600}


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


def test_base_corpus_runs_one_sync_cycle_and_reports_its_counts(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    from aiq_agent import oib_sync

    calls = []

    def sync():
        calls.append("sync")
        return oib_sync.SyncResult(enqueued=3, ingested_recorded=2, failed=1, total=12)

    monkeypatch.setattr(oib_sync, "sync", sync)
    response = client.post("/v1/maintenance/housekeeping/base-corpus", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"enqueued": 3, "ingested_recorded": 2, "failed": 1, "total": 12}
    assert calls == ["sync"]


def test_base_corpus_does_not_sync_for_a_caller_without_the_token(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    from aiq_agent import oib_sync

    monkeypatch.setattr(oib_sync, "sync", lambda: pytest.fail("an unauthenticated call must not start a sync"))
    assert client.post("/v1/maintenance/housekeeping/base-corpus").status_code == 403


def test_base_corpus_that_cannot_run_fails_the_call_so_the_scheduler_shows_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    from aiq_agent import oib_sync

    def broken():
        raise RuntimeError("the base corpus needs AIQ_SUMMARY_DB")

    monkeypatch.setattr(oib_sync, "sync", broken)
    failing = TestClient(client.app, raise_server_exceptions=False)
    assert failing.post("/v1/maintenance/housekeeping/base-corpus", headers=AUTH).status_code == 500
