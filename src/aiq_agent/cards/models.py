# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Pydantic models for Grid response cards."""

from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import Field
from pydantic import TypeAdapter
from pydantic import field_validator


class SummaryCard(BaseModel):
    """A concise overview of the answer for the user."""

    type: Literal["summary"]
    title: str = Field(min_length=1, description="Short title for the summary card")
    content: str | None = Field(default=None, description="One-paragraph summary")
    key_points: list[str] | None = Field(default=None, description="Bullet points highlighting key facts")


class LegalBasisCard(BaseModel):
    """A legal norm, regulation, or OIB Richtlinie that grounds the answer."""

    type: Literal["legal_basis"]
    law: str = Field(min_length=1, description="Name of the law, regulation, or OIB Richtlinie")
    article: str | None = Field(default=None, description="Relevant article or paragraph number")
    section: str | None = Field(default=None, description="Relevant section or chapter")
    summary: str | None = Field(default=None, description="Plain-language summary of the legal relevance")
    original_text: str | None = Field(default=None, description="Literal excerpt from the source, if available")


class ProjectProfilePatchOperation(BaseModel):
    """A JSON Patch operation targeting a project profile section."""

    op: Literal["add", "replace", "remove"]
    path: str
    value: Any = None

    @field_validator("path")
    @classmethod
    def _validate_path(cls, v: str) -> str:
        allowed_prefixes = ("/facts", "/goals", "/unknowns", "/assumptions")
        if not v.startswith(allowed_prefixes):
            raise ValueError(f"Patch path must start with one of {allowed_prefixes}")
        segments = v.split("/")
        if ".." in segments:
            raise ValueError("Patch path must not contain '..' segments")
        return v


class ProjectProfilePatchPreviewItem(BaseModel):
    """A before/after preview for a single patched field."""

    label: str
    before: str
    after: str


class ProjectProfilePatchCard(BaseModel):
    """A reviewable patch (add/replace/remove) against a project profile."""

    type: Literal["project_profile_patch"] = "project_profile_patch"
    title: str
    rationale: str
    patch: list[ProjectProfilePatchOperation]
    preview: list[ProjectProfilePatchPreviewItem]


# ── Schematic cards: shared sub-structures ───────────────────────────────────
# These cards are programmatically-drawn technical schematics (SVG). The model
# emits PARAMETERS ONLY — never a rendered image and never a number it can't
# know. The frontend draws the diagram to scale from these parameters. Required
# limits come from the OIB corpus (with a NormReference); actual/geometry values
# come from the user's question or the project profile. If a value is unknown,
# leave it null and set status 'needs_input' — do not estimate.

DimStatus = Literal["pass", "fail", "warning", "needs_input"]


class NormReference(BaseModel):
    """A verifiable pointer into a regulation (the atom of grounding).

    Every required value MUST carry one so the architect can verify it against
    the source. Never fabricate a reference.
    """

    document: str = Field(min_length=1, description="Regulation name, e.g. 'OIB-Richtlinie 2', 'ÖNORM B 1600'")
    section: str | None = Field(default=None, description="Clause/table, e.g. 'Pkt. 5.1.1', 'Tabelle 1b'")
    edition: str | None = Field(default=None, description="Edition/year, e.g. 'Ausgabe Mai 2023'")
    excerpt: str | None = Field(default=None, description="Literal quoted sentence grounding the value (<= ~200 chars)")


class DimensionCheck(BaseModel):
    """One measured dimension drawn on a schematic and checked against a limit.

    `value` is the project's actual measurement (drawn to scale); `required` is
    the OIB limit. If `value` is unknown, leave it null and set status
    'needs_input'.
    """

    label: str = Field(min_length=1, description="What is measured, e.g. 'lichte Durchgangsbreite'")
    value: float | None = Field(default=None, description="Actual measurement (drawn); null if unknown")
    required: float | None = Field(default=None, description="OIB limit for this dimension")
    unit: str = Field(default="cm", description="Unit for both value and required, e.g. 'cm', 'm', '%'")
    comparator: Literal["<=", ">="] | None = Field(default=None, description="How actual must relate to required")
    status: DimStatus = Field(description="Verdict for this dimension")


