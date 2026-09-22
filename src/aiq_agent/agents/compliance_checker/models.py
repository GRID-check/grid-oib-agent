"""Pydantic contracts for the OIB compliance-check pipeline.

Two kinds of model live here and the difference matters:

* ``RequirementProfile``/``RequirementItem`` (Stage 1) and
  ``EvidenceBatchResult``/``EvidenceFinding`` (Stage 2) are sent to the LLM as
  native strict ``json_schema`` structured output via
  ``aiq_agent.common.strict_json_response_format``. Strict mode rejects the
  JSON-Schema ``minimum``/``maximum``/``minLength``/``maxLength``/``pattern``
  keywords, so those four use ``field_validator`` instead of
  ``Field(ge=..., le=..., ...)``. ``tests/.../test_models.py`` walks their
  schemas to keep it that way.
* Everything else is pipeline input/output built in Python and never reaches
  an LLM, so the restriction does not apply.
"""

from __future__ import annotations

from typing import ClassVar
from typing import Literal

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import field_validator

RICHTLINIE_NAMES: dict[int, str] = {
    1: "Standsicherheit",
    2: "Brandschutz",
    3: "Hygiene, Gesundheit und Umweltschutz",
    4: "Nutzungssicherheit und Barrierefreiheit",
    5: "Schallschutz",
    6: "Energieeinsparung und Wärmeschutz",
}
"""Human-readable German names for the six OIB-Richtlinien, keyed by number."""

ALL_RICHTLINIEN: tuple[int, ...] = tuple(sorted(RICHTLINIE_NAMES))
"""``(1, 2, 3, 4, 5, 6)`` -- the full default scope."""

UNJUDGED_STATUS = "nicht_geprueft"
"""Matrix-row status for a requirement the evidence check could not judge.

Distinct from the LLM's ``kein_nachweis`` ("the documents are silent"): this
one means the check itself did not happen -- retrieval or the LLM call failed,
or no project documents were in scope. The row's ``reasoning`` says which.
"""

EvidenceStatus = Literal["erfuellt", "teilweise", "nicht_erfuellt", "kein_nachweis"]
Confidence = Literal["low", "medium", "high"]


def normalize_richtlinien(value: list[int]) -> list[int]:
    """Dedupe, sort, and validate a Richtlinie scope; an empty list means all six.

    Shared by the request model and the NAT config so a bad scope fails in the
    same words at build time and at request time.
    """
    if not value:
        return list(ALL_RICHTLINIEN)
    invalid = sorted(set(value) - set(ALL_RICHTLINIEN))
    if invalid:
        raise ValueError(f"Unknown Richtlinie number(s): {invalid}. Valid range is 1-6.")
    return sorted(set(value))


def _validate_richtlinie_number(value: int) -> int:
    """Reject an out-of-range Richtlinie number without a JSON-Schema ge/le constraint."""
    if value not in ALL_RICHTLINIEN:
        raise ValueError(f"richtlinie must be one of {list(ALL_RICHTLINIEN)}, got {value}")
    return value


class _StrictContract(BaseModel):
    """Base for schemas sent to the LLM as strict json_schema structured output."""

    model_config: ClassVar[ConfigDict] = {"extra": "forbid"}


class RequirementItem(_StrictContract):
    """One OIB-Richtlinie requirement, scoped to the project context."""

    id: str = Field(description="Stable requirement id, e.g. 'R2-3.1.2'.")
    richtlinie: int = Field(description="OIB-Richtlinie number this requirement belongs to (1-6).")
    punkt: str = Field(description="Section/point reference within the Richtlinie, e.g. '3.1.2'.")
    requirement: str = Field(description="The requirement text, restated concisely for this project.")
    applicability: Literal["anwendbar", "nicht_anwendbar", "zu_pruefen"] = Field(
        description="Whether this requirement applies to the project as described."
    )
    rationale: str = Field(description="Why the requirement is (not) applicable, given the project context.")

    @field_validator("richtlinie", mode="after")
    @classmethod
    def _validate_richtlinie(cls, value: int) -> int:
        return _validate_richtlinie_number(value)


