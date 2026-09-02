"""
Agent-agnostic job runner.

Provides the Dask task function for running any registered agent with:
- NAT's JobStore for job metadata and status
- SSE event streaming for real-time UI updates
- Cancellation monitoring for graceful job termination
- Phoenix/OpenTelemetry observability via NAT's ExporterManager
"""

from __future__ import annotations

import asyncio
import base64
import importlib
import json
import logging
import os
import uuid
from typing import Any

from starlette.datastructures import Headers

from aiq_agent.cards.generate import CardGenerationResult
from aiq_agent.common.turn_status import DEGRADED_CARDS_GENERATION_FAILED
from aiq_agent.project_context import ORGANIZATION_ID_HEADER
from aiq_agent.project_context import PROJECT_ID_HEADER
from aiq_agent.project_context import PROJECT_MEMORY_HEADER
from aiq_agent.project_context import USER_ID_HEADER
from aiq_agent.project_context import compose_project_context

from .callbacks import AgentEventCallback
from .conversation_output import FAILURE_NOTICE
from .conversation_output import INTERRUPTED_NOTICE
from .conversation_output import write_job_notice
from .conversation_output import write_job_turn
from .event_store import BatchingEventStore
from .event_store import EventStore
from .outcome_notify import notify_job_outcome
from .phase_events import PHASE_DONE
from .phase_events import PhaseProgressCallback
from .phase_events import emit_phase_event

logger = logging.getLogger(__name__)

# Root modules of LLM/provider client stacks — exceptions raised from these are
# classified as provider errors in sanitize_job_error().
_LLM_PROVIDER_ERROR_MODULES = frozenset(
    {
        "openai",
        "anthropic",
        "litellm",
        "langchain",
        "langchain_core",
        "langchain_openai",
        "langchain_anthropic",
        "langchain_nvidia_ai_endpoints",
    }
)

# Root modules of HTTP/transport stacks — classified as connection errors.
_NETWORK_ERROR_MODULES = frozenset({"httpx", "httpcore", "aiohttp", "requests", "urllib3"})

# langgraph is a transitive (not declared) dependency of this package — guard
# the import so error classification keeps working if it is ever absent.
try:
    from langgraph.errors import GraphRecursionError as _GraphRecursionError
except ImportError:
    _GraphRecursionError = None

# User-safe error messages for sanitize_job_error — named constants so they
# are testable and searchable.  Each category gets one curated string that
# leaks no exception-internal data (hosts, DSNs, paths, credentials).
_WALL_CLOCK_TIMEOUT_MSG = "Die Recherche hat ihr Zeitlimit erreicht und wurde ohne vollständiges Ergebnis abgebrochen."
_GENERIC_TIMEOUT_MSG = "The job timed out while waiting on an external service."
_GRAPH_RECURSION_ERROR_MSG = "Die Recherche hat ihr Schritt-Limit erreicht, ohne ein vollständiges Ergebnis zu liefern."
_LLM_PROVIDER_ERROR_MSG = "The LLM provider returned an error while running the job."
_CONNECTION_ERROR_MSG = "A connection error occurred while running the job."
_INTERNAL_ERROR_MSG = "The job failed due to an internal error."

# A run that SUCCEEDED but owes the reader a caveat gets its own job_events row
# rather than a status change: the answer is real and persisted, it is just
# marked. Same ``job.*`` lifecycle shape as job.heartbeat/job.error/job.phase,
# so the existing SSE surface streams it to clients unchanged.
JOB_DEGRADED_EVENT_TYPE = "job.degraded"

# What travels in that event: stable tokens only, never prose. The reader is
# told about a cutoff by the report's own banner, in the product's voice; this
# channel exists so a live listener and an operator counting cutoffs can see it.
_DEGRADED_EVENT_FIELDS = ("research_truncated", "truncation_reason", "degraded_reasons")

#: The request-context headers a worker supplies to the tools it runs, from
#: the run's identity. The contract `aiq_agent.project_context.
#: TOOL_CONTEXT_REQUIREMENTS` is checked against THIS tuple by
#: `tests/aiq_agent/test_tool_context_contract.py`: a tool that needs a header
#: the worker does not inject fails that test rather than every unattended run.
WORKER_IDENTITY_HEADERS: tuple[str, ...] = (PROJECT_ID_HEADER, ORGANIZATION_ID_HEADER, USER_ID_HEADER)


def _identity_values(identity: dict) -> tuple[object, object, object]:
    return (identity.get("project_id"), identity.get("organization_id"), identity.get("user_id"))


# The answer's self-assessment, lifted alongside the cutoff/degradation marks and
# spelled exactly as the socket path spells it (``persist_assistant_message``), so
# the BFF's existing decoder maps all three into the stored provenance with no
# frontend change. Deliberately NOT in _DEGRADED_EVENT_FIELDS above: a merely
# low-confidence answer is not a degraded run, and announcing one as the other
# would train operators to ignore the signal that means a run was cut off.
_ANSWER_CONFIDENCE_FIELDS = (
    "answer_confidence",
    "answer_confidence_reason",
    "answer_confidence_capped_reason",
)


def sanitize_job_error(exc: BaseException) -> str:
    """Map an internal exception to a user-safe error message.

    Raw exception text can leak hosts, DSNs, file paths, or credentials into
    the persisted ``job.error`` field and emitted ``job.error`` events, both of
    which are returned to API clients. Callers must log the full exception
    server-side (``logger.exception``) and persist/emit only this message.

    Kept informative by category (time budget / step limit / timeout /
    provider / connection / internal) without ever including the exception's
    own text.

    NOTE: cancellation paths intentionally bypass this — the UI string-matches
    the exact error "cancelled by user".
    """
    from aiq_agent.common import RunBudgetExceededError
    from aiq_agent.common.cost_tracking import BudgetExceededError

    if isinstance(exc, (RunBudgetExceededError, BudgetExceededError)):
        # Already curated, user-safe messages ("run exceeded the configured
        # completion-token budget of N"; "the organization's LLM budget is
        # exhausted … an org admin can raise limits under …") -- persist
        # verbatim. The second used to fall through to "internal error", so
        # the one failure a person could act on themselves read as a crash.
        return str(exc)

    root_module = (type(exc).__module__ or "").split(".")[0]
    if isinstance(exc, TimeoutError):
        # The deep-research wall-clock budget (max_run_seconds) is re-raised as
        # a TimeoutError carrying a "wall-clock" marker; a bare TimeoutError is
        # an external-service wait.
        if "wall-clock" in str(exc).lower():
            return _WALL_CLOCK_TIMEOUT_MSG
        return _GENERIC_TIMEOUT_MSG
    if _GraphRecursionError is not None and isinstance(exc, _GraphRecursionError):
        # A runaway graph hit recursion_limit — not an internal defect, and not
        # an LLM provider error (langgraph is deliberately not in the provider
        # module set above).
        return _GRAPH_RECURSION_ERROR_MSG
    if root_module in _LLM_PROVIDER_ERROR_MODULES:
        return _LLM_PROVIDER_ERROR_MSG
    if root_module in _NETWORK_ERROR_MODULES or isinstance(exc, (ConnectionError, OSError)):
        return _CONNECTION_ERROR_MSG
    return _INTERNAL_ERROR_MSG


async def _update_status_if_not_terminal(job_store: Any, job_id: str, status: Any, **kwargs: Any) -> bool:
    """Write a job status only if the job is not already in a terminal state.

    Terminal statuses (SUCCESS/FAILURE/INTERRUPTED) are sticky: the ghost-job
    reaper or the cancel route may have already finalized this job while the
    worker was still running, and the runner's own success/failure write must
    not overwrite that verdict (e.g. flipping a reaped FAILURE back to SUCCESS).

    Returns True if the status was written, False if it was left untouched.
    """
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    terminal_statuses = {JobStatus.SUCCESS.value, JobStatus.FAILURE.value, JobStatus.INTERRUPTED.value}
    try:
        job = await job_store.get_job(job_id)
    except Exception:
        logger.warning("Could not read current status for job %s before writing %s", job_id, status, exc_info=True)
        job = None

    if job is not None and job.status in terminal_statuses:
        logger.info(
            "Job %s already in terminal status %s; not overwriting with %s",
            job_id,
            job.status,
            status,
        )
        return False

    await job_store.update_status(job_id, status, **kwargs)
    return True


def _normalize_trace_id(trace_id: int | str | None) -> int | None:
    """Convert trace ID to integer format.

    Args:
        trace_id: Trace ID as int, hex string, or None.

    Returns:
        Integer trace ID or None.
    """
    if trace_id is None:
        return None
    if isinstance(trace_id, int):
        return trace_id
    try:
        return int(trace_id, 16)
    except ValueError:
        return int(trace_id)


