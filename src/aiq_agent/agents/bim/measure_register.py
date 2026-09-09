"""``ifc_measure`` tool — measure the building, and say how the number was got.

The sibling of :mod:`aiq_agent.agents.bim.register`. ``ifc_query`` reads the
extracted index and answers what the export WROTE DOWN; this tool runs the
spatial engine (IfcOpenShell/OCCT) over the model's own bytes for what it did
not: a floor area with no published quantity, a sill with no property, the
lichte Höhe under a suspended ceiling.

Every answer carries its provenance, and the renderer puts a different German
verb in front of each — *deklariert* (the file states it) / *gemessen (±tol)*
(we measured it) / *vermutlich* (a heuristic, with its confidence). Collapsing
those into one number is how a guess gets stamped. ``decidable: false`` is not
an error: the question was well-formed and THIS EXPORT cannot answer it, and
``missing.remedy`` says what the architect changes in their CAD.

Design, costs and the defects each rule answers:
``docs/roadmap/agent-spatial-reasoning.md`` and
``docs/roadmap/spatial-review-findings.md``.
"""

import asyncio
import logging
import math
import re
from collections.abc import Callable
from collections.abc import Sequence
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError
from pydantic import field_validator
from pydantic import model_validator

from aiq_agent.agents.bim.capability_gaps import record_gap
from aiq_agent.agents.bim.failures import ENGINE_UNAVAILABLE_TEXT
from aiq_agent.agents.bim.failures import MEASURE_FAILURES
from aiq_agent.agents.bim.failures import NO_ORG_TEXT
from aiq_agent.agents.bim.failures import NO_PROJECT_TEXT
from aiq_agent.agents.bim.failures import UNAVAILABLE_TEXT
from aiq_agent.agents.bim.failures import rejected_text
from aiq_agent.agents.bim.failures import too_large_text
from aiq_agent.agents.bim.failures import unrunnable_text
from aiq_agent.agents.bim.measurement_evidence import EVIDENCE_PROVENANCES
from aiq_agent.agents.bim.measurement_evidence import measurement_evidence_line
from aiq_agent.agents.bim.measurement_sources import MeasuredElement
from aiq_agent.agents.bim.measurement_sources import MeasurementSource
from aiq_agent.agents.bim.measurement_sources import record_measurements
from aiq_agent.agents.bim.rendering import listed
from aiq_agent.agents.bim.rendering import render_unresolved
from aiq_agent.agents.bim.trace import record_ifc_call
from aiq_agent.knowledge.ifc_spatial_client import call_spatial_tool
from aiq_agent.knowledge.ifc_spatial_client import open_model
from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source
from aiq_agent.project_context import get_organization_id_from_context
from aiq_agent.project_context import get_project_id_from_context
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

__all__ = [
    "ENGINE_UNAVAILABLE_TEXT",
    "NO_PROJECT_TEXT",
    "UNAVAILABLE_TEXT",
    "IfcMeasureConfig",
    "IfcMeasureInput",
    "ifc_measure",
]

logger = logging.getLogger(__name__)

# The failure texts, under the names the shallow researcher's tests fix.
_rejected_text = rejected_text
_unrunnable_text = unrunnable_text
_too_large_text = too_large_text


#: The operations, in the order the description teaches them.
#:
#: ORDERED, and that is not cosmetic. This tuple becomes the ``enum`` on the
#: ``operation`` field of the wire schema, and a set's iteration order varies
#: between processes because string hashing is randomised. A schema whose enum
#: reorders on every restart is a different schema to every prefix cache in
#: front of the model.
OPERATIONS: tuple[str, ...] = (
    "briefing",
    "find_elements",
    "element",
    "relations",
    "measure",
    "survey",
    "element_profile",
    "distance",
    "clearance",
    "sun_position",
    "storey_heights",
    "room_inventory",
    "draw",
    "view",
    "shopping_list",
    "fire",
    "envelope",
    "overhang",
    "light_incidence",
)

VALID_OPERATIONS = frozenset(OPERATIONS)

#: Operations that answer with something other than a quantity, and therefore
#: carry no measurement-evidence trailer (:func:`_render`).
#:
#: A briefing, a hit list, an element's index metadata, a written IDS file and a
#: drawing's path are all real results and none of them measures the building.
#: Telling the model „Messwerte in diesem Ergebnis: 0" about a `draw` reads as a
#: measurement that failed and invites a retry that costs one of five tool
#: iterations.
#:
#: This is an allow-list of SUPPRESSION, not of grounding, so it fails in the
#: safe direction: an operation missing from this set gets a trailer stating its
#: true count, and an operation wrongly IN it gets no trailer — which the
#: confidence gate reads as no measurement either way. `relations` is
#: deliberately absent: „0 Messwerte" is exactly what the model needs to hear
#: before it turns a list of bounding walls into „rund 2,7 m".
NON_MEASURING_OPERATIONS: frozenset[str] = frozenset(
    {
        "briefing",
        "find_elements",
        "element",
        "draw",
        "view",
        "shopping_list",
    }
)

# ── the enums, mirrored ──────────────────────────────────────────────────────
#
# These four sets mirror `ifc_spatial.tools.RELATIONS`, `.MEASURES`, `.KINDS`
# and the room-use lexicon, and `tests/aiq_agent/agents/test_ifc_measure_tool.py`
# pins them against the package so a renamed operator fails there rather than at
# the user.
#
# Copied rather than imported for one reason: `import ifc_spatial` pulls in
# IfcOpenShell, numpy and shapely — a second of import time and a few hundred
# megabytes of address space — and this module is imported by NAT's plugin
# discovery at startup on every deployment, including the ones that never touch
# a building. The engine is imported when a call is actually made.

#: relation → what it answers, in the tool's own words.
RELATIONS: dict[str, str] = {
    "hostedIn": "which wall carries this window/door (from voids+fills)",
    "hosts": "which openings are cut out of this element",
    "fillerOf": "what fills this opening",
    "bounds": "which elements bound this room  [geometry, see below]",
    "enclosedBy": "which rooms this element bounds  [geometry, see below]",
    "opensTo": "which rooms this window/door opens into  [geometry, see below]",
    "connects": "which elements butt onto this one",
    "contains": "which elements sit in this storey or room",
    "containerOf": "which storey or room this element sits in",
    "adjacentSpaces": "which rooms border this room  [geometry, see below]",
    "elementsOfStorey": "every element of this storey, including those in rooms",
    "above": "what is directly ABOVE this element or room  [geometry, rays; furniture excluded]",
    "below": "what is directly BELOW it  [geometry, rays]",
}

#: The four relations that fall back to a geometric contact map when the export
#: declares no ``IfcRelSpaceBoundary`` — which is the ordinary case.
GEOMETRIC_RELATIONS = frozenset({"bounds", "enclosedBy", "opensTo", "adjacentSpaces", "above", "below"})

#: measure → what it answers.
MEASURES: dict[str, str] = {
    "extent": "width, depth, height and centroid of one element",
    "floorArea": (
        "a room's floor area FROM THE GEOMETRY — available even when the export publishes no "
        "quantity. When it publishes one, both routes are compared and a contradiction is reported"
    ),
    "sillAndHead": "Brüstungs- und Sturzhöhe of a window/door above ITS OWN storey",
    "elevation": "underside and top, absolute and above the element's own storey",
    "clearHeight": (
        "lichte Raumhöhe — floor to the LOWEST thing hanging into the room (suspended ceiling, "
        "downstand, duct). NOT the height of the space solid, which is what 'extent' gives and what "
        "a Raumhöhennachweis must not use"
    ),
    "azimuth": "which way a facade faces. Undecidable without TrueNorth in the file",
    "lightEntryArea": (
        "a ROOM's light-entry area and what percent of its floor area that is — the number an OIB 3 "
        "daylight check comes down to. Sums only the EXTERNAL openings (an internal door lights "
        "nothing) and measures the structural clear opening, not the glazed area. Applies no "
        "threshold: the percentage is in the Bestimmung, not in the model"
    ),
    "egressPath": (
        "a ROOM's shortest WALKABLE route to the outside through doors, with the rooms, the doors "
        "and a length. Adjacency is not walkability — two rooms sharing a wall with no door between "
        "them are adjacent and unreachable. The length is a polyline through room and door centres, "
        "so it is a LOWER BOUND and explicitly not a Fluchtweglänge under OIB 2"
    ),
    "reachableFrom": (
        "every room reachable from this one through doors, with door counts. Answers 'which rooms are "
        "behind this door', and finds rooms with no way out at all — itself a finding"
    ),
    "clearWidth": (
        "the LICHTE Breite and Höhe of an opening, measured on the aperture itself. THIS is what a "
        "door-width or escape-route-width check needs — 'distance' measures centroids and boxes and "
        "gives an Achsabstand"
    ),
    "orientedExtent": (
        "length/width/height along the ELEMENT's own axes plus its bearing from north. Use for anything "
        "skewed to the model grid, where 'extent' is axis-aligned and systematically too large"
    ),
    "roomDepth": (
        "how deep a room runs back from its daylight facade, the width along that facade, and the ratio "
        "to the clear height. Names which facade it chose and, for a corner room, the runner-up"
    ),
    "stairGeometry": (
        "riser height, tread depth, riser count and the NUTZBREITE of a stair flight — plus the SPREAD "
        "of the risers, because a stair can be right on average and still unwalkable. Declared values "
        "are checked against the geometry and a contradiction is reported"
    ),
    "rampSlope": "a ramp's slope as a percentage AND as a ratio, with run, rise and clear width",
    "headroom": (
        "clear height over a stair flight or ramp, measured PERPENDICULAR to the pitch rather than "
        "vertically — a vertical ray from the tread misses the tight point (1.35 m vs 1.65 m measured)"
    ),
    "stepsOf": "the flights and landings a stair is made of, so one flight can be asked about",
    "turningCircle": (
        "the largest circle that fits on a ROOM's free floor — what a Wendekreis check comes down to. "
        "Counts fixed built-ins only; furniture is reported beside it, because a permit is granted on "
        "the building and not on the chairs. Applies no threshold"
    ),
    "thresholdHeight": (
        "the step at a door. Where the export models no floor build-up this is a STRUCTURAL number and "
        "the answer says so — screed, covering and seal are what make the step, so 0 mm on raw slabs "
        "says nothing about the finished threshold"
    ),
    "balustrade": (
        "where there is a fall at an opening, how far, and what stands there. Undecidable when the "
        "export contains no IfcRailing at all — no railing in the model is not no railing on site"
    ),
    "clearApproach": "the free floor in front of a door on each side, and what ends it",
}

# NONE of these is a clear dimension, and saying otherwise was a defect. The
# entry for 'horizontal' read "what a lichte Breite check needs"; the operator
# measures CENTROID to CENTROID in plan, which is an Achsabstand. On a 1.00 m
# opening between two 30 cm walls that is 1.30 m — too large by half of each
# element, in the direction that turns a failed escape-route width into a passing
# one. A clear width is `measure` + `clearWidth`, measured on the aperture.
DISTANCE_MODES = {
    "min": (
        "gap between the two axis-aligned BOUNDING BOXES. 0 means the boxes overlap — it does NOT "
        "prove the solids touch, and on a skewed element the true gap is larger"
    ),
    "centroid": "centre to centre in 3D (Achsabstand). NOT a clear dimension",
    "horizontal": (
        "centre to centre in plan, Z ignored (Achsabstand) — what a plan drawing scales off. NOT a "
        "lichte Breite: for a clear width use measure/clearWidth on the opening"
    ),
    "vertical": (
        "difference in centre HEIGHT — what a section scales off. NOT a lichte Höhe: for that use "
        "measure/clearHeight on the room"
    ),
}

