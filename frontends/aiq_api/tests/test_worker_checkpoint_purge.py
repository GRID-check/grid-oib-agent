"""Deep-research checkpoint retention: a finished run's durable checkpoint rows
are purged (thread_id == job_id), and the helper is a safe no-op when durable
checkpointing is not configured."""

from sqlalchemy import text

from aiq_api.jobs.event_store import EventStore
from aiq_api.jobs.worker import _purge_deep_checkpoint

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
