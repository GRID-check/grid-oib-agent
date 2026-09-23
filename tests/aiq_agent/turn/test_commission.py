"""An escalated question becomes a run, or says exactly why it could not.

The turn used to submit the job itself and write „Deep research job submitted.
Job ID: …" into the thread, which was the entire record of the work. It now
asks the BFF to commission a run (ADR-0062), and every refusal it can meet has
its own name, because the caller answers each one differently: a full queue is
a "try later", everything else is a reason to research in process instead of
leaving the reader with nothing.
"""

import pytest

from aiq_agent.tools.tasks.client import DelegationError
from aiq_agent.turn import commission
from aiq_agent.turn.commission import CommissionRefused
from aiq_agent.turn.commission import commission_research_run

QUESTION = "Gilt für das Atrium in Haus A OIB 2 oder OIB 2.3?"
OK_BODY = {
    "runId": "run-1",
    "runMessageId": "msg-1",
    "conversationId": "s_conv",
    "status": "running",
}


@pytest.fixture
def commissioning(monkeypatch):
    """A turn inside a project, with a signed envelope, and a captured POST."""
    calls: list[tuple[dict, object]] = []

    def _post(payload, envelope):
        calls.append((payload, envelope))
        return OK_BODY

    monkeypatch.setattr(commission.project_context, "get_project_id_from_context", lambda: "proj-1")
    monkeypatch.setattr(
        commission.project_context,
        "get_request_envelope_from_context",
        lambda: ("header", "signature"),
    )
    monkeypatch.setattr(commission, "post_task", _post)
    return calls


def _refusing(monkeypatch, error: Exception):
    monkeypatch.setattr(commission.project_context, "get_project_id_from_context", lambda: "proj-1")
    monkeypatch.setattr(
        commission.project_context,
        "get_request_envelope_from_context",
        lambda: ("header", "signature"),
    )

    def _post(payload, envelope):
        raise error

    monkeypatch.setattr(commission, "post_task", _post)


class TestWhatItAsksFor:
    async def test_the_question_and_the_project_reach_the_task_api(self, commissioning):
        run = await commission_research_run(QUESTION)

        payload, envelope = commissioning[0]
        assert payload == {"op": "research", "projectId": "proj-1", "question": QUESTION}
        # Echoed byte-for-byte: this tier signs nothing of its own.
        assert (envelope.header, envelope.signature) == ("header", "signature")
        assert (run.run_id, run.run_message_id, run.conversation_id) == ("run-1", "msg-1", "s_conv")

    async def test_what_the_clarifier_settled_travels_with_the_question(self, commissioning):
        await commission_research_run(QUESTION, context="  Frage: Welches Geschoss? Antwort: EG.  ")

        assert commissioning[0][0]["context"] == "Frage: Welches Geschoss? Antwort: EG."

    async def test_an_empty_context_is_absent_rather_than_empty(self, commissioning):
        await commission_research_run(QUESTION, context="   ")

        assert "context" not in commissioning[0][0]

    async def test_the_rahmen_and_the_unterlagen_ride_the_commission(self, commissioning):
        from aiq_agent.common.plan_documents import PlanDocument
        from aiq_agent.common.plan_documents import PlanDocuments

        docs = PlanDocuments(
            grundlage=[PlanDocument(name="Einreichplan.pdf", title="Einreichplan EG", shelf="project")],
            ausgeschlossen=[PlanDocument(name="alt.pdf")],
        )
        await commission_research_run(QUESTION, data_sources=["knowledge_base"], documents=docs)

        payload = commissioning[0][0]
        assert payload["dataSources"] == ["knowledge_base"]
        assert payload["documents"] == {
            "grundlage": [{"name": "Einreichplan.pdf", "title": "Einreichplan EG", "shelf": "project"}],
            "ausgeschlossen": [{"name": "alt.pdf"}],
            # The BFF's documents schema accepts it: `lib/runs/plan-documents.ts`.
            "nur_grundlage": False,
        }

    async def test_an_empty_unterlagen_list_is_absent(self, commissioning):
        from aiq_agent.common.plan_documents import PlanDocuments

        await commission_research_run(QUESTION, documents=PlanDocuments())

        assert "documents" not in commissioning[0][0] and "dataSources" not in commissioning[0][0]

    async def test_a_long_question_is_cut_rather_than_refused(self, commissioning):
        # The question is the run's prompt AND its title. Refusing over a long
        # sentence would lose the work to enforce a bound the route also holds.
        await commission_research_run("Wie hoch " * 400)

        assert len(commissioning[0][0]["question"]) == commission.MAX_QUESTION_CHARS


