"""Tests for runner-side safety behavior.

Covers: terminal-status stickiness (a reaped FAILURE must never be flipped
back to SUCCESS by the worker), CancellationMonitor stopping on FAILURE, and
error-message sanitization (no raw exception text with hosts/DSNs to clients).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest

from aiq_api.jobs.runner import CancellationMonitor
from aiq_api.jobs.runner import _create_agent_instance
from aiq_api.jobs.runner import _resolve_deep_research_checkpointer
from aiq_api.jobs.runner import _update_status_if_not_terminal
from aiq_api.jobs.runner import sanitize_job_error


def _job_store(current_status: str | None):
    job = SimpleNamespace(status=current_status) if current_status is not None else None
    return SimpleNamespace(get_job=AsyncMock(return_value=job), update_status=AsyncMock())


class TestTerminalStatusStickiness:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("terminal_status", ["success", "failure", "interrupted"])
    async def test_success_write_skipped_when_already_terminal(self, terminal_status):
        """A reaped/cancelled job must keep its terminal verdict."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = _job_store(terminal_status)

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.SUCCESS, output={"report": "r"})

        assert written is False
        job_store.update_status.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_failure_write_skipped_when_already_interrupted(self):
        """The worker's failure path must not clobber a user cancellation."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = _job_store("interrupted")

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.FAILURE, error="boom")

        assert written is False
        job_store.update_status.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_writes_when_job_still_running(self):
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = _job_store("running")

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.SUCCESS, output={"report": "r"})

        assert written is True
        job_store.update_status.assert_awaited_once_with("job-1", JobStatus.SUCCESS, output={"report": "r"})

    @pytest.mark.asyncio
    async def test_writes_when_current_status_unreadable(self):
        """Fail open: an unreadable current status must not lose the terminal write."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = SimpleNamespace(
            get_job=AsyncMock(side_effect=ConnectionError("db down")),
            update_status=AsyncMock(),
        )

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.FAILURE, error="boom")

        assert written is True
        job_store.update_status.assert_awaited_once_with("job-1", JobStatus.FAILURE, error="boom")

    @pytest.mark.asyncio
    async def test_writes_when_job_missing(self):
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

        job_store = _job_store(None)

        written = await _update_status_if_not_terminal(job_store, "job-1", JobStatus.SUCCESS)

        assert written is True
        job_store.update_status.assert_awaited_once_with("job-1", JobStatus.SUCCESS)


class TestCancellationMonitorStopStatuses:
    def _monitor(self) -> CancellationMonitor:
        return CancellationMonitor(
            scheduler_address="tcp://localhost:8786",
            db_url="sqlite:///test.db",
            job_id="job-1",
            poll_interval=0.01,
        )

    @staticmethod
    def _patch_job_store(monkeypatch, status: str) -> None:
        import nat.front_ends.fastapi.async_jobs.job_store as nat_job_store

        class FakeJobStore:
            def __init__(self, scheduler_address=None, db_url=None, db_engine=None):
                pass

            async def get_job(self, job_id):
                return SimpleNamespace(status=status)

        monkeypatch.setattr(nat_job_store, "JobStore", FakeJobStore)

    @pytest.mark.asyncio
    async def test_monitor_stops_on_interrupted(self, monkeypatch):
        self._patch_job_store(monkeypatch, "interrupted")
        monitor = self._monitor()

        await asyncio.wait_for(monitor._poll_job_status(), timeout=2.0)

        assert monitor.is_cancelled

    @pytest.mark.asyncio
    async def test_monitor_stops_on_failure(self, monkeypatch):
        """The ghost-job reaper writes FAILURE externally; the worker must stop too."""
        self._patch_job_store(monkeypatch, "failure")
        monitor = self._monitor()

        await asyncio.wait_for(monitor._poll_job_status(), timeout=2.0)

        assert monitor.is_cancelled

    @pytest.mark.asyncio
    async def test_monitor_keeps_running_job_alive(self, monkeypatch):
        self._patch_job_store(monkeypatch, "running")
        monitor = self._monitor()

        task = asyncio.create_task(monitor._poll_job_status())
        await asyncio.sleep(0.1)

        assert not monitor.is_cancelled
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


