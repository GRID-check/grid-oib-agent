"""Treppen und Rampen — the geometry OIB 4 and OIB 2 actually turn on.

The engine could measure a window sill to the millimetre and could not say how
high one step of a staircase is. That is an accident of history: the first
failing example this package chased happened to be a daylight question, so the
daylight side grew and the circulation side did not. The repository's own golden
benchmark asks *„Welche Anforderungen stellt OIB-RL 4 an Treppenlauf-Nutzbreiten
in Bürogebäuden?"* and the answer layer had nothing to measure against — no
riser, no tread, no Nutzbreite, no Durchgangshöhe.

## Four operators, and what each one is FOR

:func:`stair_geometry`
    Steigungshöhe, Auftrittsbreite, their **spread**, the total rise and going,
    and the Nutzbreite of the flight. The spread is not decoration: OIB 4 wants
    the risers of a flight equal, and a flight whose risers vary by 40 mm is a
    trip hazard that no single mean value reveals. The synthetic flight in
    ``test_stairs.py`` has risers of 0.160 / 0.190 / 0.170 / 0.200 / 0.180 m and
    a ``Pset_StairFlightCommon.RiserHeight`` of 0.180 — the declared value and
    the measured MEAN agree exactly, and the stair is still wrong. Only the
    spread says so.

:func:`ramp_slope`
    The slope as a percentage **and** as a ratio, because barrier-free ramps are
    decided on a percentage and drawn as a ratio, and because a bare number
    "6" is ambiguous between 6 %, 1:6 and 6°. All three forms travel together
    with the rise and the run they were derived from.

:func:`headroom`
    The Durchgangshöhe — measured PERPENDICULAR to the pitch, which is the
    measurement people get wrong. See the argument below; on the test fixture
    the vertical reading is 1.620 m and the true clear passage is 1.348 m, a
    27 cm error in the generous direction.

:func:`steps_of`
    The flights and landings an ``IfcStair`` aggregates, so a caller can ask
    about one flight rather than an assembly — OIB 4 limits risers per flight
    *without a landing*, so the landings are half the question.

## The geometric route, and why it is not the declared one

``Pset_StairCommon`` / ``Pset_StairFlightCommon`` carry ``NumberOfRiser``,
``RiserHeight`` and ``TreadLength``, and where they exist they are read. They are
not trusted on their own. A schedule value is what somebody TYPED; the solid is
what will be built, and the two disagree often enough that
:func:`~ifc_spatial.envelope.triangulate` exists in this package for exactly this
shape of finding. So both routes run and both are reported: the fixture's first
flight declares ``RiserHeight = 0.170`` over a body whose treads sit 0.180 m
apart, and the answer says so in the words `triangulate` already uses for a room
area — *"Das ist ein Befund über den Export, nicht über das Gebäude."*

The geometry itself is simple once seen: a stair flight's solid has horizontal
tread faces at regular heights. Cluster the up-facing triangles by Z, and the
spacings between consecutive clusters ARE the risers; the plan distance between
consecutive cluster centroids is the going; the width of the tread surfaces is
the Nutzbreite. No stair-specific kernel call is needed and none exists.

Two things that reading assumes are not true of real exports, and both cost this
module a confident wrong number on the first third-party file it met:

**One body is not one flight.** ArchiCAD writes the Institute's „Treppe-EG" as a
single ``IfcStair`` — no ``IfcStairFlight``, no landing slab, no
``PredefinedType`` — and it is a three-flight dogleg. Taking the chord from its
first tread centre to its last gives a diagonal across the stairwell, and every
number measured against that axis is a number about the stairwell: the reported
„Nutzbreite" of **0.318 m** is one tread measured across that diagonal — the
depth of a step, not the width of a flight — on flights that are **1.500 m**
wide. So the levels are split into runs at the turns and at the Podeste, and each
run is measured on its own axis (:func:`_read_body`).

**One step is not one face.** The same export writes each step twice — the
structural step and its tread finish 60 mm above it — so every riser was counted
twice and halved: **45 risers of 0.065 m** for 21 of 0.137 m. A face with another
face directly above it is not a walking surface, and :func:`_walking_surfaces`
drops it.

What cannot be read as a straight run is REFUSED, with the measurement that
decided it: a winder whose tread centres bow off their own chord, a "riser" of
0.065 m that no leg climbs. The refusal is a true statement about the file; the
number it replaces was a false statement about the building.

## Why the Durchgangshöhe is measured perpendicular

A vertical ray from a tread measures the wrong thing, and it is wrong in the
direction nobody checks. The tight point on a stair is where the flight passes
under the edge of the floor above; the shortest line from the walking surface to
that edge is perpendicular to the pitch, and it is SHORTER than any vertical
distance measured under it. On the fixture — a 33.7° flight passing under a slab
edge at x = 1.20 m, soffit 2.60 m — the smallest vertical clearance over the
pitch line is 1.620 m (1.645 m as this operator's rays sample it) and the true
clear passage is 1.348 m. An operator that reported the vertical figure would be
handing an architect 27 cm of headroom that is not there.

So the measurement is a surface-to-surface minimum from the **raking plane** (the
plane through the nosings, over the flight's width) to whatever is above it —
which is the perpendicular distance by construction, since the shortest distance
from a plane region to a point is along the normal. Rays along that normal find
the candidates; :func:`~ifc_spatial.clearance._soup_distance` then measures them
exactly, so the answer does not depend on a sample happening to land on the
critical point. Both numbers are reported, the perpendicular one as the value and
the vertical one beside it, because a clause that means the vertical reading must
be able to get it without a second call.

The exclusion discipline is :func:`~ifc_spatial.operators.clear_height`'s, not a
new one: :data:`~ifc_spatial.model.AIR_TYPES` and
:data:`~ifc_spatial.operators.FURNISHING` are skipped and everything else counts.
Unfiltered rays have already cost this repository three wrong answers, and a
chair is not a Durchgangshöhe. ``IfcRailing`` was proposed for that list and is
deliberately not in it — every stair in the corpus was reporting its own
balustrade as the thing a head hits (0.415 m on the FZK Wendeltreppe, 0.117 m on
each of the four Institute stairs, which measure 1.745 m), and the cause was the
rake and not the filter. See :data:`HEADROOM_TRANSPARENT` for the measurement
that settled it.

## What this module refuses to do

It names no OIB number. It does not know that a riser may be at most 18 cm, that
an office stair wants 1.20 m of Nutzbreite, or that a barrier-free ramp stops at
6 %. It measures, it reports the spread, it says which route each number came
from — and the Bestimmung decides. There is no verdict field, and „erfüllt"
appears nowhere in it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from .clearance import CLEARANCE_BUDGET_SECONDS
from .clearance import _soup_distance
from .clearance import _usable_triangles
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import triangulate
from .envelope import undecidable
from .geometry import FACE_AREA_FRACTION
from .geometry import MIN_FACE_AREA
from .geometry import triangle_normals_areas
from .model import AIR_TYPES
from .model import DeclaredQuantity
from .model import ElementGeometry
from .model import SpatialModel
from .operators import COORDINATE_TOLERANCE
from .operators import DIMENSION_TOLERANCE
from .operators import FURNISHING
from .operators import MIN_INTRUSION
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind

# ── what counts as what ─────────────────────────────────────────────────────

#: The subjects :func:`stair_geometry` will measure. ``IfcStair`` is in the list
#: because half the exports in the wild never split a stair into flights at all —
#: Revit writes one ``IfcStair`` carrying the whole body — and an operator that
#: only accepted ``IfcStairFlight`` would report „keine Treppe" about a file with
#: a staircase in it.
STAIR_TYPES = ("IfcStair", "IfcStairFlight")
#: The same for ramps.
RAMP_TYPES = ("IfcRamp", "IfcRampFlight")

#: ``normal.z`` above which a triangle counts as a tread surface. 0.99 is ~8° of
#: slack, which absorbs tessellation noise on a flat face and still rejects the
#: sloped soffit underneath — that soffit is within 34° of horizontal on an
#: ordinary flight and would otherwise be clustered as if it were a step.
TREAD_NORMAL_DOT = 0.99

#: How much a tread triangle may fall across itself, in metres.
#:
#: The normal alone cannot tell a tread from a shallow ramp, and this was
#: measured here rather than reasoned about: the fixture's 6 % entrance ramp has
#: a running surface at 3.4°, well inside :data:`TREAD_NORMAL_DOT`'s 8° of slack,
#: and the tread reader clustered its two triangles into "steps" 0.100 m apart —
#: a riser invented out of a ramp. A tread is not merely near-horizontal, it is
#: LEVEL WITHIN ITSELF: an external stair's drainage fall of 1.5 % drops 4 mm
#: over a 0.27 m going, while a ramp face drops the whole rise. 20 mm separates
#: the two by an order of magnitude in either direction.
TREAD_FLATNESS = 0.02

#: ``normal.z`` above which a triangle belongs to a ramp's running surface. Much
#: looser than :data:`TREAD_NORMAL_DOT` on purpose: the running surface of a ramp
#: IS the sloped face, so anything that faces upward at all is a candidate and the
#: dominant planar cluster decides. 0.05 keeps out the near-vertical sides.
RUNNING_SURFACE_MIN_DOT = 0.05

#: How far above a flight :func:`headroom` looks, in metres. A storey height plus
#: a stair rise; past that a hit is not a Durchgangshöhe but the underside of a
#: roof two floors up, and reporting it would be worse than reporting nothing.
HEADROOM_REACH = 6.0

#: Spacing of the sample points along the pitch line, metres. Only used to FIND
#: obstructions — the reported distance is measured exactly against the surfaces
#: that were found, so this spacing does not enter the number the way
#: ``clear_height``'s grid enters its own.
HEADROOM_SAMPLE_SPACING = 0.10

#: Where across the flight the sample rays are cast, as fractions of the width.
#: Deliberately not 0.0 and 1.0: a ray on the very edge of a flight hits the
#: stairwell wall beside it, and a wall beside a stair is not a Durchgangshöhe.
HEADROOM_LATERAL = (0.25, 0.5, 0.75)

#: Types that never stop a :func:`headroom` ray. ``clear_height``'s list, and
#: ``clear_height``'s reason: a chair is not a Durchgangshöhe.
#:
#: ``IfcRailing`` was proposed for this list and is deliberately NOT in it, and
#: the reason is worth keeping because the evidence pointed the other way at
#: first. Every stair in the corpus reported its own balustrade as the tight
#: point over the flight — 0.415 m on the FZK Wendeltreppe (``IfcRailing
#: 0o5vgCKyTBzO5$QJcI2YDP``), 0.117 m on each of the four Institute stairs —
#: which reads exactly like a missing type filter, and ArchiCAD does contain the
#: balustrade in the STOREY rather than in the stair, so no ``IfcRelAggregates``
#: exclusion could have reached it.
#:
#: It was not the filter. Those rays were cast from the rake that
#: :func:`_read_body` replaces: one plane fitted across a three-flight dogleg,
#: 0.318 m wide and tilted along the diagonal of the stairwell, which passes
#: through everything standing in the well — the balustrade included. Measured
#: with the flights read correctly and railings still counted, **no railing is a
#: ray candidate on any of the twelve flights of the four Institute stairs**, and
#: the tight point is the slab it always was (1.745 m under „Decke-001").
#:
#: So the type ban would have been a bandage over a fault that no longer exists,
#: and it would cost something real: a balustrade that genuinely stands over a
#: walking line — a gallery edge above the flight below, a handrail that leans
#: into the middle of a narrow stair — is something a head meets, and this
#: operator has to be able to say so. The lateral sampling at
#: :data:`HEADROOM_LATERAL` already keeps a railing standing at the EDGE of its
#: own flight out of the measurement, which is the case that was feared.
HEADROOM_TRANSPARENT = FURNISHING

#: How much of a horizontal face may lie under another horizontal face of the
#: SAME body before it stops being a walking surface — as a fraction of its own
#: plan area.
#:
#: ArchiCAD writes every step of ``AC20-Institute-Var-2.ifc`` twice: the
#: structural step and, 60 mm above it, the tread finish. Both are up-facing,
#: both are level within themselves and both clear the sliver filter, so the
#: reader counted **45 risers of 0.065 m** where the stair has 21 of 0.137 m.
#: The rule that separates them is physical rather than statistical: you cannot
#: walk on a surface that has another surface directly above it. Two consecutive
#: treads of a real flight are offset by their going and do not overlap in plan
#: at all, so half the face's own area is a wide margin.
BURIED_OVERLAP_FRACTION = 0.5

#: How close above a horizontal face another face may stand, in metres, for the
#: lower one to be BURIED rather than walked on.
#:
#: Not a headroom: on a dogleg the upper flight passes ~2 m over the lower one
#: within the same body, and a large window here would delete the lower flight.
#: 0.30 m is above the 60 mm finish layer and above the 0.20 m at which the
#: Institute's stair slab meets its landing, and far below any distance a person
#: could pass through — nothing walkable has 0.30 m of clear height over it.
BURIED_CLEARANCE = 0.30

#: How far the plan direction from one tread to the next may turn, in degrees,
#: before the two treads belong to different flights.
#:
#: Generous on purpose. The Institute's dogleg turns 88° at each landing, so
#: anything under ~60° separates its three flights; a WINDER turns 15–25° per
#: step, and a tight threshold would cut it into fifteen one-tread "flights"
#: that each measure nothing. A winder must fail :data:`FLIGHT_STRAIGHTNESS` as
#: one piece and be refused as one piece, which is what 30° arranges.
FLIGHT_TURN_DEGREES = 30.0

#: How far a tread centre may lie off the straight line through the first and
#: last tread centre of its run, in metres, before the run is not a straight
#: flight and nothing directional may be measured on it.
#:
#: A straight flight holds its centres on that line to within tessellation noise
#: (the Institute's three flights: below 1 mm). The FZK Wendeltreppe's centres
#: bow 0.5 m off their own chord, which is what makes „Auftritt 0.184 m,
#: Nutzbreite 0.200 m" on that stair a measurement of a chord across a stairwell
#: rather than of a step.
FLIGHT_STRAIGHTNESS = 0.05

#: How many times the median tread area a horizontal surface must cover before
#: it is a Podest rather than a Stufe.
#:
#: Measured on both sides. Institute: treads 0.598 m², landings 2.518 m² and
#: 2.783 m² — a factor of 4.2. FZK Wendeltreppe: every winder tread 0.107 m²,
#: so no factor at all and nothing is misread as a landing. Area rather than
#: depth because a winder tread's minimal rectangle is nearly as deep as it is
#: wide and a depth test calls all fifteen of them Podeste.
LANDING_AREA_FACTOR = 2.0

#: The band a measured riser must fall into to be a step at all, in metres.
#:
#: This is NOT OIB 4's maximum — that number belongs to the Bestimmung and this
#: layer must not know it. It is the band outside which the number cannot be a
#: step of any kind: below 0.08 m it is a finish layer, a chamfer or a drainage
#: fall (the Institute's doubled faces measured 0.065 m and were reported as a
#: stair), above 0.40 m nobody climbs it in one movement. Inside the band every
#: value is reported without comment, including ones OIB 4 would reject.
PLAUSIBLE_RISER = (0.08, 0.40)

#: How far the step from the flight's own underside to its first tread may
#: deviate from the median of the visible risers before it is dropped.
#:
#: The bottom riser is the one riser a flight's body does not always show. A
#: monolithic wedge (and every synthetic flight in the tests) starts at floor
#: level, so ``first tread − body base`` IS the first riser. A flight with a
#: waist starts at the underside of the soffit, tens of centimetres lower, and
#: taking that difference as a riser would invent a 0.6 m step. 50 % of the
#: median is wide enough for a genuinely uneven bottom step and narrow enough
#: that a soffit never passes.
BASE_RISER_RELATIVE_SLACK = 0.5

#: Pset names for the declared stair schedule, in priority order. Both the stair
#: and the flight pset use the same property names, which is why one list serves.
_RISER_COUNT_NAMES = ("NumberOfRiser", "NumberOfRisers", "NumberOfRiserPerFlight")
_RISER_HEIGHT_NAMES = ("RiserHeight",)
_TREAD_LENGTH_NAMES = ("TreadLength", "TreadLengthAtOffset", "Going")
_FLIGHT_WIDTH_NAMES = ("ClearWidth", "Width", "NominalWidth")
_RAMP_SLOPE_NAMES = ("Slope", "RequiredSlope")


def _sources(*ids: str | None) -> list[str]:
    """The ``from_`` list: every element that fed the answer, once, in order.

    Deduplicated because the subject of these operators is often its own source —
    ``stairGeometry(<flight>)`` measures the flight it was handed — and a
    ``from`` list that names the same GlobalId twice reads as two independent
    pieces of evidence.
    """
    return list(dict.fromkeys([i for i in ids if i]))


# ════════════════════════════════════════════════════════════════════════════
# the tread reading — one flight's body, turned into risers and goings
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class _Tread:
    """One horizontal step surface, as the mesh shows it."""

    z: float
    area: float
    #: Area-weighted centroid of the tread surface, world coordinates.
    centre: np.ndarray
    #: The tread's extent along the flight's own axes: (along_min, along_max,
    #: across_min, across_max), after the axes are known.
    span: tuple[float, float, float, float]


@dataclass(frozen=True)
class _Flight:
    """Everything one flight's solid says about its steps.

    One flight, not one body: a body that runs up, turns at a landing and runs
    up again holds three of these. See :func:`_read_body`.
    """

    global_id: str
    treads: list[_Tread]
    #: Riser heights, bottom to top. See :data:`BASE_RISER_RELATIVE_SLACK` for
    #: when the first one is in here and when it cannot be.
    risers: list[float]
    #: Whether the bottom riser (body base → first tread, or landing → first
    #: tread where a landing carries this flight) is among them.
    base_riser_used: bool
    #: Goings, bottom to top — plan distance between consecutive tread centres.
    goings: list[float]
    #: Narrowest tread surface: the Nutzbreite this body supports.
    clear_width: float
    #: Plan projection of all tread surfaces, along the flight's own axis.
    total_going: float
    total_rise: float
    #: Unit horizontal direction of travel, upward.
    along: np.ndarray
    #: Unit horizontal direction across the flight.
    across: np.ndarray
    #: Nosing points, bottom to top: the front edge of each tread at its centre.
    nosings: np.ndarray
    #: A Podest carries the foot of this flight / receives its head. Both are
    #: false for a flight that starts on the floor and ends on the storey above.
    landing_below: bool = False
    landing_above: bool = False


@dataclass(frozen=True)
class _Body:
    """What one solid holds: its flights, its landings, and what it refused.

    ``refusals`` is the part of the body the reader would not turn into numbers,
    in German and with the measurement that decided it. It is not an error
    channel — a body can yield two good flights and one refusal — and it is what
    the operators put in front of the reader instead of a number they made up.
    """

    flights: list[_Flight]
    landings: int
    refusals: list[str]
    #: Horizontal faces the body showed at all, after the buried ones are gone.
    levels: int


def _tread_surfaces(geo: ElementGeometry) -> list[tuple[float, float, np.ndarray, np.ndarray]]:
    """Up-facing horizontal faces of a body, clustered by height.

    Returns ``(z, area, centre, vertices)`` per cluster, ascending. Slivers are
    dropped by the same rule ``geometry.outermost_parallel_face`` uses — a face
    carries a cluster only if it holds :data:`~ifc_spatial.geometry.FACE_AREA_FRACTION`
    of the largest one — because a 20 mm nosing chamfer is up-facing, horizontal
    and NOT a step, and one of those between two real treads would split a
    0.18 m riser into two of 0.16 and 0.02.
    """
    tris = _usable_triangles(geo)
    if len(tris) == 0:
        return []
    normals, areas = triangle_normals_areas(tris)
    level = (tris[:, :, 2].max(axis=1) - tris[:, :, 2].min(axis=1)) <= TREAD_FLATNESS
    up = (normals[:, 2] >= TREAD_NORMAL_DOT) & level
    if not up.any():
        return []
    tris = tris[up]
    areas = areas[up]
    heights = tris.mean(axis=1)[:, 2]

    order = np.argsort(heights)
    clusters: list[list[int]] = []
    for index in order:
        if clusters and abs(float(heights[index]) - float(heights[clusters[-1][-1]])) <= COORDINATE_TOLERANCE:
            clusters[-1].append(int(index))
        else:
            clusters.append([int(index)])

    out: list[tuple[float, float, np.ndarray, np.ndarray]] = []
    for members in clusters:
        member_areas = areas[members]
        total = float(member_areas.sum())
        if total <= 0:
            continue
        centroids = tris[members].mean(axis=1)
        centre = (centroids * member_areas[:, None]).sum(axis=0) / total
        z = float((heights[members] * member_areas).sum() / total)
        out.append((z, total, centre, tris[members].reshape(-1, 3)))

    if not out:
        return []
    floor = max(max(c[1] for c in out) * FACE_AREA_FRACTION, MIN_FACE_AREA)
    return [c for c in out if c[1] >= floor]


def _plan_polygon(vertices: np.ndarray) -> Any:
    """The plan outline of one cluster, as a shapely polygon.

    ``vertices`` is the flattened triangle array ``_tread_surfaces`` carries, so
    it reshapes back into the triangles it was made of — the union of those in
    plan is the face's real outline. A bounding box would not do: two consecutive
    treads of a flight running diagonally in plan have boxes that overlap by more
    than half while the treads themselves only touch along their nosing, and the
    buried-face rule below would then delete every second step.
    """
    import shapely
    import shapely.ops

    polygons = []
    for tri in vertices.reshape(-1, 3, 3):
        polygon = shapely.Polygon(tri[:, :2])
        if polygon.is_valid and polygon.area > 0:
            polygons.append(polygon)
    if not polygons:
        return None
    return shapely.ops.unary_union(polygons)


def _walking_surfaces(
    clusters: list[tuple[float, float, np.ndarray, np.ndarray]],
) -> list[tuple[float, float, np.ndarray, np.ndarray]]:
    """The clusters a foot can land on — the buried ones dropped.

    A horizontal face with another horizontal face of the same body directly
    above it is not a step; it is under one. ArchiCAD writes each step of
    ``AC20-Institute-Var-2.ifc`` as a structural step and a tread finish 60 mm
    above it, both up-facing and both level, and every step was therefore counted
    twice: **45 risers of 0.065 m** on a stair with 21 of 0.137 m, with the
    doubled count and the halved riser both reported as measurements. The same
    rule removes the four faces that sit 0.20 m under that stair's landings.

    The test is the physical one and not a spacing heuristic: overlap in plan by
    more than :data:`BURIED_OVERLAP_FRACTION` of the lower face's own area, with
    the upper face within :data:`BURIED_CLEARANCE`. Consecutive treads of a real
    flight are offset by their going and do not overlap at all, so nothing a foot
    can reach is dropped by it.
    """
    if len(clusters) < 2:
        return list(clusters)

    polygons = [_plan_polygon(vertices) for _, _, _, vertices in clusters]
    keep: list[tuple[float, float, np.ndarray, np.ndarray]] = []
    for index, cluster in enumerate(clusters):
        mine = polygons[index]
        buried = False
        for other in range(index + 1, len(clusters)):
            gap = clusters[other][0] - cluster[0]
            if gap > BURIED_CLEARANCE:
                break  # ascending, so everything past this one is further up
            theirs = polygons[other]
            if mine is None or theirs is None or mine.area <= 0:
                continue
            if mine.intersection(theirs).area >= BURIED_OVERLAP_FRACTION * mine.area:
                buried = True
                break
        if not buried:
            keep.append(cluster)
    return keep


def _landing_levels(clusters: list[tuple[float, float, np.ndarray, np.ndarray]]) -> list[bool]:
    """Which of these surfaces are Podeste — by area against the median tread.

    A landing is not a step and must not be measured as one: on the Institute
    stair the two landings are 2.518 m² and 2.783 m² against a median tread of
    0.598 m², and taking them as treads is what produced „Auftritte 0.023 m bis
    1.053 m" there. The median is the tread, because a flight has many more
    treads than landings; :data:`LANDING_AREA_FACTOR` is the factor between them.
    """
    if not clusters:
        return []
    median = float(np.median([area for _, area, _, _ in clusters]))
    if median <= 0:
        return [False] * len(clusters)
    return [area > LANDING_AREA_FACTOR * median for _, area, _, _ in clusters]


def _runs(
    clusters: list[tuple[float, float, np.ndarray, np.ndarray]], landings: list[bool]
) -> list[tuple[list[int], bool, bool]]:
    """Split the levels into flights: ``(tread indices, Podest below, above)``.

    Two things end a flight and they are both what ends one on a drawing:

    * **a Podest.** It is the head of the flight under it and the foot of the
      flight over it, and it belongs to neither one's Auftritt.
    * **a turn.** Where the plan direction from one tread to the next swings by
      more than :data:`FLIGHT_TURN_DEGREES`, the treads after the turn are a
      different flight — the case a dogleg makes when the export writes no
      ``IfcStairFlight`` at all, which is the ArchiCAD case this exists for.

    Indices rather than the clusters themselves, because a cluster carries numpy
    arrays and ``list.index`` on one of those raises rather than compares.
    """
    groups: list[tuple[list[int], bool, bool]] = []
    current: list[int] = []
    carried_landing = False
    for index in range(len(clusters)):
        if landings[index]:
            if current:
                groups.append((current, carried_landing, True))
            current, carried_landing = [], True
            continue
        if len(current) >= 2:
            previous = clusters[current[-1]][2][:2] - clusters[current[-2]][2][:2]
            step = clusters[index][2][:2] - clusters[current[-1]][2][:2]
            if _turn_degrees(previous, step) > FLIGHT_TURN_DEGREES:
                groups.append((current, carried_landing, False))
                current, carried_landing = [], False
        current.append(index)
    if current:
        groups.append((current, carried_landing, False))
    return groups


def _turn_degrees(first: np.ndarray, second: np.ndarray) -> float:
    """Angle between two plan steps, in degrees. 0° for a degenerate one."""
    a, b = float(np.linalg.norm(first)), float(np.linalg.norm(second))
    if a < 1e-9 or b < 1e-9:
        return 0.0
    cosine = float(np.clip(np.dot(first, second) / (a * b), -1.0, 1.0))
    return math.degrees(math.acos(cosine))


def _measure_run(
    element: Any,
    treads_in: list[tuple[float, float, np.ndarray, np.ndarray]],
    *,
    base_z: float,
    landing_below: tuple[float, float, np.ndarray, np.ndarray] | None,
    landing_above: tuple[float, float, np.ndarray, np.ndarray] | None,
    alone: bool = False,
) -> tuple[_Flight | None, str | None]:
    """One straight run → a ``_Flight``, or ``None`` and the reason in German.

    The refusals are the point of this function. A stair that cannot be measured
    has to say so: the reader has already shipped „Nutzbreite 0.318 m" for a
    1.500 m flight and „16 Steigungen von 0.177 m bis 0.850 m" for a
    Wendeltreppe, and both were `decidable=True` with a confident number in them.
    Nothing here reports a value it could not derive.

    ``alone`` says this run is the whole body. A body that shows exactly one
    tread is a Blockstufe and is measured; a run of one tread cut out of a longer
    sequence by a turn on either side is a winder step, and at one of those there
    is no direction of travel to measure an Auftritt or a Nutzbreite along.
    """
    if len(treads_in) < 2 and landing_below is None and landing_above is None and not alone:
        return None, (
            "Ein Abschnitt des Körpers besteht aus einer einzelnen Trittfläche zwischen zwei "
            "Richtungswechseln. An einer gewendelten Stufe sind Auftritt und Nutzbreite nicht messbar."
        )

    if len(treads_in) >= 2:
        travel = treads_in[-1][2][:2] - treads_in[0][2][:2]
        length = float(np.linalg.norm(travel))
        if length < 1e-9:
            # Every tread centre over the same point in plan — a spiral flight
            # that closes on itself. Direction-based measurements are meaningless
            # here and pretending otherwise is how a Wendeltreppe gets reported
            # with a 0.00 m Auftritt.
            return None, (
                "Die Trittflächen liegen in der Draufsicht übereinander — ein Lauf, der sich um seine "
                "eigene Achse dreht. Auftritt und Nutzbreite sind daran nicht messbar."
            )
        along = np.array([travel[0] / length, travel[1] / length, 0.0])
    else:
        # A single tread between two Podeste is a real thing (one step down into
        # a room). Its travel direction is the SHORT axis of the tread: a step is
        # wide across and shallow along, so the short side of its own minimal
        # rectangle is the direction a person walks.
        along = _short_axis(treads_in[0][3])
        if along is None:
            return None, (
                "Eine einzelne Trittfläche ohne erkennbare Laufrichtung — an ihr ist keine Laufrichtung "
                "und damit keine Nutzbreite messbar."
            )
    across = np.array([-along[1], along[0], 0.0])

    if len(treads_in) >= 3:
        # Collinearity. A straight flight holds its tread centres on the line
        # through the first and the last to within tessellation noise; a winder
        # bows off it by half a metre, and every directional number measured
        # across that bow is a number about a chord and not about a step.
        first = treads_in[0][2][:2]
        last = treads_in[-1][2][:2]
        direction = last - first
        direction = direction / float(np.linalg.norm(direction))
        # The 2-D cross product, written out: numpy 2.0 deprecates `np.cross` on
        # 2-vectors and the perpendicular offset of a point from a unit line is
        # exactly this scalar.
        offsets = [
            abs(float(direction[0] * (cluster[2][1] - first[1]) - direction[1] * (cluster[2][0] - first[0])))
            for cluster in treads_in
        ]
        deviation = max(offsets)
        if deviation > FLIGHT_STRAIGHTNESS:
            return None, (
                f"Die Trittflächen liegen nicht auf einer Geraden: ihre Mitten weichen bis zu "
                f"{deviation:.3f} m von der Verbindungslinie zwischen erster und letzter Trittfläche ab. "
                "Das ist ein gewendelter Lauf; Steigung, Auftritt und Nutzbreite eines gewendelten Laufs "
                "sind entlang der Lauflinie zu messen, und die Lauflinie steht in dieser Datei nicht."
            )

    treads: list[_Tread] = []
    for z, area, centre, vertices in treads_in:
        a = vertices @ along
        b = vertices @ across
        treads.append(
            _Tread(z=z, area=area, centre=centre, span=(float(a.min()), float(a.max()), float(b.min()), float(b.max())))
        )

    levels = [t.z for t in treads]
    steps = [levels[i + 1] - levels[i] for i in range(len(levels) - 1)]
    if landing_below is not None:
        # The Podest under a flight IS its floor line, so the step up off it is
        # this flight's bottom riser and there is nothing to guess about.
        bottom = levels[0] - landing_below[0]
        base_riser_used = True
    else:
        bottom = levels[0] - base_z
        if steps:
            median = float(np.median(steps))
            base_riser_used = abs(bottom - median) <= BASE_RISER_RELATIVE_SLACK * median
        else:
            # Nothing to compare against. The body's underside is the only
            # candidate for a floor line, and the caveat says the measurement
            # rests on it.
            base_riser_used = bottom > MIN_INTRUSION
    risers = ([bottom] if base_riser_used else []) + steps
    if landing_above is not None:
        risers = risers + [landing_above[0] - levels[-1]]

    if risers:
        median_riser = float(np.median(risers))
        low, high = PLAUSIBLE_RISER
        if not low <= median_riser <= high:
            return None, (
                f"Die am Körper gemessene Steigungshöhe wäre {median_riser:.3f} m. Eine Stufe dieser Höhe "
                f"gibt es nicht (messbar sind {low:.2f} m bis {high:.2f} m) — die waagrechten Flächen dieses "
                "Körpers sind an dieser Stelle keine Stufen, sondern etwa Belagsschichten oder Auflager."
            )

    goings = [float(np.linalg.norm(treads[i + 1].centre[:2] - treads[i].centre[:2])) for i in range(len(treads) - 1)]
    widths = [t.span[3] - t.span[2] for t in treads]
    # The nosing is the FRONT edge of the tread — its minimum along the travel
    # direction — held at the tread's own lateral centre.
    nosings = np.array(
        [[*(t.centre[:2] + along[:2] * (t.span[0] - float(t.centre[:2] @ along[:2]))), t.z] for t in treads]
    )

    return (
        _Flight(
            global_id=element.GlobalId,
            treads=treads,
            risers=risers,
            base_riser_used=base_riser_used,
            goings=goings,
            clear_width=float(min(widths)),
            total_going=float(treads[-1].span[1] - treads[0].span[0]),
            total_rise=float(sum(risers)),
            along=along,
            across=across,
            nosings=nosings,
            landing_below=landing_below is not None,
            landing_above=landing_above is not None,
        ),
        None,
    )


def _short_axis(vertices: np.ndarray) -> np.ndarray | None:
    """Unit plan direction across the SHORT side of a face's minimal rectangle."""
    import shapely

    polygon = _plan_polygon(vertices)
    if polygon is None or polygon.area <= 0:
        return None
    rectangle = shapely.minimum_rotated_rectangle(polygon)
    corners = np.array(rectangle.exterior.coords[:-1]) if hasattr(rectangle, "exterior") else None
    if corners is None or len(corners) != 4:
        return None
    sides = [corners[(i + 1) % 4] - corners[i] for i in range(4)]
    shortest = min(sides[:2], key=lambda side: float(np.linalg.norm(side)))
    length = float(np.linalg.norm(shortest))
    if length < 1e-9:
        return None
    return np.array([shortest[0] / length, shortest[1] / length, 0.0])


