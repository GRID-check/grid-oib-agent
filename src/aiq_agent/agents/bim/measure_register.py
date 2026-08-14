"""``ifc_measure`` tool — measure the building, and say how the number was got.

The sibling of :mod:`aiq_agent.agents.bim.register`, and deliberately not a
replacement for it. ``ifc_query`` reads the extracted index: it is fast, it
covers the whole model, and it answers what the EXPORT WROTE DOWN — counts,
storeys, property values, the quantities the exporter chose to publish. That is
the right tool for most questions and it stays the first one to reach for.

This tool answers the questions the index cannot, because the export never wrote
them down. A room whose ``Qto_SpaceBaseQuantities`` is absent still has a floor
area; a window with no ``Pset_WindowCommon.SillHeight`` still has a sill; a room
with a suspended ceiling has a clear height that is 30 cm less than its space
solid, and no property in the file says so. Those numbers are in the GEOMETRY,
and this tool runs the spatial engine (IfcOpenShell/OCCT — roadmap §13b) over
the model's own bytes to obtain them.

## The one thing this tool is really for

Every answer carries its **provenance**, and the three are three different
claims a human being will end up signing:

  ``declared``  the file states it — wrong only if the export is wrong;
  ``computed``  we measured it, and the tolerance travels with the number;
  ``inferred``  a heuristic, with its confidence and its reasons.

Collapsing those into one number is how a guess gets stamped. So the renderer
puts a different German verb in front of each — *deklariert* / *gemessen (±tol)*
/ *vermutlich* — and the tool description forbids the agent from mixing them up.

The fourth state is ``decidable: false``, which is not an error: the question
was well-formed and THIS EXPORT cannot answer it. It carries ``missing.remedy``,
which is what the architect changes in their CAD. Reporting that as a failure of
the tool — or worse, as a fact about the building — is the failure this whole
library exists to prevent.

## What it costs

Geometry is not free. The first measurement on a cold model tessellates it
(~2 s for a house); the first ``relations opensTo`` / ``bounds`` /
``enclosedBy`` / ``adjacentSpaces`` builds a space-contact map (~6 s), and
``draw`` is ~5 s. Everything after that is milliseconds, because the parsed
model is cached by content hash for the life of the process
(:mod:`aiq_agent.knowledge.ifc_spatial_client`). An agent that is told what a
call costs can decide it is worth it; one that finds out afterwards cannot.
"""

import asyncio
import logging
import math
import re
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import Field
from pydantic import field_validator
from pydantic import model_validator

# Shared with `ifc_query` so the two halves of the BIM surface fail identically:
# an agent that learns this sentence from one tool reads it correctly from the
# other. The dependency runs measure -> register and never back, so `register`
# stays loadable on a deployment without the spatial engine — which is the
# independence the two entry points in pyproject.toml exist to preserve.
from aiq_agent.agents.bim.capability_gaps import record_gap
from aiq_agent.agents.bim.measurement_evidence import EVIDENCE_PROVENANCES
from aiq_agent.agents.bim.measurement_evidence import measurement_evidence_line
from aiq_agent.agents.bim.register import NO_PROJECT_TEXT
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

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
# This tool used to be declared to the model as sixteen bare strings: no enums,
# no per-parameter text, nothing required. Every fact needed to call it
# correctly lived in the description and none of it lived where a schema would
# put it, so „measure" and „measure_room" were equally well-formed calls as far
# as anything between the model and this function could tell.
#
# That is a TURN problem before it is a token problem. The agent runs with
# `max_tool_iterations: 5` and force-synthesises at the limit, so an invented
# operation or a misspelled measure name cost one call in five: the request was
# accepted, reached `_build_call`, and came back as a sentence the model had to
# read and retry.
#
# What the schema buys, precisely — and it is NOT the turn back. The budget is
# charged when the model EMITS the call (`shallow_researcher.agent` adds one per
# tool call in the response) and nothing refunds it, so a call refused by the
# validator spends the same iteration a call refused by `_build_call` does; the
# ToolNode returns the ValidationError as the tool result and the loop carries
# on. What the schema changes is how often a bad call is EMITTED at all — an
# enum in the args schema is the one place a model reliably reads a vocabulary
# from, and most models will not emit a value it forbids. The refusal that does
# happen is cheaper (the tool body never runs, so nothing resolves a project or
# opens a model) and it is better: the permitted set travels with it, out of the
# schema, rather than being retyped in a sentence that can drift from it.
#
# FLAT, with each overloaded field naming the operations it belongs to — NOT a
# discriminated union, although `operation` is a perfect discriminator and the
# union is the cleaner model. The reason is what the union becomes on the wire.
# NAT hands `input_schema` to LangChain as `args_schema`, and a
# `RootModel[Annotated[Union[...], Field(discriminator=...)]]` comes out of
# `convert_to_openai_tool` as a single property called `root` holding an
# `anyOf` — so the model would have to nest every call inside `{"root": {…}}`,
# a wrapper it has no way to learn about except by guessing. Measured, not
# assumed; `tests/aiq_agent/agents/test_ifc_measure_tool.py` keeps the
# measurement so a later NAT can be re-checked rather than re-argued. A flat
# model with operation-scoped descriptions carries the same facts in a shape the
# wire can actually express.
#
# The enums are BUILT from the vocabularies above rather than retyped beside
# them. A hand-copied literal list is a second copy of a copy, and the one thing
# this file already knows about copies is that they drift.


def _literal(*groups) -> Any:
    """A ``Literal`` over these vocabularies, in the order they were written.

    Order is part of the contract: the tuple becomes the ``enum`` array in the
    schema the model is handed, and an enum that reshuffles between restarts
    invalidates every prefix cache in front of it.
    """
    names: list[str] = []
    for group in groups:
        for name in group:
            if name not in names:
                names.append(name)
    return Literal[tuple(names)]  # type: ignore[valid-type]


#: Which vocabulary a bad `kind` is recorded AGAINST — the ledger entry, not the
#: check. `kind` is one field over four vocabularies, and the `Literal` accepts
#: the union of all of them because `_build_call` has always been the one that
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

