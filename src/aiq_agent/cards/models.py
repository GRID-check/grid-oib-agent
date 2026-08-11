"""Pydantic models for Grid response cards."""

from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import AliasChoices
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import TypeAdapter
from pydantic import field_validator
from pydantic import model_validator


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


# Canonical project-profile fact keys (mirrors the intake definition in
# frontends/ui/src/lib/project-profile/intake-definition.ts). Included in the
# emit_card guidance so the model patches known keys with valid values instead
# of inventing near-duplicates ("building_class" vs "gebaeudeklasse").
PROFILE_FACT_VOCABULARY = (
    "hauptnutzung: wohnen|buero|beherbergung|versammlung|gesundheit|landwirtschaft|produzierend|lager|sonstiges; "
    "gebaeudeklasse: GK1|GK2|GK3|GK4|GK5; "
    "fluchtniveau: <=7m|7-11m|11-22m|>22m; "
    "bestand_neubau: bestand|neubau|zu_und_umbau; "
    "widmung: bauland|verkehrsflaeche|freiland|kerngebiet|gemischt; "
    "bauweise: offen|gekuppelt|geschlossen; "
    "sicherheitskategorie: low|medium|high; "
    "bestandsalter: <10|10-30|30-50|>50; "
    "geschosse_oberirdisch / geschosse_unterirdisch / anzahl_betten / anzahl_einheiten: number; "
    "grundgrenze / fluchtlinie / schutzzone / abweichender_bebauungsplan: boolean; "
    "hohe_gebaeude_details: free text"
)


class ProjectProfilePatchOperation(BaseModel):
    """A JSON Patch operation targeting a project profile section."""

    op: Literal["add", "replace", "remove"]
    path: str = Field(
        description=(
            'For a confirmed hard fact use "/facts/<key>" with op "add" (works for both new and changed '
            'values). For an uncertain inference use "/assumptions/<key>". Known fact keys and values: '
            + PROFILE_FACT_VOCABULARY
        )
    )
    value: Any = Field(
        default=None,
        description=(
            'The PLAIN value only (e.g. "GK4", 3, true) — never wrap it in an object; the app adds '
            "provenance metadata when the user accepts."
        ),
    )

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
    """Propose an update to the project brief (hard project facts) — applied only if the user accepts."""

    type: Literal["project_profile_patch"] = "project_profile_patch"
    title: str = Field(description='Short action title, e.g. "Projektkontext aktualisieren: Fluchtniveau"')
    rationale: str = Field(
        description="One or two sentences: what was learned in this conversation and why it changes the brief"
    )
    patch: list[ProjectProfilePatchOperation]
    preview: list[ProjectProfilePatchPreviewItem] = Field(
        description='One row per changed field; use "—" for before when the fact was previously unknown'
    )


class MemoryProposalCard(BaseModel):
    """A proposal to save a finding to long-term memory, confirmed by the user.

    System-emitted by the `remember` tool when an org-scoped write needs human
    authorization; the user chooses org-wide or project scope and the write goes
    through their authenticated session."""

    type: Literal["memory_proposal"]
    title: str = Field(min_length=1, description="Short title for the memory proposal")
    content: str = Field(min_length=1, description="The finding to remember (shown to the user verbatim)")
    kind: Literal["decision", "constraint", "open_question", "derived_fact", "preference"]
    confidence: Literal["low", "medium", "high"] = Field(default="medium")


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


# ── Schematic cards (wave 2) ─────────────────────────────────────────────────


class Obstruction(BaseModel):
    """An object blocking daylight (opposing building, own projection)."""

    distance_m: float = Field(gt=0, description="Horizontal distance from the window in metres")
    height_m: float = Field(description="Height of the obstruction above the window sill in metres")
    label: str = Field(min_length=1, description="What it is, e.g. 'Gegenüberliegendes Gebäude'")