def _read_body(model: SpatialModel, element: Any) -> _Body:
    """One solid → every flight in it, its landings, and what it refused.

    The reader used to assume that one body is one flight, and took the chord
    from the first tread centre to the last as the direction of travel. On the
    Institute's „Treppe-EG" — a three-flight dogleg written as ONE ``IfcStair``
    with no parts and no ``PredefinedType``, so nothing in the file announces the
    flights — that chord runs diagonally across the stairwell. Everything
    measured against it was measured against the wrong axis: the „Nutzbreite"
    it reported, **0.318 m**, is the depth of one tread across that diagonal —
    a step's going, near enough — on a flight that is **1.500 m** wide. A 4.7×
    understatement of the one number OIB 4's Nutzbreite question turns on, and
    in the direction that fails a stair which complies.

    So the levels are split into runs first — at the landings and at the turns —
    and each run is measured on its own axis. Whatever cannot be split into a
    straight run is refused with the measurement that decided it, never averaged
    into a number that looks like a stair.
    """
    geo = model.geometry(element.GlobalId)
    if geo is None:
        return _Body(flights=[], landings=0, refusals=[], levels=0)
    clusters = _walking_surfaces(_tread_surfaces(geo))
    if not clusters:
        return _Body(flights=[], landings=0, refusals=[], levels=0)

    landings = _landing_levels(clusters)
    groups = _runs(clusters, landings)
    landing_positions = [index for index, is_landing in enumerate(landings) if is_landing]

    flights: list[_Flight] = []
    refusals: list[str] = []
    for indices, below, above in groups:
        first, last = indices[0], indices[-1]
        landing_under = next((clusters[i] for i in reversed(landing_positions) if i < first), None) if below else None
        landing_over = next((clusters[i] for i in landing_positions if i > last), None) if above else None
        flight, refusal = _measure_run(
            element,
            [clusters[i] for i in indices],
            base_z=float(geo.box[0][2]),
            landing_below=landing_under,
            landing_above=landing_over,
            alone=len(groups) == 1,
        )
        if flight is not None:
            flights.append(flight)
        elif refusal is not None and refusal not in refusals:
            refusals.append(refusal)

    return _Body(flights=flights, landings=len(landing_positions), refusals=refusals, levels=len(clusters))