#: The fields `_build_call` has always matched case-insensitively, and their
#: canonical spellings.
#:
#: Preserved deliberately. `_build_call` lower-cases `operation`, `room_kind`,
#: `kind` and `mode`, and case-folds the fire and envelope aspects, so
#: kind='Compactness' has always been a working call. A `Literal` is
#: case-SENSITIVE, so without this the schema would start refusing calls the
#: tool used to answer — a refactor breaking the thing it was meant to make
#: cheaper. `measure` and `relation` are absent on purpose: `_build_call`
#: requires those exact, and the schema says exactly what the tool does.
_CASE_FOLDED: dict[str, tuple[str, ...]] = {
    "operation": OPERATIONS,
    "room_kind": ROOM_KINDS,
    "kind": _ALL_KINDS,
    "mode": (*DISTANCE_MODES, *VIEW_MODES),
}


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
    # `None`, not `0.0`, and the bounds are the ones `_build_call` enforces.
    # Two defects came out of the old `default=0.0, ge=0.0, le=90.0`: it made
    # „not given" indistinguishable from „zero degrees" — the same
    # default-in-two-places defect the `mode` field was fixed for — and it
    # declared a range the tool does not accept, so `angle_deg=90` passed
    # validation and then spent one of five turns on `_build_call`'s refusal.
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
    def _fold_case_and_keep_the_ledger(cls, data: Any) -> Any:
        """Two jobs the ``Literal`` cannot do for itself, both before it runs.

        FIRST, the case-folding `_build_call` has always done. It lower-cases
        `operation`, `room_kind`, `kind` and `mode` and matches the fire and
        envelope aspects case-insensitively, so kind='Compactness' is a call
        this tool has always answered. A `Literal` is case-sensitive; without
        this, tightening the schema would start refusing calls that used to
        work, which is the opposite of the point.

        SECOND, the capability ledger. `capability_gaps` exists because
        ``measure="wandstaerke"`` is not really a mistake — it is somebody
        asking for a wall thickness this surface has no operator for, said in
        one word, and it is the most useful signal the BIM surface produces.
        `_build_call` wrote those entries. Once the enum is on the wire the
        value never reaches `_build_call`: pydantic refuses it first, and the
        backlog would go quiet exactly as the refusals got cheaper — which
        reads as „nobody asks for anything we lack".

        Nothing here raises. Whatever is still unknown after the folding is left
        for the ``Literal`` to refuse, so there is one error message and it is
        the one that lists the permitted values.
        """
        if not isinstance(data, dict):
            return data
        data = dict(data)
        for name, vocabulary in _CASE_FOLDED.items():
            asked = data.get(name)
            if not isinstance(asked, str) or not asked.strip():
                continue
            canonical = next((known for known in vocabulary if known.lower() == asked.strip().lower()), None)
            if canonical is not None:
                data[name] = canonical

        operation = str(data.get("operation") or "").strip().lower()
        for name, asked, known in (
            ("operation", data.get("operation"), VALID_OPERATIONS),
            ("measure", data.get("measure"), MEASURES),
            ("relation", data.get("relation"), RELATIONS),
            ("room_kind", data.get("room_kind"), ROOM_KINDS),
            # Against the WHOLE of `kind`, because that is what the field
            # accepts. Checking against the operation's own vocabulary would
            # file `element_profile kind='space'` as a missing capability, and
            # `_build_call` answers that call by ignoring the field.
            (_KIND_FIELD.get(operation, "kind"), data.get("kind"), _ALL_KINDS),
        ):
            wanted = asked.strip() if isinstance(asked, str) else ""
            if wanted and wanted not in known:
                record_gap(surface="ifc_measure", field=name, asked_for=wanted, known=known)
        return data

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
        deprecated. Both arrive at `_build_call` as the one shape it parses.
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