#: `what` on the `fire` operation — the OIB 2 geometry, in one place.
FIRE_ASPECTS = {
    "fluchtniveau": (
        "height of the topmost occupied floor above the lowest adjoining ground — the number the "
        "Gebäudeklasse hangs on. Returns a HEIGHT and never a class"
    ),
    "compartmentArea": "floor area of a fire compartment across several rooms, each room listed",
    "separatingElements": (
        "what lies BETWEEN two rooms — wall, slab, and the doors in them — each with its DECLARED "
        "FireRating, and explicitly with its absence"
    ),
    "siteBoundary": (
        "distance to the site boundary (Brandübertragung). Undecidable on most exports, because a "
        "parcel boundary is rarely exported — and it is not guessed here"
    ),
    "doorGraph": (
        "the WHOLE building's walkable graph: rooms as nodes, OUTSIDE as its own node, doors as edges "
        "— plus the doors that became NEITHER (unbestimmt, ausgeschlossen). A room with no edge has no "
        "way out; an unresolved door is a hole in EVERY route through this building. measure/egressPath "
        "gives one route, this says how sound the basis of all routes is. Takes no global_id"
    ),
}

#: `what` on the `envelope` operation — the OIB 6 geometry.
#:
#: Carried on `kind`, the same field `fire` uses, because both are "one subject
#: asked several ways" and a third field spelling would make the model choose a
#: parameter name instead of a question.
ENVELOPE_ASPECTS = {
    "thermalEnvelope": (
        "which elements form the boundary between heated inside and outside, grouped by kind, each "
        "with its area and its DECLARED U-value. Every entry says which rung decided it — declared "
        "IsExternal and inferred from room contact are not the same claim — and the two lists that "
        "make the total checkable come back with it: innenliegend (decided, left out) and "
        "unbestimmt (not decided, so neither counted nor discarded)"
    ),
    "areaByOrientation": (
        "envelope area per compass bearing, opaque and transparent apart, with the window-to-wall "
        "ratio per facade. Needs a declared TrueNorth; without one the bearing is refused, not guessed"
    ),
    "compactness": (
        "A/V in 1/m, with the characteristic length (V over A) beside it. A and V come back separately, "
        "because a ratio whose inputs are invisible cannot be checked by whoever signs it. V is the "
        "NET volume (the sum of the IfcSpace solids)"
    ),
}

#: `mode` on view. A SECOND vocabulary on the same field, which is worth naming
#: rather than leaving inline: `mode` already carries the distance senses, and a
#: model that reads DISTANCE_MODES and then meets `mode="highlight"` has to work
#: out for itself that the field is operation-scoped. Spelling both sets out —
#: and pinning both in the skill test — is what keeps that from being a guess.
VIEW_MODES = {
    "highlight": "mark these elements red on the full plan — 'where is this in the building'",
    "only": "draw nothing but these elements — 'what does this look like'",
}

#: `kind` on find_elements — the spatial role, not the IFC type.
KINDS = ("project", "site", "building", "storey", "space", "element", "opening", "group")

#: `room_kind` on room_inventory.
ROOM_KINDS = ("aufenthaltsraum", "nebenraum", "erschliessung")

#: `ifc_spatial.tools.MAX_BATCH` — the most GlobalIds one `measure` may carry.
#: Mirrored for the same reason the vocabularies above are, and pinned against
#: the package by the same test.
MAX_BATCH = 50

#: The one value `kind` takes on `element_profile`, where it is an opt-in to the
#: expensive measures rather than a vocabulary.
PROFILE_KINDS = ("expensive",)


def _enum_lines(entries: dict[str, str], indent: str = "    ") -> str:
    return "\n".join(f"{indent}{name} — {meaning}" for name, meaning in entries.items())


# ── the input schema ─────────────────────────────────────────────────────────
#
# The schema is what the model reads a vocabulary from, so the enums are BUILT
# from the vocabularies above rather than retyped beside them, and the model is
# FLAT rather than a discriminated union: a `RootModel[Union[...]]` reaches the
# wire as one property called `root`, a wrapper the model cannot learn about.
# Measured, not assumed — `tests/aiq_agent/agents/test_ifc_measure_tool.py`
# keeps the measurement. Why the schema was tightened at all, and what it buys
# (fewer bad calls EMITTED, not turns refunded): ``docs/roadmap/spatial-review-findings.md``.


def _literal(*groups) -> Any:
    """A ``Literal`` over these vocabularies, in the order they were written.

    Order is part of the contract: the tuple becomes the ``enum`` array in the
    schema the model is handed, and an enum that reshuffles between restarts
    invalidates every prefix cache in front of it.
    """
    names = dict.fromkeys(name for group in groups for name in group)
    return Literal[tuple(names)]  # type: ignore[valid-type]


#: Which vocabulary a bad `kind` is recorded AGAINST — the ledger entry, not the
#: check. `kind` is one field over four vocabularies, and the `Literal` accepts
#: the union of all of them because the call builders are the layer that
#: knows which applies: `element_profile` ignores a `kind` that is not
#: 'expensive', and narrowing the type here would turn that shrug into a
#: refusal. What IS scoped is the backlog line: „fire kind='brandabschnitt'" and
#: „find_elements kind='brandabschnitt'" are different requests, and a ledger
#: that merged them would rank neither.
_KIND_FIELD: dict[str, str] = {
    "fire": "fire.kind",
    "envelope": "envelope.kind",
    "element_profile": "element_profile.kind",
}

#: Every spelling `kind` accepts, across all four of its vocabularies.
_ALL_KINDS: tuple[str, ...] = (*KINDS, *FIRE_ASPECTS, *ENVELOPE_ASPECTS, *PROFILE_KINDS)

#: The fields this tool has always matched case-insensitively, and their
#: canonical spellings. A `Literal` is case-SENSITIVE, and kind='Compactness'
#: has always been a working call. `measure` and `relation` are absent on
#: purpose: those have always been required exact.
_CASE_FOLDED: dict[str, tuple[str, ...]] = {
    "operation": OPERATIONS,
    "room_kind": ROOM_KINDS,
    "kind": _ALL_KINDS,
    "mode": (*DISTANCE_MODES, *VIEW_MODES),
}


def _canonical(asked: str, vocabulary: Sequence[str]) -> str:
    """The vocabulary's own spelling of ``asked``, or ``asked`` unchanged when it is in no vocabulary."""
    wanted = asked.strip().lower()
    return next((known for known in vocabulary if known.lower() == wanted), asked)


def _record_misses(data: dict[str, Any]) -> None:
    """Write every value that is in no vocabulary to the capability ledger."""
    operation = str(data.get("operation") or "").strip().lower()
    checks = (
        ("operation", VALID_OPERATIONS),
        ("measure", MEASURES),
        ("relation", RELATIONS),
        ("room_kind", ROOM_KINDS),
        # Against the WHOLE of `kind`, because that is what the field accepts:
        # `element_profile kind='space'` is a shrug, not a missing capability.
        (_KIND_FIELD.get(operation, "kind"), _ALL_KINDS),
    )
    for name, known in checks:
        asked = data.get(name.split(".")[-1])
        wanted = asked.strip() if isinstance(asked, str) else ""
        if wanted and wanted not in known:
            record_gap(surface="ifc_measure", field=name, asked_for=wanted, known=known)