def _spread(values: list[float]) -> dict[str, float]:
    """Mean, extremes and spread of a set of measurements.

    ``spread`` is max − min and not a standard deviation: an architect fixes the
    two steps at the ends of the range, not a distribution, and OIB 4's demand
    that risers be equal is a statement about exactly that difference.
    """
    array = np.array(values, dtype=float)
    return {
        "mean": float(array.mean()),
        "min": float(array.min()),
        "max": float(array.max()),
        "spread": float(array.max() - array.min()),
        "count": int(array.size),
    }


# ════════════════════════════════════════════════════════════════════════════
# what the file declares about a stair
# ════════════════════════════════════════════════════════════════════════════


def _declared_count(model: SpatialModel, elements: list[Any]) -> tuple[int | None, str | None]:
    """``NumberOfRiser`` off the first element that declares it, with its source.

    Read with ``declared_property`` and not ``declared_quantity``, because a
    riser COUNT carries no unit and must not be run through a length conversion —
    in a millimetre model that path would turn 18 risers into 0.018.
    """
    for element in elements:
        value = model.declared_property(element, _RISER_COUNT_NAMES)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        return int(value), element.GlobalId
    return None, None


def _declared_length(
    model: SpatialModel, elements: list[Any], names: tuple[str, ...]
) -> tuple[DeclaredQuantity | None, str | None]:
    """The first declared length among ``names``, in metres, with its element.

    ``declared_quantity`` rather than ``declared_property`` because this one DOES
    carry a unit: ``Pset_StairCommon.RiserHeight`` is an ``IfcPositiveLengthMeasure``
    stated in the file's own length unit, so a millimetre export declares 175.0
    and means 0.175 m.
    """
    for element in elements:
        quantity = model.declared_quantity(element, names)
        if quantity is not None:
            return quantity, element.GlobalId
    return None, None