def _clean(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _build_call(
    operation: str,
    global_id: str = "",
    other_global_id: str = "",
    relation: str = "",
    measure: str = "",
    mode: str = "",
    ifc_type: str = "",
    name_contains: str = "",
    storey: str = "",
    kind: str = "",
    room_kind: str = "",
    limit: int = 50,
    angle_deg: float | None = None,
    swivel_deg: float | None = None,
    when: str = "",
) -> tuple[str, dict[str, Any]] | str:
    """The engine tool name and its arguments, or a correctable error string.

    Every enum is checked HERE, before the model is resolved and long before it
    is parsed. The reason is the same one `_build_query` gives on the query
    side: an argument the engine would reject arrives as an exception several
    seconds and one 150 MB download later, by which time the agent has been told
    only that something failed. Refusing by name — with the permitted values
    spelled out — is a mistake the model can correct in the same turn.
    """
    op = (operation or "").strip().lower()
    if op not in VALID_OPERATIONS:
        record_gap(surface="ifc_measure", field="operation", asked_for=operation, known=VALID_OPERATIONS)
        return f"Error: unknown operation '{operation}'. Use one of: {', '.join(sorted(VALID_OPERATIONS))}."

    subject = _clean(global_id)

    if op == "briefing":
        # Always the rendered TEXT block, never the JSON. The briefing's whole
        # job is to be read into the agent's context and copied out of; handing
        # back the same facts as a nested object would make the agent
        # reassemble sentences the renderer already got right.
        return "briefing", {"format": "text"}

    if op == "storey_heights":
        return "storey_heights", {}

    if op == "sun_position":
        moment = _clean(when)
        if not moment:
            return (
                "Error: sun_position needs 'when' — an ISO 8601 instant WITH a time zone, e.g. "
                "'2026-06-21T12:00:00+02:00' (Austrian summer time) or '2026-06-21T10:00:00Z'. A "
                "timestamp without a zone is refused rather than read as UTC: Austria runs UTC+1 and "
                "UTC+2, so reading 12:00 as UTC moves the sun 30° east of where it stood."
            )
        # No latitude/longitude field, deliberately, and the engine's schema has
        # none either. The operator accepts an override — a surveyor's coordinate
        # is better than an exporter's default — but a model that CAN fill a
        # latitude fills one, and an assumed 48.2°N Vienna on a Vorarlberg
        # project is 1.4° out in solar altitude and comes back as a `computed`
        # number with a tolerance, indistinguishable from a measured one. Without
        # a georeference in the file the answer is undecidable, which is correct.
        return "sun_position", {"when": moment}

    if op == "overhang":
        if not subject or not _clean(other_global_id):
            return (
                "Error: overhang needs TWO elements — global_id is the projecting one (the roof, the "
                "balcony) and other_global_id the one whose facade plane is the reference (the wall "
                "under it). Get the wall from relations/hostedIn on the window."
            )
        return "overhang", {"projecting": subject, "facade": _clean(other_global_id)}

    if op == "light_incidence":
        if not subject:
            return "Error: light_incidence needs global_id — the opening, or the window that fills it."
        if angle_deg is None or not 0 < float(angle_deg) < 90:
            # Refused rather than defaulted to 45. The angle is a fact about the
            # CLAUSE, and a tool that supplies one is answering a question of law
            # it was never asked — the whole reason this layer returns geometry
            # and no verdict.
            return (
                "Error: light_incidence needs angle_deg, and it must be between 0 and 90. The angle "
                "comes from the Bestimmung, not from the model — for OIB 3 that is 45, with "
                "swivel_deg 30. This tool does not supply it, because supplying it would be applying "
                "the clause."
            )
        args: dict[str, Any] = {"globalId": subject, "angle": float(angle_deg)}
        if swivel_deg is not None:
            if not 0 <= float(swivel_deg) < 90:
                return "Error: swivel_deg must be between 0 and 90."
            args["swivel"] = float(swivel_deg)
        # Comma-separated, because the recessed-window workflow needs TWO
        # exclusions and one field only carried one. A window deep in a thick
        # wall is shaded by its own reveal AND by the roof above it, so an agent
        # asked to re-run "without the host wall" had to drop the roof exclusion
        # to do it — and silently changed the question. The engine's `exclude`
        # has always been a list; only this field was narrower than it.
        excluded = [part.strip() for part in _clean(other_global_id).split(",") if part.strip()]
        if excluded:
            args["exclude"] = excluded
        return "light_incidence", args

    if op == "find_elements":
        args: dict[str, Any] = {"limit": max(1, min(int(limit or 50), 500))}
        if _clean(ifc_type):
            args["ifcType"] = _clean(ifc_type)
        if _clean(name_contains):
            args["nameContains"] = _clean(name_contains)
        if _clean(storey):
            args["storey"] = _clean(storey)
        if _clean(kind):
            if _clean(kind).lower() not in KINDS:
                return (
                    f"Error: kind '{kind}' does not exist. Use one of: {', '.join(KINDS)}. "
                    "'kind' is the spatial ROLE (a room is 'space'); an IFC type goes in 'ifc_type'."
                )
            args["kind"] = _clean(kind).lower()
        return "find_elements", args

    if op == "room_inventory":
        wanted = _clean(room_kind).lower()
        if wanted not in ROOM_KINDS:
            record_gap(surface="ifc_measure", field="room_kind", asked_for=room_kind, known=ROOM_KINDS)
            return f"Error: room_kind '{room_kind}' does not exist. Use one of: {', '.join(ROOM_KINDS)}."
        return "room_inventory", {"kind": wanted}

    if op == "fire":
        wanted = _clean(kind) or "fluchtniveau"
        aspect = next((k for k in FIRE_ASPECTS if k.lower() == wanted.lower()), None)
        if aspect is None:
            record_gap(surface="ifc_measure", field="fire.kind", asked_for=kind, known=FIRE_ASPECTS)
            return f"Error: for operation 'fire', kind must be one of: {', '.join(FIRE_ASPECTS)}. Got '{kind}'."
        args = {"what": aspect}
        if _clean(global_id):
            args["globalId"] = _clean(global_id)
        return "fire", args

    if op == "envelope":
        # No `globalId` forwarded even when the model supplies one: all three
        # aspects take the WHOLE model, and the engine's schema does not accept
        # the field. Passing it through would turn a harmless surplus argument
        # into a schema rejection the model cannot read its way out of.
        wanted = _clean(kind) or "thermalEnvelope"
        aspect = next((k for k in ENVELOPE_ASPECTS if k.lower() == wanted.lower()), None)
        if aspect is None:
            record_gap(surface="ifc_measure", field="envelope.kind", asked_for=kind, known=ENVELOPE_ASPECTS)
            return f"Error: for operation 'envelope', kind must be one of: {', '.join(ENVELOPE_ASPECTS)}. Got '{kind}'."
        return "envelope", {"what": aspect}

    if op == "shopping_list":
        return "shopping_list", {}

    if op == "view":
        # `global_id` carries a comma-separated list here rather than one id,
        # because the question "where is this" is usually about a pair — the
        # window AND the wall it is supposed to sit in — and a single-value
        # field forces two renders to ask one question.
        wanted = [part.strip() for part in _clean(global_id).split(",") if part.strip()]
        picked = (_clean(mode) or "highlight").lower()
        if picked not in VIEW_MODES:
            return (
                "Error: for operation 'view', mode must be 'highlight' (mark these elements, keep the "
                "rest of the plan) or 'only' (draw nothing else). Default is 'highlight'."
            )
        if picked == "only" and not wanted:
            return "Error: mode='only' needs at least one global_id — otherwise there is nothing to draw."
        args = {}
        if _clean(storey):
            args["storey"] = _clean(storey)
        if wanted:
            args["only" if picked == "only" else "highlight"] = wanted
        return "view", args

    if op == "draw":
        args = {}
        if _clean(storey):
            args["storey"] = _clean(storey)
        if _clean(ifc_type):
            args["include"] = [_clean(ifc_type)]
        return "draw", args

    if op == "survey":
        # Sits with `find_elements` and `draw`, ABOVE the subject guard, because
        # it takes no element: its subject IS the selection. The selection half
        # is `find_elements` and the measuring half is `measure`, and the reason
        # the two are fused into one operation is the turn budget — composed
        # from primitives, „wie hoch ist der Keller" costs find_elements +
        # measure + a GlobalId→Name join the agent has to carry in its head,
        # three of five turns for a question that has one call in it.
        wanted = _clean(measure)
        if wanted not in MEASURES:
            record_gap(surface="ifc_measure", field="measure", asked_for=measure, known=MEASURES)
            return f"Error: measure '{measure}' does not exist. Use one of: {', '.join(MEASURES)}."
        # Capped at 50 rather than find_elements' 500: every row here is a real
        # geometric measurement, not an index lookup.
        args = {"measure": wanted, "limit": max(1, min(int(limit or 50), 50))}
        if _clean(ifc_type):
            args["ifcType"] = _clean(ifc_type)
        if _clean(name_contains):
            args["nameContains"] = _clean(name_contains)
        if _clean(storey):
            args["storey"] = _clean(storey)
        if _clean(kind):
            if _clean(kind).lower() not in KINDS:
                return (
                    f"Error: kind '{kind}' does not exist. Use one of: {', '.join(KINDS)}. "
                    "'kind' is the spatial ROLE (a room is 'space'); an IFC type goes in 'ifc_type'."
                )
            args["kind"] = _clean(kind).lower()
        return "survey", args

    # Everything below needs a subject element.
    if not subject:
        return (
            f"Error: operation '{op}' needs a global_id (the element's IFC GlobalId). "
            "Get one from operation='find_elements' — never invent one."
        )

    if op == "element":
        return "element", {"globalId": subject}

    if op == "relations":
        wanted = _clean(relation)
        if wanted not in RELATIONS:
            record_gap(surface="ifc_measure", field="relation", asked_for=relation, known=RELATIONS)
            return f"Error: relation '{relation}' does not exist. Use one of: {', '.join(RELATIONS)}."
        return "relations", {"globalId": subject, "relation": wanted}

    if op == "measure":
        wanted = _clean(measure)
        if wanted not in MEASURES:
            record_gap(surface="ifc_measure", field="measure", asked_for=measure, known=MEASURES)
            return f"Error: measure '{measure}' does not exist. Use one of: {', '.join(MEASURES)}."
        return "measure", {"globalId": subject, "measure": wanted}

    if op == "element_profile":
        # Below the subject guard, correctly: this one IS about a single
        # element. `kind` carries the expensive opt-in rather than a new
        # parameter, because the field is already the tool's catch-all
        # vocabulary slot and one more boolean on a sixteen-parameter signature
        # buys less than it costs.
        args = {"globalId": subject}
        if _clean(kind).lower() == "expensive":
            args["include"] = "expensive"
        return "element_profile", args

    if op == "clearance":
        if not _clean(other_global_id):
            return (
                "Error: clearance needs TWO elements — set 'global_id' and 'other_global_id'. For the "
                "clear width of ONE opening use operation='measure' with measure='clearWidth': an "
                "opening has two reveals but is only one element."
            )
        return "clearance", {"a": subject, "b": _clean(other_global_id)}

    # distance
    other = _clean(other_global_id)
    if not other:
        return "Error: operation 'distance' needs two elements — set 'global_id' and 'other_global_id'."
    wanted_mode = (_clean(mode) or "min").lower()
    if wanted_mode not in DISTANCE_MODES:
        return (
            f"Error: mode '{mode}' does not exist. Use one of: {', '.join(DISTANCE_MODES)}. "
            "All four are AXIS distances between centroids or boxes — none is a clear dimension. "
            "For a lichte Breite use operation='measure' with measure='clearWidth' on the opening, and "
            "for a lichte Höhe measure='clearHeight' on the room."
        )
    return "distance", {"a": subject, "b": other, "mode": wanted_mode}


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

    unit = answer.get("unit")
    value = answer.get("value")
    tolerance = answer.get("tolerance")
    # A declared figure is the file's own statement and is never re-rounded; a
    # measured one is shown to its band and no further.
    decimals = _decimals(tolerance) if answer.get("provenance") == "computed" else None
    text = _value_text(value, decimals)
    # A unit belongs after a NUMBER. Appended to a list or to a set of named
    # numbers it produces "2 Einträge m" and "sill=0.9, head=2.11 m", the second
    # of which reads as though only the last figure carried the unit.
    scalar = isinstance(value, (int, float)) and not isinstance(value, bool)
    suffix = (f" {unit}" if scalar else f" ({unit})") if unit else ""
    provenance = answer.get("provenance")

    if provenance == "declared":
        return f"deklariert: {text}{suffix} — so steht es in der Datei."
    if provenance == "inferred":
        confidence = answer.get("confidence")
        band = f" (Konfidenz {_num(confidence)})" if confidence is not None else ""
        return f"vermutlich: {text}{suffix}{band} — ein Vorschlag zur Bestätigung, keine Feststellung."
    # The tolerance is always a scalar in the value's unit, whatever shape the
    # value itself has — so it takes the plain unit, not the parenthesised one.
    band = f" (±{_tolerance_text(tolerance)}{' ' + unit if unit else ''})" if tolerance is not None else ""
    return f"gemessen{band}: {text}{suffix} — aus der Geometrie berechnet, nicht deklariert."


def _render_answer(answer: dict[str, Any], *, list_limit: int = 40) -> list[str]:
    """An :class:`ifc_spatial.envelope.Answer` as lines."""
    lines = [_provenance_line(answer)]

    value = answer.get("value")
    decimals = _decimals(answer.get("tolerance")) if answer.get("provenance") == "computed" else None
    numbers = (
        isinstance(value, list)
        and bool(value)
        and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)
    )

    # `lightEntryArea` returns the ratio AND both of its inputs AND the openings
    # split three ways. Flattened by `_value_text` it reads
    # „lightEntryArea=2.190, floorArea=15.417, ratio=0.142, percent=14.21,
    # openings=1 Eintrag, innenliegend=1 Eintrag" — every number present and the
    # sentence unreadable. The percentage is what the question was, so it leads,
    # and the two inputs follow so the arithmetic is checkable.
    if isinstance(value, dict) and "lightEntryArea" in value:
        entry_area = value.get("lightEntryArea")
        floor = value.get("floorArea")
        # The band travels with the number here as it does everywhere else. This
        # line replaced the provenance line wholesale and dropped the ± with it,
        # so the one measurement most likely to be quoted into a daylight
        # verdict was the only one arriving without its tolerance.
        band = f" (±{_tolerance_text(answer.get('tolerance'))} m²)" if answer.get("tolerance") is not None else ""
        lines[0] = (
            f"gemessen{band}: Lichteintrittsfläche {_num(entry_area, decimals)} m² auf "
            f"{_num(floor, decimals)} m² Bodenfläche = **{_num(value.get('percent'), 2)} %** "
            "— aus der Geometrie berechnet, nicht deklariert."
        )
        for entry in value.get("openings") or []:
            lines.append(
                f"- außenliegend: {entry.get('ifcType')} „{entry.get('name')}“ "
                f"· {_num(entry.get('area'), 3)} m² · GlobalId {entry.get('globalId')}"
            )
        for key, label in (
            ("innenliegend", "NICHT gezählt (innenliegend)"),
            ("unbestimmt", "NICHT gezählt (außen/innen unbestimmt)"),
        ):
            for entry in value.get(key) or []:
                lines.append(
                    f"- {label}: {entry.get('ifcType')} „{entry.get('name')}“ "
                    f"· {_num(entry.get('area'), 3)} m² · {entry.get('because')}"
                )
        if answer.get("caveat"):
            lines.append(f"Hinweis: {answer['caveat']}")
        if answer.get("method"):
            lines.append(f"Methode: {answer['method']}")
        return lines

    # `egressPath` returns a route, and a route flattened by `_value_text` reads
    # „space=…, reachesOutside=True, doorCount=3, length=15.492, legs=3 Einträge"
    # — the number present and the way out invisible. The legs ARE the answer:
    # which door, into which room, how far, in order.
    if isinstance(value, dict) and "legs" in value and "reachesOutside" in value:
        room = (value.get("space") or {}).get("name") or "der Raum"
        if not value.get("reachesOutside"):
            lines[0] = f"gemessen: von „{room}“ führt KEINE Türverbindung ins Freie."
        else:
            lines[0] = (
                f"gemessen: „{room}“ erreicht das Freie über {value.get('doorCount')} Tür(en), "
                f"Weglänge {_num(value.get('length'), 2)} m — aus der Geometrie berechnet, nicht deklariert."
            )
        for leg in value.get("legs") or []:
            door = leg.get("tuer") or {}
            outside = (leg.get("nach") or {}).get("kind") == "outside"
            lines.append(
                f"- {(leg.get('von') or {}).get('name')} → "
                f"{'INS FREIE' if outside else (leg.get('nach') or {}).get('name')} "
                f"durch „{door.get('name')}“ ({_num(leg.get('length'), 2)} m) · GlobalId {door.get('globalId')}"
            )
        if answer.get("caveat"):
            lines.append(f"Hinweis: {answer['caveat']}")
        if answer.get("method"):
            lines.append(f"Methode: {answer['method']}")
        return lines

    # `doorGraph` is the whole building, and `_value_text` flattens it to
    # „nodes=83 Einträge, edges=77 Einträge, unbestimmt=0 Einträge,
    # ausgeschlossen=0 Einträge" — four counts and not one door. Measured on the
    # institute building in the corpus, and it is the same defect `egressPath`
    # has a branch for: the counts are not the answer. The answer is WHICH rooms
    # have no way out and WHICH doors the derivation could not read, because
    # those two lists are what makes every route in the building sound or
    # unfounded, and this tool was wired precisely to surface them.
    if isinstance(value, dict) and "nodes" in value and "edges" in value and "unbestimmt" in value:
        edges = value.get("edges") or []
        nodes = value.get("nodes") or []
        rooms = [node for node in nodes if isinstance(node, dict) and node.get("globalId") != "AUSSEN"]
        outside = sum(1 for edge in edges if isinstance(edge, dict) and edge.get("external"))
        # German agrees in number, and this file already treats that as a
        # correctness rule rather than polish — `light_incidence` does it below,
        # and `_value_text` writes „1 Eintrag" against „2 Einträge". „1 Räume"
        # in a headline reads as a rendering bug and invites the reader to
        # distrust the number beside it.
        room_text = "1 Raum" if len(rooms) == 1 else f"{len(rooms)} Räume"
        door_text = "1 Türverbindung" if len(edges) == 1 else f"{len(edges)} Türverbindungen"
        lines[0] = (
            f"gemessen: {room_text}, {door_text}, davon {outside} ins Freie "
            "— aus der Geometrie abgeleitet, nicht deklariert."
        )
        reached = {node for edge in edges if isinstance(edge, dict) for node in (edge.get("verbindet") or [])}
        stranded = [node for node in rooms if node.get("globalId") not in reached]
        for node in stranded[:list_limit]:
            lines.append(
                f"- KEINE Türkante: {node.get('ifcType')} „{node.get('name')}“ · "
                f"GlobalId {node.get('globalId')} — dieser Raum hat in dieser Datei keinen Ausgang"
            )
        # Each of these three lists is cut to `list_limit`, and a cut nobody
        # names reads as a complete list. That is the same defect `fire`'s
        # caveat carried — „die vollständige Liste" beside ten of twelve — and
        # it lands hardest here: a building with more than forty rooms without
        # an exit is precisely the building this branch exists to surface.
        if len(stranded) > list_limit:
            lines.append(f"… {len(stranded) - list_limit} weitere Räume ohne Türkante nicht gezeigt.")
        # These two are the reason the graph is worth a call of its own. A door
        # whose rooms could not be resolved is a hole in EVERY route through the
        # building, and a reader who sees only the edge count cannot tell a
        # building with three doors from one with five of which two were
        # unreadable.
        undetermined = value.get("unbestimmt") or []
        for entry in undetermined[:list_limit]:
            lines.append(
                f"- UNBESTIMMT: {entry.get('ifcType')} „{entry.get('name')}“ · "
                f"GlobalId {entry.get('globalId')} — {entry.get('warum')}"
            )
        if len(undetermined) > list_limit:
            lines.append(f"… {len(undetermined) - list_limit} weitere unbestimmte Türen nicht gezeigt.")
        excluded = value.get("ausgeschlossen") or []
        for entry in excluded[:list_limit]:
            lines.append(
                f"- NICHT als Kante gewertet: {entry.get('ifcType')} „{entry.get('name')}“ · "
                f"GlobalId {entry.get('globalId')} — {entry.get('warum')}"
            )
        if len(excluded) > list_limit:
            lines.append(f"… {len(excluded) - list_limit} weitere ausgeschlossene Türen nicht gezeigt.")
        if answer.get("caveat"):
            lines.append(f"Hinweis: {answer['caveat']}")
        if answer.get("method"):
            lines.append(f"Methode: {answer['method']}")
        return lines

    # `light_incidence` answers a yes/no question with a list, and the list can
    # be empty — which is the ANSWER (nothing intrudes) and renders as nothing
    # at all without this line. It goes above the entries because it is the
    # sentence the reader came for.
    if "free" in answer:
        unit = answer.get("unit") or "m"
        prism = answer.get("prism") or {}
        angles = (
            f" (Prisma {_angle(prism.get('angleDeg'))}°"
            # `is not None`, not truthiness: a swivel of 0° is a STATED
            # parameter from the Bestimmung („senkrecht, kein seitlicher
            # Schwenk"), and dropping the phrase leaves a reader unable to tell
            # it from a prism that was never given one.
            + (f", seitlich {_angle(prism.get('swivelDeg'))}°" if prism.get("swivelDeg") is not None else "")
            + ")"
            if prism
            else ""
        )
        if answer.get("free"):
            lines.append(f"FREI{angles}: kein Bauteil ragt in das Prisma.")
        else:
            count = len(value) if isinstance(value, list) else 0
            deepest = (
                max((e.get("intrusionDepth", 0) for e in value if isinstance(e, dict)), default=None)
                if isinstance(value, list)
                else None
            )
            depth = f", tiefster Eingriff {_num(deepest, decimals)} {unit}" if deepest is not None else ""
            # Noun AND verb agree. „1 Bauteil ragen" is the kind of sentence that
            # tells an Austrian architect the text was generated by something
            # that does not speak German, and everything after it is read as
            # machine output rather than as a finding.
            subject = "1 Bauteil ragt" if count == 1 else f"{count} Bauteile ragen"
            lines.append(f"NICHT FREI{angles}: {subject} in das Prisma{depth}.")

    if isinstance(value, list) and value and not numbers:
        # A coordinate triple is already in the line above; listing it again as
        # three bullets would read as three findings.
        shown = value[:list_limit]
        for entry in shown:
            if isinstance(entry, dict) and "intrusionDepth" in entry:
                # Was falling through to `- {dict repr}`, handing the model a
                # Python literal for the flagship operator's own result.
                unit = answer.get("unit") or "m"
                lines.append(
                    f"- {entry.get('name') or entry.get('globalId')} · GlobalId {entry.get('globalId')}"
                    f" · ragt {_num(entry.get('intrusionDepth'), decimals)} {unit} in das Prisma"
                )
            elif isinstance(entry, dict) and "ifcType" in entry:
                lines.append(_element_line(entry))
            elif isinstance(entry, dict) and "storey" in entry:
                height = entry.get("height")
                lines.append(
                    f"- {entry.get('storey')}: Höhenlage {_num(entry.get('elevation'), decimals)}"
                    + (
                        f", Geschoßhöhe {_num(height, decimals)}"
                        if height is not None
                        else ", Geschoßhöhe nicht bestimmbar"
                    )
                )
            elif isinstance(entry, dict) and "confidence" in entry:
                because = ", ".join(entry.get("because") or [])
                lines.append(
                    f"- {entry.get('name') or entry.get('globalId')} · GlobalId {entry.get('globalId')} "
                    f"· Konfidenz {_num(entry.get('confidence'))}" + (f" ({because})" if because else "")
                )
            else:
                lines.append(f"- {entry}")
        if len(value) > len(shown):
            lines.append(f"… {len(value) - len(shown)} weitere Einträge nicht gezeigt.")

    if answer.get("agreement") == "disagree":
        lines.append("WIDERSPRUCH zwischen zwei Wegen zu dieser Zahl — siehe Hinweis.")
    if answer.get("caveat"):
        # Never optional. The storey-pitch caveat is the difference between a
        # Rohbauhöhe and a Raumhöhennachweis; dropping it publishes a different
        # claim than the one the operator made.
        lines.append(f"Hinweis: {answer['caveat']}")
    if answer.get("because") and not isinstance(value, list):
        lines.append("Begründung: " + "; ".join(str(reason) for reason in answer["because"]))
    if answer.get("method"):
        lines.append(f"Methode: {answer['method']}")
    from_ = answer.get("from") or []
    if from_:
        lines.append("Bezug: " + ", ".join(str(ref) for ref in from_[:8]))
    return lines


