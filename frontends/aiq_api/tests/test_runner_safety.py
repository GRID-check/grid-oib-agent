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

from aiq_api.jobs.conversation_output import write_job_turn
from aiq_api.jobs.runner import _ANSWER_CONFIDENCE_FIELDS
from aiq_api.jobs.runner import _DEGRADED_EVENT_FIELDS
from aiq_api.jobs.runner import _GRAPH_RECURSION_ERROR_MSG
from aiq_api.jobs.runner import _WALL_CLOCK_TIMEOUT_MSG
from aiq_api.jobs.runner import JOB_DEGRADED_EVENT_TYPE
from aiq_api.jobs.runner import CancellationMonitor
from aiq_api.jobs.runner import _build_job_output
from aiq_api.jobs.runner import _create_agent_instance
from aiq_api.jobs.runner import _extract_answer_transparency
from aiq_api.jobs.runner import _extract_skills_activated
from aiq_api.jobs.runner import _generate_grid_cards
from aiq_api.jobs.runner import _mark_degraded
from aiq_api.jobs.runner import _purge_deep_checkpoint
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


class TestBudgetMessagesSurvive:
    """The one failure a person can act on themselves must say so."""

    def test_organization_budget_exhaustion_keeps_its_actionable_message(self) -> None:
        from aiq_agent.common.cost_tracking import BudgetExceededError

        message = sanitize_job_error(BudgetExceededError("organization"))

        assert "budget is exhausted" in message
        assert "raise limits" in message


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

    def test_deep_research_agent_receives_max_run_seconds(self):
        """F5: max_run_seconds from fn_config is forwarded to DeepResearcherAgent."""
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig

        fn_config = DeepResearchAgentConfig(orchestrator_llm="llm", max_run_seconds=999)
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

        assert captured_kwargs["max_run_seconds"] == 999

    def test_deep_research_agent_receives_max_run_seconds_zero(self):
        """F5: max_run_seconds=0 (disabled guard) is also forwarded."""
        from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig

        fn_config = DeepResearchAgentConfig(orchestrator_llm="llm", max_run_seconds=0)
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

        assert captured_kwargs["max_run_seconds"] == 0


class TestWallClockTimeout:
    """F3: wall-clock budget timeout surfaces as a curated German message."""

    def test_wall_clock_timeout_uses_curated_message(self):
        """A TimeoutError with 'wall-clock' marker gets the correct message."""
        message = sanitize_job_error(TimeoutError("deep research exceeded the 2400 s wall-clock budget"))
        assert message == _WALL_CLOCK_TIMEOUT_MSG

    def test_wall_clock_timeout_case_insensitive(self):
        """The 'wall-clock' marker check is case-insensitive."""
        message = sanitize_job_error(TimeoutError("WALL-CLOCK"))
        assert message == _WALL_CLOCK_TIMEOUT_MSG

    def test_generic_timeout_not_confused_with_wall_clock(self):
        """A plain TimeoutError (external service) still gets the English message."""
        message = sanitize_job_error(TimeoutError("connection to upstream timed out"))
        assert message == "The job timed out while waiting on an external service."


class TestGraphRecursionErrorClassification:
    """F3: langgraph.GraphRecursionError gets a curated German message."""

    def test_graph_recursion_uses_curated_message(self):
        try:
            from langgraph.errors import GraphRecursionError
        except ImportError:
            pytest.skip("langgraph not installed")

        message = sanitize_job_error(GraphRecursionError("Recursion limit reached"))
        assert message == _GRAPH_RECURSION_ERROR_MSG

    def test_graph_recursion_not_confused_with_internal_error(self):
        try:
            from langgraph.errors import GraphRecursionError
        except ImportError:
            pytest.skip("langgraph not installed")

        message = sanitize_job_error(GraphRecursionError("some error"))
        assert "internal error" not in message


class TestPurgeDeepCheckpointImportable:
    """F7: _purge_deep_checkpoint lives in runner.py and is importable there."""

    def test_purge_function_exists_in_runner(self):
        assert callable(_purge_deep_checkpoint)

    def test_purge_is_noop_without_dsn(self, monkeypatch):
        monkeypatch.delenv("AIQ_DEEP_CHECKPOINT_DB", raising=False)
        _purge_deep_checkpoint("job-x")  # must not raise