class DaylightIncidenceCard(BaseModel):
    """A daylight (Belichtung) schematic: the 45° free-light line vs obstructions.

    Emit for daylight/Belichtung questions (OIB 3). Draws a window section, the
    45° free-light-incidence line from the window's lower edge, any obstruction,
    and a glass-area-vs-floor-area check. The renderer does the 45° geometry —
    the model supplies distances/heights only.
    """

    type: Literal["daylight_incidence"]
    title: str = Field(min_length=1, description="Title, e.g. 'Belichtung – freier Lichteinfall'")
    room_floor_area_m2: float | None = Field(default=None, description="Aufenthaltsraum floor area in m²")
    glass_area: DimensionCheck = Field(description="Lichteintrittsfläche (m²) vs the ≥10% requirement")
    window_sill_height_m: float | None = Field(default=None, description="Sill (Parapet) height in metres")
    window_head_height_m: float | None = Field(default=None, description="Window head (Sturz) height in metres")
    obstruction: Obstruction | None = Field(default=None, description="Any object intruding into the 45° light cone")
    reference: NormReference = Field(description="Source of the daylight requirement (OIB 3)")
    note: str | None = Field(default=None, description="Optional clarification")


class GuardrailCheckCard(BaseModel):
    """An Absturzsicherung (guardrail) elevation with the interacting limits.

    Emit for guardrail/railing questions (OIB 4). Draws the railing to scale and
    checks height (>=100 cm, >=110 cm where Absturzhöhe > 12 m), max opening
    (<=12 cm cube), bottom gap, and shades the no-climb zone.
    """

    type: Literal["guardrail_check"]
    title: str = Field(min_length=1, description="Title, e.g. 'Absturzsicherung Dachterrasse'")
    context: Literal["balkon", "loggia", "stiege", "fenster", "dachterrasse"] = Field(description="Railing location")
    fall_height: DimensionCheck = Field(description="Absturzhöhe (m) — decides which height limit applies")
    rail_height: DimensionCheck = Field(description="Geländerhöhe (cm) vs the required minimum")
    max_opening: DimensionCheck = Field(description="Largest opening (cm) vs the <=12 cm cube rule")
    bottom_gap: DimensionCheck | None = Field(default=None, description="Gap at the base (cm)")
    has_horizontal_elements_in_climb_zone: bool | None = Field(default=None, description="Climbable horizontals?")
    reference: NormReference = Field(description="Source of the guardrail limits (OIB 4)")
    note: str | None = Field(default=None, description="Optional clarification")


class DensityCheckCard(BaseModel):
    """A site-density schematic: parcel + footprint + coverage/density bars.

    Emit for Bebauungsdichte/Bebauungsgrad/GFZ questions. Draws the parcel with
    the footprint shaded and two limit bars (built area / parcel and BGF /
    parcel) vs the Bebauungsplan limits. The renderer computes the ratios — the
    model supplies areas + the limits (from the user's Bebauungsplan) only.
    """

    type: Literal["density_check"]
    title: str = Field(min_length=1, description="Title, e.g. 'Bebauungsdichte – Grundstück'")
    parcel_area_m2: float = Field(gt=0, description="Parcel (Grundstück) area in m²")
    footprint_area_m2: float | None = Field(default=None, description="Built (bebaute) area in m²")
    gross_floor_area_m2: float | None = Field(default=None, description="Bruttogeschossfläche (BGF) in m²")
    coverage: DimensionCheck = Field(description="Bebauungsgrad (built/parcel) vs limit; value null = renderer derives")
    density: DimensionCheck = Field(description="GFZ (BGF/parcel) vs limit; null value = renderer derives")
    reference: NormReference = Field(description="Source of the limits (usually the Bebauungsplan)")
    note: str | None = Field(default=None, description="Optional clarification")


class AufstellflaechePlan(BaseModel):
    """The fire-brigade Aufstellfläche geometry."""

    width: DimensionCheck = Field(description="Aufstellfläche width (m)")
    length: DimensionCheck = Field(description="Aufstellfläche length (m)")
    distance_to_facade: DimensionCheck | None = Field(default=None, description="Distance to the facade (m)")


class FireAccessPlanCard(BaseModel):
    """A fire-brigade access (Feuerwehrzufahrt) site plan schematic.

    Emit for fire-access questions (OIB 2 / TRVB). Top-down plan: access route
    from the road, the Aufstellfläche beside the facade, and the reach distance
    from the Aufstellfläche to the farthest necessary entrance (typically
    <=80 m). Numeric minimums vary by Land — always corpus-grounded per check.
    """

    type: Literal["fire_access_plan"]
    title: str = Field(min_length=1, description="Title, e.g. 'Feuerwehrzufahrt & Aufstellfläche'")
    parcel_width_m: float = Field(gt=0, description="Parcel width in metres")
    parcel_depth_m: float = Field(gt=0, description="Parcel depth in metres")
    building_width_m: float = Field(gt=0, description="Building footprint width in metres")
    building_depth_m: float = Field(gt=0, description="Building footprint depth in metres")
    route_width: DimensionCheck = Field(description="Zufahrt clear width (m) vs the minimum")
    gate_clearance_height: DimensionCheck | None = Field(default=None, description="Durchfahrt clear height (m)")
    aufstellflaeche: AufstellflaechePlan = Field(description="The fire-brigade standing-area geometry")
    walk_distance_to_entrance: DimensionCheck = Field(description="Reach to farthest entrance (m), e.g. <=80")
    gebaeudeklasse: str | None = Field(default=None, description="The building's Gebäudeklasse (drives the limit)")
    reference: NormReference = Field(description="Source of the access requirements (OIB 2 / TRVB)")
    note: str | None = Field(default=None, description="Optional clarification")


