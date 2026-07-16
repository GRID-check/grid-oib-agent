"""Request and pipeline state models for the OIB compliance-check agent.

These models are pipeline INPUT/OUTPUT-shaped, never sent to an LLM as a
structured-response schema, so ``ge``/``le`` and friends are fine here. The
strict-mode-safe restriction (no ``ge``/``le``/``min_length``/``max_length``/
``pattern`` -- use ``field_validator`` instead) only applies to schemas that
reach an LLM structured-output call: see ``models/requirements.py`` and
``models/evidence.py``.
"""

from __future__ import annotations

from typing import Annotated
from typing import Any

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel
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

ALL_RICHTLINIEN: list[int] = sorted(RICHTLINIE_NAMES)
"""``[1, 2, 3, 4, 5, 6]`` -- the full default scope."""


class ComplianceCheckRequest(BaseModel):
    """Scope and project context for one OIB compliance-check pipeline run."""

    richtlinien: list[int] = Field(
        default_factory=lambda: list(ALL_RICHTLINIEN),
        description="OIB-Richtlinien numbers (1-6) in scope for this check. Defaults to all six.",
    )
    project_name: str | None = Field(default=None, description="Short project name/label for the report header.")
    project_description: str = Field(
        default="",
        description="Free-text project description used as context for Stage 1 requirement derivation.",
    )
    project_descriptors: dict[str, str] = Field(
        default_factory=dict,
        description="Structured project facts (e.g. Gebaeudeklasse, Nutzung, Bauweise) used as LLM context.",
    )
    collection_name: str | None = Field(
        default=None,
        description="Project document knowledge-collection name for Stage 2 evidence retrieval.",
    )

    @field_validator("richtlinien", mode="after")
    @classmethod
    def _validate_richtlinien(cls, value: list[int]) -> list[int]:
        """Dedupe, sort, and validate scope against the six known Richtlinien.

        An empty list is treated as "all Richtlinien" (matching the config
        default) rather than an error -- an empty scope would otherwise
        silently produce a no-op pipeline run instead of a clear signal.
        """
        if not value:
            return list(ALL_RICHTLINIEN)
        invalid = sorted(set(value) - set(ALL_RICHTLINIEN))
        if invalid:
            raise ValueError(f"Unknown Richtlinie number(s): {invalid}. Valid range is 1-6.")
        return sorted(set(value))


class ComplianceCheckAgentState(BaseModel):
    """Message-based input/output state for the compliance-check agent.

    Mirrors the shape other agents in this fleet accept (see
    ``ShallowResearchAgentState``): a ``messages`` list with the LangGraph
    reducer plus request-scoped context fields. ``register.py`` appends the
    rendered Markdown report as a final ``AIMessage`` and returns the updated
    state, matching the other agents' message-in/message-out contract.
    """

    messages: Annotated[list[AnyMessage], add_messages] = Field(default_factory=list)
    project_context: str | None = Field(
        default=None,
        description="Free-text project context/description for Stage 1 requirement derivation.",
    )
    project_descriptors: dict[str, str] = Field(default_factory=dict)
    richtlinien: list[int] | None = Field(
        default=None,
        description="Per-request override for the configured Richtlinien scope; None uses the config default.",
    )
    collection_name: str | None = Field(default=None)
    data_sources: list[str] | None = None
    user_info: dict[str, Any] | None = None