class TestExtractSkillsActivated:
    """Lifting the job run's skill transparency off whatever the agent returned.

    The runner is agent-agnostic by design, so this reads defensively: a state
    object, a dict, or an agent with no such field at all.
    """

    def test_reads_it_off_an_agent_state(self) -> None:
        state = SimpleNamespace(skills_activated=["oib-brandschutznachweis"])
        assert _extract_skills_activated(state) == ["oib-brandschutznachweis"]

    def test_reads_it_off_a_dict_result(self) -> None:
        assert _extract_skills_activated({"skills_activated": ["a", "b"]}) == ["a", "b"]

    def test_an_agent_without_the_field_simply_has_none(self) -> None:
        assert _extract_skills_activated(SimpleNamespace()) is None
        assert _extract_skills_activated({}) is None
        assert _extract_skills_activated("just a report string") is None

    def test_an_empty_or_malformed_list_is_none_not_an_empty_claim(self) -> None:
        assert _extract_skills_activated(SimpleNamespace(skills_activated=[])) is None
        assert _extract_skills_activated(SimpleNamespace(skills_activated="oib")) is None
        assert _extract_skills_activated(SimpleNamespace(skills_activated=[None, 3, "ok"])) == ["ok"]


class TestCardFailureIsADegradedReason:
    """A run whose proposals could not be derived says so, beside the agent's own reasons."""

    def test_appends_after_the_agent_reasons_without_duplicating(self) -> None:
        transparency: dict = {"degraded_reasons": ["no_valid_citations"]}

        _mark_degraded(transparency, "cards_generation_failed")
        _mark_degraded(transparency, "cards_generation_failed")

        assert transparency["degraded_reasons"] == ["no_valid_citations", "cards_generation_failed"]

    def test_creates_the_list_when_the_agent_recorded_none(self) -> None:
        transparency: dict = {"research_truncated": True}

        _mark_degraded(transparency, "cards_generation_failed")

        assert transparency == {"research_truncated": True, "degraded_reasons": ["cards_generation_failed"]}

    @pytest.mark.asyncio
    async def test_generate_grid_cards_reports_a_lost_attempt(self) -> None:
        with patch(
            "aiq_agent.cards.generate.generate_cards_result",
            AsyncMock(side_effect=RuntimeError("the worker has no card model")),
        ):
            result = await _generate_grid_cards(MagicMock(), "q", "report")

        assert result.cards is None
        assert result.failed is True


class TestExtractAnswerTransparency:
    """Lifting the marks a run left on its own answer off whatever it returned.

    A deep job can SUCCEED with a caveat owed to the reader — cut off by the
    wall clock or the step limit, degraded because no report file was written or
    nothing was provably grounded, citations stripped before anyone saw them.
    Read defensively (state object, dict, or an agent that records none of it)
    and never turned into a claim the state did not make.
    """

    def test_reads_the_cutoff_off_an_agent_state(self) -> None:
        state = SimpleNamespace(research_truncated=True, truncation_reason="wall_clock")
        assert _extract_answer_transparency(state) == {
            "research_truncated": True,
            "truncation_reason": "wall_clock",
        }

    def test_reads_it_off_a_dict_result(self) -> None:
        result = {
            "research_truncated": True,
            "truncation_reason": "step_limit",
            "degraded_reasons": ["no_report_file"],
        }
        assert _extract_answer_transparency(result) == result

    def test_a_clean_run_contributes_nothing(self) -> None:
        assert _extract_answer_transparency(SimpleNamespace()) == {}
        assert _extract_answer_transparency({}) == {}
        assert _extract_answer_transparency("just a report string") == {}

    def test_a_completed_run_is_absent_not_false(self) -> None:
        """Absence is the contract: never ``research_truncated: false``."""
        state = SimpleNamespace(research_truncated=None, truncation_reason=None, degraded_reasons=None)
        assert _extract_answer_transparency(state) == {}
        assert _extract_answer_transparency(SimpleNamespace(research_truncated=False)) == {}

    def test_only_literal_true_counts_as_a_cutoff(self) -> None:
        """A truthy stand-in is an upstream bug, not a cutoff to announce."""
        assert _extract_answer_transparency(SimpleNamespace(research_truncated=1)) == {}
        assert _extract_answer_transparency(SimpleNamespace(research_truncated="yes")) == {}

    def test_a_malformed_reason_is_dropped_rather_than_forwarded(self) -> None:
        assert _extract_answer_transparency(SimpleNamespace(truncation_reason="")) == {}
        assert _extract_answer_transparency(SimpleNamespace(truncation_reason="   ")) == {}
        assert _extract_answer_transparency(SimpleNamespace(truncation_reason=17)) == {}

    def test_degraded_reasons_keeps_only_the_stable_tokens(self) -> None:
        state = SimpleNamespace(degraded_reasons=["no_report_file", None, 3, "", "no_valid_citations"])
        assert _extract_answer_transparency(state) == {"degraded_reasons": ["no_report_file", "no_valid_citations"]}

    def test_an_empty_degraded_list_is_not_a_claim(self) -> None:
        assert _extract_answer_transparency(SimpleNamespace(degraded_reasons=[])) == {}
        assert _extract_answer_transparency(SimpleNamespace(degraded_reasons="no_report_file")) == {}

    def test_citations_removed_survives_the_job_path_too(self) -> None:
        """The socket path always lifted this; the job path dropped it entirely."""
        removed = {"count": 2, "reasons": ["dead link"]}
        assert _extract_answer_transparency(SimpleNamespace(citations_removed=removed)) == {
            "citations_removed": removed
        }
        assert _extract_answer_transparency(SimpleNamespace(citations_removed={})) == {}
        assert _extract_answer_transparency(SimpleNamespace(citations_removed="two")) == {}