def _model_line(result: dict[str, Any], handle: str = "") -> str:
    model = result.get("model") or {}
    filename = model.get("filename")
    if not filename:
        return ""
    facts = []
    if model.get("schemaVersion"):
        facts.append(str(model["schemaVersion"]))
    if model.get("elements"):
        facts.append(f"{model['elements']} Bauteile")
    detail = f" ({', '.join(facts)})" if facts else ""
    return f"Modell: {filename}{detail}" + (f" · Kennung {handle[:12]}" if handle else "")


def _image_blocks(payload: dict[str, Any], *, source: dict[str, Any] | None, handle: str) -> list[dict]:
    """The plan as something the model can actually LOOK at.

    Every other operation returns prose because every other operation returns
    facts. This one returns a picture, and a picture described in prose is not a
    picture — `draw` already proves that: it writes an SVG and hands back a path
    and a byte count, which tells the agent nothing it did not already know.

    Two blocks rather than one. The caption carries what the pixels cannot state
    exactly — which storey, the cut height, the rooms by name, which GlobalIds
    are marked — and, crucially, the prohibition: a dimension read off a raster
    is guessed even when it happens to be right, and every dimension here is
    available from an operator that states its own tolerance.
    """
    lines = [line for line in (_model_line(source or {}, handle),) if line]
    lines.append(str(payload.get("note") or ""))
    rooms = payload.get("rooms") or []
    if rooms:
        lines.append("Räume im Bild: " + ", ".join(str(room) for room in rooms) + ".")
    marked = payload.get("highlighted") or []
    if marked:
        lines.append("Rot markiert: " + ", ".join(str(item) for item in marked) + ".")
    if not payload.get("northDeclared"):
        # No arrow was drawn, and the absence has to be stated — otherwise the
        # reader supplies a north themselves, which is exactly the invention
        # („Südfassade") this package exists to stop.
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
    message = result.get("message") or "Das Modell konnte nicht gelesen werden."
    models = result.get("models") or []
    if not models:
        return str(message)
    listed = ", ".join(f"{m.get('filename')} ({m.get('status')}, {m.get('elements', 0)} Bauteile)" for m in models[:10])
    heading = (
        "Verfügbare Modelle"
        if result.get("reason") in {"no_match", "ambiguous"}
        else "Modelle in diesem Projekt (noch nicht abfragbar)"
    )
    return f"{message} {heading}: {listed}."