class SectionStorey(BaseModel):
    """One storey in a building cross-section, drawn as a band to scale."""

    label: str = Field(min_length=1, description="Storey label, e.g. 'EG', '1.OG', 'KG'")
    height_m: float = Field(gt=0, description="Clear storey height in metres (drawn to scale)")
    below_grade: bool = Field(default=False, description="True for basements/underground storeys")


class SectionMarker(BaseModel):
    """A horizontal reference line at a given height in the section."""

    label: str = Field(min_length=1, description="What the line marks, e.g. 'Fluchtniveau', 'GK4-Grenze'")
    height_m: float = Field(description="Height above ground datum in metres")
    kind: Literal["fluchtniveau", "threshold", "reference"] = Field(default="reference", description="Styling role")


class SetbackSide(BaseModel):
    """A required distance from the building footprint to one parcel edge."""

    side: Literal["front", "back", "left", "right"] = Field(description="Which edge")
    required_m: float = Field(description="Required setback in metres (OIB/Bauordnung)")
    actual_m: float | None = Field(default=None, description="Actual distance in metres; null if unknown")
    status: DimStatus = Field(description="Verdict for this side")


class EgressSegment(BaseModel):
    """One straight run of an escape path, drawn end-to-end with the next."""

    label: str = Field(min_length=1, description="Segment label, e.g. 'Raum → Gang', 'Gang → Treppenhaus'")
    length_m: float = Field(gt=0, description="Run length in metres (drawn to scale)")
    turn: Literal["straight", "left", "right"] = Field(default="straight", description="Turn AFTER this run")


# ── Schematic cards ──────────────────────────────────────────────────────────


class BuildingSectionCard(BaseModel):
    """A to-scale building cross-section (schematic) drawn from storey heights.

    Emit for height/Gebäudeklasse/Fluchtniveau questions where seeing the
    building against threshold lines helps (e.g. 'liege ich unter der GK4-Grenze?
    Fluchtniveau bei 9,8 m'). Draws stacked storeys, the ground line, and dashed
    marker lines (Fluchtniveau, GK/Hochhaus limits) with labels.
    """

    type: Literal["building_section"]
    title: str = Field(min_length=1, description="Title, e.g. 'Gebäudeschnitt – Höhenprüfung'")
    storeys: list[SectionStorey] = Field(description="Storeys bottom-to-top; basements flagged below_grade")
    markers: list[SectionMarker] | None = Field(default=None, description="Reference lines: Fluchtniveau, GK/Hochhaus")
    reference: NormReference = Field(description="Source of the threshold heights")
    note: str | None = Field(default=None, description="Optional clarification")


class StairDiagramCard(BaseModel):
    """A staircase drawn to scale (schematic section) with step-geometry checks.

    Emit for stair questions (e.g. 'passt eine Treppe mit 17 Stufen, 18 cm
    Steigung, 27 cm Auftritt, 100 cm breit?'). Draws the step profile to scale
    and checks riser/going/width and the comfort rule (2×Steigung + Auftritt ≈
    59–65 cm) against OIB 4.
    """

    type: Literal["stair_diagram"]
    title: str = Field(min_length=1, description="Title, e.g. 'Treppenlauf – Steigungsverhältnis'")
    riser_count: int = Field(gt=0, description="Number of steps in the flight (drawn)")
    riser_height: DimensionCheck = Field(description="Steigung (rise) per step; typical limit <= 18 cm")
    tread_depth: DimensionCheck = Field(description="Auftritt (going) per step; typical limit >= 28 cm")
    width: DimensionCheck = Field(description="Nutzbare Laufbreite; limit depends on Gebäudeklasse")
    comfort_note: str | None = Field(default=None, description="Result of the 2×Steigung + Auftritt comfort check")
    reference: NormReference = Field(description="Source of the step-geometry limits")