class AcousticCheckItem(BaseModel):
    """One sound-insulation check between two building parts."""

    path_label: str = Field(min_length=1, description="What is separated, e.g. 'Wohnungstrennwand Top 3/Top 4'")
    metric: Literal["DnTw", "LnTw", "Rw_res"] = Field(description="Airborne / impact / resulting metric")
    check: DimensionCheck = Field(description="Measured vs required in dB (comparator differs by metric)")
    reference: NormReference = Field(description="Source of the dB limit (OIB 5 / ÖNORM B 8115-2)")


class AcousticCheckCard(BaseModel):
    """Sound-insulation (Schallschutz) gauges — direction-aware dB checks.

    Emit for Schallschutz questions (OIB 5). One gauge per building-part pair:
    airborne (DnTw, higher is better) and impact (LnTw, lower is better) shown
    with opposite orientation so the margin is unmistakable. Measured values
    come from the Bauphysik report; unknown → needs_input.
    """

    type: Literal["acoustic_check"]
    title: str = Field(min_length=1, description="Title, e.g. 'Schallschutz – Wohnungstrennung'")
    checks: list[AcousticCheckItem] = Field(description="The individual dB checks")
    sound_class: str | None = Field(default=None, description="ÖNORM B 8115-2 Schallschutzklasse, if given")
    note: str | None = Field(default=None, description="Optional clarification")


# ── Schematic cards (wave 3) ─────────────────────────────────────────────────


class FireCompartment(BaseModel):
    """One Brandabschnitt (fire compartment) drawn as a band, area-checked."""

    label: str = Field(min_length=1, description="Compartment name, e.g. 'BA 1 – Wohnungen OG'")
    area: DimensionCheck = Field(description="Brandabschnittsfläche (m²) vs the max permitted (comparator '<=')")
    use: str | None = Field(default=None, description="Nutzung, e.g. 'Wohnen', 'Büro', 'Tiefgarage'")


class FireCompartmentCard(BaseModel):
    """A fire-compartment (Brandabschnitt) plan: a storey split into compartments.

    Emit for Brandabschnitt questions (OIB 2): draws the storey outline divided
    into compartments (width proportional to area) separated by Brandwände, each
    read against the maximum permitted Brandabschnittsfläche for its use and
    Gebäudeklasse. The limit varies by use/GK — always corpus-grounded.
    """

    type: Literal["fire_compartment"]
    title: str = Field(min_length=1, description="Title, e.g. 'Brandabschnitte – Regelgeschoss'")
    storey_label: str | None = Field(default=None, description="Which level the plan shows, e.g. '2.OG'")
    compartments: list[FireCompartment] = Field(description="The compartments on this level, left-to-right")
    gebaeudeklasse: str | None = Field(default=None, description="Gebäudeklasse driving the area limit")
    reference: NormReference = Field(description="Source of the max Brandabschnittsfläche (OIB 2)")
    note: str | None = Field(default=None, description="Optional clarification")


class EnvelopeComponent(BaseModel):
    """One thermal-envelope component with its U-value checked against a limit."""

    label: str = Field(min_length=1, description="Component, e.g. 'Außenwand', 'Dach', 'Fenster'")
    kind: Literal["wall", "roof", "floor", "window", "door"] = Field(description="Where it sits in the section")
    u_value: DimensionCheck = Field(description="U-Wert W/(m²K) vs the max U-value (lower is better, '<=')")