class IfcMeasureInput(BaseModel):
    """The arguments of one ``ifc_measure`` call, as the model sees them."""

    operation: _literal(OPERATIONS) = Field(
        description=(
            "WHICH question to ask. The only required argument — every other field is scoped by this "
            "one. On a model you have not looked at yet, 'briefing'."
        )
    )
    global_id: str | list[str] = Field(
        default="",
        description=(
            "The element's IFC GlobalId, from 'find_elements', from 'element', or from an ifc_query "
            "result in THIS turn — an invented id is refused by name, not guessed at. Usually ONE id. "
            "A list (or one comma-separated string) where the question is about a set: 'measure' over "
            f"an already-known selection (at most {MAX_BATCH}, each element keeping its own answer, "
            "tolerance and refusal), 'view' to mark several at once, 'fire' with kind='compartmentArea' "
            "for the rooms of the compartment — and exactly two rooms for kind='separatingElements'. "
            "'envelope' takes none: an envelope is not a property of an element. The selecting "
            "operations ('find_elements', 'survey', 'draw') and the whole-model ones need none either."
        ),
    )
    other_global_id: str | list[str] = Field(
        default="",
        description=(
            "The SECOND element, and it means a different thing per operation. 'distance' and "
            "'clearance': the element to measure against. 'overhang': the element whose outer face is "
            "the REFERENCE plane, while global_id is the projecting one (get it from "
            "relations/hostedIn on the window). 'light_incidence': the elements EXCLUDED from the test "
            "— a list, or several ids separated by commas. Unused by every other operation."
        ),
    )
    relation: _literal(RELATIONS) | None = Field(
        default=None,
        description=(
            "'relations' only — which topological question to ask about global_id:\n"
            f"{_enum_lines(RELATIONS)}\n"
            "The ones marked [geometry] cost seconds on a cold model — see COST."
        ),
    )
    measure: _literal(MEASURES) | None = Field(
        default=None,
        description=(
            f"'measure' (one element) and 'survey' (a whole selection) — WHICH quantity:\n{_enum_lines(MEASURES)}"
        ),
    )
    mode: _literal(DISTANCE_MODES, VIEW_MODES) | None = Field(
        default=None,
        description=(
            "Two vocabularies on one field, scoped by operation.\n"
            "  'distance' (default 'min'):\n"
            f"{_enum_lines(DISTANCE_MODES, indent='    ')}\n"
            "  NONE of those four is a clear dimension. For a lichte Breite use measure='clearWidth' on "
            "the opening, for a lichte Höhe measure='clearHeight' on the room, and for the smallest "
            "surface-to-surface gap between two elements operation='clearance'.\n"
            "  'view' (default 'highlight'):\n"
            f"{_enum_lines(VIEW_MODES, indent='    ')}\n"
            "Unused by every other operation."
        ),
    )
    ifc_type: str = Field(
        default="",
        description=(
            "'find_elements', 'survey' and 'draw' — the IFC CLASS, e.g. IfcSpace, IfcWindow, IfcDoor. "
            "The spatial role goes in 'kind' instead."
        ),
    )
    name_contains: str = Field(
        default="",
        description=(
            "'find_elements' and 'survey' — a substring of the element's name. Take it from the "
            "briefing or from an earlier result; an invented fragment matches nothing."
        ),
    )
    storey: str = Field(
        default="",
        description=(
            "'find_elements', 'survey', 'draw' and 'view' — the storey name EXACTLY as the briefing "
            "spells it. A storey name you invented matches nothing, and an empty result reads like "
            "'the building has none'."
        ),
    )
    kind: _literal(KINDS, FIRE_ASPECTS, ENVELOPE_ASPECTS, PROFILE_KINDS) | None = Field(
        default=None,
        description=(
            "Three vocabularies on one field, scoped by operation.\n"
            "  'find_elements' and 'survey' — the spatial ROLE, not the IFC type (a room is 'space'): "
            f"{', '.join(KINDS)}.\n"
            "  'fire' — which OIB 2 (Brandschutz) geometry, default 'fluchtniveau':\n"
            f"{_enum_lines(FIRE_ASPECTS, indent='    ')}\n"
            "  'envelope' — which OIB 6 (Wärmeschutz) geometry of the WHOLE building, default "
            "'thermalEnvelope':\n"
            f"{_enum_lines(ENVELOPE_ASPECTS, indent='    ')}\n"
            "  'element_profile' — 'expensive' to include escape route, reachability, turning circle "
            "and door approach, which are left out otherwise.\n"
            "Unused by every other operation."
        ),
    )
    room_kind: _literal(ROOM_KINDS) | None = Field(
        default=None,
        description=(
            "'room_inventory' only — which SUSPECTED use to group the rooms by. Inferred from their "
            "names: a proposal for a human to confirm, never a finding."
        ),
    )
    model_name: str = Field(
        default="",
        description=(
            "A substring of the file name, to pick one model when the project has several. Leave it "
            "empty when there is only one."
        ),
    )
    limit: int = Field(
        default=0,
        description=(
            "How many rows: 'find_elements' up to 500, 'survey' up to 50 — every row there is a real "
            "geometric measurement and not an index lookup. 0 leaves the server's default."
        ),
    )
    # `None`, not `0.0`: „not given" must stay distinguishable from „zero
    # degrees". The bounds are the tool's own, so the schema refuses what the
    # engine would.
    angle_deg: float | None = Field(
        default=None,
        gt=0.0,
        lt=90.0,
        description=(
            "'light_incidence' only — the Lichteinfallswinkel in degrees, strictly between 0 and 90. "
            "It is a fact about the BESTIMMUNG and not about the model (OIB 3: 45, with swivel_deg 30). "
            "This tool refuses without it rather than defaulting, because supplying it would be "
            "applying the clause."
        ),
    )
    swivel_deg: float | None = Field(
        default=None,
        ge=0.0,
        lt=90.0,
        description=(
            "'light_incidence' only — the lateral Verschwenkung in degrees, from 0 to under 90. From "
            "the Bestimmung as well (OIB 3: 30)."
        ),
    )
    when: str = Field(
        default="",
        description=(
            "'sun_position' only — an ISO 8601 instant WITH a time zone, e.g. "
            "'2026-06-21T12:00:00+02:00' (Austrian summer time) or '2026-06-21T10:00:00Z'. A timestamp "
            "without a zone is refused rather than read as UTC: Austria runs UTC+1 and UTC+2, so "
            "reading 12:00 as UTC moves the sun 30° east of where it stood."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _fold_case(cls, data: Any) -> Any:
        """Case-fold what the tool has always case-folded, and keep the ledger.

        A ``Literal`` is case-sensitive; ``kind='Compactness'`` has always been
        answered, so the canonical spelling is substituted before the enum
        runs. Whatever is still unknown afterwards is left for the ``Literal``
        to refuse — after :func:`record_gap` has written down what was wanted,
        because the refusal never reaches the tool body and the backlog would
        otherwise go quiet exactly as refusals got cheaper.
        """
        if not isinstance(data, dict):
            return data
        data = dict(data)
        for name, vocabulary in _CASE_FOLDED.items():
            asked = data.get(name)
            if isinstance(asked, str) and asked.strip():
                data[name] = _canonical(asked, vocabulary)
        _record_misses(data)
        return data

    @field_validator("ifc_type", "name_contains", "storey", "model_name", "when", mode="after")
    @classmethod
    def _stripped(cls, value: str) -> str:
        return value.strip()

    @field_validator("global_id", "other_global_id", mode="after")
    @classmethod
    def _ids_on_one_line(cls, value: str | list[str]) -> str:
        """A real array where the wire can carry one, a comma string underneath.

        The engine's `highlight`, `only` and `exclude` have always been arrays,
        and this field was narrower than they were: a caller who had a list had
        to know to join it. `list[str]` is expressible in the wire schema — it
        is an ordinary `type: array` and needs no `anyOf` gymnastics — so it is
        offered, and the comma-separated string every existing caller and the
        whole description already use is normalised onto it rather than
        deprecated. Both reach the call builders as the one shape they parse.
        """
        parts = value if isinstance(value, list) else str(value).split(",")
        return ",".join(str(part).strip() for part in parts if str(part).strip())

    @model_validator(mode="after")
    def _a_batch_fits_in_one_call(self) -> "IfcMeasureInput":
        """The engine's own ceiling, applied before the model is downloaded.

        `measure` over more than :data:`MAX_BATCH` ids is refused by the engine
        — but only after the file has been resolved, fetched and tessellated,
        which is seconds and one of five turns spent to be told to count. Every
        other operation that takes a list has no such ceiling, so none is
        invented for them here.
        """
        if self.operation == "measure":
            count = len([part for part in str(self.global_id).split(",") if part])
            if count > MAX_BATCH:
                raise ValueError(
                    f"operation='measure' takes at most {MAX_BATCH} GlobalIds in one call — "
                    f"{count} were given. Measure in several calls, or narrow the selection with "
                    "operation='survey', which selects and measures in one."
                )
        return self


_TOOL_DESCRIPTION = (
    "MEASURE the project's IFC/BIM model — geometry, topology and spatial relationships — and report "
    "every number with the provenance it came with. Use this when the answer is a DIMENSION, a "
    "DISTANCE, an AREA the export may not have published, or a spatial relationship ('which room does "
    "this window open into', 'wie hoch ist der Raum wirklich', 'wie weit ist die Tür von der Wand', "
    "'welche Bauteile begrenzen diesen Raum').\n"
    "\n"
    "This is NOT a replacement for ifc_query. ifc_query reads the extracted index: it is fast, it "
    "covers the whole model, and it answers what the export WROTE DOWN — counts, storeys, property "
    "values, published quantities. Reach for it first for 'how many' and 'which ones'. Reach for "
    "ifc_measure when the file does not state the number and the geometry has to be read, or when a "
    "declared number needs a second, independent route to check it against.\n"
    "\n"
    "CALL 'briefing' FIRST, once per model, before anything else. The briefing is this FILE speaking: "
    "it names the storeys with their elevations, the property vocabulary this exporter actually used "
    "(DIALEKT), and — the part that saves whole turns — the BLIND section, which says which questions "
    "this file cannot answer at all. Storey and property names come from THERE, copied verbatim. A "
    "storey name you invented matches nothing, and an empty result reads like 'the building has none'.\n"
    "\n"
    "The parameter list says WHICH arguments each operation takes and what every enum value means. "
    "What follows is what each operation is FOR — the judgement the schema cannot carry.\n"
    "\n"
    "  'briefing'       — this file speaking about itself. Free, no geometry. START HERE.\n"
    "  'find_elements'  — GlobalIds by type, name, storey or spatial role. The input every other "
    "operation needs. Free, no geometry.\n"
    "  'element'        — everything about ONE element, including which relations it actually has, so "
    "a relation that would come back empty need not be guessed at. Free, no geometry.\n"
    "  'relations'      — one topological question about one element.\n"
    "  'measure'        — one measurement of one element, or of an already-known set of them.\n"
    "  'survey'         — ONE measure across ALL elements of a selection, each named, with the SPREAD "
    "over the set. Reach for this the moment the question is plural — 'wie hoch ist der Keller' names "
    "one room and means seventeen, and 'all 17 at 2.70 m' and '16 at 2.70 m, one at 0.25 m' are "
    "different answers to it. Measuring one element and generalising supports neither, whichever "
    "element you picked. The spread IS the finding; report it.\n"
    "  'element_profile' — the reverse: EVERY measure that applies to ONE element, in one call. Which "
    "measures apply follows from the element's IFC type, so a door is not asked for its lichte "
    "Raumhöhe. Reach for it once an element has become interesting — the outlier a survey named — "
    "instead of guessing one measure at a time.\n"
    "  'distance'       — the distance between TWO elements, along an axis, between centroids or "
    "boxes. An Achsabstand, never a clear dimension.\n"
    "  'clearance'      — the LICHTE dimension between TWO elements: the smallest SURFACE-to-SURFACE "
    "gap. This is the number 'distance' does not have — its 'min' is a gap between BOUNDING BOXES, and "
    "on the sample house's pitched roof against the interior partition that reads 0.000 m where the "
    "clear dimension is 0.995 m, because the roof's box swallows the wall's. A box gap is a lower "
    "bound on a clearance and never an upper one, so it errs in the direction where too tight passes "
    "as free. For the clear width of ONE opening use 'measure' with clearWidth instead — an opening "
    "has two reveals but is one element.\n"
    "  'sun_position'   — where the sun stood over this building at an instant: azimuth, altitude, and "
    "the direction TOWARDS the sun in THIS model's coordinates. NOT a Besonnungsstudie: it says where "
    "the sun was, never whether the neighbour's gable was in the way — that needs everything outside "
    "the property line, which is not in the file, and the caveat says so. Undecidable without "
    "IfcSite.RefLatitude/RefLongitude, and no latitude is assumed: an assumed Vienna on a Vorarlberg "
    "project is 1.4° out in altitude and would come back as a measured number with a tolerance. This "
    "tool therefore takes no coordinates at all.\n"
    "  'storey_heights' — the storey pitch (slab top to slab top) for every storey. This is the "
    "STRUCTURAL height, NOT the lichte Raumhöhe — never use it for a Raumhöhennachweis, use 'measure' "
    "with clearHeight.\n"
    "  'room_inventory' — rooms grouped by a SUSPECTED use, inferred from their names. A proposal for "
    "a human to confirm, never a finding.\n"
    "  'fire'           — the OIB 2 (Brandschutz) geometry. NO Gebäudeklasse: fluchtniveau returns a "
    "HEIGHT, and which class follows from it is a legal classification under OIB 2 plus Landesrecht.\n"
    "  'envelope'       — the OIB 6 (Wärmeschutz) geometry of the WHOLE building. Asking wall by wall "
    "is how the wall that was left out stays invisible, so it takes no element. No U-value is "
    "CALCULATED: a declared one is repeated, a missing one is missing and is never derived from the "
    "layer set, because a U-value computed from a material list is a different number from the one the "
    "architect signed and looks identical. Costs geometry (seconds).\n"
    "  'overhang'       — how far one element projects past another's facade plane. The Dachüberstand, "
    "the balcony, the canopy.\n"
    "  'light_incidence' — builds the light prism over an opening's lower edge and reports which "
    "elements reach into it and how deep. The result is GEOMETRY: a cut prism enlarges the required "
    "Lichteintrittsfläche under OIB 3, it does not ban the window. Report what intrudes and how far, "
    "then apply the clause yourself. The host wall is deliberately not excluded on its own, because a "
    "window set deep in a thick wall genuinely is shaded by its own reveal — but if the wall comes "
    "back as an obstruction, re-run with it excluded (keeping any other exclusion you already had), "
    "and say in the answer that you did and why.\n"
    "  'view'           — LOOK at a floor plan. Returns the storey as an IMAGE you can actually see, "
    "cut at 1.2 m so door and window openings appear as gaps. Use it to settle which element is meant, "
    "to sanity-check that a measured arrangement looks the way the numbers imply, or before measuring "
    "at all. ~6 s. NEVER read a number off it — a dimension taken from a picture is guessed even when "
    "it happens to be right.\n"
    "  'draw'           — the same plan as an SVG FILE for the USER (~5 s). It returns a path, not an "
    "image: you cannot see it. Use 'view' when YOU need to look, 'draw' when the user wants the file.\n"
    "  'shopping_list'  — writes the model's blind spots as a buildingSMART IDS 1.0 file the architect "
    "can run in Solibri/BIMcollab/ifctester against their own model, and re-run after fixing to prove "
    "it landed. Offer it when several answers came back undecidable, or when asked what to fix in the "
    "export. It requires only that a property EXISTS and is evaluable, never what value it must have — "
    "the thresholds are in the OIB Bestimmung. Not every blind spot is expressible; the summary says "
    "how many are and names the rest.\n"
    "\n"
    "PROVENANCE — the reason this tool exists. Every answer says HOW it was obtained, and the three "
    "are three different sentences in German that must not be swapped:\n"
    "  'declared' → „laut Modell …“ / „das Modell deklariert …“. The file states it.\n"
    "  'computed' → „gemessen: … (±Toleranz)“. WE measured it from the geometry. The tolerance is part "
    "of the claim — quote it. NEVER write a computed number as something the model states.\n"
    "  'inferred' → „vermutlich …“ plus the reasons. A heuristic, offered for confirmation, never a "
    "finding. room_inventory is always this: whether a room is an Aufenthaltsraum is a LEGAL "
    "classification, not a geometric one.\n"
    "The rendered summary line already carries the right verb — quote that line rather than "
    "reassembling the claim yourself.\n"
    "\n"
    "'decidable: false' is NOT an error and NOT a fact about the building. It means the question was "
    "well formed and THIS EXPORT cannot answer it. Report it as a finding about the export, name what "
    "is missing, and pass on 'missing.remedy' verbatim — that sentence is what the architect changes "
    "in their CAD to make the question answerable. Saying 'the building has no sill height' when the "
    "file merely does not publish one is a wrong answer.\n"
    "\n"
    "NEVER recompute, round, convert or extrapolate a number this tool returns. Do not add two areas "
    "together, do not derive a third dimension from two others, do not restate a millimetre value in "
    "centimetres. If a question needs a number that was not returned, make another call — arithmetic "
    "done in an answer is a guess wearing the tool's authority. And NEVER read a measurement off a "
    "drawing: 'draw' shows the arrangement, 'measure' and 'distance' give the numbers, and a value "
    "read off an image is guessed even when it happens to be right.\n"
    "\n"
    "COST — plan the calls before making them. 'briefing', 'find_elements' and 'element' are free "
    "(pure topology). The first 'measure' or 'distance' on a model tessellates it (~2 s for a "
    "single-family house). The geometric relations opensTo / bounds / enclosedBy / adjacentSpaces "
    "build a space-contact map on first use — around 7 seconds on a cold model — because most exports "
    "write no IfcRelSpaceBoundary and it has to be derived. 'draw' is ~5 s. After that everything is "
    "milliseconds, because the model stays parsed. Do NOT call the geometric relations speculatively "
    "or 'to see what is there' — call them when the answer needs them.\n"
    "\n"
    "Every GlobalId you pass must come from 'find_elements', from 'element', or from an ifc_query "
    "result in THIS turn. An invented GlobalId is refused by name, not guessed at.\n"
    "\n"
    "A typical chain — 'ist die Raumhöhe im Wohnzimmer ausreichend?':\n"
    "  1. operation='briefing' → the storey names and what this file cannot answer\n"
    "  2. operation='find_elements' ifc_type='IfcSpace' name_contains='Wohn' storey='Erdgeschoss'\n"
    "  3. operation='measure' global_id='<the GlobalId from step 2>' measure='clearHeight' — or, if the "
    "question is really about the storey and not that one room, operation='survey' measure='clearHeight' "
    "storey='Erdgeschoss', which measures all of them and gives the spread\n"
    "  4. report the rendered line as it stands — gemessen, with its tolerance and its caveat\n"
    "\n"
    "When the model cannot be resolved the tool says so in German — report that sentence rather than "
    "answering from your own knowledge of buildings.\n"
    "\n"
    "A measurement that contradicts a declared quantity is reported as a contradiction ('Widerspruch'), "
    "and that is a FINDING an architect wants before submission: their schedule and their geometry "
    "disagree. Report both numbers and which one the tool preferred; do not silently pick one."
)


# ── the engine call ──────────────────────────────────────────────────────────
#
# The vocabularies are the schema's business: by the time a call is built here
# every enum has been case-folded and refused by `IfcMeasureInput`. What is left
# to decide is what the schema cannot say — which fields an operation needs,
# which of `kind`'s four vocabularies applies to it, and the engine's own
# argument names.

_EngineCall = tuple[str, dict[str, Any]]

#: The operations that are about ONE element, and refuse without it.
_SUBJECT_OPERATIONS = frozenset({"element", "relations", "measure", "element_profile", "clearance", "distance"})

#: Which vocabulary a refused field is listed against, for the sentence.
_VOCABULARIES: dict[str, Sequence[str]] = {
    "relation": tuple(RELATIONS),
    "measure": tuple(MEASURES),
    "mode": (*DISTANCE_MODES, *VIEW_MODES),
    "kind": _ALL_KINDS,
    "room_kind": ROOM_KINDS,
}


_KIND_ADVICE = "'kind' is the spatial ROLE (a room is 'space'); an IFC type goes in 'ifc_type'."
_MODE_ADVICE = (
    "All four are AXIS distances between centroids or boxes — none is a clear dimension. "
    "For a lichte Breite use operation='measure' with measure='clearWidth' on the opening, and "
    "for a lichte Höhe measure='clearHeight' on the room."
)

#: What a refused field's sentence goes on to say, where the vocabulary alone misleads.
_ADVICE = {"kind": _KIND_ADVICE, "mode": _MODE_ADVICE}


def _does_not_exist(field: str, asked: Any, vocabulary: Sequence[str]) -> str:
    advice = _ADVICE.get(field)
    return f"Error: {field} '{asked}' does not exist. Use one of: {', '.join(vocabulary)}." + (
        f" {advice}" if advice else ""
    )


def _needs(operation: str, field: str, vocabulary: Sequence[str]) -> str:
    return f"Error: operation '{operation}' needs '{field}'. Use one of: {', '.join(vocabulary)}."


def _ids(text: str) -> list[str]:
    return [part.strip() for part in text.split(",") if part.strip()]


def _selection_args(a: IfcMeasureInput, ceiling: int) -> dict[str, Any] | str:
    """The filter half `find_elements` and `survey` share. `kind` is the spatial ROLE here, never an aspect."""
    args: dict[str, Any] = {"limit": max(1, min(a.limit, ceiling))}
    for key, value in (("ifcType", a.ifc_type), ("nameContains", a.name_contains), ("storey", a.storey)):
        if value:
            args[key] = value
    if a.kind is None:
        return args
    if a.kind not in KINDS:
        return _does_not_exist("kind", a.kind, KINDS)
    args["kind"] = a.kind
    return args


def _find_elements_call(a: IfcMeasureInput) -> _EngineCall | str:
    args = _selection_args(a, 500)
    return args if isinstance(args, str) else ("find_elements", args)


def _survey_call(a: IfcMeasureInput) -> _EngineCall | str:
    """Selection and measurement in one call, capped at 50: every row is a real geometric measurement."""
    if a.measure is None:
        return _needs("survey", "measure", tuple(MEASURES))
    args = _selection_args(a, 50)
    return args if isinstance(args, str) else ("survey", {"measure": a.measure, **args})


def _sun_position_call(a: IfcMeasureInput) -> _EngineCall | str:
    """No latitude field, deliberately: an assumed Vienna on a Vorarlberg project is 1.4° out and looks measured."""
    if not a.when:
        return (
            "Error: sun_position needs 'when' — an ISO 8601 instant WITH a time zone, e.g. "
            "'2026-06-21T12:00:00+02:00' (Austrian summer time) or '2026-06-21T10:00:00Z'. A "
            "timestamp without a zone is refused rather than read as UTC: Austria runs UTC+1 and "
            "UTC+2, so reading 12:00 as UTC moves the sun 30° east of where it stood."
        )
    return "sun_position", {"when": a.when}


def _overhang_call(a: IfcMeasureInput) -> _EngineCall | str:
    if not a.global_id or not a.other_global_id:
        return (
            "Error: overhang needs TWO elements — global_id is the projecting one (the roof, the "
            "balcony) and other_global_id the one whose facade plane is the reference (the wall "
            "under it). Get the wall from relations/hostedIn on the window."
        )
    return "overhang", {"projecting": a.global_id, "facade": a.other_global_id}


def _light_incidence_call(a: IfcMeasureInput) -> _EngineCall | str:
    """The angle is refused rather than defaulted to 45: it is a fact about the CLAUSE, not the model."""
    if not a.global_id:
        return "Error: light_incidence needs global_id — the opening, or the window that fills it."
    if a.angle_deg is None:
        return (
            "Error: light_incidence needs angle_deg, and it must be between 0 and 90. The angle "
            "comes from the Bestimmung, not from the model — for OIB 3 that is 45, with "
            "swivel_deg 30. This tool does not supply it, because supplying it would be applying "
            "the clause."
        )
    args: dict[str, Any] = {"globalId": a.global_id, "angle": float(a.angle_deg)}
    if a.swivel_deg is not None:
        args["swivel"] = float(a.swivel_deg)
    # A list: a window deep in a thick wall is shaded by its own reveal AND by
    # the roof, and re-running "without the host wall" must keep the roof.
    if a.other_global_id:
        args["exclude"] = _ids(a.other_global_id)
    return "light_incidence", args


def _room_inventory_call(a: IfcMeasureInput) -> _EngineCall | str:
    if a.room_kind is None:
        return _needs("room_inventory", "room_kind", ROOM_KINDS)
    return "room_inventory", {"kind": a.room_kind}


def _fire_call(a: IfcMeasureInput) -> _EngineCall | str:
    aspect = a.kind or "fluchtniveau"
    if aspect not in FIRE_ASPECTS:
        return f"Error: for operation 'fire', kind must be one of: {', '.join(FIRE_ASPECTS)}. Got '{a.kind}'."
    args: dict[str, Any] = {"what": aspect}
    if a.global_id:
        args["globalId"] = a.global_id
    return "fire", args


def _envelope_call(a: IfcMeasureInput) -> _EngineCall | str:
    """Whole-model only: no `globalId` is forwarded, because the engine's schema does not accept one."""
    aspect = a.kind or "thermalEnvelope"
    if aspect not in ENVELOPE_ASPECTS:
        return f"Error: for operation 'envelope', kind must be one of: {', '.join(ENVELOPE_ASPECTS)}. Got '{a.kind}'."
    return "envelope", {"what": aspect}


def _view_call(a: IfcMeasureInput) -> _EngineCall | str:
    """`global_id` is a list here: "where is this" is usually about a pair — the window AND its wall."""
    mode = a.mode or "highlight"
    if mode not in VIEW_MODES:
        return (
            "Error: for operation 'view', mode must be 'highlight' (mark these elements, keep the "
            "rest of the plan) or 'only' (draw nothing else). Default is 'highlight'."
        )
    ids = _ids(a.global_id)
    if mode == "only" and not ids:
        return "Error: mode='only' needs at least one global_id — otherwise there is nothing to draw."
    args: dict[str, Any] = {}
    if a.storey:
        args["storey"] = a.storey
    if ids:
        args[mode] = ids
    return "view", args


def _draw_call(a: IfcMeasureInput) -> _EngineCall:
    args: dict[str, Any] = {}
    if a.storey:
        args["storey"] = a.storey
    if a.ifc_type:
        args["include"] = [a.ifc_type]
    return "draw", args


def _relations_call(a: IfcMeasureInput) -> _EngineCall | str:
    if a.relation is None:
        return _needs("relations", "relation", tuple(RELATIONS))
    return "relations", {"globalId": a.global_id, "relation": a.relation}


def _measure_call(a: IfcMeasureInput) -> _EngineCall | str:
    if a.measure is None:
        return _needs("measure", "measure", tuple(MEASURES))
    return "measure", {"globalId": a.global_id, "measure": a.measure}


def _element_profile_call(a: IfcMeasureInput) -> _EngineCall:
    """`kind='expensive'` opts into escape route, reachability, turning circle and door approach."""
    args: dict[str, Any] = {"globalId": a.global_id}
    if a.kind == "expensive":
        args["include"] = "expensive"
    return "element_profile", args


def _clearance_call(a: IfcMeasureInput) -> _EngineCall | str:
    if not a.other_global_id:
        return (
            "Error: clearance needs TWO elements — set 'global_id' and 'other_global_id'. For the "
            "clear width of ONE opening use operation='measure' with measure='clearWidth': an "
            "opening has two reveals but is only one element."
        )
    return "clearance", {"a": a.global_id, "b": a.other_global_id}


def _distance_call(a: IfcMeasureInput) -> _EngineCall | str:
    if not a.other_global_id:
        return "Error: operation 'distance' needs two elements — set 'global_id' and 'other_global_id'."
    mode = a.mode or "min"
    if mode not in DISTANCE_MODES:
        return _does_not_exist("mode", a.mode, tuple(DISTANCE_MODES))
    return "distance", {"a": a.global_id, "b": a.other_global_id, "mode": mode}


_CALL_BUILDERS: dict[str, Callable[[IfcMeasureInput], _EngineCall | str]] = {
    # Always the rendered TEXT: the briefing's job is to be read into context and copied out of.
    "briefing": lambda a: ("briefing", {"format": "text"}),
    "find_elements": _find_elements_call,
    "element": lambda a: ("element", {"globalId": a.global_id}),
    "relations": _relations_call,
    "measure": _measure_call,
    "survey": _survey_call,
    "element_profile": _element_profile_call,
    "distance": _distance_call,
    "clearance": _clearance_call,
    "sun_position": _sun_position_call,
    "storey_heights": lambda a: ("storey_heights", {}),
    "room_inventory": _room_inventory_call,
    "draw": _draw_call,
    "view": _view_call,
    "shopping_list": lambda a: ("shopping_list", {}),
    "fire": _fire_call,
    "envelope": _envelope_call,
    "overhang": _overhang_call,
    "light_incidence": _light_incidence_call,
}


def _engine_call(arguments: IfcMeasureInput, default_limit: int = 50) -> _EngineCall | str:
    """The engine tool name and its arguments, or a correctable error string.

    Refusing here — before the model is resolved and long before it is parsed
    — is what makes the mistake correctable in the same turn.
    """
    if arguments.operation in _SUBJECT_OPERATIONS and not arguments.global_id:
        return (
            f"Error: operation '{arguments.operation}' needs a global_id (the element's IFC GlobalId). "
            "Get one from operation='find_elements' — never invent one."
        )
    with_limit = arguments.model_copy(update={"limit": arguments.limit or default_limit})
    return _CALL_BUILDERS[arguments.operation](with_limit)


def _refusal(exc: ValidationError) -> str:
    """The schema's refusal as the sentence the ToolNode hands the agent: one message, the permitted values in it."""
    error = exc.errors()[0]
    field = str(error["loc"][0]) if error["loc"] else "arguments"
    asked = error.get("input")
    if field == "operation":
        return f"Error: unknown operation '{asked}'. Use one of: {', '.join(sorted(VALID_OPERATIONS))}."
    if error["type"] == "literal_error" and field in _VOCABULARIES:
        return _does_not_exist(field, asked, _VOCABULARIES[field])
    return f"Error: {field}: {error['msg']}"


def _build_call(**arguments: Any) -> _EngineCall | str:
    """The tool minus the I/O: validate the way the wire does, then build.

    The tool body holds a validated model and calls :func:`_engine_call`; this
    is the seam the tests and the question battery drive with loose keyword
    arguments. An empty string means "not given", as it always has.
    """
    given = {name: value for name, value in arguments.items() if value != ""}
    try:
        parsed = IfcMeasureInput.model_validate(given)
    except ValidationError as exc:
        return _refusal(exc)
    return _engine_call(parsed)


# ── rendering ────────────────────────────────────────────────────────────────


def _decimals(tolerance: Any) -> int | None:
    """How many decimals a value carrying this tolerance may be shown to.

    One decade finer than the band and no more, so nothing the operator resolved
    is thrown away and nothing it did not is invented.

    This used to `ceil` the logarithm, which rounds a tolerance UP to the next
    decade before counting: ±0.005 m earned four decimals (0.1 mm — fifty times
    finer than the band) and ±3° earned one (0.1° — thirty times). Only exact
    powers of ten came out right, which is why it looked correct on ±0.01.

    `floor` makes the tolerance's own leading digit set the scale, so the shown
    resolution is always between one and ten times finer than the band: ±0.005 m
    earns three decimals (0.647 m), ±3° earns none (0°), ±0.15 m² earns one
    (15.4 m²). That last one is the change most likely to look like a
    regression and is the clearest case of the fix — a 15-centimetre band does
    not support a centimetre digit, and printing 15.42 claimed it did.
    """
    if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)):
        return None
    # NaN and inf reach here from a division in an operator, and `math.log10`
    # would raise on one and overflow the decimal count on the other.
    if not math.isfinite(tolerance) or tolerance <= 0:
        return None
    return min(6, max(0, math.floor(-math.log10(tolerance)) + 1))