class DimensionDiagramCard(BaseModel):
    """A parametric accessibility/geometry schematic with dimension arrows.

    Emit for clearance questions (door width, ramp gradient, turning circle,
    corridor width, threshold). The renderer picks a prebuilt template for
    `shape` and draws each dimension arrow where it is measured, coloured by
    status — preventing the Stocklichte-vs-Durchgangslichte misread.
    """

    type: Literal["dimension_diagram"]
    title: str = Field(min_length=1, description="Title, e.g. 'Rampe – Neigung & Breite'")
    shape: Literal["door", "ramp", "corridor", "turning_circle", "threshold", "parking_space"] = Field(
        description="Which schematic template to draw"
    )
    dimensions: list[DimensionCheck] = Field(description="The measured dimensions to annotate on the schematic")
    reference: NormReference = Field(description="Source of the dimension limits (e.g. OIB 4 / ÖNORM B 1600)")
    note: str | None = Field(default=None, description="Optional clarification")


class SetbackPlanCard(BaseModel):
    """A top-down site plan (schematic): parcel, footprint, and setback envelopes.

    Emit for Abstandsflächen/Bauwich questions ('hält das Gebäude die Abstände
    ein?'). Draws the parcel, the required-setback envelope, and the building
    footprint, with a distance arrow per side coloured by status.
    """

    type: Literal["setback_plan"]
    title: str = Field(min_length=1, description="Title, e.g. 'Abstandsflächen – Lageplan'")
    parcel_width_m: float = Field(gt=0, description="Parcel width in metres (drawn to scale)")
    parcel_depth_m: float = Field(gt=0, description="Parcel depth in metres (drawn to scale)")
    building_width_m: float = Field(gt=0, description="Building footprint width in metres")
    building_depth_m: float = Field(gt=0, description="Building footprint depth in metres")
    sides: list[SetbackSide] = Field(description="Required/actual distance per parcel edge")
    reference: NormReference = Field(description="Source of the setback requirements")


class EgressDiagramCard(BaseModel):
    """A schematic escape-route (Fluchtweg) path with the total length checked.

    Emit for escape-route-length questions ('ist der Fluchtweg mit 12 m + 26 m
    zulässig?'). Draws the path segment-by-segment from the worst-case point to
    the exit and checks the total against the OIB 2 limit (typically 40 m).
    """

    type: Literal["egress_diagram"]
    title: str = Field(min_length=1, description="Title, e.g. 'Fluchtweg – Gehweglänge'")
    segments: list[EgressSegment] = Field(description="Path runs from the worst-case point to the exit, in order")
    total_length: DimensionCheck = Field(description="Sum of segment lengths vs the OIB limit (e.g. <= 40 m)")
    start_label: str | None = Field(default="ungünstigster Punkt", description="Label for the path start")
    exit_label: str | None = Field(default="Treppenhaus", description="Label for the path end/exit")
    reference: NormReference = Field(description="Source of the escape-length limit (OIB 2)")


GridCard = (
    SummaryCard
    | LegalBasisCard
    | ProjectProfilePatchCard
    | BuildingSectionCard
    | StairDiagramCard
    | DimensionDiagramCard
    | SetbackPlanCard
    | EgressDiagramCard
)

# Discriminated-union adapter. ``grid_card_adapter`` is the canonical public name;
# ``_grid_card_adapter`` is retained as a backwards-compatible alias.
grid_card_adapter = TypeAdapter(Annotated[GridCard, Field(discriminator="type")])
_grid_card_adapter = grid_card_adapter

__all__ = [
    "GridCard",
    "LegalBasisCard",
    "ProjectProfilePatchCard",
    "ProjectProfilePatchOperation",
    "ProjectProfilePatchPreviewItem",
    "SummaryCard",
    "grid_card_adapter",
    "validate_cards",
]


def validate_cards(raw: list[dict]) -> list[dict]:
    """Validate a list of raw card dicts and return the validated dicts."""
    return [_grid_card_adapter.validate_python(item).model_dump(exclude_none=True) for item in raw]
