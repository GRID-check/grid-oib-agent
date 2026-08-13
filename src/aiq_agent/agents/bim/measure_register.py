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

from pydantic import Field

# Shared with `ifc_query` so the two halves of the BIM surface fail identically:
# an agent that learns this sentence from one tool reads it correctly from the
# other. The dependency runs measure -> register and never back, so `register`
# stays loadable on a deployment without the spatial engine — which is the
# independence the two entry points in pyproject.toml exist to preserve.
from aiq_agent.agents.bim.register import NO_PROJECT_TEXT
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

VALID_OPERATIONS = {
    "briefing",
    "find_elements",
    "element",
    "relations",
    "measure",
    "distance",
    "storey_heights",
    "room_inventory",
    "draw",
    "view",
    "shopping_list",
    "fire",
    "overhang",
    "light_incidence",
}

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


def _enum_lines(entries: dict[str, str], indent: str = "    ") -> str:
    return "\n".join(f"{indent}{name} — {meaning}" for name, meaning in entries.items())


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
    "operation:\n"
    "  'briefing'       — the building briefing for this model. Free, no geometry. START HERE.\n"
    "  'find_elements'  — GlobalIds by ifc_type / name_contains / storey / kind. The input every other "
    "operation needs. Free, no geometry.\n"
    "  'element'        — everything about ONE element: type, name, storey, container, and which "
    "relations it actually has. Free, no geometry.\n"
    "  'relations'      — one topological question about one element. Set 'relation':\n"
    f"{_enum_lines(RELATIONS)}\n"
    "  'measure'        — one measurement of one element. Set 'measure':\n"
    f"{_enum_lines(MEASURES)}\n"
    "  'distance'       — the distance between TWO elements. Set 'global_id' and 'other_global_id', "
    "and 'mode':\n"
    f"{_enum_lines(DISTANCE_MODES)}\n"
    "  'storey_heights' — the storey pitch (slab top to slab top) for every storey. This is the "
    "STRUCTURAL height, NOT the lichte Raumhöhe — never use it for a Raumhöhennachweis, use "
    "measure/clearHeight.\n"
    "  'room_inventory' — rooms grouped by a SUSPECTED use (room_kind: aufenthaltsraum, nebenraum, "
    "erschliessung), inferred from their names. A proposal for a human to confirm, never a finding.\n"
    "  'overhang'       — how far one element projects past another's facade plane, in metres. The "
    "Dachüberstand, the balcony, the canopy. global_id is the projecting element, other_global_id the "
    "one whose outer face is the reference — get that from relations/hostedIn on the window.\n"
    "  'light_incidence' — builds the light prism over an opening's lower edge and reports which "
    "elements reach into it and how deep. angle_deg and swivel_deg come from the BESTIMMUNG, not from "
    "the model (OIB 3: 45 and 30) and the tool refuses without them rather than defaulting, because "
    "supplying the angle would be applying the clause. The result is GEOMETRY: a cut prism enlarges "
    "the required Lichteintrittsflaeche under OIB 3, it does not ban the window. Report what intrudes "
    "and how far, then apply the clause yourself. other_global_id EXCLUDES elements from the test — one "
    "GlobalId, or several separated by commas. The host wall is deliberately not excluded on its own, "
    "because a window set deep in a thick wall genuinely is shaded by its own reveal — but if the wall "
    "comes back as an obstruction, re-run with it excluded (keeping any other exclusion you already "
    "had), and say in the answer that you did and why.\n"
    "  'view'           — LOOK at a floor plan. Returns the storey as an IMAGE you can actually see, "
    "cut at 1.2 m so door and window openings appear as gaps. global_id takes one GlobalId or several "
    "separated by commas; mode='highlight' (default) marks them red on the full plan ('where is this'), "
    "mode='only' draws nothing else ('what does this look like'). Use it to settle which element is "
    "meant, to sanity-check that a measured arrangement looks the way the numbers imply, or before "
    "measuring at all. ~6 s. NEVER read a number off it — a dimension taken from a picture is guessed "
    "even when it happens to be right.\n"
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
    "drawing: 'draw' shows the arrangement, measure/distance give the numbers, and a value read off an "
    "image is guessed even when it happens to be right.\n"
    "\n"
    "COST — plan the calls before making them. 'briefing', 'find_elements' and 'element' are free "
    "(pure topology). The first 'measure' or 'distance' on a model tessellates it (~2 s for a "
    "single-family house). relations opensTo / bounds / enclosedBy / adjacentSpaces build a "
    "space-contact map on first use — around 7 seconds on a cold model — because most exports write no "
    "IfcRelSpaceBoundary and it has to be derived. 'draw' is ~5 s. After that everything is "
    "milliseconds, because the model stays parsed. Do NOT call the geometric relations speculatively "
    "or 'to see what is there' — call them when the answer needs them.\n"
    "\n"
    "Every GlobalId you pass must come from find_elements, from element, or from an ifc_query result "
    "in THIS turn. An invented GlobalId is refused by name, not guessed at.\n"
    "\n"
    "A typical chain — 'ist die Raumhöhe im Wohnzimmer ausreichend?':\n"
    "  1. operation='briefing'  → the storey names and what this file cannot answer\n"
    "  2. operation='find_elements' ifc_type='IfcSpace' name_contains='Wohn' storey='Erdgeschoss'\n"
    "  3. operation='measure' global_id='<the GlobalId from step 2>' measure='clearHeight'\n"
    "  4. report the rendered line as it stands — gemessen, with its tolerance and its caveat\n"
    "For a distance: operation='distance' global_id='<a>' other_global_id='<b>' mode='horizontal'. "
    "For a room's suspected use: operation='room_inventory' room_kind='aufenthaltsraum'. "
    "For a plan: operation='draw' storey='Erdgeschoss'.\n"
    "\n"
    "model_name selects one model when the project has several (a substring of the file name); leave "
    "it empty when there is only one. When the model cannot be resolved the tool says so in German — "
    "report that sentence rather than answering from the model's own knowledge.\n"
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
            return f"Error: room_kind '{room_kind}' does not exist. Use one of: {', '.join(ROOM_KINDS)}."
        return "room_inventory", {"kind": wanted}

    if op == "fire":
        wanted = _clean(kind) or "fluchtniveau"
        aspect = next((k for k in FIRE_ASPECTS if k.lower() == wanted.lower()), None)
        if aspect is None:
            return f"Error: for operation 'fire', kind must be one of: {', '.join(FIRE_ASPECTS)}. Got '{kind}'."
        args = {"what": aspect}
        if _clean(global_id):
            args["globalId"] = _clean(global_id)
        return "fire", args

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
            return f"Error: relation '{relation}' does not exist. Use one of: {', '.join(RELATIONS)}."
        return "relations", {"globalId": subject, "relation": wanted}

    if op == "measure":
        wanted = _clean(measure)
        if wanted not in MEASURES:
            return f"Error: measure '{measure}' does not exist. Use one of: {', '.join(MEASURES)}."
        return "measure", {"globalId": subject, "measure": wanted}

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
            text = _value_text(inner, decimals)
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

    # `light_incidence` answers a yes/no question with a list, and the list can
    # be empty — which is the ANSWER (nothing intrudes) and renders as nothing
    # at all without this line. It goes above the entries because it is the
    # sentence the reader came for.
    if "free" in answer:
        unit = answer.get("unit") or "m"
        prism = answer.get("prism") or {}
        angles = (
            f" (Prisma {_angle(prism.get('angleDeg'))}°"
            + (f", seitlich {_angle(prism.get('swivelDeg'))}°" if prism.get("swivelDeg") else "")
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


def _render(
    operation: str,
    payload: Any,
    *,
    source: dict[str, Any] | None = None,
    handle: str = "",
) -> str:
    """The engine's result as the string the model reads."""
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

    async def _ifc_measure(
        operation: str = "briefing",
        global_id: str = "",
        other_global_id: str = "",
        relation: str = "",
        measure: str = "",
        mode: str = "min",
        ifc_type: str = "",
        name_contains: str = "",
        storey: str = "",
        kind: str = "",
        room_kind: str = "",
        model_name: str = "",
        limit: int = 0,
        angle_deg: float = 0.0,
        swivel_deg: float = 0.0,
    ) -> list[dict] | str:
        """Measure the project's IFC/BIM model and report the provenance."""
        organization_id = get_organization_id_from_context()
        if not organization_id:
            return "Error: organization unknown for this session — the BIM model cannot be read. Do not retry."
        project_id = get_project_id_from_context()
        if not project_id:
            # Same hole as `ifc_query`, same reason: `/api/internal/bim/source`
            # needs a project to scope the model list to, this tool never sends
            # a modelId, and the 400 that results reads as a correctable
            # argument error. Refused here, where the reason is knowable.
            _trace((operation or "").strip().lower(), "", outcome="no_project")
            return NO_PROJECT_TEXT

        built = _build_call(
            operation=operation or "briefing",
            global_id=global_id or "",
            other_global_id=other_global_id or "",
            relation=relation or "",
            measure=measure or "",
            mode=mode or "",
            ifc_type=ifc_type or "",
            name_contains=name_contains or "",
            storey=storey or "",
            kind=kind or "",
            room_kind=room_kind or "",
            limit=limit if limit and limit > 0 else tool_config.default_limit,
            # Zero is "not given" for both, which is safe because neither is a
            # usable angle: `light_incidence` refuses a missing or out-of-range
            # one by name rather than defaulting to 45, since the angle is a
            # fact about the clause and supplying it would be applying the law.
            angle_deg=angle_deg if angle_deg else None,
            swivel_deg=swivel_deg if swivel_deg else None,
        )
        if isinstance(built, str):
            # Rejected before anything was resolved, downloaded or parsed.
            _trace((operation or "").strip().lower(), "", outcome="rejected")
            return built
        name, args = built
        detail = str(args.get("relation") or args.get("measure") or args.get("mode") or "")

        try:
            source, payload, handle = await asyncio.to_thread(
                _run, organization_id, project_id, model_name or "", name, args
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

    yield FunctionInfo.from_fn(_ifc_measure, description=_TOOL_DESCRIPTION)
