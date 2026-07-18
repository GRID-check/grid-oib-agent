"""Deterministic Stage 3 assembly models.

None of these models are ever sent to an LLM as a structured-response schema
-- they are built entirely in Python from Stage 1 (``RequirementProfile``)
and Stage 2 (``EvidenceFinding``) results -- so the strict-mode-safe
restriction from ``requirements.py``/``evidence.py`` does not apply and
``Field(ge=..., le=...)`` is used normally where useful.
"""

from typing import Literal

from pydantic import BaseModel
from pydantic import Field

from .requirements import RequirementItem


class ComplianceMatrixRow(BaseModel):
    """One deterministically assembled compliance-matrix row (requirement + evidence finding)."""

    requirement_id: str
    richtlinie: int
    punkt: str
    requirement: str
    status: str
    confidence: str
    evidence_quotes: list[str] = Field(default_factory=list)
    source_files: list[str] = Field(default_factory=list)
    reasoning: str = ""
    # Trust chain (system-derived from the norm registry, never LLM-authored).
    norm_id: str | None = None
    rank: str | None = None
    binding: str | None = None


class GapItem(BaseModel):
    """A compliance gap ranked by risk for the risikogewichtete Lueckenliste."""

    requirement_id: str
    richtlinie: int
    punkt: str
    requirement: str
    status: str
    risk_score: int = Field(ge=0, le=100, description="Deterministic risk score computed in code, never by an LLM.")
    risk_level: Literal["hoch", "mittel", "niedrig"]
    rationale: str


class ComplianceMatrix(BaseModel):
    """Deterministically assembled result of the compliance-check pipeline (Stage 3, no LLM calls)."""

    findings: list[ComplianceMatrixRow] = Field(default_factory=list)
    not_applicable: list[RequirementItem] = Field(
        default_factory=list,
        description="Requirements scoped out in Stage 1 (applicability == nicht_anwendbar).",
    )
    gaps: list[GapItem] = Field(
        default_factory=list, description="Non-'erfuellt' findings, sorted by risk_score descending."
    )
    open_questions: list[str] = Field(default_factory=list)
    status_counts: dict[str, int] = Field(default_factory=dict)


class ComplianceCheckResult(BaseModel):
    """Full pipeline output: the assembled matrix, the rendered report, and the LLM call budget spent."""

    matrix: ComplianceMatrix
    report_markdown: str
    stage1_llm_calls: int = Field(description="Requirement-profile LLM calls attempted (one per Richtlinie).")
    stage2_llm_calls: int = Field(description="Evidence-batch LLM calls attempted (one per requirement batch).")

    @property
    def total_llm_calls(self) -> int:
        """Total LLM calls spent by this run (Stage 3 assembly and rendering make none)."""
        return self.stage1_llm_calls + self.stage2_llm_calls
