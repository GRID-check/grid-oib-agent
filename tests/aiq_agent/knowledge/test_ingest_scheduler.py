"""The ingest workers are shared between organisations, not handed out in arrival order.

One office's folder upload used to queue every other office behind it: the
ingestor's pool was a FIFO across all tenants. These pin the order a free worker
takes jobs in, with workers held on events so the order is deterministic.
"""

from __future__ import annotations

import threading

import pytest

from aiq_agent.knowledge import ingest_scheduler
from aiq_agent.knowledge.ingest_scheduler import PLATFORM_LANE
from aiq_agent.knowledge.ingest_scheduler import FairIngestScheduler
from aiq_agent.knowledge.ingest_scheduler import per_org_cap_from_env

TIMEOUT = 5


class Recorder:
    """Jobs that record their name when they run, and can be held until released."""

    def __init__(self) -> None:
        self.order: list[str] = []
        self._lock = threading.Lock()
        self._gates: dict[str, threading.Event] = {}
        self._started: dict[str, threading.Event] = {}

    def job(self, name: str, *, hold: bool = False):
        gate = threading.Event()
        if not hold:
            gate.set()
        self._gates[name] = gate
        self._started[name] = threading.Event()

        def run() -> None:
            with self._lock:
                self.order.append(name)
            self._started[name].set()
            assert gate.wait(TIMEOUT), f"{name} was never released"

        return run

    def wait_started(self, name: str) -> None:
        assert self._started[name].wait(TIMEOUT), f"{name} never started"

    def release(self, name: str) -> None:
        self._gates[name].set()


@pytest.fixture
def scheduler():
    created: list[FairIngestScheduler] = []

    def make(workers: int = 1, **kwargs) -> FairIngestScheduler:
        s = FairIngestScheduler(workers, idle_poll_seconds=0.05, **kwargs)
        created.append(s)
        return s

    yield make
    for s in created:
        s.shutdown(wait=True, timeout=TIMEOUT)


def test_a_second_office_is_served_before_the_first_ones_backlog(scheduler):
    s = scheduler(workers=1)
    r = Recorder()
    s.submit("org-a", r.job("a0", hold=True))
    r.wait_started("a0")
    for i in range(1, 6):
        s.submit("org-a", r.job(f"a{i}"))
    s.submit("org-b", r.job("b1"))

    r.release("a0")
    _drain_when(r, 7)

    # FIFO would run a1..a5 first. B waits for one job, not for A's backlog.
    assert r.order[:3] == ["a0", "b1", "a1"]


def test_backlogs_alternate_while_both_have_work(scheduler):
    s = scheduler(workers=1)
    r = Recorder()
    s.submit("org-a", r.job("hold", hold=True))
    r.wait_started("hold")
    for i in range(3):
        s.submit("org-a", r.job(f"a{i}"))
    for i in range(3):
        s.submit("org-b", r.job(f"b{i}"))

    r.release("hold")
    _drain_when(r, 7)

    assert r.order == ["hold", "b0", "a0", "b1", "a1", "b2", "a2"]


def test_a_newcomer_takes_the_next_free_worker_from_a_busy_office(scheduler):
    s = scheduler(workers=2)
    r = Recorder()
    s.submit("org-a", r.job("a0", hold=True))
    s.submit("org-a", r.job("a1", hold=True))
    r.wait_started("a0")
    r.wait_started("a1")
    s.submit("org-a", r.job("a2"))
    s.submit("org-b", r.job("b0"))

    r.release("a0")
    _drain_when(r, 4)
    r.release("a1")

    assert r.order.index("b0") < r.order.index("a2")


def test_one_office_alone_uses_every_worker(scheduler):
    s = scheduler(workers=3)
    r = Recorder()
    for i in range(3):
        s.submit("org-a", r.job(f"a{i}", hold=True))
    for i in range(3):
        r.wait_started(f"a{i}")

    assert s.running() == {"org-a": 3}
    for i in range(3):
        r.release(f"a{i}")


def test_the_cap_holds_back_an_office_that_already_has_its_share(scheduler):
    s = scheduler(workers=3, per_org_cap=1)
    r = Recorder()
    s.submit("org-a", r.job("a0", hold=True))
    s.submit("org-a", r.job("a1"))
    s.submit("org-b", r.job("b0", hold=True))
    r.wait_started("a0")
    r.wait_started("b0")

    assert s.waiting() == {"org-a": 1}
    r.release("a0")
    r.wait_started("a1")
    r.release("b0")


def test_a_job_without_an_office_is_a_lane_of_its_own(scheduler):
    s = scheduler(workers=1)
    r = Recorder()
    s.submit("org-a", r.job("hold", hold=True))
    r.wait_started("hold")
    s.submit("org-a", r.job("a0"))
    s.submit(None, r.job("sync"))

    assert s.waiting() == {"org-a": 1, PLATFORM_LANE: 1}
    r.release("hold")
    _drain_when(r, 3)
    assert r.order[1] == "sync"


def test_a_failing_job_does_not_take_the_worker_with_it(scheduler):
    s = scheduler(workers=1)
    r = Recorder()

    def boom() -> None:
        raise RuntimeError("parse failed")

    s.submit("org-a", boom)
    s.submit("org-a", r.job("after"))
    r.wait_started("after")


