"""Tests for the SSE generators.

Covers: NOTIFY-gap recovery (a lost/out-of-order NOTIFY must not drop events),
terminal drain via range fetch (the final report artifact must not be lost to
a dropped NOTIFY), and mid-stream pub-sub failure resuming the polling fallback
from the last yielded event instead of replaying the whole stream.
"""

from __future__ import annotations

import asyncio
import json
import sys
import types
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest

from aiq_api.jobs.connection_manager import reset_connection_manager
from aiq_api.jobs.event_store import EventStore


@pytest.fixture
def db_url(tmp_path):
    return f"sqlite+aiosqlite:///{tmp_path / 'test_sse_stream.db'}"


@pytest.fixture(autouse=True)
def clear_state():
    EventStore._tables_initialized.clear()
    reset_connection_manager()
    yield
    EventStore._tables_initialized.clear()
    reset_connection_manager()


class FakeListenConnection:
    """Stands in for an asyncpg LISTEN connection; captures the handler so
    tests can inject notifications directly."""

    def __init__(self):
        self.handler = None
        self.channel = None

    async def add_listener(self, channel, handler):
        self.channel = channel
        self.handler = handler

    async def remove_listener(self, channel, handler):
        pass

    async def close(self):
        pass


@pytest.mark.asyncio
async def test_notification_gap_recovered_by_range_fetch_and_terminal_drain(db_url, monkeypatch):
    """A NOTIFY for only the newest event must still deliver all earlier unseen
    events (range fetch), and events written after the last NOTIFY must be
    delivered by the terminal drain's final range fetch."""
    import aiq_api.routes.jobs as jobs_routes

    fake_conn = FakeListenConnection()
    fake_asyncpg = types.SimpleNamespace(connect=AsyncMock(return_value=fake_conn))
    monkeypatch.setitem(sys.modules, "asyncpg", fake_asyncpg)

    job_id = "sse-job"
    store = EventStore(db_url, job_id)

    running = SimpleNamespace(status="running", error=None)
    success = SimpleNamespace(status="success", error=None)
    job_store = SimpleNamespace(get_job=AsyncMock(side_effect=[running, success]))

    gen = jobs_routes._sse_generator_postgres(job_store, job_id, db_url, 0)

    # No historical events yet: the first yield is the stream.mode announcement.
    first = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
    assert "stream.mode" in first

    # Let the generator pass the reconciliation fetch and block on the
    # notification queue, THEN store three events but deliver a NOTIFY for
    # only the last one (simulating two lost/out-of-order NOTIFYs).
    pending = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0.3)
    store.store({"type": "step.one", "data": {}})
    store.store({"type": "step.two", "data": {}})
    store.store({"type": "step.three", "data": {}})
    last_id = EventStore.get_events(db_url, job_id)[-1]["_id"]
    fake_conn.handler(None, 1234, fake_conn.channel, json.dumps({"id": last_id}))

    chunk1 = await asyncio.wait_for(pending, timeout=5.0)
    chunk2 = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
    chunk3 = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
    assert "event: step.one" in chunk1
    assert "event: step.two" in chunk2
    assert "event: step.three" in chunk3

    # Job flips to success -> job.status is emitted next.
    status_chunk = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
    assert "event: job.status" in status_chunk
    assert '"status": "success"' in status_chunk

    # Final report artifact stored WITHOUT any NOTIFY: the terminal drain's
    # final range fetch must still deliver it.
    store.store({"type": "artifact.update", "data": {"type": "output", "content": "final report"}})
    final_chunk = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
    assert "event: artifact.update" in final_chunk
    assert "final report" in final_chunk

    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(gen.__anext__(), timeout=5.0)


@pytest.mark.asyncio
async def test_pubsub_midstream_failure_resumes_polling_from_last_yielded_event(monkeypatch):
    """The polling fallback must resume from the pub-sub generator's cursor,
    not replay the whole stream from the original start_event_id."""
    import aiq_api.routes.jobs as jobs_routes

    resume: dict = {}

    async def fake_postgres(job_store, job_id, db_url, start_event_id=0, progress=None):
        assert progress is not None
        progress["last_event_id"] = 42
        yield "id: 42\nevent: step.one\ndata: {}\n\n"
        raise RuntimeError("connection dropped mid-stream")

    async def fake_polling(job_store, job_id, db_url, start_event_id=0):
        resume["start_event_id"] = start_event_id
        yield "id: 43\nevent: step.two\ndata: {}\n\n"

    monkeypatch.setattr(jobs_routes, "_sse_generator_postgres", fake_postgres)
    monkeypatch.setattr(jobs_routes, "_sse_generator_polling", fake_polling)

    chunks = [
        chunk async for chunk in jobs_routes._sse_generator(MagicMock(), "job-1", "postgresql://db/x", start_event_id=5)
    ]

    assert resume["start_event_id"] == 42
    assert len(chunks) == 2


@pytest.mark.asyncio
async def test_pubsub_failure_before_any_event_resumes_from_start_event_id(monkeypatch):
    """If pub-sub dies before yielding anything, polling starts at the original cursor."""
    import aiq_api.routes.jobs as jobs_routes

    resume: dict = {}

    async def fake_postgres(job_store, job_id, db_url, start_event_id=0, progress=None):
        raise RuntimeError("could not connect")
        yield  # pragma: no cover - makes this an async generator

    async def fake_polling(job_store, job_id, db_url, start_event_id=0):
        resume["start_event_id"] = start_event_id
        yield "id: 5\nevent: stream.mode\ndata: {}\n\n"

    monkeypatch.setattr(jobs_routes, "_sse_generator_postgres", fake_postgres)
    monkeypatch.setattr(jobs_routes, "_sse_generator_polling", fake_polling)

    chunks = [
        chunk async for chunk in jobs_routes._sse_generator(MagicMock(), "job-1", "postgresql://db/x", start_event_id=5)
    ]

    assert resume["start_event_id"] == 5
    assert len(chunks) == 1
