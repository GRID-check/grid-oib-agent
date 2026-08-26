"""Pydantic models for Grid response cards.

## Every text field on every card is PLAIN TEXT

No card renderer parses markup. The frontend sets each string into JSX, where
React escapes it, so a field that arrives holding ``[OIB-Richtlinie ansehen](
https://www.oib.or.at/de/oib-richtlinien)`` puts those brackets on screen — next
to the card's own working source link, which is what a production ``legal_basis``
card did. The contract was never written down anywhere, which is why the model
could not be said to have broken it.

It is written down here, and :class:`CardModel` enforces it: the delimiters are
removed at validation time, on every emission path, so a card cannot display raw
markup. The enforcement deliberately does NOT live in the renderer. A card is the
part that gets screenshotted into an Einreichung; a renderer that quietly parses
markdown in a field nobody declared as markdown would hand the model a way to put
an arbitrary link, or emphasis the schema never sanctioned, into a legal
citation. Flattening on the way in removes the markup without ever granting that
power.
"""

import re
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

# The three inline constructs that are UNAMBIGUOUSLY markup: a link or image
# target, a doubled emphasis delimiter, and a code span. Each is meaningless as
# literal text in an Austrian legal citation, and each is something an LLM writes
# into a JSON string without noticing that the string is not prose.
#
# What is deliberately NOT here is the ambiguous half of markdown. Single `*`
# and `_` emphasis, a leading `- ` or `#`, and `<https://…>` autolinks all occur
# for their own reasons in the text these fields carry — footnote markers in an
# OIB table, a dash inside „§ 3 - Abs. 1“, a heading character in a Bescheid
# reference. `original_text` is documented as a LITERAL excerpt from the source,
# and mangling a verbatim legal quotation is a worse defect than an asterisk.
# Doubled delimiters have no such second reading, which is why the line is drawn
# there rather than at "everything CommonMark would call emphasis".
_MD_LINK = re.compile(r"!?\[([^\]\n]*)\]\(\s*<?([^)\s]*)>?(?:\s+\"[^\"\n]*\")?\s*\)")
_MD_STRONG = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", re.DOTALL)
_MD_CODE = re.compile(r"`+([^`\n]+)`+")


def _unwrap_link(match: re.Match[str]) -> str:
    """Render a markdown link as the text a reader would have seen, plus its target.

    The URL is KEPT, as literal text. Dropping it would be the one thing a
    sanitiser of a legal citation must not do — silently delete part of what the
    citation asserted — and keeping it as text is not a link: nothing downstream
    turns a bare URL in a card field into an anchor. So the reader loses the
    brackets and nothing else.
    """
    label = match.group(1).strip()
    target = match.group(2).strip()
    if not target or target == label:
        return label
    if not label:
        return target
    return f"{label} ({target})"


def flatten_card_markup(value: str) -> str:
    """Strip inline markdown delimiters from one card text value.

    Idempotent, and a no-op on text that carries no markup — which is almost all
    of it, so the common case costs three failed regex scans.
    """
    flattened = _MD_LINK.sub(_unwrap_link, value)
    flattened = _MD_STRONG.sub(lambda m: m.group(2), flattened)
    return _MD_CODE.sub(lambda m: m.group(1), flattened)


def _flatten_markup_deep(value: Any) -> Any:
    """Apply :func:`flatten_card_markup` to a string, or to the strings in a list.

    Recurses through lists because ``TypedTableCard.rows`` is ``list[list[str]]``
    — a table cell is as much on-screen text as a title is. Nested card models
    are left alone here: they are :class:`CardModel` subclasses and have already
    flattened their own fields by the time the parent validates. Anything else
    (numbers, enums, dicts) passes through untouched.
    """
    if isinstance(value, str):
        return flatten_card_markup(value)
    if isinstance(value, list):
        return [_flatten_markup_deep(item) for item in value]
    return value


class CardModel(BaseModel):
    """Base for every card and every building block inside one.

    Carries the plain-text guarantee described in the module docstring, in the
    one place that covers all of it: a wildcard field validator, inherited by
    every subclass, so a card type added next sprint is covered by BEING a card
    rather than by someone remembering to annotate its fields. There are 177
    free-text fields across 71 models here; an ``Annotated[str, …]`` per field
    would be 177 chances to forget one.

    It runs on EVERY emission path, because all of them go through
    ``grid_card_adapter`` or :func:`validate_cards` — the ``emit_card`` tool, the
    post-hoc batch generator, the shallow-researcher DSML path, project memory
    and surfaced documents. Identifier-shaped fields (IFC GlobalIds, model file
    names, JSON-pointer paths) inherit it too and are unaffected: none of the
    three constructs can occur in one.
    """

    @field_validator("*", mode="after")
    @classmethod
    def _flatten_text_markup(cls, value: Any) -> Any:
        return _flatten_markup_deep(value)


class SummaryCard(CardModel):
    """A concise overview of the answer for the user."""

    type: Literal["summary"]
    title: str = Field(min_length=1, description="Short title for the summary card")
    content: str | None = Field(default=None, description="One-paragraph summary")
    key_points: list[str] | None = Field(default=None, description="Bullet points highlighting key facts")


class LegalBasisCard(CardModel):
    """A legal norm, regulation, or OIB Richtlinie that grounds the answer.

    ## Why `lane` is a lane key and not `'oib' | 'law'`

    The card paints the OIB accent (``--source-oib``) rather than the generic
    law blue for an OIB-Richtlinie, because OIB and RIS are the two tiers
    architects compare most often. The frontend decides that in exactly one
    place, ``accentForLane`` (``features/chat/lib/source-kinds.ts``), and that
    helper takes a FINE LANE KEY — the same vocabulary ``norm_registry
    .lane_for_hit`` stamps on every retrieved chunk and every citation chip.

    So this field carries lane keys verbatim. A parallel ``'oib' | 'law'``
    vocabulary would read as the accent it resolves TO, and would need a second
    mapping on the frontend to be usable — which is the drift ``accentForLane``
    exists to prevent, and would let this card and the "Belegt durch" chips
    disagree about the same document.

    Only the two tiers the card actually renders are offered; every other lane
    ``lane_for_hit`` can produce normalises onto them or onto None (see
    :meth:`_normalise_lane`).
    """

    type: Literal["legal_basis"]
    law: str = Field(min_length=1, description="Name of the law, regulation, or OIB Richtlinie")
    lane: Literal["baurecht_oib", "baurecht_ris"] | None = Field(
        default=None,
        description=(
            "Which tier of Baurecht this citation is. "
            '"baurecht_oib" for an OIB-Richtlinie, -Leitfaden or -Erläuterung; '
            '"baurecht_ris" for a Gesetz or Verordnung published in RIS (Bauordnung, '
            "Bautechnikverordnung, Bundes-/Landesgesetz). The name you just wrote in `law` almost "
            "always decides it, so fill it in whenever you can name the source at all — leaving it "
            "out costs the card its accent. Omit it ONLY when the citation is genuinely neither: an "
            "ÖNORM, a Bescheid, an Erlass, or a document you cannot place. Never guess a tier — the "
            "card claims an authority off this field, and this is the citation an architect verifies."
        ),
    )
    edition: str | None = Field(
        default=None,
        description=(
            "Ausgabe of the cited document, copied verbatim, e.g. 'Ausgabe Mai 2023'. „OIB-Richtlinie "
            "2“ without its Ausgabe is not verifiable, so supply it whenever the source states one. "
            "Omit it when the source states none (most Gesetze carry a Fassung, not an Ausgabe) or "
            "when you did not see it: an invented Ausgabe makes an unverifiable citation look verified."
        ),
    )
    article: str | None = Field(default=None, description="Relevant article or paragraph number")
    section: str | None = Field(default=None, description="Relevant section or chapter")
    summary: str | None = Field(default=None, description="Plain-language summary of the legal relevance")
    original_text: str | None = Field(default=None, description="Literal excerpt from the source, if available")

    @field_validator("lane", mode="before")
    @classmethod
    def _normalise_lane(cls, value: Any) -> Any:
        """Fold any real lane key onto the two rendered tiers, unknown onto None.

        ``lane_for_hit`` produces thirteen lane keys and the model is shown two,
        so a plausible near-miss (``baurecht_land``, ``baurecht_oib_leitfaden``)
        must not cost the whole card. This is the product's proof-of-work card:
        rejecting it over an optional *display* field would drop the proof, not
        the field.

        Anything that is not authoritative Baurecht folds to None and renders
        neutral — the pre-schema rendering, so an absent lane is a no-op rather
        than a hole. ``baurecht_basis`` is excluded by name even though it
        carries the ``baurecht`` prefix: it is the default lane of a document
        nobody has classified, and letting it inherit the RIS tier is exactly
        the failure ``authorityTag`` is written to avoid — an unclassified
        upload claiming to be an Austrian legal source, the strongest provenance
        claim this product can make.
        """
        if value is None:
            return None
        key = str(value).strip().lower()
        if key.startswith("baurecht_oib"):
            return "baurecht_oib"
        if key == "baurecht_basis":
            return None
        if key.startswith("baurecht"):
            return "baurecht_ris"
        return None


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


