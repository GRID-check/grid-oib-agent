"""Which deployments hand an escalated question to a RUN.

The gate used to read ``NAT_DASK_SCHEDULER_ADDRESS`` and nothing else, so every
deployment running DB-claimed workers (``GRID_JOB_EXECUTION=db``, ADR-0021 —
what staging and production run, and where no scheduler address is ever set)
fell back to synchronous in-process research. That fallback returns no job id,
and everything keyed off one — the report route, the filing seam the BFF jobs
proxy hangs off it — was therefore unreachable on exactly the deployments that
run the feature.

The contract under test is the one ``aiq_api.jobs.submit.submit_agent_job``
already enforces: a submission is accepted unless *neither* backend is
configured. These tests hold the chat gate to the same line — the turn now
commissions a run through the BFF instead of submitting the job itself
(ADR-0062), but the deployment question it asks first is unchanged.
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
    """Whether a commissioner is built at all — the decision the bug got wrong."""

    def test_db_execution_without_a_scheduler_still_submits(self, monkeypatch):
        # Staging exactly: db-claimed workers, no Dask anywhere.
        monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

        assert build_run_commissioner(_config()) is not None

    def test_scheduler_without_db_execution_submits(self, monkeypatch):
        monkeypatch.delenv("GRID_JOB_EXECUTION", raising=False)
        monkeypatch.setenv("NAT_DASK_SCHEDULER_ADDRESS", "tcp://localhost:8786")

        assert build_run_commissioner(_config()) is not None

    def test_neither_backend_falls_back_to_synchronous(self, monkeypatch):
        # Local dev with no workers: the sync fallback is the feature, not a bug.
        monkeypatch.delenv("GRID_JOB_EXECUTION", raising=False)
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

        assert build_run_commissioner(_config()) is None

    def test_dask_mode_named_explicitly_without_a_scheduler_falls_back(self, monkeypatch):
        # `dask` is the default value of the variable, so setting it must not
        # read as "some backend is configured".
        monkeypatch.setenv("GRID_JOB_EXECUTION", "dask")
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

        assert build_run_commissioner(_config()) is None

    def test_the_flag_still_governs(self, monkeypatch):
        # Both backends available and the feature off: still no submitter.
        monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
        monkeypatch.setenv("NAT_DASK_SCHEDULER_ADDRESS", "tcp://localhost:8786")

        assert build_run_commissioner(_config(use_async_deep_research=False)) is None


class TestCommissioningReachesTheTaskApi:
    """The built commissioner asks the BFF for a run, carrying the question and
    what the clarifier already settled."""

    async def test_db_mode_commissioner_commissions_a_run(self, monkeypatch):
        monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

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
