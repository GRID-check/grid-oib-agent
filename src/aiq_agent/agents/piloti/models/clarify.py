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

from aiq_agent.common.plan_documents import PlanDocuments
from aiq_agent.common.research_plan import PlanStart
from aiq_agent.common.research_plan import ResearchPlanDraft

PlanGenre = Literal["pruefbericht", "aktenvermerk", "vergleich", "checkliste", "bericht"]
"""The document genre a run writes. Office genres, not whitepaper shapes."""

PlanDepth = Literal["kurzpruefung", "gutachten"]
"""How deep the report goes: the smallest complete form, or the full derivation."""


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


def _require_every_property(schema: dict[str, Any]) -> None:
    """Strict json_schema needs every property required; the Python defaults
    below are for callers that build a plan by hand, never for the model."""
    schema["required"] = list(schema.get("properties", {}))


class PlanResponse(_StrictContract):
    """Structured response from the planner LLM: the research plan preview.

    ``sections`` are what the report will cover, in the order it will. The reader edits them, the genre and
    the depth on the plan card before the run starts, and the approved plan
    binds the planner and the writer.
    """

    model_config: ClassVar[ConfigDict] = {"extra": "forbid", "json_schema_extra": _require_every_property}

    title: str = Field(description="Clear, descriptive title for the research report.")
    sections: list[str] = Field(description="3-8 section headings outlining what the report covers.")
    genre: PlanGenre = Field(
        default="bericht",
        description="The document genre: pruefbericht, aktenvermerk, vergleich, checkliste or bericht.",
    )
    depth: PlanDepth = Field(
        default="gutachten", description="kurzpruefung for the smallest complete form, gutachten for full depth."
    )
    grundlage: list[str] = Field(
        default_factory=list,
        description=(
            "File names from the document inventory the run must read in full, because the request is about "
            "them or cannot be answered without them. Empty when no listed document is that."
        ),
    )
    ausgeschlossen: list[str] = Field(
        default_factory=list,
        description="File names the reader excluded on the plan card. Always empty from the planner.",
    )


@dataclass(frozen=True)
class ClarifyRequest:
    """What the conversation graph hands the clarification step.

    A trimmed window of the conversation plus the same three context values the
    Piloti itself answered on, so the questions and the plan are asked
    against the reader's project rather than against the query alone.
    """

    messages: list[BaseMessage]
    data_sources: list[str] | None = None
    project_context: str | None = None
    available_documents: list[dict[str, Any]] | None = None


@dataclass(frozen=True)
class ClarifyResult:
    """How the dialog ended, and what deep research reads if it runs.

    ``research_context`` is the Q&A transcript. When planning is on, ``plan``
    is the drafted plan and ``draft`` the same plan as the BFF's plan
    primitive takes it (ADR-0068); nothing was asked about it, because the
    reader changes, holds or starts it on the run block while the run waits.
    Both are None when planning is off.
    """

    research_context: str
    plan: PlanResponse | None = None
    #: The Unterlagen the plan named, resolved against the turn's inventory.
    documents: PlanDocuments | None = None
    draft: ResearchPlanDraft | None = None
    start: PlanStart | None = None