class ThermalEnvelopeCard(BaseModel):
    """A thermal-envelope (Wärmeschutz) schematic: U-values per building part.

    Emit for U-Wert / Wärmeschutz questions (OIB 6). Draws a simple building
    cross-section with each envelope component highlighted by status, and one
    limit bar per component reading its U-value against the maximum permitted
    (lower is better). Fills the OIB 6 energy-efficiency domain.
    """

    type: Literal["thermal_envelope"]
    title: str = Field(min_length=1, description="Title, e.g. 'Wärmeschutz – U-Werte der Gebäudehülle'")
    components: list[EnvelopeComponent] = Field(description="The envelope components to check")
    reference: NormReference = Field(description="Source of the max U-values (OIB 6 / ÖNORM B 8110-1)")
    note: str | None = Field(default=None, description="Optional clarification")


class EnergyPerformanceCard(BaseModel):
    """An energy-performance (Energieausweis) card: HWB on the A–G class ladder.

    Emit for Energieausweis / Heizwärmebedarf questions (OIB 6). Draws the
    A++…G energy-class ladder with the building's class highlighted, and reads
    the Heizwärmebedarf (kWh/m²a) against the required maximum. fGEE optional.
    """

    type: Literal["energy_performance"]
    title: str = Field(min_length=1, description="Title, e.g. 'Energieausweis – Heizwärmebedarf'")
    hwb: DimensionCheck = Field(description="Heizwärmebedarf kWh/(m²a) vs the max (lower is better, '<=')")
    energy_class: str | None = Field(default=None, description="Energieeffizienzklasse, e.g. 'A', 'B', 'C'")
    fgee: DimensionCheck | None = Field(default=None, description="Gesamtenergieeffizienzfaktor vs its limit")
    reference: NormReference = Field(description="Source of the HWB requirement (OIB 6)")
    note: str | None = Field(default=None, description="Optional clarification")


class ElevatorRequirementCard(BaseModel):
    """A barrier-free-elevator (Aufzug) card: requirement + cabin dimensions.

    Emit for Aufzug / barrierefreie-Erschließung questions (OIB 4). Draws the
    served storeys as a stack with a lift shaft, states whether a barrier-free
    lift is required (drives from storey count / arrival level), and checks the
    cabin and door clear dimensions against the accessibility minimums.
    """

    type: Literal["elevator_requirement"]
    title: str = Field(min_length=1, description="Title, e.g. 'Barrierefreier Aufzug – Erschließung'")
    storeys_served: int = Field(gt=0, description="Number of levels the building has (drawn as a stack)")
    entrance_level_index: int | None = Field(default=None, description="0-based index of the entrance level")
    is_required: bool | None = Field(default=None, description="Is a barrier-free lift required? null = unknown")
    requirement_note: str | None = Field(default=None, description="Why a lift is / isn't required")
    cabin_width: DimensionCheck | None = Field(default=None, description="Kabinenbreite (cm) vs the minimum (>=110)")
    cabin_depth: DimensionCheck | None = Field(default=None, description="Kabinentiefe (cm) vs the minimum (>=140)")
    door_width: DimensionCheck | None = Field(default=None, description="lichte Türbreite (cm) vs the minimum (>=90)")
    reference: NormReference = Field(description="Source of the lift requirement (OIB 4 / ÖNORM B 1600)")
    note: str | None = Field(default=None, description="Optional clarification")


class ParkingRequirementCard(BaseModel):
    """A parking-provision (Stellplatznachweis) card: required vs provided count.

    Emit for Stellplatz / Fahrradabstellplatz questions (Bauordnung /
    Stellplatzverordnung). Draws a slot grid — outline slots for the required
    count, filled for those provided — and reads provided against the required
    minimum for cars and, optionally, bicycles.
    """

    type: Literal["parking_requirement"]
    title: str = Field(min_length=1, description="Title, e.g. 'Stellplatznachweis – Wohnbau'")
    car_spaces: DimensionCheck = Field(description="Provided vs required Kfz-Stellplätze (comparator '>=')")
    bicycle_spaces: DimensionCheck | None = Field(default=None, description="Provided vs required Fahrradabstellplätze")
    basis: str | None = Field(default=None, description="How the requirement is derived, e.g. '1 Stpl. je 100 m² BGF'")
    reference: NormReference = Field(description="Source of the parking requirement (Bauordnung / StPl-VO)")
    note: str | None = Field(default=None, description="Optional clarification")


# ── Structured non-schematic cards ───────────────────────────────────────────