class TestSanitizeJobError:
    def test_internal_error_never_leaks_exception_text(self):
        message = sanitize_job_error(RuntimeError("postgresql://user:s3cret@db.internal:5432/jobs failed"))

        assert message == "The job failed due to an internal error."
        assert "s3cret" not in message
        assert "db.internal" not in message

    def test_timeout_classified(self):
        assert sanitize_job_error(TimeoutError("upstream at 10.0.0.5 timed out")) == (
            "The job timed out while waiting on an external service."
        )

    def test_connection_error_classified(self):
        message = sanitize_job_error(ConnectionError("refused by 10.0.0.5:5432"))

        assert message == "A connection error occurred while running the job."
        assert "10.0.0.5" not in message

    def test_llm_provider_error_classified_by_module(self):
        class FakeProviderError(Exception):
            pass

        FakeProviderError.__module__ = "openai.error"

        message = sanitize_job_error(FakeProviderError("401 from https://api.example.com key=sk-abc"))

        assert message == "The LLM provider returned an error while running the job."
        assert "sk-abc" not in message

    def test_network_stack_error_classified_by_module(self):
        class FakeTransportError(Exception):
            pass

        FakeTransportError.__module__ = "httpx"

        message = sanitize_job_error(FakeTransportError("connect to internal-host:8443 failed"))

        assert message == "A connection error occurred while running the job."
        assert "internal-host" not in message

    def test_budget_exceeded_error_message_persisted_verbatim(self):
        """RunBudgetExceededError already carries a curated, user-safe message
        ("run exceeded the configured completion-token budget of N") -- it
        must be persisted as-is instead of falling through to the generic
        internal-error classification other unclassified exceptions get."""
        from aiq_agent.common import RunBudgetExceededError

        message = sanitize_job_error(RunBudgetExceededError(ceiling=50_000, used=50_123))

        assert message == "run exceeded the configured completion-token budget of 50000"


class TestResolveDeepResearchCheckpointer:
    """Async-job checkpointer seam (T3-8): restart-safe deep-research jobs.

    A worker crash mid-run currently loses all execution state; only the SQL
    JobStore row survives (the ghost-job reaper eventually marks it FAILURE).
    _resolve_deep_research_checkpointer builds the optional durable
    checkpointer that lets a manually re-invoked job_id resume instead.
    """

    @pytest.mark.asyncio
    async def test_returns_none_for_non_deep_research_agent(self):
        """Other agent types (e.g. shallow_research_agent) are never given a checkpointer."""
        fn_config = SimpleNamespace(type="shallow_research_agent", checkpoint_db="./checkpoints.db")

        result = await _resolve_deep_research_checkpointer(fn_config)

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_when_checkpoint_db_unset(self):
        """No checkpoint_db configured -> current in-memory-only behavior, no checkpointer."""
        fn_config = SimpleNamespace(type="deep_research_agent", checkpoint_db=None)

        result = await _resolve_deep_research_checkpointer(fn_config)

        assert result is None

    @pytest.mark.asyncio
    async def test_builds_checkpointer_via_get_checkpointer_when_configured(self):
        """A configured checkpoint_db resolves through aiq_agent.common.get_checkpointer (shared cache)."""
        import aiq_agent.common as common_module

        fn_config = SimpleNamespace(type="deep_research_agent", checkpoint_db="./deep_research_checkpoints.db")
        fake_checkpointer = MagicMock(name="fake_checkpointer")
        get_checkpointer_mock = AsyncMock(return_value=fake_checkpointer)

        with patch.object(common_module, "get_checkpointer", get_checkpointer_mock):
            result = await _resolve_deep_research_checkpointer(fn_config)

        get_checkpointer_mock.assert_awaited_once_with("./deep_research_checkpoints.db")
        assert result is fake_checkpointer


class TestCreateAgentInstanceForwardsCheckpointer:
    """_create_agent_instance threads the resolved checkpointer into DeepResearcherAgent (T3-8)."""

    def test_deep_research_agent_receives_checkpointer(self):
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig

        fn_config = DeepResearchAgentConfig(orchestrator_llm="llm")
        fake_checkpointer = MagicMock(name="fake_checkpointer")
        captured_kwargs = {}

        def _agent_cls(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return MagicMock()

        _create_agent_instance(
            agent_cls=_agent_cls,
            llm_provider=MagicMock(),
            llm=MagicMock(),
            tools=[],
            fn_config=fn_config,
            verbose=False,
            callbacks=[],
            job_id="job-1",
            checkpointer=fake_checkpointer,
        )

        assert captured_kwargs["checkpointer"] is fake_checkpointer

    def test_deep_research_agent_defaults_checkpointer_to_none(self):
        """Omitting checkpointer at the call site preserves current behavior."""
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig

        fn_config = DeepResearchAgentConfig(orchestrator_llm="llm")
        captured_kwargs = {}

        def _agent_cls(*args, **kwargs):
            captured_kwargs.update(kwargs)
            return MagicMock()

        _create_agent_instance(
            agent_cls=_agent_cls,
            llm_provider=MagicMock(),
            llm=MagicMock(),
            tools=[],
            fn_config=fn_config,
            verbose=False,
            callbacks=[],
            job_id="job-1",
        )

        assert captured_kwargs["checkpointer"] is None
