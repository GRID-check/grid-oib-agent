"""``keyed_lock``: one holder per key, in this process and, on Postgres, across replicas.

The ingestor holds one per (collection, document name) while it replaces a
document's previous version. Two jobs for one name that ran at once both
collected the same predecessor and both kept their own new version.

The process lock and the fail-open path run for real; the Postgres half is
pinned by what it sends, since the suite has no Postgres server.
"""

from __future__ import annotations

import threading
import time
from unittest.mock import MagicMock

import pytest

from aiq_agent.knowledge import leader_lock
from aiq_agent.knowledge.leader_lock import keyed_lock


@pytest.fixture(autouse=True)
def _no_database(monkeypatch):
    monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
    monkeypatch.delenv("NAT_JOB_STORE_DB_URL", raising=False)


def _run_two(first_key: str, second_key: str) -> list[str]:
    """Hold ``first_key`` while another thread asks for ``second_key``; the order things happened."""
    events: list[str] = []
    inside = threading.Event()

    def holder():
        with keyed_lock(first_key):
            inside.set()
            time.sleep(0.3)
            events.append("first done")

    def waiter():
        assert inside.wait(5)
        with keyed_lock(second_key):
            events.append("second in")

    threads = [threading.Thread(target=holder), threading.Thread(target=waiter)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    return events


def test_the_same_key_waits_for_its_holder():
    assert _run_two("reingest:proj:statik.pdf", "reingest:proj:statik.pdf") == ["first done", "second in"]


def test_another_key_does_not_wait():
    assert _run_two("reingest:proj:statik.pdf", "reingest:proj:anderes.pdf") == ["second in", "first done"]


def test_the_lock_is_released_when_the_body_raises():
    with pytest.raises(RuntimeError), keyed_lock("reingest:proj:x.pdf"):
        raise RuntimeError("ingest failed")
    with keyed_lock("reingest:proj:x.pdf"):
        pass


def test_an_unreachable_database_runs_the_body_unguarded(monkeypatch):
    # Port 9 (discard) is closed: acquisition fails and the upload goes on.
    monkeypatch.setenv("AIQ_SUMMARY_DB", "postgresql://nobody@127.0.0.1:9/none?connect_timeout=1")
    ran = []
    with keyed_lock("reingest:proj:y.pdf"):
        ran.append(True)
    assert ran == [True]


def test_on_postgres_the_key_is_an_advisory_lock_held_on_its_own_session(monkeypatch):
    """Taken before the body, released and the session closed after it, even on a raise."""
    monkeypatch.setenv("AIQ_SUMMARY_DB", "postgresql://grid@db/grid")
    conn = MagicMock()
    engine = MagicMock()
    engine.connect.return_value = conn
    monkeypatch.setattr(leader_lock, "_lock_engine", lambda url: engine)

    with pytest.raises(RuntimeError), keyed_lock("reingest:proj:statik.pdf"):
        (lock_sql, params), _ = conn.execute.call_args
        assert "pg_advisory_lock(:namespace, hashtext(:key))" in str(lock_sql)
        assert params == {"namespace": leader_lock._KEYED_LOCK_NAMESPACE, "key": "reingest:proj:statik.pdf"}
        raise RuntimeError("ingest failed")

    (unlock_sql, _), _ = conn.execute.call_args
    assert "pg_advisory_unlock" in str(unlock_sql)
    conn.close.assert_called_once()
