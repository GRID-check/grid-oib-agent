"""The ghost-job reaper's election takes its lock on the direct lock DSN (ADR-0083).

The reaper used to run its own ``pg_try_advisory_lock`` on the job-store engine.
Behind the transaction pooler that lock is taken on one server connection and
"released" on another, so one replica would hold it until the pooler recycled
the connection and no replica would reap. It now elects through
``aiq_agent.knowledge.leader_lock`` like every other session lock, so these
tests pin the one fact that matters: which connection, and which statements.

The suite has no Postgres server, so the engine is a double and the tests read
what it was sent.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest

import aiq_api.routes.jobs as jobs_routes
from aiq_agent.knowledge import leader_lock

POOLED = "postgresql+asyncpg://aiq:pw@grid-pg-pooler-rw:5432/aiq_jobs"  # pragma: allowlist secret
DIRECT = "postgresql://aiq:pw@grid-pg-rw:5432/aiq_jobs"  # pragma: allowlist secret


def _engine(monkeypatch, *, wins: bool):
    """A lock engine whose try-lock answers ``wins``; returns (engine, connection)."""
    conn = MagicMock()
    conn.execute.return_value.scalar.return_value = wins
    engine = MagicMock()
    engine.connect.return_value = conn
    seen_urls: list[str] = []

    def lock_engine(url):
        seen_urls.append(url)
        return engine

    monkeypatch.setattr(leader_lock, "_lock_engine", lock_engine)
    return seen_urls, conn


@pytest.fixture(autouse=True)
def _lock_dsn(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)


@pytest.mark.asyncio
async def test_the_reaper_locks_on_the_direct_dsn_not_the_job_store_url(monkeypatch):
    seen_urls, conn = _engine(monkeypatch, wins=True)
    cycle = AsyncMock(return_value=["job-1"])
    monkeypatch.setattr(jobs_routes, "_do_reap_cycle", cycle)

    reaped = await jobs_routes._reap_stale_jobs_once(MagicMock(), POOLED)

    assert reaped == ["job-1"]
    assert seen_urls == [DIRECT]
    (lock_sql, lock_params), _ = conn.execute.call_args_list[0]
    assert "pg_try_advisory_lock(:id)" in str(lock_sql)
    assert lock_params == {"id": jobs_routes._PG_REAPER_LOCK_ID}
    (unlock_sql, _), _ = conn.execute.call_args_list[-1]
    assert "pg_advisory_unlock" in str(unlock_sql)
    conn.close.assert_called_once()


@pytest.mark.asyncio
async def test_a_replica_that_loses_the_election_skips_the_cycle(monkeypatch):
    _, conn = _engine(monkeypatch, wins=False)
    cycle = AsyncMock(return_value=["job-1"])
    monkeypatch.setattr(jobs_routes, "_do_reap_cycle", cycle)

    assert await jobs_routes._reap_stale_jobs_once(MagicMock(), POOLED) == []

    cycle.assert_not_awaited()
    conn.close.assert_called_once()


@pytest.mark.asyncio
async def test_the_lock_is_released_when_the_cycle_raises(monkeypatch):
    _, conn = _engine(monkeypatch, wins=True)
    monkeypatch.setattr(jobs_routes, "_do_reap_cycle", AsyncMock(side_effect=RuntimeError("cycle failed")))

    with pytest.raises(RuntimeError, match="cycle failed"):
        await jobs_routes._reap_stale_jobs_once(MagicMock(), POOLED)

    (unlock_sql, _), _ = conn.execute.call_args_list[-1]
    assert "pg_advisory_unlock" in str(unlock_sql)
    conn.close.assert_called_once()


@pytest.mark.asyncio
async def test_a_lock_that_cannot_be_taken_skips_the_cycle_and_the_next_tick_retries(monkeypatch, caplog):
    """Fail-closed: with the lock database down nobody reaps this cycle.

    Running unelected would be every web replica reaping at once. The reaper runs on
    a two-minute schedule, so the cost of skipping is one tick.
    """
    conn = MagicMock()
    conn.execute.side_effect = RuntimeError("connection lost")
    engine = MagicMock()
    engine.connect.return_value = conn
    monkeypatch.setattr(leader_lock, "_lock_engine", lambda url: engine)
    cycle = AsyncMock(return_value=["job-1"])
    monkeypatch.setattr(jobs_routes, "_do_reap_cycle", cycle)

    with caplog.at_level("WARNING"):
        assert await jobs_routes._reap_stale_jobs_once(MagicMock(), POOLED) == []

    cycle.assert_not_awaited()
    assert "skipping this cycle" in caplog.text
    conn.close.assert_called_once()
