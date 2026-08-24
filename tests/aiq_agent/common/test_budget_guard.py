"""Tests for the per-run completion-token budget cap (backlog T4-4).

Covers: defensive env-var parsing, completion-token extraction from both
LangChain usage-metadata shapes, ceiling enforcement deferred to the *next*
LLM call (never aborting one already in flight), thread-safe accumulation
across "concurrent worker" callback copies sharing one tracker, and that the
handler actually propagates its exception through LangChain's callback
dispatch (``raise_error``).
"""

from __future__ import annotations

import threading

import pytest
from langchain_core.callbacks.manager import handle_event
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration
from langchain_core.outputs import LLMResult

from aiq_agent.common.budget_guard import BudgetGuardCallback
from aiq_agent.common.budget_guard import RunBudgetExceededError
from aiq_agent.common.budget_guard import _BudgetTracker
from aiq_agent.common.budget_guard import _extract_completion_tokens
from aiq_agent.common.budget_guard import _parse_completion_token_ceiling
from aiq_agent.common.budget_guard import create_budget_guard_callback


def _result_with_usage_metadata(output_tokens: int) -> LLMResult:
    message = AIMessage(
        content="answer",
        usage_metadata={"input_tokens": 10, "output_tokens": output_tokens, "total_tokens": 10 + output_tokens},
    )
    return LLMResult(generations=[[ChatGeneration(message=message)]])


def _result_with_token_usage_metadata(completion_tokens: int) -> LLMResult:
    message = AIMessage(
        content="answer",
        response_metadata={"token_usage": {"prompt_tokens": 5, "completion_tokens": completion_tokens}},
    )
    return LLMResult(generations=[[ChatGeneration(message=message)]])


class TestParseCompletionTokenCeiling:
    def test_unset_disables(self):
        assert _parse_completion_token_ceiling(None) == 0

    def test_blank_disables(self):
        assert _parse_completion_token_ceiling("   ") == 0

    def test_zero_disables(self):
        assert _parse_completion_token_ceiling("0") == 0

    def test_negative_disables(self):
        assert _parse_completion_token_ceiling("-5") == 0

    def test_non_integer_disables(self):
        assert _parse_completion_token_ceiling("not-a-number") == 0

    def test_positive_value_parsed(self):
        assert _parse_completion_token_ceiling("50000") == 50000

    def test_whitespace_trimmed(self):
        assert _parse_completion_token_ceiling("  1000  ") == 1000


class TestCreateBudgetGuardCallback:
    def test_disabled_by_default(self, monkeypatch):
        monkeypatch.delenv("GRID_MAX_RUN_COMPLETION_TOKENS", raising=False)
        assert create_budget_guard_callback() is None

    def test_disabled_when_env_zero(self, monkeypatch):
        monkeypatch.setenv("GRID_MAX_RUN_COMPLETION_TOKENS", "0")
        assert create_budget_guard_callback() is None

    def test_enabled_from_env(self, monkeypatch):
        monkeypatch.setenv("GRID_MAX_RUN_COMPLETION_TOKENS", "1000")
        callback = create_budget_guard_callback()
        assert isinstance(callback, BudgetGuardCallback)

    def test_explicit_ceiling_overrides_env(self, monkeypatch):
        monkeypatch.setenv("GRID_MAX_RUN_COMPLETION_TOKENS", "1000")
        assert create_budget_guard_callback(ceiling=0) is None
        callback = create_budget_guard_callback(ceiling=42)
        assert callback is not None
        assert callback._tracker.ceiling == 42


class TestExtractCompletionTokens:
    def test_prefers_usage_metadata(self):
        assert _extract_completion_tokens(_result_with_usage_metadata(123)) == 123

    def test_falls_back_to_token_usage(self):
        assert _extract_completion_tokens(_result_with_token_usage_metadata(77)) == 77

    def test_no_usage_returns_zero(self):
        message = AIMessage(content="answer")
        result = LLMResult(generations=[[ChatGeneration(message=message)]])
        assert _extract_completion_tokens(result) == 0

    def test_no_generations_returns_zero(self):
        result = LLMResult(generations=[])
        assert _extract_completion_tokens(result) == 0

    def test_malformed_response_never_raises(self):
        assert _extract_completion_tokens(object()) == 0


