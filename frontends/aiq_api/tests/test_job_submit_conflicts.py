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

"""Tests for duplicate job-ID rejection on submit (hijack/delete protection).

A caller-supplied job_id that collides with an existing job must be rejected
with 409 Conflict: NAT's job_info write and the job_access upsert are
unconditional, so re-submitting an existing ID would rewrite ownership, and a
failed re-submission would wipe the original job via rollback_job_submission.
"""

from __future__ import annotations

from datetime import UTC
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_agent.auth import Principal
from aiq_api.jobs import access as job_access
from aiq_api.jobs.access import create_job_access
from aiq_api.jobs.access import get_job_access
from aiq_api.jobs.access import job_exists
from aiq_api.jobs.event_store import EventStore
from aiq_api.jobs.submit import DuplicateJobIdError
from aiq_api.jobs.submit import submit_agent_job


@pytest.fixture
def db_url(tmp_path):
    return f"sqlite+aiosqlite:///{tmp_path / 'test_job_submit_conflicts.db'}"


@pytest.fixture(autouse=True)
def clear_event_store_caches():
    EventStore._tables_initialized.clear()
    job_access._job_access_schema_initialized.clear()
    yield
    EventStore._tables_initialized.clear()
    job_access._job_access_schema_initialized.clear()


def _insert_job_info(db_url: str, job_id: str, *, status: str = "running") -> None:
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
        now = datetime.now(UTC).replace(tzinfo=None)
        conn.execute(
            text(
                "INSERT OR REPLACE INTO job_info "
                "(job_id, status, created_at, updated_at, expiry_seconds, is_expired) "
                "VALUES (:job_id, :status, :ts, :ts, 3600, 0)"
            ),
            {"job_id": job_id, "status": status, "ts": now},
        )
        conn.commit()


def _mock_job_store() -> MagicMock:
    store = MagicMock()
    store.ensure_job_id.side_effect = lambda job_id: job_id or "generated-job-id"
    store.submit_job = AsyncMock(return_value=None)
    return store


def _submit_env(db_url: str) -> dict[str, str]:
    return {
        "NAT_DASK_SCHEDULER_ADDRESS": "tcp://localhost:8786",
        "NAT_JOB_STORE_DB_URL": db_url,
    }


class TestJobExists:
    def test_false_on_fresh_database(self, db_url):
        assert job_exists("job-1", db_url) is False

    def test_true_for_job_access_row(self, db_url):
        create_job_access("job-1", Principal(type="jwt", sub="user-1"), db_url)

        assert job_exists("job-1", db_url) is True

    def test_true_for_job_info_only_row(self, db_url):
        _insert_job_info(db_url, "job-1")

        assert job_exists("job-1", db_url) is True

    def test_false_for_other_job(self, db_url):
        create_job_access("job-1", Principal(type="jwt", sub="user-1"), db_url)
        _insert_job_info(db_url, "job-1")

        assert job_exists("job-2", db_url) is False


class TestSubmitDuplicateJobId:
    owner = Principal(type="jwt", sub="user-1", email="owner@example.com")
    attacker = Principal(type="jwt", sub="user-2", email="attacker@example.com")

    @pytest.mark.asyncio
    async def test_existing_job_id_rejected_and_untouched(self, db_url):
        """Re-submitting an existing job_id must fail without altering ownership or job_info."""
        create_job_access("job-1", self.owner, db_url)
        _insert_job_info(db_url, "job-1", status="running")

        job_store = _mock_job_store()
        with patch.dict("os.environ", _submit_env(db_url)):
            with patch("nat.front_ends.fastapi.async_jobs.job_store.JobStore", return_value=job_store):
                with pytest.raises(DuplicateJobIdError):
                    await submit_agent_job(
                        agent_type="deep_researcher",
                        input_text="query",
                        owner="attacker@example.com",
                        principal=self.attacker,
                        job_id="job-1",
                    )

        job_store.submit_job.assert_not_called()

        access = get_job_access("job-1", db_url)
        assert access is not None
        assert access["owner_subject"] == "user-1"
        assert access["owner_email"] == "owner@example.com"

        from sqlalchemy import text

        engine = EventStore._get_or_create_sync_engine(db_url)
        with engine.connect() as conn:
            row = conn.execute(text("SELECT status FROM job_info WHERE job_id = 'job-1'")).first()
        assert row is not None
        assert row[0] == "running"

    @pytest.mark.asyncio
    async def test_job_info_only_row_also_rejected(self, db_url):
        """A job known only to NAT's job_info (no access row yet) still counts as existing."""
        _insert_job_info(db_url, "job-1")

        job_store = _mock_job_store()
        with patch.dict("os.environ", _submit_env(db_url)):
            with patch("nat.front_ends.fastapi.async_jobs.job_store.JobStore", return_value=job_store):
                with pytest.raises(DuplicateJobIdError):
                    await submit_agent_job(
                        agent_type="deep_researcher",
                        input_text="query",
                        owner="user@example.com",
                        principal=self.owner,
                        job_id="job-1",
                    )

        job_store.submit_job.assert_not_called()

    @pytest.mark.asyncio
    async def test_auto_generated_job_id_skips_existence_check(self, db_url):
        """UUID collisions are not a practical concern; skip the DB round-trip."""
        job_store = _mock_job_store()
        with patch.dict("os.environ", _submit_env(db_url)):
            with patch("nat.front_ends.fastapi.async_jobs.job_store.JobStore", return_value=job_store):
                with patch("aiq_api.jobs.submit.job_exists") as job_exists_spy:
                    result = await submit_agent_job(
                        agent_type="deep_researcher",
                        input_text="query",
                        owner="user@example.com",
                        principal=self.owner,
                    )

        assert result == "generated-job-id"
        job_exists_spy.assert_not_called()
        job_store.submit_job.assert_called_once()

    @pytest.mark.asyncio
    async def test_fresh_custom_job_id_submits_normally(self, db_url):
        job_store = _mock_job_store()
        with patch.dict("os.environ", _submit_env(db_url)):
            with patch("nat.front_ends.fastapi.async_jobs.job_store.JobStore", return_value=job_store):
                result = await submit_agent_job(
                    agent_type="deep_researcher",
                    input_text="query",
                    owner="user@example.com",
                    principal=self.owner,
                    job_id="fresh-job",
                )

        assert result == "fresh-job"
        job_store.submit_job.assert_called_once()
        access = get_job_access("fresh-job", db_url)
        assert access is not None
        assert access["owner_subject"] == "user-1"


