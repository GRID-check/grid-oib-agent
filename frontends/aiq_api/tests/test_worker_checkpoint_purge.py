"""Deep-research checkpoint retention: a finished run's durable checkpoint rows
are purged (thread_id == job_id), and the helper is a safe no-op when durable
checkpointing is not configured."""

import inspect

import pytest
from sqlalchemy import text

from aiq_api.jobs import queue
from aiq_api.jobs import runner
from aiq_api.jobs.event_store import EventStore
from aiq_api.jobs.runner import _purge_deep_checkpoint
from aiq_api.jobs.runner import _purge_deep_checkpoint_unless_reclaimed

_TABLES = ("checkpoints", "checkpoint_blobs", "checkpoint_writes")


def test_purge_deletes_only_the_finished_thread(tmp_path, monkeypatch):
    dsn = f"sqlite:///{tmp_path / 'ckpt.db'}"
    monkeypatch.setenv("AIQ_DEEP_CHECKPOINT_DB", dsn)
    engine = EventStore._get_or_create_sync_engine(dsn)
    with engine.connect() as conn:
        for t in _TABLES:
            conn.execute(text(f"CREATE TABLE {t} (thread_id TEXT, v TEXT)"))
            conn.execute(text(f"INSERT INTO {t} (thread_id, v) VALUES ('job-1', 'a'), ('job-2', 'b')"))
        conn.commit()

    _purge_deep_checkpoint("job-1")

    with engine.connect() as conn:
        for t in _TABLES:
            remaining = conn.execute(text(f"SELECT thread_id FROM {t}")).scalars().all()
            assert "job-1" not in remaining, f"{t} still has the finished job's rows"
            assert "job-2" in remaining, f"{t} lost another job's rows"


def test_purge_is_noop_without_dsn(monkeypatch):
    monkeypatch.delenv("AIQ_DEEP_CHECKPOINT_DB", raising=False)
    _purge_deep_checkpoint("job-x")  # must not raise


def test_purge_swallows_missing_tables(tmp_path, monkeypatch):
    # DSN set but no checkpoint tables yet (durability on, no run) -> no raise.
    monkeypatch.setenv("AIQ_DEEP_CHECKPOINT_DB", f"sqlite:///{tmp_path / 'empty.db'}")
    _purge_deep_checkpoint("job-x")


# ---------------------------------------------------------------------------
# A reclaimed loser must not purge the new owner's checkpoint.
#
# The rows are keyed by job id, so after a reclaim they are the winner's resume
# point. worker.py skipped its purge on claim loss; the runner's `finally` did
# not, and deleted them from under the winner.
# ---------------------------------------------------------------------------


def _checkpoint_db(tmp_path, monkeypatch):
    dsn = f"sqlite:///{tmp_path / 'ckpt.db'}"
    monkeypatch.setenv("AIQ_DEEP_CHECKPOINT_DB", dsn)
    engine = EventStore._get_or_create_sync_engine(dsn)
    with engine.connect() as conn:
        for t in _TABLES:
            conn.execute(text(f"CREATE TABLE {t} (thread_id TEXT, v TEXT)"))
            conn.execute(text(f"INSERT INTO {t} (thread_id, v) VALUES ('job-1', 'a')"))
        conn.commit()
    return engine


def _rows_left(engine) -> int:
    with engine.connect() as conn:
        return sum(len(conn.execute(text(f"SELECT thread_id FROM {t}")).all()) for t in _TABLES)


def _queue_with_reclaim(tmp_path) -> str:
    """Worker-A stalls past the stale window; worker-B reclaims the claim."""
    db_url = f"sqlite:///{tmp_path / 'queue.db'}"
    queue.ensure_research_queue_table(db_url)
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    queue.claim_next(db_url, "worker-A", 30, 3)
    with queue._connection(db_url) as conn:
        conn.execute(
            text("UPDATE research_job_queue SET heartbeat_at = datetime('now', '-120 seconds') WHERE job_id = 'job-1'")
        )
        conn.commit()
    queue.claim_next(db_url, "worker-B", 30, 3)
    return db_url


@pytest.mark.asyncio
async def test_a_reclaimed_loser_leaves_the_checkpoint_to_the_new_owner(tmp_path, monkeypatch):
    engine = _checkpoint_db(tmp_path, monkeypatch)
    db_url = _queue_with_reclaim(tmp_path)

    assert await _purge_deep_checkpoint_unless_reclaimed(db_url, "job-1", "worker-A") is False
    assert _rows_left(engine) == len(_TABLES)


@pytest.mark.asyncio
async def test_the_owner_purges_its_checkpoint(tmp_path, monkeypatch):
    engine = _checkpoint_db(tmp_path, monkeypatch)
    db_url = _queue_with_reclaim(tmp_path)

    assert await _purge_deep_checkpoint_unless_reclaimed(db_url, "job-1", "worker-B") is True
    assert _rows_left(engine) == 0


@pytest.mark.asyncio
async def test_the_dask_path_has_no_claim_and_purges(tmp_path, monkeypatch):
    engine = _checkpoint_db(tmp_path, monkeypatch)

    assert await _purge_deep_checkpoint_unless_reclaimed("sqlite://", "job-1", None) is True
    assert _rows_left(engine) == 0


def test_the_runner_never_purges_without_the_claim_check():
    """Ratchet: the unconditional call is what deleted the winner's checkpoint."""
    source = inspect.getsource(runner.run_agent_job)
    assert "_purge_deep_checkpoint(" not in source
    assert "_purge_deep_checkpoint_unless_reclaimed(" in source