class CancellationMonitor:
    """
    Monitors job status for cancellation requests.

    Polls the job store at regular intervals and sets an asyncio.Event
    when the job status changes to INTERRUPTED or FAILURE (the latter is
    written by the ghost-job reaper, which must also stop the worker).
    """

    def __init__(
        self,
        scheduler_address: str,
        db_url: str,
        job_id: str,
        poll_interval: float = 1.0,
    ):
        self.scheduler_address = scheduler_address
        self.db_url = db_url
        self.job_id = job_id
        self.poll_interval = poll_interval
        self._cancelled = asyncio.Event()
        self._monitor_task: asyncio.Task | None = None

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled.is_set()

    async def _poll_job_status(self) -> None:
        """Poll job status and set cancelled event if interrupted."""
        from nat.front_ends.fastapi.async_jobs.job_store import JobStatus
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

        job_store = JobStore(scheduler_address=self.scheduler_address, db_url=self.db_url)

        # FAILURE included: the ghost-job reaper writes FAILURE externally and
        # the worker must stop instead of running to completion against a job
        # that has already been finalized.
        stop_statuses = (JobStatus.INTERRUPTED.value, JobStatus.FAILURE.value)

        while not self._cancelled.is_set():
            try:
                job = await job_store.get_job(self.job_id)
                if job and job.status in stop_statuses:
                    logger.info("Cancellation detected for job %s (status: %s)", self.job_id, job.status)
                    self._cancelled.set()
                    break
            except Exception as e:
                logger.warning("Error checking job status for %s: %s", self.job_id, e)

            await asyncio.sleep(self.poll_interval)

    def start(self) -> None:
        """Start the cancellation monitor background task."""
        if self._monitor_task is None:
            self._monitor_task = asyncio.create_task(self._poll_job_status())
            logger.debug("Started cancellation monitor for job %s", self.job_id)

    def stop(self) -> None:
        """Stop the cancellation monitor."""
        if self._monitor_task and not self._monitor_task.done():
            self._monitor_task.cancel()
            self._monitor_task = None
            logger.debug("Stopped cancellation monitor for job %s", self.job_id)

    def check(self) -> None:
        """Check if cancelled and raise CancelledError if so."""
        if self._cancelled.is_set():
            raise asyncio.CancelledError("Job cancelled by user")


# Interval for emitting heartbeat events
HEARTBEAT_INTERVAL_SECONDS = 30


async def run_with_cancellation(
    coro,
    monitor: CancellationMonitor,
    event_store: EventStore | BatchingEventStore | None = None,
) -> Any:
    """
    Run a coroutine with cancellation monitoring and periodic heartbeats.

    Emits job.heartbeat events every 30s so the SSE stream stays alive
    and the ghost job reaper can detect dead workers.
    Raises asyncio.CancelledError if the monitor detects cancellation.
    """
    import time

    task = asyncio.create_task(coro)
    monitor.start()
    start_time = time.monotonic()
    last_heartbeat = start_time

    try:
        while not task.done():
            if monitor.is_cancelled:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                raise asyncio.CancelledError("Job cancelled by user")

            now = time.monotonic()
            if event_store and (now - last_heartbeat) >= HEARTBEAT_INTERVAL_SECONDS:
                last_heartbeat = now
                event_store.store(
                    {
                        "type": "job.heartbeat",
                        "data": {"uptime_seconds": int(now - start_time)},
                    }
                )

            await asyncio.sleep(0.1)

        return task.result()
    finally:
        monitor.stop()


def _resolve_worker_tool_refs(fn_config: Any) -> list[str]:
    """Resolve the tool refs a worker agent should build with.

    Uses the config's explicit ``tools`` list, or auto-inherits the entire
    data_source_registry when none are configured.

    The empty check is falsy (not ``is None``): agent configs declare ``tools``
    with ``default_factory=list``, so an omitted list arrives as ``[]``, never
    ``None``. A prior ``is None`` guard therefore never inherited and silently
    built a tool-less agent — the researcher workers received no source tools
    while validation elsewhere reported the inherited tools as available. This
    matches the two other resolution sites (the sync agent build in
    deep_researcher/register.py and the chat-route validator in
    chat_researcher/register.py), which both treat an empty list as "inherit".
    """
    tool_refs = getattr(fn_config, "tools", None)
    if not tool_refs:
        from aiq_agent.common import get_all_tool_refs

        return get_all_tool_refs()
    return list(tool_refs)


async def _resolve_deep_research_checkpointer(fn_config: Any) -> Any | None:
    """Build the durable checkpointer for a deep-research async job, if configured.

    Async deep-research jobs have no restart safety by default (T3-8): each
    Dask job builds a fresh in-memory-only DeepAgents graph via a new
    DeepResearcherAgent, so a worker crash mid-run loses all execution state
    -- only the SQL JobStore row survives, and the ghost-job reaper eventually
    marks it FAILURE with nothing to resume.

    When ``deep_research_agent.checkpoint_db`` is configured, this builds (and
    caches, via ``aiq_agent.common.get_checkpointer``) a durable checkpointer
    keyed by that database path/DSN. ``DeepResearcherAgent.run()`` then uses
    the job_id as the graph's thread_id, so a re-invocation of the same
    job_id resumes from the last persisted checkpoint instead of starting
    over -- see ``DeepResearcherAgent.run`` for the exact resume contract and
    its current manual-resubmit-only limitation.

    Returns None (current default behavior, no durability) for any agent
    type other than ``deep_research_agent``, or when ``checkpoint_db`` is
    unset -- both keep the prior in-memory-only, non-durable behavior.
    """
    if getattr(fn_config, "type", None) != "deep_research_agent":
        return None
    checkpoint_db = getattr(fn_config, "checkpoint_db", None)
    if not checkpoint_db:
        return None

    from aiq_agent.common import get_checkpointer

    return await get_checkpointer(checkpoint_db)


def _purge_deep_checkpoint(job_id: str) -> None:
    """Best-effort deletion of a finished deep run's durable checkpoint rows.

    The deep-research checkpointer keys ``thread_id == job_id`` in
    ``AIQ_DEEP_CHECKPOINT_DB`` and writes the full growing state every step, but
    nothing prunes ``checkpoints``/``checkpoint_blobs``/``checkpoint_writes`` — so
    they grow (superlinearly per run) forever. Once a run is terminal the
    checkpoint is dead weight (resume is manual-resubmit, never auto-read), so
    drop it. Never raises.
    """
    dsn = os.environ.get("AIQ_DEEP_CHECKPOINT_DB")
    if not dsn:
        return
    try:
        from sqlalchemy import text

        from .event_store import EventStore

        engine = EventStore._get_or_create_sync_engine(dsn)
        with engine.connect() as conn:
            for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
                # Fixed table names (LangGraph schema); the thread id is bound.
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"DELETE FROM {table} WHERE thread_id = :tid"),  # noqa: S608
                    {"tid": job_id},
                )
            conn.commit()
    except Exception:
        logger.debug("Deep checkpoint purge skipped for job %s", job_id, exc_info=True)


def _load_agent_class(agent_class_path: str) -> type:
    """
    Dynamically load an agent class from its module path.

    Args:
        agent_class_path: Full path like 'aiq_agent.agents.deep_researcher.agent.DeepResearcherAgent'

    Returns:
        The agent class.

    Raises:
        ImportError: If the module or class cannot be found.
    """
    module_path, class_name = agent_class_path.rsplit(".", 1)
    module = importlib.import_module(module_path)
    return getattr(module, class_name)


async def _create_llm_provider(builder: Any, fn_config: Any) -> tuple[Any, Any]:
    """Create a role-aware LLM provider from a NAT function config."""
    from aiq_agent.common import AgentGroup
    from aiq_agent.common import LLMProvider
    from aiq_agent.common import LLMRole
    from aiq_agent.common import get_langchain_llm

    # Agent-group tags mirror the sync registrations (deep_researcher/register.py)
    # so per-org runtime model overrides apply identically to async jobs.
    role_config_attrs = (
        (LLMRole.ORCHESTRATOR, "orchestrator_llm", AgentGroup.DEEP_RESEARCH),
        (LLMRole.ROUTER, "source_router_llm", AgentGroup.DEEP_RESEARCH_ROUTER),
        (LLMRole.PLANNER, "planner_llm", AgentGroup.DEEP_RESEARCH),
        (LLMRole.RESEARCHER, "researcher_llm", AgentGroup.DEEP_RESEARCH),
        (LLMRole.REPORT_WRITER, "writer_llm", AgentGroup.DEEP_RESEARCH),
    )
    llm_cache: dict[Any, Any] = {}
    role_llms = {}
    role_groups = {}
    for role, config_attr, group in role_config_attrs:
        llm_ref = getattr(fn_config, config_attr, None)
        if llm_ref:
            if llm_ref not in llm_cache:
                llm_cache[llm_ref] = await get_langchain_llm(builder, llm_ref)
            role_llms[role] = llm_cache[llm_ref]
            role_groups[role] = group

    default_group = AgentGroup.DEEP_RESEARCH
    default_llm = role_llms.get(LLMRole.ORCHESTRATOR)
    if default_llm is None:
        llm_ref = getattr(fn_config, "llm", None)
        if llm_ref:
            if llm_ref not in llm_cache:
                llm_cache[llm_ref] = await get_langchain_llm(builder, llm_ref)
            default_llm = llm_cache[llm_ref]
            if getattr(fn_config, "type", None) == "shallow_research_agent":
                default_group = AgentGroup.SHALLOW_RESEARCH

    provider = LLMProvider()
    provider.set_default(default_llm, group=default_group)
    for role, llm in role_llms.items():
        provider.configure(role, llm, group=role_groups.get(role))

    return provider, default_llm


