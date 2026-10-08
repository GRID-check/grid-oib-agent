"""Tests for the research-runs listing endpoint (GET /v1/jobs/async/jobs)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from datetime import UTC
from datetime import datetime
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_agent.auth import Principal
from aiq_api.jobs import access as job_access
from aiq_api.jobs.access import JobCaller
from aiq_api.jobs.access import SignedJobScope
from aiq_api.jobs.event_store import EventStore
from aiq_api.routes.jobs import _find_research_runs


@pytest.fixture
def db_url(tmp_path):
    return f"sqlite+aiosqlite:///{tmp_path / 'test_research_runs.db'}"


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
    status: str = "success",
    created_at: datetime | None = None,
    is_expired: bool = False,
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
        ts = (created_at or datetime.now(UTC)).replace(tzinfo=None)
        conn.execute(
            text(
                "INSERT OR REPLACE INTO job_info "
                "(job_id, status, created_at, updated_at, expiry_seconds, is_expired) "
                "VALUES (:job_id, :status, :ts, :ts, 3600, :is_expired)"
            ),
            {"job_id": job_id, "status": status, "ts": ts, "is_expired": is_expired},
        )
        conn.commit()


def _seed_job(
    db_url: str,
    job_id: str,
    principal: Principal,
    *,
    status: str = "success",
    created_at: datetime | None = None,
    conversation_id: str | None = None,
    project_collection: str | None = None,
    organization_id: str | None = None,
) -> None:
    job_access.create_job_access(
        job_id,
        principal,
        db_url,
        conversation_id=conversation_id,
        project_collection=project_collection,
        organization_id=organization_id,
    )
    _insert_job_info(db_url, job_id, status=status, created_at=created_at)


class TestFindResearchRuns:
    """Unit tests directly against the sync query helper."""

    def test_filters_by_project_collection(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        _seed_job(db_url, "job-a", principal, project_collection="proj-alpha")
        _seed_job(db_url, "job-b", principal, project_collection="proj-beta")

        rows, total = _find_research_runs(db_url, None, "proj-alpha", None, None, 50, 0)

        assert total == 1
        assert [row["job_id"] for row in rows] == ["job-a"]
        assert rows[0]["project_collection"] == "proj-alpha"

    def test_filters_by_conversation_id(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        _seed_job(db_url, "job-a", principal, conversation_id="conv-1")
        _seed_job(db_url, "job-b", principal, conversation_id="conv-2")

        rows, total = _find_research_runs(db_url, None, None, "conv-2", None, 50, 0)

        assert total == 1
        assert [row["job_id"] for row in rows] == ["job-b"]

    def test_filters_by_status(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        _seed_job(db_url, "job-a", principal, status="success")
        _seed_job(db_url, "job-b", principal, status="failure")

        rows, total = _find_research_runs(db_url, None, None, None, "failure", 50, 0)

        assert total == 1
        assert [row["job_id"] for row in rows] == ["job-b"]

    def test_owner_scoping_excludes_other_owners_jobs(self, db_url):
        owner_a = Principal(type="jwt", sub="user-1")
        owner_b = Principal(type="jwt", sub="user-2")
        _seed_job(db_url, "job-a", owner_a)
        _seed_job(db_url, "job-b", owner_b)

        rows, total = _find_research_runs(db_url, JobCaller(principal=owner_a), None, None, None, 50, 0)

        assert total == 1
        assert [row["job_id"] for row in rows] == ["job-a"]

    def test_no_owner_enforcement_returns_all_jobs(self, db_url):
        owner_a = Principal(type="jwt", sub="user-1")
        owner_b = Principal(type="jwt", sub="user-2")
        _seed_job(db_url, "job-a", owner_a)
        _seed_job(db_url, "job-b", owner_b)

        rows, total = _find_research_runs(db_url, None, None, None, None, 50, 0)

        assert total == 2
        assert {row["job_id"] for row in rows} == {"job-a", "job-b"}

    def test_orders_newest_first_and_paginates(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        now = datetime.now(UTC)
        _seed_job(db_url, "job-old", principal, created_at=now - timedelta(minutes=10))
        _seed_job(db_url, "job-new", principal, created_at=now)

        rows, total = _find_research_runs(db_url, None, None, None, None, 1, 0)

        assert total == 2
        assert [row["job_id"] for row in rows] == ["job-new"]

    def test_pagination_stable_for_identical_created_at(self, db_url):
        """job_id tiebreaker: identical created_at must not duplicate/drop rows across pages."""
        principal = Principal(type="jwt", sub="user-1")
        ts = datetime.now(UTC)
        for job_id in ("job-a", "job-b", "job-c"):
            _seed_job(db_url, job_id, principal, created_at=ts)

        pages = [_find_research_runs(db_url, None, None, None, None, 1, offset)[0][0]["job_id"] for offset in (0, 1, 2)]

        # Deterministic order (created_at DESC, job_id DESC) and full coverage.
        assert pages == ["job-c", "job-b", "job-a"]


class TestListingFollowsTheSignedScope:
    """ADR-0084: the listing shows the runs a single-job read would open, no more."""

    OWNER = Principal(type="jwt", sub="user-owner")
    TEAMMATE = Principal(type="jwt", sub="user-teammate")

    def _seed_tenants(self, db_url: str) -> None:
        _seed_job(db_url, "own-elsewhere", self.TEAMMATE, organization_id="org-1", project_collection="proj_beta")
        _seed_job(db_url, "project-run", self.OWNER, organization_id="org-1", project_collection="proj_alpha")
        _seed_job(db_url, "other-project", self.OWNER, organization_id="org-1", project_collection="proj_beta")
        _seed_job(db_url, "other-org", self.OWNER, organization_id="org-2", project_collection="proj_alpha")
        _seed_job(db_url, "no-org", self.OWNER, project_collection="proj_alpha", conversation_id="conv-1")
        _seed_job(db_url, "conversation-run", self.OWNER, organization_id="org-1", conversation_id="conv-1")

    def _ids(self, db_url: str, scope: SignedJobScope | None, project_collection: str | None = None) -> set[str]:
        caller = JobCaller(principal=self.TEAMMATE, scope=scope)
        rows, total = _find_research_runs(db_url, caller, project_collection, None, None, 50, 0)
        assert total == len(rows)
        return {row["job_id"] for row in rows}

    def test_own_runs_plus_the_signed_projects_runs_and_never_another_organizations(self, db_url):
        self._seed_tenants(db_url)
        scope = SignedJobScope(organization_id="org-1", project_collection="proj_alpha", conversation_id=None)

        assert self._ids(db_url, scope) == {"own-elsewhere", "project-run"}

    def test_the_project_filter_narrows_and_does_not_widen(self, db_url):
        self._seed_tenants(db_url)
        scope = SignedJobScope(organization_id="org-1", project_collection="proj_alpha", conversation_id=None)

        assert self._ids(db_url, scope, "proj_alpha") == {"project-run"}
        # Naming a project the envelope did not sign shows only what the caller owns there.
        assert self._ids(db_url, scope, "proj_beta") == {"own-elsewhere"}

    def test_the_signed_conversations_runs_are_listed(self, db_url):
        self._seed_tenants(db_url)
        scope = SignedJobScope(organization_id="org-1", project_collection=None, conversation_id="conv-1")

        assert self._ids(db_url, scope) == {"own-elsewhere", "conversation-run"}

    def test_without_a_scope_only_own_runs(self, db_url):
        self._seed_tenants(db_url)

        assert self._ids(db_url, None) == {"own-elsewhere"}


@pytest.fixture
async def research_runs_app(db_url, monkeypatch):
    """Build a minimal app with the async job routes, including the new list endpoint."""
    import aiq_api.routes.jobs as jobs_routes

    worker = SimpleNamespace(
        _db_url=db_url,
        _config_file_path="config.yml",
        _log_level=20,
        _front_end_config=SimpleNamespace(expiry_seconds=86400),
    )

    builder = MagicMock()
    app = FastAPI()
    await jobs_routes.register_job_routes(app, builder, worker)
    return app


@pytest.mark.asyncio
async def test_list_research_runs_scopes_to_caller_when_auth_required(research_runs_app, db_url, monkeypatch):
    import aiq_api.routes.jobs as jobs_routes

    monkeypatch.setenv("REQUIRE_AUTH", "true")
    owner_a = Principal(type="jwt", sub="user-1")
    owner_b = Principal(type="jwt", sub="user-2")
    _seed_job(db_url, "job-a", owner_a)
    _seed_job(db_url, "job-b", owner_b)

    monkeypatch.setattr(jobs_routes, "require_verified_principal", lambda: owner_a)

    with TestClient(research_runs_app) as client:
        response = client.get("/v1/jobs/async/jobs")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert [job["job_id"] for job in body["jobs"]] == ["job-a"]


@pytest.mark.asyncio
async def test_list_research_runs_anonymous_mode_sees_all_jobs(research_runs_app, db_url, monkeypatch):
    """Mirrors authorize_job_access: when REQUIRE_AUTH is not 'true', ownership isn't enforced."""
    import aiq_api.routes.jobs as jobs_routes

    monkeypatch.setenv("REQUIRE_AUTH", "false")
    owner_a = Principal(type="jwt", sub="user-1")
    owner_b = Principal(type="jwt", sub="user-2")
    _seed_job(db_url, "job-a", owner_a)
    _seed_job(db_url, "job-b", owner_b)

    monkeypatch.setattr(jobs_routes, "require_verified_principal", lambda: owner_a)

    with TestClient(research_runs_app) as client:
        response = client.get("/v1/jobs/async/jobs")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert {job["job_id"] for job in body["jobs"]} == {"job-a", "job-b"}