class _Source:
    """A durable queue stand-in: hands out the jobs it holds, then None."""

    def __init__(self, jobs) -> None:
        self.jobs = list(jobs)
        self.asked = 0

    def __call__(self):
        self.asked += 1
        return self.jobs.pop(0) if self.jobs else None


def test_claimed_jobs_and_local_lanes_take_turns(scheduler):
    s = scheduler(workers=1)
    r = Recorder()
    s.submit("org-a", r.job("hold", hold=True))
    r.wait_started("hold")
    for i in range(2):
        s.submit("org-a", r.job(f"local{i}"))
    s.attach_source(_Source([r.job("claimed0"), r.job("claimed1")]))

    r.release("hold")
    _drain_when(r, 5)

    assert r.order == ["hold", "claimed0", "local0", "claimed1", "local1"]


def test_an_empty_source_does_not_delay_local_work(scheduler):
    s = scheduler(workers=1)
    s.attach_source(_Source([]))
    r = Recorder()
    s.submit("org-a", r.job("a0"))
    r.wait_started("a0")


def test_a_source_that_fails_is_asked_again(scheduler):
    calls = []
    r = Recorder()
    job = r.job("claimed")

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise ConnectionError("database restarting")
        return job if len(calls) == 2 else None

    s = scheduler(workers=1)
    s.attach_source(flaky)
    r.wait_started("claimed")


def test_shutdown_stops_claiming(scheduler):
    s = scheduler(workers=1)
    source = _Source([])
    s.attach_source(source)
    s.shutdown(wait=True, timeout=TIMEOUT)
    asked = source.asked
    source.jobs.append(lambda: None)
    threading.Event().wait(0.2)
    assert source.asked == asked
    with pytest.raises(RuntimeError):
        s.submit("org-a", lambda: None)


class _SlowSource:
    """A source whose claim is held open, as a database round trip is."""

    def __init__(self, job) -> None:
        self.job = job
        self.asking = threading.Event()
        self.answer = threading.Event()
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if self.calls > 1:
            return None
        self.asking.set()
        assert self.answer.wait(TIMEOUT)
        return self.job


def test_a_worker_asking_the_source_counts_as_busy(scheduler):
    """A drain that sees no busy worker must not be racing a claim that is committed but not yet running."""
    r = Recorder()
    source = _SlowSource(r.job("claimed", hold=True))
    s = scheduler(workers=1)
    s.attach_source(source)

    assert source.asking.wait(TIMEOUT)
    assert s.busy == 1  # the claim is in flight: nothing is running yet

    source.answer.set()
    r.wait_started("claimed")
    assert s.busy == 1
    r.release("claimed")


def test_a_claim_that_lands_after_the_source_was_detached_is_given_back(scheduler):
    r = Recorder()
    job = r.job("claimed")
    released = threading.Event()
    job.release = released.set
    source = _SlowSource(job)
    s = scheduler(workers=1)
    s.attach_source(source)
    assert source.asking.wait(TIMEOUT)

    s.detach_source()
    source.answer.set()

    assert released.wait(TIMEOUT)
    threading.Event().wait(0.1)
    assert r.order == []  # never started
    assert s.busy == 0


def test_a_job_with_nothing_to_give_back_still_runs_after_a_detach(scheduler):
    r = Recorder()
    source = _SlowSource(r.job("claimed"))
    s = scheduler(workers=1)
    s.attach_source(source)
    assert source.asking.wait(TIMEOUT)

    s.detach_source()
    source.answer.set()

    r.wait_started("claimed")


def test_the_per_org_cap_is_read_from_the_fleet_name(monkeypatch):
    monkeypatch.setenv("GRID_INGEST_MAX_PER_ORG", "3")
    monkeypatch.setenv("AIQ_INGEST_MAX_PER_ORG", "9")

    assert per_org_cap_from_env() == 3


def test_the_old_per_org_cap_name_is_still_accepted_and_warns_once(monkeypatch, caplog):
    monkeypatch.delenv("GRID_INGEST_MAX_PER_ORG", raising=False)
    monkeypatch.setenv("AIQ_INGEST_MAX_PER_ORG", "2")
    monkeypatch.setattr(ingest_scheduler, "_legacy_cap_warned", False)

    with caplog.at_level("WARNING"):
        assert per_org_cap_from_env() == 2
        assert per_org_cap_from_env() == 2

    warnings = [r for r in caplog.records if "deprecated" in r.getMessage()]
    assert len(warnings) == 1
    assert "GRID_INGEST_MAX_PER_ORG" in warnings[0].getMessage()


@pytest.mark.parametrize("value", ["", "many", "-4"])
def test_a_missing_or_malformed_per_org_cap_means_no_cap(monkeypatch, value):
    monkeypatch.setenv("GRID_INGEST_MAX_PER_ORG", value)
    monkeypatch.delenv("AIQ_INGEST_MAX_PER_ORG", raising=False)

    assert per_org_cap_from_env() == 0


def _drain_when(r: Recorder, count: int) -> None:
    """Wait until ``count`` jobs have started."""
    for _ in range(int(TIMEOUT / 0.01)):
        if len(r.order) >= count:
            return
        threading.Event().wait(0.01)
    raise AssertionError(f"only {r.order} ran")
