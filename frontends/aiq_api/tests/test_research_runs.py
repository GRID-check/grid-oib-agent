# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Tests for the research-runs listing endpoint (GET /v1/jobs/async/jobs)."""

from __future__ import annotations

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
) -> None:
    job_access.create_job_access(
        job_id,
        principal,
        db_url,
        conversation_id=conversation_id,
        project_collection=project_collection,
    )
    _insert_job_info(db_url, job_id, status=status, created_at=created_at)


class TestFindResearchRuns:
    """Unit tests directly against the sync query helper."""

    def test_filters_by_project_collection(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        _seed_job(db_url, "job-a", principal, project_collection="proj-alpha")
        _seed_job(db_url, "job-b", principal, project_collection="proj-beta")

        rows, total = _find_research_runs(db_url, False, None, None, "proj-alpha", None, None, 50, 0)

        assert total == 1
        assert [row["job_id"] for row in rows] == ["job-a"]
        assert rows[0]["project_collection"] == "proj-alpha"

    def test_filters_by_conversation_id(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        _seed_job(db_url, "job-a", principal, conversation_id="conv-1")
        _seed_job(db_url, "job-b", principal, conversation_id="conv-2")

        rows, total = _find_research_runs(db_url, False, None, None, None, "conv-2", None, 50, 0)

        assert total == 1
        assert [row["job_id"] for row in rows] == ["job-b"]

    def test_filters_by_status(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        _seed_job(db_url, "job-a", principal, status="success")
        _seed_job(db_url, "job-b", principal, status="failure")

        rows, total = _find_research_runs(db_url, False, None, None, None, None, "failure", 50, 0)

        assert total == 1
        assert [row["job_id"] for row in rows] == ["job-b"]

    def test_owner_scoping_excludes_other_owners_jobs(self, db_url):
        owner_a = Principal(type="jwt", sub="user-1")
        owner_b = Principal(type="jwt", sub="user-2")
        _seed_job(db_url, "job-a", owner_a)
        _seed_job(db_url, "job-b", owner_b)

        rows, total = _find_research_runs(db_url, True, "jwt", "user-1", None, None, None, 50, 0)

        assert total == 1
        assert [row["job_id"] for row in rows] == ["job-a"]

    def test_no_owner_enforcement_returns_all_jobs(self, db_url):
        owner_a = Principal(type="jwt", sub="user-1")
        owner_b = Principal(type="jwt", sub="user-2")
        _seed_job(db_url, "job-a", owner_a)
        _seed_job(db_url, "job-b", owner_b)

        rows, total = _find_research_runs(db_url, False, None, None, None, None, None, 50, 0)

        assert total == 2
        assert {row["job_id"] for row in rows} == {"job-a", "job-b"}

    def test_orders_newest_first_and_paginates(self, db_url):
        principal = Principal(type="jwt", sub="user-1")
        now = datetime.now(UTC)
        _seed_job(db_url, "job-old", principal, created_at=now - timedelta(minutes=10))
        _seed_job(db_url, "job-new", principal, created_at=now)

        rows, total = _find_research_runs(db_url, False, None, None, None, None, None, 1, 0)

        assert total == 2
        assert [row["job_id"] for row in rows] == ["job-new"]


@pytest.fixture
async def research_runs_app(db_url, monkeypatch):
    """Build a minimal app with the async job routes, including the new list endpoint."""
    import aiq_api.routes.jobs as jobs_routes

    monkeypatch.setattr(jobs_routes, "_start_periodic_cleanup", MagicMock())

    async def _no_op_reaper(*_args, **_kwargs):
        return None

    monkeypatch.setattr(jobs_routes, "_reap_ghost_jobs", _no_op_reaper)

    worker = SimpleNamespace(
        _dask_available=True,
        _job_store=MagicMock(),
        _scheduler_address="tcp://localhost:8786",
        _db_url=db_url,
        _config_file_path="config.yml",
        _log_level=20,
        _use_dask_threads=False,
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
