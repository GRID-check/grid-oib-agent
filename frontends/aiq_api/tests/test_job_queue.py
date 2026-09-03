"""Tests for the DB-claimed research-job queue (ADR-0021, jobs/queue.py).

Exercises the claim state machine on SQLite: enqueue → claim → heartbeat →
done, plus stale reclaim, retry exhaustion, cancellation, and payload fidelity.
Cross-worker claim exclusivity in production rests on Postgres
``FOR UPDATE SKIP LOCKED`` (the proven purger pattern); here we pin the
transitions a single claimer must honor.
"""

from __future__ import annotations

import base64
import json
import os

import pytest
from sqlalchemy import text

from aiq_api.jobs import payload_crypto
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


def test_mark_done_removes_row(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    queue.claim_next(db_url, "worker-A", 30, 3)
    queue.mark_done(db_url, "job-1")  # cancel-route path: unconditional
    with queue._connection(db_url) as conn:
        remaining = conn.execute(text("SELECT count(*) FROM research_job_queue")).scalar()
    assert remaining == 0


def test_mark_done_ownership_guard(db_url):
    # A stalled worker that lost its claim must NOT delete the new owner's row.
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    queue.claim_next(db_url, "worker-A", 30, 3)
    _age_heartbeat(db_url, "job-1", 120)
    queue.claim_next(db_url, "worker-B", 30, 3)  # B now owns it

    queue.mark_done(db_url, "job-1", worker_id="worker-A")  # stale A returns
    with queue._connection(db_url) as conn:
        remaining = conn.execute(text("SELECT count(*) FROM research_job_queue")).scalar()
    assert remaining == 1  # B's live row preserved

    queue.mark_done(db_url, "job-1", worker_id="worker-B")  # real owner finishes
    with queue._connection(db_url) as conn:
        remaining = conn.execute(text("SELECT count(*) FROM research_job_queue")).scalar()
    assert remaining == 0


def test_reap_exhausted_deletes_rows(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"})
    for _ in range(3):
        queue.claim_next(db_url, "w", 30, 3)
        _age_heartbeat(db_url, "job-1", 120)
    assert queue.reap_exhausted(db_url, 30, 3) == ["job-1"]
    with queue._connection(db_url) as conn:
        remaining = conn.execute(text("SELECT count(*) FROM research_job_queue")).scalar()
    assert remaining == 0  # exhausted rows are removed, not left as 'failed'


def test_forged_plaintext_row_quarantined_with_kek(db_url, monkeypatch):
    """A DB-write attacker inserts a plaintext row with a forged auth token /
    usage context directly, bypassing serialize. With a KEK set the claim must
    quarantine the row (never raise, never hand a payload dict to
    run_agent_job) so the worker loop survives and the forgery never executes."""
    forged = {
        "auth_token": "attacker-forged-token",
        "usage_context": {"organization_id": "victim-org"},
        "input_text": "x",
    }
    # Attacker writes dev-format plaintext straight into the table.
    stored = "json:" + base64.b64encode(json.dumps(forged).encode()).decode()
    monkeypatch.setenv("GRID_JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(32)).decode())
    with queue._connection(db_url) as conn:
        conn.execute(
            text("INSERT INTO research_job_queue (job_id, payload, status, attempts) VALUES (:j, :p, 'queued', 0)"),
            {"j": "forged-1", "p": stored},
        )
        conn.commit()
    claim = queue.claim_next(db_url, "worker-A", stale_seconds=30, max_attempts=3)
    assert claim is not None
    assert claim["job_id"] == "forged-1"
    assert claim.get(queue.POISON_CLAIM_MARKER) is True
    assert "payload" not in claim  # nothing executable ever leaves the queue
    with queue._connection(db_url) as conn:
        remaining = conn.execute(text("SELECT count(*) FROM research_job_queue")).scalar()
    assert remaining == 0  # quarantined, never CLAIMED
    # A second claim never sees the poison again — no crash loop.
    assert queue.claim_next(db_url, "worker-A", stale_seconds=30, max_attempts=3) is None


def test_corrupt_enc_blob_quarantined_and_healthy_claimed_next(db_url, monkeypatch):
    """Ratchet for backlog item 4: a corrupt ``enc:`` blob (torn write, KEK
    rotation, tampered tag) is quarantined on first claim — no raise, so the
    worker loop stays alive — and the very next claim already returns the
    healthy row behind it."""
    monkeypatch.setenv("GRID_JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(32)).decode())
    corrupt = "enc:" + base64.b64encode(b"truncated-ciphertext").decode()
    with queue._connection(db_url) as conn:
        conn.execute(
            text("INSERT INTO research_job_queue (job_id, payload, status, attempts) VALUES (:j, :p, 'queued', 0)"),
            {"j": "poison-1", "p": corrupt},
        )
        conn.commit()
    healthy = {"input_text": "healthy"}
    queue.enqueue(db_url, "healthy-1", healthy)

    first = queue.claim_next(db_url, "worker-A", stale_seconds=30, max_attempts=3)
    assert first is not None and first["job_id"] == "poison-1"
    assert first.get(queue.POISON_CLAIM_MARKER) is True
    assert "payload" not in first

    second = queue.claim_next(db_url, "worker-A", stale_seconds=30, max_attempts=3)
    assert second is not None
    assert second["job_id"] == "healthy-1"
    assert second["payload"] == healthy
    assert second["attempts"] == 1

    with queue._connection(db_url) as conn:
        remaining = conn.execute(text("SELECT job_id FROM research_job_queue")).scalars().all()
    assert "poison-1" not in remaining  # quarantined row is gone for good


def test_worker_poll_loop_survives_poison_claim(monkeypatch, tmp_path):
    """A poison claim (plaintext rejected under KEK, corrupt row, DB blip) must
    not kill the worker process — otherwise one forged row DoSes every replica
    into a crash loop. The poll tick is skipped; the row ages out via
    reclaim/reap."""
    import asyncio

    from aiq_api.jobs import worker as worker_mod

    db_url = f"sqlite:///{tmp_path}/jobs.db"
    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", db_url)
    monkeypatch.setenv("GRID_WORKER_LIVENESS_FILE", str(tmp_path / "alive"))

    def _poison(db_url_, worker_id_, stale_seconds_, max_attempts_):
        raise payload_crypto.PayloadKeyError("payload is not encrypted but GRID_JOB_PAYLOAD_KEK is set")

    monkeypatch.setattr(worker_mod.queue, "claim_next", _poison)
    w = worker_mod.ResearchWorker()
    w.poll_seconds = 0.01

    async def _main():
        stopper = asyncio.get_running_loop().call_later(0.05, w.request_stop)
        await w.run()
        stopper.cancel()

    asyncio.run(_main())  # must return, not raise


@pytest.mark.asyncio
async def test_worker_quarantines_poison_and_runs_healthy(monkeypatch, tmp_path):
    """Worker-level ratchet for backlog item 4: with a corrupt ``enc:`` blob at
    the head of the queue, the worker stays alive, quarantines the poison row
    to FAILURE (job_info + job.error event), and still runs the healthy row
    behind it — all without a single raise out of ``claim_next``."""
    import asyncio
    from datetime import UTC
    from datetime import datetime

    from aiq_api.jobs import worker as worker_mod
    from aiq_api.jobs.event_store import EventStore
    from nat.front_ends.fastapi.async_jobs.job_store import JobStore

    db_url = f"sqlite:///{tmp_path}/jobs.db"
    async_db_url = f"sqlite+aiosqlite:///{tmp_path}/jobs.db"
    queue.ensure_research_queue_table(db_url)
    monkeypatch.setenv("GRID_JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(32)).decode())

    corrupt = "enc:" + base64.b64encode(b"truncated-ciphertext").decode()
    with queue._connection(db_url) as conn:
        conn.execute(
            text("INSERT INTO research_job_queue (job_id, payload, status, attempts) VALUES (:j, :p, 'queued', 0)"),
            {"j": "poison-1", "p": corrupt},
        )
        conn.commit()
    queue.enqueue(db_url, "healthy-1", {"input_text": "healthy"})

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
        ts = datetime.now(UTC).replace(tzinfo=None)
        for job_id in ("poison-1", "healthy-1"):
            conn.execute(
                text(
                    "INSERT OR REPLACE INTO job_info "
                    "(job_id, status, created_at, updated_at, expiry_seconds, is_expired) "
                    "VALUES (:job_id, 'submitted', :ts, :ts, 3600, 0)"
                ),
                {"job_id": job_id, "ts": ts},
            )
        conn.commit()

    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", async_db_url)
    monkeypatch.setenv("GRID_WORKER_LIVENESS_FILE", str(tmp_path / "alive"))
    monkeypatch.delenv("AIQ_DEEP_CHECKPOINT_DB", raising=False)

    ran: list[dict] = []

    async def _fake_run(**kwargs):
        ran.append(kwargs)

    monkeypatch.setattr(worker_mod, "run_agent_job", _fake_run)
    w = worker_mod.ResearchWorker()
    w.poll_seconds = 0.01

    async def _main():
        task = asyncio.create_task(w.run())
        store = JobStore(scheduler_address="", db_url=async_db_url)
        poison_failed = False
        for _ in range(500):  # ~10 s budget; stops as soon as both outcomes land
            await asyncio.sleep(0.02)
            poison = await store.get_job("poison-1")
            poison_failed = poison is not None and poison.status == "failure"
            if ran and poison_failed:
                break
        w.request_stop()
        await asyncio.wait_for(task, timeout=15)
        return poison_failed

    poison_failed = await _main()  # returns, never raises: the worker survived
    queue._queue_schema_initialized.discard(db_url)

    assert poison_failed, "poison row was never quarantined to FAILURE"
    assert [c.get("input_text") for c in ran] == ["healthy"], f"healthy row not processed exactly once: {ran}"

    store = JobStore(scheduler_address="", db_url=async_db_url)
    poison = await store.get_job("poison-1")
    assert poison is not None and poison.status == "failure"
    assert poison.error == worker_mod.POISON_PAYLOAD_ERROR

    with engine.connect() as conn:
        events = conn.execute(
            text("SELECT event_type, event_data FROM job_events WHERE job_id = :job_id"),
            {"job_id": "poison-1"},
        ).all()
    assert any(t == "job.error" and worker_mod.POISON_PAYLOAD_ERROR in (d or "") for t, d in events)

    with queue._connection(db_url) as conn:
        remaining = conn.execute(text("SELECT job_id FROM research_job_queue")).scalars().all()
    assert remaining == [], f"queue not drained: {remaining}"


def test_reap_exhausted_leader_lock_id_is_distinct():
    """The worker reap lock must not collide with the web-tier reaper/cleanup or
    checkpoint locks — a shared id would make two unrelated reapers mutually
    exclude each other across replicas."""
    from aiq_api.jobs.checkpoint_retention import _PG_CHECKPOINT_LOCK_ID
    from aiq_api.routes.jobs import _PG_ADVISORY_LOCK_ID
    from aiq_api.routes.jobs import _PG_REAPER_LOCK_ID

    others = {_PG_ADVISORY_LOCK_ID, _PG_REAPER_LOCK_ID, _PG_CHECKPOINT_LOCK_ID}
    assert queue._PG_REAP_EXHAUSTED_LOCK_ID not in others
