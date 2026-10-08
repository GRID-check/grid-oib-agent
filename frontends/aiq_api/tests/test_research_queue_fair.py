"""What the claim substrate gives the research queue (ADR-0079).

``test_job_queue.py`` pins the state machine of one job. These pin what changed
when research moved off FIFO: fairness across organizations, priority inside one,
the per-organization cap that makes a job wait instead of fail, release on drain
that spends no attempt, dead rows, the in-place upgrade of the table that is
already in production, and the meters. The substrate's own scenarios, on both
databases, are ``tests/aiq_agent/common/test_claim_queue.py``.
"""

from __future__ import annotations

import asyncio
import os

import pytest
from sqlalchemy import text

from aiq_agent.common import claim_queue
from aiq_api.jobs import payload_crypto
from aiq_api.jobs import queue
from aiq_api.jobs.runner import _lost_claim

_POSTGRES = os.environ.get("AIQ_TEST_POSTGRES_URL")


@pytest.fixture(
    params=[
        "sqlite",
        pytest.param("postgres", marks=pytest.mark.skipif(not _POSTGRES, reason="AIQ_TEST_POSTGRES_URL not set")),
    ]
)
def db_url(request, tmp_path):
    """The claim runs the same scenarios on SQLite and, where one is given, on Postgres (its real SQL)."""
    url = f"sqlite:///{tmp_path}/jobs.db" if request.param == "sqlite" else _POSTGRES
    if request.param == "postgres":
        with queue._connection(url) as conn:
            for table in (queue.TABLE, queue.TURNS_TABLE):
                conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
            conn.commit()
        queue._queues.pop(url, None)
    queue.ensure_research_queue_table(url)
    yield url
    queue._queues.pop(url, None)


def _claim(db_url: str, n: int, **kwargs) -> list[dict]:
    """``n`` claims by ``n`` different workers, in order."""
    return [queue.claim_next(db_url, f"w{i}", 30, 3, **kwargs) for i in range(n)]


def test_one_organizations_backlog_does_not_make_another_wait_behind_it(db_url):
    for n in range(4):
        queue.enqueue(db_url, f"a{n}", {"input_text": "sweep"}, "org-a", "bulk")
    queue.enqueue(db_url, "b0", {"input_text": "my question"}, "org-b")

    order = [c["job_id"] for c in _claim(db_url, 2)]

    # b0 was enqueued LAST, behind four jobs of another organization, and is among the first two to start.
    assert "b0" in order


def test_lanes_alternate_while_both_have_work(db_url):
    for n in range(3):
        queue.enqueue(db_url, f"a{n}", {"input_text": "x"}, "org-a")
        queue.enqueue(db_url, f"b{n}", {"input_text": "x"}, "org-b")

    lanes = [c["lane"] for c in _claim(db_url, 6)]

    assert sorted(lanes) == ["org-a"] * 3 + ["org-b"] * 3
    assert all(lanes[i] != lanes[i + 1] for i in range(5))


def test_interactive_goes_before_bulk_inside_an_organization_and_never_before_another(db_url):
    queue.enqueue(db_url, "a-scheduled", {"input_text": "x"}, "org-a", "bulk")
    queue.enqueue(db_url, "a-asked", {"input_text": "x"}, "org-a", "interactive")
    queue.enqueue(db_url, "b-scheduled", {"input_text": "x"}, "org-b", "bulk")

    order = [c["job_id"] for c in _claim(db_url, 3)]

    # Inside org-a the question beats the sweep; org-b's bulk job is not behind org-a's interactive one.
    assert order.index("a-asked") < order.index("a-scheduled")
    assert order.index("b-scheduled") < order.index("a-scheduled")


def test_a_claim_says_which_lane_and_priority_it_came_from(db_url):
    queue.enqueue(db_url, "a0", {"input_text": "x"}, "org-a", "bulk")

    claim = queue.claim_next(db_url, "w1", 30, 3)

    assert (claim["lane"], claim["priority"]) == ("org-a", claim_queue.PRIORITY_BULK)


def test_an_unknown_priority_is_refused_where_it_enters(db_url):
    with pytest.raises(ValueError, match="unknown priority"):
        queue.enqueue(db_url, "job-1", {"input_text": "x"}, "org-a", "urgent")
    assert queue.counts(db_url)["queued"] == 0


def test_the_per_organization_cap_makes_the_next_job_wait_not_fail(db_url):
    queue.enqueue(db_url, "a0", {"input_text": "x"}, "org-a")
    queue.enqueue(db_url, "a1", {"input_text": "x"}, "org-a")
    queue.enqueue(db_url, "b0", {"input_text": "x"}, "org-b")

    first, second, third = _claim(db_url, 3, per_lane_cap=1)

    assert {first["lane"], second["lane"]} == {"org-a", "org-b"}
    assert third is None  # org-a is at its cap: a1 waits, and is still in the queue
    assert queue.counts(db_url) == {"queued": 1, "claimed": 2, "dead": 0}

    org_a_running = first if first["lane"] == "org-a" else second
    queue.mark_done(db_url, org_a_running["job_id"], "w0" if first is org_a_running else "w1")
    assert queue.claim_next(db_url, "w3", 30, 3, per_lane_cap=1)["job_id"] == "a1"