class ProjectProfilePatchOperation(CardModel):
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


class ProjectProfilePatchPreviewItem(CardModel):
    """A before/after preview for a single patched field."""

    label: str
    before: str
    after: str


class ProjectProfilePatchCard(CardModel):
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


class MemoryProposalCard(CardModel):
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


class NormReference(CardModel):
    """A verifiable pointer into a regulation (the atom of grounding).

    Every required value MUST carry one so the architect can verify it against
    the source. Never fabricate a reference.
    """

    document: str = Field(min_length=1, description="Regulation name, e.g. 'OIB-Richtlinie 2', 'ÖNORM B 1600'")
    section: str | None = Field(default=None, description="Clause/table, e.g. 'Pkt. 5.1.1', 'Tabelle 1b'")
    edition: str | None = Field(default=None, description="Edition/year, e.g. 'Ausgabe Mai 2023'")
    excerpt: str | None = Field(default=None, description="Literal quoted sentence grounding the value (<= ~200 chars)")


class DimensionCheck(CardModel):
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


class SectionStorey(CardModel):
    """One storey in a building cross-section, drawn as a band to scale."""

    label: str = Field(min_length=1, description="Storey label, e.g. 'EG', '1.OG', 'KG'")
    height_m: float = Field(gt=0, description="Clear storey height in metres (drawn to scale)")
    below_grade: bool = Field(default=False, description="True for basements/underground storeys")


class SectionMarker(CardModel):
    """A horizontal reference line at a given height in the section."""

    label: str = Field(min_length=1, description="What the line marks, e.g. 'Fluchtniveau', 'GK4-Grenze'")
    height_m: float = Field(description="Height above ground datum in metres")
    kind: Literal["fluchtniveau", "threshold", "reference"] = Field(default="reference", description="Styling role")


class SetbackSide(CardModel):
    """A required distance from the building footprint to one parcel edge."""

    side: Literal["front", "back", "left", "right"] = Field(description="Which edge")
    required_m: float = Field(description="Required setback in metres (OIB/Bauordnung)")
    actual_m: float | None = Field(default=None, description="Actual distance in metres; null if unknown")
    status: DimStatus = Field(description="Verdict for this side")


class EgressSegment(CardModel):
    """One straight run of an escape path, drawn end-to-end with the next."""

    label: str = Field(min_length=1, description="Segment label, e.g. 'Raum → Gang', 'Gang → Treppenhaus'")
    length_m: float = Field(gt=0, description="Run length in metres (drawn to scale)")
    turn: Literal["straight", "left", "right"] = Field(default="straight", description="Turn AFTER this run")


# ── Schematic cards ──────────────────────────────────────────────────────────


class BuildingSectionCard(CardModel):
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


class StairDiagramCard(CardModel):
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


class DimensionDiagramCard(CardModel):
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


class SetbackPlanCard(CardModel):
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


class EgressDiagramCard(CardModel):
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


class Obstruction(CardModel):
    """An object blocking daylight (opposing building, own projection)."""

    distance_m: float = Field(gt=0, description="Horizontal distance from the window in metres")
    height_m: float = Field(description="Height of the obstruction above the window sill in metres")
    label: str = Field(min_length=1, description="What it is, e.g. 'Gegenüberliegendes Gebäude'")


class DaylightIncidenceCard(CardModel):
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


class GuardrailCheckCard(CardModel):
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


class DensityCheckCard(CardModel):
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


class AufstellflaechePlan(CardModel):
    """The fire-brigade Aufstellfläche geometry."""

    width: DimensionCheck = Field(description="Aufstellfläche width (m)")
    length: DimensionCheck = Field(description="Aufstellfläche length (m)")
    distance_to_facade: DimensionCheck | None = Field(default=None, description="Distance to the facade (m)")


class FireAccessPlanCard(CardModel):
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


class AcousticCheckItem(CardModel):
    """One sound-insulation check between two building parts."""

    path_label: str = Field(min_length=1, description="What is separated, e.g. 'Wohnungstrennwand Top 3/Top 4'")
    metric: Literal["DnTw", "LnTw", "Rw_res"] = Field(description="Airborne / impact / resulting metric")
    check: DimensionCheck = Field(description="Measured vs required in dB (comparator differs by metric)")
    reference: NormReference = Field(description="Source of the dB limit (OIB 5 / ÖNORM B 8115-2)")


class AcousticCheckCard(CardModel):
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


class FireCompartment(CardModel):
    """One Brandabschnitt (fire compartment) drawn as a band, area-checked."""

    label: str = Field(min_length=1, description="Compartment name, e.g. 'BA 1 – Wohnungen OG'")
    area: DimensionCheck = Field(description="Brandabschnittsfläche (m²) vs the max permitted (comparator '<=')")
    use: str | None = Field(default=None, description="Nutzung, e.g. 'Wohnen', 'Büro', 'Tiefgarage'")


class FireCompartmentCard(CardModel):
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


class EnvelopeComponent(CardModel):
    """One thermal-envelope component with its U-value checked against a limit."""

    label: str = Field(min_length=1, description="Component, e.g. 'Außenwand', 'Dach', 'Fenster'")
    kind: Literal["wall", "roof", "floor", "window", "door"] = Field(description="Where it sits in the section")
    u_value: DimensionCheck = Field(description="U-Wert W/(m²K) vs the max U-value (lower is better, '<=')")


class ThermalEnvelopeCard(CardModel):
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


class EnergyPerformanceCard(CardModel):
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


class ElevatorRequirementCard(CardModel):
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


class ParkingRequirementCard(CardModel):
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


class ChecklistItem(CardModel):
    """One requirement in a checklist, with its verdict and grounding."""

    label: str = Field(min_length=1, description="The requirement, e.g. 'Zweiter Fluchtweg vorhanden'")
    status: DimStatus = Field(description="Verdict for this requirement")
    detail: str | None = Field(default=None, description="Short explanation or the relevant measured value")
    reference: NormReference | None = Field(default=None, description="Where this requirement comes from")


class RequirementChecklistCard(CardModel):
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


class ComparisonRow(CardModel):
    """One criterion compared across the options (one value per option)."""

    label: str = Field(min_length=1, description="Criterion, e.g. 'max. Brandabschnittsfläche'")
    values: list[str] = Field(min_length=1, description="One value per option, same order as `options`")
    highlight_index: int | None = Field(
        default=None, ge=0, description="0-based index of the option favoured on this criterion, if any"
    )


class ComparisonTableCard(CardModel):
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


class VerdictHeaderCard(CardModel):
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


class ConditionBranch(CardModel):
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


