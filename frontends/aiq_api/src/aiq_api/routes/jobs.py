"""
Agent-agnostic async job API routes.

Routes:
    GET  /v1/jobs/async/agents                            - List available agent types
    POST /v1/jobs/async/submit                            - Submit a new job for any agent
    GET  /v1/jobs/async/job/{job_id}                      - Get job status
    GET  /v1/jobs/async/job/{job_id}/stream               - SSE stream from beginning
    GET  /v1/jobs/async/job/{job_id}/stream/{last_event_id} - SSE stream from event ID
    POST /v1/jobs/async/job/{job_id}/cancel               - Cancel running job
    GET  /v1/jobs/async/job/{job_id}/state                - Get artifacts from event store
    GET  /v1/jobs/async/job/{job_id}/report               - Get final report
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING
from typing import Annotated
from typing import Any

from fastapi import Body
from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

from aiq_agent.common.data_source_registry import get_all_sources
from aiq_agent.common.data_source_registry import get_all_tool_refs
from aiq_agent.common.data_source_registry import get_source_id_for_tool
from aiq_agent.common.db_utils import redact_db_url
from aiq_agent.common.job_admission import JobAdmissionError
from nat.builder.framework_enum import LLMFrameworkEnum

from ..jobs.access import require_verified_principal
from ..registry import AGENT_REGISTRY
from ..registry import get_agent_config

if TYPE_CHECKING:
    from nat.builder.workflow_builder import WorkflowBuilder
    from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorker

logger = logging.getLogger(__name__)


class JobSubmitRequest(BaseModel):
    """Request to submit an async job."""

    agent_type: str = Field(..., description="Agent type (e.g., 'deep_researcher')")
    input: str = Field(..., min_length=1, max_length=32000, description="Input query for the agent")
    job_id: str | None = Field(
        None,
        pattern=r"^[a-zA-Z0-9_-]+$",
        max_length=64,
        description="Optional custom job ID (auto-generated if omitted)",
    )
    expiry_seconds: int | None = Field(
        None,
        ge=600,
        le=604800,
        description="Job expiry in seconds (default from config, max 7 days)",
    )
    data_sources: list[str] | None = Field(
        None,
        description=(
            "Optional data source IDs to target. Omit or set null to use all data-source tools "
            "available to the chosen agent. When specific IDs are passed, unmapped utility tools "
            "(e.g., 'think') remain available. Pass an empty list to run the agent with no "
            "data-source tools; unmapped utility tools remain available."
        ),
    )


JOB_SUBMIT_EXAMPLES: dict[str, dict] = {
    "default": {
        "summary": "Default (all data sources)",
        "value": {
            "agent_type": "deep_researcher",
            "input": "What are the latest advances in quantum computing?",
            "expiry_seconds": 86400,
        },
    },
    "scoped": {
        "summary": "Scoped to specific data sources",
        "value": {
            "agent_type": "deep_researcher",
            "input": "What are the latest advances in quantum computing?",
            "data_sources": ["web_search"],
        },
    },
}


def _source_ids_by_lowercase() -> tuple[list[str], dict[str, str]]:
    """Return known source IDs and a lower-case lookup preserving canonical IDs.

    Assumes registry IDs are unique under ``.lower()``. The data source registry
    convention is snake_case (e.g. ``web_search``, ``knowledge_layer``); two IDs
    differing only by case would collapse here.
    """
    known_ids = sorted(source.id for source in get_all_sources())
    return known_ids, {source_id.lower(): source_id for source_id in known_ids}


async def _get_agent_available_source_ids(builder: WorkflowBuilder, agent_config_name: str) -> list[str]:
    """Return mapped source IDs with at least one effective tool for an agent config.

    This mirrors the async job runner's effective tool resolution: explicit
    `tools` wins and overrides registry refs, otherwise inherit all registry
    refs, resolve LangChain wrappers through the builder, then apply exact
    tool-name `exclude_tools`.

    A source is reported as available if at least one of its tools survives
    ``exclude_tools``; partial exclusion does not hide the source.

    Assumes agent configs registered for async submission expose typed
    ``tools`` and ``exclude_tools`` fields (see ``aiq_agent.agents.*.register``).
    A registered agent without these fields is a registration-time bug, not a
    runtime concern.
    """
    fn_config = builder.get_function_config(agent_config_name)
    tool_refs = fn_config.tools if fn_config.tools is not None else get_all_tool_refs()
    tools = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)

    excluded = set(fn_config.exclude_tools or [])
    if excluded:
        tools = [tool for tool in tools if getattr(tool, "name", "") not in excluded]

    source_ids: set[str] = set()
    for tool in tools:
        name = getattr(tool, "name", "")
        if not name:
            continue
        sid = get_source_id_for_tool(name)
        if sid is not None:
            source_ids.add(sid)
    return sorted(source_ids)


async def _validate_data_sources_for_agent(
    *,
    builder: WorkflowBuilder,
    agent_type: str,
    agent_config_name: str,
    data_sources: list[str] | None,
) -> None:
    """Raise HTTP 422 if requested sources are unknown or unavailable to the selected agent."""
    # Semantic fast path: omit/null/empty means "use all data-source tools available
    # to the chosen agent" (or, for empty list, "use no data-source tools"). In both
    # cases there is nothing for the caller to validate against, so we skip.
    #
    # Bonus: this also avoids a builder.get_tools() round-trip on the default code
    # path -- pinned by test_submit_job_forwards_omitted_data_sources_without_resolving_tools.
    if not data_sources:
        return

    known_ids, known_by_lower = _source_ids_by_lowercase()

    try:
        available_ids = await _get_agent_available_source_ids(builder, agent_config_name)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception(
            "Failed to validate data sources for agent %s using config %s",
            agent_type,
            agent_config_name,
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to validate data sources for selected agent",
        ) from exc

    available_by_lower = {source_id.lower(): source_id for source_id in available_ids}

    # Single-pass partition: walk requested IDs once, deduping case-insensitively
    # and routing each unique ID into either "unknown to system" or "known but
    # unavailable to this agent." Preserves first-seen casing and request order.
    seen: set[str] = set()
    invalid_ids: list[str] = []
    unavailable_for_agent: list[str] = []
    for source_id in data_sources:
        key = source_id.lower()
        if key in seen:
            continue
        seen.add(key)
        if key not in known_by_lower:
            invalid_ids.append(source_id)
        elif key not in available_by_lower:
            unavailable_for_agent.append(source_id)

    if not invalid_ids and not unavailable_for_agent:
        return

    parts: list[str] = []
    if invalid_ids:
        parts.append(f"Unknown data source(s): {', '.join(invalid_ids)}")
    if unavailable_for_agent:
        parts.append(f"Data source(s) are not available for agent '{agent_type}': {', '.join(unavailable_for_agent)}")
    message = ". ".join(parts)

    # Echo back the caller's request annotated with which IDs were unknown vs
    # unavailable, plus the global registry list (which is also discoverable via
    # /v1/data_sources). The per-agent capability list is intentionally NOT
    # returned -- it's not exposed anywhere else and would reveal agent
    # capability boundaries.
    raise HTTPException(
        status_code=422,
        detail={
            "message": message,
            "invalid_ids": invalid_ids,
            "unavailable_for_agent": unavailable_for_agent,
            "known_ids": known_ids,
        },
    )


class JobStatusResponse(BaseModel):
    """Job status response."""

    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "job_id": "abc123",
                    "status": "submitted",
                    "agent_type": "deep_researcher",
                    "error": None,
                    "created_at": "2026-02-12T10:30:00Z",
                }
            ]
        }
    )

    job_id: str = Field(..., description="Unique job identifier")
    status: str = Field(
        ...,
        description="Current status: submitted, running, success, failure, interrupted, not_found",
    )
    agent_type: str | None = Field(None, description="Agent type used for this job")
    error: str | None = Field(None, description="Error message if job failed")
    created_at: str | None = Field(None, description="Creation timestamp (ISO format)")


class JobStateResponse(BaseModel):
    """Job state response with artifacts."""

    job_id: str = Field(..., description="Unique job identifier")
    has_state: bool = Field(..., description="Whether state/artifacts are available")
    state: dict | None = Field(None, description="Internal job state")
    artifacts: dict | None = Field(None, description="Tool calls, outputs, and sources collected during execution")


class JobReportResponse(BaseModel):
    """Final report response."""

    job_id: str = Field(..., description="Unique job identifier")
    has_report: bool = Field(..., description="Whether the final report is available")
    report: str | None = Field(None, description="Final research report from the agent")


class ResearchRunItem(BaseModel):
    """A single research run (async job) summary."""

    job_id: str = Field(..., description="Unique job identifier")
    status: str = Field(..., description="Current job status")
    created_at: str | None = Field(None, description="Creation timestamp (ISO format)")
    conversation_id: str | None = Field(None, description="Conversation the job was submitted from, if any")
    project_collection: str | None = Field(None, description="Project collection the job was scoped to, if any")


class ResearchRunsResponse(BaseModel):
    """List of research runs matching the requested filters."""

    jobs: list[ResearchRunItem] = Field(..., description="Matching research runs, newest first")
    total: int = Field(..., description="Total number of matching runs (before limit/offset)")


class AgentInfo(BaseModel):
    """Information about a registered agent."""

    agent_type: str = Field(..., description="Agent identifier used in submit requests")
    description: str = Field(..., description="Human-readable description of the agent")


class AgentListResponse(BaseModel):
    """List of available agents."""

    agents: list[AgentInfo] = Field(..., description="Registered agent types")


class DataSource(BaseModel):
    """Information about an available data source."""

    id: str = Field(..., description="Unique identifier for the data source")
    name: str = Field(..., description="Display name")
    description: str | None = Field(default=None, description="Human-readable description")
    requires_auth: bool = Field(default=False, description="Whether user authentication is required")


class DataSourcesResponse(BaseModel):
    """Data sources listing plus derived deployment capabilities.

    ``data_sources`` is the registry listing (unchanged). ``vlm_available`` is a
    DERIVED capability, not a flag: it reflects whether a vision model API key
    resolves on this deployment, so the frontend can offer image upload only
    when ingestion would actually succeed (availability = ``image-upload`` flag
    AND this capability). See ``resolve_vlm_api_key`` for the resolution chain.
    """

    data_sources: list[DataSource] = Field(..., description="Registered data sources")
    vlm_available: bool = Field(
        default=False,
        description="Whether a vision model (VLM) is configured (derived from VLM API key presence)",
    )


async def register_job_routes(app: FastAPI, builder: WorkflowBuilder, worker: FastApiFrontEndPluginWorker) -> None:
    """
    Register agent-agnostic async job routes.

    Uses NAT's JobStore for job metadata and Dask for distributed execution.
    The /v1/data_sources endpoint is always registered regardless of Dask availability.
    """
    import logging as std_logging
    import os

    from .builder_state import set_active_builder

    # Publish the builder so the internal workflows submit route (registered
    # without one) can reuse _validate_data_sources_for_agent.
    set_active_builder(builder)

    from aiq_agent.common.data_source_registry import get_all_sources
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    from ..jobs.access import authorize_job_access
    from ..jobs.access import ensure_job_access_table
    from ..jobs.event_store import EventStore
    from ..jobs.submit import DuplicateJobIdError
    from ..jobs.submit import MissingPrincipalError
    from ..jobs.submit import SchedulerNotConfiguredError
    from ..jobs.submit import job_execution_mode
    from ..jobs.submit import submit_agent_job as submit_authorized_job

    if not get_all_sources():
        logger.warning(
            "No data sources registered. Add a 'data_sources' function with "
            "_type: data_source_registry to your YAML config to enable "
            "data source toggles in the UI."
        )

    @app.get(
        "/v1/jobs/async/agents",
        response_model=AgentListResponse,
        tags=["async jobs"],
        summary="List available agents",
        description="Returns all registered agent types that can be used with the submit endpoint.",
    )
    async def list_agents() -> AgentListResponse:
        """List available agent types for async job submission."""
        agents = [
            AgentInfo(agent_type=agent_type, description=config.description)
            for agent_type, config in AGENT_REGISTRY.items()
        ]
        return AgentListResponse(agents=agents)

    @app.get(
        "/v1/data_sources",
        response_model=DataSourcesResponse,
        tags=["data sources"],
        summary="List data sources and deployment capabilities",
    )
    async def list_data_sources() -> DataSourcesResponse:
        """List data sources from the registry plus derived capabilities.

        ``vlm_available`` is derived from the knowledge layer's single VLM-key
        resolver (``vlm_configured``) — the same seam the ingestion path uses —
        so the advertised image-upload capability can never drift from what
        ingestion will actually attempt. Resolves defensively: any import/lookup
        failure reports ``vlm_available=False`` (fail-closed, no false offer).
        """
        try:
            from knowledge_layer.llamaindex.adapter import vlm_configured

            vlm_available = vlm_configured()
        except Exception:  # noqa: BLE001 — capability probe must never break the listing
            logger.warning("VLM capability probe failed; reporting vlm_available=False", exc_info=True)
            vlm_available = False

        return DataSourcesResponse(
            data_sources=[
                DataSource(
                    id=source.id,
                    name=source.name,
                    description=source.description,
                    requires_auth=source.requires_auth,
                )
                for source in get_all_sources()
            ],
            vlm_available=vlm_available,
        )

    logger.info("Registered /v1/data_sources and /v1/jobs/async/agents routes")

    db_execution = job_execution_mode() == "db"
    dask_available = getattr(worker, "_dask_available", False)
    job_store = getattr(worker, "_job_store", None)

    # In db-execution mode (ADR-0021) the web tier runs no Dask cluster, so the
    # routes must still register with a DB-only job store. Otherwise the routes
    # require Dask + a job store as before.
    if not db_execution and (not dask_available or not job_store):
        logger.warning(
            "Dask not available - async job submission routes require NAT_DASK_SCHEDULER_ADDRESS"
            " and NAT_JOB_STORE_DB_URL"
        )
        return

    scheduler_address = getattr(worker, "_scheduler_address", None) or os.environ.get("NAT_DASK_SCHEDULER_ADDRESS")
    db_url = getattr(worker, "_db_url", None) or os.environ.get("NAT_JOB_STORE_DB_URL", "sqlite:///./data/jobs.db")

    if job_store is None:
        # DB-only store: JobStore only *stores* the scheduler address (no Dask
        # client is built at construction), so status/persistence work without a
        # cluster. Submission enqueues a claimable row; workers execute it.
        from nat.front_ends.fastapi.async_jobs.job_store import JobStore

        job_store = JobStore(scheduler_address=scheduler_address or "", db_url=db_url)
    # submit_agent_job resolves these from the environment only; publish the
    # worker-provided values so a NAT-config-only deployment (no env vars)
    # doesn't register routes whose every submission then fails.
    if scheduler_address:
        os.environ.setdefault("NAT_DASK_SCHEDULER_ADDRESS", scheduler_address)
    if db_url:
        os.environ.setdefault("NAT_JOB_STORE_DB_URL", db_url)
    config_path = getattr(worker, "_config_file_path", None) or os.environ.get("NAT_CONFIG_FILE", "")
    log_level = getattr(worker, "_log_level", std_logging.INFO)
    use_threads = getattr(worker, "_use_dask_threads", False)

    if not config_path:
        logger.error("Config file path not available - NAT_CONFIG_FILE not set")
        return

    front_end_config = getattr(worker, "_front_end_config", None)
    default_expiry_seconds = getattr(front_end_config, "expiry_seconds", 86400) if front_end_config else 86400

    logger.info(
        "Registering async job routes: scheduler=%s, db=%s, expiry=%ds",
        scheduler_address,
        redact_db_url(db_url),
        default_expiry_seconds,
    )
    await asyncio.get_running_loop().run_in_executor(None, ensure_job_access_table, db_url)

    @app.get("/health", tags=["health"], summary="Health check")
    async def health_check():
        """Health check endpoint that validates DB connectivity."""
        from sqlalchemy import text

        from ..jobs.event_store import EventStore

        result = {"status": "ok", "dask_available": dask_available, "db": "ok"}

        # Check DB connectivity using any cached async engine
        try:
            cache = EventStore._async_engine_cache
            if cache:
                engine = next(iter(cache.values()))[0]
                async with engine.connect() as conn:
                    await asyncio.wait_for(conn.execute(text("SELECT 1")), timeout=3.0)
            else:
                result["db"] = "no_engine"
        except Exception:
            logger.warning("Health check DB ping failed", exc_info=True)
            result["status"] = "degraded"
            result["db"] = "unreachable"
            from fastapi.responses import JSONResponse

            return JSONResponse(status_code=503, content=result)

        return result

    @app.post(
        "/v1/jobs/async/submit",
        response_model=JobStatusResponse,
        tags=["async jobs"],
        summary="Submit a new async job",
        description=(
            "Submit a research query to a registered agent. Returns a job ID for tracking progress via SSE stream."
        ),
        responses={
            400: {"description": "Unknown agent type or invalid request"},
            409: {"description": "A job with the supplied job_id already exists"},
            422: {"description": "One or more unknown or agent-unavailable data source IDs"},
            503: {"description": "Dask scheduler not available"},
        },
    )
    async def submit_job(
        req: Annotated[JobSubmitRequest, Body(openapi_examples=JOB_SUBMIT_EXAMPLES)],
    ) -> JobStatusResponse:
        """Submit a new async job for deep research or other registered agents."""
        try:
            agent_config = get_agent_config(req.agent_type)
        except KeyError as e:
            raise HTTPException(400, str(e))

        expiry = req.expiry_seconds if req.expiry_seconds is not None else default_expiry_seconds
        # Authenticate the caller (raises 401/403 if unverified). The returned principal
        # is also forwarded to submit_authorized_job(...) below for ownership recording.
        principal = require_verified_principal()
        validation_start = time.perf_counter()
        await _validate_data_sources_for_agent(
            builder=builder,
            agent_type=req.agent_type,
            agent_config_name=agent_config.config_name,
            data_sources=req.data_sources,
        )
        logger.info(
            "Validated data_sources for agent %s in %.1fms (requested=%s)",
            req.agent_type,
            (time.perf_counter() - validation_start) * 1000,
            len(req.data_sources) if req.data_sources is not None else "none",
        )

        # Propagate auth token to Dask worker for requires_auth data sources
        from aiq_agent.auth import get_auth_token

        auth_token = get_auth_token()
        try:
            job_id = await submit_authorized_job(
                agent_type=req.agent_type,
                input_text=req.input,
                owner=principal.email or principal.sub,
                principal=principal,
                job_id=req.job_id,
                expiry_seconds=expiry,
                data_sources=req.data_sources,
                auth_token=auth_token,
            )
        except JobAdmissionError as e:
            raise HTTPException(429, str(e), headers={"Retry-After": str(e.retry_after_seconds)})
        except DuplicateJobIdError as e:
            # Caller-supplied job_id collides with an existing job; letting the
            # submission proceed would rewrite the original job's ownership.
            raise HTTPException(409, str(e))
        except SchedulerNotConfiguredError as e:
            # Server misconfiguration, not an authorization failure.
            raise HTTPException(503, str(e))
        except MissingPrincipalError as e:
            # Static, user-safe message defined in jobs/submit.py.
            raise HTTPException(403, str(e))
        except RuntimeError:
            # Arbitrary internal error text (hosts, DSNs, stack details) must
            # never be echoed to clients. Log the full exception server-side.
            logger.exception("Runtime error submitting async %s job", req.agent_type)
            raise HTTPException(500, "Failed to submit async job")
        except Exception as e:
            logger.warning("Failed to submit authorized job: %s", e)
            raise HTTPException(500, "Failed to persist async job authorization metadata")

        logger.info(
            "Submitted %s job %s (expiry=%ds) for principal %s:%s",
            req.agent_type,
            job_id,
            expiry,
            principal.type,
            principal.sub,
        )
        return JobStatusResponse(
            job_id=job_id,
            status=JobStatus.SUBMITTED.value,
            agent_type=req.agent_type,
        )

    @app.get(
        "/v1/jobs/async/job/{job_id}",
        response_model=JobStatusResponse,
        tags=["async jobs"],
        summary="Get job status",
        description="Get the current status of an async job by its ID.",
        responses={404: {"description": "Job not found"}},
    )
    async def get_job_status(job_id: str) -> JobStatusResponse:
        """Get the current status of a job."""
        principal = require_verified_principal()
        job = await authorize_job_access(job_store, db_url, job_id, principal)

        return JobStatusResponse(
            job_id=job_id,
            status=job.status,
            error=job.error,
            created_at=job.created_at.isoformat() if job.created_at else None,
        )

    @app.get(
        "/v1/jobs/async/job/{job_id}/stream",
        tags=["async jobs"],
        summary="Stream job events",
        description=(
            "Server-Sent Events (SSE) stream of job progress from the beginning."
            " Includes tool calls, intermediate results, and the final report."
        ),
        responses={404: {"description": "Job not found"}},
    )
    async def stream_job_events(job_id: str) -> StreamingResponse:
        """SSE stream for job events from beginning."""
        principal = require_verified_principal()
        await authorize_job_access(job_store, db_url, job_id, principal)

        return StreamingResponse(
            _sse_generator(job_store, job_id, db_url, start_event_id=0),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get(
        "/v1/jobs/async/job/{job_id}/stream/{last_event_id}",
        tags=["async jobs"],
        summary="Resume job event stream",
        description="Resume an SSE stream from a specific event ID. Use for reconnection after network interruption.",
        responses={404: {"description": "Job not found"}},
    )
    async def stream_job_events_from(job_id: str, last_event_id: int) -> StreamingResponse:
        """SSE stream for job events from specific event ID (for reconnection)."""
        principal = require_verified_principal()
        await authorize_job_access(job_store, db_url, job_id, principal)

        return StreamingResponse(
            _sse_generator(job_store, job_id, db_url, start_event_id=last_event_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post(
        "/v1/jobs/async/job/{job_id}/cancel",
        tags=["async jobs"],
        summary="Cancel a submitted or running job",
        description="Request cancellation of a submitted or running job. The job status will be set to INTERRUPTED.",
        responses={
            400: {"description": "Job is not in a cancellable (SUBMITTED or RUNNING) state"},
            404: {"description": "Job not found"},
        },
    )
    async def cancel_job(job_id: str) -> dict:
        """Cancel a submitted or running job."""
        principal = require_verified_principal()
        job = await authorize_job_access(job_store, db_url, job_id, principal)

        # SUBMITTED is cancellable too: a job stuck before its first status
        # transition would otherwise be un-cancellable while still consuming
        # admission-control quota (count_active_jobs counts non-terminal jobs).
        if job.status not in (JobStatus.RUNNING.value, JobStatus.SUBMITTED.value):
            raise HTTPException(400, f"Job not cancellable: {job_id} (status: {job.status})")

        await job_store.update_status(job_id, JobStatus.INTERRUPTED, error="cancelled by user")

        def _record_cancellation_event() -> None:
            # EventStore construction and store() are blocking DB I/O — keep
            # them off the event loop like the rest of this module.
            event_store = EventStore(db_url, job_id)
            event_store.store(
                {
                    "type": "job.cancellation_requested",
                    "data": {"reason": "cancelled by user"},
                }
            )

        await asyncio.get_running_loop().run_in_executor(None, _record_cancellation_event)

        if job_execution_mode() == "db":
            # DB-claimed execution (ADR-0021): removing the queue row drops an
            # unclaimed job so no worker ever runs it; a running worker sees the
            # INTERRUPTED status via its CancellationMonitor and stops on its own.
            # No scheduler is involved, so the Dask cancel is skipped.
            from ..jobs import queue

            await asyncio.get_running_loop().run_in_executor(None, queue.mark_done, db_url, job_id)
            task_cancelled = False
        else:
            task_cancelled = await _cancel_dask_task(scheduler_address, job_id)

        logger.info("Cancel requested for job %s: status updated, task_cancelled=%s", job_id, task_cancelled)

        return {"job_id": job_id, "status": JobStatus.INTERRUPTED.value, "task_cancelled": task_cancelled}

    @app.get(
        "/v1/jobs/async/job/{job_id}/state",
        response_model=JobStateResponse,
        tags=["async jobs"],
        summary="Get job artifacts",
        description="Get tool calls, outputs, and sources collected during job execution.",
        responses={404: {"description": "Job not found"}},
    )
    async def get_job_state(job_id: str) -> JobStateResponse:
        """Get artifacts from event store."""
        principal = require_verified_principal()
        await authorize_job_access(job_store, db_url, job_id, principal)

        artifacts = await _get_job_artifacts(db_url, job_id)
        return JobStateResponse(
            job_id=job_id,
            has_state=artifacts is not None,
            state=None,
            artifacts=artifacts,
        )

    @app.get(
        "/v1/jobs/async/job/{job_id}/report",
        response_model=JobReportResponse,
        tags=["async jobs"],
        summary="Get final report",
        description="Get the final research report from a completed job.",
        responses={404: {"description": "Job not found"}},
    )
    async def get_job_report(job_id: str) -> JobReportResponse:
        """Get the final report from a completed job."""
        principal = require_verified_principal()
        job = await authorize_job_access(job_store, db_url, job_id, principal)

        report = None
        if job.output:
            try:
                output = json.loads(job.output) if isinstance(job.output, str) else job.output
                report = output.get("report")
            except (json.JSONDecodeError, AttributeError):
                pass

        return JobReportResponse(job_id=job_id, has_report=bool(report), report=report)

    @app.get(
        "/v1/jobs/async/jobs",
        response_model=ResearchRunsResponse,
        tags=["async jobs"],
        summary="List research runs",
        description=(
            "List async job runs (research runs), optionally filtered by project collection, "
            "conversation, and/or status. Scoped to the caller's own jobs, consistent with "
            "single-job access checks elsewhere in this API."
        ),
    )
    async def list_research_runs(
        project_collection: str | None = None,
        conversation_id: str | None = None,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> ResearchRunsResponse:
        """List research runs matching the given filters, newest first."""
        principal = require_verified_principal()

        clamped_limit = max(1, min(limit, 200))
        clamped_offset = max(0, offset)

        # Mirrors authorize_job_access: ownership is only enforced when REQUIRE_AUTH=true.
        enforce_owner = os.environ.get("REQUIRE_AUTH", "false").lower() == "true"

        loop = asyncio.get_running_loop()
        rows, total = await loop.run_in_executor(
            None,
            _find_research_runs,
            db_url,
            enforce_owner,
            principal.type,
            principal.sub,
            project_collection,
            conversation_id,
            status,
            clamped_limit,
            clamped_offset,
        )

        jobs = [
            ResearchRunItem(
                job_id=row["job_id"],
                status=row["status"],
                created_at=_format_created_at(row["created_at"]),
                conversation_id=row["conversation_id"],
                project_collection=row["project_collection"],
            )
            for row in rows
        ]
        return ResearchRunsResponse(jobs=jobs, total=total)

    logger.info("Registered async job routes at /v1/jobs/async")

    # Ensure job_events table exists before reaper runs (reaper queries it via raw SQL;
    # table is otherwise created lazily on first EventStore write).
    EventStore._ensure_table_exists(db_url)

    # Start the ghost job reaper background task
    asyncio.create_task(_reap_ghost_jobs(job_store, db_url, scheduler_address))

    # Start periodic cleanup of expired jobs (NAT's job_info table) and old events (job_events table).
    # NAT provides periodic_cleanup as a Dask task for job_info, but it must be explicitly submitted.
    # We also run a local asyncio task for job_events cleanup since NAT doesn't manage that table.
    _start_periodic_cleanup(job_store, scheduler_address, db_url, default_expiry_seconds, log_level, use_threads)


GHOST_JOB_TIMEOUT_SECONDS = 300  # 5 minutes without events = ghost job
GHOST_REAPER_INTERVAL_SECONDS = 60  # check every 60 seconds


def _find_stale_jobs(db_url: str, active_statuses: tuple[str, ...]) -> list[str]:
    """
    Sync helper to query for ghost jobs in any of the given non-terminal statuses.

    Runs in a thread via run_in_executor to avoid blocking the async event loop
    with DB I/O.
    """
    from sqlalchemy import inspect
    from sqlalchemy import text

    from ..jobs.event_store import EventStore

    EventStore._ensure_table_exists(db_url)
    engine = EventStore._get_or_create_sync_engine(db_url)
    inspector = inspect(engine)
    if not inspector.has_table("job_events"):
        return []

    status_placeholders = ", ".join(f":s{i}" for i in range(len(active_statuses)))
    status_params: dict[str, Any] = {f"s{i}": status for i, status in enumerate(active_statuses)}

    with engine.connect() as conn:
        if db_url.startswith("postgres"):
            stale_query = text(
                "SELECT DISTINCT je.job_id FROM job_events je "
                "INNER JOIN job_info ji ON je.job_id = ji.job_id "
                f"WHERE ji.status IN ({status_placeholders}) "
                "GROUP BY je.job_id "
                "HAVING MAX(je.created_at) < NOW() - :timeout * INTERVAL '1 second'"
            )
            params: dict[str, Any] = {**status_params, "timeout": GHOST_JOB_TIMEOUT_SECONDS}
        else:
            stale_query = text(
                "SELECT DISTINCT je.job_id FROM job_events je "
                "INNER JOIN job_info ji ON je.job_id = ji.job_id "
                f"WHERE ji.status IN ({status_placeholders}) "
                "GROUP BY je.job_id "
                "HAVING MAX(je.created_at) < datetime('now', :timeout_interval)"
            )
            params = {
                **status_params,
                "timeout_interval": f"-{GHOST_JOB_TIMEOUT_SECONDS} seconds",
            }

        result = conn.execute(stale_query, params)
        stale_ids = [row[0] for row in result]

        # Second predicate: active jobs that never produced a single event.
        # The INNER JOIN above can't match them, but they are exactly the
        # crash classes the reaper exists for: a worker that died during agent
        # setup (RUNNING, before the first heartbeat/callback event), or a job
        # stuck in SUBMITTED whose Dask task was never picked up. Timestamps
        # come from job_info since these jobs have no events at all. Without
        # this they hold admission-control slots forever.
        if db_url.startswith("postgres"):
            eventless_query = text(
                "SELECT ji.job_id FROM job_info ji "
                "LEFT JOIN job_events je ON je.job_id = ji.job_id "
                f"WHERE ji.status IN ({status_placeholders}) AND je.job_id IS NULL "
                "AND COALESCE(ji.updated_at, ji.created_at) < NOW() - :timeout * INTERVAL '1 second'"
            )
            eventless_params: dict[str, Any] = {**status_params, "timeout": GHOST_JOB_TIMEOUT_SECONDS}
        else:
            eventless_query = text(
                "SELECT ji.job_id FROM job_info ji "
                "LEFT JOIN job_events je ON je.job_id = ji.job_id "
                f"WHERE ji.status IN ({status_placeholders}) AND je.job_id IS NULL "
                "AND datetime(COALESCE(ji.updated_at, ji.created_at)) < datetime('now', :timeout_interval)"
            )
            eventless_params = {
                **status_params,
                "timeout_interval": f"-{GHOST_JOB_TIMEOUT_SECONDS} seconds",
            }

        result = conn.execute(eventless_query, eventless_params)
        stale_ids.extend(row[0] for row in result)
        return stale_ids


def _format_created_at(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def _find_research_runs(
    db_url: str,
    enforce_owner: bool,
    owner_auth_type: str | None,
    owner_subject: str | None,
    project_collection: str | None,
    conversation_id: str | None,
    status: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict], int]:
    """
    Sync helper to query research runs (job_access joined with NAT's job_info).

    Runs in a thread via run_in_executor to avoid blocking the event loop with DB I/O.
    Mirrors the raw-SQL, sync-engine query pattern used by ``_find_stale_jobs`` above.

    When ``enforce_owner`` is True (REQUIRE_AUTH=true), results are scoped to the
    given owner_auth_type/owner_subject pair -- the same principal match performed
    by ``authorize_job_access``. When False (auth disabled), ownership is not
    enforced, consistent with how ``authorize_job_access`` treats no-auth
    deployments.
    """
    from sqlalchemy import inspect
    from sqlalchemy import text

    from ..jobs.event_store import EventStore

    EventStore._ensure_table_exists(db_url)
    engine = EventStore._get_or_create_sync_engine(db_url)

    # job_info is created by NAT's JobStore; on a fresh database where no job
    # has ever been submitted it may not exist yet, and the JOIN below would
    # 500 the listing instead of returning an empty page (same guard as
    # _find_stale_jobs uses for job_events).
    if not inspect(engine).has_table("job_info"):
        return [], 0

    conditions: list[str] = []
    params: dict[str, Any] = {}

    if enforce_owner:
        conditions.append("ja.owner_auth_type = :owner_auth_type AND ja.owner_subject = :owner_subject")
        params["owner_auth_type"] = owner_auth_type
        params["owner_subject"] = owner_subject
    if project_collection is not None:
        conditions.append("ja.project_collection = :project_collection")
        params["project_collection"] = project_collection
    if conversation_id is not None:
        conditions.append("ja.conversation_id = :conversation_id")
        params["conversation_id"] = conversation_id
    if status is not None:
        conditions.append("ji.status = :status")
        params["status"] = status

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    join_sql = "FROM job_access ja INNER JOIN job_info ji ON ja.job_id = ji.job_id"

    with engine.connect() as conn:
        total = conn.execute(text(f"SELECT COUNT(*) {join_sql} {where_clause}"), params).scalar() or 0

        rows = (
            conn.execute(
                text(
                    "SELECT ja.job_id, ji.status, ji.created_at, ja.conversation_id, ja.project_collection "
                    f"{join_sql} {where_clause} "
                    # job_id tiebreaker: created_at alone is not unique, and an
                    # unstable order across pages would duplicate/drop rows
                    # during offset pagination.
                    "ORDER BY ji.created_at DESC, ja.job_id DESC "
                    "LIMIT :limit OFFSET :offset"
                ),
                {**params, "limit": limit, "offset": offset},
            )
            .mappings()
            .all()
        )

    return [dict(row) for row in rows], total


async def _reap_stale_jobs_once(job_store, db_url: str, scheduler_address: str | None = None) -> list[str]:
    """Run a single reap cycle: mark stale jobs FAILURE and cancel their Dask tasks.

    Returns the list of reaped job IDs. Factored out of _reap_ghost_jobs for
    testability.
    """
    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    from ..jobs.event_store import EventStore

    loop = asyncio.get_running_loop()

    # SUBMITTED jobs are reaped too: they may have ZERO events (never picked up
    # by a worker) yet still consume admission quota (count_active_jobs counts
    # all non-terminal jobs).
    stale_statuses = (JobStatus.RUNNING.value, JobStatus.SUBMITTED.value)
    stale_job_ids = await loop.run_in_executor(None, _find_stale_jobs, db_url, stale_statuses)

    for stale_job_id in stale_job_ids:
        logger.warning("Reaping ghost job %s (no events for %ds)", stale_job_id, GHOST_JOB_TIMEOUT_SECONDS)
        try:
            await job_store.update_status(
                stale_job_id,
                JobStatus.FAILURE,
                error="Job timed out (no heartbeat received from worker)",
            )
            event_store = EventStore(db_url, stale_job_id)
            event_store.store(
                {
                    "type": "job.error",
                    "data": {
                        "error": "Job timed out (no heartbeat received from worker)",
                        "error_type": "GhostJobTimeout",
                    },
                }
            )
            # Stop the worker like the cancel route does: writing FAILURE alone
            # leaves the Dask task running, wasting resources (terminal-status
            # stickiness in the runner prevents it from flipping the status,
            # and its CancellationMonitor stops it once it polls the FAILURE).
            if scheduler_address:
                await _cancel_dask_task(scheduler_address, stale_job_id)
        except Exception as e:
            logger.warning("Failed to reap ghost job %s: %s", stale_job_id, e)

    return stale_job_ids


async def _reap_ghost_jobs(job_store, db_url: str, scheduler_address: str | None = None) -> None:
    """
    Background task that periodically marks stale RUNNING/SUBMITTED jobs as FAILURE.

    A job is considered "ghost" if it has been non-terminal for over
    GHOST_JOB_TIMEOUT_SECONDS with no new events in the job_events table
    (falling back to job_info timestamps for jobs that never produced events).
    This catches Dask worker crashes and OOM kills that bypass Python exception
    handling, as well as SUBMITTED jobs that were never picked up.
    """
    logger.info(
        "Ghost job reaper started (timeout=%ds, interval=%ds)",
        GHOST_JOB_TIMEOUT_SECONDS,
        GHOST_REAPER_INTERVAL_SECONDS,
    )

    while True:
        try:
            await asyncio.sleep(GHOST_REAPER_INTERVAL_SECONDS)
            await _reap_stale_jobs_once(job_store, db_url, scheduler_address)
        except asyncio.CancelledError:
            logger.info("Ghost job reaper stopped")
            break
        except Exception as e:
            logger.warning("Ghost job reaper error: %s", e)


_cleanup_task: asyncio.Task | None = None
"""Module-level reference for graceful shutdown cancellation."""

# Advisory lock ID for PostgreSQL — ensures only one pod runs cleanup at a time.
# Arbitrary constant; change if it collides with another lock in your deployment.
_PG_ADVISORY_LOCK_ID = 0x41495143_4C45414E  # "AIQCLEAN" in hex


def _start_periodic_cleanup(
    job_store,
    scheduler_address: str,
    db_url: str,
    expiry_seconds: int,
    log_level: int,
    use_threads: bool,
) -> None:
    """
    Start periodic cleanup of expired jobs and old events.

    Submits NAT's periodic_cleanup as a Dask task (handles job_info expiry)
    and starts a local asyncio task for coordinated event cleanup.
    """
    global _cleanup_task

    # Cleanup interval: half the expiry time, clamped to [60s, 3600s]
    cleanup_interval = max(60, min(expiry_seconds // 2, 3600))

    # Submit NAT's periodic_cleanup as a long-running Dask task for job_info table.
    # In db-execution mode (ADR-0021) there is no Dask client; job_info expiry is
    # instead handled by the shared-Postgres event/expiry paths, so skip cleanly.
    if getattr(job_store, "dask_client", None) is None:
        logger.info("No Dask client (db execution) - skipping NAT periodic_cleanup Dask submit")
    else:
        try:
            from dask.distributed import fire_and_forget

            from nat.front_ends.fastapi.async_jobs import periodic_cleanup

            cleanup_future = job_store.dask_client.submit(
                periodic_cleanup,
                scheduler_address=scheduler_address,
                db_url=db_url,
                sleep_time_sec=cleanup_interval,
                configure_logging=not use_threads,
                log_level=log_level,
            )
            fire_and_forget(cleanup_future)
            logger.info(
                "Submitted periodic job cleanup task to Dask (interval=%ds, expiry=%ds)",
                cleanup_interval,
                expiry_seconds,
            )
        except Exception as e:
            logger.warning("Failed to submit periodic cleanup to Dask: %s", e)

    # Start local asyncio task for job_events table cleanup (NAT doesn't manage this table).
    # Uses pg_try_advisory_xact_lock on PostgreSQL so only one pod runs cleanup per cycle.
    # Cancel any previously-started task before overwriting the reference.
    if _cleanup_task and not _cleanup_task.done():
        _cleanup_task.cancel()
    _cleanup_task = asyncio.create_task(_cleanup_old_events_loop(db_url, expiry_seconds, cleanup_interval))


async def stop_periodic_cleanup() -> None:
    """Cancel the event cleanup background task. Call from shutdown handler."""
    global _cleanup_task
    if _cleanup_task and not _cleanup_task.done():
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass
        _cleanup_task = None
        logger.info("Event cleanup task cancelled")


async def _cleanup_old_events_loop(db_url: str, retention_seconds: int, interval_seconds: int) -> None:
    """
    Background task that periodically deletes old events from the job_events table
    and removes events for jobs already marked as expired in job_info.

    On PostgreSQL, uses pg_try_advisory_xact_lock so only one pod runs cleanup per cycle
    when multiple pods share the same database.
    """

    is_postgres = db_url.startswith("postgres")

    logger.info(
        "Event cleanup task started (retention=%ds, interval=%ds, advisory_lock=%s)",
        retention_seconds,
        interval_seconds,
        is_postgres,
    )

    # Run once immediately on startup to catch anything that aged out during downtime.
    try:
        await _run_event_cleanup(db_url, retention_seconds, is_postgres)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.warning("Event cleanup startup run failed: %s", e)

    while True:
        try:
            await asyncio.sleep(interval_seconds)
            await _run_event_cleanup(db_url, retention_seconds, is_postgres)
        except asyncio.CancelledError:
            logger.info("Event cleanup task stopped")
            break
        except Exception as e:
            logger.warning("Event cleanup error: %s", e)


async def _run_event_cleanup(db_url: str, retention_seconds: int, is_postgres: bool) -> None:
    """
    Execute one cleanup cycle: time-based event pruning + removal of events for expired jobs.

    On PostgreSQL, acquires a transaction-level advisory lock (pg_try_advisory_xact_lock)
    so concurrent pods skip the cycle rather than doing redundant work. The lock is
    automatically released on commit/rollback, avoiding leak risks.
    """
    from ..jobs.access import cleanup_job_access
    from ..jobs.event_store import EventStore

    loop = asyncio.get_running_loop()

    def _do_cleanup() -> tuple[int, int, int]:
        from sqlalchemy import text

        engine = EventStore._get_or_create_sync_engine(db_url)

        with engine.connect() as conn:
            # On PostgreSQL, acquire a transaction-level advisory lock. If another pod
            # already holds it, skip this cycle. The lock is automatically released
            # on commit/rollback — no manual unlock needed.
            if is_postgres:
                locked = conn.execute(
                    text("SELECT pg_try_advisory_xact_lock(:lock_id)"),
                    {"lock_id": _PG_ADVISORY_LOCK_ID},
                ).scalar()
                if not locked:
                    return (0, 0, 0)

            # 1. Time-based: delete events older than retention period
            if is_postgres:
                result = conn.execute(
                    text("DELETE FROM job_events WHERE created_at < NOW() - :seconds * INTERVAL '1 second'"),
                    {"seconds": retention_seconds},
                )
            else:
                result = conn.execute(
                    text("DELETE FROM job_events WHERE created_at < datetime('now', :interval)"),
                    {"interval": f"-{retention_seconds} seconds"},
                )
            time_deleted = result.rowcount

            # 2. Coordinated: delete events for jobs already marked expired in job_info.
            # This catches events that haven't aged out yet but whose parent job is
            # already expired (e.g. short-lived jobs with long event retention).
            expired_result = conn.execute(
                text("DELETE FROM job_events WHERE job_id IN (SELECT job_id FROM job_info WHERE is_expired = true)")
            )
            expired_deleted = expired_result.rowcount
            access_deleted = cleanup_job_access(db_url, conn=conn)

            conn.commit()
            return (time_deleted, expired_deleted, access_deleted)

    time_deleted, expired_deleted, access_deleted = await loop.run_in_executor(None, _do_cleanup)

    if time_deleted > 0 or expired_deleted > 0 or access_deleted > 0:
        logger.info(
            "Event cleanup: %d old events removed, %d events for expired jobs removed, %d access rows removed",
            time_deleted,
            expired_deleted,
            access_deleted,
        )


async def _cancel_dask_task(scheduler_address: str, job_id: str) -> bool:
    """
    Cancel a Dask task by job ID.

    Args:
        scheduler_address: Dask scheduler address.
        job_id: Job ID to cancel.

    Returns:
        True if a Dask cancellation request was sent, False otherwise.
    """
    if not scheduler_address:
        # db-execution mode (ADR-0021): no Dask scheduler. Cancellation is the
        # job_info status flip the caller already made; nothing to cancel here.
        return False
    try:
        from distributed import Client
        from distributed import Future

        async with Client(scheduler_address, asynchronous=True) as client:
            # NAT JobStore submits job futures with key ``{job_id}-job``. Targeting
            # the key directly avoids using Dask Variable.get as a maybe-exists
            # check, which logs scheduler-side timeout errors when the variable is
            # absent or slow to resolve.
            future = Future(f"{job_id}-job", client)
            await client.cancel([future], asynchronous=True, force=True)
            logger.info("Sent cancellation request for Dask task %s", future.key)
            return True
    except (ConnectionError, TimeoutError, OSError) as e:
        logger.warning("Failed to cancel Dask task for job %s: %s", job_id, e)
    except Exception as e:
        logger.warning("Unexpected error cancelling Dask task for job %s: %s", job_id, e)
    return False


def _extract_event_metadata(event: dict) -> tuple[dict, dict]:
    """Extract data and metadata from an event dict."""
    data = event.get("data", {}) if isinstance(event.get("data"), dict) else {}
    metadata = event.get("metadata", {}) if isinstance(event.get("metadata"), dict) else {}
    if not metadata and isinstance(data, dict):
        metadata = data.get("metadata", {}) or {}
    return data, metadata


def _process_tool_start(event: dict, data: dict, metadata: dict, tool_call_map: dict[str, dict]) -> None:
    """Process a tool.start event and add to tool_call_map.

    Stored events (IntermediateStepEvent.to_sse_dict) carry ``id``/``name`` at
    the top level and the tool input directly under ``data`` — not nested one
    level deeper.
    """
    tool_id = event.get("id", "")
    tool_call_map[tool_id] = {
        "id": tool_id,
        "name": event.get("name", ""),
        "input": data.get("input"),
        "output": None,
        "status": "running",
        "workflow": metadata.get("workflow"),
        "timestamp": event.get("timestamp"),
    }


def _process_tool_end(event: dict, data: dict, metadata: dict, tool_call_map: dict[str, dict]) -> None:
    """Process a tool.end event and update tool_call_map.

    tool.start and tool.end are separate events with distinct ``id``s, so the
    running entry is matched by tool name (the emitter resolves the name from
    the run_id on both sides).
    """
    tool_output = data.get("output")
    tool_name = event.get("name", "")

    running = next(
        (entry for entry in tool_call_map.values() if entry["name"] == tool_name and entry["status"] == "running"),
        None,
    )
    if running is not None:
        running["output"] = tool_output
        running["status"] = "completed"
    else:
        tool_id = event.get("id", "")
        tool_call_map[tool_id] = {
            "id": tool_id,
            "name": tool_name,
            "input": None,
            "output": tool_output,
            "status": "completed",
            "workflow": metadata.get("workflow"),
            "timestamp": event.get("timestamp"),
        }


def _normalize_url(url: str) -> str:
    """Normalize URL for consistent deduplication."""
    from urllib.parse import urlparse
    from urllib.parse import urlunparse

    try:
        parsed = urlparse(url)
        normalized_path = parsed.path.rstrip("/") if parsed.path != "/" else "/"
        return urlunparse(
            (
                parsed.scheme.lower(),
                parsed.netloc.lower(),
                normalized_path,
                parsed.params,
                parsed.query,
                "",
            )
        )
    except Exception:
        return url


def _is_valid_url(url: str) -> bool:
    """Check if string is a valid HTTP/HTTPS URL."""
    return bool(url and url.lower().startswith(("http://", "https://")))


def _process_artifact_update(
    event: dict,
    data: dict,
    metadata: dict,
    outputs: list[dict],
    sources_found: set[str],
    sources_cited: set[str],
) -> None:
    """Process an artifact.update event and add to outputs."""
    artifact_type = data.get("type")
    content = data.get("content")

    # Track citation sources and uses for accurate counts (with validation)
    if artifact_type == "citation_source":
        url = data.get("url") or content
        if _is_valid_url(url):
            sources_found.add(_normalize_url(url))
    elif artifact_type == "citation_use":
        url = data.get("url") or content
        if _is_valid_url(url):
            sources_cited.add(_normalize_url(url))

    if content:
        outputs.append(
            {
                "type": artifact_type,
                "content": content,
                "name": event.get("name"),
                "workflow": metadata.get("workflow"),
                "timestamp": event.get("timestamp"),
                **{k: v for k, v in data.items() if k not in ("type", "content")},
            }
        )


async def _get_job_artifacts(db_url: str, job_id: str) -> dict | None:
    """
    Extract artifacts from stored events.

    Returns a simplified structure with all tool calls, outputs, and source counts.
    Frontend categorizes tools by name (task=subagent, write_todos=middleware, etc.).

    Args:
        db_url: Database URL for event store.
        job_id: Job ID to fetch artifacts for.

    Returns:
        Dict with 'tools', 'outputs', and 'sources' (counts), or None if no artifacts found.
    """
    from ..jobs.event_store import EventStore

    try:
        events = await EventStore.get_events_async(db_url, job_id, 0, 10000)
        if not events:
            return None

        tool_call_map: dict[str, dict] = {}
        outputs: list[dict] = []
        sources_found: set[str] = set()
        sources_cited: set[str] = set()

        for event in events:
            event_type = event.get("type", "")
            data, metadata = _extract_event_metadata(event)

            if event_type == "tool.start":
                _process_tool_start(event, data, metadata, tool_call_map)
            elif event_type == "tool.end":
                _process_tool_end(event, data, metadata, tool_call_map)
            elif event_type == "artifact.update":
                _process_artifact_update(event, data, metadata, outputs, sources_found, sources_cited)

        tools = list(tool_call_map.values())
        result = {
            "tools": tools,
            "outputs": outputs,
            "sources": {
                "found": len(sources_found),
                "cited": len(sources_cited),
                "found_urls": list(sources_found),
                "cited_urls": list(sources_cited),
            },
        }
        return result if tools or outputs or sources_found else None

    except (KeyError, TypeError) as e:
        logger.warning("Failed to parse artifacts for job %s: %s", job_id, e)
        return None
    except Exception as e:
        logger.warning("Failed to get artifacts for job %s: %s", job_id, e)
        return None


async def _sse_generator(job_store, job_id: str, db_url: str, start_event_id: int = 0):
    """
    Route to appropriate SSE generator based on database type.

    PostgreSQL: Uses LISTEN/NOTIFY for real-time push-based events (sub-10ms latency).
    SQLite: Uses polling (0.5s interval) since SQLite doesn't support pub-sub.
    """
    from ..jobs.event_store import EventStore

    if EventStore.is_postgres(db_url):
        # Shared cursor: the pub-sub generator records the id of the last real
        # event it yielded so a mid-stream failure resumes the polling fallback
        # from there instead of replaying the whole stream from start_event_id.
        progress = {"last_event_id": start_event_id}
        try:
            async for event in _sse_generator_postgres(job_store, job_id, db_url, start_event_id, progress):
                yield event
        except Exception as e:
            logger.warning("Pub-sub failed, falling back to polling: %s", e)
            async for event in _sse_generator_polling(job_store, job_id, db_url, progress["last_event_id"]):
                yield event
    else:
        async for event in _sse_generator_polling(job_store, job_id, db_url, start_event_id):
            yield event


async def _sse_generator_postgres(
    job_store, job_id: str, db_url: str, start_event_id: int = 0, progress: dict[str, int] | None = None
):
    """
    PostgreSQL pub-sub based SSE generator - near-instant event delivery.

    Uses asyncpg LISTEN/NOTIFY for real-time push-based events.
    Achieves sub-10ms latency compared to 500ms polling interval.

    When ``progress`` is provided, its ``last_event_id`` entry is kept in sync
    with the cursor of the last real event yielded, so the caller can resume a
    polling fallback from there after a mid-stream failure.
    """
    import asyncio

    import asyncpg

    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    from ..jobs.connection_manager import get_connection_manager
    from ..jobs.event_store import EventStore

    connection_manager = get_connection_manager()
    last_status = None
    last_event_id = start_event_id
    sequence_id = start_event_id
    terminal_statuses = {JobStatus.SUCCESS.value, JobStatus.FAILURE.value, JobStatus.INTERRUPTED.value}
    is_reconnect = start_event_id > 0

    def advance_cursor(event_id: int) -> None:
        nonlocal last_event_id
        last_event_id = event_id
        if progress is not None:
            progress["last_event_id"] = event_id

    def format_sse(event_type: str, data: dict, event_id: int | None = None) -> str:
        # Synthetic events (job.status, stream.mode, ...) reuse the last real
        # event id instead of advancing past it: id+1 is exactly the id the
        # next stored job_events row will get, so a client that disconnects
        # after a synthetic event would reconnect past a real event and lose it.
        nonlocal sequence_id
        if event_id is not None:
            sequence_id = event_id
        return f"id: {sequence_id}\nevent: {event_type}\ndata: {json.dumps(data)}\n\n"

    # LISTEN/NOTIFY needs a persistent session — incompatible with PgBouncer
    # transaction pooling. Use AIQ_LISTEN_DB_URL to point directly at PostgreSQL.
    import os

    listen_db_url = os.environ.get("AIQ_LISTEN_DB_URL", db_url)
    # Strip +psycopg2 before +psycopg (it's a prefix of the former) — this
    # codebase standardizes on postgresql+psycopg:// URLs, which asyncpg
    # rejects; a leftover driver suffix silently degrades every SSE stream
    # to polling ("Pub-sub failed, falling back to polling").
    asyncpg_url = (
        listen_db_url.replace("+psycopg2", "")
        .replace("+psycopg", "")
        .replace("+asyncpg", "")
        .replace("postgresql://", "postgres://")
    )
    channel = f"job_events_{job_id.replace('-', '_')}"

    logger.info(f"SSE pub-sub stream starting for job_id={job_id}, channel={channel}")

    conn = None
    notification_queue: asyncio.Queue = asyncio.Queue()

    def notification_handler(connection, pid, channel_name, payload):
        try:
            notification_queue.put_nowait(payload)
        except asyncio.QueueFull:
            logger.warning("Notification queue full for job %s", job_id)

    try:
        conn = await asyncpg.connect(asyncpg_url)
        await conn.add_listener(channel, notification_handler)
        logger.info(f"SSE: Listening on channel {channel}")

        async with connection_manager.track_connection():
            job = await job_store.get_job(job_id)
            if not job:
                logger.warning(f"SSE pub-sub: Job {job_id} not found")
                yield format_sse("job.error", {"error": "Job not found"})
                return

            job_already_complete = job.status in terminal_statuses

            events = await EventStore.get_events_async(db_url, job_id, last_event_id, 10000)
            logger.info(
                f"SSE pub-sub: Fetched {len(events)} historical events for job {job_id} (after_id={last_event_id})"
            )

            for event in events:
                db_event_id = event.pop("_id", None)
                if db_event_id:
                    advance_cursor(db_event_id)
                event_type = event.pop("type", "event")
                yield format_sse(event_type, event, db_event_id)

            yield format_sse("stream.mode", {"mode": "pubsub", "channel": channel})

            # Reconciliation fetch: catch events that arrived while sending the historical batch.
            # The LISTEN handler may have queued notifications for some of these, but a direct
            # fetch ensures no gap between the historical batch and the live stream.
            reconcile_events = await EventStore.get_events_async(db_url, job_id, last_event_id, 1000)
            if reconcile_events:
                logger.info(f"SSE pub-sub: Reconciliation fetched {len(reconcile_events)} events for job {job_id}")
                for event in reconcile_events:
                    db_event_id = event.pop("_id", None)
                    if db_event_id:
                        advance_cursor(db_event_id)
                    event_type = event.pop("type", "event")
                    yield format_sse(event_type, event, db_event_id)

            if job_already_complete:
                last_status = job.status
                data = {"status": job.status}
                if job.error:
                    data["error"] = job.error
                if is_reconnect:
                    data["reconnected"] = True
                yield format_sse("job.status", data)
                logger.info(f"SSE pub-sub: Job {job_id} already complete, sent {len(events)} events")
                return

            while True:
                if connection_manager.is_shutting_down:
                    logger.info("SSE pub-sub stream closing for job %s due to server shutdown", job_id)
                    yield format_sse("job.shutdown", {"message": "Server shutting down"})
                    break

                try:
                    try:
                        payload = await asyncio.wait_for(notification_queue.get(), timeout=5.0)
                        notification_data = json.loads(payload)
                        event_id = notification_data.get("id")

                        if event_id and event_id > last_event_id:
                            # Range-fetch from the cursor instead of fetching the
                            # notified id alone: NOTIFYs can be lost or arrive out
                            # of order, and jumping last_event_id straight to the
                            # notified id would drop the unseen rows in between
                            # forever.
                            new_events = await EventStore.get_events_async(db_url, job_id, last_event_id, 1000)
                            for event in new_events:
                                db_event_id = event.pop("_id", None)
                                if db_event_id:
                                    advance_cursor(db_event_id)
                                event_type = event.pop("type", "event")
                                yield format_sse(event_type, event, db_event_id)
                    except TimeoutError:
                        # Fallback poll: catch events if NOTIFY was lost
                        fallback_events = await EventStore.get_events_async(db_url, job_id, last_event_id, 100)
                        for event in fallback_events:
                            db_event_id = event.pop("_id", None)
                            if db_event_id:
                                advance_cursor(db_event_id)
                            event_type = event.pop("type", "event")
                            yield format_sse(event_type, event, db_event_id)

                    job = await job_store.get_job(job_id)
                    if not job:
                        logger.warning(f"SSE pub-sub: Job {job_id} not found")
                        yield format_sse("job.error", {"error": "Job not found"})
                        break

                    if job.status != last_status:
                        last_status = job.status
                        logger.info(f"SSE pub-sub: Job {job_id} status changed to {job.status}")
                        data = {"status": job.status}
                        if job.error:
                            data["error"] = job.error
                        if is_reconnect:
                            data["reconnected"] = True
                            is_reconnect = False
                        yield format_sse("job.status", data)

                    if job.status in terminal_statuses:
                        await asyncio.sleep(0.5)
                        # Terminal drain via one final range fetch after the
                        # cursor (rather than draining queued notifications
                        # id-by-id): the job's last events — including the final
                        # report artifact — must not be lost to a dropped NOTIFY.
                        final_events = await EventStore.get_events_async(db_url, job_id, last_event_id, 10000)
                        for event in final_events:
                            db_event_id = event.pop("_id", None)
                            if db_event_id:
                                advance_cursor(db_event_id)
                            event_type = event.pop("type", "event")
                            yield format_sse(event_type, event, db_event_id)
                        break

                except asyncio.CancelledError:
                    logger.info("SSE pub-sub stream cancelled for job %s", job_id)
                    break
                except Exception as e:
                    logger.exception("SSE pub-sub stream error for job %s: %s", job_id, e)
                    yield format_sse("job.error", {"error": "Internal server error"})
                    break

    finally:
        if conn:
            try:
                await conn.remove_listener(channel, notification_handler)
                await conn.close()
                logger.info(f"SSE pub-sub: Closed connection for job {job_id}")
            except Exception as e:
                logger.warning(f"SSE pub-sub: Error closing connection for job {job_id}: {e}")


async def _sse_generator_polling(job_store, job_id: str, db_url: str, start_event_id: int = 0):
    """
    Polling-based SSE generator for SQLite and fallback scenarios.

    Replays historical events as fast as possible, then switches to live polling mode.
    Live mode uses a 0.5s polling interval and is suitable for local development with SQLite.
    Supports reconnection via start_event_id - replays events after that ID without delay.
    Supports graceful shutdown via the SSE connection manager.
    """
    import asyncio

    from nat.front_ends.fastapi.async_jobs.job_store import JobStatus

    from ..jobs.connection_manager import get_connection_manager
    from ..jobs.event_store import EventStore

    connection_manager = get_connection_manager()
    last_status = None
    last_event_id = start_event_id
    sequence_id = start_event_id
    terminal_statuses = {JobStatus.SUCCESS.value, JobStatus.FAILURE.value, JobStatus.INTERRUPTED.value}
    is_reconnect = start_event_id > 0
    in_replay_mode = True
    replay_mode_announced = False

    def format_sse(event_type: str, data: dict, event_id: int | None = None) -> str:
        # Synthetic events (job.status, stream.mode, ...) reuse the last real
        # event id instead of advancing past it: id+1 is exactly the id the
        # next stored job_events row will get, so a client that disconnects
        # after a synthetic event would reconnect past a real event and lose it.
        nonlocal sequence_id
        if event_id is not None:
            sequence_id = event_id
        return f"id: {sequence_id}\nevent: {event_type}\ndata: {json.dumps(data)}\n\n"

    logger.info(
        "SSE polling stream starting for job_id=%s, start_event_id=%s, db_url=%s",
        job_id,
        start_event_id,
        redact_db_url(db_url),
    )

    async with connection_manager.track_connection():
        yield format_sse("stream.mode", {"mode": "polling", "interval_ms": 500})

        while True:
            if connection_manager.is_shutting_down:
                logger.info("SSE stream closing for job %s due to server shutdown", job_id)
                yield format_sse("job.shutdown", {"message": "Server shutting down"})
                break

            try:
                job = await job_store.get_job(job_id)
                if not job:
                    logger.warning(f"SSE: Job {job_id} not found")
                    yield format_sse("job.error", {"error": "Job not found"})
                    break

                # Replay mode drains historical events quickly without wait delays.
                # Live mode returns to regular polling cadence.
                if in_replay_mode:
                    limit = 10000 if job.status in terminal_statuses else 1000
                else:
                    limit = 10000 if job.status in terminal_statuses else 100
                events = await EventStore.get_events_async(db_url, job_id, last_event_id, limit)

                if events:
                    logger.info(f"SSE: Fetched {len(events)} events for job {job_id} (after_id={last_event_id})")
                elif job.status in terminal_statuses:
                    logger.warning(f"SSE: No events found for completed job {job_id} (after_id={last_event_id})")

                for i, event in enumerate(events):
                    if connection_manager.is_shutting_down:
                        logger.info("SSE stream closing for job %s due to server shutdown (mid-batch)", job_id)
                        yield format_sse("job.shutdown", {"message": "Server shutting down"})
                        return

                    try:
                        db_event_id = event.pop("_id", None)
                        if db_event_id:
                            last_event_id = db_event_id
                        event_type = event.pop("type", "event")
                        sse_output = format_sse(event_type, event, db_event_id)
                        yield sse_output
                    except Exception as e:
                        logger.error(f"SSE: Failed to yield event {i} (id={db_event_id}): {e}", exc_info=True)

                # Transition to live mode after historical catch-up:
                # - no more events after current cursor, or
                # - fetched a partial replay batch (< limit), indicating we've reached the current tail.
                if in_replay_mode and (not events or len(events) < limit):
                    in_replay_mode = False
                    replay_mode_announced = True
                    logger.info(
                        "SSE: Replay complete for job %s at event_id=%s; switching to live mode", job_id, last_event_id
                    )
                    yield format_sse("stream.mode", {"mode": "live"})

                if job.status != last_status:
                    last_status = job.status
                    logger.info(f"SSE: Job {job_id} status changed to {job.status}")
                    data = {"status": job.status}
                    if job.error:
                        data["error"] = job.error
                    if is_reconnect:
                        data["reconnected"] = True
                        is_reconnect = False
                    yield format_sse("job.status", data)

                if job.status in terminal_statuses:
                    break

                # During replay we intentionally avoid polling delays so clients can catch up quickly.
                if in_replay_mode:
                    continue

                # If replay was completed in a prior iteration but stream.mode couldn't be emitted
                # (e.g., due to an exception path), emit it once before waiting.
                if not in_replay_mode and not replay_mode_announced:
                    replay_mode_announced = True
                    yield format_sse("stream.mode", {"mode": "live"})

                shutdown_signaled = await connection_manager.wait_or_shutdown(0.5)
                if shutdown_signaled:
                    logger.info("SSE stream closing for job %s due to server shutdown (during wait)", job_id)
                    yield format_sse("job.shutdown", {"message": "Server shutting down"})
                    break

            except asyncio.CancelledError:
                logger.info("SSE stream cancelled for job %s", job_id)
                break
            except Exception as e:
                logger.exception("SSE stream error for job %s: %s", job_id, e)
                yield format_sse("job.error", {"error": "Internal server error"})
                break
