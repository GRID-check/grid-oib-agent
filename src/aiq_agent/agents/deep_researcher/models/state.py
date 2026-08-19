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
    # The tenant whose skills this run resolves (``x-grid-organization-id`` on
    # the synchronous path). Carried on the STATE rather than read from the
    # request context because deep research runs in a Dask worker, where no
    # request headers exist: the job runner captured the identity at submit time
    # and injects it here, the same way it injects ``project_context`` and
    # ``force_skills``. None means anonymous — the run then resolves no
    # organization skills and writes its report without them.
    organization_id: str | None = None