def _reconcile(
    measured: float | None,
    declared_quantity: DeclaredQuantity | None,
    *,
    subject_id: str,
    declared_on: str | None,
    method: str,
) -> tuple[dict[str, Any], str | None]:
    """One measured number against one declared number — the triangulated pair.

    Returns the block that goes into the answer's value and the German sentence
    (or ``None``) that the disagreement is worth. The sentence is
    ``envelope.triangulate``'s own, unchanged: the reader must not be able to tell
    whether a schedule/geometry conflict was found on a room area or on a riser.

    The two ``undecidable`` branches below stand for ONE missing route, never for
    both — the early return covers that case — but they still carry real German,
    because a placeholder that can only surface in a bug surfaces in a bug.
    """
    if measured is None and declared_quantity is None:
        return {"value": None, "declared": None, "agreement": None}, None

    measured_answer = (
        computed(measured, unit="m", tolerance=DIMENSION_TOLERANCE, from_=[subject_id], method=method)
        if measured is not None
        else undecidable(
            from_=[subject_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="dieser Wert ist am Körper nicht messbar",
                remedy="Der Körper zeigt die Flächen nicht, aus denen sich dieser Wert ablesen ließe.",
            ),
        )
    )
    declared_answer = (
        declared(declared_quantity.value, unit="m", from_=[declared_on or subject_id], method=method)
        if declared_quantity is not None
        else undecidable(
            from_=[subject_id],
            method=method,
            missing=MissingFact(
                what="die Datei deklariert diesen Wert nicht",
                remedy=(
                    "Steigungshöhe und Auftritt in Pset_StairCommon bzw. Pset_StairFlightCommon eintragen "
                    "und erneut exportieren."
                ),
            ),
        )
    )
    pair = triangulate(measured_answer, declared_answer, method=method)
    block: dict[str, Any] = {
        "value": pair.value,
        "measured": measured,
        "declared": None if declared_quantity is None else declared_quantity.value,
        "declaredAs": None if declared_quantity is None else declared_quantity.path,
        "agreement": pair.agreement,
    }
    return block, pair.caveat


# ════════════════════════════════════════════════════════════════════════════
# stair_geometry
# ════════════════════════════════════════════════════════════════════════════


def _parts_of(element: Any) -> list[Any]:
    """``IfcRelAggregates`` parts of an assembly, in file order."""
    out: list[Any] = []
    for rel in getattr(element, "IsDecomposedBy", []) or []:
        for part in rel.RelatedObjects or []:
            if getattr(part, "GlobalId", None):
                out.append(part)
    return out


def _is_landing(element: Any) -> bool:
    """A landing, by the only statement IFC makes about one.

    ``IfcSlab.PredefinedType = LANDING`` — not the name. Names are „Podest",
    „Landing", „Zwischenpodest" and „Slab:Generic 200mm:314159" depending on the
    exporter, and a name test would classify by locale.
    """
    if not element.is_a("IfcSlab"):
        return False
    return str(getattr(element, "PredefinedType", "") or "").upper() == "LANDING"


def _flight_parts(element: Any) -> tuple[list[Any], list[Any], list[Any]]:
    """An assembly's parts, split into flights, landings and everything else."""
    flights, landings, other = [], [], []
    for part in _parts_of(element):
        if part.is_a("IfcStairFlight") or part.is_a("IfcRampFlight"):
            flights.append(part)
        elif _is_landing(part):
            landings.append(part)
        else:
            other.append(part)
    return flights, landings, other