class TestBuildJobOutput:
    """What a client reading the finished job actually sees."""

    def test_a_clean_run_is_just_the_report(self) -> None:
        assert _build_job_output("# Report", cards=None, transparency={}) == {"report": "# Report"}

    def test_the_transparency_fields_land_next_to_the_report(self) -> None:
        output = _build_job_output(
            "# Report",
            cards=[{"type": "next_step"}],
            transparency={
                "research_truncated": True,
                "truncation_reason": "wall_clock",
                "degraded_reasons": ["no_valid_citations"],
            },
        )
        assert output == {
            "report": "# Report",
            "cards": [{"type": "next_step"}],
            "research_truncated": True,
            "truncation_reason": "wall_clock",
            "degraded_reasons": ["no_valid_citations"],
        }

    def test_a_state_straight_off_the_agent_reaches_the_output(self) -> None:
        """End of the chain the runner walks: state object -> persisted output."""
        state = SimpleNamespace(
            research_truncated=True,
            truncation_reason="step_limit",
            degraded_reasons=["no_report_file"],
            citations_removed={"count": 1},
        )
        output = _build_job_output("# Report", cards=None, transparency=_extract_answer_transparency(state))
        assert output["research_truncated"] is True
        assert output["truncation_reason"] == "step_limit"
        assert output["degraded_reasons"] == ["no_report_file"]
        assert output["citations_removed"] == {"count": 1}

    def test_nothing_empty_is_written(self) -> None:
        """No ``cards: []`` and no ``research_truncated: false`` on a clean run."""
        output = _build_job_output("# Report", cards=[], transparency=_extract_answer_transparency({}))
        assert output == {"report": "# Report"}


class TestDegradedEvent:
    """The live channel: a listener watching the stream to the end is told."""

    def test_the_event_type_is_a_job_lifecycle_event(self) -> None:
        assert JOB_DEGRADED_EVENT_TYPE == "job.degraded"

    def test_the_payload_carries_only_the_stable_tokens(self) -> None:
        assert _DEGRADED_EVENT_FIELDS == ("research_truncated", "truncation_reason", "degraded_reasons")
        # The citation summary is output-only: the event stays tokens.
        assert "citations_removed" not in _DEGRADED_EVENT_FIELDS


