"""What the clarification step is asked, what it asks the two LLMs, and what it
hands back.

The two ``_StrictContract`` models are sent to a model as native strict
``json_schema`` structured output via
:func:`aiq_agent.common.strict_json_response_format`, so both obey the
strict-mode contract: every property is required (an optional one is expressed
as nullable, never as a default) and ``extra="forbid"`` puts
``additionalProperties: false`` in the emitted schema. A schema that omits a
property from ``required`` is rejected by the provider with a 400, which is why
none of these fields carries a pydantic default.

Parsing is deliberately more forgiving than the schema — see
``ClarificationResponse._fill_omitted_keys``.
"""

from dataclasses import dataclass
from typing import Any
from typing import ClassVar
from typing import Literal

from langchain_core.messages import BaseMessage
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import model_validator

PlanDecision = Literal["approved", "shallow", "cancelled", "feedback"]
"""What one reply to the plan preview asks for. ``feedback`` means "revise it"."""

PlanOutcome = Literal["approved", "shallow", "cancelled"]
"""Where the plan preview ended. ``PlanDecision`` minus the one that loops."""


class _StrictContract(BaseModel):
    """Base for schemas sent to an LLM as strict json_schema structured output."""

    model_config: ClassVar[ConfigDict] = {"extra": "forbid"}


class ClarificationResponse(_StrictContract):
    """
    Structured response from the clarifier LLM.

    Attributes:
        needs_clarification: True if additional clarification is needed,
            False if the agent has enough information to proceed.
        clarification_question: The clarification question to ask the user.
            Required when needs_clarification is True, null otherwise.
        options: Short labels for the answers offered by the question, so the
            UI can render a picker instead of asking the user to retype one of
            them. Empty when the question has no enumerable answers.
    """

    needs_clarification: bool = Field(
        description="True if additional clarification is needed from the user, "
        "False if enough information has been gathered to proceed with research."
    )
    clarification_question: str | None = Field(
        description="The clarification question to ask the user. Required when needs_clarification is True, "
        "null otherwise.",
    )
    options: list[str] = Field(
        # The options are a *duplicate* of the choices already spelled out in
        # clarification_question, not a replacement: the question carries the
        # framing sentence and the skip line, the options carry the pickable
        # labels. Empty even when clarification is needed, because a question
        # with no enumerable answers is a perfectly valid clarification and
        # inventing labels for it would put words in the user's mouth.
        description="Short label of each offered answer (the pickable part only, not the explanation). "
        "Empty when the question has no enumerable answers, and always when needs_clarification is false.",
    )

    @model_validator(mode="before")
    @classmethod
    def _fill_omitted_keys(cls, data: Any) -> Any:
        """Accept a reply that leaves out the two keys with an obvious empty value.

        The SCHEMA has to require all three (strict mode), and does. Parsing is
        the other direction: the tool-bound binding cannot carry a schema (see
        ``clarify._clarifier_llm``), so on that path the model is only *asked*
        for three keys, and one that answers with two is answering, not
        failing. Rejecting it would replace a good question with the fallback
        one.
        """
        if isinstance(data, dict):
            return {"clarification_question": None, "options": [], **data}
        return data

    @classmethod
    def complete(cls) -> "ClarificationResponse":
        """The sentinel written when nothing more needs asking."""
        return cls(needs_clarification=False, clarification_question=None, options=[])

    def is_valid(self) -> bool:
        """Check if the response is valid (has question when needed)."""
        if self.needs_clarification:
            return bool(self.clarification_question)
        # Nothing is being asked, so there is nothing to offer answers to.
        # Options here mean the model contradicted itself; treating that as
        # invalid keeps a stale picker from being shown next to no question.
        return not self.options


class PlanResponse(_StrictContract):
    """Structured response from the planner LLM: the research plan preview."""

    title: str = Field(description="Clear, descriptive title for the research report.")
    sections: list[str] = Field(description="5-8 section headings outlining the report structure.")


@dataclass(frozen=True)
class ClarifyRequest:
    """What the conversation graph hands the clarification step.

    A trimmed window of the conversation plus the same three context values the
    researcher itself answered on, so the questions and the plan are asked
    against the reader's project rather than against the query alone.
    """

    messages: list[BaseMessage]
    data_sources: list[str] | None = None
    project_context: str | None = None
    available_documents: list[dict[str, Any]] | None = None


@dataclass(frozen=True)
class ClarifyResult:
    """How the dialog ended, and the text deep research reads if it runs.

    One outcome instead of three mutually-exclusive booleans that could
    contradict each other, and one finished string instead of a title, a
    section list and a caller that concatenated them: ``research_context``
    already carries the Q&A transcript and, when a plan was approved, that
    plan. ``outcome`` is None when plan approval is off — the questions were
    asked, no plan was ever shown, and deep research proceeds.
    """

    research_context: str
    outcome: PlanOutcome | None = None