class RequirementProfile(_StrictContract):
    """Structured Stage 1 response: derived requirements for one Richtlinie."""

    richtlinie: int = Field(description="OIB-Richtlinie number this profile covers (1-6).")
    scope_notes: str = Field(description="Brief note on how the project context was applied to scope requirements.")
    requirements: list[RequirementItem] = Field(description="Requirements derived for this Richtlinie.")

    @field_validator("richtlinie", mode="after")
    @classmethod
    def _validate_richtlinie(cls, value: int) -> int:
        return _validate_richtlinie_number(value)


class EvidenceFinding(_StrictContract):
    """Stage 2 judgment for one requirement, grounded in retrieved project-document evidence."""

    requirement_id: str = Field(description="The RequirementItem.id this finding judges.")
    status: EvidenceStatus = Field(description="Compliance status supported by the retrieved evidence.")
    evidence_quotes: list[str] = Field(
        description="Short verbatim quotes from project documents supporting the status; empty if kein_nachweis."
    )
    source_files: list[str] = Field(description="Source file names the evidence quotes were drawn from.")
    confidence: Confidence = Field(description="Confidence in this judgment.")
    reasoning: str = Field(description="Concise explanation connecting the evidence to the status.")
    open_question: str | None = Field(
        description="A specific open question to raise with the project team, or null if none."
    )


class EvidenceBatchResult(_StrictContract):
    """Structured Stage 2 response: judgments for one batch of requirements."""

    findings: list[EvidenceFinding] = Field(description="One finding per requirement in the submitted batch.")


class ComplianceCheckRequest(BaseModel):
    """Scope and project context for one compliance-check run."""

    richtlinien: list[int] = Field(
        default_factory=lambda: list(ALL_RICHTLINIEN),
        description="OIB-Richtlinien numbers (1-6) in scope for this check. Defaults to all six.",
    )
    project_description: str = Field(
        default="",
        description="Free-text project context used for Stage 1 requirement derivation and Stage 2 judging.",
    )
    project_descriptors: dict[str, str] = Field(
        default_factory=dict,
        description="Confirmed intake facts (bundesland, gebaeudeklasse, hauptnutzung, ...) rendered as a prompt list.",
    )
    project_documents_in_scope: bool = Field(
        default=True,
        description=(
            "Whether the request's collection scope holds a project or session collection. "
            "False skips Stage 2: there is nothing to judge evidence against."
        ),
    )

    @field_validator("richtlinien", mode="after")
    @classmethod
    def _validate_richtlinien(cls, value: list[int]) -> list[int]:
        return normalize_richtlinien(value)


class ComplianceMatrixRow(BaseModel):
    """One compliance-matrix row: a requirement joined with its evidence finding."""

    requirement_id: str
    richtlinie: int
    punkt: str
    requirement: str
    status: str
    confidence: str
    evidence_quotes: list[str] = Field(default_factory=list)
    source_files: list[str] = Field(default_factory=list)
    reasoning: str = ""


class GapItem(BaseModel):
    """A non-'erfuellt' finding for the Lueckenliste, ranked by (status, confidence)."""

    requirement_id: str
    richtlinie: int
    punkt: str
    requirement: str
    status: str
    confidence: str
    rationale: str


class ComplianceMatrix(BaseModel):
    """Assembled result of the pipeline (Stage 3, no LLM calls)."""

    richtlinien: list[int] = Field(default_factory=list, description="The Richtlinie scope that was checked.")
    findings: list[ComplianceMatrixRow] = Field(default_factory=list)
    not_applicable: list[RequirementItem] = Field(
        default_factory=list,
        description="Requirements scoped out in Stage 1 (applicability == nicht_anwendbar).",
    )
    gaps: list[GapItem] = Field(default_factory=list, description="Non-'erfuellt' rows, worst first.")
    open_questions: list[str] = Field(default_factory=list)
    status_counts: dict[str, int] = Field(default_factory=dict)
    notices: list[str] = Field(
        default_factory=list,
        description="Per-Richtlinie failures (retrieval, LLM) the reader must know about; rendered as Hinweise.",
    )


class ComplianceCheckResult(BaseModel):
    """Full pipeline output: the assembled matrix and the rendered German Markdown report."""

    matrix: ComplianceMatrix
    report_markdown: str