class TestRollbackHardening:
    principal = Principal(type="jwt", sub="user-1", email="user@example.com")

    @pytest.mark.asyncio
    async def test_rollback_runs_when_preexistence_verified(self, db_url):
        """Baseline: a verified-fresh custom job_id still rolls back on failure."""
        job_store = _mock_job_store()
        with patch.dict("os.environ", _submit_env(db_url)):
            with patch("nat.front_ends.fastapi.async_jobs.job_store.JobStore", return_value=job_store):
                with patch("aiq_api.jobs.submit.create_job_access", side_effect=RuntimeError("db write failed")):
                    with patch("aiq_api.jobs.submit.rollback_job_submission") as rollback:
                        with pytest.raises(RuntimeError, match="db write failed"):
                            await submit_agent_job(
                                agent_type="deep_researcher",
                                input_text="query",
                                owner="user@example.com",
                                principal=self.principal,
                                job_id="fresh-job",
                            )

        rollback.assert_called_once_with("fresh-job", db_url)

    @pytest.mark.asyncio
    async def test_rollback_skipped_when_preexistence_unverified(self, db_url):
        """If the existence check errored, rollback must not run — it could wipe a pre-existing job."""
        job_store = _mock_job_store()
        with patch.dict("os.environ", _submit_env(db_url)):
            with patch("nat.front_ends.fastapi.async_jobs.job_store.JobStore", return_value=job_store):
                with patch("aiq_api.jobs.submit.job_exists", side_effect=RuntimeError("db unreachable")):
                    with patch("aiq_api.jobs.submit.create_job_access", side_effect=RuntimeError("db write failed")):
                        with patch("aiq_api.jobs.submit.rollback_job_submission") as rollback:
                            with pytest.raises(RuntimeError, match="db write failed"):
                                await submit_agent_job(
                                    agent_type="deep_researcher",
                                    input_text="query",
                                    owner="user@example.com",
                                    principal=self.principal,
                                    job_id="maybe-existing-job",
                                )

        rollback.assert_not_called()


@pytest.fixture
async def submit_conflict_app(db_url, monkeypatch):
    """Minimal app with async job routes and a conflicting submit_agent_job."""
    import aiq_api.routes.jobs as jobs_routes
    from aiq_api.jobs import submit

    monkeypatch.setattr(jobs_routes, "_start_periodic_cleanup", MagicMock())

    async def _no_op_reaper(*_args, **_kwargs):
        return None

    monkeypatch.setattr(jobs_routes, "_reap_ghost_jobs", _no_op_reaper)
    monkeypatch.setattr(
        jobs_routes,
        "require_verified_principal",
        lambda: Principal(type="jwt", sub="user-1", email="user@example.com"),
    )

    submitted_job = AsyncMock(side_effect=DuplicateJobIdError("Job ID already exists: job-1"))
    monkeypatch.setattr(submit, "submit_agent_job", submitted_job)

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

    app = FastAPI()
    await jobs_routes.register_job_routes(app, MagicMock(), worker)
    return app, submitted_job


@pytest.mark.asyncio
async def test_submit_route_maps_duplicate_job_id_to_409(submit_conflict_app):
    app, submitted_job = submit_conflict_app

    with TestClient(app) as client:
        response = client.post(
            "/v1/jobs/async/submit",
            json={"agent_type": "deep_researcher", "input": "query", "job_id": "job-1"},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "Job ID already exists: job-1"
    submitted_job.assert_awaited_once()
