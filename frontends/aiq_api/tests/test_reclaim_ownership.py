"""Reclaim-during-run emits ownership-lost, never a user cancel (hardening item 7).

Root cause: the DB worker aborts a reclaimed run with a bare
``run_task.cancel()``, which is indistinguishable on delivery from the
``CancellationMonitor``'s user cancel — so the runner's ``CancelledError``
handler told every abort as a user cancel (INTERRUPTED "cancelled by user" +
user notice + ``job.cancelled``) while the new owner was still running. The
two causes are told apart by positive claim state (item 10's ``_lost_claim``),
never by message sniffing.

Why missed: one delivery path, two causes. The cancel-route tests covered the
user path and the reaper tests covered the FAILURE race, but no test ever
reclaimed a live claim mid-run — and the ``job.cancelled`` store sat at the
tail of the handler unconditionally, outside every gate item 6/10 added.

The fix (``runner._finalize_cancelled_run``): positive claim loss takes the
ownership-lost branch — no status write, no notice, no notify, no
``job.cancelled`` — and streams one truthful ``job.ownership-lost`` lifecycle
event through the same ``EventStore`` the SSE stream replays (no new phase, so
no ``phase_events`` row — AGENTS.md). The ``job.cancelled`` event additionally
agrees with the standing verdict (``_should_emit_cancelled_event``): a late
abort after the winner's SUCCESS or the reaper's FAILURE streams nothing.

Ratchet: this file drives the real finalizer against a real sqlite JobStore,
queue table and event table — no store/queue mocks. Only the HTTP seams are
stubbed (``post_internal_conversation_message``, per conversation_output's own
"Python never touches the database" contract); the outcome notify is observed,
not stubbed out.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from aiq_api.jobs import queue
from aiq_api.jobs.conversation_output import INTERRUPTED_NOTICE
from aiq_api.jobs.conversation_output import write_job_turn
from aiq_api.jobs.event_store import EventStore
from aiq_api.jobs.runner import JOB_OWNERSHIP_LOST_EVENT_TYPE
from aiq_api.jobs.runner import _finalize_cancelled_run
from aiq_api.jobs.runner import _lost_claim
from aiq_api.jobs.runner import _should_emit_cancelled_event
from aiq_api.jobs.runner import _should_write_notice
from aiq_api.jobs.runner import _update_status_if_not_terminal

USAGE = {"identity": {"organization_id": "org_1", "user_id": "u1"}}
CONVERSATION_ID = "conv-1"


@pytest.fixture
def db_url(tmp_path):
    """One SQLite file for the queue table, job_info and job_events alike.

    ``sqlite+aiosqlite`` so NAT's async JobStore and the sync SQLAlchemy
    engines (queue/event_store, normalized to sync) meet in the same file.
    """
    url = f"sqlite+aiosqlite:///{tmp_path / 'reclaim_ownership.db'}"
    queue.ensure_research_queue_table(url)
    _ensure_job_info_table(url)
    yield url
    queue._queue_schema_initialized.discard(url)
    EventStore._tables_initialized.discard(url)


@pytest.fixture(autouse=True)
def clear_engine_caches():
    EventStore._tables_initialized.clear()
    yield
    EventStore._tables_initialized.clear()


@pytest.fixture
def posts(monkeypatch):
    """The conversation HTTP seam: record what the thread would have received."""
    mock = AsyncMock()
    monkeypatch.setattr(
        "aiq_api.jobs.conversation_output.post_internal_conversation_message",
        mock,
    )
    return mock


@pytest.fixture
def notify_spy(monkeypatch):
    """Observe (not stub out) outcome notifications."""
    mock = AsyncMock(return_value=False)
    monkeypatch.setattr("aiq_api.jobs.runner.notify_job_outcome", mock)
    return mock


def _ensure_job_info_table(db_url: str) -> None:
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
        conn.commit()


def _seed_job(db_url: str, job_id: str, status: str) -> None:
    from datetime import UTC
    from datetime import datetime
    from datetime import timedelta

    engine = EventStore._get_or_create_sync_engine(db_url)
    ts = (datetime.now(UTC) - timedelta(seconds=10)).replace(tzinfo=None)
    with engine.connect() as conn:
        conn.execute(
            text(
                "INSERT OR REPLACE INTO job_info "
                "(job_id, status, created_at, updated_at, expiry_seconds, is_expired) "
                "VALUES (:job_id, :status, :ts, :ts, 3600, 0)"
            ),
            {"job_id": job_id, "status": status, "ts": ts},
        )
        conn.commit()


def _age_heartbeat(db_url: str, job_id: str, seconds_ago: int) -> None:
    with queue._connection(db_url) as conn:
        conn.execute(
            text("UPDATE research_job_queue SET heartbeat_at = datetime('now', :delta) WHERE job_id = :job_id"),
            {"delta": f"-{seconds_ago} seconds", "job_id": job_id},
        )
        conn.commit()


def _make_store(db_url: str):
    from nat.front_ends.fastapi.async_jobs.job_store import JobStore

    return JobStore(scheduler_address="", db_url=db_url)


def _reclaim(db_url: str, job_id: str = "job-1") -> None:
    """Worker-A stalls past the stale window; worker-B reclaims the live claim."""
    queue.enqueue(db_url, job_id, {"input_text": "x"})
    queue.claim_next(db_url, "worker-A", 30, 3)
    _age_heartbeat(db_url, job_id, 120)
    queue.claim_next(db_url, "worker-B", 30, 3)


def _event_types(db_url: str, job_id: str) -> list[str]:
    return [event["type"] for event in EventStore.get_events(db_url, job_id)]


class TestReclaimDuringRun:
    """The item-7 ratchet: loser emits ownership-lost only, winner still wins."""

    @pytest.mark.asyncio
    async def test_loser_emits_ownership_lost_only(self, db_url, posts, notify_spy):
        _seed_job(db_url, "job-1", "running")
        _reclaim(db_url)
        store = _make_store(db_url)

        await _finalize_cancelled_run(
            job_store=store,
            db_url=db_url,
            job_id="job-1",
            claim_owner="worker-A",
            parent_conversation_id=CONVERSATION_ID,
            usage_context=USAGE,
            event_store=None,
        )

        # Status untouched: still RUNNING for the new owner to finalize.
        job = await store.get_job("job-1")
        assert job.status == "running"
        assert job.error is None

        # Exactly one lifecycle event, and it is not the user-cancel one.
        events = EventStore.get_events(db_url, "job-1")
        assert [event["type"] for event in events] == [JOB_OWNERSHIP_LOST_EVENT_TYPE]
        assert JOB_OWNERSHIP_LOST_EVENT_TYPE == "job.ownership-lost"
        assert "cancelled by user" not in json.dumps(events)

        # Nothing user-visible: no thread notice, no outcome notify.
        posts.assert_not_awaited()
        notify_spy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_winner_succeeds_and_writes_turn_coherently(self, db_url, posts):
        """After the loser's ownership-lost, the winner's SUCCESS + thread turn
        land as one coherent artefact — status, Report and thread agree, and
        the stream holds no cancellation."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        _seed_job(db_url, "job-1", "running")
        _reclaim(db_url)
        store = _make_store(db_url)

        await _finalize_cancelled_run(
            job_store=store,
            db_url=db_url,
            job_id="job-1",
            claim_owner="worker-A",
            parent_conversation_id=CONVERSATION_ID,
            usage_context=USAGE,
            event_store=None,
        )

        # Winner B still owns the claim, so its verdict write wins ...
        assert await _lost_claim(db_url, "job-1", "worker-B") is False
        finalized = await _update_status_if_not_terminal(store, "job-1", JobStatus.SUCCESS, output={"report": "winner"})
        assert finalized is True

        # ... and its thread turn goes out through the real writer.
        await write_job_turn(
            conversation_id=CONVERSATION_ID,
            job_id="job-1",
            usage_context=USAGE,
            prompt="Fasse die Woche zusammen.",
            answer="winner",
        )
        written = [call.kwargs for call in posts.await_args_list]
        assert [post["role"] for post in written] == ["user", "assistant"]
        assert written[1]["text"] == "winner"
        assert written[1]["metadata"]["deep_research_job_id"] == "job-1"

        job = await store.get_job("job-1")
        assert job.status == "success"
        assert job.error is None
        assert json.loads(job.output) == {"report": "winner"}
        assert _event_types(db_url, "job-1") == [JOB_OWNERSHIP_LOST_EVENT_TYPE]


