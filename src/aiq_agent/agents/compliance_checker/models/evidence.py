"""Stage 2 (evidence check) structured-response contracts.

Sent to the LLM as native strict ``json_schema`` structured output -- see the
module docstring in ``requirements.py`` for why no field here uses
``Field(ge=..., le=..., min_length=..., ...)``.
"""

from typing import ClassVar
from typing import Literal

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

EvidenceStatus = Literal["erfuellt", "teilweise", "nicht_erfuellt", "kein_nachweis"]


class _StrictContract(BaseModel):
    """Base model for schemas sent to the LLM as strict json_schema structured output."""

    model_config: ClassVar[ConfigDict] = {"extra": "forbid"}


class EvidenceFinding(_StrictContract):
    """Stage 2 judgment for one requirement, grounded in retrieved project-document evidence."""

    requirement_id: str = Field(description="The RequirementItem.id this finding judges.")
    status: EvidenceStatus = Field(description="Compliance status supported by the retrieved evidence.")
    evidence_quotes: list[str] = Field(
        description="Short verbatim quotes from project documents supporting the status; empty if kein_nachweis."
    )
    source_files: list[str] = Field(description="Source file names the evidence quotes were drawn from.")
    confidence: Literal["low", "medium", "high"] = Field(description="Confidence in this judgment.")
    reasoning: str = Field(description="Concise explanation connecting the evidence to the status.")
    open_question: str | None = Field(
        description="A specific open question to raise with the project team, or null if none."
    )


class EvidenceBatchResult(_StrictContract):
    """Structured Stage 2 response: judgments for one batch of requirements."""

    findings: list[EvidenceFinding] = Field(description="One finding per requirement in the submitted batch.")
