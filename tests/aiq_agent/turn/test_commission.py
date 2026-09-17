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
