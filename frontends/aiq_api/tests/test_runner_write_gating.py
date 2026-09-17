"""Write gating for finished job runs (deep-research hardening, item 10).

Root cause: the SUCCESS status write was guarded by
``_update_status_if_not_terminal`` but the conversation writes were not — a
reaped (FAILURE) job finishing late still wrote its answer into the thread
while the status stayed FAILURE, and a losing worker wrote INTERRUPTED_NOTICE
beside the winner's answer. Thread vs Report vs status diverged.

The gate (``aiq_api.jobs.runner``): a run publishes thread/notice output only
when it still owns the job — a positively lost queue claim publishes nothing
at all, and otherwise the notice must agree with the standing terminal
verdict. The conditional status write itself is item 6's; this item owns the
conversation-write gating and coordinates with it through the ``finalized``
verdict. Lifecycle events (``job.cancelled``/``job.error``/``job.phase``) are
deliberately untouched here: the ownership-lost signal owns them (item 7).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from aiq_api.jobs import queue
from aiq_api.jobs.event_store import EventStore
from aiq_api.jobs.runner import _current_job_status
from aiq_api.jobs.runner import _lost_claim
from aiq_api.jobs.runner import _should_write_notice
from aiq_api.jobs.runner import _update_status_if_not_terminal


@pytest.fixture
def db_url(tmp_path):
    """One SQLite file for the queue table, job_info and job_events alike.

    ``sqlite+aiosqlite`` so NAT's async JobStore and the sync SQLAlchemy
    engines (queue/event_store, normalized to sync) meet in the same file.
    """
    url = f"sqlite+aiosqlite:///{tmp_path / 'write_gating.db'}"
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


def _fake_store(status: str | None = None, exc: BaseException | None = None):
    if exc is not None:
        return SimpleNamespace(get_job=AsyncMock(side_effect=exc))
    job = SimpleNamespace(status=status) if status is not None else None
    return SimpleNamespace(get_job=AsyncMock(return_value=job))


class TestClaimOwnerProbe:
    """``queue.claim_owner``: who holds the live claim, or indeterminate."""

    def test_unclaimed_row_is_indeterminate(self, db_url):
        queue.enqueue(db_url, "job-1", {"input_text": "x"})
        assert queue.claim_owner(db_url, "job-1") is None

    def test_reports_the_current_holder(self, db_url):
        queue.enqueue(db_url, "job-1", {"input_text": "x"})
        queue.claim_next(db_url, "worker-A", 30, 3)
        assert queue.claim_owner(db_url, "job-1") == "worker-A"

    def test_loser_sees_the_winner(self, db_url):
        queue.enqueue(db_url, "job-1", {"input_text": "x"})
        queue.claim_next(db_url, "worker-A", 30, 3)
        _age_heartbeat(db_url, "job-1", 120)
        queue.claim_next(db_url, "worker-B", 30, 3)
        assert queue.claim_owner(db_url, "job-1") == "worker-B"

    def test_deleted_row_is_indeterminate(self, db_url):
        """Cancel route / mark_done delete the row: not a loss, the verdict
        gate decides (a user cancel still owns its INTERRUPTED notice)."""
        queue.enqueue(db_url, "job-1", {"input_text": "x"})
        queue.claim_next(db_url, "worker-A", 30, 3)
        queue.mark_done(db_url, "job-1", worker_id="worker-A")
        assert queue.claim_owner(db_url, "job-1") is None

    def test_unknown_job_is_indeterminate(self, db_url):
        assert queue.claim_owner(db_url, "nope") is None


class TestLostClaim:
    """``runner._lost_claim``: positive ownership loss only, fail open."""

    @pytest.mark.asyncio
    async def test_no_owner_means_no_claim_to_lose(self):
        """Dask path (``claim_owner=None``): must not touch any database, not
        even to fail — a bogus URL proves no I/O happens."""
        assert await _lost_claim("sqlite:////definitely/not/here.db", "job-1", None) is False

    @pytest.mark.asyncio
    async def test_owner_match_is_not_a_loss(self, db_url):
        queue.enqueue(db_url, "job-1", {"input_text": "x"})
        queue.claim_next(db_url, "worker-A", 30, 3)
        assert await _lost_claim(db_url, "job-1", "worker-A") is False

    @pytest.mark.asyncio
    async def test_reclaimed_loser_reports_loss(self, db_url):
        queue.enqueue(db_url, "job-1", {"input_text": "x"})
        queue.claim_next(db_url, "worker-A", 30, 3)
        _age_heartbeat(db_url, "job-1", 120)
        queue.claim_next(db_url, "worker-B", 30, 3)
        assert await _lost_claim(db_url, "job-1", "worker-A") is True
        assert await _lost_claim(db_url, "job-1", "worker-B") is False

    @pytest.mark.asyncio
    async def test_missing_row_is_indeterminate_not_a_loss(self, db_url):
        assert await _lost_claim(db_url, "job-1", "worker-A") is False


class TestCurrentJobStatus:
    @pytest.mark.asyncio
    async def test_passes_the_status_through(self):
        assert await _current_job_status(_fake_store("failure"), "job-1") == "failure"

    @pytest.mark.asyncio
    async def test_missing_job_is_none(self):
        assert await _current_job_status(_fake_store(None), "job-1") is None

    @pytest.mark.asyncio
    async def test_unreadable_status_is_none(self):
        assert await _current_job_status(_fake_store(exc=ConnectionError("db down")), "job-1") is None

    @pytest.mark.asyncio
    async def test_no_store_is_none(self):
        assert await _current_job_status(None, "job-1") is None


class TestShouldWriteNotice:
    """The notice must agree with the standing verdict (item 10).

    ``finalized`` (this run wrote the terminal state, item 6's verdict) always
    wins. Otherwise only the same verdict may repeat its notice — idempotent by
    deterministic message id — and an unreadable status fails open.
    """

    @pytest.mark.asyncio
    @pytest.mark.parametrize("status", ["running", "success", "failure", "interrupted", None])
    @pytest.mark.parametrize("verdict", ["interrupted", "failure"])
    async def test_winner_always_may_write(self, status, verdict):
        assert (
            await _should_write_notice(job_store=_fake_store(status), job_id="j", verdict=verdict, finalized=True)
            is True
        )

    @pytest.mark.asyncio
    async def test_user_cancel_notice_survives_a_lost_status_race(self):
        """The cancel route wrote INTERRUPTED; the worker's own write reports
        False — the thread must still say what happened, or the cancel leaves
        an empty thread that reads as broken."""
        assert (
            await _should_write_notice(
                job_store=_fake_store("interrupted"), job_id="j", verdict="interrupted", finalized=False
            )
            is True
        )

    @pytest.mark.asyncio
    async def test_loser_cancel_after_winner_success_is_skipped(self):
        """The INTERRUPTED_NOTICE-beside-the-winner's-answer divergence."""
        assert (
            await _should_write_notice(
                job_store=_fake_store("success"), job_id="j", verdict="interrupted", finalized=False
            )
            is False
        )

    @pytest.mark.asyncio
    async def test_cancel_after_reaper_failure_is_skipped(self):
        assert (
            await _should_write_notice(
                job_store=_fake_store("failure"), job_id="j", verdict="interrupted", finalized=False
            )
            is False
        )

    @pytest.mark.asyncio
    async def test_failure_after_winner_success_is_skipped(self):
        assert (
            await _should_write_notice(job_store=_fake_store("success"), job_id="j", verdict="failure", finalized=False)
            is False
        )

    @pytest.mark.asyncio
    async def test_failure_after_user_cancel_is_skipped(self):
        """A failure notice must not relabel a standing cancellation."""
        assert (
            await _should_write_notice(
                job_store=_fake_store("interrupted"), job_id="j", verdict="failure", finalized=False
            )
            is False
        )

    @pytest.mark.asyncio
    async def test_same_verdict_failure_may_repeat(self):
        """Same verdict, no divergence: the notice only fills the thread the
        reaper left empty, under the identical message id."""
        assert (
            await _should_write_notice(job_store=_fake_store("failure"), job_id="j", verdict="failure", finalized=False)
            is True
        )

    @pytest.mark.asyncio
    async def test_unreadable_status_fails_open(self):
        assert (
            await _should_write_notice(
                job_store=_fake_store(exc=ConnectionError("db down")),
                job_id="j",
                verdict="failure",
                finalized=False,
            )
            is True
        )

    @pytest.mark.asyncio
    async def test_missing_job_fails_open(self):
        assert (
            await _should_write_notice(job_store=_fake_store(None), job_id="j", verdict="failure", finalized=False)
            is True
        )

    @pytest.mark.asyncio
    async def test_no_store_fails_open(self):
        assert await _should_write_notice(job_store=None, job_id="j", verdict="failure", finalized=False) is True


class TestReapedThenFinishedWritesNothing:
    """Ratchet 1: a reaped (FAILURE) job finishing late leaves the thread
    alone — no turn, no notice — so the thread cannot claim an answer the
    Report does not have under a FAILURE status."""

    @pytest.mark.asyncio
    async def test_reaped_success_finish_writes_neither_turn_nor_notice(self, db_url):
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        _seed_job(db_url, "job-1", "failure")  # ghost-job reaper got here first
        queue.enqueue(db_url, "job-1", {"input_text": "x"})
        queue.claim_next(db_url, "worker-A", 30, 3)  # still our claim: ownership passes
        store = _make_store(db_url)

        lost = await _lost_claim(db_url, "job-1", "worker-A")
        finalized = await _update_status_if_not_terminal(store, "job-1", JobStatus.SUCCESS, output={"report": "late"})

        assert lost is False
        assert finalized is False  # the SUCCESS site publishes `if finalized`: no thread turn
        assert (
            await _should_write_notice(
                job_store=store, job_id="job-1", verdict=JobStatus.INTERRUPTED.value, finalized=False
            )
            is False
        )

        job = await store.get_job("job-1")
        assert job.status == "failure"
        assert job.output is None  # the late answer persisted nowhere


class TestLoserVsWinnerSingleCoherentArtefact:
    """Ratchet 2: exactly one run publishes — the winner's verdict, report and
    thread agree, the loser leaves no artefact of its own."""

    @pytest.mark.asyncio
    async def test_reclaimed_loser_publishes_nothing_after_winner_success(self, db_url):
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        _seed_job(db_url, "job-1", "running")
        queue.enqueue(db_url, "job-1", {"input_text": "x"})
        queue.claim_next(db_url, "worker-A", 30, 3)
        _age_heartbeat(db_url, "job-1", 120)
        queue.claim_next(db_url, "worker-B", 30, 3)  # worker-A stalled; B reclaims
        store = _make_store(db_url)

        # Winner B: still owner, wins SUCCESS, publishes the single turn.
        assert await _lost_claim(db_url, "job-1", "worker-B") is False
        winner_finalized = await _update_status_if_not_terminal(
            store, "job-1", JobStatus.SUCCESS, output={"report": "winner"}
        )
        assert winner_finalized is True

        # Loser A, aborted late: positive claim loss publishes nothing at all,
        # and even the notice path agrees with the standing SUCCESS verdict.
        assert await _lost_claim(db_url, "job-1", "worker-A") is True
        assert (
            await _should_write_notice(
                job_store=store, job_id="job-1", verdict=JobStatus.INTERRUPTED.value, finalized=False
            )
            is False
        )

        job = await store.get_job("job-1")
        assert job.status == "success"

    @pytest.mark.asyncio
    async def test_user_cancel_still_leaves_its_notice(self, db_url):
        """The other side of the same gate: suppressing the loser must not
        suppress the legitimate cancel notice (empty thread reads as broken)."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        _seed_job(db_url, "job-1", "interrupted")  # cancel route wrote the verdict
        store = _make_store(db_url)

        finalized = await _update_status_if_not_terminal(
            store, "job-1", JobStatus.INTERRUPTED, error="cancelled by user"
        )
        assert finalized is False
        assert (
            await _should_write_notice(
                job_store=store, job_id="job-1", verdict=JobStatus.INTERRUPTED.value, finalized=False
            )
            is True
        )


class TestWorkerPassesClaimOwnership:
    """The DB worker hands its claim id to the run (both execution paths in
    ``submit.py`` carry the matching ``claim_owner`` slot: ``None`` on Dask,
    still ``None`` at submit, the worker's id at replay)."""

    @pytest.mark.asyncio
    async def test_run_claimed_hands_worker_id_to_runner(self, tmp_path, monkeypatch):
        from aiq_api.jobs import worker as worker_mod

        qdb = f"sqlite:///{tmp_path}/worker.db"
        queue.ensure_research_queue_table(qdb)
        try:
            seen: dict = {}

            async def fake_run_agent_job(**kwargs):
                seen.update(kwargs)

            monkeypatch.setattr(worker_mod, "run_agent_job", fake_run_agent_job)
            worker = worker_mod.ResearchWorker()
            worker.db_url = qdb
            worker.worker_id = "worker-A"

            queue.enqueue(qdb, "job-1", {"job_id": "job-1"})
            claim = queue.claim_next(qdb, "worker-A", 30, 3)
            assert claim is not None
            await worker._run_claimed(claim)

            assert seen.get("claim_owner") == "worker-A"
        finally:
            queue._queue_schema_initialized.discard(qdb)
