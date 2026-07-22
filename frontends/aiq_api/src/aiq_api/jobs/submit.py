"""
Job submission utilities.

Provides functions to submit agent jobs to the Dask cluster.
"""

from __future__ import annotations

import asyncio
import logging
import os

from aiq_agent.auth import Principal
from aiq_agent.auth import get_current_principal
from aiq_agent.common.job_admission import JobAdmissionError
from aiq_api.auth import get_current_trace_tags

from ..registry import get_agent_config
from .access import _make_no_auth_principal
from .access import count_active_jobs
from .access import create_job_access
from .access import job_exists
from .access import rollback_job_submission
from .runner import run_agent_job


def job_execution_mode() -> str:
    """Execution backend for research jobs: ``dask`` (default, per-pod cluster)
    or ``db`` (DB-claimed workers, ADR-0021 — enables horizontal scaling)."""
    return os.environ.get("GRID_JOB_EXECUTION", "dask").strip().lower()


def _build_run_agent_payload(
    *,
    configure_logging,
    log_level,
    scheduler_address,
    db_url,
    config_path,
    job_id,
    input_text,
    agent_config,
    parent_trace_context,
    available_documents,
    data_sources,
    auth_token,
    collection_scope,
    project_context,
    model_overrides,
    usage_context,
    user_info,
    clarifier_result,
    memory_reflection_enabled,
    memory_reflection_llm,
) -> dict:
    """Build the JSON-serializable ``run_agent_job`` kwargs a DB worker replays.

    Keys mirror ``run_agent_job``'s signature exactly; ``parent_trace_context``
    is the 7-tuple expanded positionally in the Dask path. Every value is a
    plain str/int/bool/list/dict/None, so it round-trips through JSON.
    """
    (
        parent_span_id,
        parent_function_id,
        parent_function_name,
        parent_workflow_run_id,
        parent_workflow_trace_id,
        parent_conversation_id,
        request_trace_tags,
    ) = parent_trace_context
    return {
        "configure_logging": configure_logging,
        "log_level": log_level,
        "scheduler_address": scheduler_address,
        "db_url": db_url,
        "config_file_path": config_path,
        "job_id": job_id,
        "input_text": input_text,
        "agent_class_path": agent_config.class_path,
        "agent_config_name": agent_config.config_name,
        "parent_span_id": parent_span_id,
        "parent_function_id": parent_function_id,
        "parent_function_name": parent_function_name,
        "parent_workflow_run_id": parent_workflow_run_id,
        "parent_workflow_trace_id": parent_workflow_trace_id,
        "parent_conversation_id": parent_conversation_id,
        "request_trace_tags": request_trace_tags,
        "available_documents": available_documents,
        "data_sources": data_sources,
        "auth_token": auth_token,
        "collection_scope": collection_scope,
        "project_context": project_context,
        "model_overrides": model_overrides,
        "usage_context": usage_context,
        "user_info": user_info,
        "clarifier_result": clarifier_result,
        "memory_reflection_enabled": memory_reflection_enabled,
        "memory_reflection_llm": memory_reflection_llm,
    }


logger = logging.getLogger(__name__)

# @environment_variable GRID_MAX_ACTIVE_JOBS
# @category Server
# @type int
# @default 8
# @required false
# Maximum non-terminal async jobs accepted across all organizations
# (admission control). 0 or negative disables the global cap.
MAX_ACTIVE_JOBS = int(os.environ.get("GRID_MAX_ACTIVE_JOBS", "8"))

# @environment_variable GRID_MAX_ACTIVE_JOBS_PER_ORG
# @category Server
# @type int
# @default 3
# @required false
# Maximum non-terminal async jobs accepted per organization, so one tenant
# cannot occupy the whole cluster. 0 or negative disables the per-org cap.
MAX_ACTIVE_JOBS_PER_ORG = int(os.environ.get("GRID_MAX_ACTIVE_JOBS_PER_ORG", "3"))