def _num(value: Any, decimals: int | None = None) -> str:
    """A number as the engine produced it, to the precision it actually has.

    The rule used to be "never round", on the reasoning that a renderer which
    reshapes a value breaks the tool's only claim. That reasoning was right and
    the conclusion was wrong, and the battery showed why: `floorArea` rendered
    as „gemessen (±0.15416781250000042 m²): 15.41678125000004 m²“.

    Seventeen digits against a 15-centimetre band is not fidelity, it is a
    binary-float artifact wearing the costume of a measurement. It is LESS
    faithful than 15.42, because it asserts precision the operator explicitly
    disclaims — and the model reading it will quote the digits, because we told
    it that numbers come from the tool and are never to be re-rounded.

    So the value is shown to its tolerance and to nothing else. Where there is
    no tolerance — a `declared` figure, a confidence — the value is the file's
    own statement and is passed through untouched, which is the case the old
    rule was really protecting.
    """
    if isinstance(value, bool) or value is None:
        return str(value)
    if isinstance(value, float):
        if decimals is not None:
            return f"{value:.{decimals}f}"
        return repr(value)
    return str(value)


def _tolerance_text(tolerance: Any) -> str:
    """The band itself, at two significant figures.

    Its OWN rule, not the value's. Sharing `_decimals` meant the band was
    rounded to the precision it had just authorised for the value, so a
    tolerance of 0.154 m² printed as „±0.2 m²" — rounded UP by a third, and in
    the direction that overstates our own uncertainty. Two significant figures
    is what an error estimate can carry, and trailing zeros are stripped so
    ±0.005 stays ±0.005 rather than becoming ±0.0050.
    """
    if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)):
        return _num(tolerance)
    value = float(tolerance)
    if not math.isfinite(value) or value <= 0:
        return _num(tolerance)
    # Two significant figures: one decade past the leading digit.
    decimals = min(6, max(0, math.floor(-math.log10(value)) + 2))
    text = f"{value:.{decimals}f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def _angle(value: Any) -> str:
    """An angle the CALLER supplied, echoed back as they wrote it.

    45.0° is not a measurement with a hundredth of a degree behind it; it is the
    number the clause states, round-tripped through a float. Printing it as „45"
    keeps the parameter distinguishable from everything else on the line, which
    is measured.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return str(value)
    return str(int(value)) if float(value).is_integer() else _num(float(value), 1)


#: Keys whose value is DIMENSIONLESS and must not inherit the answer's band.
#:
#: `_decimals` derives its precision from the answer's tolerance, which carries
#: the answer's UNIT. Applied to a ratio that is a different quantity entirely,
#: it destroys the number: `envelope/areaByOrientation` has a tolerance of
#: ±2.3 m², which earns zero decimals, and the window-to-wall ratios then
#: rendered `windowWallRatio=0` for north (0.193), south (0.405) and the
#: building as a whole (0.177). The WWR is the entire point of that operator,
#: and a facade reported at 0 reads as one with no glazing in it — a claim about
#: the building, made by a rounding rule, and false.
#:
#: Two decimals rather than the band's, because these are ratios in 0…1 and
#: their own resolution has nothing to do with how well an area was measured.
#:
#: Bare `ratio` is deliberately NOT in this set, and the exclusion is the whole
#: reason the set is a set rather than a regex on the name. Two operators return
#: a key called `ratio` and only one of them is unitless:
#: `lightEntryArea.ratio` is a fraction, but `compactness.ratio` is A/V in
#: **1/m** — the answer's own main value, whose ±0.021 1/m band is exactly the
#: right precision for it. Overriding that one would be this same bug pointed
#: the other way. `lightEntryArea` loses nothing by the omission: its headline
#: line already states the share as „**14.21 %**" at full precision.
_UNITLESS_KEYS = frozenset({"windowWallRatio", "percent", "confidence"})


def _value_text(value: Any, decimals: int | None = None) -> str:
    """The answer's value as one readable line."""
    if value is None:
        return "—"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _num(value, decimals)
    if isinstance(value, dict):
        # `extent`, `elevation`, `sillAndHead` — a handful of named numbers.
        # Nested one level (extent's `box`), the flat join produced
        # "box=min=[…], max=[…]", which reads as one key with two values.
        parts = []
        for key, inner in value.items():
            text = _value_text(inner, 2 if key in _UNITLESS_KEYS else decimals)
            parts.append(f"{key}=({text})" if isinstance(inner, dict) else f"{key}={text}")
        return ", ".join(parts)
    if isinstance(value, list):
        # A coordinate is a list of three numbers, and counting it — "centroid=3
        # Einträge" — throws away the only part anybody wanted.
        if value and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
            return "[" + ", ".join(_num(item, decimals) for item in value) + "]"
        # German has a singular, and a renderer that substitutes into one
        # template produces "1 Einträge" in an answer an architect reads.
        return "1 Eintrag" if len(value) == 1 else f"{len(value)} Einträge"
    return str(value)