class ChecklistItem(BaseModel):
    """One requirement in a checklist, with its verdict and grounding."""

    label: str = Field(min_length=1, description="The requirement, e.g. 'Zweiter Fluchtweg vorhanden'")
    status: DimStatus = Field(description="Verdict for this requirement")
    detail: str | None = Field(default=None, description="Short explanation or the relevant measured value")
    reference: NormReference | None = Field(default=None, description="Where this requirement comes from")


class RequirementChecklistCard(BaseModel):
    """A requirement checklist: several pass/fail criteria for one question.

    Emit when an answer boils down to a list of criteria read against the
    project ('Was muss ich für GK 4 erfüllen?', 'Ist das Bauansuchen
    vollständig?'). Each item carries its own verdict and, where possible, its
    own norm reference; unknown items use status 'needs_input' — never a guess.
    """

    type: Literal["requirement_checklist"]
    title: str = Field(min_length=1, description="Title, e.g. 'Anforderungen GK 4 – Brandschutz'")
    items: list[ChecklistItem] = Field(min_length=1, description="The requirements, in reading order")
    reference: NormReference | None = Field(default=None, description="Overall source when items share one")
    note: str | None = Field(default=None, description="Optional clarification")


class ComparisonRow(BaseModel):
    """One criterion compared across the options (one value per option)."""

    label: str = Field(min_length=1, description="Criterion, e.g. 'max. Brandabschnittsfläche'")
    values: list[str] = Field(min_length=1, description="One value per option, same order as `options`")
    highlight_index: int | None = Field(
        default=None, ge=0, description="0-based index of the option favoured on this criterion, if any"
    )


class ComparisonTableCard(BaseModel):
    """A side-by-side comparison of a small number of options.

    Emit when the user weighs alternatives (GK 4 vs GK 5, two escape-route
    variants, Holzbau vs Massivbau requirements). Options are columns, criteria
    are rows; values are short strings the model already grounded in the
    answer. Optionally highlight the favoured option per row and name an
    overall recommendation.
    """

    type: Literal["comparison_table"]
    title: str = Field(min_length=1, description="Title, e.g. 'GK 4 vs. GK 5 – Anforderungen'")
    options: list[str] = Field(min_length=2, description="Column headers, e.g. ['GK 4', 'GK 5']")
    rows: list[ComparisonRow] = Field(min_length=1, description="The compared criteria")
    recommendation: str | None = Field(default=None, description="Overall recommendation, if the answer implies one")
    reference: NormReference | None = Field(default=None, description="Source grounding the compared values")
    note: str | None = Field(default=None, description="Optional clarification")

    @model_validator(mode="after")
    def _square_rows(self) -> "ComparisonTableCard":
        """Pad short rows with '' and truncate long ones to the option count.

        LLM output occasionally mismatches row/column counts; an empty cell is
        honest ("no value given") while dropping the whole card loses the rest.
        """
        n = len(self.options)
        for row in self.rows:
            if len(row.values) < n:
                row.values = row.values + [""] * (n - len(row.values))
            elif len(row.values) > n:
                row.values = row.values[:n]
            if row.highlight_index is not None and row.highlight_index >= n:
                row.highlight_index = None
        return self


# ── Document-surfacing card (system-emitted) ─────────────────────────────────
# Surfaced by the `surface_documents` tool from a REAL vector search over the
# project + Büroarchiv corpus — never fabricated by the model (it is a system
# card, so `emit_card` refuses it). Each entry names a real indexed file so the
# frontend can resolve it to the live document row (id, thumbnail, preview) and
# render the same rich file-explorer card the Files page uses.


class SurfacedDocument(BaseModel):
    """One real document surfaced by a corpus search, with its match evidence."""

    file_name: str = Field(min_length=1, description="Exact indexed file name (resolves to the live document row)")
    summary: str | None = Field(default=None, description="One-line description of what the document is")
    snippet: str | None = Field(default=None, description="Best-matching passage — WHY this file surfaced")
    page: int | None = Field(default=None, description="1-based page the snippet came from, if known")
    score: float | None = Field(default=None, description="0..1 relevance score of the best chunk")
    source: Literal["projekt", "buero"] | None = Field(
        default=None, description="Which corpus it came from: 'projekt' (project) or 'buero' (Büroarchiv)"
    )