def _measured_count(payload: Any) -> int:
    """How many QUANTITIES in one payload carry a ``declared``/``computed`` provenance.

    Read off the envelope's own fields — ``decidable``, ``provenance``, ``unit``
    and ``tolerance`` — and never off the German the renderer wraps them in.
    This is the number the result states about itself
    (:mod:`.measurement_evidence`), and it is what the confidence gate stands
    on, so it counts EVIDENCE and nothing else: an undecidable finding, a
    heuristic ``inferred`` guess and a measure that raised are all zero.

    A provenance alone is NOT enough, and that distinction is the whole point.
    ``relations`` answers a topology question — „welche Bauteile begrenzen
    diesen Raum" — and returns a decidable ``Answer`` whose ``value`` is a LIST
    of GlobalIds with ``provenance: declared``. Nothing in it was measured, yet
    it used to report one Messwert, and an answer that ran a `relations` lookup
    and then invented „rund 2,7 m" surfaced at "medium" as a measurement.
    ``find_elements`` was already excluded for exactly this reason; a hit list
    does not stop being a hit list by arriving in an ``Answer`` wrapper.

    So the test is whether the value is a QUANTITY: a ``unit`` or a
    ``tolerance``. Not scalar-ness — ``storey_heights`` measures every storey
    and legitimately answers with a list carrying ``unit: "m"`` — and not both
    fields either, since ``envelope`` reports areas in m² without a tolerance.
    Verified against all 19 operations over the repository's IFC fixtures: the
    only count this changes is ``relations``.
    """

    def _one(answer: Any) -> int:
        if not isinstance(answer, dict) or answer.get("error"):
            return 0
        if not answer.get("decidable"):
            return 0
        if answer.get("provenance") not in EVIDENCE_PROVENANCES:
            return 0
        return 1 if answer.get("unit") is not None or answer.get("tolerance") is not None else 0

    if not isinstance(payload, dict):
        return 0
    # `element_profile`: many measures over one element.
    if "measures" in payload and "element" in payload:
        return sum(_one(answer) for answer in (payload.get("measures") or {}).values())
    # `survey` / a batch `measure`: one measure over many elements.
    if "results" in payload and "summary" in payload:
        return sum(_one((entry or {}).get("answer")) for entry in (payload.get("results") or []))
    # A single `Answer`.
    if "decidable" in payload:
        return _one(payload)
    # Everything else — a briefing, a find_elements hit list, an element's
    # index metadata, a written IDS file, a drawing's path. Those are real
    # results and none of them is a measurement of the building.
    return 0


