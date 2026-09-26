"""Handing a deep-research turn to a RUN instead of running it in process.

The turn no longer submits a job itself. It asks the BFF to commission a run
(``turn/commission.py``): the BFF writes the ``task_runs`` row, mints the run's
message in this thread and submits the job with that run's id, which is what
makes the block in the thread live (ADR-0062). What is decided HERE is only
whether this deployment can do that at all — a machine with no worker behind
the BFF still answers, in process, exactly as before.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import TYPE_CHECKING
from typing import Protocol

from aiq_agent.common import get_latest_user_query
from aiq_agent.turn.api_seam import async_job_dispatch
from aiq_agent.turn.commission import CommissionedRun
from aiq_agent.turn.commission import commission_planned_run
from aiq_agent.turn.commission import commission_research_run

if TYPE_CHECKING:
    from aiq_agent.agents.piloti.models import ConversationState

logger = logging.getLogger(__name__)

RunCommissioner = Callable[["ConversationState"], Awaitable[CommissionedRun]]


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


def build_run_commissioner(config: DispatchSettings) -> RunCommissioner | None:
    """The callable that turns this turn's question into a run, or ``None`` when
    this deployment has no worker and the turn must research in process.

    ``None`` is the fallback, not a failure: a local dev machine with neither
    backend still answers, just synchronously. THE acceptance condition is read
    from the dispatch seam rather than mirrored — a second copy of the condition
    is how the db-mode blindness happened — and it is still read here, before
    anything is written, because a run whose job can never be submitted is a
    failed row where an answer would do.
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
    logger.info("An escalated question is commissioned as a run (dispatch=%s)", dispatch)

    async def _commission(state: ConversationState) -> CommissionedRun:
        # A drafted plan is posted as the plan the run waits on (ADR-0068);
        # the reader edits, holds or starts it on the block.
        if state.plan_draft is not None:
            return await commission_planned_run(
                state.plan_draft, start=state.plan_start, context=state.clarifier_result
            )
        # What the clarifier settled travels with the question: the run starts
        # where the conversation got to, instead of asking it all again.
        return await commission_research_run(
            job_query(state),
            context=state.clarifier_result,
            data_sources=state.data_sources,
            documents=state.plan_documents,
        )

    return _commission
