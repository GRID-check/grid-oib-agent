"""A Büro turn asks for a Portfolio-Recherche, and the job it starts is one.

The runner has been able to run a portfolio job since the Portfolio-Recherche
slice landed (`portfolio: true` + `project_ids` on the submit body). Nothing
offered it from a chat turn: the office could recognise a question about more
projects than fit in view and had no way to say so. This file pins the path
that closes that gap, end to end and in one direction (ADR-0052 — the answering
agent decides, in its envelope; ADR-0054 spec DR-3/DR-5/DR-7):

1. the envelope's ``portfolio`` reaches the shallow result only in the OFFICE —
   a project turn already has exactly one project, so the request is dropped
   and logged rather than quietly honoured;
2. the decision survives the clarifier, which sits between the escalation and
   the job and may ask a question first;
3. the submitted job carries ``portfolio`` and ``project_ids`` — and an
   ordinary escalation still submits exactly the job it always did;
4. the reader is told what the run costs before it starts (DR-7) — by the live
   line and by the model's own ``escalation_reason`` clause, and by no wire
   field of its own.
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.agent import _effective_portfolio
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.register import ChatDeepResearcherConfig
from aiq_agent.agents.chat_researcher.register import _apply_transparency_extras
from aiq_agent.agents.chat_researcher.register import _build_deep_research_job_submitter

QUESTION = "Vergleiche die Brandschutzkonzepte in allen unseren Wiener Projekten."
HAND_OFF = "Dafür starte ich eine Portfolio-Recherche über drei Projekte."
REASON = "Portfolio-Recherche über 3 Projekte: Brandschutzkonzepte im Vergleich"
PROJECT_IDS = ["proj_seestadt", "proj_krems", "proj_favoriten"]

WORKSPACE_CONTEXT = "WORKSPACE_CONTEXT v1\n\nDiese Unterhaltung läuft im Büro, nicht in einem Projekt."


def _result(messages, *, portfolio: bool, ids: list[str] | None = None):
    """A shallow-agent result shaped like the real one, escalating.

    Every control-marker field is set EXPLICITLY, for the reason
    ``test_plan_rejection`` states: a bare ``MagicMock`` auto-vivifies each
    attribute into something truthy, and then the branch under test is not the
    branch that ran.
    """
    result = MagicMock()
    result.messages = list(messages) + [AIMessage(content=HAND_OFF)]
    result.escalation_requested = True
    result.answer_escalation_reason = REASON
    result.answer_portfolio = portfolio
    result.answer_portfolio_project_ids = list(ids) if ids else None
    result.answer_confidence_marker = None
    result.answer_confidence_marker_reason = None
    result.source_lookup_attempted = False
    result.verified_sources = None
    result.citations_removed = None
    result.skills_activated = None
    result.skills_hidden = None
    result.research_truncated = None
    result.answer_meta = None
    return result


class TestOnlyTheOfficeGetsAPortfolioRun:
    """Spec DR-5: the one path that reads more projects than the cap is reached
    deliberately, and never by a turn that has a project already."""

    def test_the_office_keeps_the_request_and_its_projects(self):
        assert _effective_portfolio(_result([], portfolio=True, ids=PROJECT_IDS), office=True) == (
            True,
            PROJECT_IDS,
        )

    def test_a_project_turn_drops_it_and_says_so(self, caplog):
        with caplog.at_level("INFO"):
            decision = _effective_portfolio(_result([], portfolio=True, ids=PROJECT_IDS), office=False)

        assert decision == (False, None)
        assert "project turn" in caplog.text, "a dropped request must be visible, not silent"

    def test_an_office_turn_that_named_no_projects_still_asks_for_the_portfolio(self):
        """Naming none is an instruction: read every project the caller may
        read. It is not a reason to fall back to a single run."""
        assert _effective_portfolio(_result([], portfolio=True, ids=None), office=True) == (True, None)

    def test_an_ordinary_escalation_is_untouched(self):
        assert _effective_portfolio(_result([], portfolio=False), office=True) == (False, None)

    def test_anything_that_is_not_an_explicit_request_fails_closed(self):
        """The expensive path is never entered on a field this could not read."""
        assert _effective_portfolio(MagicMock(), office=True) == (False, None)


def _agent(shallow_result, submitter):
    """The graph as ``register.py`` wires it, with the clarifier approving."""

    async def shallow(state_input):
        return shallow_result(state_input.messages)

    async def clarifier(state_input):
        result = MagicMock()
        result.messages = list(state_input.messages)
        result.clarifier_log = "Rückfrage: nur Wien? — Ja, nur Wien."
        result.plan_rejected = False
        result.plan_cancelled = False
        result.get_approved_plan_context = MagicMock(return_value=None)
        return result

    return ChatResearcherAgent(
        shallow_research_fn=shallow,
        deep_research_fn=AsyncMock(),
        clarifier_fn=clarifier,
        checkpointer=MemorySaver(),
        deep_research_job_submitter=submitter,
    )


class TestTheDecisionSurvivesTheClarifier:
    """The clarifier sits between the escalation and the job, and may ask a
    question first — so the intent travels on the STATE, the way
    ``escalation_reason`` does, rather than in a result the deep node would
    have to reach back into."""

    @pytest.mark.asyncio
    async def test_the_job_is_submitted_with_the_portfolio_and_its_projects(self):
        seen: dict[str, object] = {}

        async def submitter(state):
            seen["portfolio"] = state.escalation_portfolio
            seen["ids"] = state.escalation_portfolio_project_ids
            seen["reason"] = state.escalation_reason
            return "job-portfolio"

        agent = _agent(lambda msgs: _result(msgs, portfolio=True, ids=PROJECT_IDS), submitter)
        result = await agent.run(
            ChatResearcherState(
                messages=[HumanMessage(content=QUESTION)],
                workspace_context=WORKSPACE_CONTEXT,
            ),
            thread_id="portfolio-1",
        )

        assert seen == {"portfolio": True, "ids": PROJECT_IDS, "reason": REASON}
        assert result["deep_research_job_id"] == "job-portfolio"

    @pytest.mark.asyncio
    async def test_a_project_turn_submits_the_ordinary_deep_job(self):
        seen: dict[str, object] = {}

        async def submitter(state):
            seen["portfolio"] = state.escalation_portfolio
            seen["ids"] = state.escalation_portfolio_project_ids
            return "job-plain"

        agent = _agent(lambda msgs: _result(msgs, portfolio=True, ids=PROJECT_IDS), submitter)
        await agent.run(
            ChatResearcherState(
                messages=[HumanMessage(content=QUESTION)],
                project_context="PROJECT_CONTEXT v1",
            ),
            thread_id="portfolio-2",
        )

        assert seen == {"portfolio": None, "ids": None}


class TestTheSubmitterThreadsBothFields:
    """The chat path's own call into ``submit_agent_job`` — the seam where the
    two fields the runner has always accepted finally get set."""

    @pytest.fixture(autouse=True)
    def _db_dispatch(self, monkeypatch):
        monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

    async def _submit(self, state) -> MagicMock:
        submit = AsyncMock(return_value="job-1")
        with patch("aiq_api.jobs.submit.submit_agent_job", submit):
            submitter = _build_deep_research_job_submitter(ChatDeepResearcherConfig(use_async_deep_research=True))
            assert submitter is not None
            await submitter(state)
        return submit

    async def test_a_portfolio_escalation_submits_a_portfolio_job(self):
        state = ChatResearcherState(
            messages=[HumanMessage(content=QUESTION)],
            escalation_portfolio=True,
            escalation_portfolio_project_ids=PROJECT_IDS,
        )
        submit = await self._submit(state)

        assert submit.await_args.kwargs["portfolio"] is True
        assert submit.await_args.kwargs["project_ids"] == PROJECT_IDS

    async def test_an_ordinary_escalation_submits_the_job_it_always_did(self):
        submit = await self._submit(ChatResearcherState(messages=[HumanMessage(content=QUESTION)]))

        assert submit.await_args.kwargs["portfolio"] is False
        assert submit.await_args.kwargs["project_ids"] is None

    async def test_a_portfolio_run_over_every_readable_project_names_none(self):
        """The model could not enumerate them; the worker asks the register."""
        state = ChatResearcherState(
            messages=[HumanMessage(content=QUESTION)],
            escalation_portfolio=True,
        )
        submit = await self._submit(state)

        assert submit.await_args.kwargs["portfolio"] is True
        assert submit.await_args.kwargs["project_ids"] is None


class TestTheAnswerSaysItIsAPortfolioRun:
    """DR-7: the reader is told what the run costs, before it starts — twice,
    and in neither place by a wire field of its own.

    LIVE, at the instant the decision becomes true: ``emit_escalation`` under
    ``status.escalation.portfolio``, whose one value is the project count.

    DURABLY, on the answer: the model's own ``escalation_reason`` clause, which
    the office prompt branch requires to name the count ("Portfolio-Recherche
    über 3 Projekte: …"). That field is already lifted and already declared by
    the frontend, so the Herleitung narrates the portfolio run with no wire
    change at all.

    A dedicated ``escalation_portfolio`` / ``…_project_count`` pair was the
    obvious third telling, and is deliberately absent: the client's
    ``NATSystemResponseMessageSchema`` strips every key it does not declare, so
    a field lifted before the frontend learns it is set, serialised, sent and
    silently parsed away — the exact failure
    ``frontends/ui/src/adapters/api/research-truncated-wire.spec.ts`` exists to
    catch, and ``test_frame_extras_the_client_declares.py`` now catches on this
    side too. Adding the pair is a change to both halves or to neither.
    """

    def test_the_escalation_clause_carries_the_run_and_its_size(self):
        response = MagicMock(spec=["escalation_reason"])
        _apply_transparency_extras(response, {"escalation_reason": REASON})

        assert response.escalation_reason == REASON
        assert "3 Projekte" in response.escalation_reason

    def test_the_answer_grows_no_portfolio_field_of_its_own(self):
        """Even when the state carries the decision — which it does, all the way
        to the submitter — nothing about it is lifted onto the answer."""
        response = MagicMock(spec=["escalation_reason"])
        _apply_transparency_extras(
            response,
            {
                "escalation_reason": REASON,
                "escalation_portfolio": True,
                "escalation_portfolio_project_ids": PROJECT_IDS,
            },
        )

        assert not hasattr(response, "escalation_portfolio")
        assert not hasattr(response, "escalation_portfolio_project_count")

    def test_an_ordinary_escalation_narrates_exactly_as_it_did(self):
        response = MagicMock(spec=["escalation_reason"])
        _apply_transparency_extras(response, {"escalation_reason": "Die Quellen reichen nicht"})

        assert response.escalation_reason == "Die Quellen reichen nicht"
