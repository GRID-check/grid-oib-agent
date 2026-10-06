"""The claim substrate is generic over its table: a second queue is a second table, nothing else.

The ingestion queue's scenarios (fair order, cap, reap, upgrade) are
``tests/knowledge_layer_tests/test_ingest_queue.py``. These pin what the
research queue will rely on when it adopts the substrate: that a queue built
with another table and lane name behaves the same and touches nothing of the
ingestion queue's.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy import text

from aiq_agent.common import claim_queue

CLAIM = {"stale_seconds": 180, "max_attempts": 3}
_POSTGRES = os.environ.get("AIQ_TEST_POSTGRES_URL")
_TABLES = ("research_claims", "research_claim_turns", "other_claims", "other_claim_turns")


@pytest.fixture(
    params=[
        "sqlite",
        pytest.param("postgres", marks=pytest.mark.skipif(not _POSTGRES, reason="AIQ_TEST_POSTGRES_URL not set")),
    ]
)
def url(request, tmp_path):
    url = f"sqlite:///{tmp_path}/queues.db" if request.param == "sqlite" else _POSTGRES
    engine = create_engine(url.replace("postgresql://", "postgresql+psycopg://", 1))
    with engine.begin() as conn:
        for table in _TABLES:
            conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
    yield url
    engine.dispose()


def _queue(url: str, name: str = "research", table: str = "research_claims", turns: str = "research_claim_turns"):
    engines: dict[str, object] = {}

    def engine_for(db_url: str):
        if db_url not in engines:
            engines[db_url] = create_engine(db_url.replace("postgresql://", "postgresql+psycopg://", 1))
        return engines[db_url]

    return claim_queue.ClaimQueue(
        name=name, table=table, turns_table=turns, db_url=lambda: url, engine_for=engine_for, reap_lock_id=0x5253
    )


def test_two_queues_in_one_database_do_not_see_each_others_jobs(url):
    research = _queue(url)
    other = _queue(url, name="other", table="other_claims", turns="other_claim_turns")

    research.enqueue("r0", "org-a", "payload")

    assert other.claim_next("w1", **CLAIM) is None
    assert research.claim_next("w1", **CLAIM).job_id == "r0"
    assert other.counts() == {"queued": 0, "claimed": 0, "dead": 0}
    assert research.counts() == {"queued": 0, "claimed": 1, "dead": 0}


def test_a_queue_keeps_its_own_fairness_and_priority(url):
    queue = _queue(url)
    queue.enqueue("a-bulk", "org-a", "p", "bulk")
    queue.enqueue("a-live", "org-a", "p")
    queue.enqueue("b0", "org-b", "p")

    claimed = [queue.claim_next(f"w{i}", **CLAIM) for i in range(3)]

    # Lanes alternate (fewest running, then longest unserved); inside a lane, interactive first.
    assert [c.lane for c in claimed] == ["org-a", "org-b", "org-a"]
    assert [c.job_id for c in claimed if c.lane == "org-a"] == ["a-live", "a-bulk"]


def test_release_and_dead_rows_work_on_any_table(url):
    queue = _queue(url)
    queue.enqueue("r0", "org-a", "p")
    queue.claim_next("w1", **CLAIM)

    assert queue.release_claims(["r0"], "w1") == 1
    assert queue.claim_next("w2", **CLAIM).attempts == 1

    assert queue.mark_dead("r0", "cancelled") is True
    assert queue.counts() == {"queued": 0, "claimed": 0, "dead": 1}


def test_a_queue_without_a_database_is_inert():
    queue = claim_queue.ClaimQueue(
        name="x", table="x_q", turns_table="x_t", db_url=lambda: None, engine_for=lambda u: None, reap_lock_id=1
    )

    assert queue.claim_next("w1", **CLAIM) is None
    assert queue.counts() == {"queued": 0, "claimed": 0, "dead": 0}
    assert queue.release_claims(["a"], "w1") == 0
    assert queue.reap_exhausted(**CLAIM) == []
    assert queue.ahead_in_lane(["a"]) == {}
    with pytest.raises(RuntimeError, match="no database"):
        queue.enqueue("a", "org", "p")


@pytest.mark.parametrize(("name", "rank"), [(None, 0), ("interactive", 0), ("bulk", 1)])
def test_priority_names_rank_interactive_before_bulk(name, rank):
    assert claim_queue.priority_rank(name) == rank


def test_an_unknown_priority_is_a_value_error():
    with pytest.raises(ValueError, match="unknown priority 'now'"):
        claim_queue.priority_rank("now")
