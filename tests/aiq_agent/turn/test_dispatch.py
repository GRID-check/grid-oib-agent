"""Which turns are handed to a RUN.

The research queue is the only place a deep-research job runs (ADR-0021), so an
escalated question is always commissioned as a run when the workflow asks for
escalation (``use_async_deep_research``). The gate no longer reads any deployment
variable: a deployment cannot fall back to researching in process, because there
is no second execution path to fall back to.

The turn commissions the run through the BFF instead of submitting the job itself
(ADR-0062).
"""

from unittest.mock import AsyncMock
from unittest.mock import patch

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.conversation_register import ChatDeepResearcherConfig
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.turn.commission import CommissionedRun
from aiq_agent.turn.dispatch import build_run_commissioner


def _config(**overrides):
    kwargs = {"use_async_deep_research": True}
    kwargs.update(overrides)
    return ChatDeepResearcherConfig(**kwargs)


def _state():
    return ConversationState(messages=[HumanMessage(content="Wie hoch darf die Brüstung sein?")])


class TestDispatchGate:
    """Whether a commissioner is built at all: the workflow's escalation flag decides."""

    def test_escalation_on_builds_a_commissioner(self):
        assert build_run_commissioner(_config()) is not None

    def test_escalation_off_answers_in_the_turn(self):
        assert build_run_commissioner(_config(use_async_deep_research=False)) is None


class TestCommissioningReachesTheTaskApi:
    """The built commissioner asks the BFF for a run, carrying the question and
    what the clarifier already settled."""

    async def test_the_commissioner_commissions_a_run(self):
        commissioned = CommissionedRun(run_id="run-1", run_message_id="msg-1", conversation_id="s_1")
        commission = AsyncMock(return_value=commissioned)
        with patch("aiq_agent.turn.dispatch.commission_research_run", commission):
            commissioner = build_run_commissioner(_config())
            assert commissioner is not None
            state = _state()
            state.clarifier_result = "Frage: Welches Geschoss? Antwort: Erdgeschoss."
            run = await commissioner(state)

        assert run is commissioned
        assert commission.await_count == 1
        assert commission.await_args.args[0] == "Wie hoch darf die Brüstung sein?"
        assert commission.await_args.kwargs["context"] == "Frage: Welches Geschoss? Antwort: Erdgeschoss."


class TestJobQuery:
    """What the worker is asked: the preserved query, else the latest user turn."""

    def test_the_preserved_query_wins(self):
        from aiq_agent.turn.dispatch import job_query

        state = ConversationState(messages=[HumanMessage(content="neu")], original_query="ursprünglich")
        assert job_query(state) == "ursprünglich"

    def test_falls_back_to_the_latest_user_message(self):
        from aiq_agent.turn.dispatch import job_query

        assert job_query(_state()) == "Wie hoch darf die Brüstung sein?"

    def test_nothing_to_research_is_an_error(self):
        import pytest

        from aiq_agent.turn.dispatch import job_query

        with pytest.raises(RuntimeError, match="without a query"):
            job_query(ConversationState(messages=[]))
