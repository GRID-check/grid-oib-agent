"""Stage 1 (requirement profile) structured-response contracts.

These schemas are sent to the LLM as native strict ``json_schema`` structured
output (see ``aiq_agent.common.strict_json_response_format``). Strict mode
rejects JSON-Schema ``minimum``/``maximum``/``minLength``/``maxLength``/
``pattern`` keywords, so range/shape enforcement uses ``field_validator``
instead of ``Field(ge=..., le=...)`` -- mirroring the fix already applied to
``aiq_agent.agents.deep_researcher.models.subagent_contracts`` (see
``EvidenceJudgment.relevance_score`` / ``ResearchQuery.preferred_tools``
there for the two variants: clamp vs. raise).
"""

from typing import ClassVar
from typing import Literal

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import field_validator

from .request import ALL_RICHTLINIEN


class _StrictContract(BaseModel):
    """Base model for schemas sent to the LLM as strict json_schema structured output."""

    model_config: ClassVar[ConfigDict] = {"extra": "forbid"}


def _validate_richtlinie_number(value: int) -> int:
    """Reject an out-of-range Richtlinie number without a JSON-Schema ge/le constraint."""
    if value not in ALL_RICHTLINIEN:
        raise ValueError(f"richtlinie must be one of {ALL_RICHTLINIEN}, got {value}")
    return value


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