class TestWhatItRefuses:
    async def test_outside_a_project_there_is_no_run(self, monkeypatch):
        monkeypatch.setattr(commission.project_context, "get_project_id_from_context", lambda: None)

        with pytest.raises(CommissionRefused) as refusal:
            await commission_research_run(QUESTION)

        # A run's own tenancy predicate requires a project: there is no such
        # thing as a run outside one, so this is refused before anything is sent.
        assert refusal.value.reason == "no_project"

    async def test_without_a_signed_envelope_nothing_is_commissioned(self, monkeypatch):
        monkeypatch.setattr(commission.project_context, "get_project_id_from_context", lambda: "proj-1")
        monkeypatch.setattr(commission.project_context, "get_request_envelope_from_context", lambda: (None, None))

        with pytest.raises(CommissionRefused) as refusal:
            await commission_research_run(QUESTION)

        assert refusal.value.reason == "no_envelope"

    @pytest.mark.parametrize(
        ("status", "reason"),
        [
            # The authorization ladder answers 404 for a project the caller
            # cannot reach, on purpose: the two are one case.
            (403, "forbidden"),
            (404, "forbidden"),
            (429, "busy"),
            (500, "unreachable"),
            (None, "unreachable"),
        ],
    )
    async def test_every_refusal_of_the_route_has_its_own_name(self, monkeypatch, status, reason):
        _refusing(monkeypatch, DelegationError("refused", status=status))

        with pytest.raises(CommissionRefused) as refusal:
            await commission_research_run(QUESTION)

        assert refusal.value.reason == reason

    async def test_an_answer_without_a_run_is_not_a_run(self, monkeypatch):
        monkeypatch.setattr(commission.project_context, "get_project_id_from_context", lambda: "proj-1")
        monkeypatch.setattr(
            commission.project_context,
            "get_request_envelope_from_context",
            lambda: ("header", "signature"),
        )
        monkeypatch.setattr(commission, "post_task", lambda payload, envelope: {"status": "running"})

        with pytest.raises(CommissionRefused) as refusal:
            await commission_research_run(QUESTION)

        assert refusal.value.reason == "unreachable"

    async def test_a_run_whose_message_could_not_be_minted_still_runs(self, monkeypatch):
        monkeypatch.setattr(commission.project_context, "get_project_id_from_context", lambda: "proj-1")
        monkeypatch.setattr(
            commission.project_context,
            "get_request_envelope_from_context",
            lambda: ("header", "signature"),
        )
        monkeypatch.setattr(
            commission,
            "post_task",
            lambda payload, envelope: {**OK_BODY, "runMessageId": None},
        )

        run = await commission_research_run(QUESTION)

        # The work is commissioned; what is missing is the block, not the run.
        assert run.run_id == "run-1"
        assert run.run_message_id is None


class TestAPlannedRun:
    """ADR-0065: the drafted plan and its run go to the BFF in one call."""

    @pytest.fixture
    def posted(self, monkeypatch):
        from aiq_agent.turn import commission as module

        seen: list[dict] = []

        def fake_post(payload, envelope):
            seen.append(payload)
            return {"runId": "run-1", "runMessageId": "msg-1", "conversationId": "s_conv", "planId": "plan-1"}

        monkeypatch.setattr(module, "post_task", fake_post)
        monkeypatch.setattr(module.project_context, "get_project_id_from_context", lambda: "proj-1")
        monkeypatch.setattr(module.project_context, "get_request_envelope_from_context", lambda: ("h", "s"))
        return seen

    async def test_the_plan_op_carries_the_draft_the_start_and_the_questions(self, posted):
        from aiq_agent.common.research_plan import PlanStart
        from aiq_agent.common.research_plan import ResearchPlanDraft
        from aiq_agent.turn.commission import commission_planned_run

        draft = ResearchPlanDraft(question="Fluchtwege prüfen", title="Fluchtwege", sections=["Bestand"])
        run = await commission_planned_run(
            draft, start=PlanStart(policy="ask", graceSeconds=30), context="Frage: Bestand? Antwort: ja"
        )

        assert run.run_id == "run-1" and run.run_message_id == "msg-1"
        assert posted == [
            {
                "op": "plan",
                "projectId": "proj-1",
                "plan": {
                    "question": "Fluchtwege prüfen",
                    "title": "Fluchtwege",
                    "sections": ["Bestand"],
                    "genre": "bericht",
                    "depth": "gutachten",
                    "grundlage": [],
                    "ausgeschlossen": [],
                    "nurGrundlage": False,
                    "unterlagen": [],
                },
                "start": {"policy": "ask", "graceSeconds": 30},
                "context": "Frage: Bestand? Antwort: ja",
            }
        ]