def _render(
    operation: str,
    payload: Any,
    *,
    source: dict[str, Any] | None = None,
    handle: str = "",
) -> str:
    """The engine's result as the string the model reads.

    Ends with the evidence trailer (:func:`.measurement_evidence_line`) on every
    path that could carry a measurement, because "how many values did this
    actually measure" is a question the result has to answer about itself — the
    confidence gate reads that line, and a reader who sees „gemessen: raumhoehe
    an 0 von 3 Bauteilen" needs the same fact stated rather than implied.

    :data:`NON_MEASURING_OPERATIONS` get no trailer at all. „Messwerte in diesem
    Ergebnis: 0" is true of a `draw` and useless to the model: it reads as a
    measurement that failed and invites a retry, and with
    ``max_tool_iterations`` at 5 a wasted turn is expensive. Suppressing the
    line cannot open the gate, because the gate needs a trailer stating a
    NON-ZERO count and an absent trailer is False either way
    (:func:`measurement_evidence.result_carries_measurement`) — so an operation
    nobody thought to list here still yields no grounding.
    """
    body = _render_body(operation, payload, source=source, handle=handle)
    if operation in NON_MEASURING_OPERATIONS:
        return body
    return body + "\n" + measurement_evidence_line(_measured_count(payload))


def _render_body(
    operation: str,
    payload: Any,
    *,
    source: dict[str, Any] | None = None,
    handle: str = "",
) -> str:
    """The result itself, one branch per operation shape."""
    lines: list[str] = []
    header = _model_line(source or {}, handle)
    if header:
        lines.append(header)

    if operation == "briefing":
        if isinstance(payload, dict) and isinstance(payload.get("briefing"), str):
            lines.append(payload["briefing"])
        else:
            lines.append(str(payload))
        lines.append(
            "Geschoß- und Merkmalsnamen aus diesem Briefing wörtlich übernehmen — sie stammen aus "
            "DIESER Datei. Der Abschnitt BLIND sagt, was diese Datei nicht beantworten kann."
        )
        return "\n".join(line for line in lines if line)

    if operation == "find_elements" and isinstance(payload, dict):
        elements = payload.get("elements") or []
        total = payload.get("total", len(elements))
        lines.append(f"{total} Treffer, {len(elements)} aufgelistet.")
        lines.extend(_element_line(entry) for entry in elements)
        if payload.get("truncated"):
            lines.append("(Weitere Treffer vorhanden — Suche eingrenzen.)")
        if payload.get("hint"):
            lines.append(str(payload["hint"]))
        return "\n".join(line for line in lines if line)

    if operation == "element" and isinstance(payload, dict):
        element = payload.get("element") or {}
        lines.append(
            f"{element.get('ifcType')} „{element.get('name') or element.get('globalId')}“ · "
            f"GlobalId {element.get('globalId')}"
        )
        if payload.get("storey"):
            lines.append(f"Geschoß: {payload['storey']}")
        if payload.get("predefinedType"):
            lines.append(f"PredefinedType: {payload['predefinedType']}")
        container = payload.get("container")
        if isinstance(container, dict):
            lines.append(f"Liegt in: {container.get('ifcType')} „{container.get('name')}“")
        available = payload.get("available") or []
        if available:
            lines.append("Vorhandene Relationen: " + ", ".join(str(name) for name in available))
        if payload.get("hinweis"):
            lines.append(f"Hinweis: {payload['hinweis']}")
        return "\n".join(line for line in lines if line)

    if operation == "shopping_list" and isinstance(payload, dict):
        lines.append(str(payload.get("summary") or ""))
        if payload.get("path"):
            lines.append(
                f"IDS-Datei geschrieben: {payload['path']} "
                f"({payload.get('specifications')} Spezifikationen, {payload.get('bytes')} Bytes)."
            )
        for entry in payload.get("exported") or []:
            lines.append(f"- enthalten: {entry}")
        for entry in payload.get("notExportable") or []:
            lines.append(f"- NICHT als IDS ausdrückbar: {entry.get('what')} — {entry.get('why')}")
        lines.append(
            "Die Datei verlangt nur, DASS ein Merkmal vorhanden ist, nie welchen Wert es haben muss. "
            "Grenzwerte kommen aus der Bestimmung."
        )
        return "\n".join(line for line in lines if line)

    if operation == "draw" and isinstance(payload, dict):
        lines.append(
            f"Zeichnung erzeugt: {payload.get('path')} ({payload.get('bytes')} Bytes, {payload.get('seconds')} s)."
        )
        lines.append(
            "Die Zeichnung liegt als Datei auf dem Server. Maße NICHT aus dem Bild ablesen — dafür "
            "operation='measure' oder 'distance' verwenden."
        )
        return "\n".join(line for line in lines if line)

    # Every measure that applies to one element. Without this branch the payload
    # falls through to `str(payload)` at the bottom of this function and dumps a
    # raw Python dict — thousands of tokens of `{'value': {...}, 'tolerance':
    # 0.005, ...}` with the German provenance verbs stripped out, which is the
    # rendering defect this whole module exists to prevent, at the largest
    # payload on the surface.
    if isinstance(payload, dict) and "measures" in payload and "element" in payload:
        element = payload.get("element") or {}
        head = f"gemessen an {element.get('name') or element.get('globalId')} ({element.get('ifcType')}"
        if payload.get("storey"):
            head += f", {payload['storey']}"
        lines.append(head + "):")
        for name, answer in (payload.get("measures") or {}).items():
            answer = answer or {}
            if answer.get("error"):
                lines.append(f"- {name}: FEHLER — {answer['error']}")
            elif answer.get("decidable"):
                value = _value_text(answer.get("value"))
                unit = answer.get("unit") or ""
                lines.append(f"- {name}: {value} {unit}".rstrip())
            else:
                missing = (answer.get("missing") or {}).get("what") or "nicht entscheidbar"
                lines.append(f"- {name}: NICHT ENTSCHEIDBAR — {missing}")
        skipped = payload.get("notMeasured") or {}
        if skipped.get("kinds"):
            lines.append(f"Nicht gemessen: {', '.join(skipped['kinds'])}. {skipped.get('why') or ''}".strip())
        lines.append(
            "Verkürzte Übersicht: Toleranz, Herkunft und Methode je Kennwert liefert operation='measure' "
            "für den einen, auf den es ankommt. Lange Listen sind gekürzt."
        )
        return "\n".join(line for line in lines if line)

    # A batch measurement — one `measure` call over several elements. Rendered
    # as a table with the SPREAD first, because that is the finding: „alle 17
    # Kellerräume 2.70 m" and „16 davon 2.70 m, einer 0.25 m" are different
    # answers to the same question, and only the second is true of the
    # Institute's basement. Flattening this through `_value_text` would print
    # „results=17 Einträge, summary=(…)" — seventeen measurements and not one
    # number, the same defect the door graph had.
    if isinstance(payload, dict) and "results" in payload and "summary" in payload:
        summary = payload.get("summary") or {}
        results = payload.get("results") or []
        measured, of = summary.get("measured", 0), summary.get("of", len(results))
        spread = summary.get("spread")
        head = f"gemessen: {payload.get('measure')} an {measured} von {of} Bauteilen"
        if spread is not None and spread > 0:
            head += f" — von {_num(summary.get('min'), 3)} bis {_num(summary.get('max'), 3)}, Spanne {_num(spread, 3)}"
        elif spread == 0:
            head += f" — durchgehend {_num(summary.get('min'), 3)}"
        if payload.get("truncated"):
            head += f" (von {summary.get('selected')} passenden — NUR diese Auswahl)"
        lines.append(head + ".")
        for entry in results[:40]:
            answer = entry.get("answer") or {}
            # `survey` carries the name; a bare `measure` over a list of ids does
            # not. Preferring the name matters more than it looks: a reviewer who
            # has to act on „einer dieser Räume ist 0,25 m hoch" needs to know
            # WHICH, and a 22-character GlobalId is not something a person can
            # carry to a CAD window.
            label = entry.get("name") or entry.get("globalId")
            if entry.get("name") and entry.get("storey"):
                label = f"{entry['name']} ({entry['storey']})"
            if answer.get("decidable"):
                value = _num(answer.get("value"), _decimals(answer.get("tolerance")))
                lines.append(f"- {label}: {value} {answer.get('unit') or ''}".rstrip())
            else:
                missing = (answer.get("missing") or {}).get("what") or "nicht entscheidbar"
                lines.append(f"- {label}: NICHT ENTSCHEIDBAR — {missing}")
        if len(results) > 40:
            lines.append(f"… {len(results) - 40} weitere nicht gezeigt.")
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
        if spread:
            # Only when there IS a spread. Printing „die Spanne ist die Aussage"
            # under a survey that measured nothing was advice about a number the
            # caller does not have, and the sentence has to keep meaning
            # something for the cases where it fires.
            lines.append("Die Spanne ist die Aussage: ein einzeln gemessener Raum belegt nichts über die übrigen.")
        return "\n".join(line for line in lines if line)

    if isinstance(payload, dict) and "decidable" in payload:
        lines.extend(_render_answer(payload))
        return "\n".join(line for line in lines if line)

    lines.append(str(payload))
    return "\n".join(line for line in lines if line)