class ConditionTreeCard(CardModel):
    """A decision tree (Bedingungsbaum) for an answer that turns on one factor.

    Emit for the domain's most common answer shape — 'it depends on the
    Gebäudeklasse'. `question` names the deciding factor; each branch pairs a
    case with its outcome, and the branch matching the current project is
    marked `active`. Exactly the structure that otherwise becomes nested prose
    the reader has to re-collapse into a table in their head.

    THE CASES MUST BE MUTUALLY EXCLUSIVE. A fork means the project sits in
    exactly one of them, which is why at most one branch may be `active` and why
    the renderer writes the active outcome as 'für dieses Projekt gilt'. Rows
    that are all true at once — the fire resistance of the topmost storey AND of
    the other storeys AND of the basement, which are three parts of the same
    building rather than three cases of one project — are a `typed_table`, not a
    tree.
    """

    type: Literal["condition_tree"]
    title: str = Field(min_length=1, description="Title, e.g. 'Erforderliche Feuerwiderstandsklasse'")
    question: str = Field(min_length=1, description="The factor the answer depends on, e.g. 'Gebäudeklasse'")
    branches: list[ConditionBranch] = Field(min_length=1, description="The cases and their outcomes, in reading order")
    reference: NormReference | None = Field(default=None, description="Overall source when the branches share one")

    @model_validator(mode="after")
    def _at_most_one_active_branch(self) -> "ConditionTreeCard":
        """Reject a tree that marks more than one case as the project's own.

        Observed in the field: 'Feuerwiderstandsklasse in GK 4' came back with
        all three branches `active` — oberstes Geschoß R 60, sonstiges Geschoß
        R 60, unterirdisches Geschoß R 90 und A2 — and the opened one read 'FÜR
        DIESES PROJEKT GILT: R 60'. Three simultaneous answers, each claiming to
        be the one that applies. That looks like a decision was made when none
        was, which is worse than no card, and nothing anywhere stopped it.

        The message is written to be ACTED ON rather than merely understood:
        `emit_card` feeds a validation error back to the model, and the useful
        half is not 'this is invalid' but which card the content actually wants.
        """
        active = [b.condition for b in self.branches if b.active is True]
        if len(active) > 1:
            raise ValueError(
                "a condition_tree marks at most ONE branch active, because a fork means the project sits in "
                f"exactly one case — {len(active)} were marked ({', '.join(active)}). If those rows are all "
                "true at the same time (different parts of one building, not different cases of one project), "
                "this is not a fork: re-emit it as a typed_table whose columns name the distinguishing feature, "
                "the requirement and the Fundstelle. If it IS a fork, mark only the case that applies, or leave "
                "every branch unmarked when the conversation has not established which one does."
            )
        return self


class TypedColumn(CardModel):
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


# The opening line of this docstring IS the always-on L1 index entry
# (`catalog.render_card_index` takes the first line and nothing else), so it is
# written as an imperative in the same register as `process_map`, `callout` and
# `key_takeaways`. It read as pure description — "A generic table whose columns
# declare their type so cells render right" — while being the card TWO doctrine
# rows and the `condition_tree` docstring both redirect to. A redirect only lands
# if the destination says "emit me" as loudly as the card doing the redirecting;
# the field case was an answer that took `condition_tree` because that card's
# shape was already in context and its own line told the model to emit it.
class TypedTableCard(CardModel):
    """Emit for rows that are all true at once, and for any table no card covers.

    Rows that hold SIMULTANEOUSLY — the topmost storey AND the other storeys AND
    the basement, three parts of one building rather than three cases of one
    project — belong here and not in a `condition_tree`, whose branches are
    mutually exclusive. This is also the long tail: a tabular answer no
    purpose-built card covers gets this one card instead of a bespoke type per
    table. Each column names its `type` so the frontend right-aligns measurements
    and dates, renders a verdict as a status chip and a norm as emphasised,
    rather than every cell as flat text.
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


class NormChainLink(CardModel):
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


class NormChainCard(CardModel):
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


class KeyTakeaway(CardModel):
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


class KeyTakeawaysCard(CardModel):
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


class CalloutCard(CardModel):
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


class FollowUp(CardModel):
    """One next question, written out in full so it can be sent as it stands."""

    question: str = Field(
        min_length=1,
        description=(
            "The next question as a COMPLETE, sendable sentence in the answer's language — this exact "
            "text lands in the composer, so 'Wie wird das Fluchtniveau gemessen?' works and a topic "
            "label like 'Fluchtniveau' does not. Name something this answer introduced: a term it "
            "defined, a value it gave, a caveat it raised"
        ),
    )
    hint: str | None = Field(
        default=None,
        description=(
            "Optional half-line saying what asking this would get the reader, e.g. 'Messpunkt und "
            "Bezugsebene'. Shown only as a tooltip — never the question itself, and omit it rather "
            "than restating the question in other words"
        ),
    )


class FollowUpsCard(CardModel):
    """Emit at the END of an answer: the two to four questions this answer just made askable.

    The reader who now knows what a Fluchtniveau is has a next question and no
    phrasing for it; each item renders as a chip that PREFILLS the composer, so
    the way forward costs a click instead of a paragraph of typing. Nothing is
    sent on click — the reader still edits and presses send — so the card
    suggests, it never asks on their behalf.

    What makes the set work is anchoring and spread: every question must name
    something THIS answer introduced (a term it defined, a number it gave, an
    exception it raised), and the set must cover different KINDS of next step —
    narrowing to this project, going a level deeper on a rule just named,
    comparing the alternative, moving toward the next action. Four rephrasings
    of one question is one question. A generic 'Erzähl mir mehr' is worse than
    no card at all: it teaches the reader the chips are decoration, and then
    they stop reading them.
    """

    type: Literal["follow_ups"]
    title: str | None = Field(
        default=None,
        description="Optional headline, e.g. 'Weiterführende Fragen'; omit to let the questions stand alone",
    )
    items: list[FollowUp] = Field(
        min_length=2,
        max_length=4,
        description=(
            "The next questions, most useful first. Two to four — one chip is not a set of options, "
            "five is a menu the reader has to read instead of an offer they can take"
        ),
    )


# ── The derivation, and the procedure ────────────────────────────────────────
# Two shapes an OIB answer takes constantly and that had no card, so they were
# written as prose: the arithmetic that produced a number, and the ordered
# procedure a project moves through.
#
# `calculation` is the one card where the MODEL MUST NOT SUPPLY THE ANSWER. It
# supplies operands, an operation and (optionally) the limit; the renderer
# evaluates every step, propagates the tolerance band, formats to Austrian
# convention and derives the verdict. This is the same invariant the fifteen
# schematics are built on — the renderer draws to scale and does the geometry
# itself, so a card cannot show a diagram that disagrees with its own numbers —
# and it matters more here, because a Rechenweg whose stated result disagrees
# with its own operands is the artefact that gets screenshotted into an
# Einreichung.
#
# There is deliberately NO expression string and no formula field. A general
# evaluator would let the model write arbitrary arithmetic that the renderer
# must then parse and trust; parsing it back is how the renderer ends up
# re-deriving the model's intent, and the first ambiguous parse (precedence,
# a unit inside the expression, a stray parenthesis) puts a wrong number on the
# card with full confidence. A closed set of five operations cannot be
# mis-parsed because there is nothing to parse.


CalculationOperation = Literal["sum", "product", "quotient", "percent_of", "percent_ratio"]
"""The five closed operation shapes a Rechenweg is allowed to take.

Each is ONE formula the renderer evaluates directly. They were chosen against
the arithmetic that actually appears in Austrian Baurecht answers, not against
what an expression grammar would cover:

    sum           Σ factorᵢ · valueᵢ   Schrittmaßregel (2 × 17 + 30), Gehweglänge,
                                       Gesamthöhe, a Restbreite (negative factor)
    product       Π valueᵢ             Stellplatzbedarf (14 WE × 1,0), an area
    quotient      v₁ ÷ v₂              GFZ (BGF ÷ Grundfläche), Brandlast je m²,
                                       U = 1 ÷ R (numerator 1)
    percent_of    v₁ · v₂ ÷ 100        erforderliche Lichteintrittsfläche (10 % der
                                       Bodenfläche), Grünflächenanteil
    percent_ratio v₁ ÷ v₂ · 100        Bebauungsgrad, Rampenneigung — the result is a
                                       percentage and the renderer prints '%' for it