class DocumentGridCard(BaseModel):
    """A grid of REAL project/Büroarchiv documents surfaced for the user.

    System-emitted by the ``surface_documents`` tool after a deterministic vector
    search — the model asks for a search, the tool returns real files. Renders as
    clickable file-explorer preview cards (thumbnail, name, match snippet) that
    open the document.
    """

    type: Literal["document_grid"] = "document_grid"
    title: str = Field(min_length=1, description="Short heading, e.g. 'Relevante Dokumente – Fluchtwege'")
    query: str | None = Field(default=None, description="The search phrase these documents matched")
    documents: list[SurfacedDocument] = Field(min_length=1, description="The surfaced files, best match first")


# ---------------------------------------------------------------------------
# IFC/BIM viewer card
# ---------------------------------------------------------------------------
# The one card that renders the architect's ACTUAL building rather than a
# schematic of it. Everything else in this catalog is drawn from numbers the
# model supplies; this one points at geometry that already exists, so the model
# supplies only WHICH elements to look at and why.
#
# The model never invents an element: `global_ids` must be IFC GlobalIds that
# came back from the `ifc_query` tool in the same turn. An id that does not
# exist in the model simply does not highlight — the viewer shows the building
# and says how many highlights it could not resolve, rather than pretending.


class IfcPropertyMatch(BaseModel):
    """One property predicate, in ifc_query's own filter grammar."""

    name: str = Field(min_length=1, description="Property name, e.g. 'IsExternal' or 'FireRating'")
    set: str | None = Field(
        default=None,
        description="Property-set name, e.g. 'Pset_WallCommon'. Omit to search every set.",
    )
    operator: Literal["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists", "missing"] = Field(
        default="eq", description="Comparison. 'exists'/'missing' take no value."
    )
    value: str | float | bool | None = Field(default=None, description="Value to compare against")
    source: Literal["property", "quantity"] = Field(
        default="property", description="Which store to search: 'property' (default) or 'quantity'"
    )


class IfcElementMatch(BaseModel):
    """The SET of elements to highlight, as a filter rather than a list of ids.

    Exactly the ``filters`` object passed to ``ifc_query`` — the browser re-runs
    it against the model, so the highlight covers every matching element and
    nothing has to survive the model's context window.

    ``ifc_query`` spells its filter keys in camelCase (``ifcTypes``,
    ``nameContains``) and this card is authored in snake_case like every other
    card field. The agent is told to reuse the filter it already wrote, so BOTH
    spellings are accepted and normalise to the snake_case field: without the
    aliases a copied filter validated cleanly with every key silently dropped,
    leaving an empty match, and a highlight group that selects nothing.
    """

    model_config = ConfigDict(populate_by_name=True)

    ifc_types: list[str] | None = Field(
        default=None,
        validation_alias=AliasChoices("ifc_types", "ifcTypes"),
        description="Canonical IFC types, e.g. ['IfcWall']",
    )
    storeys: list[str] | None = Field(default=None, description="Storey names, e.g. ['Erdgeschoss']")
    name_contains: str | None = Field(
        default=None,
        validation_alias=AliasChoices("name_contains", "nameContains"),
        description="Case-insensitive substring of the element name",
    )
    material: str | None = Field(default=None, description="Case-insensitive substring of a material name")
    classification: str | None = Field(
        default=None, description="Case-insensitive substring of a classification code or label"
    )
    properties: list[IfcPropertyMatch] | None = Field(default=None, description="Property predicates, all required")

    def is_empty(self) -> bool:
        """True when no criterion was given at all.

        An empty filter means "every element in the building", which would
        light up the whole model under a label like *nicht erfüllt*. The
        frontend refuses it, so without this check the card validated, the
        group reached the browser, and it was dropped there — the legend lost
        an entry with no signal to anyone.
        """
        return not any(
            (self.ifc_types, self.storeys, self.name_contains, self.material, self.classification, self.properties)
        )


