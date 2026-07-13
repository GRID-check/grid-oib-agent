# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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
import uuid
from typing import Any

from starlette.datastructures import Headers

from .callbacks import AgentEventCallback
from .event_store import BatchingEventStore
from .event_store import EventStore

logger = logging.getLogger(__name__)


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
    when the job status changes to INTERRUPTED.
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

        while not self._cancelled.is_set():
            try:
                job = await job_store.get_job(self.job_id)
                if job and job.status == JobStatus.INTERRUPTED.value:
                    logger.info("Cancellation detected for job %s", self.job_id)
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
    from nat.builder.framework_enum import LLMFrameworkEnum

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
                llm_cache[llm_ref] = await builder.get_llm(llm_ref, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
            role_llms[role] = llm_cache[llm_ref]
            role_groups[role] = group

    default_group = AgentGroup.DEEP_RESEARCH
    default_llm = role_llms.get(LLMRole.ORCHESTRATOR)
    if default_llm is None:
        llm_ref = getattr(fn_config, "llm", None)
        if llm_ref:
            if llm_ref not in llm_cache:
                llm_cache[llm_ref] = await builder.get_llm(llm_ref, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
            default_llm = llm_cache[llm_ref]
            if getattr(fn_config, "type", None) == "shallow_research_agent":
                default_group = AgentGroup.SHALLOW_RESEARCH

    provider = LLMProvider()
    provider.set_default(default_llm, group=default_group)
    for role, llm in role_llms.items():
        provider.configure(role, llm, group=role_groups.get(role))

    return provider, default_llm


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
    model_overrides: dict[str, str] | None = None,
    usage_context: dict | None = None,
    user_info: dict | None = None,
    clarifier_result: str | None = None,
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
        await job_store.update_status(job_id, JobStatus.RUNNING)

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

            # BYOK (ADR-0022): resolve the org's own LLM credential just in
            # time from the BFF (never carried in job_args — plaintext keys
            # must not enter the persisted job store). The org id was captured
            # at submit time inside usage_context; resolution fails open to
            # the platform credential.
            _byok_org_id = ((usage_context or {}).get("identity") or {}).get("organization_id")
            if _byok_org_id:
                from aiq_agent.common import LLMRole
                from aiq_agent.common import resolve_org_llm_credential

                org_credential = resolve_org_llm_credential(_byok_org_id)
                if org_credential is not None:
                    credentialed = provider.with_credential(org_credential)
                    if credentialed is not provider:
                        provider = credentialed
                        if llm is not None:
                            llm = provider.get(LLMRole.ORCHESTRATOR)

            # Resolve tools: use explicit list or auto-inherit from
            # data_source_registry. `is None` (not falsy): an explicit
            # `tools: []` means a tool-less agent — the submit-route validator
            # treats it that way, and `not []` would silently hand such an
            # agent every registry tool instead.
            tool_refs = fn_config.tools
            if tool_refs is None:
                from aiq_agent.common import get_all_tool_refs

                tool_refs = get_all_tool_refs()

            tools = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)

            # Apply per-agent exclusions (e.g. deep_research excludes web_search_tool)
            if hasattr(fn_config, "exclude_tools") and fn_config.exclude_tools:
                excluded = set(fn_config.exclude_tools)
                tools = [t for t in tools if getattr(t, "name", "") not in excluded]

            if data_sources is not None:
                from aiq_agent.common import filter_tools_by_sources

                tools = filter_tools_by_sources(tools, data_sources)

            # Set up telemetry/observability for Phoenix and OpenTelemetry
            from nat.builder.context import Context
            from nat.builder.context import ContextState
            from nat.data_models.intermediate_step import IntermediateStepPayload
            from nat.data_models.intermediate_step import IntermediateStepType
            from nat.data_models.intermediate_step import StreamEventData
            from nat.data_models.intermediate_step import TraceMetadata
            from nat.data_models.invocation_node import InvocationNode
            from nat.observability.exporter_manager import ExporterManager
            from nat.plugins.langchain.callback_handler import LangchainProfilerHandler
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

                    # Create profiler callback AFTER workflow starts (ensures correct parent)
                    nat_profiler_callback = LangchainProfilerHandler()

                    verbose = is_verbose(getattr(fn_config, "verbose", False))
                    callbacks = [VerboseTraceCallback()] if verbose else []

                    raw_event_store = EventStore(db_url, job_id)
                    event_store = BatchingEventStore(raw_event_store)
                    agent_event_callback = AgentEventCallback(event_store)
                    callbacks.append(agent_event_callback)
                    callbacks.append(nat_profiler_callback)

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
                    )

                    # Run agent - LLM/tool events will be nested under workflow span.
                    # Unified LLM cost tracking covers every model call in the job;
                    # identity/budget were captured at submit time (no live request
                    # headers exist inside a Dask worker).
                    from aiq_agent.common.cost_tracking import BudgetSnapshot
                    from aiq_agent.common.cost_tracking import track_llm_costs

                    _usage = usage_context or {}
                    with track_llm_costs(
                        job_id=job_id,
                        identity=_usage.get("identity") or {},
                        budget=BudgetSnapshot.from_header(_usage.get("budget_header")) or BudgetSnapshot(),
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
                            project_context=project_context,
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
                    cards = await _generate_grid_cards(llm, input_text, report)
                    if cards:
                        # Card delivery is additive and must never flip an
                        # already-complete job to FAILURE — the report is done
                        # and persisted below regardless of this emit.
                        try:
                            agent_event_callback.emit_final_report(report, cards=cards)
                        except Exception:
                            logger.warning("Job %s: failed to emit final report with cards (non-fatal)", job_id)

                    # Flush any buffered events before updating status
                    if hasattr(event_store, "flush"):
                        event_store.flush()

                    output: dict[str, Any] = {"report": report}
                    if cards:
                        output["cards"] = cards
                    await job_store.update_status(job_id, JobStatus.SUCCESS, output=output)
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
                job = await job_store.get_job(job_id)
                if job and job.status != JobStatus.INTERRUPTED.value:
                    await job_store.update_status(job_id, JobStatus.INTERRUPTED, error="cancelled by user")
            except (ConnectionError, TimeoutError, RuntimeError):
                pass

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
        logger.exception("Job %s failed: %s", job_id, type(e).__name__)
        if job_store:
            await job_store.update_status(job_id, JobStatus.FAILURE, error=str(e))

        if event_store is None:
            event_store = BatchingEventStore(EventStore(db_url, job_id))

        event_store.store(
            {
                "type": "job.error",
                "data": {
                    "error": str(e),
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


def _create_agent_instance(
    agent_cls: type,
    llm_provider,
    llm,
    tools: list,
    fn_config,
    verbose: bool,
    callbacks: list,
    job_id: str | None = None,
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


async def _generate_grid_cards(llm: Any, query: str, report: str) -> list[dict] | None:
    """Generate Grid response cards from the final report.

    Best-effort: logs and returns None on any failure so card generation
    can never crash or fail the job.
    """
    try:
        from aiq_agent.cards import generate_cards

        cards = await generate_cards(llm, query, report)
        if cards:
            logger.info("Generated %d Grid card(s) for deep-research report", len(cards))
        return cards
    except Exception as e:
        logger.warning("Grid card generation failed (non-fatal): %s", e)
        return None


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