def _inject_worker_headers(context_state: Any, headers: dict[str, str]) -> None:
    """Layer ``headers`` onto the worker's request metadata.

    A background worker has no inbound request, so everything a chat turn
    would read from its headers has to be placed there by hand, and every
    reader downstream (`Context.get().metadata.headers`) then works unchanged.
    Layered, not replaced: each call keeps what earlier calls put there.
    """
    request_attrs = context_state.metadata.get()
    existing = dict(request_attrs.headers) if request_attrs and request_attrs.headers else {}
    request_attrs._request.headers = Headers(headers={**existing, **headers})
    context_state.metadata.set(request_attrs)


def _workflow_reflection_llm_ref(config: Any) -> str | None:
    """The chat workflow's ``memory_reflection_llm`` ref, as a plain str, or None.

    The interactive submit path reads it off the live config and carries it in
    the job; the BFF's scheduled-job submit cannot, because only the worker
    holds the config. Same ref, resolved one step later.
    """
    workflow = getattr(config, "workflow", None)
    ref = getattr(workflow, "memory_reflection_llm", None)
    return str(ref) if ref else None


async def run_agent_job(
    configure_logging: bool,
    log_level: int,
    scheduler_address: str,
    db_url: str,
    config_file_path: str,
    job_id: str,
    input_text: str,
    agent_class_path: str,
    agent_config_name: str,
    parent_span_id: str | None = None,
    parent_function_id: str | None = None,
    parent_function_name: str | None = None,
    parent_workflow_run_id: str | None = None,
    parent_workflow_trace_id: int | str | None = None,
    parent_conversation_id: str | None = None,
    request_trace_tags: dict[str, str] | None = None,
    available_documents: list[dict] | None = None,
    data_sources: list[str] | None = None,
    auth_token: str | None = None,
    collection_scope: list[str] | None = None,
    project_context: str | None = None,
    # The project-memory digest the BFF built when the job fired. A FALLBACK:
    # the worker fetches a live digest first (a queued job may wait minutes,
    # and the reflection pass at the end of a long run wants memory as of
    # then), and keeps this one only when that fetch fails.
    project_memory: str | None = None,
    # Rendered PLATFORM_LESSONS block, carried in the job payload because
    # request contextvars do not survive into a background worker.
    platform_lessons: str | None = None,
    model_overrides: dict[str, str] | None = None,
    usage_context: dict | None = None,
    user_info: dict | None = None,
    clarifier_result: str | None = None,
    memory_reflection_enabled: bool = False,
    memory_reflection_llm: str | None = None,
    force_skills: list[str] | None = None,
):
    """
    Dask task to run any registered agent with cancellation support and telemetry.

    This function is submitted to Dask and runs in a worker process. It:
    - Uses NAT's JobStore for status tracking
    - Monitors for cancellation requests and gracefully terminates the agent
    - Exports telemetry to Phoenix/OpenTelemetry via NAT's ExporterManager
    - Propagates trace context from parent workflow for nested spans

    Args:
        configure_logging: Whether to set up logging in the worker.
        log_level: Logging level to use.
        scheduler_address: Dask scheduler address.
        db_url: Database URL for job store and event store.
        config_file_path: Path to NAT config file.
        job_id: Unique job identifier.
        input_text: User input/query to run.
        agent_class_path: Full module path to agent class.
        agent_config_name: NAT config function name for the agent.
        parent_span_id: Parent span ID for trace continuity (from caller context).
        parent_function_id: Parent function ID for span hierarchy.
        parent_function_name: Parent function name for span metadata.
        parent_workflow_run_id: Parent workflow run ID for trace grouping.
        parent_workflow_trace_id: Parent trace ID (int or hex string) for trace continuity.
        parent_conversation_id: Conversation ID for session grouping in Phoenix.
        request_trace_tags: Request trace tags captured at async submission time.
        available_documents: Optional list of document dicts with file_name and summary.
        data_sources: Optional list of allowed data sources to enforce in the worker.
        auth_token: Optional auth token propagated from the HTTP request for
            data sources that require authentication (requires_auth: true).
        collection_scope: Optional list of collection names to scope knowledge
            retrieval to. Injected into the worker's request metadata so that
            ``get_collection_scope_from_context()`` returns the correct scope.
        project_context: Optional project context string to inject into the
            worker's request metadata so that
            ``get_project_context_from_context()`` returns the correct context.
        model_overrides: Optional per-org runtime model overrides
            (``{agent_group: openrouter_model_id}``) captured from the
            submitting request's ``X-Grid-Model-Overrides`` header. Applied to
            the worker's LLM provider and re-injected into the worker's request
            metadata so ``get_model_overrides_from_context()`` stays correct.
        usage_context: Optional identity + budget snapshot captured at submit
            time (``capture_usage_context()``), used to activate unified LLM
            cost tracking for the whole job.
        user_info: Optional user identity dict (name/email) forwarded onto the
            agent state so prompts render the authenticated-user context.
        clarifier_result: Optional clarifier dialog log forwarded onto the
            agent state so prompts render the Clarification Context section.
        memory_reflection_enabled: Whether the post-answer memory-reflection
            stage should run over this job's report. Captured from the
            submitting request's feature flag (the worker has no live request to
            read it from). Only honored for jobs that also supply
            ``memory_reflection_llm``.
        memory_reflection_llm: Optional ``llms:`` ref (e.g. ``card_llm``) for the
            reflection pass. When set (and enabled), the worker reflects over the
            finished report to record durable project findings — the chat path
            skips reflection for deep jobs because the report only exists once
            the async job completes.
        force_skills: Optional list of skill names the agent run must
            force-activate. Injected onto the agent state as ``force_skills``
            where the state model declares the field — the same guarded path
            ``data_sources``/``project_context`` take (Agent Skills feature;
            the state-field consumer is added by ``src/aiq_agent``).
    """

    # Propagate auth token into the current async task's context so tools
    # can retrieve it via get_auth_token(). Uses a ContextVar so concurrent
    # jobs in the same Dask worker process don't leak tokens across tasks.
    _auth_token_reset = None
    if auth_token:
        from ._auth_context import job_auth_token

        _auth_token_reset = job_auth_token.set(auth_token)

    from aiq_api.auth.request_trace import install_request_trace_span_injection
    from aiq_api.auth.request_trace import request_trace_tag_context

    install_request_trace_span_injection()

    from aiq_agent.common import VerboseTraceCallback
    from aiq_agent.common import is_verbose
    from nat.builder.framework_enum import LLMFrameworkEnum
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus
    from nat.front_ends.fastapi.async_jobs.job_store import JobStore
    from nat.runtime.loader import load_config

    if configure_logging:
        try:
            from nat.utils.log_utils import setup_logging

            setup_logging(log_level)
        except ImportError:
            import logging as std_logging

            std_logging.basicConfig(level=log_level)

    # Quiet NAT's per-parallel-step span-stack warnings in the worker too —
    # deep research's concurrent researcher/tool fan-out triggers them on
    # essentially every parallel call (see logging_utils for details).
    from aiq_agent.common.logging_utils import suppress_noisy_dependency_logs

    suppress_noisy_dependency_logs()

    job_store: JobStore | None = None
    cancellation_monitor: CancellationMonitor | None = None
    event_store: EventStore | BatchingEventStore | None = None
    logger.info(
        "Dask worker received: agent=%s, config=%s, job_id=%s",
        agent_class_path,
        agent_config_name,
        job_id,
    )

    try:
        job_store = JobStore(scheduler_address=scheduler_address, db_url=db_url)
        # Guard the RUNNING write: a cancel (INTERRUPTED) or the ghost reaper
        # (FAILURE) may have already finalized this job in the race window
        # between claim and here. An unconditional write would resurrect a
        # reaped job or silently lose a cancel (esp. in db-execution mode, where
        # cancel deletes the queue row and this status flip is the only signal).
        if not await _update_status_if_not_terminal(job_store, job_id, JobStatus.RUNNING):
            logger.info("Job %s already terminal before start; aborting run", job_id)
            return

        cancellation_monitor = CancellationMonitor(
            scheduler_address=scheduler_address,
            db_url=db_url,
            job_id=job_id,
            poll_interval=1.0,
        )

        config = load_config(config_file_path)

        # Dynamically load the agent class
        agent_cls = _load_agent_class(agent_class_path)

        async with WorkflowBuilder.from_config(config=config) as builder:
            fn_config = builder.get_function_config(agent_config_name)
            if getattr(fn_config, "type", None) == "deep_research_agent":
                from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig
                from aiq_agent.agents.deep_researcher.register import resolve_deep_research_runtime_config

                if isinstance(fn_config, DeepResearchAgentConfig):
                    skills_config, sandbox_config = resolve_deep_research_runtime_config(fn_config, builder)
                    fn_config = fn_config.model_copy(update={"skills": skills_config, "sandbox": sandbox_config})

            provider, llm = await _create_llm_provider(builder, fn_config)

            # Apply per-org runtime model overrides captured at submission time.
            # Done directly on the provider (not only via the header injection
            # below) so the override holds regardless of when the agent class
            # resolves its LLMs relative to context setup.
            if model_overrides:
                from aiq_agent.common import LLMRole
                from aiq_agent.common import sanitize_model_overrides

                sanitized_overrides = sanitize_model_overrides(model_overrides)
                overridden = provider.with_model_overrides(sanitized_overrides)
                if overridden is not provider:
                    provider = overridden
                    if llm is not None:
                        llm = provider.get(LLMRole.ORCHESTRATOR)

            # The tenant this job belongs to, captured at submit time inside
            # usage_context because a Dask worker has no request headers to read
            # it from. Two things need it: BYOK below, and the agent state
            # handed to _run_agent (deep research resolves the organization's
            # skills from it).
            #
            # BYOK (ADR-0022): resolve the org's own LLM credential just in
            # time from the BFF (never carried in job_args — plaintext keys
            # must not enter the persisted job store); resolution fails open to
            # the platform credential.
            _job_org_id = ((usage_context or {}).get("identity") or {}).get("organization_id")
            # Captured for the post-job reflection pass, which builds its own LLM
            # outside the provider and must re-apply the same tenant credential.
            resolved_org_credential = None
            if _job_org_id:
                from aiq_agent.common import LLMRole
                from aiq_agent.common import resolve_org_llm_credential

                org_credential = resolve_org_llm_credential(_job_org_id)
                resolved_org_credential = org_credential
                if org_credential is not None:
                    credentialed = provider.with_credential(org_credential)
                    if credentialed is not provider:
                        provider = credentialed
                        if llm is not None:
                            llm = provider.get(LLMRole.ORCHESTRATOR)

            # Resolve tools: use the explicit list or auto-inherit the whole
            # data_source_registry when none are configured.
            tool_refs = _resolve_worker_tool_refs(fn_config)

            tools = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)

            # Apply per-agent exclusions (e.g. deep_research excludes web_search_tool)
            if hasattr(fn_config, "exclude_tools") and fn_config.exclude_tools:
                excluded = set(fn_config.exclude_tools)
                tools = [t for t in tools if getattr(t, "name", "") not in excluded]

            if data_sources is not None:
                from aiq_agent.common import filter_tools_by_sources

                tools = filter_tools_by_sources(tools, data_sources)

            # Set up telemetry/observability for Phoenix and OpenTelemetry
            from aiq_agent.common.nat_step_repair import SpanClosingProfilerHandler
            from nat.builder.context import Context
            from nat.builder.context import ContextState
            from nat.data_models.intermediate_step import IntermediateStepPayload
            from nat.data_models.intermediate_step import IntermediateStepType
            from nat.data_models.intermediate_step import StreamEventData
            from nat.data_models.intermediate_step import TraceMetadata
            from nat.data_models.invocation_node import InvocationNode
            from nat.observability.exporter_manager import ExporterManager
            from nat.utils.reactive.subject import Subject

            telemetry_exporters = {
                name: configured.instance for name, configured in builder._telemetry_exporters.items()
            }
            exporter_manager = ExporterManager.from_exporters(telemetry_exporters)

            # Initialize context state with trace propagation from parent
            context_state = ContextState.get()
            context_state.workflow_run_id.set(job_id)
            if parent_conversation_id:
                context_state.conversation_id.set(parent_conversation_id)

            workflow_trace_id = _normalize_trace_id(parent_workflow_trace_id) or uuid.uuid4().int
            context_state.workflow_trace_id.set(workflow_trace_id)

            # Event stream for exporters to subscribe to
            event_stream = Subject()
            context_state.event_stream.set(event_stream)

            # Initialize span stack (triggers default ["root"])
            _ = context_state.active_span_id_stack

            # Set up span hierarchy metadata
            workflow_span_name = f"async_job:{agent_config_name}"
            context_state.active_function.set(
                InvocationNode(
                    function_name=workflow_span_name,
                    function_id=job_id,
                    parent_id=parent_function_id,
                    parent_name=parent_function_name,
                )
            )

            context = Context(context_state)

            # Inject collection-scope header into the worker's request metadata
            # so downstream code can read it the same way synchronous HTTP/WebSocket
            # requests do: Context.get().metadata.headers.get("x-grid-collection-scope")
            if collection_scope is not None:
                request_attrs = context_state.metadata.get()
                encoded = base64.urlsafe_b64encode(json.dumps(collection_scope).encode()).rstrip(b"=").decode()
                existing_headers = dict(request_attrs.headers) if request_attrs and request_attrs.headers else {}
                request_attrs._request.headers = Headers(
                    headers={**existing_headers, "x-grid-collection-scope": encoded}
                )
                context_state.metadata.set(request_attrs)
            elif getattr(fn_config, "type", None) == "deep_research_agent":
                # Audit-confirmed silent fallback: with no collection scope,
                # get_collection_scope_from_context() returns None and knowledge-retrieval
                # tools fall back to searching only the base/OIB collection plus the
                # s_<conversation> session collection for the rest of this job — any
                # project-specific collection is invisible, with no other user-facing
                # signal that it happened. Logged once per job (this branch runs once per
                # run_agent_job call, not per retrieval) so the degradation is diagnosable.
                _identity = (usage_context or {}).get("identity") or {}
                logger.warning(
                    "Job %s: async deep-research job has no collection scope; knowledge "
                    "retrieval will search only the base/OIB and s_<conversation> session "
                    "collections for this job — project collections will be invisible "
                    "(authenticated=%s, project_scoped=%s)",
                    job_id,
                    bool(_identity.get("organization_id") or _identity.get("user_id")),
                    bool(_identity.get("project_id") or project_context),
                )

            if project_context is not None:
                from aiq_agent.project_context import normalize_project_context

                normalized = normalize_project_context(project_context)
                if normalized:
                    request_attrs = context_state.metadata.get()
                    existing_headers = dict(request_attrs.headers) if request_attrs and request_attrs.headers else {}
                    request_attrs._request.headers = Headers(
                        headers={**existing_headers, "x-grid-project-context": normalized}
                    )
                    context_state.metadata.set(request_attrs)

            # Re-inject the model-overrides header so any code that reads
            # get_model_overrides_from_context() inside the worker sees the
            # same overrides as the submitting request.
            if model_overrides:
                from aiq_agent.common import MODEL_OVERRIDES_HEADER

                request_attrs = context_state.metadata.get()
                encoded = base64.urlsafe_b64encode(json.dumps(model_overrides).encode()).rstrip(b"=").decode()
                existing_headers = dict(request_attrs.headers) if request_attrs and request_attrs.headers else {}
                request_attrs._request.headers = Headers(headers={**existing_headers, MODEL_OVERRIDES_HEADER: encoded})
                context_state.metadata.set(request_attrs)

            # WHO this job runs for. The chat path sets these on the WebSocket
            # upgrade and every project-scoped tool reads them back through
            # `get_project_id_from_context()`; a worker had none, so `remember`
            # answered "no project in scope" on every deep-research run and the
            # memory the run should have kept was never written.
            _identity = (usage_context or {}).get("identity") or {}
            _identity_headers = {
                name: value
                for name, value in zip(WORKER_IDENTITY_HEADERS, _identity_values(_identity), strict=True)
                if isinstance(value, str) and value.strip()
            }
            if _identity_headers:
                _inject_worker_headers(context_state, _identity_headers)

            # WHAT the project already knows. The chat path fetches a live digest
            # per turn and falls back to the connection-time one only on failure
            # (chat_researcher/register.py); the same discipline here, with the
            # BFF-built `project_memory` as the frozen fallback. A successful
            # fetch is authoritative even when empty — memory may have been
            # cleared since the job fired.
            memory_digest = project_memory
            if _identity.get("project_id") or _identity.get("organization_id"):
                try:
                    from aiq_agent.knowledge.project_memory import fetch_memory_digest

                    memory_digest = await asyncio.to_thread(
                        fetch_memory_digest,
                        project_id=_identity.get("project_id"),
                        organization_id=_identity.get("organization_id"),
                        query=input_text,
                    )
                except Exception:
                    logger.warning(
                        "Job %s: live memory digest fetch failed; using the digest from submit time",
                        job_id,
                        exc_info=True,
                    )
            if memory_digest:
                _inject_worker_headers(
                    context_state,
                    {PROJECT_MEMORY_HEADER: base64.urlsafe_b64encode(memory_digest.encode()).rstrip(b"=").decode()},
                )
            # The agent state gets what a chat turn gets: profile and memory,
            # composed the way `get_project_context_from_context()` composes them.
            agent_project_context = compose_project_context(project_context, memory_digest)

            workflow_metadata = TraceMetadata(
                provided_metadata={
                    "workflow_run_id": job_id,
                    "workflow_trace_id": f"{workflow_trace_id:032x}",
                    "conversation_id": parent_conversation_id,
                    "agent": agent_class_path,
                    "parent_workflow_run_id": parent_workflow_run_id,
                    "parent_workflow_name": parent_function_name,
                }
            )

            # Run with telemetry - exporter must start before pushing events
            with request_trace_tag_context(request_trace_tags or {}):
                async with exporter_manager.start(context_state=context_state):
                    # Link to parent span if provided (for nested trace continuity)
                    parent_metadata: TraceMetadata | None = None
                    if parent_span_id and parent_span_id != "root":
                        parent_metadata = TraceMetadata(
                            provided_metadata={
                                "workflow_run_id": parent_workflow_run_id,
                                "workflow_trace_id": f"{workflow_trace_id:032x}",
                                "conversation_id": parent_conversation_id,
                                "workflow_name": parent_function_name,
                            }
                        )
                        context.intermediate_step_manager.push_intermediate_step(
                            IntermediateStepPayload(
                                UUID=parent_span_id,
                                event_type=IntermediateStepType.SPAN_START,
                                name=parent_function_name or "parent_workflow",
                                metadata=parent_metadata,
                            )
                        )

                    # Push WORKFLOW_START first so LLM/tool events become children
                    context.intermediate_step_manager.push_intermediate_step(
                        IntermediateStepPayload(
                            UUID=job_id,
                            event_type=IntermediateStepType.WORKFLOW_START,
                            name=workflow_span_name,
                            metadata=workflow_metadata,
                            data=StreamEventData(input=input_text),
                        )
                    )

                    # Create profiler callback AFTER workflow starts (ensures correct parent).
                    # SpanClosingProfilerHandler closes errored LLM/tool spans (missing
                    # on_llm_error/on_tool_error upstream orphan a frame on retry, corrupting
                    # IntermediateStepManager's span stack) and supports for_new_run() so it
                    # gets a fresh instance per researcher worker like VerboseTraceCallback.
                    nat_profiler_callback = SpanClosingProfilerHandler()

                    verbose = is_verbose(getattr(fn_config, "verbose", False))
                    callbacks = [VerboseTraceCallback()] if verbose else []

                    raw_event_store = EventStore(db_url, job_id)
                    event_store = BatchingEventStore(raw_event_store)
                    agent_event_callback = AgentEventCallback(event_store)
                    callbacks.append(agent_event_callback)
                    callbacks.append(nat_profiler_callback)

                    # Phase-progress events (T4-4) and the completion-token budget
                    # cap are deep-research-specific: only that agent has the
                    # planner/researcher/writer subagent structure the phase
                    # detector understands, and long-running fan-out research is
                    # the run-away-cost shape the budget cap exists for.
                    is_deep_research_job = getattr(fn_config, "type", None) == "deep_research_agent"
                    if is_deep_research_job:
                        callbacks.append(
                            PhaseProgressCallback(
                                event_store,
                                max_research_concurrency=getattr(fn_config, "max_research_concurrency", None),
                            )
                        )

                        from aiq_agent.common import create_budget_guard_callback

                        budget_guard_callback = create_budget_guard_callback()
                        if budget_guard_callback is not None:
                            callbacks.append(budget_guard_callback)

                    # Durable checkpointing (T3-8): None unless deep_research_agent.checkpoint_db is
                    # configured, in which case DeepResearcherAgent resumes via job_id as thread_id.
                    checkpointer = await _resolve_deep_research_checkpointer(fn_config)

                    # Instantiate agent with callbacks
                    agent = _create_agent_instance(
                        agent_cls=agent_cls,
                        llm_provider=provider,
                        llm=llm,
                        tools=tools,
                        fn_config=fn_config,
                        verbose=verbose,
                        callbacks=callbacks,
                        job_id=job_id,
                        checkpointer=checkpointer,
                    )

                    # Run agent - LLM/tool events will be nested under workflow span.
                    # Unified LLM cost tracking covers every model call in the job;
                    # identity/budget were captured at submit time (no live request
                    # headers exist inside a Dask worker).
                    from aiq_agent.common.cost_tracking import BudgetSnapshot
                    from aiq_agent.common.cost_tracking import track_llm_costs
                    from aiq_agent.common.profiler import track_agent_profile

                    _usage = usage_context or {}
                    with (
                        track_agent_profile(
                            agent_name="deep_research_job",
                            job_id=job_id,
                            identity=_usage.get("identity") or {},
                        ),
                        track_llm_costs(
                            job_id=job_id,
                            identity=_usage.get("identity") or {},
                            budget=BudgetSnapshot.from_header(_usage.get("budget_header")) or BudgetSnapshot(),
                        ),
                    ):
                        result = await _run_agent(
                            agent=agent,
                            input_text=input_text,
                            monitor=cancellation_monitor,
                            available_documents=available_documents,
                            data_sources=data_sources,
                            event_store=event_store,
                            user_info=user_info,
                            clarifier_result=clarifier_result,
                            project_context=agent_project_context,
                            platform_lessons=platform_lessons,
                            force_skills=force_skills,
                            organization_id=_job_org_id,
                        )

                    # Emit WORKFLOW_END event for Phoenix
                    context.intermediate_step_manager.push_intermediate_step(
                        IntermediateStepPayload(
                            UUID=job_id,
                            event_type=IntermediateStepType.WORKFLOW_END,
                            name=workflow_span_name,
                            metadata=workflow_metadata,
                            data=StreamEventData(output=_extract_result(result)),
                        )
                    )

                    if parent_metadata:
                        context.intermediate_step_manager.push_intermediate_step(
                            IntermediateStepPayload(
                                UUID=parent_span_id,
                                event_type=IntermediateStepType.SPAN_END,
                                name=parent_function_name or "parent_workflow",
                                metadata=parent_metadata,
                            )
                        )

                    # Signal event stream completion
                    event_stream.on_complete()

                    # Extract report and update status inside the context manager
                    # so the UI sees completion before exporter flush and cleanup
                    report = _extract_result(result)

                    # Generate Grid response cards from the final report and
                    # re-emit the report artifact with the cards attached.
                    # Best-effort and additive: card failures never fail the job.
                    cards_result = await _generate_grid_cards(llm, input_text, report)
                    cards = cards_result.cards
                    if cards:
                        # Card delivery is additive and must never flip an
                        # already-complete job to FAILURE — the report is done
                        # and persisted below regardless of this emit.
                        try:
                            agent_event_callback.emit_final_report(report, cards=cards)
                        except Exception:
                            logger.warning("Job %s: failed to emit final report with cards (non-fatal)", job_id)

                    # Capture durable project findings from the finished report.
                    # The chat path runs this post-answer for shallow/meta turns
                    # but skips deep jobs (the report exists only now). Awaited,
                    # guarded, and fail-open — the user already has the report, so
                    # this never affects the job outcome, only its bookkeeping.
                    await _run_deep_research_reflection(
                        builder=builder,
                        job_id=job_id,
                        # A scheduled job's submitter (the BFF) knows the flag but
                        # not the config's LLM ref; the worker has the config.
                        reflection_llm_ref=memory_reflection_llm or _workflow_reflection_llm_ref(config),
                        reflection_enabled=memory_reflection_enabled,
                        query=input_text,
                        report=report,
                        usage_context=usage_context,
                        memory_digest=memory_digest,
                        org_credential=resolved_org_credential,
                        model_overrides=model_overrides,
                    )

                    # The marks the run left on its own answer (cut off, degraded,
                    # citations stripped). Lifted here, one step before the job is
                    # finalized, so both surfaces get them from the same read:
                    # the persisted output below and the live event just under it.
                    # Guarded exactly like the card emit above — this is
                    # bookkeeping ABOUT a finished answer and must never unmake it.
                    transparency: dict[str, Any] = {}
                    try:
                        transparency = _extract_answer_transparency(result)
                        # Post-hoc card generation is the runner's own step, so
                        # its failure is recorded here rather than by the agent:
                        # the report is whole, the proposals derived from it are
                        # missing, and the reader is told which of the two it is.
                        if cards_result.failed:
                            _mark_degraded(transparency, DEGRADED_CARDS_GENERATION_FAILED)
                        if event_store is not None and (
                            transparency.get("research_truncated") or transparency.get("degraded_reasons")
                        ):
                            # Its own event, deliberately NOT a status change: the
                            # run SUCCEEDED, it just succeeded with a marked
                            # answer. A live SSE listener would otherwise learn
                            # nothing until it went back and re-read the finished
                            # job's output — so the reader who watched the stream
                            # all the way to the end is precisely the one who
                            # would never be told the answer was salvaged.
                            # Payload is stable tokens only (no prose): the
                            # reader's caveat rides the report's own banner, in
                            # the product's voice.
                            event_store.store(
                                {
                                    "type": JOB_DEGRADED_EVENT_TYPE,
                                    "data": {
                                        key: transparency[key] for key in _DEGRADED_EVENT_FIELDS if key in transparency
                                    },
                                }
                            )
                    except Exception:
                        logger.warning(
                            "Job %s: failed to record answer transparency (non-fatal)", job_id, exc_info=True
                        )

                    if is_deep_research_job:
                        emit_phase_event(event_store, PHASE_DONE)

                    # Flush any buffered events before updating status
                    if hasattr(event_store, "flush"):
                        event_store.flush()

                    # The answer's structured provenance, read once and handed to
                    # BOTH surfaces below: the job output feeds the live Report
                    # panel, the message metadata feeds the thread on reload. A
                    # source list — or a cutoff mark — that reached only one of
                    # them is the bug this closes, one layer up.
                    verified_sources = _extract_verified_sources(result)
                    output = _build_job_output(report, cards=cards, transparency=transparency, sources=verified_sources)
                    # Sticky terminal statuses: never flip a job the reaper or
                    # cancel route already finalized (FAILURE/INTERRUPTED) back
                    # to SUCCESS.
                    finalized = await _update_status_if_not_terminal(
                        job_store, job_id, JobStatus.SUCCESS, output=output
                    )
                    # A job with `output: 'chat'` was given a conversation when
                    # it fired; this is what puts the run INTO it, so somebody
                    # can open the thread and keep typing. Best-effort by
                    # contract: the report is already stored on the job above,
                    # and a conversation write must never unmake a good run.
                    await write_job_turn(
                        conversation_id=parent_conversation_id,
                        job_id=job_id,
                        usage_context=usage_context,
                        prompt=input_text,
                        answer=report,
                        cards=cards,
                        skills_activated=_extract_skills_activated(result),
                        sources=verified_sources,
                        # The same transparency dict the job output above got.
                        # The Report panel reads that output; the thread reads
                        # only this row, so a run cut off at the wall clock and
                        # salvaged would otherwise reopen tomorrow as a clean
                        # answer — the caveat surviving exactly as long as the
                        # live panel stayed open, which is not what "persisted"
                        # is supposed to mean.
                        transparency=transparency,
                    )
                    # Tell the job's creator. Only when THIS run wrote the
                    # terminal status: a job the reaper already finalized was
                    # reported by nobody, and will not be reported twice here.
                    if finalized:
                        await notify_job_outcome(
                            job_id=job_id,
                            usage_context=usage_context,
                            status="success",
                            report=report,
                            cards=cards,
                        )
                    logger.info(
                        "Job %s completed (report: %d chars, cards: %d)",
                        job_id,
                        len(report),
                        len(cards) if cards else 0,
                    )

    except asyncio.CancelledError:
        logger.info("Job %s cancelled", job_id)
        if job_store:
            try:
                # Sticky terminal statuses: don't overwrite a FAILURE (reaper)
                # or SUCCESS either — only mark still-active jobs INTERRUPTED.
                # The "cancelled by user" error string is exact: the UI
                # string-matches on it.
                finalized = await _update_status_if_not_terminal(
                    job_store, job_id, JobStatus.INTERRUPTED, error="cancelled by user"
                )
            except (ConnectionError, TimeoutError, RuntimeError):
                finalized = False
        else:
            finalized = False

        await write_job_notice(
            conversation_id=parent_conversation_id,
            job_id=job_id,
            usage_context=usage_context,
            notice=INTERRUPTED_NOTICE,
        )
        if finalized:
            await notify_job_outcome(job_id=job_id, usage_context=usage_context, status="interrupted")

        if event_store is None:
            event_store = BatchingEventStore(EventStore(db_url, job_id))

        event_store.store(
            {
                "type": "job.cancelled",
                "data": {"reason": "cancelled by user"},
            }
        )
        if hasattr(event_store, "flush"):
            event_store.flush()

    except Exception as e:
        # Full exception (with traceback) is logged server-side; only the
        # sanitized, user-safe message is persisted and streamed to clients.
        logger.exception("Job %s failed: %s", job_id, type(e).__name__)
        safe_error = sanitize_job_error(e)
        finalized = False
        if job_store:
            # Sticky terminal statuses: don't clobber an INTERRUPTED/FAILURE
            # verdict written by the cancel route or the ghost-job reaper.
            finalized = await _update_status_if_not_terminal(job_store, job_id, JobStatus.FAILURE, error=safe_error)
        # The conversation was created when the job FIRED, before the outcome
        # was known. Left alone, a failed run leaves a thread somebody opens to
        # find completely empty, which reads as a broken product rather than a
        # failed run.
        await write_job_notice(
            conversation_id=parent_conversation_id,
            job_id=job_id,
            usage_context=usage_context,
            notice=FAILURE_NOTICE,
        )
        if finalized:
            await notify_job_outcome(job_id=job_id, usage_context=usage_context, status="failure", error=safe_error)

        if event_store is None:
            event_store = BatchingEventStore(EventStore(db_url, job_id))

        event_store.store(
            {
                "type": "job.error",
                "data": {
                    "error": safe_error,
                    "error_type": type(e).__name__,
                },
            }
        )
        if hasattr(event_store, "flush"):
            event_store.flush()

    finally:
        # Ensure terminal-path events are not left in the batch buffer.
        if event_store is not None and hasattr(event_store, "flush"):
            event_store.flush()
        if cancellation_monitor:
            cancellation_monitor.stop()
        # Clean up job-scoped auth token
        if _auth_token_reset is not None:
            from ._auth_context import job_auth_token

            job_auth_token.reset(_auth_token_reset)
        # Drop the job's URL dedup caches: they are class-level dicts keyed by
        # job_id and otherwise accumulate for the life of the worker process.
        AgentEventCallback.cleanup_job_urls(job_id)
        # Drop the run's durable deep-checkpoint rows (AIQ_DEEP_CHECKPOINT_DB,
        # thread_id == job_id) once the run is terminal, so they don't grow
        # forever.  Both the Dask (this file) and DB-queue (worker.py) paths
        # run this; the worker-path call is idempotent with this one.
        _purge_deep_checkpoint(job_id)