class IfcHighlight(BaseModel):
    """One set of model elements to call out, with a verdict.

    Give EITHER ``match`` or ``global_ids``, and prefer ``match`` whenever the
    answer is about a set rather than about elements you named. An id list has
    to travel through the model's context, so "the 420 external walls" arrived
    as whatever fitted and the card highlighted a fraction of the answer while
    the legend claimed all of it. A filter is re-run in the browser: the whole
    set lights up, and it costs the model a filter it has already written.
    """

    global_ids: list[str] | None = Field(
        default=None,
        min_length=1,
        description=(
            "IFC GlobalIds returned by ifc_query. NEVER invent these — an id you did not see is a wrong answer. "
            "Use for a handful of elements the answer names; use 'match' for a set."
        ),
    )
    match: IfcElementMatch | None = Field(
        default=None,
        description=(
            "The ifc_query filter that selects this set. Preferred over global_ids for anything "
            "larger than a few elements — reuse the exact filters you queried with."
        ),
    )
    label: str = Field(min_length=1, description="What is being shown, e.g. 'Fluchtweg > 40 m'")
    status: Literal["pass", "fail", "warning", "info"] = Field(
        default="info", description="Verdict colour: pass=green, fail=red, warning=amber, info=neutral"
    )

    @model_validator(mode="after")
    def exactly_one_selector(self) -> "IfcHighlight":
        """A group with neither selects nothing; with both, the two disagree.

        Both is the dangerous one: the renderer would have to pick, and either
        choice silently discards half of what the model asked for.
        """
        if (self.global_ids is None) == (self.match is None):
            raise ValueError("give exactly one of 'global_ids' or 'match'")
        if self.match is not None and self.match.is_empty():
            raise ValueError("'match' needs at least one criterion — an empty filter selects the whole building")
        return self


