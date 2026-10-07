"""``leader_lock``, and the rule every session lock here follows (ADR-0083).

A session advisory lock lives as long as the server connection that took it, so
it is taken on the direct DSN (``AIQ_LOCK_DB_URL``) and on an engine that never
pools. Behind the transaction pooler it would be acquired on one server
connection and released on another, which leaves the first locked and raises
nothing. The suite has no Postgres server, so the Postgres half is pinned by
what the engine double is sent and which URL it is built for.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aiq_agent.knowledge import leader_lock as lock_module
from aiq_agent.knowledge.leader_lock import keyed_lock
from aiq_agent.knowledge.leader_lock import leader_lock
from aiq_agent.knowledge.leader_lock import leader_lock_async

DIRECT = "postgresql://aiq:pw@grid-pg-rw:5432/aiq_jobs"  # pragma: allowlist secret
POOLED = "postgresql+psycopg://aiq:pw@grid-pg-pooler-rw:5432/aiq_jobs"  # pragma: allowlist secret


@pytest.fixture(autouse=True)
def _no_database(monkeypatch):
    for name in ("AIQ_LOCK_DB_URL", "AIQ_SUMMARY_DB", "NAT_JOB_STORE_DB_URL"):
        monkeypatch.delenv(name, raising=False)


def _engine(monkeypatch, *, wins: bool = True):
    """A lock engine double: (urls it was built for, the connection it hands out)."""
    conn = MagicMock()
    conn.execute.return_value.scalar.return_value = wins
    engine = MagicMock()
    engine.connect.return_value = conn
    urls: list[str] = []

    def build(url):
        urls.append(url)
        return engine

    monkeypatch.setattr(lock_module, "_lock_engine", build)
    return urls, conn


def _sql(conn) -> list[str]:
    return [str(call.args[0]) for call in conn.execute.call_args_list]


def test_without_postgres_everyone_is_the_leader():
    with leader_lock(1) as leads:
        assert leads is True


def test_a_sqlite_lock_url_is_not_postgres_and_grants_leadership(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", "sqlite:///./locks.db")
    with leader_lock(1) as leads:
        assert leads is True


def test_the_winner_holds_the_lock_on_the_direct_dsn_and_releases_it(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    urls, conn = _engine(monkeypatch, wins=True)

    with leader_lock(42) as leads:
        assert leads is True
        assert "pg_try_advisory_lock(:id)" in _sql(conn)[0]
        conn.close.assert_not_called()  # the session IS the lock

    assert urls == [DIRECT]
    assert conn.execute.call_args_list[0].args[1] == {"id": 42}
    assert "pg_advisory_unlock(:id)" in _sql(conn)[-1]
    conn.close.assert_called_once()


def test_the_lock_is_released_when_the_body_raises(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    _, conn = _engine(monkeypatch, wins=True)

    with pytest.raises(RuntimeError), leader_lock(42):
        raise RuntimeError("cleanup failed")

    assert "pg_advisory_unlock" in _sql(conn)[-1]
    conn.close.assert_called_once()


def test_the_loser_runs_nothing_and_leaves_no_session_behind(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    _, conn = _engine(monkeypatch, wins=False)

    with leader_lock(42) as leads:
        assert leads is False

    assert len(_sql(conn)) == 1  # the try-lock; there is nothing to unlock
    conn.close.assert_called_once()


def test_an_unreachable_database_grants_leadership_rather_than_stopping_the_work(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", "postgresql://nobody@127.0.0.1:9/none?connect_timeout=1")

    with leader_lock(42) as leads:
        assert leads is True


def test_a_failed_unlock_still_ends_the_session(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    _, conn = _engine(monkeypatch, wins=True)
    conn.execute.side_effect = [MagicMock(scalar=MagicMock(return_value=True)), RuntimeError("connection lost")]

    with leader_lock(42) as leads:
        assert leads is True

    conn.close.assert_called_once()  # closing a never-pooled session releases the lock


@pytest.mark.parametrize("name", ["AIQ_SUMMARY_DB", "NAT_JOB_STORE_DB_URL"])
def test_postgres_without_a_lock_dsn_is_a_configuration_error_not_a_quiet_fallback(monkeypatch, name):
    # The old behaviour derived the lock connection from these. Doing that now
    # would put session locks on the pooled DSN, which is the bug.
    monkeypatch.setenv(name, POOLED)

    with pytest.raises(RuntimeError, match="AIQ_LOCK_DB_URL is not set"), leader_lock(1):
        pass
    with pytest.raises(RuntimeError, match="AIQ_LOCK_DB_URL is not set"), keyed_lock("reingest:proj:x.pdf"):
        pass


def test_the_lock_dsn_wins_over_the_pooled_ones(monkeypatch):
    monkeypatch.setenv("AIQ_SUMMARY_DB", POOLED)
    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", POOLED)
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    urls, _ = _engine(monkeypatch)

    with leader_lock(1):
        pass
    with keyed_lock("reingest:proj:x.pdf"):
        pass

    assert urls == [DIRECT, DIRECT]


async def test_the_async_election_is_the_same_election(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    urls, conn = _engine(monkeypatch, wins=True)

    async with leader_lock_async(7) as leads:
        assert leads is True

    assert urls == [DIRECT]
    assert "pg_advisory_unlock" in _sql(conn)[-1]
    conn.close.assert_called_once()


async def test_the_async_loser_is_told_so(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    _engine(monkeypatch, wins=False)

    async with leader_lock_async(7) as leads:
        assert leads is False


def test_the_lock_engine_never_pools_and_does_not_open_a_transaction():
    # Real engine construction (no connection): NullPool, so close() ends the
    # session and with it the lock.
    from sqlalchemy.pool import NullPool

    lock_module._lock_engines.pop(DIRECT, None)
    engine = lock_module._lock_engine(DIRECT)

    assert isinstance(engine.pool, NullPool)
    assert engine.dialect.name == "postgresql"
    assert engine.dialect.driver == "psycopg"
    lock_module._lock_engines.pop(DIRECT, None)