def _create_agent_instance(
    agent_cls: type,
    llm_provider,
    llm,
    tools: list,
    fn_config,
    verbose: bool,
    callbacks: list,
    job_id: str | None = None,
    checkpointer: Any | None = None,
):
    """
    Create an agent instance, supporting different constructor patterns.

    Tries in order:
    1. llm_provider + tools pattern (DeepResearcherAgent style)
    2. llm + tools pattern (simpler agents)
    """
    from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig

    if isinstance(fn_config, DeepResearchAgentConfig):
        return agent_cls(
            llm_provider=llm_provider,
            tools=tools,
            verbose=verbose,
            callbacks=callbacks,
            domain_catalog_path=fn_config.domain_catalog_path,
            enable_source_router=fn_config.enable_source_router,
            enable_citation_verification=fn_config.enable_citation_verification,
            skills=fn_config.skills,
            sandbox=fn_config.sandbox,
            job_id=job_id,
            max_research_concurrency=fn_config.max_research_concurrency,
            max_concurrent_source_tool_calls=fn_config.max_concurrent_source_tool_calls,
            max_source_tool_batch_size=fn_config.max_source_tool_batch_size,
            max_run_seconds=fn_config.max_run_seconds,
            checkpointer=checkpointer,
        )

    # Try original deep_researcher pattern (llm_provider + tools + verbose)
    try:
        return agent_cls(
            llm_provider=llm_provider,
            tools=tools,
            verbose=verbose,
            callbacks=callbacks,
        )
    except TypeError:
        pass

    # Try llm_provider + tools pattern (ShallowResearcherAgent style)
    try:
        return agent_cls(
            llm_provider=llm_provider,
            tools=tools,
            max_tool_iterations=getattr(fn_config, "max_tool_iterations", 5),
            callbacks=callbacks,
        )
    except TypeError:
        pass

    # Try simpler llm + tools pattern
    try:
        return agent_cls(
            llm=llm,
            tools=tools,
            callbacks=callbacks,
        )
    except TypeError:
        pass

    # Fallback: just callbacks
    return agent_cls(callbacks=callbacks)