async def _enforce_job_admission(db_url: str, organization_id: str | None) -> None:
    """Refuse submission when active-job caps are reached (fail-open on errors)."""
    if MAX_ACTIVE_JOBS <= 0 and MAX_ACTIVE_JOBS_PER_ORG <= 0:
        return

    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    terminal = (JobStatus.SUCCESS.value, JobStatus.FAILURE.value, JobStatus.INTERRUPTED.value)
    loop = asyncio.get_running_loop()
    try:
        if MAX_ACTIVE_JOBS > 0:
            active = await loop.run_in_executor(None, count_active_jobs, db_url, terminal, None)
            if active >= MAX_ACTIVE_JOBS:
                raise JobAdmissionError(
                    f"Research queue is full ({active} jobs active). Please try again in a few minutes.",
                )
        if MAX_ACTIVE_JOBS_PER_ORG > 0 and organization_id:
            org_active = await loop.run_in_executor(None, count_active_jobs, db_url, terminal, organization_id)
            if org_active >= MAX_ACTIVE_JOBS_PER_ORG:
                raise JobAdmissionError(
                    f"Your organization already has {org_active} research jobs running. "
                    "Please wait for one to finish before starting another.",
                )
    except JobAdmissionError:
        raise
    except Exception:
        # Admission control is protective, not load-bearing: a broken count
        # must never take research submission down.
        logger.warning("Job admission check failed; admitting job", exc_info=True)


def _get_disabled_sources() -> set[str]:
    """Org-disabled source ids from the submitting request (fail-open)."""
    try:
        from aiq_agent.common import get_disabled_sources_from_context

        return get_disabled_sources_from_context()
    except Exception:
        logger.warning("Failed to read disabled data sources; not filtering", exc_info=True)
        return set()


def _resolve_submission_principal(owner: str) -> Principal | None:
    """Resolve the best available principal for async job ownership.

    Used only when submit_agent_job is called programmatically without an
    explicit principal.  Verified middleware identity is preferred; falls back
    to a compatibility principal when auth is disabled.
    """
    principal = get_current_principal()
    if principal is not None:
        return principal

    if os.environ.get("REQUIRE_AUTH", "false").lower() == "true":
        return None

    return _make_no_auth_principal(owner)


def _get_parent_trace_context() -> tuple[
    str | None,  # parent_span_id
    str | None,  # parent_function_id
    str | None,  # parent_function_name
    str | None,  # parent_workflow_run_id
    int | str | None,  # parent_workflow_trace_id
    str | None,  # parent_conversation_id
    dict[str, str],  # request_trace_tags
]:
    """
    Extract trace context from current workflow for propagation to async jobs.

    This enables nested spans in Phoenix - the async job will appear as a child
    of the workflow that submitted it.

    Returns:
        Tuple of (parent_span_id, parent_function_id, parent_function_name,
                  parent_workflow_run_id, parent_workflow_trace_id, parent_conversation_id, request_trace_tags)
    """
    try:
        from nat.builder.context import ContextState
    except ImportError:
        return (None, None, None, None, None, None, {})

    context_state = ContextState.get()

    # Extract workflow-level context
    parent_workflow_run_id = context_state.workflow_run_id.get()
    parent_workflow_trace_id = context_state.workflow_trace_id.get()
    parent_conversation_id = context_state.conversation_id.get()

    # Extract span hierarchy context
    parent_span_id = None
    active_stack = context_state.active_span_id_stack.get()
    if active_stack and len(active_stack) > 1:
        parent_span_id = active_stack[1]

    parent_function_id = None
    parent_function_name = None
    active_function = context_state.active_function.get()
    if active_function and active_function.function_id != "root":
        parent_function_id = active_function.function_id
        parent_function_name = active_function.function_name

    return (
        parent_span_id,
        parent_function_id,
        parent_function_name,
        parent_workflow_run_id,
        parent_workflow_trace_id,
        parent_conversation_id,
        get_current_trace_tags(),
    )


def _base_collection_name() -> str:
    """Return the configured base/OIB knowledge collection name.

    Mirrors the env var precedence used elsewhere in the codebase
    (e.g. ``aiq_agent.oib_sync``): ``OIB_COLLECTION_NAME`` wins over the
    legacy ``COLLECTION_NAME``, defaulting to ``oib_knowledge``.
    """
    return os.environ.get("OIB_COLLECTION_NAME") or os.environ.get("COLLECTION_NAME") or "oib_knowledge"


def _derive_project_collection(collection_scope: list[str] | None) -> str | None:
    """Extract the project collection from a request's collection scope.

    The collection scope contains the base/OIB collection, the project
    collection, and an ``s_<conversation>`` scoped collection. The project
    collection is the single remaining entry once those two are excluded.
    Returns None if no such entry exists (or more than one candidate remains,
    which indicates an ambiguous scope not worth guessing at).
    """
    if not collection_scope:
        return None

    base_collection = _base_collection_name()
    candidates = [
        collection
        for collection in collection_scope
        if collection != base_collection and not collection.startswith("s_")
    ]
    if len(candidates) == 1:
        return candidates[0]
    return None