# ── the three ways this tool can fail, said differently ──────────────────────
#
# Kept as module-level text rather than inline strings so the distinction is
# testable without a running frontend — and so it stays a distinction. The whole
# reason `BimQueryRejectedError` exists is that every 4xx used to be reported as
# "the model service is unavailable", which ends a turn on a typo with the agent
# instructed to say nothing about the building.


def _rejected_text(reason: str) -> str:
    """The arguments were wrong, and that is fixable in this same turn."""
    return (
        f"Error: the request was rejected — {reason}. This is a problem with the arguments, not "
        "with the model. Correct them and call the tool again. Do NOT state anything about the "
        "building on the strength of this."
    )


def _unrunnable_text(reason: str) -> str:
    """The call could not be MADE. Two kinds, and they need opposite advice.

    Distinct from `decidable: false`, which is a successful answer about the
    export and renders as a finding, not as an error.

    An unknown GlobalId means look it up again. A WRONG KIND — asking a wall for
    its clear opening width — means the id is CORRECT and the operator is not,
    and telling the agent to re-check the id sends it to `find_elements` for
    something it already has, then back with the same wrong call. The engine's
    own message already names the operator that would answer, so the advice here
    is to take it.
    """
    wrong_kind = "Fehler im Aufruf" in reason
    if wrong_kind:
        return (
            f"Error: {reason}. The GlobalId is fine — the OPERATOR is wrong for this kind of "
            "element. Do not look the id up again; use the operator named above."
        )
    return (
        f"Error: {reason}. This is a problem with the arguments, not with the building — "
        "check the GlobalId with operation='find_elements' and call again."
    )


#: Nothing was looked at. "Could not look" is not "looked and found nothing".
UNAVAILABLE_TEXT = (
    "Error: das Modell konnte gerade nicht gelesen werden (der Modelldienst ist nicht erreichbar). "
    "Do NOT state anything about the building's geometry; tell the user the model could not be read."
)


def _too_large_text(model_bytes: int | None, limit_bytes: int) -> str:
    """A model this worker cannot hold — a fact about the FILE, not an outage.

    Named separately from :data:`UNAVAILABLE_TEXT` because the two need opposite
    actions from the reader. An outage means wait. This never resolves on its
    own: the export has to get smaller or the worker bigger, and the message
    says which, with the numbers in it so nobody is arguing with an invisible
    limit.

    `ifc_query` is offered by name because it still works — the metadata half
    reads the extracted index and never touches these bytes, so "too large to
    MEASURE" is a much narrower failure than it sounds.
    """
    size = f"{model_bytes / (1024 * 1024):.0f} MB" if model_bytes else "Dieses Modell"
    limit = f"{limit_bytes // (1024 * 1024)} MB"
    return (
        f"Error: das Modell ({size}) ist zu groß für die geometrische Auswertung auf diesem Server "
        f"(Grenze {limit}). Das ist eine Aussage über die DATEI, kein Ausfall — Warten hilft nicht. "
        "Dem Nutzer sagen: entweder das Modell nach Bauteil oder Bauabschnitt getrennt exportieren, "
        "oder einen größeren Auswerte-Server anfordern. Metadaten-Fragen (Bauteillisten, "
        "Property-Werte, Zählungen) sind mit ifc_query weiterhin beantwortbar — die laufen über den "
        "extrahierten Index und nicht über die Datei. Keine Maße schätzen."
    )


#: This deployment has no geometry engine. Not a fact about the building either.
ENGINE_UNAVAILABLE_TEXT = (
    "Error: geometric measurement is not available in this deployment (the spatial engine is not "
    "installed). Metadata questions can still be answered with ifc_query. Do NOT estimate the number."
)