async def _run_agent(
    agent,
    input_text: str,
    monitor: CancellationMonitor,
    available_documents: list[dict] | None = None,
    data_sources: list[str] | None = None,
    event_store: EventStore | None = None,
    user_info: dict | None = None,
    clarifier_result: str | None = None,
    project_context: str | None = None,
    platform_lessons: str | None = None,
    force_skills: list[str] | None = None,
    organization_id: str | None = None,
) -> Any:
    """
    Run the agent, supporting different run() signatures.

    Tries:
    1. run(input_text: str) -> str (simple protocol)
    2. run(state) where state has messages (LangGraph pattern)
    """
    from langchain_core.messages import HumanMessage

    # Check if agent has a simple run(input_text) method
    if hasattr(agent, "run"):
        import inspect

        sig = inspect.signature(agent.run)
        params = list(sig.parameters.keys())

        # If first param is 'input_text' or 'query', use simple pattern
        if params and params[0] in ("input_text", "query", "input"):
            return await run_with_cancellation(
                agent.run(input_text),
                monitor,
                event_store=event_store,
            )

        # Otherwise assume state-based pattern
        # Try to find the agent's state class
        state_cls = _get_agent_state_class(agent)
        if state_cls:
            # Build state with available_documents if the class supports it
            state_kwargs = {"messages": [HumanMessage(content=input_text)]}
            if data_sources is not None:
                state_kwargs["data_sources"] = data_sources
            # Mirror the synchronous chat path: prompts read these off the
            # agent state, so async jobs must carry them too. Guarded by
            # field support so non-research agents keep working unchanged.
            state_fields = getattr(state_cls, "model_fields", {})
            for field_name, field_value in (
                ("user_info", user_info),
                ("clarifier_result", clarifier_result),
                ("project_context", project_context),
                ("platform_lessons", platform_lessons),
                ("force_skills", force_skills),
                # No request headers exist in a Dask worker, so an agent that
                # resolves per-tenant data (deep research resolves the org's
                # skills) cannot read the organization off the context the way
                # the synchronous chat path does. It was captured at submit
                # time; hand it over the same way as the fields above.
                ("organization_id", organization_id),
            ):
                if field_value is not None and field_name in state_fields:
                    state_kwargs[field_name] = field_value
            if available_documents:
                # Convert dicts to AvailableDocument if the state class expects them
                try:
                    from aiq_agent.knowledge import AvailableDocument

                    state_kwargs["available_documents"] = [AvailableDocument(**doc) for doc in available_documents]
                    logger.debug(
                        "Dask worker passing %d available documents to agent state",
                        len(available_documents),
                    )
                except (ImportError, TypeError):
                    # AvailableDocument not available or state doesn't support it
                    pass
            state = state_cls(**state_kwargs)
        else:
            # Fallback: create a simple dict state
            state = {"messages": [HumanMessage(content=input_text)]}
            if data_sources is not None:
                state["data_sources"] = data_sources
            if available_documents:
                state["available_documents"] = available_documents
            if user_info is not None:
                state["user_info"] = user_info
            if clarifier_result is not None:
                state["clarifier_result"] = clarifier_result
            if project_context is not None:
                state["project_context"] = project_context
            if platform_lessons is not None:
                state["platform_lessons"] = platform_lessons
            if force_skills is not None:
                state["force_skills"] = force_skills

        return await run_with_cancellation(
            agent.run(state),
            monitor,
            event_store=event_store,
        )

    raise TypeError(f"Agent {type(agent).__name__} does not have a run method")