def test_a_drained_workers_claim_goes_back_without_spending_an_attempt(db_url):
    queue.enqueue(db_url, "job-1", {"input_text": "x"}, "org-a")
    assert queue.claim_next(db_url, "worker-A", 30, 3)["attempts"] == 1

    assert queue.release_claims(db_url, ["job-1"], "worker-B") == 0  # not B's claim: left alone
    assert queue.release_claims(db_url, ["job-1"], "worker-A") == 1

    again = queue.claim_next(db_url, "worker-B", 30, 3)
    assert again["job_id"] == "job-1"
    assert again["attempts"] == 1  # the drain cost the job nothing
    assert queue.claim_state(db_url, "job-1") == (queue.CLAIMED, "worker-B")


def test_a_released_job_reads_as_a_lost_claim_to_the_run_that_still_holds_it(db_url):
    """The runner stops publishing when its row is QUEUED again: that is how a drain
    gives a job away without the aborted run writing INTERRUPTED beside the next one."""
    queue.enqueue(db_url, "job-1", {"input_text": "x"}, "org-a")
    queue.claim_next(db_url, "worker-A", 30, 3)
    assert asyncio.run(_lost_claim(db_url, "job-1", "worker-A")) is False

    queue.release_claims(db_url, ["job-1"], "worker-A")

    assert queue.claim_state(db_url, "job-1") == (queue.QUEUED, None)
    assert asyncio.run(_lost_claim(db_url, "job-1", "worker-A")) is True


def test_waiting_jobs_are_counted_per_organization(db_url):
    queue.enqueue(db_url, "a0", {"input_text": "x"}, "org-a")
    queue.enqueue(db_url, "a1", {"input_text": "x"}, "org-a")
    queue.enqueue(db_url, "b0", {"input_text": "x"}, "org-b")
    queue.claim_next(db_url, "w1", 30, 3)  # one of them runs now: it is not waiting

    assert queue.queued_in_lane(db_url, "org-a") + queue.queued_in_lane(db_url, "org-b") == 2
    assert queue.queued_in_lane(db_url, "org-nobody") == 0
    assert queue.queued_in_lane(db_url, None) == 0


_PRE_LANE_TABLE = (
    "CREATE TABLE research_job_queue ("
    "  job_id VARCHAR PRIMARY KEY, payload TEXT NOT NULL, status VARCHAR NOT NULL DEFAULT 'queued',"
    "  claimed_by VARCHAR, claimed_at DATETIME, heartbeat_at DATETIME,"
    "  attempts INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
)


def test_a_table_from_before_lanes_is_upgraded_in_place_and_its_rows_still_run(tmp_path):
    """The table that is already in production: no lane, no priority, no dead rows."""
    url = f"sqlite:///{tmp_path}/old.db"
    with queue._connection(url) as conn:
        conn.execute(text(_PRE_LANE_TABLE))
        conn.execute(
            text("INSERT INTO research_job_queue (job_id, payload) VALUES ('old-1', :p)"),
            {"p": payload_crypto.serialize({"input_text": "written yesterday"})},
        )
        conn.commit()

    queue.ensure_research_queue_table(url)
    queue._queues.pop(url, None)
    queue.ensure_research_queue_table(url)  # an upgrade is idempotent

    claimed = queue.claim_next(url, "w1", 30, 3)
    assert claimed["job_id"] == "old-1"
    assert claimed["payload"] == {"input_text": "written yesterday"}
    assert claimed["lane"] == ""  # no organization is known for it: a lane of its own
    # A replica still on the old code inserts no lane, and must still be able to enqueue.
    with queue._connection(url) as conn:
        conn.execute(text("INSERT INTO research_job_queue (job_id, payload) VALUES ('old-2', :p)"), {"p": "{}"})
        conn.commit()
    assert queue.counts(url)["queued"] == 1
    queue._queues.pop(url, None)


def test_the_queue_reports_under_its_own_name(db_url, monkeypatch):
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import InMemoryMetricReader

    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    monkeypatch.setattr(claim_queue, "_instruments", claim_queue._Instruments(provider.get_meter("test")))
    queue.queue_for(db_url).observe()
    queue.enqueue(db_url, "job-1", {"input_text": "x"}, "org-a")
    queue.enqueue(db_url, "job-2", {"input_text": "x"}, "org-a")
    queue.claim_next(db_url, "w1", 30, 3)
    queue.queue_for(db_url).record_duration(12.0, "deep_researcher")

    points = {
        metric.name: list(metric.data.data_points)
        for resource in reader.get_metrics_data().resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
    }
    provider.shutdown()

    depth = {p.attributes["status"]: p.value for p in points["grid.queue.depth"] if p.attributes["queue"] == "research"}
    assert depth == {"queued": 1, "claimed": 1, "dead": 0}
    assert points["grid.queue.claim_latency_ms"][0].attributes == {"queue": "research"}
    assert points["grid.queue.job_duration_seconds"][0].attributes == {"queue": "research", "kind": "deep_researcher"}
