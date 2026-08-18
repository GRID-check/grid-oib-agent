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
        default_factory=list,
        description=(
            "Optional and not rendered. The card builds its before/after rows from the PATCH "
            "and the live profile (`buildPatchPreviewRows`), never from a model-supplied "
            "preview — what the user consents to has to be what is written. Kept as an "
            "optional field rather than removed so an older stored card still validates."
        ),
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

#: Where a number on a card came from — the three the spatial engine draws.
#:
#: These are `ifc_spatial.envelope.Answer.provenance` exactly, and the point of
#: keeping the same three words is that the card and the sentence beside it can
#: never disagree about who is making the claim. The German the renderer prints
#: for each is not decoration either:
#:
#:   declared → „laut Modell"   — the architect's own statement, quoted back
#:   computed → „gemessen"      — OUR measurement, and it carries a tolerance
#:   inferred → „vermutlich"    — a heuristic, offered for confirmation
#:
#: The difference between the first two is the difference between reporting the
#: file and reporting ourselves, and a reader has to be able to tell which one
#: they are being handed before they sign it.
Provenance = Literal["declared", "computed", "inferred"]


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

    ## Why a number here carries where it came from

    This block used to be `label / value / required / unit / comparator /
    status` and nothing else, and that made the card the least honest surface in
    the product. `ifc_measure` answers „gemessen: 2.47 m (±5 mm) — aus der
    Geometrie berechnet, nicht deklariert", the assistant repeats that in the
    prose, and the card beside it drew **2.47 m ✓** — indistinguishable from a
    figure the architect had stated in their own file. The card is the part a
    reviewer screenshots into a submission, so the surface that dropped the
    qualifier was the surface most likely to be forwarded without it.

    Three fields close that, and all three are OPTIONAL: a card built from the
    Bestimmung alone (a limit with no model behind it) has nothing to put in
    them, and a null here means "not stated", never "declared".
    """

    label: str = Field(min_length=1, description="What is measured, e.g. 'lichte Durchgangsbreite'")
    value: float | None = Field(default=None, description="Actual measurement (drawn); null if unknown")
    required: float | None = Field(default=None, description="OIB limit for this dimension")
    unit: str = Field(default="cm", description="Unit for both value and required, e.g. 'cm', 'm', '%'")
    comparator: Literal["<=", ">="] | None = Field(default=None, description="How actual must relate to required")
    status: DimStatus = Field(description="Verdict for this dimension")
    provenance: Provenance | None = Field(
        default=None,
        description=(
            "Where `value` came from, copied from the ifc_measure answer's own provenance: 'declared' "
            "(the IFC file states it), 'computed' (we measured it off the geometry), 'inferred' (a "
            "heuristic, offered for confirmation). Leave null when the number did not come from the "
            "model at all — a figure the user typed, or one taken from the Bestimmung. NEVER guess it: "
            "labelling our own measurement 'declared' turns our tolerance into the architect's claim."
        ),
    )
    tolerance: float | None = Field(
        default=None,
        ge=0,
        description=(
            "The ± band on `value`, in the SAME unit — copied from the ifc_measure answer. Only "
            "meaningful with provenance 'computed': a declared figure is the file's statement and has "
            "no band of ours. A measured dimension without its band reads as exact, and the band is "
            "what decides whether 2.49 m clears a 2.50 m minimum."
        ),
    )
    missing: str | None = Field(
        default=None,
        description=(
            "With status 'needs_input': what the export does not provide and WHAT TO CHANGE IN THE CAD "
            "to make it answerable — copied verbatim from the ifc_measure answer's missing.remedy. This "
            "is the sentence the architect acts on, and a card that shows an empty slot instead of it "
            "turns a finding about the export into a blank the reader reads as a fact about the building."
        ),
    )


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
    building against threshold lines helps (e.g. 'am I below the GK4 limit with
    a Fluchtniveau of 9.8 m?'). Draws stacked storeys, the ground line, and
    dashed marker lines (Fluchtniveau, GK/Hochhaus limits) with labels.
    """

    type: Literal["building_section"]
    title: str = Field(min_length=1, description="Title, e.g. 'Gebäudeschnitt – Höhenprüfung'")
    storeys: list[SectionStorey] = Field(description="Storeys bottom-to-top; basements flagged below_grade")
    markers: list[SectionMarker] | None = Field(default=None, description="Reference lines: Fluchtniveau, GK/Hochhaus")
    reference: NormReference = Field(description="Source of the threshold heights")
    note: str | None = Field(default=None, description="Optional clarification")


