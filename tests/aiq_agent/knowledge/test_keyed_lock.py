"""``keyed_lock``: one holder per key, in this process and, on Postgres, across replicas.

The ingestor holds one per (collection, document name) while it replaces a
document's previous version. Two jobs for one name that ran at once both
collected the same predecessor and both kept their own new version.

The process lock and the fail-closed path run for real; the Postgres half is
pinned by what it sends, since the suite has no Postgres server.
"""

from __future__ import annotations

import asyncio
import threading
import time
from unittest.mock import MagicMock

import pytest

from aiq_agent.knowledge import leader_lock
from aiq_agent.knowledge.leader_lock import keyed_lock
from aiq_agent.knowledge.leader_lock import keyed_lock_async


@pytest.fixture(autouse=True)
def _no_database(monkeypatch):
    monkeypatch.delenv("AIQ_LOCK_DB_URL", raising=False)
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


def test_an_unreachable_database_raises_and_the_body_does_not_run(monkeypatch, caplog):
    # Port 9 (discard) is closed: the lock cannot be taken, so the document is NOT
    # replaced unguarded across replicas; the attempt fails and is retried.
    monkeypatch.setenv("AIQ_LOCK_DB_URL", "postgresql://nobody@127.0.0.1:9/none?connect_timeout=1")
    ran = []
    with caplog.at_level("WARNING"), pytest.raises(Exception):  # noqa: B017, PT011 - the driver's own error
        with keyed_lock("reingest:proj:y.pdf"):
            ran.append(True)
    assert ran == []
    assert "keyed_lock acquisition failed" in caplog.text


def test_a_failed_acquisition_releases_the_process_lock_and_closes_the_session(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", "postgresql://grid@db/grid")
    conn = MagicMock()
    conn.execute.side_effect = RuntimeError("connection lost")
    engine = MagicMock()
    engine.connect.return_value = conn
    monkeypatch.setattr(leader_lock, "_lock_engine", lambda url: engine)

    with pytest.raises(RuntimeError, match="connection lost"), keyed_lock("reingest:proj:z.pdf"):
        pass

    conn.close.assert_called_once()
    # The same key is takeable again at once, here with no Postgres: nothing is left held.
    monkeypatch.delenv("AIQ_LOCK_DB_URL")
    with keyed_lock("reingest:proj:z.pdf"):
        pass


def test_on_postgres_the_key_is_an_advisory_lock_held_on_its_own_session(monkeypatch):
    """Taken before the body, released and the session closed after it, even on a raise."""
    monkeypatch.setenv("AIQ_LOCK_DB_URL", "postgresql://grid@db/grid")
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


async def test_the_async_form_waits_off_the_event_loop_and_holds_across_the_await():
    events: list[str] = []

    async def holder():
        async with keyed_lock_async("langgraph-setup:store"):
            events.append("first in")
            await asyncio.sleep(0.2)
            events.append("first done")

    async def waiter():
        await asyncio.sleep(0.05)
        async with keyed_lock_async("langgraph-setup:store"):
            events.append("second in")

    ticks = 0

    async def loop_stays_free():
        nonlocal ticks
        while len(events) < 3:
            ticks += 1
            await asyncio.sleep(0.01)

    await asyncio.wait_for(asyncio.gather(holder(), waiter(), loop_stays_free()), 10)

    assert events == ["first in", "first done", "second in"]
    assert ticks > 5
