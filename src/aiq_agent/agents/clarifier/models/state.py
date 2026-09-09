"""State models for clarifier agent."""

from typing import Annotated
from typing import Any
from typing import Literal
from typing import Self

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel
from pydantic import Field
from pydantic import computed_field

from .response import ClarificationResponse

PlanDecision = Literal["approved", "shallow", "cancelled", "feedback"]
"""What one reply to the plan preview asks for. ``feedback`` means "revise it"."""

PlanOutcome = Literal["approved", "shallow", "cancelled"]
"""Where the plan preview ended. ``PlanDecision`` minus the one that loops."""


class PlanOutcomeFields(BaseModel):
    """The dialog's product: the transcript and how the plan preview ended.

    Defined once and inherited by both the graph state and the returned result
    so the two cannot drift — they carried six duplicated fields, and the three
    mutually-exclusive booleans among them could contradict each other.
    """

    clarifier_log: str = Field(default="", description="Markdown transcript of the clarification dialog.")
    plan_title: str | None = Field(default=None)
    plan_sections: list[str] = Field(default_factory=list)
    plan_outcome: PlanOutcome | None = Field(
        default=None,
        description="How the plan preview ended, or None when plan approval is off or never reached.",
    )


class ClarifierResult(PlanOutcomeFields):
    """
    Result returned from clarifier agent run.

    Contains the clarification log plus optional plan approval details. The
    three ``plan_*`` booleans the caller routes on are computed from
    ``plan_outcome`` rather than stored, so exactly one of them can ever be
    true.
    """

    @classmethod
    def from_state(cls, state: "ClarifierAgentState") -> Self:
        """Project the finished graph state onto what the caller reads."""
        return cls(**{name: getattr(state, name) for name in PlanOutcomeFields.model_fields})

    @computed_field
    @property
    def plan_approved(self) -> bool:
        """Whether the user approved the plan: the caller runs deep research."""
        return self.plan_outcome == "approved"

    @computed_field
    @property
    def plan_rejected(self) -> bool:
        """Whether the user declined the plan while still wanting an answer —
        the caller falls through to shallow research."""
        return self.plan_outcome == "shallow"

    @computed_field
    @property
    def plan_cancelled(self) -> bool:
        """Whether the user cancelled outright — no research of any depth is
        wanted for this turn."""
        return self.plan_outcome == "cancelled"

    def get_approved_plan_context(self) -> str | None:
        """Get formatted plan context if approved."""
        if not self.plan_approved or not self.plan_title:
            return None
        sections_text = "\n".join(f"- {s}" for s in self.plan_sections)
        return f"**Approved Research Plan**\n\nTitle: {self.plan_title}\n\nSections:\n{sections_text}"


class ClarifierAgentState(PlanOutcomeFields):
    """
    State for clarifier agent.

    The turn limits are NOT here: they are configuration, they reach the graph
    nodes on the run's binding, and a copy on the state was only ever stamped
    over by ``run()``.

    Attributes:
        messages: Conversation history with LangGraph message reducer.
        data_sources: Optional list of data sources to scope tools.
        available_documents: User-uploaded documents (file_name, summary) that are
            ingested; the user may refer to these.
        project_context: Optional project profile context for
            project-aware research planning.
        clarification: The last clarification response the LLM produced, parsed
            once by the node that received it so the router and the question
            node read it instead of re-parsing the message text.
        iteration: Current iteration of the clarification dialog.
    """

    messages: Annotated[list[AnyMessage], add_messages]
    data_sources: list[str] | None = Field(default=None)
    project_context: str | None = Field(default=None)
    available_documents: list[dict[str, Any]] | None = Field(
        default=None,
        description="User-uploaded documents (file_name, summary) that are ingested; the user may refer to these.",
    )
    clarification: ClarificationResponse | None = Field(default=None)
    iteration: int = Field(default=0)