class TestUserCancelPreserved:
    """The other side of the branch: a real cancel keeps its full vocabulary."""

    @pytest.mark.asyncio
    async def test_cancel_route_state_repeats_cancelled(self, db_url, posts, notify_spy):
        """Cancel route already wrote INTERRUPTED and deleted the queue row; the
        runner loses the write race but still leaves the notice and the event."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        _seed_job(db_url, "job-1", "running")
        store = _make_store(db_url)
        await store.update_status("job-1", JobStatus.INTERRUPTED, error="cancelled by user")
        # No queue row: the cancel route deleted it (indeterminate, not a loss).

        await _finalize_cancelled_run(
            job_store=store,
            db_url=db_url,
            job_id="job-1",
            claim_owner="worker-A",
            parent_conversation_id=CONVERSATION_ID,
            usage_context=USAGE,
            event_store=None,
        )

        job = await store.get_job("job-1")
        assert job.status == "interrupted"
        assert job.error == "cancelled by user"

        events = EventStore.get_events(db_url, "job-1")
        assert [event["type"] for event in events] == ["job.cancelled"]
        assert events[0]["data"] == {"reason": "cancelled by user"}

        posts.assert_awaited_once()
        assert posts.await_args.kwargs["text"] == INTERRUPTED_NOTICE
        # Lost the status-write race, so no second outcome report (unchanged).
        notify_spy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_runner_winning_the_race_reports_fully(self, db_url, posts, notify_spy):
        """External abort while still RUNNING: the runner owns the INTERRUPTED
        verdict, the notice, the notify and the event — today's shape, kept."""
        _seed_job(db_url, "job-1", "running")
        store = _make_store(db_url)

        await _finalize_cancelled_run(
            job_store=store,
            db_url=db_url,
            job_id="job-1",
            claim_owner="worker-A",
            parent_conversation_id=CONVERSATION_ID,
            usage_context=USAGE,
            event_store=None,
        )

        job = await store.get_job("job-1")
        assert job.status == "interrupted"
        assert job.error == "cancelled by user"
        assert _event_types(db_url, "job-1") == ["job.cancelled"]
        posts.assert_awaited_once()
        notify_spy.assert_awaited_once_with(job_id="job-1", usage_context=USAGE, status="interrupted")

    @pytest.mark.asyncio
    async def test_dask_path_has_no_claim_to_lose(self, db_url, posts, notify_spy):
        """``claim_owner=None`` (no claim table on the Dask path): the abort is
        a cancel, never ownership-lost — both GRID_JOB_EXECUTION modes behave."""
        _seed_job(db_url, "job-1", "running")
        store = _make_store(db_url)

        await _finalize_cancelled_run(
            job_store=store,
            db_url=db_url,
            job_id="job-1",
            claim_owner=None,
            parent_conversation_id=CONVERSATION_ID,
            usage_context=USAGE,
            event_store=None,
        )

        job = await store.get_job("job-1")
        assert job.status == "interrupted"
        assert _event_types(db_url, "job-1") == ["job.cancelled"]
        posts.assert_awaited_once()
        notify_spy.assert_awaited_once()


