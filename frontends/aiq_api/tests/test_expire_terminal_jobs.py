"""job_info / job_access retention in db-execution mode (ADR-0021).

NAT's expiry runs only as a Dask task, so in db mode nothing ages out finished
jobs. ``expire_terminal_jobs`` fills that gap: it marks terminal rows expired
past their per-row expiry and hard-deletes rows past the delete grace, always
keeping the single most-recent finished job and never touching active jobs.
"""

from __future__ import annotations

from datetime import UTC
from datetime import datetime
from datetime import timedelta

from sqlalchemy import text

from aiq_api.jobs.access import expire_terminal_jobs
from aiq_api.jobs.event_store import EventStore


def _iso(days_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M:%S")


def _setup(dsn: str) -> None:
    engine = EventStore._get_or_create_sync_engine(dsn)
    with engine.connect() as conn:
        conn.execute(
            text(
                "CREATE TABLE job_info ("
                "  job_id TEXT PRIMARY KEY, status TEXT, updated_at DATETIME,"
                "  expiry_seconds INTEGER, is_expired INTEGER DEFAULT 0)"
            )
        )
        conn.execute(text("CREATE TABLE job_access (job_id TEXT PRIMARY KEY, owner TEXT)"))
        conn.execute(text("CREATE TABLE job_events (id INTEGER PRIMARY KEY, job_id TEXT)"))
        rows = [
            # id, status, updated_at, expiry(1h)
            ("active", "RUNNING", _iso(30), 3600),  # non-terminal -> never touched
            ("old-del", "FAILURE", _iso(30), 3600),  # past expiry + past 7d grace -> DELETE
            ("mid-mark", "FAILURE", _iso(2), 3600),  # past expiry, within grace -> MARK
            ("newest", "SUCCESS", _iso(1), 3600),  # most-recent finished -> KEEP untouched
        ]
        for job_id, status, updated_at, expiry in rows:
            conn.execute(
                text("INSERT INTO job_info (job_id, status, updated_at, expiry_seconds) VALUES (:j, :s, :u, :e)"),
                {"j": job_id, "s": status, "u": updated_at, "e": expiry},
            )
            conn.execute(text("INSERT INTO job_access (job_id, owner) VALUES (:j, 'u')"), {"j": job_id})
            conn.execute(text("INSERT INTO job_events (job_id) VALUES (:j)"), {"j": job_id})
        conn.commit()


def test_marks_expired_deletes_aged_keeps_newest_and_active(tmp_path):
    dsn = f"sqlite:///{tmp_path / 'jobs.db'}"
    _setup(dsn)

    marked, deleted = expire_terminal_jobs(dsn, delete_grace_seconds=7 * 86400)

    # Both past-expiry terminals are marked (old-del + mid-mark); old-del is then
    # also hard-deleted for being past the 7d grace.
    assert (marked, deleted) == (2, 1)
    engine = EventStore._get_or_create_sync_engine(dsn)
    with engine.connect() as conn:
        info = dict(conn.execute(text("SELECT job_id, is_expired FROM job_info")).fetchall())
        # Aged-out job is gone from every table (cascade).
        assert "old-del" not in info
        for table in ("job_access", "job_events"):
            remaining = conn.execute(text(f"SELECT job_id FROM {table}")).scalars().all()
            assert "old-del" not in remaining, f"{table} kept the deleted job"
        # Past-expiry-but-within-grace is flagged, not deleted.
        assert info["mid-mark"] == 1
        # Most-recent finished job is preserved untouched even though it is past expiry.
        assert info["newest"] == 0
        # Active (non-terminal) job is never expired.
        assert info["active"] == 0


def test_noop_when_no_job_info_table(tmp_path):
    dsn = f"sqlite:///{tmp_path / 'empty.db'}"
    # No tables created -> safe (0, 0), no raise.
    assert expire_terminal_jobs(dsn, delete_grace_seconds=604800) == (0, 0)
