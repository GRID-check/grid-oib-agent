"""Result models for chat research agent."""

from typing import Literal

from pydantic import BaseModel


class ShallowResult(BaseModel):
    """
    Result from shallow research execution.

    Attributes:
        answer: The research answer or response text.
        confidence: INTERNAL control-flow proxy — NOT a measure of answer
            quality and never surfaced to users. It is assigned only on the
            error/escalation branches of ``shallow_research_node``: "high" means
            "the system is certain an error occurred and the canned error text is
            the correct response", "low" means "the shallow agent flagged its
            answer insufficient and asked to escalate". "medium" is never
            assigned, and the normal success path leaves ``shallow_result`` as
            ``None`` entirely. The user-facing self-assessment of answer quality
            is a SEPARATE signal (the model's ``[CONFIDENCE:...]`` marker,
            surfaced via ``ChatResearcherState.answer_confidence``); do not
            conflate the two.
        escalate_to_deep: Whether this query should be escalated to deep research.
        escalation_reason: Optional explanation for why escalation is needed.
    """

    answer: str
    confidence: Literal["low", "medium", "high"]
    escalate_to_deep: bool
    escalation_reason: str | None = None