class TestLateAbortAfterStandingVerdict:
    """A late abort must not rewrite a verdict it does not own (item 7 tail)."""

    @pytest.mark.asyncio
    async def test_abort_after_winner_success_streams_nothing(self, db_url, posts, notify_spy):
        """Winner SUCCEEDED and dropped the queue row before the loser's abort
        landed: indeterminate claim, but the standing SUCCESS vetoes the
        user-cancel vocabulary entirely. (Old code streamed job.cancelled.)"""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        _seed_job(db_url, "job-1", "running")
        store = _make_store(db_url)
        await store.update_status("job-1", JobStatus.SUCCESS, output={"report": "winner"})
        # No queue row: the winner's mark_done already removed it.

        await _finalize_cancelled_run(
            job_store=store,
            db_url=db_url,
            job_id="job-1",
            claim_owner="worker-A",
            parent_conversation_id=CONVERSATION_ID,
            usage_context=USAGE,
            event_store=None,
        )

        job = await store.get_job("job-1")
        assert job.status == "success"
        assert json.loads(job.output) == {"report": "winner"}
        assert EventStore.get_events(db_url, "job-1") == []
        posts.assert_not_awaited()
        notify_spy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_abort_after_reaper_failure_streams_nothing(self, db_url, posts, notify_spy):
        _seed_job(db_url, "job-1", "failure")
        store = _make_store(db_url)

        await _finalize_cancelled_run(
            job_store=store,
            db_url=db_url,
            job_id="job-1",
            claim_owner="worker-A",
            parent_conversation_id=CONVERSATION_ID,
            usage_context=USAGE,
            event_store=None,
        )

        job = await store.get_job("job-1")
        assert job.status == "failure"
        assert EventStore.get_events(db_url, "job-1") == []
        posts.assert_not_awaited()
        notify_spy.assert_not_awaited()


class TestShouldEmitCancelledEvent:
    """``_should_emit_cancelled_event`` on the real store: verdict agreement."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("status", "finalized", "expected"),
        [
            ("running", True, True),  # this run wrote INTERRUPTED itself
            ("interrupted", False, True),  # the cancel route owns the verdict
            ("success", False, False),  # the winner owns the stream
            ("failure", False, False),  # the reaper owns the stream
            ("success", True, True),  # the writer always owns its event
            # No verdict recorded while still RUNNING (the INTERRUPTED write
            # failed): claiming a user cancel would contradict the store; the
            # ghost reaper owns the eventual signal. Notice and event agree.
            ("running", False, False),
        ],
    )
    async def test_truth_table(self, db_url, status, finalized, expected):
        _seed_job(db_url, "job-1", status)
        assert (
            await _should_emit_cancelled_event(job_store=_make_store(db_url), job_id="job-1", finalized=finalized)
            is expected
        )

    @pytest.mark.asyncio
    async def test_missing_job_fails_open(self, db_url):
        assert await _should_emit_cancelled_event(job_store=_make_store(db_url), job_id="nope", finalized=False) is True

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["running", "interrupted", "success", "failure"])
    @pytest.mark.parametrize("finalized", [True, False])
    async def test_notice_and_event_always_agree(self, db_url, status, finalized):
        """The cancel path's thread notice and lifecycle event share one truth
        table, so the thread can never claim a cancel the stream denies."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        _seed_job(db_url, "job-1", status)
        store = _make_store(db_url)
        notice = await _should_write_notice(
            job_store=store, job_id="job-1", verdict=JobStatus.INTERRUPTED.value, finalized=finalized
        )
        event = await _should_emit_cancelled_event(job_store=store, job_id="job-1", finalized=finalized)
        assert notice is event