Anything more composite is expressed as SEVERAL steps, with a later step
referencing an earlier one's result (:attr:`CalculationOperand.step`).
"""


class CalculationOperand(CardModel):
    """One number entering a step of the derivation, with where it came from.

    Either a literal ``value`` or a reference to an earlier ``step`` — never
    both, because a stated value beside a reference is two answers to the same
    question and the renderer would have to pick one.

    Carries the same provenance vocabulary as :class:`DimensionCheck`, for the
    same reason: a derived number is only as honest as its inputs, and a
    Schrittmaß computed from a measurement of ours is our claim, not the
    architect's. The renderer propagates every band it is given into the result,
    so a tolerance dropped here is a tolerance dropped from the answer.
    """

    label: str = Field(
        description=(
            "What this number IS, e.g. 'Steigung', 'Bruttogeschossfläche', 'Grundfläche'. Empty ONLY for a "
            "bare constant that names itself, such as the 1 in a U-value's 1 ÷ R — everything a reader "
            "has to look up needs its name under it"
        ),
    )
    value: float | None = Field(
        default=None,
        description=(
            "The number itself. Leave null when it is not known — the renderer then shows the step as "
            "undecidable instead of a result, which is the honest outcome. Must be null when `step` is set"
        ),
    )
    unit: str | None = Field(
        default=None,
        description="Unit of this operand, e.g. 'cm', 'm²', 'MJ'; omit for a bare count or a ratio",
    )
    factor: float | None = Field(
        default=None,
        description=(
            "Only on a 'sum': the RULE's own multiplier for this term, e.g. 2 in the Schrittmaßregel "
            "'2 × Steigung + Auftritt'. Negative subtracts the term. Omit for a plain +1 — never use it "
            "to smuggle a second measured quantity in, which is what a 'product' step is for"
        ),
    )
    step: int | None = Field(
        default=None,
        description=(
            "Instead of a value: the 1-based index of an EARLIER step whose result this operand is. "
            "Must point strictly backwards. With this set, leave value, unit, provenance and tolerance "
            "null — the renderer takes them from the step it names"
        ),
    )
    provenance: Provenance | None = Field(
        default=None,
        description=(
            "Where `value` came from, copied from the ifc_measure answer's own provenance: 'declared' "
            "(the IFC file states it), 'computed' (we measured it off the geometry), 'inferred' (a "
            "heuristic). Leave null for a figure the user typed or a limit read out of the Bestimmung. "
            "NEVER guess it"
        ),
    )
    tolerance: float | None = Field(
        default=None,
        ge=0,
        description=(
            "The ± band on `value`, in the SAME unit — copied from the ifc_measure answer, and only "
            "meaningful with provenance 'computed'. The renderer propagates it through every following "
            "step, so this is what decides whether the derived result is genuinely on one side of a limit"
        ),
    )
    source: str | None = Field(
        default=None,
        description=(
            "Optional half-line naming WHERE the figure is written down, e.g. 'Einreichplan, Schnitt A-A' "
            "or 'Bebauungsplan PD 8123'. Revealed when the reader expands the derivation's sources"
        ),
    )

    @model_validator(mode="after")
    def _reference_or_value(self) -> "CalculationOperand":
        if self.step is not None:
            if self.step < 1:
                raise ValueError("`step` is a 1-based index of an earlier step")
            if any(x is not None for x in (self.value, self.unit, self.provenance, self.tolerance)):
                raise ValueError("an operand referencing a step carries no value, unit, provenance or tolerance")
        return self


class CalculationStep(CardModel):
    """One line of the Rechenweg: an operation over its operands.

    The step states no result. The renderer evaluates ``operation`` over
    ``operands`` and prints what it computed — which is the whole point of the
    card, so there is no field here for the model to disagree with it in.
    """

    label: str = Field(min_length=1, description="What this step computes, e.g. 'Schrittmaß', 'Geschossflächenzahl'")
    operation: CalculationOperation = Field(
        description=(
            "Which of the five shapes this step is: 'sum' (Σ factor × value), 'product' (Π value), "
            "'quotient' (first ÷ second), 'percent_of' (second, as a percentage, OF first), "
            "'percent_ratio' (first ÷ second × 100, a percentage)"
        )
    )
    operands: list[CalculationOperand] = Field(
        min_length=2,
        max_length=6,
        description=(
            "The numbers going in, in the order they are read. 'quotient', 'percent_of' and "
            "'percent_ratio' take EXACTLY two"
        ),
    )
    unit: str | None = Field(
        default=None,
        description=(
            "Unit of THIS step's result, e.g. 'cm', 'm²', 'W/(m²K)'; omit for a dimensionless ratio like "
            "a GFZ. Ignored on 'percent_ratio', whose result is always a percentage"
        ),
    )

    @model_validator(mode="after")
    def _operand_count_matches_operation(self) -> "CalculationStep":
        if self.operation in ("quotient", "percent_of", "percent_ratio") and len(self.operands) != 2:
            raise ValueError(f"operation '{self.operation}' takes exactly two operands")
        if self.operation != "sum" and any(o.factor is not None for o in self.operands):
            raise ValueError("`factor` belongs to a 'sum' step; scale with a 'product' instead")
        return self


class CalculationLimit(CardModel):
    """The Bestimmung the derived result is held against.

    The comparator and the bound are the model's to supply — they are read out
    of the Richtlinie. The VERDICT is not: the renderer compares its own
    computed result against this and colours the card accordingly, so a card
    cannot show a green tick above arithmetic that fails.
    """

    comparator: Literal["<=", ">=", "between"] = Field(
        description="How the result must relate to the bound: at most, at least, or inside a range"
    )
    value: float = Field(description="The bound. With 'between', this is the LOWER bound")
    upper: float | None = Field(
        default=None,
        description="With 'between': the upper bound, e.g. 65 for the Schrittmaßregel's 59–65 cm. Otherwise omit",
    )
    label: str | None = Field(
        default=None, description="Optional name of the limit, e.g. 'Schrittmaßregel'; omit when the reference says it"
    )
    reference: NormReference | None = Field(default=None, description="Where the bound is written. Never invent one")

    @model_validator(mode="after")
    def _range_needs_an_upper_bound(self) -> "CalculationLimit":
        if self.comparator == "between":
            if self.upper is None:
                raise ValueError("a 'between' limit needs `upper`")
            if self.upper <= self.value:
                raise ValueError("`upper` must be greater than `value`")
        elif self.upper is not None:
            raise ValueError("`upper` is only meaningful with comparator 'between'")
        return self


class CalculationCard(CardModel):
    """Emit for the arithmetic behind a number — the Rechenweg a Ziviltechniker re-checks.

    Whenever the answer computes something (the Schrittmaßregel, a GFZ, a
    Brandlast, a required parking count, a U-value from its resistances), this
    card is the derivation laid out line by line instead of a sentence the
    reader has to re-derive to trust.

    YOU SUPPLY THE INPUTS, NEVER THE ANSWER. Give each operand its label, value
    and unit, name the operation, and give the limit if there is one. The card
    evaluates every step itself, carries the tolerance bands through, formats
    the numbers in Austrian convention and decides pass/fail. There is no field
    for a result, and that absence is the feature: a stated result that
    disagreed with its own operands would be the worst artefact this product can
    produce, because this is the part that gets screenshotted into a submission.

    Several steps chain by reference: a later operand can name an earlier step
    (`step: 1`) instead of carrying a value, so a two-stage derivation stays
    auditable rather than collapsing into one pre-computed figure.
    """

    type: Literal["calculation"]
    title: str = Field(min_length=1, description="What is being computed, e.g. 'Schrittmaßregel – Treppenlauf Haus A'")
    steps: list[CalculationStep] = Field(
        min_length=1,
        max_length=4,
        description="The derivation in order, most cards one step. A later step may reference an earlier one's result",
    )
    limit: CalculationLimit | None = Field(
        default=None,
        description=(
            "The Bestimmung the LAST step's result is checked against. Omit when the answer only derives a figure"
        ),
    )
    reference: NormReference | None = Field(
        default=None, description="Where the RULE behind the derivation is written (the limit may carry its own)"
    )
    note: str | None = Field(default=None, description="Optional one-line caveat, e.g. what the figure does not cover")

    @model_validator(mode="after")
    def _references_point_backwards(self) -> "CalculationCard":
        # A forward or self reference has no value to read, so the renderer
        # would have nothing to compute; rejecting it here means an
        # uncomputable card never reaches the client at all.
        for index, step in enumerate(self.steps, start=1):
            for operand in step.operands:
                if operand.step is not None and operand.step >= index:
                    raise ValueError(f"step {index} references step {operand.step}; a reference must point backwards")
        return self


class ProcessStep(CardModel):
    """One station of a Verfahren, with what it needs and what it produces."""

    label: str = Field(min_length=1, description="The step's name, e.g. 'Einreichung', 'Bauverhandlung'")
    summary: str | None = Field(
        default=None, description="One short line saying what happens here — shown in the row, so keep it to a clause"
    )
    actor: str | None = Field(
        default=None, description="Who acts at this step, e.g. 'Bauwerber', 'Baubehörde', 'Ziviltechniker'"
    )
    duration: str | None = Field(
        default=None,
        description=(
            "How long the step runs or the Frist attached to it, AS WRITTEN — 'binnen sechs Wochen', "
            "'8 Wochen ab Einreichung'. Never a date: nothing here is calculated, and a computed deadline "
            "would be a legal statement about this project that the card cannot make"
        ),
    )
    requires: list[str] = Field(
        default_factory=list,
        description="What must be in hand for this step, e.g. 'Einreichplan', 'Baubeschreibung', 'Energieausweis'",
    )
    produces: list[str] = Field(
        default_factory=list, description="What comes out of it, e.g. 'Baubewilligungsbescheid', 'Verhandlungsschrift'"
    )
    reference: NormReference | None = Field(
        default=None, description="The Bestimmung governing this step, e.g. the Bauordnung paragraph. Never invent one"
    )


class ProcessMapCard(CardModel):
    """Emit for „wie läuft das ab" — the ordered Verfahren, with where this project stands.

    Einreichung → Bauverhandlung → Baubewilligung → Baubeginnsanzeige →
    Fertigstellungsanzeige currently comes back as a numbered list, which says
    the order and nothing else: not what each step needs, not what it yields,
    and not where the reader is. The card draws the procedure as a rail and
    opens a step on click to show its requirements, its result and its
    Grundlage — everything already on the client, so no further question is
    needed to see it.

    Mark `current_step` ONLY when the conversation actually says where the
    project stands. The renderer derives the rest from it (earlier steps are
    done, later ones ahead), so guessing it tells the reader they have a
    Baubewilligung they may not have.
    """

    type: Literal["process_map"]
    title: str = Field(min_length=1, description="The procedure's name, e.g. 'Baubewilligungsverfahren – Wien'")
    steps: list[ProcessStep] = Field(
        min_length=3,
        max_length=8,
        description="The stations in order, first to last. Under three is not a procedure; over eight is a flowchart",
    )
    current_step: int | None = Field(
        default=None,
        description=(
            "1-based index of the step this project is AT. Everything before it renders as done and "
            "everything after as ahead, so set it only when the conversation says so — omit it rather "
            "than guessing, and the map renders with nothing marked"
        ),
    )
    reference: NormReference | None = Field(
        default=None, description="The law the procedure as a whole rests on, e.g. the Land's Bauordnung"
    )
    note: str | None = Field(default=None, description="Optional one-line caveat, e.g. that a Land deviates")

    @model_validator(mode="after")
    def _current_step_exists(self) -> "ProcessMapCard":
        if self.current_step is not None and not 1 <= self.current_step <= len(self.steps):
            raise ValueError("`current_step` must be a 1-based index into `steps`")
        return self


# ── The dossier, the clocks, and the cost of a change ────────────────────────
# Three more shapes an Austrian building-code answer takes constantly and that
# were still written as prose. Each is built around the field the prose version
# silently drops.
#
# All three obey the invariant `calculation` established: THE MODEL SUPPLIES
# INPUTS, THE RENDERER DERIVES WHAT IS DERIVABLE. None of them carries a count,
# a total or a tally on the wire — the checklist's „4 von 9 vorhanden" and the
# impact card's „3 verschärft, 1 gelockert" are computed by the component from
# the rows themselves, so there is nothing for a stated summary to disagree
# with. And none of them carries a date: a Frist is the Bauordnung's own wording
# („binnen sechs Wochen ab Zustellung"), never a calendar day this product
# worked out, because it does not know the Zustelldatum.


DocumentRequirement = Literal["required", "conditional"]
"""Whether a document is always needed, or only in certain Vorhaben."""

DocumentStatus = Literal["present", "missing"]
"""Whether the reader already HAS a document — a claim about their project.

