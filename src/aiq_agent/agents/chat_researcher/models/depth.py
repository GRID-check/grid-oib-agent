"""Depth routing decision model."""

from typing import Literal

from pydantic import BaseModel


class DepthDecision(BaseModel):
    """
    Result of depth/complexity assessment for a research query.

    Attributes:
        decision: Routing decision - 'shallow' for quick lookups or 'deep' for comprehensive research.
        raw_reasoning: Optional reasoning text from the LLM explaining the decision.
    """

    decision: Literal["shallow", "deep"]
    raw_reasoning: str | None = None