def _element_line(entry: dict[str, Any]) -> str:
    label = entry.get("name") or entry.get("globalId")
    via = f" (über {entry['via']})" if entry.get("via") else ""
    return f"- {entry.get('ifcType')} „{label}“ · GlobalId {entry.get('globalId')}{via}"


def _provenance_line(answer: dict[str, Any]) -> str:
    """The one line the agent quotes — with the right German verb in front.

    Three provenances, three sentences, and a fourth for the undecidable case.
    They are written out rather than composed from a template on purpose: the
    difference between „das Modell deklariert 15,4 m²“ and „gemessen: 15,4 m²
    (±5 mm)“ is the difference between reporting the architect's own statement
    and reporting ours, and a reader has to be able to tell which they are being
    handed.
    """
    if not answer.get("decidable", True):
        missing = answer.get("missing") or {}
        what = missing.get("what") or "die nötige Angabe"
        remedy = missing.get("remedy") or ""
        # Two sentence forms, because `missing.what` comes in two grammatical
        # shapes and one template cannot carry both. Around thirty of them
        # across the package are already negated („keine IfcSpace-Elemente"),
        # and „liefert keine IfcSpace-Elemente nicht" is not German — read
        # literally it says the opposite of the finding.
        #
        # Fixed here rather than by rewriting thirty German strings: the
        # renderer owns the sentence, so the renderer is where the agreement
        # belongs, and a string added tomorrow gets it for free.
        negated = re.match(r"kein(e|en|er|es)?\b", what.strip(), re.IGNORECASE)
        opening = f"dieser Export enthält {what}" if negated else f"dieser Export liefert {what} nicht"
        return f"NICHT ENTSCHEIDBAR: {opening}. Das ist ein Befund über den EXPORT, nicht über das Gebäude." + (
            f" Abhilfe: {remedy}" if remedy else ""
        )

    text = _value_with_unit(answer)
    tolerance = answer.get("tolerance")
    unit = answer.get("unit")
    provenance = answer.get("provenance")

    if provenance == "declared":
        return f"deklariert: {text} — so steht es in der Datei."
    if provenance == "inferred":
        confidence = answer.get("confidence")
        band = f" (Konfidenz {_num(confidence)})" if confidence is not None else ""
        return f"vermutlich: {text}{band} — ein Vorschlag zur Bestätigung, keine Feststellung."
    # The tolerance is always a scalar in the value's unit, whatever shape the
    # value itself has — so it takes the plain unit, not the parenthesised one.
    band = f" (±{_tolerance_text(tolerance)}{' ' + unit if unit else ''})" if tolerance is not None else ""
    return f"gemessen{band}: {text} — aus der Geometrie berechnet, nicht deklariert."


