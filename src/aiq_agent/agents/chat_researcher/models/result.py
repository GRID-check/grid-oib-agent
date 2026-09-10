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
        portfolio: Whether that escalation is a Portfolio-Recherche — one deep
            sub-run per project instead of one run (ADR-0054, spec DR-3/DR-4).
            The model ASKS for it in its envelope; what is recorded here is the
            EFFECTIVE decision, so it is only ever True on an office turn (an
            organization and no project). In a project turn there is exactly one
            project to read and the request is dropped, with a log line.
        portfolio_project_ids: The projects that run should read, as the model
            named them from the register. None means it named none, and the run
            reads every project the caller may read.
    """

    answer: str
    confidence: Literal["low", "medium", "high"]
    escalate_to_deep: bool
    escalation_reason: str | None = None
    portfolio: bool = False
    portfolio_project_ids: list[str] | None = None