@pytest.mark.asyncio
async def test_list_research_runs_clamps_limit(research_runs_app, db_url, monkeypatch):
    import aiq_api.routes.jobs as jobs_routes

    monkeypatch.setenv("REQUIRE_AUTH", "false")
    monkeypatch.setattr(jobs_routes, "require_verified_principal", lambda: Principal(type="jwt", sub="user-1"))

    with TestClient(research_runs_app) as client:
        response = client.get("/v1/jobs/async/jobs", params={"limit": 10000})

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_list_research_runs_honours_the_signed_project(research_runs_app, db_url, monkeypatch):
    """The route reads the envelope off the request: a teammate sees the project's runs, not another org's."""
    import aiq_api.routes.jobs as jobs_routes

    secret = "listing-test-secret"  # noqa: S105 - test fixture value
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", secret)
    monkeypatch.setenv("OIB_COLLECTION_NAME", "oib_knowledge")
    owner = Principal(type="jwt", sub="user-owner")
    teammate = Principal(type="jwt", sub="user-teammate")
    _seed_job(db_url, "project-run", owner, organization_id="org-1", project_collection="proj_alpha")
    _seed_job(db_url, "other-org", owner, organization_id="org-2", project_collection="proj_alpha")
    monkeypatch.setattr(jobs_routes, "require_verified_principal", lambda: teammate)

    raw = json.dumps(
        {
            "organizationId": "org-1",
            "userId": teammate.sub,
            "collectionScope": [
                {"collection": "oib_knowledge", "shelf": "base"},
                {"collection": "proj_alpha", "shelf": "project"},
            ],
            "issuedAt": int(time.time() * 1000),
        }
    )
    headers = {
        "x-grid-request-context": base64.urlsafe_b64encode(raw.encode()).decode().rstrip("="),
        "x-grid-request-context-sig": hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest(),
    }

    with TestClient(research_runs_app) as client:
        signed = client.get("/v1/jobs/async/jobs", headers=headers)
        unsigned = client.get("/v1/jobs/async/jobs")

    assert [job["job_id"] for job in signed.json()["jobs"]] == ["project-run"]
    assert unsigned.json()["jobs"] == []