def _value_with_unit(answer: dict[str, Any]) -> str:
    """The answer's value, rounded to its band and carrying its unit.

    Split out of :func:`_provenance_line` so the Herleitung card and the
    sentence the agent reads are formatted by ONE function. A card that
    re-derives „2,70 m" from the same envelope is a second implementation of a
    rounding rule, and the first time the two disagree the surface that exists
    to prove the derivation is the one contradicting it.
    """
    unit = answer.get("unit")
    value = answer.get("value")
    # A declared figure is the file's own statement and is never re-rounded; a
    # measured one is shown to its band and no further.
    decimals = _decimals(answer.get("tolerance")) if answer.get("provenance") == "computed" else None
    text = _value_text(value, decimals)
    # A unit belongs after a NUMBER. Appended to a list or to a set of named
    # numbers it produces "2 Einträge m" and "sill=0.9, head=2.11 m", the second
    # of which reads as though only the last figure carried the unit.
    scalar = isinstance(value, (int, float)) and not isinstance(value, bool)
    suffix = (f" {unit}" if scalar else f" ({unit})") if unit else ""
    return f"{text}{suffix}"


def _computed_decimals(answer: dict[str, Any]) -> int | None:
    """Decimals for a `computed` value; a declared figure is the file's own statement and is not rounded."""
    return _decimals(answer.get("tolerance")) if answer.get("provenance") == "computed" else None


def _missing_what(answer: dict[str, Any]) -> str:
    return (answer.get("missing") or {}).get("what") or "nicht entscheidbar"


def _all_numbers(value: list) -> bool:
    return bool(value) and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)


def _trailer(answer: dict[str, Any]) -> list[str]:
    """The caveat and the method, which close every special-shape answer."""
    lines: list[str] = []
    if answer.get("caveat"):
        lines.append(f"Hinweis: {answer['caveat']}")
    if answer.get("method"):
        lines.append(f"Methode: {answer['method']}")
    return lines


# ── the special answer shapes ────────────────────────────────────────────────
#
# Three operators answer with a structured value that `_value_text` would
# flatten into „results=17 Einträge": the light-entry area, the egress path and
# the door graph. Each gets its own headline in place of the provenance line.


def _render_light_entry(answer: dict[str, Any], list_limit: int) -> list[str]:
    value = answer["value"]
    decimals = _computed_decimals(answer)
    band = f" (±{_tolerance_text(answer.get('tolerance'))} m²)" if answer.get("tolerance") is not None else ""
    lines = [
        f"gemessen{band}: Lichteintrittsfläche {_num(value.get('lightEntryArea'), decimals)} m² auf "
        f"{_num(value.get('floorArea'), decimals)} m² Bodenfläche = **{_num(value.get('percent'), 2)} %** "
        "— aus der Geometrie berechnet, nicht deklariert."
    ]
    lines += [
        f"- außenliegend: {e.get('ifcType')} „{e.get('name')}“ · {_num(e.get('area'), 3)} m² "
        f"· GlobalId {e.get('globalId')}"
        for e in value.get("openings") or []
    ]
    excluded = (
        ("innenliegend", "NICHT gezählt (innenliegend)"),
        ("unbestimmt", "NICHT gezählt (außen/innen unbestimmt)"),
    )
    for key, label in excluded:
        lines += [
            f"- {label}: {e.get('ifcType')} „{e.get('name')}“ · {_num(e.get('area'), 3)} m² · {e.get('because')}"
            for e in value.get(key) or []
        ]
    return lines + _trailer(answer)


def _leg_row(leg: dict[str, Any]) -> str:
    door = leg.get("tuer") or {}
    to = leg.get("nach") or {}
    target = "INS FREIE" if to.get("kind") == "outside" else to.get("name")
    start = (leg.get("von") or {}).get("name")
    return (
        f"- {start} → {target} durch „{door.get('name')}“ ({_num(leg.get('length'), 2)} m) "
        f"· GlobalId {door.get('globalId')}"
    )


def _render_egress(answer: dict[str, Any], list_limit: int) -> list[str]:
    value = answer["value"]
    room = (value.get("space") or {}).get("name") or "der Raum"
    head = f"gemessen: von „{room}“ führt KEINE Türverbindung ins Freie."
    if value.get("reachesOutside"):
        head = (
            f"gemessen: „{room}“ erreicht das Freie über {value.get('doorCount')} Tür(en), "
            f"Weglänge {_num(value.get('length'), 2)} m — aus der Geometrie berechnet, nicht deklariert."
        )
    return [head, *(_leg_row(leg) for leg in value.get("legs") or []), *_trailer(answer)]


def _render_door_graph(answer: dict[str, Any], list_limit: int) -> list[str]:
    value = answer["value"]
    edges = value.get("edges") or []
    rooms = [n for n in value.get("nodes") or [] if isinstance(n, dict) and n.get("globalId") != "AUSSEN"]
    outside = sum(1 for e in edges if isinstance(e, dict) and e.get("external"))
    room_text = "1 Raum" if len(rooms) == 1 else f"{len(rooms)} Räume"
    door_text = "1 Türverbindung" if len(edges) == 1 else f"{len(edges)} Türverbindungen"
    reached = {node for e in edges if isinstance(e, dict) for node in (e.get("verbindet") or [])}
    stranded = [n for n in rooms if n.get("globalId") not in reached]

    def named(prefix: str, entry: dict[str, Any], tail: str) -> str:
        return f"- {prefix}: {entry.get('ifcType')} „{entry.get('name')}“ · GlobalId {entry.get('globalId')} — {tail}"

    lines = [
        f"gemessen: {room_text}, {door_text}, davon {outside} ins Freie "
        "— aus der Geometrie abgeleitet, nicht deklariert."
    ]
    lines += listed(
        stranded,
        list_limit,
        "Räume ohne Türkante",
        lambda n: named("KEINE Türkante", n, "dieser Raum hat in dieser Datei keinen Ausgang"),
    )
    lines += listed(
        value.get("unbestimmt") or [], list_limit, "unbestimmte Türen", lambda e: named("UNBESTIMMT", e, e.get("warum"))
    )
    lines += listed(
        value.get("ausgeschlossen") or [],
        list_limit,
        "ausgeschlossene Türen",
        lambda e: named("NICHT als Kante gewertet", e, e.get("warum")),
    )
    return lines + _trailer(answer)


#: (does the value have this shape, how to render it) — first match wins.
_ANSWER_SHAPES: tuple[tuple[Callable[[Any], bool], Callable[[dict[str, Any], int], list[str]]], ...] = (
    (lambda v: isinstance(v, dict) and "lightEntryArea" in v, _render_light_entry),
    (lambda v: isinstance(v, dict) and "legs" in v and "reachesOutside" in v, _render_egress),
    (lambda v: isinstance(v, dict) and "nodes" in v and "edges" in v and "unbestimmt" in v, _render_door_graph),
)


def _prism_line(answer: dict[str, Any], decimals: int | None) -> str:
    """FREI or NICHT FREI, with the prism's angles as the caller wrote them."""
    unit = answer.get("unit") or "m"
    prism = answer.get("prism") or {}
    angles = ""
    if prism:
        swivel = f", seitlich {_angle(prism.get('swivelDeg'))}°" if prism.get("swivelDeg") is not None else ""
        angles = f" (Prisma {_angle(prism.get('angleDeg'))}°{swivel})"
    if answer.get("free"):
        return f"FREI{angles}: kein Bauteil ragt in das Prisma."
    value = answer.get("value")
    count = len(value) if isinstance(value, list) else 0
    intruders = [e for e in value if isinstance(e, dict)] if isinstance(value, list) else []
    deepest = max((e.get("intrusionDepth", 0) for e in intruders), default=None)
    depth = f", tiefster Eingriff {_num(deepest, decimals)} {unit}" if deepest is not None else ""
    subject = "1 Bauteil ragt" if count == 1 else f"{count} Bauteile ragen"
    return f"NICHT FREI{angles}: {subject} in das Prisma{depth}."