def _get_agent_state_class(agent) -> type | None:
    """Try to find the state class for an agent."""
    agent_module = type(agent).__module__
    agent_name = type(agent).__name__

    # Try common patterns for state class names
    # e.g., DeepResearcherAgent -> DeepResearchAgentState, DeepResearcherAgentState
    state_name_patterns = [
        "AgentState",
        f"{agent_name}State",
        f"{agent_name.replace('Agent', '')}AgentState",  # DeepResearcher -> DeepResearcherAgentState
        f"{agent_name.replace('erAgent', '')}AgentState",  # DeepResearcherAgent -> DeepResearchAgentState
        "State",
    ]

    # Try models submodule first
    try:
        models_module = importlib.import_module(agent_module.replace(".agent", ".models"))
        for state_name in state_name_patterns:
            if hasattr(models_module, state_name):
                return getattr(models_module, state_name)

        # Also scan for any class ending with "State" that has a messages field
        for name in dir(models_module):
            if name.endswith("State") and not name.startswith("_"):
                cls = getattr(models_module, name)
                if isinstance(cls, type) and hasattr(cls, "model_fields"):
                    if "messages" in cls.model_fields:
                        return cls
    except (ImportError, AttributeError):
        pass

    # Try same module
    try:
        module = importlib.import_module(agent_module)
        for state_name in state_name_patterns:
            if hasattr(module, state_name):
                return getattr(module, state_name)
    except ImportError:
        pass

    return None