class IfcViewerCard(BaseModel):
    """The project's IFC model, rendered in 3D, with findings highlighted on it.

    Use when the answer is ABOUT specific parts of the building and seeing them
    beats reading their names — a compliance finding on particular walls, the
    rooms that fall below a required area, the escape route being discussed.
    Do NOT use it as a decorative "here is your building": an unhighlighted
    viewer says nothing a sentence does not.
    """

    type: Literal["ifc_viewer"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Brandabschnitte – EG'")
    model_file: str | None = Field(
        default=None,
        description=(
            "File name of the model, exactly as ifc_query reported it (e.g. 'haus-a.ifc'). "
            "Leave empty when the project has only one model."
        ),
    )
    highlights: list[IfcHighlight] | None = Field(
        default=None, description="Element groups to colour in the viewer, each with a verdict"
    )
    storey: str | None = Field(default=None, description="Storey name to isolate on open, e.g. 'Erdgeschoss'")
    note: str | None = Field(default=None, description="Optional one-line clarification under the viewer")


class IfcScheduleCard(BaseModel):
    """The project's Raumbuch (room schedule) straight from the model.

    The card names WHICH table to show; the frontend fetches the numbers from
    the model itself. The model therefore cannot get an area wrong, because it
    never supplies one — the same reason the viewer card carries GlobalIds and
    not geometry.

    Use when the user asks for room areas, a Flächenaufstellung, or "what rooms
    are on the second floor".
    """

    type: Literal["ifc_schedule"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Flächenaufstellung'")
    model_file: str | None = Field(
        default=None,
        description="File name of the model as ifc_query reported it. Empty when the project has one model.",
    )
    storey: str | None = Field(
        default=None, description="Limit the table to one storey, e.g. 'Erdgeschoss'. Empty shows all."
    )
    note: str | None = Field(default=None, description="Optional one-line clarification")


class IfcComplianceCard(BaseModel):
    """The Prüfbuch: OIB requirements with their verdict against this model.

    Carries only WHICH requirements to show; the frontend runs the catalogue and
    renders the counts, the thresholds and the failing elements itself. The
    model therefore cannot state that a building complies, because it never
    supplies a verdict — the same reason the schedule card carries no areas.

    Use when the user asks whether the model meets a requirement, what is still
    open, or what they have to add to the model. Prefer it over prose whenever
    the answer is a list of requirements: the card stays correct after the model
    changes, and a sentence does not.

    NEVER present this as a Nachweis. The catalogue reads only published
    property values, it reads no geometry, and Fluchtweglängen, Geländerhöhen
    und Brandabschnittsgrößen are not in it at all.
    """

    type: Literal["ifc_compliance"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Anforderungen Brandschutz'")
    model_file: str | None = Field(
        default=None,
        description="File name of the model as ifc_query reported it. Empty when the project has one model.",
    )
    rule_ids: list[str] = Field(
        default_factory=list,
        max_length=20,
        description=(
            "Rule ids from ifc_query operation='compliance' (e.g. 'oib2-feuerwiderstand-tragend') "
            "to narrow the card to the requirements this answer is about. Empty shows all. "
            "Use ONLY ids the tool reported; the card says so when one does not resolve."
        ),
    )
    note: str | None = Field(default=None, description="Optional one-line clarification")


class IfcElementCard(BaseModel):
    """One element of the model, in full, with a link into the 3D view.

    Use when the answer is ABOUT a specific element the user will want to look
    at — the wall that fails a requirement, the door being discussed. The card
    carries only the GlobalId; every property shown is read live from the model.
    """

    type: Literal["ifc_element"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Aussenwand Nord'")
    global_id: str = Field(
        min_length=1,
        description=(
            "IFC GlobalId returned by ifc_query. NEVER invent one — an id you did not see resolves to nothing."
        ),
    )
    model_file: str | None = Field(default=None, description="Model file name; empty when there is one model.")
    note: str | None = Field(default=None, description="Why this element matters to the answer")


class IfcDiffCard(BaseModel):
    """What changed between two revisions of the model.

    Names the two files; the frontend computes the comparison by IFC GlobalId.
    Use for "what changed since the last submission" — the question a pair of
    plan PDFs cannot answer.
    """

    type: Literal["ifc_diff"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Änderungen seit Einreichung'")
    base_model_file: str = Field(min_length=1, description="The OLDER revision's file name")
    model_file: str | None = Field(
        default=None, description="The NEWER revision's file name. Empty uses the project's current model."
    )
    note: str | None = Field(default=None, description="Optional one-line clarification")


GridCard = (
    SummaryCard
    | LegalBasisCard
    | ProjectProfilePatchCard
    | RequirementChecklistCard
    | ComparisonTableCard
    | BuildingSectionCard
    | StairDiagramCard
    | DimensionDiagramCard
    | SetbackPlanCard
    | EgressDiagramCard
    | DaylightIncidenceCard
    | GuardrailCheckCard
    | DensityCheckCard
    | FireAccessPlanCard
    | AcousticCheckCard
    | FireCompartmentCard
    | ThermalEnvelopeCard
    | EnergyPerformanceCard
    | ElevatorRequirementCard
    | ParkingRequirementCard
    | MemoryProposalCard
    | DocumentGridCard
    | IfcViewerCard
    | IfcComplianceCard
    | IfcScheduleCard
    | IfcElementCard
    | IfcDiffCard
)

# Discriminated-union adapter — the canonical validator for a raw card dict.
grid_card_adapter = TypeAdapter(Annotated[GridCard, Field(discriminator="type")])

__all__ = [
    "ChecklistItem",
    "ComparisonRow",
    "ComparisonTableCard",
    "DocumentGridCard",
    "GridCard",
    "IfcHighlight",
    "IfcViewerCard",
    "IfcComplianceCard",
    "IfcScheduleCard",
    "IfcElementCard",
    "IfcDiffCard",
    "LegalBasisCard",
    "MemoryProposalCard",
    "SurfacedDocument",
    "ProjectProfilePatchCard",
    "ProjectProfilePatchOperation",
    "ProjectProfilePatchPreviewItem",
    "RequirementChecklistCard",
    "SummaryCard",
    "grid_card_adapter",
    "validate_cards",
]


def validate_cards(raw: list[dict]) -> list[dict]:
    """Validate a list of model-produced card dicts and return the validated dicts.

    Per-card: one malformed card is logged and skipped instead of discarding
    the whole batch (LLM output regularly contains one bad item among good
    ones, and cards are a progressive enhancement — never fail the answer).

    System cards (``SYSTEM_CARD_TYPES``) are dropped here too: this is the
    post-hoc / batch generation path fed by *model* output, and a system card
    must only ever come from its owning tool on a sanctioned path (e.g.
    ``document_grid`` from ``surface_documents``, ``memory_proposal`` from
    ``remember``). The model is never told these types exist, so any occurrence
    here is a fabrication — enforce the same invariant ``emit_card`` and the
    DSML salvage already enforce, closing the last emission path.
    """
    import logging

    from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES

    logger = logging.getLogger(__name__)
    validated: list[dict] = []
    for item in raw:
        if isinstance(item, dict) and item.get("type") in SYSTEM_CARD_TYPES:
            logger.warning("Dropping model-fabricated system card (type=%s)", item.get("type"))
            continue
        try:
            validated.append(grid_card_adapter.validate_python(item).model_dump(exclude_none=True))
        except Exception as exc:
            logger.warning(
                "Dropping invalid card (type=%s): %s",
                item.get("type") if isinstance(item, dict) else type(item).__name__,
                exc,
            )
    return validated
