"""Tests for the DB-claimed research-job queue (ADR-0021, jobs/queue.py).

Exercises the claim state machine on SQLite: enqueue → claim → heartbeat →
done, plus stale reclaim, retry exhaustion, cancellation, and payload fidelity.
Cross-worker claim exclusivity in production rests on Postgres
``FOR UPDATE SKIP LOCKED`` (the proven purger pattern); here we pin the
transitions a single claimer must honor.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from aiq_api.jobs import queue


@pytest.fixture
def db_url(tmp_path):
    url = f"sqlite:///{tmp_path}/jobs.db"
    queue.ensure_research_queue_table(url)
    yield url
    queue._queue_schema_initialized.discard(url)


def _age_heartbeat(db_url: str, job_id: str, seconds_ago: int) -> None:
    with queue._connection(db_url) as conn:
        conn.execute(
            text("UPDATE research_job_queue SET heartbeat_at = datetime('now', :delta) WHERE job_id = :job_id"),
            {"delta": f"-{seconds_ago} seconds", "job_id": job_id},
        )
        conn.commit()


def test_enqueue_and_claim_roundtrip(db_url):
    payload = {"input_text": "hello", "collection_scope": ["a", "b"], "model_overrides": {"x": "y"}}
    queue.enqueue(db_url, "job-1", payload)

    claimed = queue.claim_next(db_url, "worker-A", stale_seconds=30, max_attempts=3)
    assert claimed is not None
    assert claimed["job_id"] == "job-1"
    assert claimed["payload"] == payload  # exact fidelity, incl. nested structures
    assert claimed["attempts"] == 1


def test_claimed_job_not_reclaimed_while_fresh(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    assert queue.claim_next(db_url, "worker-A", 30, 3) is not None
    # Fresh claim: no other worker may take it.
    assert queue.claim_next(db_url, "worker-B", 30, 3) is None


def test_heartbeat_ownership(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    queue.claim_next(db_url, "worker-A", 30, 3)
    assert queue.heartbeat(db_url, "job-1", "worker-A") is True
    assert queue.heartbeat(db_url, "job-1", "worker-B") is False  # not the owner


def test_stale_claim_is_reclaimed(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    queue.claim_next(db_url, "worker-A", 30, 3)  # attempts -> 1
    _age_heartbeat(db_url, "job-1", 120)  # worker-A "crashed"

    reclaimed = queue.claim_next(db_url, "worker-B", stale_seconds=30, max_attempts=3)
    assert reclaimed is not None
    assert reclaimed["attempts"] == 2


def test_retries_exhaust_then_reaped(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    for _ in range(3):  # max_attempts=3 → three claims exhaust it
        assert queue.claim_next(db_url, "w", 30, 3) is not None
        _age_heartbeat(db_url, "job-1", 120)
    # No more reclaims once attempts >= max_attempts.
    assert queue.claim_next(db_url, "w", 30, 3) is None
    reaped = queue.reap_exhausted(db_url, stale_seconds=30, max_attempts=3)
    assert reaped == ["job-1"]


def test_cancel_requested_is_skipped(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    queue.request_cancel(db_url, "job-1")
    assert queue.is_cancel_requested(db_url, "job-1") is True
    assert queue.claim_next(db_url, "worker-A", 30, 3) is None  # never handed out


def test_mark_done_removes_row(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    queue.claim_next(db_url, "worker-A", 30, 3)
    queue.mark_done(db_url, "job-1")
    with queue._connection(db_url) as conn:
        remaining = conn.execute(text("SELECT count(*) FROM research_job_queue")).scalar()
    assert remaining == 0