async def _generate_grid_cards(llm: Any, query: str, report: str) -> CardGenerationResult:
    """Generate Grid response cards from the final report.

    Best-effort: never raises, so card generation can never crash or fail the
    job. It does say when it LOST — ``failed`` on the result — because a run
    whose card model timed out used to look exactly like a run whose report
    warranted no proposals, and the reader had no way to ask for them again.
    """
    try:
        from aiq_agent.cards.generate import generate_cards_result

        result = await generate_cards_result(llm, query, report)
        if result.cards:
            logger.info("Generated %d Grid card(s) for deep-research report", len(result.cards))
        return result
    except Exception as e:
        logger.warning("Grid card generation failed (non-fatal): %s", e)
        return CardGenerationResult(cards=None, failed=True)


def _mark_degraded(transparency: dict[str, Any], reason: str) -> None:
    """Add one degraded-reason token to an answer's transparency, in place.

    Appends rather than replaces: the agent's own reasons (no report file, no
    valid citation) are already there, in its order, and this is one more thing
    the reader should know, not a different claim about the run.
    """
    existing = transparency.get("degraded_reasons")
    reasons = [token for token in existing if isinstance(token, str)] if isinstance(existing, list) else []
    if reason not in reasons:
        reasons.append(reason)
    transparency["degraded_reasons"] = reasons


async def _run_deep_research_reflection(
    *,
    builder: Any,
    job_id: str,
    reflection_llm_ref: str | None,
    reflection_enabled: bool,
    query: str,
    report: str,
    usage_context: dict | None,
    memory_digest: str | None,
    org_credential: Any,
    model_overrides: dict[str, str] | None,
) -> None:
    """Best-effort project-memory reflection over a finished deep-research report.

    The synchronous chat path runs a post-answer reflection stage for
    shallow/meta turns but deliberately skips deep-research jobs (see
    chat_researcher/register.py, ``not deep_research_job_id``) because the report
    does not exist until the async job completes. This closes that gap on the
    worker, where the report and the submitting identity are both in hand.

    Unlike the chat path this is AWAITED, not fire-and-forget: the report has
    already been delivered to the user, and awaiting keeps the builder-owned LLM
    client alive until reflection finishes (the ``async with WorkflowBuilder``
    context is still open at the call site). It only ever delays the job's
    SUCCESS bookkeeping, never the answer, and never raises — reflection is a
    safety net, not part of the job contract.
    """
    if not reflection_enabled or not reflection_llm_ref or not report:
        return
    identity = (usage_context or {}).get("identity") or {}
    project_id = identity.get("project_id")
    if not project_id:
        # The autonomous reflection stage only writes project-scoped memory
        # (audit finding S1); an org-only job has nothing it may safely record.
        return
    try:
        from aiq_agent.agents.project_memory.reflection import run_memory_reflection
        from aiq_agent.common import AgentGroup
        from aiq_agent.common import apply_model_override
        from aiq_agent.common import apply_org_credential
        from aiq_agent.common import get_langchain_llm
        from aiq_agent.common import sanitize_model_overrides
        from aiq_agent.common.cost_tracking import BudgetSnapshot
        from aiq_agent.common.cost_tracking import track_llm_costs
        from aiq_agent.common.profiler import track_agent_profile

        reflection_llm = await get_langchain_llm(builder, reflection_llm_ref)
        overrides = sanitize_model_overrides(model_overrides) if model_overrides else None
        reflection_llm = apply_model_override(reflection_llm, AgentGroup.MEMORY_REFLECTION, overrides)
        # Explicit credential (not context): a Dask worker has no live request,
        # so the org key resolved at build time is passed directly.
        reflection_llm = apply_org_credential(reflection_llm, org_credential)

        with (
            track_agent_profile(agent_name="project_memory_reflection", job_id=job_id, identity=identity),
            track_llm_costs(job_id=job_id, identity=identity, budget=BudgetSnapshot()),
        ):
            await run_memory_reflection(
                llm=reflection_llm,
                query=query,
                answer=report,
                project_id=project_id,
                organization_id=identity.get("organization_id"),
                conversation_id=identity.get("conversation_id"),
                # The MEMORY digest, not the intake profile: the pass compares
                # the report against what is already remembered, and against
                # the profile it re-recorded known findings and could never
                # resolve a supersede quote.
                memory_digest=memory_digest,
            )
    except Exception:
        logger.warning("Job %s: deep-research memory reflection failed (non-fatal)", job_id, exc_info=True)


