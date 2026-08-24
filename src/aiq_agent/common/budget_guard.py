"""Per-run completion-token budget cap for async research jobs (backlog T4-4).

``GRID_MAX_RUN_COMPLETION_TOKENS`` bounds the total completion (output) tokens
a single async job may consume across *every* LLM call it makes --
orchestrator, planner, writer, source-router, and every concurrent researcher
worker alike. It is a coarse run-away-job safety valve, independent of (and
complementary to) the USD-denominated org/user/project budgets enforced by
``aiq_agent.common.cost_tracking.GridCostTracker``.

Mechanism: a ``BaseCallbackHandler`` with ``raise_error = True`` so an
exception raised from one of its methods propagates out of LangChain's
``handle_event`` instead of being swallowed and logged (see
``langchain_core.callbacks.manager.handle_event`` -- exceptions only
propagate when ``handler.raise_error`` is set). Usage is only known
*after* a call completes, so the ceiling is enforced at the START of the
*next* call: ``on_llm_start``/``on_chat_model_start`` check accumulated usage
and raise ``RunBudgetExceededError`` once the ceiling was already exceeded by
a prior call. A call already in flight is never interrupted mid-generation --
the same soft-limit semantic ``GridCostTracker`` documents for its USD
budgets.

Named ``RunBudgetExceededError`` (not ``BudgetExceededError``) to avoid
colliding with the unrelated, pre-existing
``aiq_agent.common.cost_tracking.BudgetExceededError`` (a USD-denominated
org/user/project budget check) -- the two are independent mechanisms that can
both apply to the same job.

Thread/concurrency safety: up to ``max_research_concurrency`` (default 6)
researcher workers can be in flight at once within a single job (see
``aiq_agent.agents.deep_researcher.agent.DEFAULT_MAX_RESEARCH_CONCURRENCY``
and ``tools/research.py._run_research_queries``). Every worker's callback
list is forwarded straight through to this handler (no ``for_new_run`` is
implemented here -- there is no per-run mutable state on the handler itself,
only on the shared, lock-guarded ``_BudgetTracker``), so one tracker
correctly accumulates completion tokens across the whole job regardless of
how many workers are concurrently active.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger(__name__)

# @environment_variable GRID_MAX_RUN_COMPLETION_TOKENS
# @category Cost control
# @type int
# @default 0
# @required false
# Per-run completion-token ceiling for async research jobs. 0 (or any
# non-positive/unparseable value) disables the cap. Applies to the sum of
# completion tokens across every LLM call in the job (all subagents/workers).
GRID_MAX_RUN_COMPLETION_TOKENS_ENV = "GRID_MAX_RUN_COMPLETION_TOKENS"

DISABLED_CEILING = 0


class RunBudgetExceededError(RuntimeError):
    """Raised when a run's accumulated completion-token usage exceeds its ceiling.

    ``str(exc)`` is a curated, user-safe message -- safe to persist directly
    as the job's error field and to stream in a ``job.error`` event without
    going through the generic exception-message sanitization used for
    unclassified errors (see ``aiq_api.jobs.runner.sanitize_job_error``).
    """

    def __init__(self, ceiling: int, used: int) -> None:
        self.ceiling = ceiling
        self.used = used
        super().__init__(f"run exceeded the configured completion-token budget of {ceiling}")


def _parse_completion_token_ceiling(raw: str | None) -> int:
    """Parse ``GRID_MAX_RUN_COMPLETION_TOKENS`` defensively.

    Mirrors the fail-safe-to-disabled parsing style used for other numeric
    env knobs in this codebase (e.g. ``GRID_DB_POOL_MAX``): missing, blank,
    unparseable, or non-positive values all fall back to disabled (0) rather
    than raising or silently picking an arbitrary default ceiling.
    """
    if raw is None or not raw.strip():
        return DISABLED_CEILING
    try:
        value = int(raw.strip())
    except ValueError:
        logger.warning(
            "Invalid %s=%r (not an integer); disabling the completion-token budget cap",
            GRID_MAX_RUN_COMPLETION_TOKENS_ENV,
            raw,
        )
        return DISABLED_CEILING
    if value <= 0:
        return DISABLED_CEILING
    return value


def _extract_completion_tokens(response: Any) -> int:
    """Extract the completion/output token count from an ``LLMResult``.

    Mirrors the extraction order ``AgentEventCallback._extract_llm_response``
    uses in ``aiq_api.jobs.callbacks`` (LangChain's standardized
    ``usage_metadata.output_tokens`` first, then the OpenAI-style
    ``response_metadata.token_usage.completion_tokens`` fallback). Returns 0
    -- never raises -- when no usage information is present (e.g. a cached or
    mocked generation), matching how the rest of this codebase treats absent
    usage data as "nothing to add" rather than an error.
    """
    try:
        generations = getattr(response, "generations", None)
        if not generations or not generations[0]:
            return 0
        gen = generations[0][0]
        msg = getattr(gen, "message", None)
        if msg is None:
            return 0

        usage_metadata = getattr(msg, "usage_metadata", None)
        if usage_metadata:
            tokens = usage_metadata.get("output_tokens")
            if isinstance(tokens, int):
                return tokens

        response_metadata = getattr(msg, "response_metadata", None) or {}
        token_usage = response_metadata.get("token_usage") or {}
        tokens = token_usage.get("completion_tokens")
        if isinstance(tokens, int):
            return tokens
    except Exception:
        logger.debug("Failed to extract completion tokens from LLM response", exc_info=True)
    return 0


class _BudgetTracker:
    """Thread-safe accumulator shared by every ``BudgetGuardCallback`` copy in one job."""

    def __init__(self, ceiling: int) -> None:
        self.ceiling = ceiling
        self._lock = threading.Lock()
        self._completion_tokens = 0
        self._exceeded = False

    @property
    def enabled(self) -> bool:
        return self.ceiling > 0

    def add_completion_tokens(self, tokens: int) -> None:
        if not self.enabled or tokens <= 0:
            return
        with self._lock:
            self._completion_tokens += tokens
            if self._completion_tokens > self.ceiling:
                self._exceeded = True

    def check(self) -> None:
        """Raise RunBudgetExceededError if a prior call already pushed usage past the ceiling."""
        if not self.enabled:
            return
        with self._lock:
            exceeded = self._exceeded
            used = self._completion_tokens
        if exceeded:
            raise RunBudgetExceededError(self.ceiling, used)

    @property
    def completion_tokens(self) -> int:
        with self._lock:
            return self._completion_tokens


class BudgetGuardCallback(BaseCallbackHandler):
    """LangChain callback enforcing a per-job completion-token ceiling.

    Add one instance to a job's callback list (see
    ``aiq_api.jobs.runner.run_agent_job``); it reaches every LLM call in the
    job the same way the existing ``AgentEventCallback``/
    ``VerboseTraceCallback`` do -- LangGraph/DeepAgents' ``task`` tool merges
    the ambient parent config (including ``callbacks``) into every subagent
    and researcher-worker invocation.
    """

    # Without this, LangChain's handle_event() logs and swallows exceptions
    # raised from callback methods instead of propagating them -- the abort
    # would silently do nothing.
    raise_error = True

    def __init__(self, tracker: _BudgetTracker) -> None:
        super().__init__()
        self._tracker = tracker

    @property
    def completion_tokens(self) -> int:
        """Completion tokens accumulated so far this job (for tests/observability)."""
        return self._tracker.completion_tokens

    def on_llm_start(self, serialized: dict | None, prompts: list, **kwargs: Any) -> None:
        self._tracker.check()

    def on_chat_model_start(self, serialized: dict | None, messages: list, **kwargs: Any) -> None:
        self._tracker.check()

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        tokens = _extract_completion_tokens(response)
        if tokens:
            self._tracker.add_completion_tokens(tokens)


def create_budget_guard_callback(ceiling: int | None = None) -> BudgetGuardCallback | None:
    """Build a job-scoped ``BudgetGuardCallback``, or ``None`` when the cap is disabled.

    Args:
        ceiling: Completion-token ceiling to enforce. Defaults to
            ``GRID_MAX_RUN_COMPLETION_TOKENS`` (parsed defensively; 0/unset
            disables the cap).
    """
    resolved_ceiling = (
        ceiling
        if ceiling is not None
        else _parse_completion_token_ceiling(os.environ.get(GRID_MAX_RUN_COMPLETION_TOKENS_ENV))
    )
    if resolved_ceiling <= 0:
        return None
    return BudgetGuardCallback(_BudgetTracker(resolved_ceiling))
