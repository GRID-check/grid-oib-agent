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
Job submission utilities.

Provides functions to submit agent jobs to the Dask cluster.
"""

from __future__ import annotations

import asyncio
import logging
import os

from aiq_agent.auth import Principal
from aiq_agent.auth import get_current_principal
from aiq_api.auth import get_current_trace_tags

from ..registry import get_agent_config
from .access import _make_no_auth_principal
from .access import create_job_access
from .access import rollback_job_submission
from .runner import run_agent_job

logger = logging.getLogger(__name__)


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

    Returns:
        The job ID.

    Raises:
        KeyError: If agent_type is not registered.
        RuntimeError: If Dask scheduler is not configured.

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

    if not scheduler_address:
        raise RuntimeError("Async job submission requires NAT_DASK_SCHEDULER_ADDRESS to be set")

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

    # Capture caller identity + remaining budget for cost tracking in the worker.
    if usage_context is None:
        from aiq_agent.common.cost_tracking import capture_usage_context

        usage_context = capture_usage_context()

    if principal is None:
        principal = _resolve_submission_principal(owner)
    if principal is None:
        raise RuntimeError("Verified current principal required for async job submission")

    job_store = JobStore(scheduler_address=scheduler_address, db_url=db_url)
    resolved_job_id = job_store.ensure_job_id(job_id)
    loop = asyncio.get_running_loop()

    parent_trace_context = _get_parent_trace_context()
    parent_conversation_id = parent_trace_context[5]
    project_collection = _derive_project_collection(collection_scope)

    try:
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
        )
    except Exception:
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
