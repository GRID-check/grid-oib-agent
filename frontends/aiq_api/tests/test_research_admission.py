"""Admission waits instead of refusing (ADR-0079, ``jobs/submit.py``).

With ``GRID_JOB_EXECUTION=db`` capacity makes a research job WAIT in the queue;
the only 429 left is an organization's own waiting queue past its bound. Dask has
no queue, so its active-job caps still refuse. The queue is real here (SQLite);
what is faked is the count of active jobs, to show the db path never asks it.
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


@pytest.fixture
def active_jobs(monkeypatch):
    """A cluster that reports a given number of active jobs, and counts how often it is asked."""
    state = {"active": 0, "asked": 0}

    def count_active_jobs(_db_url, _terminal, organization_id=None):
        state["asked"] += 1
        return state["active"]

    monkeypatch.setattr(submit, "count_active_jobs", count_active_jobs)
    return state


def _fill(db_url: str, organization_id: str, jobs: int) -> None:
    for n in range(jobs):
        queue.enqueue(db_url, f"{organization_id}-{n}", {"input_text": "x"}, organization_id, "bulk")


async def test_a_full_cluster_makes_a_db_job_wait_instead_of_refusing_it(db_url, active_jobs, monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
    active_jobs["active"] = 10_000  # far past GRID_MAX_ACTIVE_JOBS and the per-organization cap

    await submit._enforce_job_admission(db_url, "org-a")  # admitted: it will wait for a worker

    assert active_jobs["asked"] == 0  # capacity is the claim's business now, not the submit's


async def test_scheduled_work_piling_up_in_one_organization_is_still_admitted_below_the_bound(db_url, monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
    monkeypatch.setenv("GRID_MAX_QUEUED_JOBS_PER_ORG", "5")
    _fill(db_url, "org-a", 4)

    await submit._enforce_job_admission(db_url, "org-a")


async def test_an_organization_past_its_waiting_bound_is_refused_and_nobody_else_is(db_url, monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
    monkeypatch.setenv("GRID_MAX_QUEUED_JOBS_PER_ORG", "3")
    _fill(db_url, "org-a", 3)

    with pytest.raises(JobAdmissionError, match="3 research jobs waiting"):
        await submit._enforce_job_admission(db_url, "org-a")
    await submit._enforce_job_admission(db_url, "org-b")  # another office's queue is its own


async def test_running_jobs_do_not_count_against_the_waiting_bound(db_url, monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
    monkeypatch.setenv("GRID_MAX_QUEUED_JOBS_PER_ORG", "2")
    _fill(db_url, "org-a", 2)
    queue.claim_next(db_url, "w1", 30, 3)  # one starts: one waits

    await submit._enforce_job_admission(db_url, "org-a")


async def test_the_waiting_bound_can_be_switched_off(db_url, monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
    monkeypatch.setenv("GRID_MAX_QUEUED_JOBS_PER_ORG", "0")
    _fill(db_url, "org-a", 60)

    await submit._enforce_job_admission(db_url, "org-a")


async def test_a_queue_that_cannot_be_read_admits_the_job(monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "db")

    def broken(*_args):
        raise RuntimeError("database away")

    monkeypatch.setattr(queue, "queued_in_lane", broken)

    await submit._enforce_job_admission("sqlite:///unused.db", "org-a")  # fails open


async def test_dask_has_no_queue_so_the_global_cap_still_refuses(db_url, active_jobs, monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "dask")
    monkeypatch.setattr(submit, "MAX_ACTIVE_JOBS", 8)
    active_jobs["active"] = 8

    with pytest.raises(JobAdmissionError, match="queue is full"):
        await submit._enforce_job_admission(db_url, "org-a")


async def test_dask_has_no_queue_so_the_per_organization_cap_still_refuses(db_url, monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "dask")
    monkeypatch.setenv("GRID_MAX_ACTIVE_JOBS_PER_ORG", "3")
    monkeypatch.setattr(submit, "MAX_ACTIVE_JOBS", 0)
    monkeypatch.setattr(submit, "count_active_jobs", lambda _url, _terminal, org=None: 3 if org else 99)

    with pytest.raises(JobAdmissionError, match="already has 3 research jobs running"):
        await submit._enforce_job_admission(db_url, "org-a")


async def test_an_unknown_priority_is_refused_before_anything_is_persisted(monkeypatch):
    monkeypatch.setenv("GRID_JOB_EXECUTION", "db")

    with pytest.raises(ValueError, match="unknown priority 'later'"):
        await submit.submit_agent_job("deep_researcher", "question", "reader@example.test", priority="later")


def test_the_per_organization_cap_is_one_name_read_in_one_place(monkeypatch):
    monkeypatch.setenv("GRID_MAX_ACTIVE_JOBS_PER_ORG", "7")
    assert queue.max_active_per_org() == 7
    monkeypatch.setenv("GRID_MAX_ACTIVE_JOBS_PER_ORG", "not a number")
    assert queue.max_active_per_org() == 3
    monkeypatch.delenv("GRID_MAX_ACTIVE_JOBS_PER_ORG")
    assert queue.max_active_per_org() == 3