class TestExtractAnswerConfidence:
    """The answer's own self-assessment, lifted on the same read.

    Deep did not record these until recently; the extractor must be correct both
    before and after that lands, which means absent contributes nothing rather
    than a neutral-looking placeholder.
    """

    def test_the_level_and_its_reasons_ride_the_transparency_dict(self) -> None:
        state = SimpleNamespace(
            answer_confidence="low",
            answer_confidence_reason="Keine bindende Quelle gefunden.",
            answer_confidence_capped_reason="ungrounded",
        )
        assert _extract_answer_transparency(state) == {
            "answer_confidence": "low",
            "answer_confidence_reason": "Keine bindende Quelle gefunden.",
            "answer_confidence_capped_reason": "ungrounded",
        }

    def test_reads_it_off_a_dict_result_too(self) -> None:
        assert _extract_answer_transparency({"answer_confidence": "high"}) == {"answer_confidence": "high"}

    def test_an_agent_that_does_not_record_it_yet_writes_nothing(self) -> None:
        """The other half of this work may not have landed; nothing breaks."""
        assert _extract_answer_transparency(SimpleNamespace()) == {}
        assert _extract_answer_transparency(SimpleNamespace(answer_confidence=None)) == {}

    def test_a_malformed_level_is_dropped_rather_than_forwarded(self) -> None:
        assert _extract_answer_transparency(SimpleNamespace(answer_confidence="")) == {}
        assert _extract_answer_transparency(SimpleNamespace(answer_confidence="   ")) == {}
        assert _extract_answer_transparency(SimpleNamespace(answer_confidence=3)) == {}
        assert _extract_answer_transparency(SimpleNamespace(answer_confidence_reason=[])) == {}

    def test_confidence_is_not_a_degraded_run(self) -> None:
        """A low-confidence answer must not fire the operator-facing signal."""
        for field_name in _ANSWER_CONFIDENCE_FIELDS:
            assert field_name not in _DEGRADED_EVENT_FIELDS

    def test_the_confidence_fields_land_in_the_job_output(self) -> None:
        state = SimpleNamespace(answer_confidence="medium", answer_confidence_reason="Nur eine Quelle.")
        output = _build_job_output("# Report", cards=None, transparency=_extract_answer_transparency(state))
        assert output["answer_confidence"] == "medium"
        assert output["answer_confidence_reason"] == "Nur eine Quelle."


class TestTransparencyReachesBothSurfaces:
    """One read, two surfaces — the bug this closes is a field reaching one.

    The job output feeds the live Report panel; the conversation message feeds
    the thread on reload. A run cut off at the wall clock that says so in the
    panel and not in the thread is an answer whose caveat expires when the tab
    is closed.
    """

    @pytest.mark.asyncio
    async def test_every_field_lands_in_the_output_and_in_the_metadata(self) -> None:
        state = SimpleNamespace(
            research_truncated=True,
            truncation_reason="wall_clock",
            degraded_reasons=["no_report_file"],
            citations_removed={"count": 1, "reasons": ["duplicate"]},
            answer_confidence="low",
            answer_confidence_reason="Recherche abgebrochen.",
            answer_confidence_capped_reason="ungrounded",
        )
        transparency = _extract_answer_transparency(state)

        output = _build_job_output("# Report", cards=None, transparency=transparency)

        with patch(
            "aiq_api.jobs.conversation_output.post_internal_conversation_message",
            new_callable=AsyncMock,
        ) as post:
            await write_job_turn(
                conversation_id="s_abc",
                job_id="job-1",
                usage_context={"identity": {"organization_id": "org_1"}},
                prompt="q",
                answer="# Report",
                transparency=transparency,
            )
        metadata = post.await_args_list[-1].kwargs["metadata"]

        for key, value in transparency.items():
            assert output[key] == value, key
            assert metadata[key] == value, key

    @pytest.mark.asyncio
    async def test_a_clean_run_marks_neither_surface(self) -> None:
        transparency = _extract_answer_transparency(SimpleNamespace())
        assert _build_job_output("# Report", cards=None, transparency=transparency) == {"report": "# Report"}

        with patch(
            "aiq_api.jobs.conversation_output.post_internal_conversation_message",
            new_callable=AsyncMock,
        ) as post:
            await write_job_turn(
                conversation_id="s_abc",
                job_id="job-1",
                usage_context={"identity": {"organization_id": "org_1"}},
                prompt="q",
                answer="# Report",
                transparency=transparency,
            )
        metadata = post.await_args_list[-1].kwargs["metadata"]
        assert "research_truncated" not in metadata
        assert "answer_confidence" not in metadata

    @pytest.mark.asyncio
    async def test_a_transparency_failure_cannot_fail_the_job(self) -> None:
        """The report is the deliverable; a caveat may never cost it.

        The runner guards its own extraction; this pins the other end — the
        conversation write, where a malformed payload from a future caller must
        still leave the reader with the answer.
        """
        with patch(
            "aiq_api.jobs.conversation_output.post_internal_conversation_message",
            new_callable=AsyncMock,
        ) as post:
            await write_job_turn(
                conversation_id="s_abc",
                job_id="job-1",
                usage_context={"identity": {"organization_id": "org_1"}},
                prompt="q",
                answer="# Report",
                transparency="research_truncated",  # type: ignore[arg-type]
            )

        assert post.await_args_list[-1].kwargs["text"] == "# Report"