class SchedulerNotConfiguredError(RuntimeError):
    """The Dask scheduler address is not configured (server misconfiguration).

    Subclasses RuntimeError for backwards compatibility, but lets HTTP routes
    map it to 503 instead of conflating it with authorization failures (403).
    """


class MissingPrincipalError(RuntimeError):
    """No verified principal is available to own the async job.

    Subclasses RuntimeError for backwards compatibility. HTTP routes map this
    specific error to 403 with its static, user-safe message — arbitrary
    RuntimeError text (which may carry hosts/DSNs) must never reach clients.
    """


class DuplicateJobIdError(ValueError):
    """A caller-supplied job ID collides with an existing job.

    Mapped to HTTP 409 Conflict by the submit route. Only raised for
    caller-supplied IDs; auto-generated UUIDs skip the existence check.
    """


async def submit_agent_job(
    agent_type: str,
    input_text: str,
    owner: str,
    principal: Principal | None = None,
    job_id: str | None = None,
    expiry_seconds: int = 86400,
    available_documents: list[dict] | None = None,
    data_sources: list[str] | None = None,
    auth_token: str | None = None,
    collection_scope: list[str] | None = None,
    project_context: str | None = None,
    model_overrides: dict[str, str] | None = None,
    usage_context: dict | None = None,
    user_info: dict | None = None,
    clarifier_result: str | None = None,
    memory_reflection_enabled: bool = False,
    memory_reflection_llm: str | None = None,
) -> str:
    """
    Submit an agent job to the Dask cluster.

    This is the main entry point for submitting async jobs from application code.
    It looks up the agent configuration from the registry and submits the job.

    Args:
        agent_type: Agent type identifier (e.g., 'deep_researcher').
        input_text: The user's query/request.
        owner: Owner email for the job.
        principal: Verified principal that owns the job.
        job_id: Optional custom job ID.
        expiry_seconds: Job expiry time in seconds (default 24h).
        available_documents: Optional list of document dicts with file_name and summary.
        data_sources: Optional list of allowed data sources to enforce in the worker.
        auth_token: Optional auth token to propagate to the Dask worker for
            data sources that require authentication.
        model_overrides: Optional per-org runtime model overrides
            (``{agent_group: openrouter_model_id}``). Auto-captured from the
            submitting request's ``X-Grid-Model-Overrides`` header when not
            explicitly provided.
        usage_context: Optional identity + budget snapshot for LLM cost
            tracking in the worker (see ``capture_usage_context``).
            Auto-captured from the submitting request when not provided.
        user_info: Optional user identity dict (name/email) set on the agent
            state so worker-side prompts can render the authenticated user,
            matching the synchronous chat path.
        clarifier_result: Optional clarifier dialog log set on the agent state
            so worker-side prompts render the structured Clarification Context
            section, matching the synchronous chat path.
        memory_reflection_enabled: Whether the worker should run the post-answer
            memory-reflection stage over the finished report. Captured from the
            submitting request's feature flag (the worker cannot read it).
        memory_reflection_llm: Optional ``llms:`` ref for the reflection pass
            (e.g. ``card_llm``). When set and enabled, the worker records durable
            project findings from the completed report.

    Returns:
        The job ID.

    Raises:
        KeyError: If agent_type is not registered.
        RuntimeError: If Dask scheduler is not configured.
        DuplicateJobIdError: If a caller-supplied job_id collides with an existing job.

    Example:
        job_id = await submit_agent_job(
            agent_type="deep_researcher",
            input_text="Research quantum computing",
            owner="user@example.com",
            available_documents=[{"file_name": "doc.pdf", "summary": "A research paper"}],
        )
    """
    from nat.front_ends.fastapi.async_jobs.job_store import JobStore

    # Get agent configuration from registry
    agent_config = get_agent_config(agent_type)

    # @environment_variable NAT_DASK_SCHEDULER_ADDRESS
    # @category Server
    # @type str
    # @required true
    # Dask scheduler address for async job submission.
    scheduler_address = os.environ.get("NAT_DASK_SCHEDULER_ADDRESS")

    # @environment_variable NAT_JOB_STORE_DB_URL
    # @category Server
    # @type str
    # @default sqlite:///./data/jobs.db
    # @required false
    # Database URL for job persistence (SQLite or PostgreSQL).
    db_url = os.environ.get("NAT_JOB_STORE_DB_URL", "sqlite:///./data/jobs.db")

    # @environment_variable NAT_CONFIG_FILE
    # @category Server
    # @type str
    # @required false
    # Path to NAT workflow config file used by Dask workers.
    config_path = os.environ.get("NAT_CONFIG_FILE", "")

    # @environment_variable NAT_FASTAPI_LOG_LEVEL
    # @category Server
    # @type int
    # @default 20
    # @required false
    # Python logging level for FastAPI workers (10=DEBUG, 20=INFO, 30=WARNING).
    log_level = int(os.environ.get("NAT_FASTAPI_LOG_LEVEL", "20"))

    # @environment_variable NAT_USE_DASK_THREADS
    # @category Server
    # @type bool
    # @default 0
    # @required false
    # Use Dask thread pool instead of process pool for workers. Set to 1 to enable.
    use_threads = os.environ.get("NAT_USE_DASK_THREADS", "0") == "1"

    db_execution = job_execution_mode() == "db"
    if not scheduler_address and not db_execution:
        raise SchedulerNotConfiguredError("Async job submission requires NAT_DASK_SCHEDULER_ADDRESS to be set")

    # Auto-capture auth token if not explicitly provided
    if auth_token is None:
        from aiq_agent.auth import get_auth_token

        auth_token = get_auth_token()

    # Auto-detect collection scope from NAT context if not explicitly provided.
    # When the request arrives via HTTP/WS the NAT middleware populates
    # Context.metadata.headers with the BFF-supplied X-Grid-Collection-Scope.
    if collection_scope is None:
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context

        collection_scope = get_collection_scope_from_context()

    # Auto-detect project context from NAT context if not explicitly provided.
    if project_context is None:
        from aiq_agent.project_context import get_project_context_from_context

        project_context = get_project_context_from_context()

    # Auto-detect per-org runtime model overrides if not explicitly provided.
    if model_overrides is None:
        from aiq_agent.common import get_model_overrides_from_context

        model_overrides = get_model_overrides_from_context() or None

    # Org-disabled data sources (ADR-0022): subtracted HERE, at submit time,
    # so Dask workers need no live flag lookup — the effective data_sources
    # list they receive already excludes anything the organization turned
    # off. A None ("all sources") request is materialized first so the
    # subtraction can apply.
    disabled_sources = _get_disabled_sources()
    if disabled_sources:
        if data_sources is None:
            from aiq_agent.common.data_source_registry import get_all_sources

            data_sources = [source.id for source in get_all_sources()]
        data_sources = [source for source in data_sources if source.strip().lower() not in disabled_sources]

    # Capture caller identity + remaining budget for cost tracking in the worker.
    if usage_context is None:
        from aiq_agent.common.cost_tracking import capture_usage_context

        usage_context = capture_usage_context()

    if principal is None:
        principal = _resolve_submission_principal(owner)
    if principal is None:
        raise MissingPrincipalError("Verified current principal required for async job submission")

    organization_id = ((usage_context or {}).get("identity") or {}).get("organization_id")

    # Admission control: nothing else bounds how many concurrent jobs the
    # cluster accepts, and each deep-research run fans out multiple
    # LLM-calling researchers. Caps are best-effort (checked before submit,
    # no lock) and fail OPEN — a broken count must not take research down.
    await _enforce_job_admission(db_url, organization_id)

    job_store = JobStore(scheduler_address=scheduler_address, db_url=db_url)
    resolved_job_id = job_store.ensure_job_id(job_id)
    loop = asyncio.get_running_loop()

    # Duplicate-ID guard: job_id is caller-supplied, and both NAT's job_info
    # write and the job_access upsert below are unconditional — without this
    # check, re-submitting an existing ID would rewrite the original job's
    # ownership (hijack), and a failed re-submission would delete the original
    # job via rollback_job_submission. Auto-generated UUIDs skip the check.
    # Fails open on DB errors (like admission control), but an unverified
    # pre-existence also suppresses the destructive rollback below.
    preexistence_verified = job_id is None
    if job_id is not None:
        try:
            if await loop.run_in_executor(None, job_exists, resolved_job_id, db_url):
                raise DuplicateJobIdError(f"Job ID already exists: {resolved_job_id}")
            preexistence_verified = True
        except DuplicateJobIdError:
            raise
        except Exception:
            logger.warning(
                "Failed to check whether job %s already exists; proceeding without rollback safety",
                resolved_job_id,
                exc_info=True,
            )

    parent_trace_context = _get_parent_trace_context()
    parent_conversation_id = parent_trace_context[5]
    project_collection = _derive_project_collection(collection_scope)

    try:
        if db_execution:
            # DB-claimed execution (ADR-0021): persist a SUBMITTED job_info row
            # (no Dask) and enqueue a claimable row carrying the run_agent_job
            # payload. A worker replica claims and runs it. _create_job reuses
            # NAT's job_info semantics without the scheduler.
            from . import queue

            payload = _build_run_agent_payload(
                configure_logging=not use_threads,
                log_level=log_level,
                scheduler_address=scheduler_address or "",
                db_url=db_url,
                config_path=config_path,
                job_id=resolved_job_id,
                input_text=input_text,
                agent_config=agent_config,
                parent_trace_context=parent_trace_context,
                available_documents=available_documents,
                data_sources=data_sources,
                auth_token=auth_token,
                collection_scope=collection_scope,
                project_context=project_context,
                model_overrides=model_overrides,
                usage_context=usage_context,
                user_info=user_info,
                clarifier_result=clarifier_result,
                memory_reflection_enabled=memory_reflection_enabled,
                memory_reflection_llm=memory_reflection_llm,
            )
            await job_store._create_job(
                config_file=config_path or None,
                job_id=resolved_job_id,
                expiry_seconds=expiry_seconds,
            )
            await loop.run_in_executor(None, queue.enqueue, db_url, resolved_job_id, payload)
        else:
            await job_store.submit_job(
                job_id=resolved_job_id,
                expiry_seconds=expiry_seconds,
                job_fn=run_agent_job,
                job_args=[
                    not use_threads,  # configure_logging
                    log_level,
                    scheduler_address,
                    db_url,
                    config_path,
                    resolved_job_id,
                    input_text,
                    agent_config.class_path,
                    agent_config.config_name,
                    *parent_trace_context,
                    available_documents,
                    data_sources,
                    auth_token,
                    collection_scope,
                    project_context,
                    model_overrides,
                    usage_context,
                    user_info,
                    clarifier_result,
                    memory_reflection_enabled,
                    memory_reflection_llm,
                ],
            )
        await loop.run_in_executor(
            None,
            create_job_access,
            resolved_job_id,
            principal,
            db_url,
            parent_conversation_id,
            project_collection,
            organization_id,
        )
    except Exception:
        if not preexistence_verified:
            # rollback_job_submission deletes job_access, job_events AND
            # job_info. Without positive proof the job ID did not exist before
            # this request, rolling back could wipe a pre-existing job.
            logger.warning(
                "Skipping rollback for job %s after submission failure: pre-existence of the "
                "job ID could not be verified, and rollback must never delete a pre-existing job.",
                resolved_job_id,
            )
            raise
        try:
            await loop.run_in_executor(None, rollback_job_submission, resolved_job_id, db_url)
            logger.warning(
                "Rolled back partial async job submission for %s after access persistence failure. "
                "The Dask worker may still be running and should be investigated if it continues writing state.",
                resolved_job_id,
            )
        except Exception as cleanup_error:
            logger.warning(
                "Failed to roll back partial async job submission for %s after access persistence failure: %s",
                resolved_job_id,
                cleanup_error,
            )
        raise

    logger.info(
        "Submitted %s job %s for owner %s (%s:%s)",
        agent_type,
        resolved_job_id,
        owner,
        principal.type,
        principal.sub,
    )
    return resolved_job_id


# Backwards compatibility alias
async def submit_deep_research_job(
    input_text: str,
    owner: str,
    job_id: str | None = None,
    expiry_seconds: int = 86400,
) -> str:
    """
    Submit a deep research job.

    Legacy function preserved for backwards compatibility.
    New code should use submit_agent_job(agent_type="deep_researcher", ...).
    """
    return await submit_agent_job(
        agent_type="deep_researcher",
        input_text=input_text,
        owner=owner,
        job_id=job_id,
        expiry_seconds=expiry_seconds,
    )