class TestBudgetTracker:
    def test_disabled_tracker_never_exceeds(self):
        tracker = _BudgetTracker(ceiling=0)
        tracker.add_completion_tokens(10_000)
        tracker.check()  # must not raise

    def test_accumulates_across_calls(self):
        tracker = _BudgetTracker(ceiling=1000)
        tracker.add_completion_tokens(300)
        tracker.add_completion_tokens(300)
        assert tracker.completion_tokens == 600

    def test_check_does_not_raise_below_ceiling(self):
        tracker = _BudgetTracker(ceiling=1000)
        tracker.add_completion_tokens(999)
        tracker.check()  # must not raise

    def test_check_raises_once_ceiling_exceeded(self):
        tracker = _BudgetTracker(ceiling=1000)
        tracker.add_completion_tokens(1001)
        with pytest.raises(RunBudgetExceededError) as exc_info:
            tracker.check()
        assert exc_info.value.ceiling == 1000
        assert exc_info.value.used == 1001

    def test_exact_ceiling_does_not_exceed(self):
        """The ceiling is a cap, not a trigger: usage == ceiling must not abort the next call."""
        tracker = _BudgetTracker(ceiling=1000)
        tracker.add_completion_tokens(1000)
        tracker.check()  # must not raise

    def test_error_message_is_explicit(self):
        tracker = _BudgetTracker(ceiling=5000)
        tracker.add_completion_tokens(5001)
        with pytest.raises(RunBudgetExceededError, match=r"exceeded the configured completion-token budget of 5000"):
            tracker.check()

    def test_negative_or_zero_token_deltas_ignored(self):
        tracker = _BudgetTracker(ceiling=100)
        tracker.add_completion_tokens(0)
        tracker.add_completion_tokens(-5)
        assert tracker.completion_tokens == 0

    def test_concurrent_accumulation_is_thread_safe(self):
        """Simulates up to max_research_concurrency (6) researcher workers all
        reporting usage through their own BudgetGuardCallback copy that share
        one tracker -- the accumulated total must equal the exact sum with no
        lost updates from concurrent access.
        """
        tracker = _BudgetTracker(ceiling=10**9)  # effectively disabled ceiling, just testing accumulation
        workers = 6
        adds_per_worker = 2000
        tokens_per_add = 7

        def _worker():
            for _ in range(adds_per_worker):
                tracker.add_completion_tokens(tokens_per_add)

        threads = [threading.Thread(target=_worker) for _ in range(workers)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert tracker.completion_tokens == workers * adds_per_worker * tokens_per_add


class TestBudgetGuardCallback:
    def test_raise_error_flag_set(self):
        """Required for LangChain's callback manager to propagate the exception
        instead of logging and swallowing it (handle_event only re-raises when
        handler.raise_error is True)."""
        callback = BudgetGuardCallback(_BudgetTracker(ceiling=100))
        assert callback.raise_error is True

    def test_on_llm_end_accumulates_tokens(self):
        callback = BudgetGuardCallback(_BudgetTracker(ceiling=10_000))
        callback.on_llm_end(_result_with_usage_metadata(250))
        callback.on_llm_end(_result_with_usage_metadata(250))
        assert callback.completion_tokens == 500

    def test_on_llm_start_does_not_raise_below_ceiling(self):
        callback = BudgetGuardCallback(_BudgetTracker(ceiling=1000))
        callback.on_llm_end(_result_with_usage_metadata(500))
        callback.on_llm_start(serialized={}, prompts=["hi"])  # must not raise

    def test_in_flight_call_completes_before_abort(self):
        """The call that pushes usage over the ceiling is never interrupted
        mid-generation -- only the *next* on_llm_start call aborts."""
        callback = BudgetGuardCallback(_BudgetTracker(ceiling=100))
        # This on_llm_end pushes tokens well past the ceiling but must not raise itself.
        callback.on_llm_end(_result_with_usage_metadata(500))
        assert callback.completion_tokens == 500

        with pytest.raises(RunBudgetExceededError):
            callback.on_llm_start(serialized={}, prompts=["next call"])

    def test_on_chat_model_start_also_checks_ceiling(self):
        callback = BudgetGuardCallback(_BudgetTracker(ceiling=100))
        callback.on_llm_end(_result_with_usage_metadata(500))
        with pytest.raises(RunBudgetExceededError):
            callback.on_chat_model_start(serialized={}, messages=[[]])

    def test_shared_tracker_across_copies_enforces_job_wide_ceiling(self):
        """for_new_run isn't implemented, but worker code paths that DO call it
        (e.g. tools/research.py's per-researcher-worker callback refresh) must
        still enforce one ceiling for the whole job if constructed to share a
        tracker explicitly."""
        tracker = _BudgetTracker(ceiling=100)
        orchestrator_cb = BudgetGuardCallback(tracker)
        worker_cb = BudgetGuardCallback(tracker)  # shares the same tracker, as create_budget_guard_callback's
        # single instance does when passed through unchanged to concurrent workers.

        orchestrator_cb.on_llm_end(_result_with_usage_metadata(60))
        worker_cb.on_llm_end(_result_with_usage_metadata(60))

        assert tracker.completion_tokens == 120
        with pytest.raises(RunBudgetExceededError):
            worker_cb.on_llm_start(serialized={}, prompts=["over budget"])
        with pytest.raises(RunBudgetExceededError):
            orchestrator_cb.on_llm_start(serialized={}, prompts=["also over budget"])


class TestBudgetGuardCallbackPropagatesThroughLangChain:
    def test_handle_event_reraises_budget_exceeded(self):
        """Integration check that langchain_core.callbacks.manager.handle_event
        actually re-raises our exception (raise_error=True), the exact
        mechanism run_agent_job relies on to abort the job."""
        callback = BudgetGuardCallback(_BudgetTracker(ceiling=10))
        callback.on_llm_end(_result_with_usage_metadata(50))

        with pytest.raises(RunBudgetExceededError):
            handle_event([callback], "on_llm_start", None, {}, ["prompt"])

    def test_handle_event_swallows_other_handlers_without_raise_error(self):
        """Sanity check on the opposite: a handler WITHOUT raise_error=True
        must not propagate, confirming the flag -- not some other mechanism --
        is what makes the budget guard's abort actually work."""

        class NonRaisingHandler:
            raise_error = False

            def on_llm_start(self, *args, **kwargs):
                raise RuntimeError("boom")

        handle_event([NonRaisingHandler()], "on_llm_start", None, {}, ["prompt"])  # must not raise
