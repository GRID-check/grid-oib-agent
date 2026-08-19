"""State models for deep research agent."""

from typing import Annotated
from typing import Any

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel
from pydantic import Field

from aiq_agent.knowledge import AvailableDocument


def _merge_dict_state(left: dict[str, Any] | None, right: dict[str, Any] | None) -> dict[str, Any]:
    if not left:
        return right or {}
    if not right:
        return left
    merged = dict(left)
    merged.update(right)
    return merged


class DeepResearchAgentState(BaseModel):
    """
    State for deep research agent.

    The deepagents-based DeepResearcherAgent manages its own internal state
    through the deepagents library. This state primarily handles the interface
    with the orchestrator.

    Attributes:
        messages: Conversation history with LangGraph message reducer.
        data_sources: List of data sources selected by the user.
        user_info: Optional user information.
        tools_info: Information about available tools.
        todos: Todo list managed by TodoListMiddleware.
        files: Virtual filesystem managed by FilesystemMiddleware.
        subagents: Status of configured DeepAgents subagents.
        rubric: DeepAgents rubric used by RubricMiddleware when available.
        clarifier_result: Log from clarifier agent dialog.
        available_documents: User-uploaded documents with summaries for context.
    """

    messages: Annotated[list[AnyMessage], add_messages]
    data_sources: list[str] | None = None
    user_info: dict[str, Any] | None = None
    tools_info: list[dict[str, Any]] | None = None
    todos: list[dict[str, Any]] = Field(default_factory=list)
    files: Annotated[dict[str, Any], _merge_dict_state] = Field(default_factory=dict)
    subagents: list[dict[str, Any]] = Field(default_factory=list)
    rubric: str | None = None
    clarifier_result: str | None = None
    available_documents: list[AvailableDocument] | None = None
    project_context: str | None = None
    # Transparency summary of citations dropped by ``verify_citations`` during
    # report post-processing (``{"count": int, "reasons": [str, ...]}``).
    # Populated by ``run()`` ONLY when ≥1 citation was removed; None otherwise.
    # The chat orchestrator lifts it onto the terminal chunk via
    # ``_normalize_citations_removed``.
    citations_removed: dict[str, Any] | None = None
    # Evidence-gathering was CUT OFF, not completed: the run hit its wall-clock
    # budget or the orchestrator's step limit and the answer was salvaged from
    # whatever it had reached by then. Set ONLY on a cutoff (None otherwise), so
    # presence is the fact — the same contract the shallow researcher's
    # ``research_truncated`` uses, and the field the websocket layer already
    # lifts onto the terminal frame.
    research_truncated: bool | None = None
    # WHY the run was cut off, as a stable token (``wall_clock`` / ``step_limit``)
    # for the operator channel. Never prose: the reader is told about truncation
    # by the report's own banner, in the product's voice.
    truncation_reason: str | None = None
    # Ways this answer is weaker than a clean run, as stable tokens
    # (``no_report_file``, ``no_valid_citations``). These used to be
    # ``logger.warning`` only — a degraded answer shipped looking exactly like a
    # good one. Empty/None means the run degraded in none of the known ways.
    degraded_reasons: list[str] | None = None
    # The tenant whose skills this run resolves (``x-grid-organization-id`` on
    # the synchronous path). Carried on the STATE rather than read from the
    # request context because deep research runs in a Dask worker, where no
    # request headers exist: the job runner captured the identity at submit time
    # and injects it here, the same way it injects ``project_context`` and
    # ``force_skills``. None means anonymous — the run then resolves no
    # organization skills and writes its report without them.
    organization_id: str | None = None
