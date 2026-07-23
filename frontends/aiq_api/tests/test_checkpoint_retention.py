"""Age-based retention for the chat checkpoint store (P0 #1, chat side).

Chat conversations have no terminal event, so their LangGraph checkpoints
accumulate forever. ``reap_idle_threads`` drops whole threads whose newest
checkpoint ``ts`` is older than the retention window, across all three
checkpoint tables, and is a safe no-op when unconfigured.
"""

from __future__ import annotations

import json
from datetime import UTC
from datetime import datetime
from datetime import timedelta

from sqlalchemy import text

from aiq_api.jobs.checkpoint_retention import _cutoff_iso
from aiq_api.jobs.checkpoint_retention import reap_idle_threads
from aiq_api.jobs.event_store import EventStore

_TABLES = ("checkpoints", "checkpoint_blobs", "checkpoint_writes")


def _ts(days_ago: float) -> str:
    return (datetime.now(UTC) - timedelta(days=days_ago)).isoformat()


def _setup(dsn: str) -> None:
    engine = EventStore._get_or_create_sync_engine(dsn)
    with engine.connect() as conn:
        conn.execute(text("CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint TEXT)"))
        conn.execute(text("CREATE TABLE checkpoint_blobs (thread_id TEXT, channel TEXT)"))
        conn.execute(text("CREATE TABLE checkpoint_writes (thread_id TEXT, idx INTEGER)"))
        # "stale" thread: two checkpoints, newest is 20 days old (> 14d window).
        for days in (25, 20):
            conn.execute(
                text("INSERT INTO checkpoints (thread_id, checkpoint) VALUES ('stale', :c)"),
                {"c": json.dumps({"ts": _ts(days)})},
            )
        # "fresh" thread: last active an hour ago.
        conn.execute(
            text("INSERT INTO checkpoints (thread_id, checkpoint) VALUES ('fresh', :c)"),
            {"c": json.dumps({"ts": _ts(1 / 24)})},
        )
        for thread in ("stale", "fresh"):
            conn.execute(text("INSERT INTO checkpoint_blobs (thread_id, channel) VALUES (:t, 'x')"), {"t": thread})
            conn.execute(text("INSERT INTO checkpoint_writes (thread_id, idx) VALUES (:t, 0)"), {"t": thread})
        conn.commit()


def test_reaps_only_idle_threads(tmp_path):
    dsn = f"sqlite:///{tmp_path / 'ckpt.db'}"
    _setup(dsn)

    reaped = reap_idle_threads(dsn, retention_seconds=14 * 86400)

    assert reaped == 1
    engine = EventStore._get_or_create_sync_engine(dsn)
    with engine.connect() as conn:
        for table in _TABLES:
            remaining = conn.execute(text(f"SELECT thread_id FROM {table}")).scalars().all()
            assert "stale" not in remaining, f"{table} kept the idle thread"
            assert "fresh" in remaining, f"{table} lost the active thread"


def test_noop_without_dsn():
    assert reap_idle_threads(None, retention_seconds=100) == 0
    assert reap_idle_threads("", retention_seconds=100) == 0


def test_noop_when_no_tables(tmp_path):
    dsn = f"sqlite:///{tmp_path / 'empty.db'}"
    assert reap_idle_threads(dsn, retention_seconds=100) == 0


def test_noop_when_retention_disabled(tmp_path):
    dsn = f"sqlite:///{tmp_path / 'ckpt.db'}"
    _setup(dsn)
    assert reap_idle_threads(dsn, retention_seconds=0) == 0


def test_cutoff_is_chronological():
    now = datetime(2026, 7, 23, tzinfo=UTC)
    cutoff = _cutoff_iso(86400, now=now)
    assert cutoff == (now - timedelta(days=1)).isoformat()