def stair_geometry(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """Steigungshöhe, Auftrittsbreite, their spread, rise, going and Nutzbreite.

    Both routes run and both are reported:

    - **the schedule** — ``Pset_StairCommon`` / ``Pset_StairFlightCommon`` with
      ``NumberOfRiser``, ``RiserHeight`` and ``TreadLength``, and
      ``Qto_StairFlightBaseQuantities`` where the export writes it;
    - **the solid** — the up-facing horizontal faces of the body, clustered by
      height. Consecutive spacings are the risers; the plan distance between
      consecutive tread centres is the going; the narrowest tread surface is the
      Nutzbreite.

    Where both exist they are triangulated, and a disagreement is reported as a
    finding about the EXPORT rather than resolved silently in favour of either.
    On the fixture: ``RiserHeight = 0.170`` declared, 0.180 measured, 5.6 % apart
    — the geometry wins the value and the caveat names both numbers.

    ## The spread is the point

    A mean riser height cannot fail. The fixture's second stair has risers of
    0.160, 0.190, 0.170, 0.200 and 0.180 m; their mean is exactly the declared
    0.180 and their **spread is 0.040 m**. OIB 4 requires the risers of a flight
    to be equal, and every number except the spread hides that they are not. So
    ``riserHeight`` and ``treadDepth`` each carry ``min``, ``max`` and ``spread``
    beside the mean, and the caveat says in German how far the steps vary.

    ## Assemblies

    An ``IfcStair`` that aggregates flights is measured flight by flight and the
    measurements are POOLED — a stair whose two flights are individually regular
    but differ from each other is exactly as unwalkable as one irregular flight,
    and pooling is what surfaces it. The per-flight breakdown travels in
    ``flights`` so a caller can still ask about one of them. An ``IfcStair`` with
    no parts is measured directly: Revit writes the whole staircase as one body
    and refusing that file would refuse most files.

    ## …and the assemblies that are not declared as one

    A body with no parts is not the same thing as a body with one flight, and
    treating it as one is what this operator got wrong. ArchiCAD writes the
    Institute's „Treppe-EG" as a single ``IfcStair`` with no ``IfcStairFlight``,
    no landing slab and no ``PredefinedType`` — nothing in the file says it is a
    three-flight dogleg — and the reader took the chord from its first tread to
    its last, which runs diagonally across the stairwell. It reported
    ``riserCount 45``, ``riserHeight 0.065``, ``clearWidth 0.318``, ``landings 0``
    with ``decidable=True``, for a stair with 21 risers of 0.137 m, a going of
    0.348 m, a **1.500 m** Nutzbreite and two Podeste. So the flights are found
    at the body — at the turns and at the landings — and each is measured on its
    own axis (:func:`_read_body`). What cannot be read as a straight flight is
    refused with the measurement that decided it rather than averaged.

    No threshold is applied and no verdict is returned. The maximum riser and the
    minimum Nutzbreite are in OIB 4, and OIB 4 is not this layer.
    """
    method = f"stairGeometry({global_id})"
    subject = _require(model, global_id, method)
    if not any(subject.is_a(name) for name in STAIR_TYPES):
        _wrong_kind(
            subject,
            method,
            "stairGeometry",
            "eine Treppe oder einen Treppenlauf (IfcStair, IfcStairFlight)",
            "für eine Rampe: rampSlope(); für die lichte Höhe über einem Lauf: headroom()",
        )

    flights, landings, _ = _flight_parts(subject)
    bodies = flights if flights else [subject]
    schedule_sources = [subject, *flights]

    readings = [(element, _read_body(model, element)) for element in bodies]
    measured = [(element, flight) for element, body in readings for flight in body.flights]
    refusals = [reason for _, body in readings for reason in body.refusals]
    measured_landings = sum(body.landings for _, body in readings)

    count, count_on = _declared_count(model, schedule_sources)
    riser_declared, riser_on = _declared_length(model, schedule_sources, _RISER_HEIGHT_NAMES)
    tread_declared, tread_on = _declared_length(model, schedule_sources, _TREAD_LENGTH_NAMES)
    width_declared, width_on = _declared_length(model, schedule_sources, _FLIGHT_WIDTH_NAMES)

    if not measured:
        # No body to read. A declared schedule is still an answer — an existing
        # building surveyed into a pset is a real case — and it is reported as
        # `declared`, never dressed up as a measurement.
        if riser_declared is None and tread_declared is None and count is None:
            geo, missing = _geometry_or_answer(model, subject, method)
            if geo is None:
                return missing  # type: ignore[return-value]
            # Two different absences, and they must not be reported as one. The
            # body that shows no horizontal face at all is an export defect; the
            # body that shows steps the reader would not measure is a stair this
            # engine cannot measure, and the reason it refused is the answer.
            return undecidable(
                from_=[global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what=(
                        (f"kein gerader Lauf am Körper von {subject.is_a()} „{model.label(subject) or global_id}“")
                        if refusals
                        else (
                            f"keine waagrechten Trittflächen am Körper von {subject.is_a()} "
                            f"„{model.label(subject) or global_id}“"
                        )
                    ),
                    remedy=(
                        " ".join(
                            [
                                *refusals,
                                "Abhilfe: die Treppe im CAD als Treppenbauteil mit je einem IfcStairFlight "
                                "pro Lauf exportieren, oder Steigungshöhe und Auftritt in "
                                "Pset_StairCommon.RiserHeight / .TreadLength deklarieren.",
                            ]
                        )
                        if refusals
                        else (
                            "Der Körper dieses Bauteils zeigt keine auswertbaren Stufen — er ist als Hüllquader, "
                            "als reine Fläche oder als eine einzige geschwungene Rampe exportiert. Abhilfe: die "
                            "Treppe im CAD als Treppenbauteil (IfcStair mit IfcStairFlight) mit voller "
                            "Körpergeometrie exportieren, oder Steigungshöhe und Auftritt in "
                            "Pset_StairCommon.RiserHeight / .TreadLength deklarieren."
                        )
                    ),
                    elements=[global_id],
                ),
            )

        # The same key shape as the measured route, with the measured half empty.
        # A consumer that reads `value["riserHeight"]["agreement"]` must not have
        # to know which route produced the answer — provenance already says that,
        # and a KeyError is a worse way to learn it.
        def _declared_block(quantity: DeclaredQuantity | None) -> dict[str, Any]:
            return {
                "value": None if quantity is None else quantity.value,
                "measured": None,
                "declared": None if quantity is None else quantity.value,
                "declaredAs": None if quantity is None else quantity.path,
                "agreement": None,
            }

        value: dict[str, Any] = {
            "riserCount": count,
            "risers": {
                "value": count,
                "measured": None,
                "declared": count,
                "declaredAs": None if count_on is None else "Pset_Stair(Flight)Common.NumberOfRiser",
                "agreement": None,
            },
            "riserHeight": _declared_block(riser_declared),
            "treadDepth": _declared_block(tread_declared),
            "clearWidth": None if width_declared is None else width_declared.value,
            "declaredWidth": None if width_declared is None else width_declared.value,
            "totalRise": None if (count is None or riser_declared is None) else count * riser_declared.value,
            "totalGoing": None,
            "flights": [],
            "landings": len(landings),
            "declaredLandings": len(landings),
            # Not zero: nothing was measured here, and a zero would read as „am
            # Körper ist kein Podest" about a body that was never read.
            "measuredLandings": None,
        }
        return declared(
            value,
            unit="m",
            from_=_sources(global_id, *[e for e in (count_on, riser_on, tread_on, width_on) if e]),
            method=method,
            caveat=" ".join(
                [
                    "Ausschließlich aus den deklarierten Eigenschaften gelesen — dieses Bauteil trägt in "
                    "der Datei keinen auswertbaren Körper. Die Werte sind also das, was jemand eingetragen "
                    "hat, und nicht das, was gebaut wird; ob die Steigungen tatsächlich gleich sind, lässt "
                    "sich daraus grundsätzlich nicht sagen.",
                    *refusals,
                ]
            ),
        )

    risers: list[float] = []
    goings: list[float] = []
    per_flight: list[dict[str, Any]] = []
    # How many flights came out of each body, so that a body split into three can
    # say WHICH of the three each row is. The GlobalId cannot say it — the three
    # flights of „Treppe-EG" are one IfcStair — and a reader looking at three rows
    # with the same id has to be able to tell them apart.
    per_body = {element.GlobalId: len(body.flights) for element, body in readings}
    seen: dict[str, int] = {}
    for element, flight in measured:
        risers.extend(flight.risers)
        goings.extend(flight.goings)
        index = seen[element.GlobalId] = seen.get(element.GlobalId, 0) + 1
        label = model.label(element)
        per_flight.append(
            {
                "globalId": element.GlobalId,
                "name": (
                    label
                    if per_body[element.GlobalId] <= 1
                    else f"{label or element.GlobalId} — Lauf {index} von {per_body[element.GlobalId]}"
                ),
                "risers": len(flight.risers),
                "riserHeight": _spread(flight.risers) if flight.risers else None,
                "treadDepth": _spread(flight.goings) if flight.goings else None,
                "clearWidth": flight.clear_width,
                "totalRise": flight.total_rise,
                "totalGoing": flight.total_going,
                "treadSurfaces": len(flight.treads),
                # A flight read out of a body that was not split into flights in
                # the file. The number is a measurement either way; where it came
                # from is not the same statement and the reader may need both.
                "fromBody": per_body[element.GlobalId] > 1 or not flights,
                "landingBelow": flight.landing_below,
                "landingAbove": flight.landing_above,
            }
        )

    riser_stats = _spread(risers) if risers else None
    tread_stats = _spread(goings) if goings else None
    clear_width = min(flight.clear_width for _, flight in measured)
    total_rise = float(sum(flight.total_rise for _, flight in measured))
    total_going = float(sum(flight.total_going for _, flight in measured))

    riser_block, riser_conflict = _reconcile(
        None if riser_stats is None else riser_stats["mean"],
        riser_declared,
        subject_id=global_id,
        declared_on=riser_on,
        method=method,
    )
    tread_block, tread_conflict = _reconcile(
        None if tread_stats is None else tread_stats["mean"],
        tread_declared,
        subject_id=global_id,
        declared_on=tread_on,
        method=method,
    )
    if riser_stats is not None:
        riser_block.update(riser_stats)
    if tread_stats is not None:
        tread_block.update(tread_stats)

    measured_count = len(risers)
    count_block: dict[str, Any] = {
        "value": count if count is not None else measured_count,
        "measured": measured_count,
        "declared": count,
        "declaredAs": None if count_on is None else "Pset_Stair(Flight)Common.NumberOfRiser",
        "agreement": None if count is None else ("agree" if count == measured_count else "disagree"),
    }

    value = {
        "riserCount": count_block["value"],
        "risers": count_block,
        "riserHeight": riser_block,
        "treadDepth": tread_block,
        "clearWidth": clear_width,
        "declaredWidth": None if width_declared is None else width_declared.value,
        "totalRise": total_rise,
        "totalGoing": total_going,
        "flights": per_flight,
        # Landings from BOTH routes, because a file states them in either. The
        # synthetic assembly declares its Podest as an IfcSlab/LANDING part; the
        # Institute's dogleg declares nothing at all and its two Podeste are only
        # in the solid, where `landings 0` used to be reported over them.
        "landings": len(landings) + measured_landings,
        "declaredLandings": len(landings),
        "measuredLandings": measured_landings,
    }

    caveats: list[str] = []
    if riser_stats is not None and riser_stats["count"] > 1:
        if riser_stats["spread"] > COORDINATE_TOLERANCE:
            caveats.append(
                f"Die Steigungen dieses Laufs sind nicht gleich hoch: {riser_stats['count']} gemessene "
                f"Steigungen streuen von {riser_stats['min']:.3f} m bis {riser_stats['max']:.3f} m, also um "
                f"{riser_stats['spread']:.3f} m. Ein Mittelwert allein verdeckt das."
            )
        else:
            caveats.append(
                f"{riser_stats['count']} gemessene Steigungen, Streuung {riser_stats['spread'] * 1000:.0f} mm — "
                "im Rahmen der Tessellierungsgenauigkeit gleich hoch."
            )
    if tread_stats is not None and tread_stats["count"] > 1 and tread_stats["spread"] > 2 * COORDINATE_TOLERANCE:
        # „Auch" only when the risers were the previous sentence's finding. On a
        # stair with equal risers and a 25 mm spread in the goings — the
        # Institute's dogleg, where the top tread is the floor slab's own face —
        # it made the answer read as if the risers had been unequal too.
        uneven_risers = riser_stats is not None and riser_stats["spread"] > COORDINATE_TOLERANCE
        caveats.append(
            f"{'Auch die' if uneven_risers else 'Die'} Auftritte sind ungleich "
            f"({tread_stats['min']:.3f} m bis {tread_stats['max']:.3f} m). "
            "Eine einzelne deutlich tiefere Stufe ist oft ein Podest, das im selben Körper steckt und hier "
            "als Stufe mitgemessen wird — "
            + (
                f"{value['landings']} Podest(e) sind an diesem Körper erkannt und aus den Auftritten "
                "herausgerechnet; ein weiteres, flacheres kann darin stecken."
                if measured_landings
                else "stepsOf() zeigt, ob die Datei ein eigenes Podest führt."
            )
        )
    if not all(flight.base_riser_used for _, flight in measured):
        caveats.append(
            "Die unterste Steigung ist nicht mitgemessen: die Unterseite dieses Körpers liegt nicht auf der "
            "Höhe des Antritts (eine Laufplatte mit Untersicht). Gezählt und gemessen sind nur die Steigungen "
            "zwischen zwei sichtbaren Trittflächen."
        )
    if len(per_flight) > 1:
        # Which flights, and where they came from. „landings 0" over a body with
        # two Podeste in it was the previous answer on the Institute's dogleg,
        # and a reader had no way to see that the three flights had been averaged
        # into one.
        from_body = sum(1 for f in per_flight if f["fromBody"])
        caveats.append(
            f"Gemessen sind {len(per_flight)} Läufe"
            + (
                f", davon {from_body} am Körper selbst erkannt (die Datei gliedert diesen Körper nicht in "
                "IfcStairFlight; die Läufe sind an den Richtungswechseln und an den Podesten getrennt)"
                if from_body
                else ""
            )
            + f". Die Steigungen sind über alle Läufe zusammengefasst; {value['landings']} Podest(e) sind "
            "erkannt und zählen nicht als Stufe."
        )
    if refusals:
        caveats.append(
            "Ein Teil dieses Körpers ist nicht mitgemessen: " + " ".join(refusals) + " Die ausgewiesenen "
            "Werte gelten nur für die Läufe, die gemessen werden konnten."
        )
    caveats.append(
        f"Nutzbreite {clear_width:.3f} m ist die schmalste gemessene Trittfläche, quer zur Laufrichtung "
        "dieses Laufs gemessen. Sie ist eine Rohbaulichte: Handläufe, Wandbekleidungen und Geländer "
        "schmälern sie und sind nur enthalten, soweit sie den Trittflächenkörper selbst begrenzen. Ist der "
        "Lauf samt Wangen als ein Körper exportiert, misst diese Zahl über die Wangen hinweg und ist dann "
        "zu groß."
    )
    for conflict in (riser_conflict, tread_conflict):
        if conflict:
            caveats.append(conflict)
    if count_block["agreement"] == "disagree":
        caveats.append(
            f"Die Datei deklariert {count} Steigungen, gemessen sind {measured_count}. Der deklarierte Wert "
            "steht im Ergebnis, weil eine Stufenzahl gezählt und nicht geschätzt wird — die Abweichung ist "
            "ein Befund über den Export (eine unterste oder oberste Stufe, die im Körper fehlt oder die zum "
            "Podest gehört)."
        )

    return computed(
        value,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=_sources(global_id, *[element.GlobalId for element, _ in measured]),
        method=method,
        caveat=" ".join(caveats),
    )


# ════════════════════════════════════════════════════════════════════════════
# ramp_slope
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class _Running:
    """A ramp flight's running surface: the dominant up-facing planar cluster."""

    global_id: str
    normal: np.ndarray
    rise: float
    run: float
    width: float
    #: Unit horizontal direction of the ascent, or ``None`` for a level surface.
    uphill: np.ndarray | None
    corners: np.ndarray


def _running_surface(model: SpatialModel, element: Any) -> _Running | None:
    """The ramp's walking surface, as a plane with an extent.

    Up-facing triangles are binned by quantised normal and the bin with the
    greatest AREA wins — the same rule, and the same reason, as
    ``geometry.dominant_vertical_plane``: a finely tessellated 0.2 m² kerb must
    not outvote a 7.5 m² running surface. The slope then comes from the winning
    bin's area-weighted normal rather than from a bounding box, which is what
    makes it right for a ramp that runs diagonally in plan.
    """
    geo = model.geometry(element.GlobalId)
    if geo is None:
        return None
    tris = _usable_triangles(geo)
    if len(tris) == 0:
        return None
    normals, areas = triangle_normals_areas(tris)
    facing = normals[:, 2] > RUNNING_SURFACE_MIN_DOT
    if not facing.any():
        return None
    tris, normals, areas = tris[facing], normals[facing], areas[facing]

    keys = np.round(normals / 0.02).astype(np.int64)
    best_area, best = -1.0, None
    for key in np.unique(keys, axis=0):
        member = (keys == key).all(axis=1)
        area = float(areas[member].sum())
        if area > best_area:
            best_area, best = area, member
    if best is None:
        return None

    surface = tris[best]
    weights = areas[best]
    normal = (normals[best] * weights[:, None]).sum(axis=0)
    normal = normal / float(np.linalg.norm(normal))
    vertices = surface.reshape(-1, 3)

    horizontal = float(math.hypot(normal[0], normal[1]))
    if horizontal < 1e-9:
        uphill = None
        run = float(max(vertices[:, 0].max() - vertices[:, 0].min(), vertices[:, 1].max() - vertices[:, 1].min()))
        width = float(min(vertices[:, 0].max() - vertices[:, 0].min(), vertices[:, 1].max() - vertices[:, 1].min()))
    else:
        # Steepest ascent is the negated horizontal part of the up-normal.
        uphill = np.array([-normal[0] / horizontal, -normal[1] / horizontal, 0.0])
        across = np.array([-uphill[1], uphill[0], 0.0])
        along_extent = vertices @ uphill
        across_extent = vertices @ across
        run = float(along_extent.max() - along_extent.min())
        width = float(across_extent.max() - across_extent.min())
    rise = float(vertices[:, 2].max() - vertices[:, 2].min())

    return _Running(
        global_id=element.GlobalId,
        normal=normal,
        rise=rise,
        run=run,
        width=width,
        uphill=uphill,
        corners=vertices,
    )


def _slope_forms(tangent: float) -> dict[str, Any]:
    """One slope, in every form a clause or a drawing might use it.

    A bare "6" is ambiguous between 6 %, 1:6 and 6°, and the three differ by a
    factor of ten. All of them are therefore present at once, and ``slopePercent``
    is defined in the value itself as ``rise / run × 100`` so that no reader has
    to assume which convention this package chose.
    """
    percent = tangent * 100.0
    ratio = (1.0 / tangent) if tangent > 1e-9 else None
    return {
        "slopePercent": percent,
        "slopeRatio": ratio,
        "slopeRatioText": "0" if ratio is None else f"1:{ratio:.1f}",
        "slopeDegrees": math.degrees(math.atan(tangent)),
    }


def ramp_slope(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """A ramp's slope, as a percentage AND as a ratio, with the rise and run.

    Barrier-free ramps are decided on a percentage, drawn as a ratio and
    dimensioned in degrees by nobody, so all three forms are returned together
    and the percentage is defined in the answer itself: **rise / run × 100**.
    6 % is 6 cm of rise per 100 cm of plan length, which is 1:16,7. A caller that
    receives only "6" cannot tell that from 1:6, and the difference is a factor of
    ten on the one number the whole clause turns on.

    The slope comes from the area-weighted normal of the running surface, not
    from a bounding box: a ramp that runs diagonally in plan has a box whose
    diagonal is longer than its run, and the box route would report it as
    flatter than it is. ``rise`` and ``run`` are the extents of that same
    surface, so ``rise / run`` reproduces the reported percentage and a reader
    can check it.

    An ``IfcRamp`` that aggregates flights reports the **steepest** flight as the
    value, with every flight in ``flights``. That is a choice about which number
    answers the question "how steep is this ramp", not a verdict: nothing here
    knows what steep enough is.

    ``Pset_RampFlightCommon.Slope`` is triangulated in where it exists. It is an
    ``IfcPlaneAngleMeasure``, so it is read through the file's plane-angle unit
    and converted — a file that states 3.4336 DEGREE means 6.0 %, and a file that
    states the same number in radians means 24 000 %. Reading it as a raw number
    is how that mistake gets made.
    """
    method = f"rampSlope({global_id})"
    subject = _require(model, global_id, method)
    if not any(subject.is_a(name) for name in RAMP_TYPES):
        _wrong_kind(
            subject,
            method,
            "rampSlope",
            "eine Rampe oder einen Rampenlauf (IfcRamp, IfcRampFlight)",
            "für eine Treppe: stairGeometry(); für die lichte Höhe über einem Lauf: headroom()",
        )

    flights, _, _ = _flight_parts(subject)
    bodies = flights if flights else [subject]
    surfaces = [(element, _running_surface(model, element)) for element in bodies]
    measured = [(element, surface) for element, surface in surfaces if surface is not None]

    declared_slope = None
    declared_on = None
    for element in [subject, *flights]:
        found = model.declared_quantity(element, _RAMP_SLOPE_NAMES)
        if found is not None:
            declared_slope, declared_on = found, element.GlobalId
            break

    if not measured:
        if declared_slope is None:
            geo, missing = _geometry_or_answer(model, subject, method)
            if geo is None:
                return missing  # type: ignore[return-value]
            return undecidable(
                from_=[global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what=f"keine auswertbare Lauffläche an {subject.is_a()} „{model.label(subject) or global_id}“",
                    remedy=(
                        "Der Körper dieses Bauteils zeigt keine nach oben gerichtete Fläche, aus der sich ein "
                        "Gefälle ablesen ließe. Abhilfe: die Rampe mit voller Körpergeometrie exportieren oder "
                        "das Gefälle in Pset_RampFlightCommon.Slope deklarieren."
                    ),
                    elements=[global_id],
                ),
            )
        # A declared plane angle, converted to SI radians by `declared_quantity`.
        forms = _slope_forms(math.tan(declared_slope.value))
        return declared(
            {**forms, "rise": None, "run": None, "clearWidth": None, "flights": []},
            unit="%",
            from_=[global_id, declared_on or global_id],
            method=method,
            caveat=(
                f"Nur deklariert ({declared_slope.path} = {declared_slope.raw:g}"
                f"{' ' + declared_slope.unit_label if declared_slope.unit_label else ''}, "
                f"also {math.degrees(declared_slope.value):.4f}°) — dieses Bauteil trägt keinen auswertbaren "
                "Körper, an dem sich das Gefälle nachmessen ließe. Steigung in Prozent heißt hier "
                "Höhenunterschied / Grundrisslänge × 100."
            ),
        )

    per_flight = []
    for element, surface in measured:
        tangent = float(math.hypot(surface.normal[0], surface.normal[1]) / surface.normal[2])
        per_flight.append(
            {
                "globalId": element.GlobalId,
                "name": model.label(element),
                **_slope_forms(tangent),
                "rise": surface.rise,
                "run": surface.run,
                "clearWidth": surface.width,
            }
        )
    steepest = max(per_flight, key=lambda f: f["slopePercent"])

    block, conflict = _reconcile(
        steepest["slopePercent"],
        None
        if declared_slope is None
        else DeclaredQuantity(
            path=declared_slope.path,
            value=math.tan(declared_slope.value) * 100.0,
            raw=declared_slope.raw,
            scale=declared_slope.scale,
            unit_label=declared_slope.unit_label,
        ),
        subject_id=global_id,
        declared_on=declared_on,
        method=method,
    )

    value = {
        "slopePercent": steepest["slopePercent"],
        "slopeRatio": steepest["slopeRatio"],
        "slopeRatioText": steepest["slopeRatioText"],
        "slopeDegrees": steepest["slopeDegrees"],
        "rise": steepest["rise"],
        "run": steepest["run"],
        "clearWidth": steepest["clearWidth"],
        "declaredSlopePercent": block["declared"],
        "agreement": block["agreement"],
        "flights": per_flight,
        "definition": "slopePercent = Höhenunterschied / Grundrisslänge × 100",
    }

    caveats = [
        f"Steigung {steepest['slopePercent']:.2f} % heißt {steepest['slopePercent']:.2f} cm Höhe je 100 cm "
        f"Grundrisslänge, als Verhältnis {steepest['slopeRatioText']}, als Winkel "
        f"{steepest['slopeDegrees']:.2f}°. Gemessen an der Neigung der Lauffläche selbst; Höhenunterschied "
        f"{steepest['rise']:.3f} m auf {steepest['run']:.3f} m Grundrisslänge bestätigen sie."
    ]
    if len(per_flight) > 1:
        caveats.append(
            f"Diese Rampe hat {len(per_flight)} Läufe; ausgewiesen ist der steilste. Die übrigen stehen in "
            "flights, dazwischenliegende Podeste zählen nicht mit."
        )
    if steepest["slopePercent"] < 0.1:
        caveats.append(
            "Die Lauffläche ist waagrecht — das ist ein Podest, kein geneigter Lauf, oder die Rampe ist ohne "
            "Gefälle modelliert."
        )
    caveats.append(
        "Die Nutzbreite ist die Breite der Lauffläche im Rohbau; Radabweiser, Handläufe und Bekleidungen "
        "schmälern sie und sind nur enthalten, soweit sie den Körper der Lauffläche begrenzen."
    )
    if conflict:
        caveats.append(conflict)

    return computed(
        value,
        unit="%",
        tolerance=0.1,
        from_=_sources(global_id, *[element.GlobalId for element, _ in measured]),
        method=method,
        caveat=" ".join(caveats),
    )


# ════════════════════════════════════════════════════════════════════════════
# headroom
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class _Rake:
    """The walking plane of one flight, as a rectangle with a normal."""

    global_id: str
    #: Four corners: bottom-left, bottom-right, top-right, top-left.
    corners: np.ndarray
    #: Unit normal, pointing up out of the walking surface.
    normal: np.ndarray
    #: Unit direction up the pitch.
    pitch: np.ndarray
    length: float
    width: float


def _rakes_of(model: SpatialModel, element: Any) -> tuple[list[_Rake], list[str]]:
    """The raking planes a Durchgangshöhe is measured from, and what was refused.

    For a stair that is the plane through the NOSINGS — not the treads, not the
    soffit. The nosing line is what a person's head clears; a plane through the
    back of each tread sits half a going behind it and would report a headroom
    that is too large by ``going × sin(pitch)``, about 15 cm on an ordinary
    flight.

    A LIST because one body can hold more than one flight: a dogleg written as a
    single ``IfcStair`` has three pitch lines pointing three ways, and one plane
    fitted across all of them is a plane through the stairwell rather than over
    a walking surface. Each flight gets its own rake and the tightest one wins.

    For a ramp it is the running surface itself.
    """
    if element.is_a("IfcRampFlight") or element.is_a("IfcRamp"):
        rake = _ramp_rake(model, element)
        return ([rake] if rake is not None else []), []

    body = _read_body(model, element)
    rakes = [rake for flight in body.flights if (rake := _flight_rake(element, flight)) is not None]
    return rakes, body.refusals


def _ramp_rake(model: SpatialModel, element: Any) -> _Rake | None:
    """The running surface of a ramp, as the rectangle a head clears."""
    surface = _running_surface(model, element)
    if surface is None:
        return None
    pitch = surface.uphill if surface.uphill is not None else np.array([1.0, 0.0, 0.0])
    if surface.uphill is not None:
        tangent = float(math.hypot(surface.normal[0], surface.normal[1]) / surface.normal[2])
        pitch = surface.uphill * math.cos(math.atan(tangent)) + np.array([0.0, 0.0, 1.0]) * math.sin(math.atan(tangent))
    across = np.array([-pitch[1], pitch[0], 0.0])
    across = across / float(np.linalg.norm(across))
    vertices = surface.corners
    along = vertices @ pitch
    side = vertices @ across
    low, high = float(along.min()), float(along.max())
    left, right = float(side.min()), float(side.max())
    height = float((vertices @ surface.normal).mean())
    corners = np.array(
        [
            pitch * low + across * left + surface.normal * height,
            pitch * low + across * right + surface.normal * height,
            pitch * high + across * right + surface.normal * height,
            pitch * high + across * left + surface.normal * height,
        ]
    )
    return _Rake(
        global_id=element.GlobalId,
        corners=corners,
        normal=surface.normal,
        pitch=pitch,
        length=high - low,
        width=right - left,
    )


def _flight_rake(element: Any, flight: _Flight) -> _Rake | None:
    """One flight's nosing plane, as the rectangle a head clears."""
    if len(flight.nosings) < 2:
        return None
    first, last = flight.nosings[0], flight.nosings[-1]
    pitch = last - first
    length = float(np.linalg.norm(pitch))
    if length < 1e-9:
        return None
    pitch = pitch / length
    across = flight.across
    normal = np.cross(across, pitch)
    normal = normal / float(np.linalg.norm(normal))
    if normal[2] < 0:
        normal = -normal
    half = flight.clear_width / 2.0
    centre_offset = float(np.mean([t.centre @ across for t in flight.treads]))
    base_first = first - across * float(first @ across) + across * centre_offset
    base_last = last - across * float(last @ across) + across * centre_offset
    corners = np.array(
        [base_first - across * half, base_first + across * half, base_last + across * half, base_last - across * half]
    )
    return _Rake(
        global_id=element.GlobalId,
        corners=corners,
        normal=normal,
        pitch=pitch,
        length=length,
        width=flight.clear_width,
    )


def _rake_samples(rake: _Rake) -> np.ndarray:
    """Sample points on the walking plane — for the RAY pass only.

    These find which elements are overhead. They do not decide the number: the
    distance is measured against the surfaces of whatever they find, so a tight
    point between two samples changes nothing as long as the element it belongs
    to was hit at all.
    """
    steps = max(2, int(math.ceil(rake.length / HEADROOM_SAMPLE_SPACING)) + 1)
    bottom_left, bottom_right, top_left = rake.corners[0], rake.corners[1], rake.corners[3]
    along = np.linspace(0.0, 1.0, steps)
    points = []
    for t in along:
        base = bottom_left + (top_left - bottom_left) * t
        side = bottom_right - bottom_left
        for fraction in HEADROOM_LATERAL:
            points.append(base + side * fraction)
    return np.array(points)


def _overhead_hits(
    model: SpatialModel, points: np.ndarray, direction: np.ndarray, exclude: set[str]
) -> tuple[float | None, dict[str, float]]:
    """Cast one ray per sample point and report the shortest run and who stopped it.

    The exclusion discipline is :func:`~ifc_spatial.operators.clear_height`'s,
    reused rather than re-derived: :data:`~ifc_spatial.model.AIR_TYPES` never
    stops a ray (a space is air and an opening is a subtraction), and every entry
    of :data:`HEADROOM_TRANSPARENT` is tested with ``is_a`` because
    ``IfcFurniture`` is only a SUBTYPE of ``IfcFurnishingElement`` in IFC4 — in
    IFC2X3 it is not, and a chair once stopped a clear-height ray for that reason.

    ``IfcRailing`` is NOT in that list, and :data:`HEADROOM_TRANSPARENT` records
    the measurement that decided it: the balustrades this pass used to report
    were reached by the old single-plane rake across a whole dogleg, not by the
    filter, and with the flights read one at a time no railing is a candidate at
    all.
    """
    shortest: float | None = None
    hit_by: dict[str, float] = {}
    ray = (float(direction[0]), float(direction[1]), float(direction[2]))
    for point in points:
        origin = point + direction * MIN_INTRUSION
        # The NEAREST accepted hit on each ray, not the first one the tree hands
        # back. `clear_height` breaks on the first and gets away with it; nothing
        # in `select_ray`'s contract promises an ordering, and the whole point of
        # this pass is which element stops a head first.
        nearest: tuple[float, str] | None = None
        for hit in model.tree.select_ray(
            (float(origin[0]), float(origin[1]), float(origin[2])), ray, length=HEADROOM_REACH
        ):
            element = model.file.by_id(hit.instance.id())
            if element.is_a() in AIR_TYPES or any(element.is_a(name) for name in HEADROOM_TRANSPARENT):
                continue
            if element.GlobalId in exclude:
                continue
            run = float(hit.distance) + MIN_INTRUSION
            if run <= MIN_INTRUSION:
                continue
            if nearest is None or run < nearest[0]:
                nearest = (run, element.GlobalId)
        if nearest is None:
            continue
        run, global_id = nearest
        shortest = run if shortest is None else min(shortest, run)
        hit_by[global_id] = min(hit_by.get(global_id, run), run)
    return shortest, hit_by


def _exact_clearance(model: SpatialModel, rake: _Rake, candidates: dict[str, float]) -> tuple[float | None, str | None]:
    """Exact perpendicular distance from the walking plane to the found elements.

    This is where the operator stops being a sampling method. The shortest
    distance from a plane region to a body above it IS the perpendicular
    distance, so measuring surface to surface — with
    :func:`~ifc_spatial.clearance._soup_distance`, the same exact triangle-pair
    routine ``clear_width`` uses — gives the Durchgangshöhe without needing a
    sample to land on the critical point. The critical point on a stair is the
    EDGE of the slab above, and no ray hits an edge.

    Only triangles wholly above the walking plane count. An element that crosses
    it — the stringer wall beside the flight — would otherwise measure zero from
    its own part below the nosings, which is a distance to something a head never
    meets.
    """
    plane_point = rake.corners.mean(axis=0)
    rectangle = np.array([rake.corners[[0, 1, 2]], rake.corners[[0, 2, 3]]])
    best: float | None = None
    culprit: str | None = None
    for global_id in candidates:
        geo = model.geometry(global_id)
        if geo is None:
            continue
        tris = _usable_triangles(geo)
        if len(tris) == 0:
            continue
        above = (((tris - plane_point) @ rake.normal) > MIN_INTRUSION).all(axis=1)
        if not above.any():
            continue
        distance, _, _, _, aborted = _soup_distance(rectangle, tris[above], CLEARANCE_BUDGET_SECONDS)
        if aborted or not math.isfinite(distance):
            continue
        if best is None or distance < best:
            best, culprit = float(distance), global_id
    return best, culprit


def headroom(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The Durchgangshöhe over a stair flight or a ramp, measured perpendicular.

    The measurement people get wrong. The tight point on a stair is where the
    flight passes under the floor above, and a vertical ray from a tread misses
    it: the shortest line from the walking surface to that slab edge runs
    perpendicular to the pitch, and it is shorter than any vertical distance
    under it. On the test fixture — a 33.69° flight (0.180/0.270) passing an edge
    at x = 1.200 m with a soffit at 2.600 m — no vertical measurement over the
    pitch line can get below 1.620 m, and the true clear passage is **1.348 m**.
    Reporting the vertical number hands the architect 27 cm of headroom that does
    not exist.

    So the value is the minimum distance from the **raking plane** — the plane
    through the nosings, over the flight's width — to any body above it. That is
    the perpendicular distance by construction. Rays along the plane's normal
    find the candidates; the reported number is then measured exactly against
    their surfaces, so it does not depend on a sample landing on the critical
    point.

    ``vertical`` travels beside it, because a clause that means the vertical
    reading must be able to have it without a second call, and because the gap
    between the two is itself worth showing.

    A flight with nothing above it is decidable and says so: ``obstructed`` is
    false and ``searchedTo`` names how far up the search went. That is a
    statement about this file — most often that the storey above was not
    exported — and it must never be confused with a measurement of zero.
    """
    method = f"headroom({global_id})"
    subject = _require(model, global_id, method)
    if not any(subject.is_a(name) for name in (*STAIR_TYPES, *RAMP_TYPES)):
        _wrong_kind(
            subject,
            method,
            "headroom",
            "einen Treppen- oder Rampenlauf (IfcStair, IfcStairFlight, IfcRamp, IfcRampFlight)",
            "für die lichte Höhe eines Raums: clearHeight(); für einen Durchgang: clearOpeningWidth()",
        )

    flights, _, _ = _flight_parts(subject)
    bodies = flights if flights else [subject]
    readings = [(element, *_rakes_of(model, element)) for element in bodies]
    usable = [(element, rake) for element, rakes, _ in readings for rake in rakes]
    refusals = [reason for _, _, reasons in readings for reason in reasons]
    if not usable:
        geo, missing = _geometry_or_answer(model, subject, method)
        if geo is None:
            return missing  # type: ignore[return-value]
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine gerade Lauflinie an {subject.is_a()} „{model.label(subject) or global_id}“",
                remedy=" ".join(
                    [
                        *refusals,
                        "Eine Durchgangshöhe wird senkrecht über der Lauflinie gemessen, und die ergibt sich "
                        "aus den Trittflächen bzw. der Lauffläche. Dieser Körper zeigt keine auswertbare — "
                        "die Treppe bzw. Rampe mit voller Körpergeometrie und je einem IfcStairFlight pro "
                        "Lauf neu exportieren.",
                    ]
                ),
                elements=[global_id],
            ),
        )

    # The subject only. The flight being measured excludes ITSELF below, because
    # a body cannot stop a ray leaving its own surface; its SIBLINGS must stay
    # candidates, because the other flight of the same stair is the commonest
    # ceiling a staircase has. This set used to hold every body in `rakes`, which
    # made the exclusion identical for all flights and blinded each one to the
    # rest of its own assembly — on the two-flight „Treppe Turm" of
    # tests/test_stairs.py, whose Lauf OG stands 1.280 m over the top nosing of
    # Lauf UG, `headroom` on the assembly reported „kein Bauteil … begrenzt
    # nichts die Durchgangshöhe" while the same question asked about Lauf UG
    # alone answered 1.280 m. „Nichts darüber" is read as a gap in the export;
    # here it was a stair, and the direction of the error is the dangerous one.
    #
    # The exclusion is still per BODY and not per flight, and it has to be: the
    # ray tree knows elements, not the runs this module reads out of one. So on a
    # dogleg written as a single IfcStair, the upper flight cannot limit the lower
    # one — the caveat says as much where it applies. Where the export gives each
    # flight its own IfcStairFlight, the sibling case above still works.
    excluded_self = {global_id}

    per_body = {element.GlobalId: len(rakes) for element, rakes, _ in readings}
    seen: dict[str, int] = {}
    per_flight: list[dict[str, Any]] = []
    for element, rake in usable:
        samples = _rake_samples(rake)
        exclude = {*excluded_self, element.GlobalId}
        sampled, candidates = _overhead_hits(model, samples, rake.normal, exclude)
        vertical, _ = _overhead_hits(model, samples, np.array([0.0, 0.0, 1.0]), exclude)
        exact, culprit = _exact_clearance(model, rake, candidates)
        index = seen[element.GlobalId] = seen.get(element.GlobalId, 0) + 1
        label = model.label(element)
        per_flight.append(
            {
                "globalId": element.GlobalId,
                "name": (
                    label
                    if per_body[element.GlobalId] <= 1
                    else f"{label or element.GlobalId} — Lauf {index} von {per_body[element.GlobalId]}"
                ),
                "headroom": exact if exact is not None else sampled,
                "sampledPerpendicular": sampled,
                "vertical": vertical,
                "obstructedBy": culprit or (min(candidates, key=candidates.get) if candidates else None),
                "samples": int(len(samples)),
            }
        )

    obstructed = [f for f in per_flight if f["headroom"] is not None]
    if not obstructed:
        return computed(
            {
                "headroom": None,
                "vertical": None,
                "obstructed": False,
                "searchedTo": HEADROOM_REACH,
                "flights": per_flight,
            },
            unit="m",
            tolerance=DIMENSION_TOLERANCE,
            from_=[global_id],
            method=method,
            caveat=(
                f"Über diesem Lauf liegt innerhalb von {HEADROOM_REACH:.1f} m kein Bauteil — in dieser Datei "
                "begrenzt nichts die Durchgangshöhe. Das ist eine Aussage über den Export und nicht über das "
                "Gebäude: meist fehlt das Geschoss darüber, seltener steht die Treppe tatsächlich im Freien. "
                "Möblierung (IfcFurnishingElement) und Luftkörper (IfcSpace, IfcOpeningElement) halten hier "
                "grundsätzlich nichts auf."
            ),
        )

    tightest = min(obstructed, key=lambda f: f["headroom"])
    culprit = tightest["obstructedBy"]
    culprit_name = None
    if culprit:
        try:
            culprit_name = model.label(model.file.by_guid(culprit)) or culprit
        except (RuntimeError, KeyError):
            culprit_name = culprit

    value = {
        "headroom": tightest["headroom"],
        "vertical": tightest["vertical"],
        "obstructed": True,
        "obstructedBy": culprit,
        "searchedTo": HEADROOM_REACH,
        "flights": per_flight,
    }

    caveats = [
        "Lichte Durchgangshöhe, senkrecht zur Lauflinie gemessen — nicht lotrecht. Die enge Stelle einer "
        "Treppe ist die Kante der Decke darüber, und ein senkrecht nach oben gemessener Wert geht daran "
        "vorbei."
    ]
    if tightest["vertical"] is not None and tightest["headroom"] is not None:
        difference = tightest["vertical"] - tightest["headroom"]
        if difference > DIMENSION_TOLERANCE:
            caveats.append(
                f"Lotrecht gemessen wären es {tightest['vertical']:.3f} m, also {difference:.3f} m mehr als "
                f"die tatsächlich durchgehende Höhe von {tightest['headroom']:.3f} m."
            )
    if culprit_name:
        caveats.append(f"Die engste Stelle liegt unter: {culprit_name}.")
    if len(per_flight) > 1:
        # The second sentence describes a limitation of reading SEVERAL flights
        # out of ONE body: the ray tree keys on elements, so a flight cannot
        # stop a ray cast from its neighbour when both came from the same solid.
        # It is false for an export that writes an `IfcStairFlight` per flight —
        # there the exclusion is per element and a sibling flight DOES limit the
        # one beneath it, which `test_the_flight_above_belongs_to_the_same_stair
        # _and_still_counts` pins at 1.280 m. Printing it anyway would tell a
        # reader their file lacks something it has.
        split_body = any(count > 1 for count in per_body.values())
        caveats.append(
            f"Gemessen über {len(per_flight)} Läufen; ausgewiesen ist der engste."
            + (
                " Läuft ein Lauf über einen anderen desselben Körpers hinweg, kann er ihn hier nicht "
                "begrenzen — die Datei müsste dafür je Lauf ein eigenes IfcStairFlight führen."
                if split_body
                else ""
            )
        )
    if refusals:
        caveats.append("Ein Teil dieses Körpers ist nicht mitgemessen: " + " ".join(refusals))
    caveats.append(
        "Gemessen von der Ebene durch die Stufenvorderkanten (bei einer Rampe: von der Lauffläche) bis zur "
        "Oberfläche des nächstliegenden Bauteils darüber, über der mittleren Hälfte der Laufbreite. "
        "Möblierung ist ausgenommen; Unterzüge, abgehängte Decken, Leitungen und auch ein Geländer, das "
        "tatsächlich über der Lauflinie steht, zählen mit, soweit sie als Körper im Modell stehen."
    )

    return computed(
        value,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=_sources(global_id, *[f["globalId"] for f in per_flight], *([culprit] if culprit else [])),
        method=method,
        caveat=" ".join(caveats),
    )


# ════════════════════════════════════════════════════════════════════════════
# steps_of
# ════════════════════════════════════════════════════════════════════════════


def steps_of(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The flights and landings a stair (or ramp) is made of — ``IfcRelAggregates``.

    Two reasons this is its own operator rather than a detail of
    :func:`stair_geometry`:

    1. **A caller must be able to ask about ONE flight.** A stair is an assembly
       and its parts carry their own psets and their own bodies; every operator
       in this module takes a flight as readily as a stair, and this is how a
       flight's GlobalId is found.
    2. **Landings are half of what OIB 4 asks.** The rule that limits risers per
       flight is a rule about flights *without an intervening landing*, so a
       count of risers on a stair means nothing until the landings are known. A
       landing is an ``IfcSlab`` with ``PredefinedType = LANDING`` — by that
       statement and not by its name, because the name is „Podest" in one export
       and „Slab:Generic 200mm:314159" in the next.

    A stair with no parts is an ``undecidable`` and not an empty list. Revit and
    ArchiCAD both write staircases as a single ``IfcStair`` with one body and no
    ``IfcRelAggregates`` at all, and ``{"flights": [], "landings": []}`` with
    ``decidable=True`` says „diese Treppe hat keine Läufe und keine Podeste" —
    a statement about the building, and one that is false for every building ever
    built. The Institute's „Treppe-EG" answered exactly that while carrying three
    flights and two Podeste in its solid, and a caller reading
    ``value["landings"] == []`` had no way to know. The caveat that used to sit
    beside the empty lists already said the statement could not be made; it is
    now where it belongs, in ``missing.what`` and ``missing.remedy``.
    """
    method = f"stepsOf({global_id})"
    subject = _require(model, global_id, method)
    if not (subject.is_a("IfcStair") or subject.is_a("IfcRamp")):
        parent = None
        for rel in getattr(subject, "Decomposes", []) or []:
            parent = rel.RelatingObject
            break
        suggestion = (
            f"dieser Lauf gehört zur Baugruppe {parent.GlobalId} — stepsOf({parent.GlobalId}) liefert deren "
            "Läufe und Podeste"
            if parent is not None and getattr(parent, "GlobalId", None)
            else "für einen einzelnen Lauf: stairGeometry() bzw. rampSlope() misst ihn direkt"
        )
        _wrong_kind(
            subject,
            method,
            "stepsOf",
            "eine Treppe oder eine Rampe als Baugruppe (IfcStair, IfcRamp)",
            suggestion,
        )

    flights, landings, other = _flight_parts(subject)
    risers_per_flight: dict[str, int | None] = {}
    for flight in flights:
        count = model.declared_property(flight, _RISER_COUNT_NAMES)
        risers_per_flight[flight.GlobalId] = (
            int(count) if isinstance(count, (int, float)) and not isinstance(count, bool) else None
        )

    value = {
        "flights": model.refs(flights),
        "landings": model.refs(landings),
        "other": model.refs(other),
        "risersPerFlight": risers_per_flight,
    }

    if not flights:
        # The empty list is not an answer, and this operator used to return one
        # with `decidable=True` beside a caveat that said the statement could not
        # be made. A caller reading `value["landings"] == []` concluded that the
        # stair has no Podest; the Institute's „Treppe-EG" has two, and its parts
        # list is empty only because ArchiCAD wrote no IfcRelAggregates at all.
        # An empty list that would be false for every building ever built is an
        # `undecidable` — the rule `relations.connects` states in its own module
        # docstring, applied here to the same shape of absence.
        return undecidable(
            from_=[global_id],
            method=method,
            missing=MissingFact(
                what=(
                    f"{subject.is_a()} „{model.label(subject) or global_id}“ ist in der Datei nicht in Läufe "
                    "gegliedert: keine IfcRelAggregates-Beziehung auf IfcStairFlight/IfcRampFlight"
                ),
                remedy=(
                    "Das heißt NICHT, dass diese Treppe aus einem einzigen Lauf besteht — mehrere Exporte "
                    "(Revit und ArchiCAD an erster Stelle) schreiben die ganze Treppe als einen Körper. Eine "
                    "Aussage „so viele Steigungen je Lauf ohne Podest“ ist an dieser Datei deshalb nicht zu "
                    "treffen. stairGeometry() misst den Körper und weist die darin erkannten Läufe und "
                    "Podeste aus; als Bauteilbezug bleibt dann aber nur die Treppe selbst. Abhilfe: im CAD "
                    "die Treppe als Treppenbauteil mit einzelnen Läufen (IfcStairFlight) und Podesten "
                    "(IfcSlab mit PredefinedType = LANDING) exportieren."
                ),
                elements=[global_id],
            ),
        )

    undeclared = [gid for gid, count in risers_per_flight.items() if count is None]
    caveat = (
        f"{len(flights)} Läufe und {len(landings)} Podeste, aus IfcRelAggregates gelesen. Podeste sind "
        "über IfcSlab.PredefinedType = LANDING erkannt; ein Podest, das der Export als gewöhnliche Decke "
        "schreibt, steht in other und fehlt in dieser Zählung."
    )
    if undeclared:
        caveat += (
            f" Für {len(undeclared)} der Läufe deklariert die Datei keine Steigungszahl "
            "(Pset_StairFlightCommon.NumberOfRiser) — stairGeometry() zählt sie am Körper nach."
        )

    return declared(
        value,
        from_=_sources(global_id, *[part.GlobalId for part in (*flights, *landings, *other)]),
        method=method,
        caveat=caveat,
    )


__all__ = [
    "BURIED_CLEARANCE",
    "BURIED_OVERLAP_FRACTION",
    "FLIGHT_STRAIGHTNESS",
    "FLIGHT_TURN_DEGREES",
    "HEADROOM_LATERAL",
    "HEADROOM_REACH",
    "HEADROOM_SAMPLE_SPACING",
    "HEADROOM_TRANSPARENT",
    "LANDING_AREA_FACTOR",
    "PLAUSIBLE_RISER",
    "RAMP_TYPES",
    "STAIR_TYPES",
    "TREAD_FLATNESS",
    "TREAD_NORMAL_DOT",
    "headroom",
    "ramp_slope",
    "stair_geometry",
    "steps_of",
]