class StairDiagramCard(BaseModel):
    """A staircase drawn to scale (schematic section) with step-geometry checks.

    Emit for stair questions (e.g. 'does a flight of 17 steps with 18 cm
    Steigung, 27 cm Auftritt and 100 cm width fit?'). Draws the step profile to
    scale and checks riser/going/width and the comfort rule (2×Steigung +
    Auftritt ≈ 59–65 cm) against OIB 4.
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

    Emit for Abstandsflächen/Bauwich questions ('does the building keep the
    required Abstände?'). Draws the parcel, the required-setback envelope, and
    the building footprint, with a distance arrow per side coloured by status.
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

    Emit for escape-route-length questions ('is a Fluchtweg of 12 m + 26 m
    permitted?'). Draws the path segment-by-segment from the worst-case point to
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
    project ('what do I have to meet for GK 4?', 'is the Bauansuchen
    complete?'). Each item carries its own verdict and, where possible, its own
    norm reference; unknown items use status 'needs_input' — never a guess.
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


class VerdictHeaderCard(BaseModel):
    """The answer's verdict (TL;DR) rendered as a structural header on top.

    Emit at the very TOP of an answer whose core is a single headline result —
    a number, a rating or a ruling ('1,10 m', 'REI 90', 'Nicht geregelt'). It
    is the lede rendered rather than written, so it cannot drift from the answer
    the way a hand-typed TL;DR can. Use at most one, and only when the answer
    resolves to one headline; a nuanced answer belongs in prose or a
    condition_tree.
    """

    type: Literal["verdict_header"]
    verdict: str = Field(
        min_length=1,
        description="The headline result itself — the number or ruling, e.g. '1,10 m', 'REI 90', 'Nicht geregelt'",
    )
    subject: str = Field(min_length=1, description="What the verdict answers, e.g. 'Erforderliche Geländerhöhe'")
    reference: NormReference | None = Field(
        default=None, description="The norm the verdict rests on, when a single one grounds it"
    )
    confidence: Literal["low", "medium", "high"] | None = Field(
        default=None, description="How firm the verdict is; omit for a plain, uncontested fact"
    )
    confidence_reason: str | None = Field(
        default=None,
        description=(
            "Why confidence is not high, e.g. a Land-specific deviation or a missing input — "
            "omit when confidence is high or absent"
        ),
    )


class ConditionBranch(BaseModel):
    """One branch of a condition tree: a case and the answer that holds under it."""

    condition: str = Field(min_length=1, description="The case this branch covers, e.g. 'GK 1–3'")
    outcome: str = Field(min_length=1, description="The answer that applies when the condition holds")
    active: bool | None = Field(
        default=None,
        description="True for the branch that matches the CURRENT project; omit when it is not known which applies",
    )
    reference: NormReference | None = Field(
        default=None, description="The norm grounding this branch's outcome, when branches cite different sources"
    )


class ConditionTreeCard(BaseModel):
    """A decision tree (Bedingungsbaum) for an answer that turns on one factor.

    Emit for the domain's most common answer shape — 'it depends on the
    Gebäudeklasse'. `question` names the deciding factor; each branch pairs a
    case with its outcome, and the branch matching the current project is
    marked `active`. Exactly the structure that otherwise becomes nested prose
    the reader has to re-collapse into a table in their head.
    """

    type: Literal["condition_tree"]
    title: str = Field(min_length=1, description="Title, e.g. 'Erforderliche Feuerwiderstandsklasse'")
    question: str = Field(min_length=1, description="The factor the answer depends on, e.g. 'Gebäudeklasse'")
    branches: list[ConditionBranch] = Field(min_length=1, description="The cases and their outcomes, in reading order")
    reference: NormReference | None = Field(default=None, description="Overall source when the branches share one")


class TypedColumn(BaseModel):
    """One column of a typed table, declaring how its cells are rendered."""

    label: str = Field(min_length=1, description="Column header, e.g. 'Bauteil', 'Mindestmaß'")
    # NOTE: named `type` per the card spec even though the catalog renderer skips
    # a field called `type` (it is the union discriminator everywhere else). The
    # worked example carries the full shape, so the model still sees the field;
    # renaming it would diverge from the documented wire contract.
    type: Literal["mass", "norm", "verdict", "date", "text"] = Field(
        description=(
            "How the frontend renders this column's cells: 'mass' (a dimension — right-aligned, tabular-nums), "
            "'date' (right-aligned, tabular-nums), 'verdict' (a pass/fail-style status — a chip), 'norm' (a norm "
            "reference — emphasised), or 'text' (plain left-aligned prose)"
        )
    )


class TypedTableCard(BaseModel):
    """A generic table whose columns declare their type so cells render right.

    Emit for a tabular answer no purpose-built card covers — one card for the
    long tail instead of a bespoke type per table. Each column names its `type`
    so the frontend right-aligns measurements and dates, renders a verdict as a
    status chip and a norm as emphasised, rather than every cell as flat text.
    """

    type: Literal["typed_table"]
    title: str = Field(min_length=1, description="Title, e.g. 'Mindestmaße barrierefreie Erschließung'")
    columns: list[TypedColumn] = Field(min_length=1, description="Column definitions, left-to-right")
    rows: list[list[str]] = Field(
        description="Each row is one cell value per column, as strings, in the same order as `columns`"
    )
    reference: NormReference | None = Field(default=None, description="Source grounding the table's values")
    note: str | None = Field(default=None, description="Optional clarification")

    @model_validator(mode="after")
    def _square_rows(self) -> "TypedTableCard":
        """Pad short rows with '' and truncate long ones to the column count.

        Mirrors ComparisonTableCard: LLM output occasionally mismatches the
        row/column count, and an empty cell is honest ('no value given') while
        dropping the whole card would lose every other row with it.
        """
        n = len(self.columns)
        for i, row in enumerate(self.rows):
            if len(row) < n:
                self.rows[i] = row + [""] * (n - len(row))
            elif len(row) > n:
                self.rows[i] = row[:n]
        return self


class NormChainLink(BaseModel):
    """One link in a norm hierarchy, with the rank that sets its visual weight."""

    label: str = Field(min_length=1, description="The norm's name, e.g. 'OIB-Richtlinie 2', 'ÖNORM B 1600'")
    # The AGENT's declared classification FOR DISPLAY, not a norm_registry
    # lookup: the first three ranks match NormRank in common/norm_registry.py,
    # the last three are display distinctions the registry folds into
    # 'norm_extern'/'behoerdliche_info'. The renderer weights binding ranks
    # heavier than interpretive ones — the whole point of the card.
    rank: Literal["bundesgesetz", "landesgesetz", "verordnung", "oib_richtlinie", "oenorm", "leitfaden"] = Field(
        description=(
            "The link's classification for display: 'bundesgesetz', 'landesgesetz' and 'verordnung' bind; "
            "'oib_richtlinie' binds where a Land has declared it; 'oenorm' and 'leitfaden' interpret. Drives "
            "the binding-vs-interpretive weight in the render — the agent's own classification, not a lookup"
        )
    )
    note: str | None = Field(
        default=None, description="What this link contributes to the chain, e.g. 'verweist auf die ÖNORM B 1600'"
    )


class NormChainCard(BaseModel):
    """The norm hierarchy (Normenkette) for this answer, binding vs interpretive.

    Emit when the answer rests on a CHAIN of norms rather than a single one — a
    Landesgesetz that declares an OIB-Richtlinie that points at an ÖNORM. Drawn
    top-to-bottom with a visible weight difference between what binds
    (Bundes-/Landesgesetz, Verordnung, a declared OIB-Richtlinie) and what
    interprets (ÖNORM, Leitfaden) — a trust artifact prose cannot show at a
    glance.
    """

    type: Literal["norm_chain"]
    title: str = Field(min_length=1, description="Title, e.g. 'Normenkette – Absturzsicherung'")
    links: list[NormChainLink] = Field(min_length=1, description="The chain top-to-bottom, most binding first")


# ── Generic answer-polish cards ──────────────────────────────────────────────
# The two types that carry no domain at all: they fit ANY answer, which is what
# the fifteen schematics and the four answer-shape cards cannot do. A question
# that draws no stair and forks on no Gebäudeklasse still has two or three
# points the reader has to leave with, and usually one sentence that changes
# what they do next — and both of those are currently prose the reader has to
# find for themselves.


class KeyTakeaway(BaseModel):
    """One takeaway: the line the reader leaves with, plus the detail behind it."""

    text: str = Field(
        min_length=1,
        description="The takeaway as ONE scannable line, e.g. 'Fluchtniveau 9,80 m → Gebäudeklasse 4'",
    )
    detail: str | None = Field(
        default=None,
        description=(
            "One or two sentences revealed when the reader expands this takeaway — the derivation, "
            "the caveat or the exception behind it. Never a restatement of `text`; omit if there is nothing to add"
        ),
    )


class KeyTakeawaysCard(BaseModel):
    """Emit for the two to five points the reader must take away from any answer.

    The generic upgrade over a markdown bullet list, and the one card that fits
    an answer with no diagram and no fork in it. Each takeaway is its own
    numbered line, so a reader who skims the card leaves with the same answer as
    one who reads the prose. A `detail` rides folded behind its takeaway and
    opens on click — the qualification survives without costing the block its
    scannability.
    """

    type: Literal["key_takeaways"]
    title: str | None = Field(
        default=None,
        description="Optional headline, e.g. 'Gebäudeklasse 4 – das Wichtigste'; omit to let the takeaways stand alone",
    )
    items: list[KeyTakeaway] = Field(
        min_length=2,
        max_length=5,
        description="The takeaways, most important first. Two to five — one is a sentence, six is the answer again",
    )


class CalloutCard(BaseModel):
    """Emit for the single caveat, deadline or tip that must not drown in a paragraph.

    One framed remark, deliberately small and domain-free. `kind` sets the tone
    AND is printed as a word ('Hinweis', 'Achtung', 'Frist', 'Tipp'), so the
    signal survives for a reader who cannot separate the colours. Use at most
    one per answer: inside a paragraph the sentence that changes what the reader
    DOES reads at the same weight as the sentence beside it, and a second
    callout puts both back at that weight.
    """

    type: Literal["callout"]
    kind: Literal["hinweis", "achtung", "frist", "tipp"] = Field(
        description=(
            "What kind of remark this is: 'hinweis' (something easily missed), 'achtung' (a risk or a "
            "requirement that is easy to get wrong), 'frist' (a deadline or a period that runs), "
            "'tipp' (a recommendation that is not required)"
        )
    )
    text: str = Field(
        min_length=1,
        description="The remark itself, one or two sentences — the part that changes what the reader does",
    )
    title: str | None = Field(
        default=None, description="Optional short headline, e.g. 'Gilt nur in Wien'; omit when `text` says it already"
    )
    detail: str | None = Field(
        default=None,
        description=(
            "Optional background revealed when the reader expands the callout — the exception, the "
            "source or the consequence. Omit rather than padding the remark out"
        ),
    )


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
    """Project/Büroarchiv files the user asked to see.

    System-emitted by ``surface_documents``. One file or a short browse
    choice — same card, the list length is the difference. Never a
    catalogue. Citations of exactly one project/Büro file peek without
    this card (``useCitationPeek``).
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

    EXACTLY ONE of ``match`` or ``global_ids`` — never both, never neither.
    (Stated here because the rendered card catalogue lists a model's fields
    from ``model_fields`` and never sees a ``model_validator``: both selectors
    therefore appear as plain optionals, and the worked example — one group of
    each kind — reads as permission to supply both. A highlight that does is
    dropped, taking its whole card with it.)

    Prefer ``match`` whenever the
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
            "IFC GlobalIds returned by ifc_query OR by ifc_measure. NEVER invent these — an id you did "
            "not see is a wrong answer. Use for a handful of elements the answer names; use 'match' for "
            "a set. When the answer came from a MEASUREMENT, the ids to highlight are the ones the "
            "measurement itself names: every ifc_measure answer ends with a 'Bezug:' line listing exactly "
            "the elements the number was derived from, and highlighting those shows the user the thing "
            "that was measured rather than a description of it."
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
    and Brandabschnittsgrößen are not in it at all.
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


