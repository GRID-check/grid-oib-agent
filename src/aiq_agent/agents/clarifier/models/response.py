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
    """

    needs_clarification: bool = Field(
        description="True if additional clarification is needed from the user, "
        "False if enough information has been gathered to proceed with research."
    )
    clarification_question: str | None = Field(
        default=None,
        description="The clarification question to ask the user. Required when needs_clarification is True.",
    )

    def is_complete(self) -> bool:
        """Check if clarification is complete."""
        return not self.needs_clarification

    def is_valid(self) -> bool:
        """Check if the response is valid (has question when needed)."""
        if self.needs_clarification:
            return bool(self.clarification_question)
        return True
