"""A run commissioned with a plan waits on it (ADR-0068).

What these pin: the worker asks the BFF whether it may start rather than
reading the plan from its payload; "not yet" puts the ledger in ``wartet``
once and polls at the hinted pace; a started plan is run as it is then, the
Q&A the turn settled first; a replaced plan ends the wait at once; transient
failures are retried and then given up; and the client reads each answer the
route can give.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from aiq_agent.common.plan_documents import PlanDocument
from aiq_agent.common.research_plan import ResearchPlan
from aiq_api.jobs import plan_client as plan_client_module
from aiq_api.jobs.plan_client import PlanClaim
from aiq_api.jobs.plan_client import PlanClient
from aiq_api.jobs.plan_client import PlanReplacedError
from aiq_api.jobs.plan_client import PlanUnavailableError
from aiq_api.jobs.plan_start import await_plan_start
from aiq_api.jobs.plan_start import started_plan
from aiq_api.jobs.run_ledger_fold import RunLedgerFold


def _plan(**overrides: Any) -> ResearchPlan:
    base: dict[str, Any] = {
        "id": "plan-1",
        "projectId": "proj",
        "conversationId": "s_conv",
        "runId": "run-1",
        "author": "agent",
        "status": "proposed",
        "question": "Fluchtwege prüfen",
        "title": "Fluchtwege im Bestand",
        "sections": ["Bestand", "Befund"],
        "genre": "pruefbericht",
        "depth": "kurzpruefung",
        "grundlage": [PlanDocument(name="Einreichplan.pdf", shelf="project")],
        "ausgeschlossen": [PlanDocument(name="Altbestand.pdf")],
        "startsAt": "2026-09-22T08:00:45.000Z",
        "createdAt": "2026-09-22T08:00:00.000Z",
        "updatedAt": "2026-09-22T08:00:00.000Z",
    }
    base.update(overrides)
    return ResearchPlan(**base)


class FakeClaims:
    def __init__(self, answers: list[Any]) -> None:
        self.answers = list(answers)
        self.calls = 0

    async def claim_start(self, plan_id: str) -> PlanClaim:
        self.calls += 1
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class FakeLedger:
    def __init__(self) -> None:
        self.moves: list[str] = []

    def note_waiting(self) -> None:
        self.moves.append("waiting")

    def note_resumed(self) -> None:
        self.moves.append("resumed")


class Sleeps:
    def __init__(self) -> None:
        self.seen: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.seen.append(seconds)


class TestTheWait:
    async def test_a_plan_that_may_start_starts_without_a_wait(self) -> None:
        ledger, sleep = FakeLedger(), Sleeps()
        plan = await await_plan_start(
            "plan-1", FakeClaims([PlanClaim(True, _plan(status="started"))]), ledger, sleep=sleep
        )
        assert plan.status == "started"
        assert ledger.moves == [] and sleep.seen == []

    async def test_not_yet_says_wartet_once_and_polls_at_the_hinted_pace(self) -> None:
        ledger, sleep = FakeLedger(), Sleeps()
        claims = FakeClaims(
            [
                PlanClaim(False, _plan(status="held", startsAt=None), 3.0),
                PlanClaim(False, _plan(status="held", startsAt=None), 3.0),
                PlanClaim(True, _plan(status="started", sections=["Nur Bestand"])),
            ]
        )
        plan = await await_plan_start("plan-1", claims, ledger, sleep=sleep)
        assert plan.sections == ["Nur Bestand"], "the plan as it is at start, edits included"
        assert ledger.moves == ["waiting", "resumed"]
        assert sleep.seen == [3.0, 3.0]

    async def test_a_countdown_waits_on_nobody_and_never_says_wartet(self) -> None:
        """A proposed plan counting down is not a person being waited on: no inbox row."""
        ledger = FakeLedger()
        claims = FakeClaims(
            [
                PlanClaim(False, _plan(status="proposed"), 3.0),
                PlanClaim(False, _plan(status="proposed"), 3.0),
                PlanClaim(True, _plan(status="started")),
            ]
        )
        await await_plan_start("plan-1", claims, ledger, sleep=Sleeps())
        assert ledger.moves == []

    async def test_a_hold_then_a_start_moves_wartet_in_and_out(self) -> None:
        ledger = FakeLedger()
        claims = FakeClaims(
            [
                PlanClaim(False, _plan(status="proposed"), 3.0),
                PlanClaim(False, _plan(status="held", startsAt=None), 3.0),
                PlanClaim(False, _plan(status="approved", startsAt=None), 1.0),
                PlanClaim(True, _plan(status="started")),
            ]
        )
        await await_plan_start("plan-1", claims, ledger, sleep=Sleeps())
        assert ledger.moves == ["waiting", "resumed"]

    async def test_a_replaced_plan_ends_the_wait_at_once(self) -> None:
        claims = FakeClaims([PlanReplacedError("replaced")])
        with pytest.raises(PlanReplacedError):
            await await_plan_start("plan-1", claims, FakeLedger(), sleep=Sleeps())
        assert claims.calls == 1

    async def test_transient_failures_are_retried_then_given_up(self) -> None:
        claims = FakeClaims([PlanUnavailableError("down"), PlanClaim(True, _plan(status="started"))])
        assert (await await_plan_start("plan-1", claims, FakeLedger(), sleep=Sleeps())).status == "started"

        down = FakeClaims([PlanUnavailableError("down")] * 5)
        with pytest.raises(PlanUnavailableError):
            await await_plan_start("plan-1", down, FakeLedger(), sleep=Sleeps(), max_unavailable_seconds=10.0)
        assert down.calls == 3

    async def test_a_cancel_while_waiting_ends_the_wait(self) -> None:
        async def never(_seconds: float) -> None:
            await asyncio.sleep(3600)

        claims = FakeClaims([PlanClaim(False, _plan(status="held", startsAt=None))] * 3)
        task = asyncio.create_task(await_plan_start("plan-1", claims, FakeLedger(), sleep=never))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


class TestWhatTheAgentReads:
    def test_the_settled_questions_come_first_then_the_plan(self) -> None:
        started = started_plan(_plan(), "Frage: Bestand? Antwort: ja")
        assert started.clarifier_result.startswith("Frage: Bestand? Antwort: ja\n\n**Approved Research Plan**")
        assert "Genre: pruefbericht" in started.clarifier_result
        assert "Depth: kurzpruefung" in started.clarifier_result
        assert "- Bestand\n- Befund" in started.clarifier_result
        assert "Einreichplan.pdf [project]" in started.clarifier_result
        assert started.documents is not None
        assert [d.name for d in started.documents.ausgeschlossen] == ["Altbestand.pdf"]

    def test_a_plan_with_no_questions_before_it_is_the_plan_alone(self) -> None:
        started = started_plan(_plan(grundlage=[], ausgeschlossen=[]), None)
        assert started.clarifier_result.startswith("**Approved Research Plan**")
        assert started.documents is None


class TestTheLedgerWhileWaiting:
    async def test_wartet_then_the_first_phase_reads_laeuft(self) -> None:
        from aiq_api.jobs.phase_events import JOB_PHASE_EVENT_TYPE
        from aiq_api.jobs.phase_events import PHASE_PLANNING_STARTED

        class Store:
            def __init__(self) -> None:
                self.events: list[dict] = []

            def store(self, event: dict) -> None:
                self.events.append(event)

        store = Store()
        fold = RunLedgerFold(job_id="job-1", run_id=None, event_store=store, autoflush=False)
        fold.note_waiting()
        await fold.flush(force=True)
        assert fold.snapshot()["status"] == "wartet"
        fold.replace_grundlage([PlanDocument(name="Einreichplan.pdf", shelf="project")])
        fold.note_resumed()
        assert fold.snapshot()["status"] == "angelegt"
        assert [doc["name"] for doc in fold.snapshot()["grundlage"]] == ["Einreichplan.pdf"]
        fold.note_waiting()
        fold.observe({"type": JOB_PHASE_EVENT_TYPE, "data": {"phase": PHASE_PLANNING_STARTED}})
        assert fold.snapshot()["status"] == "laeuft"


class TestTheClient:
    @pytest.fixture(autouse=True)
    def _bff(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff:3000")
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret")

    def _transport(self, monkeypatch: pytest.MonkeyPatch, handler) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        def record(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        real = httpx.AsyncClient

        def client(**kwargs: Any) -> httpx.AsyncClient:
            return real(transport=httpx.MockTransport(record), **kwargs)

        monkeypatch.setattr(plan_client_module.httpx, "AsyncClient", client)
        return seen

    async def test_it_posts_the_plan_id_in_the_path_and_reads_the_claim(self, monkeypatch) -> None:
        body = {"started": False, "plan": _plan().to_wire(), "retryAfterSeconds": 3}
        seen = self._transport(monkeypatch, lambda _r: httpx.Response(200, json=body))
        claim = await PlanClient().claim_start("plan 1")
        assert str(seen[0].url) == "http://bff:3000/api/internal/plans/plan%201/start"
        assert seen[0].headers["x-grid-internal-token"] == "secret"
        assert claim.started is False and claim.retry_after_seconds == 3.0
        assert claim.plan.title == "Fluchtwege im Bestand"

    async def test_409_is_a_replaced_plan_and_everything_else_is_transient(self, monkeypatch) -> None:
        self._transport(monkeypatch, lambda _r: httpx.Response(409, json={}))
        with pytest.raises(PlanReplacedError):
            await PlanClient().claim_start("plan-1")
        self._transport(monkeypatch, lambda _r: httpx.Response(502, json={}))
        with pytest.raises(PlanUnavailableError):
            await PlanClient().claim_start("plan-1")
        self._transport(monkeypatch, lambda _r: httpx.Response(200, json={"started": True, "plan": {"id": "x"}}))
        with pytest.raises(PlanUnavailableError):
            await PlanClient().claim_start("plan-1")

    async def test_no_bff_configured_is_transient(self, monkeypatch) -> None:
        monkeypatch.delenv("FRONTEND_INTERNAL_URL")
        monkeypatch.delenv("FRONTEND_URL", raising=False)
        with pytest.raises(PlanUnavailableError):
            await PlanClient().claim_start("plan-1")