class IfcModelPickerCard(BaseModel):
    """A clickable list of the project's IFC models — pick one to open in the viewer.

    Emit for "zeig mir das Modell" / "welches Modell" when the user wants to SEE
    or OPEN the building and the project may hold several models. The old answer
    to that was a prose bullet list of file names the user had to read and retype;
    this card renders each model as a tile that opens the BIM viewer on click,
    client-side, with no second turn.

    It carries only WHICH view to offer — never a list of file names. The renderer
    reads the project's actual models from the live model list (the same source
    the viewer resolves against), so the model here cannot name a file that does
    not exist: there is nothing to invent. An empty project renders nothing and
    the written answer stands on its own, which is the fail-open the prose gave.
    """

    type: Literal["ifc_model_picker"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Welches Modell möchten Sie öffnen?'")
    note: str | None = Field(default=None, description="Optional one-line clarification under the tiles")


GridCard = (
    SummaryCard
    | LegalBasisCard
    | ProjectProfilePatchCard
    | RequirementChecklistCard
    | ComparisonTableCard
    | VerdictHeaderCard
    | ConditionTreeCard
    | TypedTableCard
    | NormChainCard
    | KeyTakeawaysCard
    | CalloutCard
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
    | IfcModelPickerCard
)

# Discriminated-union adapter — the canonical validator for a raw card dict.
grid_card_adapter = TypeAdapter(Annotated[GridCard, Field(discriminator="type")])

__all__ = [
    "CalloutCard",
    "ChecklistItem",
    "ComparisonRow",
    "ComparisonTableCard",
    "ConditionBranch",
    "ConditionTreeCard",
    "DocumentGridCard",
    "GridCard",
    "IfcHighlight",
    "IfcViewerCard",
    "IfcComplianceCard",
    "IfcScheduleCard",
    "IfcElementCard",
    "IfcDiffCard",
    "IfcModelPickerCard",
    "KeyTakeaway",
    "KeyTakeawaysCard",
    "LegalBasisCard",
    "MemoryProposalCard",
    "NormChainCard",
    "NormChainLink",
    "SurfacedDocument",
    "ProjectProfilePatchCard",
    "ProjectProfilePatchOperation",
    "ProjectProfilePatchPreviewItem",
    "RequirementChecklistCard",
    "SummaryCard",
    "TypedColumn",
    "TypedTableCard",
    "VerdictHeaderCard",
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