Deliberately two values and not three. „Not stated" is the field being absent,
not a third literal, so the only way to say something about a document's status
is to say something the conversation established.
"""


class RequiredDocument(CardModel):
    """One document on the Einreichliste, with the state a bare list drops.

    „Was brauche ich für die Einreichung?" is one of the most common questions
    there is, and as a markdown list the answer carries the NAMES and nothing
    else: not whether a document is always required or only for this kind of
    Vorhaben, not who has to produce it, and not which ones the reader already
    holds. Those three are the whole of the reader's next hour of work.
    """

    label: str = Field(min_length=1, description="The document's name, e.g. 'Einreichplan', 'Energieausweis'")
    requirement: DocumentRequirement = Field(
        description=(
            "'required' when every Einreichung of this kind needs it, 'conditional' when it depends on the "
            "Vorhaben. A conditional document MUST say on what in `condition` — one whose condition you do "
            "not know is left off the list, never listed as required"
        )
    )
    condition: str | None = Field(
        default=None,
        description=(
            "REQUIRED with 'conditional' and forbidden otherwise: the case that makes this document "
            "necessary, e.g. 'nur bei Gebäuden mit mehr als 2 Wohnungen' or 'nur im Schutzzonenbereich'. "
            "One clause, as the Bestimmung words it"
        ),
    )
    issuer: str | None = Field(
        default=None,
        description=(
            "Who produces it — 'Ziviltechniker:in', 'Ingenieurkonsulent:in für Vermessungswesen', "
            "'Bauwerber', 'Baubehörde'. Omit rather than guess; a wrong issuer sends the reader to the "
            "wrong office"
        ),
    )
    status: DocumentStatus | None = Field(
        default=None,
        description=(
            "ONLY from what this conversation established: 'present' when the user said they already have "
            "it, 'missing' when they said they do not. Leave it unset otherwise — the card then renders the "
            "document as unknown, which is the truth, and never as a default. Guessing it tells the reader "
            "their dossier is further along (or further behind) than it is"
        ),
    )
    reference: NormReference | None = Field(
        default=None, description="The Bestimmung requiring this document. Never invent one"
    )
    note: str | None = Field(
        default=None,
        description="Optional one clause on FORM rather than substance, e.g. 'dreifach, in Papierform'",
    )

    @model_validator(mode="after")
    def _a_condition_belongs_to_a_conditional_document(self) -> "RequiredDocument":
        # The two halves of the same rule. A conditional entry with no condition
        # is the prose list again — the reader cannot tell whether it applies to
        # them — and a required entry that carries one is two answers at once.
        if self.requirement == "conditional" and not (self.condition or "").strip():
            raise ValueError(
                "a 'conditional' document must state its `condition`; omit the document entirely rather than "
                "listing a condition you do not know"
            )
        if self.requirement == "required" and self.condition:
            raise ValueError("a 'required' document applies always, so it carries no `condition'")
        return self


class DocumentChecklistCard(CardModel):
    """Emit for „welche Unterlagen brauche ich" — the Einreichliste as a worked list.

    The answer to that question is not a list of names, it is a list of STATES:
    which documents are always required, which depend on the Vorhabensart and on
    what, who issues each, and — where the conversation said so — which the
    reader already has. A markdown list carries none of that, so the reader
    re-derives it from the surrounding prose every time.

    The card lets them work down it: each row shows whether it is required or
    conditional and what is known about it, and a click opens the condition, the
    issuer, the Fundstelle and the form. Everything arrived with the card, so
    nothing is fetched.

    Set `status` on a document ONLY where the conversation established it. The
    card derives its own tally (how many are in hand, how many are still open)
    from the rows, so a status guessed to make the list look complete makes the
    tally wrong too.
    """

    type: Literal["document_checklist"]
    title: str = Field(min_length=1, description="What the list is FOR, e.g. 'Einreichunterlagen – Neubau Wien'")
    items: list[RequiredDocument] = Field(
        min_length=2,
        max_length=16,
        description="The documents, in the order the reader should work down them. One document is a sentence",
    )
    reference: NormReference | None = Field(
        default=None, description="The Bestimmung listing the Einreichunterlagen, e.g. the Land's Bauordnung"
    )
    note: str | None = Field(
        default=None, description="Optional one-line caveat, e.g. that the Gemeinde may ask for more"
    )


# A calendar date anywhere in a Frist is the one thing this card must never
# carry. Both patterns are fixed-width and unanchored with no nested quantifier
# and no alternation that can match the same span two ways, so matching is
# linear in the length of the string — pumped against 100k characters of '1.'
# and of '2026-' in `tests/aiq_agent/cards/test_models.py`.
_CALENDAR_DATE = re.compile(r"\d{1,2}\.\s?\d{1,2}\.\s?\d{2,4}|\d{4}-\d{2}-\d{2}")


class Deadline(CardModel):
    """One Frist of a Bauverfahren: how long it runs, and what starts the clock.

    `starts_from` is required, and that is the design. A period without its
    trigger („binnen sechs Wochen" — from what?) is not usable: the reader
    cannot place it, and a reader who assumes the wrong trigger misses the Frist
    by exactly the gap between the two events. Where the answer does not know
    what starts a clock, the Frist is left off the card rather than shown as a
    number with no anchor.
    """

    label: str = Field(min_length=1, description="The Frist's name, e.g. 'Einspruchsfrist', 'Baubeginnsanzeige'")
    period: str = Field(
        min_length=1,
        description=(
            "How long it runs, AS THE BESTIMMUNG WORDS IT — 'binnen sechs Wochen', 'vier Jahre', "
            "'unverzüglich'. NEVER a calendar date and never a date you computed: the product does not know "
            "this project's Zustelldatum, and a wrong date on a card is worse than no card. Dates are "
            "rejected by the validator"
        ),
    )
    starts_from: str = Field(
        min_length=1,
        description=(
            "WHAT STARTS THE CLOCK, and the field that makes the Frist usable — 'ab Zustellung des "
            "Bescheids', 'ab Rechtskraft der Baubewilligung', 'ab Fertigstellung'. Required: a Frist whose "
            "trigger you do not know is omitted, not shown anchored to nothing"
        ),
    )
    actor: str | None = Field(
        default=None, description="Who has to act inside it, e.g. 'Bauwerber', 'Nachbar', 'Baubehörde'"
    )
    consequence: str | None = Field(
        default=None,
        description=(
            "What happens when it lapses, e.g. 'Der Bescheid wird rechtskräftig.' — one clause. Omit when "
            "the answer does not say; this is the half a reader is most tempted to assume"
        ),
    )
    reference: NormReference | None = Field(
        default=None, description="The Bestimmung the Frist stands in. Never invent one"
    )

    @model_validator(mode="after")
    def _no_calendar_dates(self) -> "Deadline":
        for field_name in ("period", "starts_from"):
            if _CALENDAR_DATE.search(getattr(self, field_name)):
                raise ValueError(
                    f"`{field_name}` contains a calendar date; a Frist is carried as the Bestimmung words it "
                    "('binnen sechs Wochen ab Zustellung'), never as a day. This product does not know when "
                    "the Bescheid was served, so a computed date would be a legal statement about the "
                    "reader's project that nothing supports"
                )
        return self


class DeadlineTimelineCard(CardModel):
    """Emit for the FRISTEN of a Verfahren — several clocks, in the order they run.

    `callout` carries one Frist. A Bauverfahren has several in sequence —
    Einspruchsfrist, Baubeginnsanzeige, Fertigstellungsfrist, Geltungsdauer der
    Bewilligung — and their ORDER, together with what starts each one, IS the
    information. As prose they arrive as four sentences the reader has to sort
    themselves, and the sorting is where the mistake happens.

    Every Frist is carried in the Bauordnung's own words and none is turned into
    a date. The card draws them as a sequence, not to scale: the periods are
    measured in different units and run from different events, so a bar whose
    length meant anything would be claiming a shared timeline that does not
    exist.
    """

    type: Literal["deadline_timeline"]
    title: str = Field(min_length=1, description="What the Fristen belong to, e.g. 'Fristen im Bauverfahren – Wien'")
    deadlines: list[Deadline] = Field(
        min_length=2,
        max_length=8,
        description=(
            "The Fristen in the order they run. Two is the minimum, because ONE Frist is a callout — the "
            "sequence is what this card is for"
        ),
    )
    reference: NormReference | None = Field(
        default=None, description="The law the Fristen stand in, when they share one"
    )
    note: str | None = Field(
        default=None, description="Optional one-line caveat, e.g. that a Land counts a Frist differently"
    )


ChangeDirection = Literal["tightens", "relaxes", "unchanged"]
"""Which way a consequence moves for the reader.

'unchanged' earns its place: half of „was ändert sich" is answered by naming the
requirement a planner EXPECTS to move and saying that it does not. Without the
value the model has only the choice of leaving it out (and the reader assumes it
changed) or mislabelling it.
"""


class ChangeConsequence(CardModel):
    """One requirement that moves when the trigger fact moves, with its Fundstelle.

    `reference` is required here and optional almost everywhere else. This card
    exists to be planned against — a Ziviltechniker reads it and decides whether
    to keep the Fluchtniveau under 11 m — so a consequence nobody can look up is
    a consequence nobody can act on. One without a Fundstelle is left off the
    card, not listed bare.
    """

    aspect: str = Field(
        min_length=1,
        description="WHAT is affected, e.g. 'Feuerwiderstand tragender Bauteile', 'Zweiter Fluchtweg'",
    )
    before: str | None = Field(
        default=None,
        description=(
            "What applies BEFORE the change, e.g. 'REI 30'. Omit when the conversation has not established "
            "the current case — an invented 'before' invents the size of the change"
        ),
    )
    after: str = Field(min_length=1, description="What applies AFTER the change, e.g. 'REI 90 und A2'")
    direction: ChangeDirection = Field(
        description=(
            "'tightens' when the change costs the reader more (a higher class, an added requirement), "
            "'relaxes' when it costs less, 'unchanged' when this requirement is one a planner would expect "
            "to move and it does not"
        )
    )
    reference: NormReference = Field(
        description="Where THIS consequence is written. Required — a consequence you cannot cite is omitted"
    )
    detail: str | None = Field(
        default=None,
        description="Optional sentence or two, revealed on click: what the new requirement means in practice",
    )

    @model_validator(mode="after")
    def _direction_matches_the_two_values(self) -> "ChangeConsequence":
        # Only checkable when both sides are stated, and then it is worth
        # checking: a row reading 'REI 30 → REI 90, unverändert' is the card
        # contradicting itself in the reader's own line of sight.
        if self.before is None:
            return self
        same = self.before.strip() == self.after.strip()
        if same and self.direction != "unchanged":
            raise ValueError("`before` and `after` are the same, so `direction` is 'unchanged'")
        if not same and self.direction == "unchanged":
            raise ValueError("`direction` is 'unchanged' but `before` and `after` differ; say which way it moves")
        return self


class ChangeImpactCard(CardModel):
    """Emit for „was passiert, wenn X sich ändert" — one changed fact, and what it costs.

    The card a planner needs while the design is still moving: „was passiert,
    wenn das Fluchtniveau über 11 m geht?" — the Gebäudeklasse changes, and with
    it the required fire resistance, the second escape route and the lift. As
    prose that is a paragraph whose consequences the reader has to separate from
    each other and pair back to their sources.

    Not a `condition_tree`. The tree shows which case the project is IN; this
    shows what a MOVE would cost, so it names one trigger fact, its two values,
    and the consequences that follow — each with its own Fundstelle and each
    marked as tightening or relaxing. The card counts the directions itself, so
    there is no summary field to disagree with the rows.

    `from_value` is optional because the current state is a claim about this
    project: state it only where the conversation established it. `to_value` is
    the hypothesis the question itself supplies, so it is always known.
    """

    type: Literal["change_impact"]
    title: str = Field(
        min_length=1, description="The change, as a heading, e.g. 'Fluchtniveau über 11 m – was sich ändert'"
    )
    factor: str = Field(
        min_length=1, description="The ONE fact that moves, e.g. 'Fluchtniveau', 'Anzahl der Wohnungen'"
    )
    from_value: str | None = Field(
        default=None,
        description=(
            "Its value now, e.g. '7–11 m'. Omit when the conversation has not established where the project "
            "stands — never guess it, exactly as a process_map's position is never guessed"
        ),
    )
    to_value: str = Field(min_length=1, description="Its value after the change, e.g. 'über 11 m'")
    consequences: list[ChangeConsequence] = Field(
        min_length=1,
        max_length=8,
        description="What follows, most important first. Each carries its own Fundstelle",
    )
    reference: NormReference | None = Field(
        default=None, description="The Bestimmung that makes the FACTOR decisive, e.g. the Gebäudeklassen table"
    )
    note: str | None = Field(default=None, description="Optional one-line caveat, e.g. what the list does not cover")


# ── The graph the other cards cannot hold ────────────────────────────────────
# `process_map` draws a LINE and `condition_tree` draws a FAN, and each is the
# right card the moment an answer is that shape. What neither can hold is a
# GRAPH: a path that forks and rejoins, three parties handing things back and
# forth in order, a stage a Verfahren can RETURN to, a Nachweis two others
# depend on. Those answers were coming back as prose — or as a ```mermaid fence,
# which this product has drawn and been able to file into a project as SVG + PDF
# for a while now (`docs/architecture/diagrams.md`) without a single prompt,
# tool or skill ever telling the model it could draw one.
#
# This card is that fence, catalogued. The fence stays as the fallback for
# everything the card refuses; what the card adds is the three things a fence
# cannot have. It has a CATALOG entry, which is how the model learns a card
# exists at all — a fence has to win attention from prompt text instead. It is
# VALIDATED here, before it reaches a browser, where a fence is unvalidated
# until mermaid chokes on it in front of the reader. And filing the drawing
# WRITES two `documents` rows, which makes the reader's click a decision that
# ADR-0030 says has to persist on the message rather than in component-local
# React state — which is exactly where the fence's filing button holds it.
#
# What this card CANNOT have is the invariant every other drawing card in this
# module is built on: the renderer does the geometry, so a card cannot show a
# diagram that disagrees with its own numbers. Mermaid text IS the geometry —
# whatever the model writes is what is drawn, with no arithmetic in between and
# therefore nothing to catch a disagreement. So the boundary is drawn around the
# SUBJECT instead: a diagram that makes no dimensional claim has nothing on it
# that can be measurably wrong. Everything measured belongs to the fifteen
# schematic cards above, and that seam is stated in three places that must
# agree — here, `docs/architecture/diagrams.md`, and the frontend's own
# `lib/diagrams/diagram-sources.ts`.


DiagramGrammar = Literal["flowchart", "sequence", "state", "pie"]
"""The four mermaid grammars verified end to end: drawn, filed AND printed.

Not "the four we like" — the four that survive the whole pipeline. A diagram in
this product is rendered in the browser, re-serialised through the SERVER's SVG
allow-list before it is even shown, and then converted to PDF for an
Einreichung; a grammar that fails at any of those three is a card that renders
as a grey code block in an answer.

`journey` is the instructive exclusion. Mermaid emits `<foreignObject>` for it
whatever `htmlLabels` says, and `<foreignObject>` is arbitrary HTML inside a
file that gets served back to browsers, so the SVG validator refuses it — in the
browser, before the drawing is shown, which is why a journey degrades to its own
source text rather than drawing and then failing to file. `gantt`, `erDiagram`,
`classDiagram` and `mindmap` are simply unverified: nobody has put one through
the PDF converter, and a diagram that previews and then prints blank is worse
than one that never drew.
"""

# The declaration keywords mermaid accepts, mapped to the grammar they select.
# Both spellings of each are real: `graph TD` is the legacy flowchart header
# that most training data still carries, and `stateDiagram-v2` is the version
# mermaid's own docs steer you to. Refusing either would refuse a diagram that
# draws perfectly, which is the one direction this validator must not fail in.
_DIAGRAM_DECLARATIONS: dict[str, str] = {
    "flowchart": "flowchart",
    "graph": "flowchart",
    "sequencediagram": "sequence",
    "statediagram": "state",
    "statediagram-v2": "state",
    "pie": "pie",
}

#: `--- title: … ---` front matter, the one preamble mermaid allows above the
#: declaration. Stripped before the declaration is read, not refused: it is
#: valid mermaid and the model will occasionally write it.
_MERMAID_FRONT_MATTER = re.compile(r"\A\s*---\s*\r?\n.*?\r?\n\s*---\s*(?:\r?\n|\Z)", re.DOTALL)

#: `%%{init: {...}}%%` — a directive, not a comment, and it may sit on the line
#: above the declaration or run across several lines.
_MERMAID_DIRECTIVE = re.compile(r"%%\{.*?\}%%", re.DOTALL)


#: Mermaid grammars this pipeline does NOT carry, kept by name so the refusal
#: can say which one was written instead of "no diagram type". A model that
#: reaches for `gantt` has understood the request and picked a grammar we cannot
#: file; telling it that is a different instruction from telling it the source
#: has no header, and the two failures have different fixes.
_UNSUPPORTED_DECLARATIONS = frozenset(
    {
        "journey",
        "gantt",
        "erdiagram",
        "classdiagram",
        "classdiagram-v2",
        "mindmap",
        "timeline",
        "gitgraph",
        "quadrantchart",
        "requirementdiagram",
        "c4context",
        "sankey-beta",
        "xychart-beta",
        "block-beta",
        "architecture-beta",
    }
)


def _first_statement(source: str) -> str | None:
    """The first line of ``source`` that mermaid actually reads, or None.

    "First line mermaid reads" is the one thing worth being careful about:
    mermaid lets front matter, an init directive and `%%` comments precede the
    declaration, and a validator that took line one literally would refuse
    sources that draw perfectly. None means there is nothing but preamble — the
    source declares no grammar, which is the single most common way a
    model-written diagram fails, because mermaid then has nothing to parse the
    rest with and the whole block collapses.

    The raw line is returned rather than the keyword so a refusal can quote what
    the model actually wrote; the keyword is derived by the one caller.
    """
    body = _MERMAID_DIRECTIVE.sub("", _MERMAID_FRONT_MATTER.sub("", source))
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("%%"):
            continue
        return stripped
    return None


class DiagramCard(CardModel):
    """Emit when the user asks for a Diagramm, and for a fork, exchange or dependency — mermaid, never a measurement.

    A relationship prose cannot hold: a Verfahren whose stages fork and come back
    together, several Stellen handing something to each other in order, a
    Nachweis that other Nachweise wait on.

    It is the residue after the purpose-built cards have taken their shapes.
    `process_map` owns the ordered Verfahren, which is a LINE; `condition_tree`
    owns the fork on one factor, which is a FAN. Reach for this card only when
    the answer is a GRAPH neither of them can draw — a branch that comes back
    together, a Bescheid that returns a stage, three parties passing an Akt
    between them, a dependency between requirements. If the answer does fit a
    line or a fan, that card draws it better, because there the renderer decides
    what the picture looks like.

    ## The boundary, and why it is about subject rather than quality

    Every other drawing in this catalog is a schematic card: the model emits
    parameters and the renderer computes the geometry, so a card cannot show a
    diagram that disagrees with its own numbers. Here the source IS the geometry.
    Nothing stands between what the model types and what is drawn, so nothing can
    catch a disagreement — which is why the rule is that there must be nothing to
    disagree WITH. A Verfahrensablauf, an Einreichungssequenz, a
    Zuständigkeitskarte: none of them claims a measurement, so none of them can
    be measurably wrong.

    Anything carrying a measurement — a section, a stair, an escape route, a fire
    compartment, a setback — belongs to the fifteen schematic cards, where the
    renderer draws to scale. A mermaid box with „40 m" typed inside it is
    precisely the artefact the card system exists to prevent, and it is the one
    that gets screenshotted into an Einreichung.

    Naming a threshold in a branch condition („Fluchtniveau > 22 m → GK 5") is
    not that artefact and is not refused: the reader cannot mistake a rounded
    rectangle for a section, and the number there is a label the answer has
    already grounded. What is refused is the drawing that asks to be read as
    scaled. No regular expression is going to tell those apart — the same „22 m"
    appears in both — so the line is drawn in words, in the catalog, where the
    model reads it before it writes.

    ## One per answer

    A diagram earns its place when it shows something prose cannot: a fork, an
    ordering, a dependency. Most answers have none of those, and a decorative
    diagram in a compliance answer costs the reader trust in every drawing beside
    it. At most one per answer, for the same reason `callout` says so: a second
    puts both back at the weight of the prose around them.
    """

    type: Literal["diagram"]
    title: str = Field(
        min_length=1,
        description=(
            "Heading above the drawing, e.g. 'Ablauf einer Bauanzeige – Wien'. It is read on its "
            "own, above the picture, so write it as a document title rather than as a sentence"
        ),
    )
    diagram_type: DiagramGrammar = Field(
        description=(
            "Which mermaid grammar `source` is written in: 'flowchart' (a path that forks and "
            "rejoins, or a dependency), 'sequence' (parties exchanging things in order), 'state' (a "
            "stage that can be returned to), 'pie' (a split the answer has already established). "
            "These four are verified end to end; every other mermaid type either fails to draw or "
            "fails to file, so an answer needing one writes prose instead"
        )
    )
    source: str = Field(
        min_length=1,
        max_length=4000,
        description=(
            "The mermaid source, starting with its own declaration line ('flowchart TD', "
            "'sequenceDiagram', 'stateDiagram-v2', 'pie') — a source that declares nothing draws "
            "nothing. Labels in the answer's language and in Sie-Form; no label may carry a claim "
            "the answer has not grounded, because the drawing leaves the page without the paragraph "
            "that qualified it. Five to nine nodes: past that nobody reads the picture"
        ),
    )
    caption: str | None = Field(
        default=None,
        description=(
            "One line under the drawing saying what it shows that the prose does not — which "
            "Bundesland's Verfahren this is, which case is drawn, what it leaves out. Omit it rather "
            "than restating the title"
        ),
    )
    reference: NormReference | None = Field(
        default=None,
        description=(
            "The Bestimmung the depicted Verfahren rests on, e.g. the Land's Bauordnung. A procedure "
            "differs by Bundesland, so a drawing of one without its Fundstelle is a procedure from "
            "nowhere"
        ),
    )

    @model_validator(mode="after")
    def _source_declares_the_grammar_it_says_it_does(self) -> "DiagramCard":
        """Refuse a source that declares nothing, or declares something else.

        This is the one invariant available to a card whose renderer cannot do
        the geometry, and it catches the failure that actually bites. A missing
        declaration is the most common way a model-written diagram fails: mermaid
        has no grammar to parse the rest with, so the whole block collapses to a
        grey code box in the middle of an answer, which reads as this product
        being unable to draw. And a `journey` or a `gantt` smuggled in under a
        declared 'flowchart' would pass every other check here and then be
        refused by the SVG validator in the reader's browser.

        Refused rather than repaired: `emit_card` hands the message back to the
        model, which fixes the source and calls again, and every refusal is
        logged with the card type — so a doctrine that keeps producing
        undeclared diagrams is visible instead of silently patched over.
        """
        statement = _first_statement(self.source)
        if statement is None:
            raise ValueError(
                "`source` declares no diagram type: it is nothing but front matter, a directive or "
                "comments. Its first real line must be the mermaid declaration itself — "
                "'flowchart TD', 'sequenceDiagram', 'stateDiagram-v2' or 'pie'."
            )
        keyword = statement.split()[0].lower().rstrip(":")
        if keyword in _UNSUPPORTED_DECLARATIONS:
            raise ValueError(
                f"`source` is a '{keyword}' diagram, which this product cannot draw or file: only "
                "flowchart, sequence, state and pie survive rendering, the SVG allow-list and the "
                "PDF conversion. Rewrite it as one of those four, or write the answer as prose."
            )
        declared = _DIAGRAM_DECLARATIONS.get(keyword)
        if declared is None:
            raise ValueError(
                f"`source` declares no diagram type: it opens with {statement[:60]!r}. The first "
                "real line must be the declaration itself — 'flowchart TD', 'sequenceDiagram', "
                "'stateDiagram-v2' or 'pie'. Without it mermaid has no grammar to read the rest "
                "with and nothing is drawn."
            )
        if declared != self.diagram_type:
            raise ValueError(
                f"`diagram_type` is '{self.diagram_type}' but `source` declares '{declared}'. "
                "Make them agree, and note that only flowchart, sequence, state and pie are "
                "supported — any other mermaid type is refused before it reaches the reader."
            )
        return self


# ── Document-surfacing card (system-emitted) ─────────────────────────────────
# Surfaced by the `surface_documents` tool from a REAL vector search over the
# project + Büroarchiv corpus — never fabricated by the model (it is a system
# card, so `emit_card` refuses it). Each entry names a real indexed file so the
# frontend can resolve it to the live document row (id, thumbnail, preview) and
# render the same rich file-explorer card the Files page uses.


class SurfacedDocument(CardModel):
    """One real document surfaced by a corpus search, with its match evidence."""

    file_name: str = Field(min_length=1, description="Exact indexed file name (resolves to the live document row)")
    summary: str | None = Field(default=None, description="One-line description of what the document is")
    snippet: str | None = Field(default=None, description="Best-matching passage — WHY this file surfaced")
    page: int | None = Field(default=None, description="1-based page the snippet came from, if known")
    score: float | None = Field(default=None, description="0..1 relevance score of the best chunk")
    source: Literal["projekt", "buero"] | None = Field(
        default=None, description="Which corpus it came from: 'projekt' (project) or 'buero' (Büroarchiv)"
    )


class DocumentGridCard(CardModel):
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


class IfcPropertyMatch(CardModel):
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


class IfcElementMatch(CardModel):
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


class IfcHighlight(CardModel):
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


class IfcViewerCard(CardModel):
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


class IfcScheduleCard(CardModel):
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


class IfcComplianceCard(CardModel):
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


class IfcElementCard(CardModel):
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


class IfcDiffCard(CardModel):
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


class IfcModelPickerCard(CardModel):
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
    | CalculationCard
    | ProcessMapCard
    | DocumentChecklistCard
    | DeadlineTimelineCard
    | ChangeImpactCard
    | DiagramCard
    | FollowUpsCard
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
    "CalculationCard",
    "CalculationLimit",
    "CalculationOperand",
    "CalculationStep",
    "CalloutCard",
    "CardModel",
    "ChangeConsequence",
    "ChangeImpactCard",
    "ChecklistItem",
    "ComparisonRow",
    "ComparisonTableCard",
    "ConditionBranch",
    "ConditionTreeCard",
    "Deadline",
    "DeadlineTimelineCard",
    "DiagramCard",
    "DocumentChecklistCard",
    "DocumentGridCard",
    "FollowUp",
    "FollowUpsCard",
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
    "ProcessMapCard",
    "ProcessStep",
    "RequiredDocument",
    "SurfacedDocument",
    "ProjectProfilePatchCard",
    "ProjectProfilePatchOperation",
    "ProjectProfilePatchPreviewItem",
    "RequirementChecklistCard",
    "SummaryCard",
    "TypedColumn",
    "TypedTableCard",
    "VerdictHeaderCard",
    "flatten_card_markup",
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
