"""The durable ingest queue: claimed fairly across organisations, and never lost.

Runs on SQLite, which ranks in Python what Postgres ranks in the claim query,
and on Postgres too when ``AIQ_TEST_POSTGRES_URL`` names a database this suite
may clear (``postgresql://postgres@127.0.0.1:55432/postgres``): the order is
the contract both implement, and production runs the Postgres one.
"""

from __future__ import annotations

import os
from datetime import datetime

import pytest
from sqlalchemy import text

from aiq_agent.knowledge import ingest_queue
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.ingest_scheduler import PLATFORM_LANE
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState

CLAIM = {"stale_seconds": 180, "max_attempts": 3}


_POSTGRES = os.environ.get("AIQ_TEST_POSTGRES_URL")


@pytest.fixture(
    params=[
        "sqlite",
        pytest.param("postgres", marks=pytest.mark.skipif(not _POSTGRES, reason="AIQ_TEST_POSTGRES_URL not set")),
    ]
)
def db(request, tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/jobs.db" if request.param == "sqlite" else _POSTGRES
    if request.param == "postgres":
        with _engine(url).begin() as conn:
            for table in ("ingest_job_queue", "ingest_lane_turns", "ingest_jobs"):
                conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    yield url
    ingest_queue._initialized.discard(url)
    ingest_status_store._initialized.discard(url)


def _engine(url: str):
    return DocumentMetadataStore._get_or_create_sync_engine(url)


def _enqueue(job_id: str, org: str | None, at: str) -> None:
    ingest_queue.enqueue(job_id, org, f"payload-{job_id}")
    with _engine(ingest_queue.db_url()).begin() as conn:
        conn.execute(text("UPDATE ingest_job_queue SET created_at = :at WHERE job_id = :id"), {"at": at, "id": job_id})


def _age_heartbeat(url: str, job_id: str) -> None:
    with _engine(url).begin() as conn:
        conn.execute(
            text("UPDATE ingest_job_queue SET heartbeat_at = '2000-01-01 00:00:00' WHERE job_id = :id"), {"id": job_id}
        )


def test_nothing_to_claim_is_none(db):
    assert ingest_queue.claim_next("w1", **CLAIM) is None


def test_a_second_office_goes_before_the_first_ones_backlog(db):
    for i in range(5):
        _enqueue(f"a{i}", "org-a", f"2026-09-30 10:00:0{i}")
    _enqueue("b0", "org-b", "2026-09-30 10:05:00")

    first = ingest_queue.claim_next("w1", **CLAIM)
    second = ingest_queue.claim_next("w2", **CLAIM)

    assert (first.job_id, second.job_id) == ("a0", "b0")


def test_the_office_with_fewer_running_jobs_goes_first(db):
    for i in range(3):
        _enqueue(f"a{i}", "org-a", f"2026-09-30 10:00:0{i}")
    _enqueue("b0", "org-b", "2026-09-30 10:00:09")
    _enqueue("b1", "org-b", "2026-09-30 10:00:10")

    claimed = [ingest_queue.claim_next(f"w{i}", **CLAIM).job_id for i in range(4)]

    assert claimed == ["a0", "b0", "a1", "b1"]


def test_backlogs_alternate_when_one_worker_finishes_each(db):
    for i in range(3):
        _enqueue(f"a{i}", "org-a", f"2026-09-30 10:00:0{i}")
    for i in range(3):
        _enqueue(f"b{i}", "org-b", f"2026-09-30 10:01:0{i}")

    order = []
    for _ in range(6):
        claim = ingest_queue.claim_next("w1", **CLAIM)
        order.append(claim.job_id)
        ingest_queue.mark_done(claim.job_id, "w1")

    assert order == ["a0", "b0", "a1", "b1", "a2", "b2"]


def test_the_cap_holds_an_office_at_its_share(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:01")

    assert ingest_queue.claim_next("w1", per_lane_cap=1, **CLAIM).job_id == "a0"
    assert ingest_queue.claim_next("w2", per_lane_cap=1, **CLAIM) is None


def test_a_job_without_an_office_waits_in_the_platform_lane(db):
    ingest_queue.enqueue("sync", None, "p")

    assert ingest_queue.claim_next("w1", **CLAIM).lane == PLATFORM_LANE


def test_a_dead_workers_claim_is_taken_again_and_then_given_up(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")

    for attempt in range(1, 4):
        claim = ingest_queue.claim_next(f"w{attempt}", **CLAIM)
        assert (claim.job_id, claim.attempts) == ("a0", attempt)
        assert ingest_queue.claim_next("other", **CLAIM) is None
        _age_heartbeat(db, "a0")

    assert ingest_queue.claim_next("w4", **CLAIM) is None
    assert ingest_queue.reap_exhausted(**CLAIM) == ["a0"]


def test_a_heartbeat_keeps_the_claim_and_a_lost_claim_says_so(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    ingest_queue.claim_next("w1", **CLAIM)

    assert ingest_queue.heartbeat("a0", "w1") is True
    assert ingest_queue.heartbeat("a0", "w2") is False
    ingest_queue.mark_done("a0", "w2")
    assert ingest_queue.depth() == 0
    ingest_queue.mark_done("a0", "w1")
    assert ingest_queue.heartbeat("a0", "w1") is False


def test_depth_counts_the_waiting_jobs(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:01")
    ingest_queue.claim_next("w1", **CLAIM)

    assert ingest_queue.depth() == 1


def test_a_waiting_job_counts_only_its_own_offices_jobs_ahead(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:01")
    _enqueue("a2", "org-a", "2026-09-30 10:00:02")
    _enqueue("b0", "org-b", "2026-09-30 09:00:00")
    _enqueue("b1", "org-b", "2026-09-30 11:00:00")
    claimed = ingest_queue.claim_next("w1", **CLAIM)

    ahead = ingest_queue.ahead_in_lane(["a0", "a1", "a2", "b0", "b1", "unknown"])

    # b0 is the oldest job and the first claim takes it: claimed, so no entry.
    assert claimed is not None and claimed.job_id == "b0"
    # org-b's backlog stands between org-a and nothing: a0 is next for org-a.
    assert ahead == {"a0": 0, "a1": 1, "a2": 2, "b1": 0}


def test_no_ids_asks_nothing(db):
    assert ingest_queue.ahead_in_lane([]) == {}


def test_a_queued_job_is_not_settled_as_interrupted_when_its_replica_is_gone(db):
    """The accepting replica wrote PENDING and died; the job still waits in the queue."""
    status = IngestionJobStatus(
        job_id="a0",
        status=JobState.PENDING,
        submitted_at=datetime(2026, 9, 30, 10, 0, 0),
        total_files=1,
        collection_name="proj_1",
        backend="llamaindex",
    )
    ingest_status_store.put(status)
    ingest_queue.enqueue("a0", "org-a", "p")
    with _engine(db).begin() as conn:
        conn.execute(text("UPDATE ingest_jobs SET heartbeat_at = '2000-01-01 00:00:00'"))

    assert ingest_status_store.fail_interrupted() == 0
    assert ingest_status_store.get("a0").status == JobState.PENDING
    assert ingest_status_store.in_flight_files(["proj_1"]) == {"proj_1": []}

    # Gone from the queue (finished elsewhere, or out of attempts): now it can be.
    ingest_queue.mark_done("a0")
    assert ingest_status_store.get("a0").status == JobState.FAILED


def test_racing_workers_never_claim_one_job_twice(db):
    if not db.startswith("postgres"):
        pytest.skip("SQLite backs a single process; SKIP LOCKED is the Postgres guarantee")
    from concurrent.futures import ThreadPoolExecutor

    for i in range(60):
        ingest_queue.enqueue(f"j{i}", f"org-{i % 7}", "p")

    def drain(worker: str) -> list[str]:
        mine = []
        while (claim := ingest_queue.claim_next(worker, **CLAIM)) is not None:
            mine.append(claim.job_id)
        return mine

    with ThreadPoolExecutor(8) as pool:
        claimed = [job for batch in pool.map(drain, [f"w{i}" for i in range(8)]) for job in batch]

    assert sorted(claimed) == sorted(f"j{i}" for i in range(60))


def test_a_claim_that_raced_past_the_cap_puts_its_job_back(db):
    """Two claims that each saw the lane under its cap: the one checked second gives its job back."""
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:01")
    # Both claimed as if racing: neither saw the other when it ranked the lane.
    first = ingest_queue.claim_next("w1", **CLAIM)
    second = ingest_queue.claim_next("w2", **CLAIM)
    assert (first.job_id, second.job_id) == ("a0", "a1")

    with _engine(db).connect() as conn:
        row = conn.execute(
            text("SELECT job_id, lane, payload, attempts, claimed_at FROM ingest_job_queue WHERE job_id = 'a1'")
        ).first()
        assert ingest_queue._release_over_cap(conn, db, row, {"cap": 1, "stale": 180, "worker": "w2"}) is True
        kept = conn.execute(
            text("SELECT job_id, lane, payload, attempts, claimed_at FROM ingest_job_queue WHERE job_id = 'a0'")
        ).first()
        assert ingest_queue._release_over_cap(conn, db, kept, {"cap": 1, "stale": 180, "worker": "w1"}) is False

    assert ingest_queue.depth() == 1  # a1 is waiting again
    again = ingest_queue.claim_next("w3", **CLAIM)
    assert (again.job_id, again.attempts) == ("a1", 1)  # the given-back claim did not cost an attempt


def test_racing_workers_never_exceed_the_cap(db):
    if not db.startswith("postgres"):
        pytest.skip("the race needs Postgres; SQLite backs a single process")
    from concurrent.futures import ThreadPoolExecutor

    for i in range(20):
        ingest_queue.enqueue(f"a{i}", "org-a", "p")

    def grab(worker: str) -> str | None:
        claim = ingest_queue.claim_next(worker, per_lane_cap=2, **CLAIM)
        return claim.job_id if claim else None

    for _ in range(5):
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(grab, [f"w{i}" for i in range(8)]))

    with _engine(db).connect() as conn:
        held = conn.execute(text("SELECT COUNT(*) FROM ingest_job_queue WHERE status = 'claimed'")).scalar()
    assert held == 2