def _trace(operation: str, detail: str, *, outcome: str) -> None:
    """What this call did, for Langfuse (ADR-0045 §Observability).

    The same seam ``ifc_query`` uses and the same rule about its contents: the
    SHAPE of the call, never the building. ``ifc_measure_detail`` is a relation
    or measure NAME from a closed vocabulary in this file — never a GlobalId, an
    element name or a measured value.
    """
    from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
    from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

    add_trace_tag("feature:ifc")
    # Both fields are drawn from the closed vocabularies at the top of this
    # file. An operation the model invented is recorded as `unknown` rather than
    # echoed: free text out of a language model is not a fact about this call,
    # and an external observability service is not the place to find that out.
    known = operation if operation in VALID_OPERATIONS else "unknown"
    known_detail = detail if detail in RELATIONS or detail in MEASURES or detail in DISTANCE_MODES else None
    record_trace_metadata(
        ifc_op=f"measure:{known}",
        ifc_outcome=outcome,
        ifc_measure_detail=known_detail,
    )


class IfcMeasureConfig(FunctionBaseConfig, name="ifc_measure"):
    """Configuration for the ``ifc_measure`` spatial tool."""

    default_limit: int = Field(default=50, description="Rows returned by 'find_elements' when none is given.")


@register_function(config_type=IfcMeasureConfig)
async def ifc_measure(tool_config: IfcMeasureConfig, builder: Builder):
    from aiq_agent.knowledge.bim_query import BimQueryRejectedError
    from aiq_agent.knowledge.bim_query import BimQueryUnavailableError
    from aiq_agent.knowledge.ifc_spatial_client import ModelTooLargeError
    from aiq_agent.knowledge.ifc_spatial_client import SpatialEngineUnavailableError
    from aiq_agent.knowledge.ifc_spatial_client import SpatialToolError
    from aiq_agent.knowledge.ifc_spatial_client import call_spatial_tool
    from aiq_agent.knowledge.ifc_spatial_client import open_model
    from aiq_agent.knowledge.ifc_spatial_client import resolve_model_source
    from aiq_agent.project_context import get_organization_id_from_context
    from aiq_agent.project_context import get_project_id_from_context

    def _run(organization_id: str, project_id: str | None, model_name: str, name: str, args: dict[str, Any]):
        """Resolve, load and call — one blocking unit for ``to_thread``."""
        source = resolve_model_source(
            organization_id=organization_id,
            project_id=project_id,
            model_name=model_name or None,
        )
        if not source.get("resolved"):
            return source, None, ""
        handle = open_model(source)
        return source, call_spatial_tool(handle, name, args), handle

    async def _ifc_measure(arguments: IfcMeasureInput) -> list[dict] | str:
        """Measure the project's IFC/BIM model and report the provenance.

        One validated argument rather than sixteen loose ones. The defaults used
        to be written twice — once in this signature and once in the prose that
        told the model what they were — and the two disagreed: `mode` defaulted
        to 'min' here, so every `view` call that took the description at its
        word and omitted the field arrived as mode='min', which `view` does not
        have, and was refused. The description said the default was 'highlight'
        and it was telling the truth about `_build_call`; nothing between them
        was. :class:`IfcMeasureInput` is now the only place a default is
        written, and 'not given' reaches `_build_call` as 'not given', where the
        per-operation default has always lived.
        """
        organization_id = get_organization_id_from_context()
        if not organization_id:
            return "Error: organization unknown for this session — the BIM model cannot be read. Do not retry."
        project_id = get_project_id_from_context()
        if not project_id:
            # Same hole as `ifc_query`, same reason: `/api/internal/bim/source`
            # needs a project to scope the model list to, this tool never sends
            # a modelId, and the 400 that results reads as a correctable
            # argument error. Refused here, where the reason is knowable.
            _trace(arguments.operation, "", outcome="no_project")
            return NO_PROJECT_TEXT

        limit = arguments.limit
        built = _build_call(
            operation=arguments.operation,
            global_id=str(arguments.global_id),
            other_global_id=str(arguments.other_global_id),
            relation=arguments.relation or "",
            measure=arguments.measure or "",
            mode=arguments.mode or "",
            ifc_type=arguments.ifc_type,
            name_contains=arguments.name_contains,
            storey=arguments.storey,
            kind=arguments.kind or "",
            room_kind=arguments.room_kind or "",
            limit=limit if limit and limit > 0 else tool_config.default_limit,
            # Passed through as they arrived. "Not given" is `None` in the
            # schema itself, so nothing here has to re-decide what a missing
            # angle looks like — and `swivel_deg=0` (a real, legal value: no
            # lateral Verschwenkung) reaches `_build_call` as 0 instead of being
            # laundered into "absent" by a falsiness test.
            angle_deg=arguments.angle_deg,
            swivel_deg=arguments.swivel_deg,
            when=arguments.when,
        )
        if isinstance(built, str):
            # Rejected before anything was resolved, downloaded or parsed.
            _trace(arguments.operation, "", outcome="rejected")
            return built
        name, args = built
        detail = str(args.get("relation") or args.get("measure") or args.get("mode") or "")

        try:
            source, payload, handle = await asyncio.to_thread(
                _run, organization_id, project_id, arguments.model_name, name, args
            )
        except BimQueryRejectedError as exc:
            logger.info("ifc_measure was rejected: %s", exc)
            _trace(name, detail, outcome="rejected")
            return _rejected_text(str(exc))
        except ModelTooLargeError as exc:
            # Caught BEFORE its base class, and reported as a fact about the
            # FILE. As a generic outage this sent an architect off to wait for a
            # service to recover that was never down.
            logger.info("ifc_measure refused an oversized model: %s", exc)
            _trace(name, detail, outcome="model_too_large")
            return _too_large_text(exc.model_bytes, exc.limit_bytes)
        except BimQueryUnavailableError as exc:
            # "Could not look" is not "looked and found nothing" — say so, or a
            # transport failure gets reported as a fact about the building.
            logger.warning("ifc_measure could not obtain the model: %s", exc)
            _trace(name, detail, outcome="service_unavailable")
            return UNAVAILABLE_TEXT
        except SpatialEngineUnavailableError:
            logger.warning("ifc_measure was called but the spatial engine is not installed")
            _trace(name, detail, outcome="engine_unavailable")
            return ENGINE_UNAVAILABLE_TEXT
        except SpatialToolError as exc:
            # A call that could NOT BE MADE — an unknown GlobalId, a relation
            # the engine does not have. Distinct from every `decidable: false`,
            # which is a successful answer about the EXPORT and is rendered as
            # one further down.
            logger.info("ifc_measure could not run the operator: %s", exc)
            _trace(name, detail, outcome="rejected")
            return _unrunnable_text(str(exc))

        if not source.get("resolved"):
            _trace(name, detail, outcome=f"unresolved:{source.get('reason', 'unknown')}")
            return _render_unresolved(source)

        decidable = payload.get("decidable") if isinstance(payload, dict) else None
        _trace(
            name,
            detail,
            outcome="undecidable" if decidable is False else "resolved",
        )
        if name == "view" and isinstance(payload, dict) and payload.get("pngBase64"):
            return _image_blocks(payload, source=source, handle=handle)
        return _render(name, payload, source=source, handle=handle)

    # `input_schema` is passed rather than inferred, which is the whole point:
    # NAT hands it to the framework wrapper as the tool's `args_schema`, and
    # that is what becomes the JSON schema the model is shown. Inferred from the
    # signature it was sixteen bare strings; declared, it carries the enums, the
    # per-parameter text and the one required field.
    yield FunctionInfo.from_fn(_ifc_measure, input_schema=IfcMeasureInput, description=_TOOL_DESCRIPTION)
