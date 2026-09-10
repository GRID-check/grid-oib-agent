"""Handing a deep-research turn to a worker instead of running it in process."""

from __future__ import annotations

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import TYPE_CHECKING
from typing import Protocol

from aiq_agent.auth import get_current_principal
from aiq_agent.common import get_latest_user_query
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common.platform_lessons import render_lessons_block
from aiq_agent.project_context import get_memory_reflection_enabled_from_context
from aiq_agent.turn.api_seam import async_job_dispatch
from aiq_agent.turn.api_seam import submit_agent_job

if TYPE_CHECKING:
    from aiq_agent.agents.researcher.models import ConversationState

logger = logging.getLogger(__name__)

JobSubmitter = Callable[["ConversationState"], Awaitable[str]]


class DispatchSettings(Protocol):
    """The two workflow-config fields the dispatch decision reads."""

    use_async_deep_research: bool
    memory_reflection_llm: str | None


def job_query(state: ConversationState) -> str:
    """The question the worker researches: the preserved query, else the latest user turn."""
    query = state.original_query or (get_latest_user_query(state.messages) if state.messages else None)
    if not query:
        raise RuntimeError("Cannot submit deep research job without a query.")
    return query if isinstance(query, str) else str(query)


async def submit_deep_research_job(state: ConversationState, *, memory_reflection_llm: str | None) -> str:
    """Submit this turn's deep research as a worker job; returns the job id.

    The structured fields travel as fields (not prose-folded into the input)
    so the worker sets them on ``DeepResearchAgentState`` and the deep prompts
    render their dedicated sections, same as the in-process path. Everything
    read from the request context is read HERE, while the context is live.
    """
    principal = get_current_principal()
    owner = principal.email if principal and principal.email else "anonymous"
    documents = [doc.model_dump() for doc in state.available_documents] if state.available_documents else None
    return await submit_agent_job(
        agent_type="deep_researcher",
        input_text=job_query(state),
        owner=owner,
        available_documents=documents,
        data_sources=state.data_sources,
        collection_scope=state.collection_scope,
        project_context=state.project_context,
        platform_lessons=render_lessons_block(state.platform_lessons),
        model_overrides=get_model_overrides_from_context() or None,
        user_info=state.user_info,
        clarifier_result=state.clarifier_result,
        # Deep-research reflection runs on the worker once the report exists
        # (the sync post-answer stage skips deep jobs).
        memory_reflection_enabled=(memory_reflection_llm is not None and get_memory_reflection_enabled_from_context()),
        memory_reflection_llm=memory_reflection_llm,
    )


def build_deep_research_job_submitter(config: DispatchSettings) -> JobSubmitter | None:
    """The callable that hands a deep-research turn to a worker, or ``None`` when
    this deployment has no worker and the turn must run deep research in process.

    ``None`` is the fallback, not a failure: a local dev machine with neither
    backend still answers, just synchronously. THE acceptance condition is
    read from the submitter itself rather than mirrored: ``submit_agent_job``
    refuses exactly when ``async_job_dispatch()`` is None, and a second copy
    of the condition is how the db-mode blindness happened.
    """
    if not config.use_async_deep_research:
        return None
    dispatch = async_job_dispatch()
    if dispatch is None:
        logger.info(
            "use_async_deep_research is enabled but neither NAT_DASK_SCHEDULER_ADDRESS nor "
            "GRID_JOB_EXECUTION=db is configured. Falling back to synchronous deep research execution."
        )
        return None
    logger.info("Chat-initiated deep research submits async jobs (dispatch=%s)", dispatch)
    # Plain str (LLMRef is a str subclass) so it crosses the worker
    # serialization boundary without depending on the subclass.
    reflection_llm = str(config.memory_reflection_llm) if config.memory_reflection_llm else None

    async def _submit(state: ConversationState) -> str:
        return await submit_deep_research_job(state, memory_reflection_llm=reflection_llm)

    return _submit
