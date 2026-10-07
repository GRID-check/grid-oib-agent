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

from aiq_agent.common import claim_queue
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


def _enqueue(job_id: str, org: str | None, at: str, priority: str | None = None) -> None:
    ingest_queue.enqueue(job_id, org, f"payload-{job_id}", priority)
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
    assert ingest_queue.counts()["queued"] == 0
    ingest_queue.mark_done("a0", "w1")
    assert ingest_queue.heartbeat("a0", "w1") is False


def test_depth_counts_the_waiting_jobs(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:01")
    ingest_queue.claim_next("w1", **CLAIM)

    assert ingest_queue.counts()["queued"] == 1


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
        assert ingest_queue.QUEUE._release_over_cap(conn, db, row, {"cap": 1, "stale": 180, "worker": "w2"}) is True
        kept = conn.execute(
            text("SELECT job_id, lane, payload, attempts, claimed_at FROM ingest_job_queue WHERE job_id = 'a0'")
        ).first()
        assert ingest_queue.QUEUE._release_over_cap(conn, db, kept, {"cap": 1, "stale": 180, "worker": "w1"}) is False

    assert ingest_queue.counts()["queued"] == 1  # a1 is waiting again
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


# ------------------------------------------------------------------ priority


def test_an_offices_upload_goes_before_its_own_older_bulk_job(db):
    _enqueue("bulk0", "org-a", "2026-09-30 10:00:00", priority="bulk")
    _enqueue("bulk1", "org-a", "2026-09-30 10:00:01", priority="bulk")
    _enqueue("upload", "org-a", "2026-09-30 10:00:09")

    claimed = [ingest_queue.claim_next(f"w{i}", **CLAIM).job_id for i in range(3)]

    assert claimed == ["upload", "bulk0", "bulk1"]


def test_priority_does_not_let_one_office_pass_another(db):
    """The lane order decides between offices: a bulk job of an idle office beats an interactive one of a busy one."""
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:01")
    _enqueue("b-bulk", "org-b", "2026-09-30 10:00:02", priority="bulk")
    first = ingest_queue.claim_next("w1", **CLAIM)

    second = ingest_queue.claim_next("w2", **CLAIM)

    assert (first.job_id, second.job_id) == ("a0", "b-bulk")
    assert second.priority == claim_queue.PRIORITY_BULK


def test_a_claim_reports_the_priority_the_job_was_queued_with(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")

    assert ingest_queue.claim_next("w1", **CLAIM).priority == claim_queue.PRIORITY_INTERACTIVE


def test_an_unknown_priority_is_refused_and_nothing_is_stored(db):
    with pytest.raises(ValueError, match="unknown priority"):
        ingest_queue.enqueue("a0", "org-a", "p", priority="urgent")

    assert ingest_queue.counts() == {"queued": 0, "claimed": 0, "dead": 0}


def test_the_jobs_ahead_follow_the_claim_order_inside_the_office(db):
    _enqueue("bulk0", "org-a", "2026-09-30 10:00:00", priority="bulk")
    _enqueue("bulk1", "org-a", "2026-09-30 10:00:01", priority="bulk")
    _enqueue("upload", "org-a", "2026-09-30 10:00:09")

    assert ingest_queue.ahead_in_lane(["bulk0", "bulk1", "upload"]) == {"upload": 0, "bulk0": 1, "bulk1": 2}


# ------------------------------------------------------------------ release


def test_a_released_claim_goes_back_without_costing_an_attempt(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    claim = ingest_queue.claim_next("w1", **CLAIM)
    assert claim.attempts == 1

    assert ingest_queue.release_claims(["a0"], "w1") == 1

    assert ingest_queue.counts() == {"queued": 1, "claimed": 0, "dead": 0}
    again = ingest_queue.claim_next("w2", **CLAIM)
    assert (again.job_id, again.attempts) == ("a0", 1)


def test_a_release_keeps_the_jobs_place_in_line(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:01")
    ingest_queue.claim_next("w1", **CLAIM)

    ingest_queue.release_claims(["a0"], "w1")

    assert ingest_queue.claim_next("w2", **CLAIM).job_id == "a0"


def test_a_worker_cannot_release_a_claim_that_is_not_its_own(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    ingest_queue.claim_next("w1", **CLAIM)

    assert ingest_queue.release_claims(["a0"], "w2") == 0
    assert ingest_queue.release_claims([], "w1") == 0

    assert ingest_queue.counts()["claimed"] == 1


def test_releasing_an_already_queued_job_changes_nothing(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")

    assert ingest_queue.release_claims(["a0"], "w1") == 0


# --------------------------------------------------------------------- dead


def _exhaust(db, job_id: str) -> None:
    for attempt in range(1, 4):
        assert ingest_queue.claim_next(f"w{attempt}", **CLAIM).job_id == job_id
        _age_heartbeat(db, job_id)


def _row(db, job_id: str):
    with _engine(db).connect() as conn:
        return conn.execute(
            text("SELECT status, dead_reason, payload FROM ingest_job_queue WHERE job_id = :id"), {"id": job_id}
        ).first()


def test_a_job_that_exhausted_its_claims_is_kept_dead_with_its_reason(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _exhaust(db, "a0")

    assert ingest_queue.reap_exhausted(**CLAIM) == ["a0"]

    status, reason, payload = _row(db, "a0")
    assert (status, reason) == ("dead", "attempts_exhausted")
    assert payload == ""  # the presigned URLs do not outlive the job
    assert ingest_queue.counts() == {"queued": 0, "claimed": 0, "dead": 1}
    assert ingest_queue.reap_exhausted(**CLAIM) == []  # a dead row is reaped once


def test_a_dead_row_is_never_claimed_counted_ahead_or_held_against_a_lane(db):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:05")
    _exhaust(db, "a0")
    ingest_queue.reap_exhausted(**CLAIM)

    assert ingest_queue.ahead_in_lane(["a0", "a1"]) == {"a1": 0}
    assert ingest_queue.claim_next("w9", per_lane_cap=1, **CLAIM).job_id == "a1"
    assert ingest_queue.claim_next("w10", **CLAIM) is None


def test_a_dead_row_no_longer_holds_its_status_so_the_job_settles_as_interrupted(db):
    status = IngestionJobStatus(
        job_id="a0",
        status=JobState.PENDING,
        submitted_at=datetime(2026, 9, 30, 10, 0, 0),
        total_files=1,
        collection_name="proj_1",
        backend="llamaindex",
    )
    ingest_status_store.put(status)
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _exhaust(db, "a0")
    with _engine(db).begin() as conn:
        conn.execute(text("UPDATE ingest_jobs SET heartbeat_at = '2000-01-01 00:00:00'"))
    ingest_queue.reap_exhausted(**CLAIM)

    assert ingest_status_store.get("a0").status == JobState.FAILED


def test_mark_dead_retires_a_job_once_and_keeps_the_row(db):
    ingest_queue.enqueue("a0", "org-a", "secret")

    assert ingest_queue.mark_dead("a0", "unreadable_payload") is True
    assert ingest_queue.mark_dead("a0", "again") is False

    assert _row(db, "a0") == ("dead", "unreadable_payload", "")
    assert ingest_queue.claim_next("w1", **CLAIM) is None


def test_old_dead_rows_are_purged_and_fresh_ones_kept(db):
    for job_id in ("old", "fresh"):
        ingest_queue.enqueue(job_id, "org-a", "p")
        ingest_queue.mark_dead(job_id, "unreadable_payload")
    with _engine(db).begin() as conn:
        conn.execute(text("UPDATE ingest_job_queue SET dead_at = '2000-01-01 00:00:00' WHERE job_id = 'old'"))

    assert ingest_queue.purge_dead(older_than_seconds=86400) == 1

    assert _row(db, "old") is None
    assert _row(db, "fresh") is not None


# ------------------------------------------------------------------ upgrade

_ORIGINAL_TABLE = """
CREATE TABLE ingest_job_queue (
  job_id VARCHAR PRIMARY KEY, lane VARCHAR NOT NULL, payload TEXT NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'queued', claimed_by VARCHAR, claimed_at {ts}, heartbeat_at {ts},
  attempts INTEGER NOT NULL DEFAULT 0, created_at {ts} DEFAULT {now}
)
"""


def _indexes(db) -> set[str]:
    from sqlalchemy import inspect

    with _engine(db).connect() as conn:
        return {index["name"] for index in inspect(conn).get_indexes("ingest_job_queue")}


def test_a_table_from_before_priority_and_dead_rows_is_upgraded_in_place(db):
    postgres = db.startswith("postgres")
    ts, now = ("TIMESTAMP WITH TIME ZONE", "NOW()") if postgres else ("DATETIME", "CURRENT_TIMESTAMP")
    with _engine(db).begin() as conn:
        conn.execute(text(_ORIGINAL_TABLE.format(ts=ts, now=now)))
        conn.execute(text("CREATE INDEX ix_ingest_job_queue_lane_created ON ingest_job_queue (lane, created_at)"))
        conn.execute(text("INSERT INTO ingest_job_queue (job_id, lane, payload) VALUES ('old', 'org-a', 'p')"))
    ingest_queue._initialized.discard(db)

    ingest_queue.ensure_table(db)
    ingest_queue._initialized.discard(db)
    ingest_queue.ensure_table(db)  # and again: an upgrade is idempotent

    indexes = _indexes(db)
    assert "ix_ingest_job_queue_lane_priority_created" in indexes
    assert "ix_ingest_job_queue_lane_created" not in indexes
    claim = ingest_queue.claim_next("w1", **CLAIM)
    assert (claim.job_id, claim.priority) == ("old", claim_queue.PRIORITY_INTERACTIVE)
    ingest_queue.enqueue("new", "org-a", "p", priority="bulk")
    assert ingest_queue.counts() == {"queued": 1, "claimed": 1, "dead": 0}


# ------------------------------------------------------------------- meters


@pytest.fixture
def readings(monkeypatch):
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import InMemoryMetricReader

    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    monkeypatch.setattr(claim_queue, "_instruments", claim_queue._Instruments(provider.get_meter("test")))

    def read() -> dict[str, list]:
        collected: dict[str, list] = {}
        data = reader.get_metrics_data()
        for resource in data.resource_metrics if data else []:
            for scope in resource.scope_metrics:
                for metric in scope.metrics:
                    collected[metric.name] = list(metric.data.data_points)
        return collected

    yield read
    provider.shutdown()


def _by_attributes(points: list, **wanted) -> list:
    return [p for p in points if all(p.attributes.get(k) == v for k, v in wanted.items())]


def test_depth_and_oldest_age_are_observed_per_status(db, readings):
    ingest_queue.QUEUE.observe()
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _enqueue("a1", "org-a", "2026-09-30 10:00:01")
    ingest_queue.claim_next("w1", **CLAIM)

    metrics_now = readings()

    depth = metrics_now["grid.queue.depth"]
    assert _by_attributes(depth, queue="ingest", status="queued")[0].value == 1
    assert _by_attributes(depth, queue="ingest", status="claimed")[0].value == 1
    assert _by_attributes(depth, queue="ingest", status="dead")[0].value == 0
    assert metrics_now["grid.queue.oldest_age_seconds"][0].value > 0


def test_claims_and_dead_jobs_are_counted(db, readings):
    _enqueue("a0", "org-a", "2026-09-30 10:00:00")
    _exhaust(db, "a0")
    ingest_queue.reap_exhausted(**CLAIM)
    ingest_queue.QUEUE.record_duration(2.5, "ingest")

    metrics_now = readings()

    assert metrics_now["grid.queue.dead_total"][0].value == 1
    assert metrics_now["grid.queue.claim_latency_ms"][0].count == 3
    duration = metrics_now["grid.queue.job_duration_seconds"][0]
    assert (duration.attributes["kind"], duration.sum) == ("ingest", 2.5)