def _list_entry(entry: Any, answer: dict[str, Any], decimals: int | None) -> str:
    """One row of a list-valued answer, by what the row carries."""
    if not isinstance(entry, dict):
        return f"- {entry}"
    name = entry.get("name") or entry.get("globalId")
    if "intrusionDepth" in entry:
        unit = answer.get("unit") or "m"
        depth = _num(entry.get("intrusionDepth"), decimals)
        return f"- {name} · GlobalId {entry.get('globalId')} · ragt {depth} {unit} in das Prisma"
    if "ifcType" in entry:
        return _element_line(entry)
    if "storey" in entry:
        height = entry.get("height")
        tail = f", Geschoßhöhe {_num(height, decimals)}" if height is not None else ", Geschoßhöhe nicht bestimmbar"
        return f"- {entry.get('storey')}: Höhenlage {_num(entry.get('elevation'), decimals)}{tail}"
    if "confidence" in entry:
        because = ", ".join(entry.get("because") or [])
        return f"- {name} · GlobalId {entry.get('globalId')} · Konfidenz {_num(entry.get('confidence'))}" + (
            f" ({because})" if because else ""
        )
    return f"- {entry}"


def _render_answer(answer: dict[str, Any], *, list_limit: int = 40) -> list[str]:
    """An :class:`ifc_spatial.envelope.Answer` as lines."""
    value = answer.get("value")
    for matches, render in _ANSWER_SHAPES:
        if matches(value):
            return render(answer, list_limit)
    decimals = _computed_decimals(answer)
    lines = [_provenance_line(answer)]
    if "free" in answer:
        lines.append(_prism_line(answer, decimals))
    if isinstance(value, list) and value and not _all_numbers(value):
        lines += listed(value, list_limit, "Einträge", lambda entry: _list_entry(entry, answer, decimals))
    if answer.get("agreement") == "disagree":
        lines.append("WIDERSPRUCH zwischen zwei Wegen zu dieser Zahl — siehe Hinweis.")
    if answer.get("caveat"):
        lines.append(f"Hinweis: {answer['caveat']}")
    if answer.get("because") and not isinstance(value, list):
        lines.append("Begründung: " + "; ".join(str(reason) for reason in answer["because"]))
    if answer.get("method"):
        lines.append(f"Methode: {answer['method']}")
    if answer.get("from"):
        lines.append("Bezug: " + ", ".join(str(ref) for ref in answer["from"][:8]))
    return lines


# ── the payload shapes ───────────────────────────────────────────────────────


def _is_profile(payload: Any) -> bool:
    """`element_profile`: many measures over ONE element."""
    return isinstance(payload, dict) and "measures" in payload and "element" in payload


def _is_batch(payload: Any) -> bool:
    """`survey`, or `measure` over a list: ONE measure over many elements."""
    return isinstance(payload, dict) and "results" in payload and "summary" in payload


def _model_identity(source: dict[str, Any] | None) -> str | None:
    """Which file, its schema and its size — without the „Modell: " label the prose header adds."""
    model = (source or {}).get("model") or {}
    filename = model.get("filename")
    if not filename:
        return None
    facts = [str(model["schemaVersion"])] if model.get("schemaVersion") else []
    if model.get("elements"):
        facts.append(f"{model['elements']} Bauteile")
    return f"{filename} ({', '.join(facts)})" if facts else str(filename)


def _model_line(result: dict[str, Any], handle: str = "") -> str:
    identity = _model_identity(result)
    if not identity:
        return ""
    return f"Modell: {identity}" + (f" · Kennung {handle[:12]}" if handle else "")


def _briefing_lines(payload: Any) -> list[str]:
    text = (
        payload["briefing"] if isinstance(payload, dict) and isinstance(payload.get("briefing"), str) else str(payload)
    )
    return [
        text,
        "Geschoß- und Merkmalsnamen aus diesem Briefing wörtlich übernehmen — sie stammen aus "
        "DIESER Datei. Der Abschnitt BLIND sagt, was diese Datei nicht beantworten kann.",
    ]


def _find_elements_lines(payload: dict[str, Any]) -> list[str]:
    elements = payload.get("elements") or []
    lines = [f"{payload.get('total', len(elements))} Treffer, {len(elements)} aufgelistet."]
    lines += [_element_line(entry) for entry in elements]
    if payload.get("truncated"):
        lines.append("(Weitere Treffer vorhanden — Suche eingrenzen.)")
    if payload.get("hint"):
        lines.append(str(payload["hint"]))
    return lines


def _element_lines(payload: dict[str, Any]) -> list[str]:
    element = payload.get("element") or {}
    label = element.get("name") or element.get("globalId")
    lines = [f"{element.get('ifcType')} „{label}“ · GlobalId {element.get('globalId')}"]
    if payload.get("storey"):
        lines.append(f"Geschoß: {payload['storey']}")
    if payload.get("predefinedType"):
        lines.append(f"PredefinedType: {payload['predefinedType']}")
    container = payload.get("container")
    if isinstance(container, dict):
        lines.append(f"Liegt in: {container.get('ifcType')} „{container.get('name')}“")
    if payload.get("available"):
        lines.append("Vorhandene Relationen: " + ", ".join(str(name) for name in payload["available"]))
    if payload.get("hinweis"):
        lines.append(f"Hinweis: {payload['hinweis']}")
    return lines


def _shopping_list_lines(payload: dict[str, Any]) -> list[str]:
    lines = [str(payload.get("summary") or "")]
    if payload.get("path"):
        lines.append(
            f"IDS-Datei geschrieben: {payload['path']} "
            f"({payload.get('specifications')} Spezifikationen, {payload.get('bytes')} Bytes)."
        )
    lines += [f"- enthalten: {entry}" for entry in payload.get("exported") or []]
    lines += [
        f"- NICHT als IDS ausdrückbar: {e.get('what')} — {e.get('why')}" for e in payload.get("notExportable") or []
    ]
    lines.append(
        "Die Datei verlangt nur, DASS ein Merkmal vorhanden ist, nie welchen Wert es haben muss. "
        "Grenzwerte kommen aus der Bestimmung."
    )
    return lines


def _draw_lines(payload: dict[str, Any]) -> list[str]:
    return [
        f"Zeichnung erzeugt: {payload.get('path')} ({payload.get('bytes')} Bytes, {payload.get('seconds')} s).",
        "Die Zeichnung liegt als Datei auf dem Server. Maße NICHT aus dem Bild ablesen — dafür "
        "operation='measure' oder 'distance' verwenden.",
    ]


def _profile_row(name: str, answer: dict[str, Any]) -> str:
    if answer.get("error"):
        return f"- {name}: FEHLER — {answer['error']}"
    if answer.get("decidable"):
        return f"- {name}: {_value_text(answer.get('value'))} {answer.get('unit') or ''}".rstrip()
    return f"- {name}: NICHT ENTSCHEIDBAR — {_missing_what(answer)}"


def _profile_lines(payload: dict[str, Any]) -> list[str]:
    """Every measure that applies to one element, one line each — never the raw dict."""
    element = payload.get("element") or {}
    storey = f", {payload['storey']}" if payload.get("storey") else ""
    lines = [f"gemessen an {element.get('name') or element.get('globalId')} ({element.get('ifcType')}{storey}):"]
    lines += [_profile_row(name, answer or {}) for name, answer in (payload.get("measures") or {}).items()]
    skipped = payload.get("notMeasured") or {}
    if skipped.get("kinds"):
        lines.append(f"Nicht gemessen: {', '.join(skipped['kinds'])}. {skipped.get('why') or ''}".strip())
    lines.append(
        "Verkürzte Übersicht: Toleranz, Herkunft und Methode je Kennwert liefert operation='measure' "
        "für den einen, auf den es ankommt. Lange Listen sind gekürzt."
    )
    return lines


def _batch_headline(payload: dict[str, Any]) -> str:
    """The SPREAD first, because that is the finding: „alle 17 bei 2.70 m" and „16 bei 2.70 m, einer bei 0.25 m" differ.

    Flattening this through `_value_text` would print „results=17 Einträge" — seventeen measurements and not one number.
    """
    summary = payload.get("summary") or {}
    results = payload.get("results") or []
    spread = summary.get("spread")
    measured, of = summary.get("measured", 0), summary.get("of", len(results))
    head = f"gemessen: {payload.get('measure')} an {measured} von {of} Bauteilen"
    if spread is not None and spread > 0:
        head += f" — von {_num(summary.get('min'), 3)} bis {_num(summary.get('max'), 3)}, Spanne {_num(spread, 3)}"
    elif spread == 0:
        head += f" — durchgehend {_num(summary.get('min'), 3)}"
    if payload.get("truncated"):
        head += f" (von {summary.get('selected')} passenden — NUR diese Auswahl)"
    return head + "."


def _batch_row(entry: dict[str, Any]) -> str:
    """The name where the payload has one: a 22-character GlobalId is nothing a reviewer carries to a CAD window."""
    answer = entry.get("answer") or {}
    label = entry.get("name") or entry.get("globalId")
    if entry.get("name") and entry.get("storey"):
        label = f"{entry['name']} ({entry['storey']})"
    if answer.get("decidable"):
        value = _num(answer.get("value"), _decimals(answer.get("tolerance")))
        return f"- {label}: {value} {answer.get('unit') or ''}".rstrip()
    return f"- {label}: NICHT ENTSCHEIDBAR — {_missing_what(answer)}"


def _batch_lines(payload: dict[str, Any]) -> list[str]:
    summary = payload.get("summary") or {}
    lines = [_batch_headline(payload)]
    lines += listed(payload.get("results") or [], 40, "Bauteile", _batch_row)
    if summary.get("undecidable"):
        count = len(summary["undecidable"])
        noun = "Bauteil konnte" if count == 1 else "Bauteile konnten"
        lines.append(
            f"{count} {noun} nicht gemessen werden — sie sind oben einzeln genannt und dürfen "
            "nicht als „wie die anderen“ berichtet werden."
        )
    if summary.get("disagree"):
        named = ", ".join(entry.get("name") or entry.get("globalId") for entry in summary["disagree"])
        lines.append(
            f"WIDERSPRUCH zwischen deklariertem und gemessenem Wert bei: {named}. "
            "Das ist ein Befund über den Export, nicht über das Gebäude."
        )
    if payload.get("hint"):
        lines.append(str(payload["hint"]))
    if summary.get("spread"):
        lines.append("Die Spanne ist die Aussage: ein einzeln gemessener Raum belegt nichts über die übrigen.")
    return lines


_BODY_RENDERERS: dict[str, Callable[[dict[str, Any]], list[str]]] = {
    "find_elements": _find_elements_lines,
    "element": _element_lines,
    "shopping_list": _shopping_list_lines,
    "draw": _draw_lines,
}


def _body_lines(operation: str, payload: Any) -> list[str]:
    """The result itself: by operation where the shape is the operation's own, by payload shape otherwise."""
    if operation == "briefing":
        return _briefing_lines(payload)
    renderer = _BODY_RENDERERS.get(operation)
    if renderer is not None and isinstance(payload, dict):
        return renderer(payload)
    if _is_profile(payload):
        return _profile_lines(payload)
    if _is_batch(payload):
        return _batch_lines(payload)
    if isinstance(payload, dict) and "decidable" in payload:
        return _render_answer(payload)
    # Never `str(payload)`: a raw dict dump strips the provenance verbs, which
    # is the defect this renderer exists to prevent. A shape nobody renders is
    # a bug to fix, and a test should be what finds it.
    raise TypeError(f"ifc_measure: no renderer for the {operation!r} payload ({type(payload).__name__})")


