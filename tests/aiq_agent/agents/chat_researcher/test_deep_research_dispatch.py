"""Which deployments hand a chat deep-research turn to a worker.

The gate used to read ``NAT_DASK_SCHEDULER_ADDRESS`` and nothing else, so every
deployment running DB-claimed workers (``GRID_JOB_EXECUTION=db``, ADR-0021 —
what staging and production run, and where no scheduler address is ever set)
fell back to synchronous in-process research. That fallback returns no job id,
and everything keyed off one — the report route, the filing seam the BFF jobs
proxy hangs off it — was therefore unreachable on exactly the deployments that
run the feature.

The contract under test is the one ``aiq_api.jobs.submit.submit_agent_job``
already enforces: a submission is accepted unless *neither* backend is
configured. These tests hold the chat gate to the same line.
"""

from unittest.mock import AsyncMock
from unittest.mock import patch

from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.register import ChatDeepResearcherConfig
from aiq_agent.agents.chat_researcher.register import _build_deep_research_job_submitter


def _config(**overrides):
    kwargs = {"use_async_deep_research": True}
    kwargs.update(overrides)
    return ChatDeepResearcherConfig(**kwargs)


def _state():
    return ChatResearcherState(messages=[HumanMessage(content="Wie hoch darf die Brüstung sein?")])


class TestDispatchGate:
    """Whether a submitter is built at all — the decision the bug got wrong."""

    def test_db_execution_without_a_scheduler_still_submits(self, monkeypatch):
        # Staging exactly: db-claimed workers, no Dask anywhere.
        monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

        assert _build_deep_research_job_submitter(_config()) is not None

    def test_scheduler_without_db_execution_submits(self, monkeypatch):
        monkeypatch.delenv("GRID_JOB_EXECUTION", raising=False)
        monkeypatch.setenv("NAT_DASK_SCHEDULER_ADDRESS", "tcp://localhost:8786")

        assert _build_deep_research_job_submitter(_config()) is not None

    def test_neither_backend_falls_back_to_synchronous(self, monkeypatch):
        # Local dev with no workers: the sync fallback is the feature, not a bug.
        monkeypatch.delenv("GRID_JOB_EXECUTION", raising=False)
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

        assert _build_deep_research_job_submitter(_config()) is None

    def test_dask_mode_named_explicitly_without_a_scheduler_falls_back(self, monkeypatch):
        # `dask` is the default value of the variable, so setting it must not
        # read as "some backend is configured".
        monkeypatch.setenv("GRID_JOB_EXECUTION", "dask")
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

        assert _build_deep_research_job_submitter(_config()) is None

    def test_the_flag_still_governs(self, monkeypatch):
        # Both backends available and the feature off: still no submitter.
        monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
        monkeypatch.setenv("NAT_DASK_SCHEDULER_ADDRESS", "tcp://localhost:8786")

        assert _build_deep_research_job_submitter(_config(use_async_deep_research=False)) is None


class TestSubmissionReachesTheApi:
    """The built submitter calls the one submit path, with no scheduler in hand."""

    async def test_db_mode_submitter_calls_submit_agent_job(self, monkeypatch):
        monkeypatch.setenv("GRID_JOB_EXECUTION", "db")
        monkeypatch.delenv("NAT_DASK_SCHEDULER_ADDRESS", raising=False)

        submit = AsyncMock(return_value="job-123")
        with patch("aiq_api.jobs.submit.submit_agent_job", submit):
            submitter = _build_deep_research_job_submitter(_config())
            assert submitter is not None
            job_id = await submitter(_state())

        assert job_id == "job-123"
        assert submit.await_count == 1
        assert submit.await_args.kwargs["agent_type"] == "deep_researcher"
        assert submit.await_args.kwargs["input_text"] == "Wie hoch darf die Brüstung sein?"
