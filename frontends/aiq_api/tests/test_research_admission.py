"""Admission waits instead of refusing (ADR-0079, ``jobs/submit.py``).

Capacity makes a research job WAIT in the queue; the only 429 left is an
organization's own waiting queue past its bound. The queue is real here (SQLite).
"""

from __future__ import annotations

import pytest

from aiq_agent.common.job_admission import JobAdmissionError
from aiq_api.jobs import queue
from aiq_api.jobs import submit


@pytest.fixture
def db_url(tmp_path):
    url = f"sqlite:///{tmp_path}/jobs.db"
    queue.ensure_research_queue_table(url)
    yield url
    queue._queues.pop(url, None)


def _fill(db_url: str, organization_id: str, jobs: int) -> None:
    for n in range(jobs):
        queue.enqueue(db_url, f"{organization_id}-{n}", {"input_text": "x"}, organization_id, "bulk")


async def test_scheduled_work_piling_up_in_one_organization_is_still_admitted_below_the_bound(db_url, monkeypatch):
    monkeypatch.setenv("GRID_MAX_QUEUED_JOBS_PER_ORG", "5")
    _fill(db_url, "org-a", 4)

    await submit._enforce_job_admission(db_url, "org-a")


async def test_an_organization_past_its_waiting_bound_is_refused_and_nobody_else_is(db_url, monkeypatch):
    monkeypatch.setenv("GRID_MAX_QUEUED_JOBS_PER_ORG", "3")
    _fill(db_url, "org-a", 3)

    with pytest.raises(JobAdmissionError, match="3 research jobs waiting"):
        await submit._enforce_job_admission(db_url, "org-a")
    await submit._enforce_job_admission(db_url, "org-b")  # another office's queue is its own


async def test_running_jobs_do_not_count_against_the_waiting_bound(db_url, monkeypatch):
    monkeypatch.setenv("GRID_MAX_QUEUED_JOBS_PER_ORG", "2")
    _fill(db_url, "org-a", 2)
    queue.claim_next(db_url, "w1", 30, 3)  # one starts: one waits

    await submit._enforce_job_admission(db_url, "org-a")


async def test_the_waiting_bound_can_be_switched_off(db_url, monkeypatch):
    monkeypatch.setenv("GRID_MAX_QUEUED_JOBS_PER_ORG", "0")
    _fill(db_url, "org-a", 60)

    await submit._enforce_job_admission(db_url, "org-a")


async def test_a_queue_that_cannot_be_read_admits_the_job(monkeypatch):
    def broken(*_args):
        raise RuntimeError("database away")

    monkeypatch.setattr(queue, "queued_in_lane", broken)

    await submit._enforce_job_admission("sqlite:///unused.db", "org-a")  # fails open


async def test_an_unknown_priority_is_refused_before_anything_is_persisted():
    with pytest.raises(ValueError, match="unknown priority 'later'"):
        await submit.submit_agent_job("deep_researcher", "question", "reader@example.test", priority="later")


def test_the_per_organization_cap_is_one_name_read_in_one_place(monkeypatch):
    monkeypatch.setenv("GRID_MAX_ACTIVE_JOBS_PER_ORG", "7")
    assert queue.max_active_per_org() == 7
    monkeypatch.setenv("GRID_MAX_ACTIVE_JOBS_PER_ORG", "not a number")
    assert queue.max_active_per_org() == 3
    monkeypatch.delenv("GRID_MAX_ACTIVE_JOBS_PER_ORG")
    assert queue.max_active_per_org() == 3