def _image_blocks(payload: dict[str, Any], *, source: dict[str, Any] | None, handle: str) -> list[dict]:
    """The plan as something the model can actually LOOK at: a caption block and an image block.

    The caption carries what the pixels cannot state exactly — storey, rooms,
    marked GlobalIds — and the prohibition: a dimension read off a raster is
    guessed even when it happens to be right.
    """
    lines = [_model_line(source or {}, handle), str(payload.get("note") or "")]
    if payload.get("rooms"):
        lines.append("Räume im Bild: " + ", ".join(str(room) for room in payload["rooms"]) + ".")
    if payload.get("highlighted"):
        lines.append("Rot markiert: " + ", ".join(str(item) for item in payload["highlighted"]) + ".")
    if not payload.get("northDeclared"):
        lines.append(
            "Kein Nordpfeil: diese Datei deklariert keine Nordrichtung. Aus dem Bild lässt sich "
            "keine Himmelsrichtung ableiten."
        )
    lines.append(
        "Das Bild dient der Orientierung und der Identifikation von Bauteilen. Maße NIE daraus "
        "ablesen — dafür operation='measure' oder 'distance', die ihre Toleranz mitliefern."
    )
    return [
        {"type": "text", "text": "\n".join(line for line in lines if line)},
        {
            "type": "image_url",
            "image_url": {"url": f"data:{payload.get('mediaType', 'image/png')};base64,{payload['pngBase64']}"},
        },
    ]


def _render_unresolved(result: dict[str, Any]) -> str:
    """A model that could not be selected — the same shape ``ifc_query`` uses."""
    return render_unresolved(result, "Das Modell konnte nicht gelesen werden.")


# ── evidence: what the result says about itself ──────────────────────────────


def _is_evidence(answer: Any) -> bool:
    """Whether one envelope answer is EVIDENCE: decidable, declared or computed, and a QUANTITY.

    A provenance alone is not enough — `relations` answers with a decidable
    list of GlobalIds `provenance: declared`, and nothing in it was measured.
    A unit or a tolerance is what makes a value a quantity; not both, since
    `envelope` reports m² without a tolerance and `storey_heights` a list
    with a unit.
    """
    if not isinstance(answer, dict) or answer.get("error"):
        return False
    if not answer.get("decidable"):
        return False
    if answer.get("provenance") not in EVIDENCE_PROVENANCES:
        return False
    return answer.get("unit") is not None or answer.get("tolerance") is not None


def _measured_count(payload: Any) -> int:
    """How many QUANTITIES in one payload carry a ``declared``/``computed`` provenance.

    The number the result states about itself (:mod:`.measurement_evidence`),
    read off the envelope's own fields and never off the German around them.
    """
    if _is_profile(payload):
        return sum(_is_evidence(answer) for answer in (payload.get("measures") or {}).values())
    if _is_batch(payload):
        return sum(_is_evidence((entry or {}).get("answer")) for entry in (payload.get("results") or []))
    if isinstance(payload, dict) and "decidable" in payload:
        return int(_is_evidence(payload))
    return 0


def _measured_elements(answer: dict[str, Any], names: dict[str, MeasuredElement]) -> tuple[MeasuredElement, ...]:
    """The elements a value was derived from, in the operator's order; an id the payload cannot name still travels."""
    ids = answer.get("from")
    if not isinstance(ids, list):
        return ()
    return tuple(
        names.get(str(global_id), MeasuredElement(global_id=str(global_id)))
        for global_id in ids
        if isinstance(global_id, (str, int))
    )


def _measurement_source(
    answer: dict[str, Any],
    *,
    headline: str,
    names: dict[str, MeasuredElement],
    model: str | None,
) -> MeasurementSource:
    """One evidence-bearing envelope answer as a Herleitung source."""
    tolerance = answer.get("tolerance")
    unit = answer.get("unit")
    tolerance_text = f"±{_tolerance_text(tolerance)}{' ' + unit if unit else ''}" if tolerance is not None else None
    return MeasurementSource(
        headline=headline,
        statement=_provenance_line(answer),
        provenance=str(answer.get("provenance") or ""),
        value_text=_value_with_unit(answer),
        tolerance_text=tolerance_text,
        method=str(answer.get("method") or ""),
        elements=_measured_elements(answer, names),
        model=model,
        caveat=str(answer["caveat"]) if answer.get("caveat") else None,
    )


def _element_index(entries: Sequence[dict[str, Any]]) -> dict[str, MeasuredElement]:
    """GlobalId → the element as the payload names it."""
    index: dict[str, MeasuredElement] = {}
    for entry in entries:
        global_id = (entry or {}).get("globalId")
        if not global_id:
            continue
        index[str(global_id)] = MeasuredElement(
            global_id=str(global_id),
            name=(entry.get("name") or None),
            ifc_type=(entry.get("ifcType") or None),
        )
    return index


def _profile_sources(payload: dict[str, Any], model: str | None) -> list[MeasurementSource]:
    element = payload.get("element") or {}
    names = _element_index([element])
    label = element.get("name") or element.get("globalId") or ""
    return [
        _measurement_source(
            answer, headline=f"{measure} · {label}" if label else str(measure), names=names, model=model
        )
        for measure, answer in (payload.get("measures") or {}).items()
        if _is_evidence(answer)
    ]


def _batch_sources(payload: dict[str, Any], measure: str, model: str | None) -> list[MeasurementSource]:
    out: list[MeasurementSource] = []
    for entry in payload.get("results") or []:
        answer = (entry or {}).get("answer")
        if not _is_evidence(answer):
            continue
        label = entry.get("name") or entry.get("globalId") or ""
        headline = f"{measure} · {label}" if label else measure
        out.append(_measurement_source(answer, headline=headline, names=_element_index([entry]), model=model))
    return out


def _measurement_sources(
    operation: str,
    payload: Any,
    *,
    source: dict[str, Any] | None,
    detail: str,
) -> list[MeasurementSource]:
    """The measurements in one payload, as sources for the Herleitung.

    Walks exactly the shapes :func:`_measured_count` walks and admits exactly
    what :func:`_is_evidence` admits, so the cards under an answer and the
    „Messwerte in diesem Ergebnis" trailer are the same statement twice.
    Headlines are the register's own vocabulary, qualified by the element the
    payload names; a single `Answer` names none, so its headline is what the
    CALL asked for.
    """
    if operation in NON_MEASURING_OPERATIONS or not isinstance(payload, dict):
        return []
    model = _model_identity(source)
    if _is_profile(payload):
        return _profile_sources(payload, model)
    if _is_batch(payload):
        return _batch_sources(payload, str(payload.get("measure") or detail or operation), model)
    if "decidable" in payload and _is_evidence(payload):
        return [_measurement_source(payload, headline=str(detail or operation), names={}, model=model)]
    return []


def _render(
    operation: str,
    payload: Any,
    *,
    source: dict[str, Any] | None = None,
    handle: str = "",
    detail: str = "",
) -> str:
    """The engine's result as the string the model reads.

    Ends with the evidence trailer (:func:`.measurement_evidence_line`) on every
    operation that could carry a measurement; :data:`NON_MEASURING_OPERATIONS`
    get none, and an absent trailer never opens the confidence gate. This is
    also the last point at which the structured ``Answer`` exists, so it is
    where a measurement becomes a Herleitung source — a no-op unless a turn is
    capturing.
    """
    lines = [_model_line(source or {}, handle), *_body_lines(operation, payload)]
    record_measurements(_measurement_sources(operation, payload, source=source, detail=detail))
    if operation not in NON_MEASURING_OPERATIONS:
        lines.append(measurement_evidence_line(_measured_count(payload)))
    return "\n".join(line for line in lines if line)


# ── tracing and the tool ─────────────────────────────────────────────────────


def _trace(operation: str, detail: str, *, outcome: str) -> None:
    """The SHAPE of the call for Langfuse: names from the closed vocabularies here, never model-authored text."""
    known = operation if operation in VALID_OPERATIONS else "unknown"
    known_detail = detail if detail in RELATIONS or detail in MEASURES or detail in DISTANCE_MODES else None
    record_ifc_call(f"measure:{known}", outcome, ifc_measure_detail=known_detail)


def _run(organization_id: str, project_id: str | None, model_name: str, name: str, args: dict[str, Any]):
    """Resolve, load and call — one blocking unit for ``to_thread``."""
    source = resolve_model_source(organization_id=organization_id, project_id=project_id, model_name=model_name or None)
    if not source.get("resolved"):
        return source, None, ""
    handle = open_model(source)
    return source, call_spatial_tool(handle, name, args), handle


def _reply(name: str, detail: str, source: dict[str, Any], payload: Any, handle: str) -> list[dict] | str:
    """What the agent reads once the engine has answered — or once the model could not be selected."""
    if not source.get("resolved"):
        _trace(name, detail, outcome=f"unresolved:{source.get('reason', 'unknown')}")
        return _render_unresolved(source)
    decidable = payload.get("decidable") if isinstance(payload, dict) else None
    _trace(name, detail, outcome="undecidable" if decidable is False else "resolved")
    if name == "view" and isinstance(payload, dict) and payload.get("pngBase64"):
        return _image_blocks(payload, source=source, handle=handle)
    return _render(name, payload, source=source, handle=handle, detail=detail)


async def _measure(arguments: IfcMeasureInput, default_limit: int) -> list[dict] | str:
    """The tool body: guard, build, run, render — every failure as text the agent can act on."""
    organization_id = get_organization_id_from_context()
    if not organization_id:
        return NO_ORG_TEXT
    project_id = get_project_id_from_context()
    if not project_id:
        _trace(arguments.operation, "", outcome="no_project")
        return NO_PROJECT_TEXT
    built = _engine_call(arguments, default_limit)
    if isinstance(built, str):
        _trace(arguments.operation, "", outcome="rejected")
        return built
    name, args = built
    # The measure/relation/mode the CALL asked for: the only headline a single-`Answer` payload has.
    detail = str(args.get("relation") or args.get("measure") or args.get("mode") or "")
    try:
        source, payload, handle = await asyncio.to_thread(
            _run, organization_id, project_id, arguments.model_name, name, args
        )
    except MEASURE_FAILURES.exceptions as exc:
        failure = MEASURE_FAILURES.describe(exc)
        logger.log(failure.level, "ifc_measure %s: %s", failure.outcome, exc)
        _trace(name, detail, outcome=failure.outcome)
        return failure.text(exc)
    return _reply(name, detail, source, payload, handle)


class IfcMeasureConfig(FunctionBaseConfig, name="ifc_measure"):
    """Configuration for the ``ifc_measure`` spatial tool."""

    default_limit: int = Field(default=50, description="Rows returned by 'find_elements' when none is given.")


@register_function(config_type=IfcMeasureConfig)
async def ifc_measure(tool_config: IfcMeasureConfig, builder: Builder):
    async def _ifc_measure(arguments: IfcMeasureInput) -> list[dict] | str:
        """Measure the project's IFC/BIM model and report the provenance."""
        return await _measure(arguments, tool_config.default_limit)

    # `input_schema` is what NAT hands LangChain as `args_schema`: the enums,
    # the per-parameter text and the one required field reach the model.
    yield FunctionInfo.from_fn(_ifc_measure, input_schema=IfcMeasureInput, description=_TOOL_DESCRIPTION)
