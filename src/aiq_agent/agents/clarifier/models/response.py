"""Response models for clarifier agent."""

from pydantic import BaseModel
from pydantic import Field


class ClarificationResponse(BaseModel):
    """
    Structured response from the clarifier agent.

    Attributes:
        needs_clarification: True if additional clarification is needed,
            False if the agent has enough information to proceed.
        clarification_question: The clarification question to ask the user.
            Required when needs_clarification is True, should be None otherwise.
        options: Short labels for the answers offered by the question, so the
            UI can render a picker instead of asking the user to retype one of
            them. Empty when the question has no enumerable answers.
    """

    needs_clarification: bool = Field(
        description="True if additional clarification is needed from the user, "
        "False if enough information has been gathered to proceed with research."
    )
    clarification_question: str | None = Field(
        default=None,
        description="The clarification question to ask the user. Required when needs_clarification is True.",
    )
    options: list[str] = Field(
        default_factory=list,
        # The options are a *duplicate* of the choices already spelled out in
        # clarification_question, not a replacement: the question carries the
        # framing sentence and the skip line, the options carry the pickable
        # labels. Optional even when clarification is needed, because a question
        # with no enumerable answers is a perfectly valid clarification and
        # inventing labels for it would put words in the user's mouth.
        description="Short label of each offered answer (the pickable part only, not the explanation). "
        "Omit or leave empty when the question has no enumerable answers, and always when "
        "needs_clarification is false.",
    )

    def is_complete(self) -> bool:
        """Check if clarification is complete."""
        return not self.needs_clarification

    def is_valid(self) -> bool:
        """Check if the response is valid (has question when needed)."""
        if self.needs_clarification:
            return bool(self.clarification_question)
        # Nothing is being asked, so there is nothing to offer answers to.
        # Options here mean the model contradicted itself; treating that as
        # invalid keeps a stale picker from being shown next to no question.
        return not self.options
