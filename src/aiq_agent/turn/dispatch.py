"""Handing a deep-research turn to a RUN instead of running it in process.

The turn no longer submits a job itself. It asks the BFF to commission a run
(``turn/commission.py``): the BFF writes the ``task_runs`` row, mints the run's
message in this thread and submits the job with that run's id, which is what
makes the block in the thread live (ADR-0062). What is decided HERE is only
whether the workflow escalates this turn at all (`use_async_deep_research`).
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import TYPE_CHECKING
from typing import Protocol

from aiq_agent.common import get_latest_user_query
from aiq_agent.turn.commission import CommissionedRun
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
    the workflow answers the turn in process (``use_async_deep_research`` is off).
    """
    if not config.use_async_deep_research:
        return None
    logger.info("An escalated question is commissioned as a research run")

    async def _commission(state: ConversationState) -> CommissionedRun:
        # What the clarifier settled travels with the question: the run starts
        # where the conversation got to, instead of asking it all again.
        return await commission_research_run(
            job_query(state),
            context=state.clarifier_result,
            data_sources=state.data_sources,
            documents=state.plan_documents,
        )

    return _commission