def _extract_skills_activated(result: Any) -> list[str] | None:
    """The skill names a job run activated, or ``None``.

    The socket path lifts this off the agent state onto the terminal frame and
    persists it as message metadata; a job run had the same field on the same
    state and dropped it on the floor, so a thread written by a job showed no
    transparency where an interactive turn showed some. Read defensively (state
    object OR dict, list-of-str or nothing) because the runner is agent-agnostic
    by design — an agent whose state has no such field simply has none.
    """
    value = getattr(result, "skills_activated", None)
    if value is None and isinstance(result, dict):
        value = result.get("skills_activated")
    if not isinstance(value, list):
        return None
    names = [name for name in value if isinstance(name, str) and name]
    return names or None


def _extract_verified_sources(result: Any) -> list[dict[str, Any]] | None:
    """The structured provenance of a finished run's answer, or ``None``.

    Each entry is one source the report CITED, as the agent's citation
    verification resolved it: the ``[N]`` label it wears in the prose, the
    document/file/page locator the reader opens a PDF with, the coarse ``kind``
    and the norm registry's binding note. The socket path lifts exactly this
    field off the state and posts it as ``sources``; the job path reduced the
    whole state to a report string, so a deep answer delivered as a job arrived
    with nothing but numbers scraped back out of its own Markdown — no
    open-at-page, no hover snippet, no authority badge — while the same answer
    streamed live arrived fully attributed.

    Read defensively (state object OR dict, entries type-checked one by one)
    because the runner is agent-agnostic by design: an agent whose state carries
    no such field contributes nothing here, and one that carries a malformed
    version contributes nothing rather than an unopenable chip.
    """
    value = getattr(result, "verified_sources", None)
    if value is None and isinstance(result, dict):
        value = result.get("verified_sources")
    if not isinstance(value, list):
        return None
    sources = [source for source in value if isinstance(source, dict) and source]
    return sources or None


def _build_job_output(
    report: str,
    *,
    cards: list[Any] | None,
    transparency: dict[str, Any],
    sources: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The dict a finished job persists as its ``output``.

    A named function rather than three inline lines because this dict IS the
    contract a client reads a finished job by, and inline it could not be
    checked without standing up a worker, a job store and a Dask scheduler.

    ``report`` is always there. Everything else is present or absent, never
    present-and-empty: no ``cards: []`` on a run that produced none, and no
    ``research_truncated: false`` on a run that completed — the same contract
    that field keeps on the chat path, so a client can key off existence.

    ``sources`` is spelled the way the backend spells it everywhere else on the
    wire (``websocket_reconnect``'s terminal frame, the message metadata), so
    the live Report panel and a rehydrated thread read one contract rather than
    two dialects of the same list.
    """
    output: dict[str, Any] = {"report": report}
    if cards:
        output["cards"] = cards
    if sources:
        output["sources"] = sources
    output.update(transparency)
    return output


def _extract_answer_transparency(result: Any) -> dict[str, Any]:
    """The marks a finished run left on its own answer, as the fields it set.

    A deep run can SUCCEED and still owe the reader a caveat. It can be cut off
    by the wall clock or by the graph's step limit and have its answer salvaged
    from partial work (``research_truncated`` / ``truncation_reason``); it can
    ship in a known-weaker form — no report file was ever written, or citation
    verification found nothing provably grounded (``degraded_reasons``); and
    citations it did make can have been stripped before anyone saw them
    (``citations_removed``). It can also rate its own answer, in the level and
    the two reasons that make the level actionable (``answer_confidence``).
    The socket path lifts all of that off the agent state onto the terminal
    frame. The job path reduced the entire state to a report string, so every
    one of these markers died inside the Dask worker and the same answer looked
    *cleaner* delivered as a job than streamed live.

    Read defensively — state object OR dict, every field type-checked on its own
    — because the runner is agent-agnostic by design: an agent whose state
    carries none of this simply contributes nothing here, and one that carries a
    malformed version of it contributes nothing rather than a wrong claim.

    Returns only the fields actually present. Absence is the default and the
    caller copies this dict straight into the job's persisted output, so the
    presence of a key is itself the fact — ``research_truncated`` is written as
    ``true`` or not written at all, never as ``false``, which is the contract it
    already keeps on the chat path.
    """

    def field(name: str) -> Any:
        value = getattr(result, name, None)
        if value is None and isinstance(result, dict):
            value = result.get(name)
        return value

    transparency: dict[str, Any] = {}

    # Literal ``True`` only. A truthy stand-in (``1``, ``"yes"``) means the state
    # was written by something that does not share this contract, and telling a
    # reader their research was cut off when nothing recorded a cutoff is a worse
    # failure than telling them nothing.
    if field("research_truncated") is True:
        transparency["research_truncated"] = True

    reason = field("truncation_reason")
    if isinstance(reason, str) and reason.strip():
        # Read independently of the flag rather than nested under it: a state
        # that recorded WHY it stopped but lost the boolean still knows something
        # true, and the caller keys its event off either one being present.
        transparency["truncation_reason"] = reason

    degraded_reasons = field("degraded_reasons")
    if isinstance(degraded_reasons, list):
        tokens = [token for token in degraded_reasons if isinstance(token, str) and token]
        # An empty list is not a claim of "degraded in zero ways" — it is the
        # ordinary case, and it stays out of the output entirely.
        if tokens:
            transparency["degraded_reasons"] = tokens

    citations_removed = field("citations_removed")
    if isinstance(citations_removed, dict) and citations_removed:
        transparency["citations_removed"] = citations_removed

    # The answer's own self-assessment, read here so it rides the SAME dict to
    # the same two surfaces instead of growing a second lift with its own bugs.
    # The three travel together on purpose: the shallow path has always sent the
    # level with its reason, because "niedrig" alone tells a reader their answer
    # might be wrong and nothing about what to check, and a level whose reason
    # was dropped in transport is the exact complaint that pairing exists to
    # prevent. Deep may not record any of them yet — absent is the ordinary case
    # and writes nothing, so this lands before the field exists and stays correct
    # after it does.
    for confidence_field in _ANSWER_CONFIDENCE_FIELDS:
        value = field(confidence_field)
        if isinstance(value, str) and value.strip():
            transparency[confidence_field] = value

    return transparency


def _extract_result(result: Any) -> str:
    """Extract string result from various result formats."""
    # Direct string
    if isinstance(result, str):
        return result

    # State with messages
    if hasattr(result, "messages") and result.messages:
        last_msg = result.messages[-1]
        if hasattr(last_msg, "content"):
            return str(last_msg.content)

    # Dict with messages
    if isinstance(result, dict):
        if "messages" in result and result["messages"]:
            last_msg = result["messages"][-1]
            if hasattr(last_msg, "content"):
                return str(last_msg.content)
        if "report" in result:
            return str(result["report"])
        if "output" in result:
            return str(result["output"])

    return str(result) if result else ""


# Backwards compatibility alias
async def run_deep_research(
    configure_logging: bool,
    log_level: int,
    scheduler_address: str,
    db_url: str,
    config_file_path: str,
    job_id: str,
    input_text: str,
):
    """
    Legacy function for running deep research jobs.

    Preserved for backwards compatibility. New code should use run_agent_job directly.
    """
    await run_agent_job(
        configure_logging=configure_logging,
        log_level=log_level,
        scheduler_address=scheduler_address,
        db_url=db_url,
        config_file_path=config_file_path,
        job_id=job_id,
        input_text=input_text,
        agent_class_path="aiq_agent.agents.deep_researcher.agent.DeepResearcherAgent",
        agent_config_name="deep_research_agent",
    )
