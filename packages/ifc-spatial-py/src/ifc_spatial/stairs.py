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
chair is not a Durchgangshöhe.

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
    """Everything one flight's solid says about its steps."""

    global_id: str
    treads: list[_Tread]
    #: Riser heights, bottom to top. See :data:`BASE_RISER_RELATIVE_SLACK` for
    #: when the first one is in here and when it cannot be.
    risers: list[float]
    #: Whether the bottom riser (body base → first tread) is among them.
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


def _read_flight(model: SpatialModel, element: Any) -> _Flight | None:
    """One flight's body → its risers, goings, width and nosing line.

    ``None`` when the body carries no usable tread surfaces at all: a flight
    exported as a bounding box, or a curved flight whose "treads" are a single
    swept face. That is a fact about the export and the callers turn it into an
    undecidable that says so.
    """
    geo = model.geometry(element.GlobalId)
    if geo is None:
        return None
    clusters = _tread_surfaces(geo)
    if not clusters:
        return None

    if len(clusters) >= 2:
        travel = clusters[-1][2][:2] - clusters[0][2][:2]
    else:
        # A single step: no two centres to take a direction from, so the body's
        # longer plan axis is used. It is only needed for the width and the
        # nosing here, and a one-step flight has no going to get wrong.
        low, high = geo.box
        wider_in_x = (high[0] - low[0]) >= (high[1] - low[1])
        travel = np.array([high[0] - low[0], 0.0]) if wider_in_x else np.array([0.0, high[1] - low[1]])
    length = float(np.linalg.norm(travel))
    if length < 1e-9:
        # Every tread centre over the same point in plan — a spiral stair whose
        # flight closes on itself. Direction-based measurements are meaningless
        # here and pretending otherwise is how a Wendeltreppe gets reported with
        # a 0.00 m Auftritt.
        return None
    along = np.array([travel[0] / length, travel[1] / length, 0.0])
    across = np.array([-along[1], along[0], 0.0])

    treads: list[_Tread] = []
    for z, area, centre, vertices in clusters:
        a = vertices @ along
        b = vertices @ across
        treads.append(
            _Tread(z=z, area=area, centre=centre, span=(float(a.min()), float(a.max()), float(b.min()), float(b.max())))
        )

    levels = [t.z for t in treads]
    steps = [levels[i + 1] - levels[i] for i in range(len(levels) - 1)]
    base = float(geo.box[0][2])
    bottom = levels[0] - base
    if steps:
        median = float(np.median(steps))
        base_riser_used = abs(bottom - median) <= BASE_RISER_RELATIVE_SLACK * median
    else:
        # Nothing to compare against. The body's underside is the only candidate
        # for a floor line, and the caveat says the measurement rests on it.
        base_riser_used = bottom > MIN_INTRUSION
    risers = ([bottom] if base_riser_used else []) + steps

    goings = [float(np.linalg.norm(treads[i + 1].centre[:2] - treads[i].centre[:2])) for i in range(len(treads) - 1)]
    widths = [t.span[3] - t.span[2] for t in treads]
    # The nosing is the FRONT edge of the tread — its minimum along the travel
    # direction — held at the tread's own lateral centre.
    nosings = np.array(
        [[*(t.centre[:2] + along[:2] * (t.span[0] - float(t.centre[:2] @ along[:2]))), t.z] for t in treads]
    )

    return _Flight(
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
    )


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

    readings = [(element, _read_flight(model, element)) for element in bodies]
    measured = [(element, flight) for element, flight in readings if flight is not None]

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
            return undecidable(
                from_=[global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what=(
                        f"keine waagrechten Trittflächen am Körper von {subject.is_a()} "
                        f"„{model.label(subject) or global_id}“"
                    ),
                    remedy=(
                        "Der Körper dieses Bauteils zeigt keine auswertbaren Stufen — er ist als Hüllquader, "
                        "als reine Fläche oder als eine einzige geschwungene Rampe exportiert. Abhilfe: die "
                        "Treppe im CAD als Treppenbauteil (IfcStair mit IfcStairFlight) mit voller "
                        "Körpergeometrie exportieren, oder Steigungshöhe und Auftritt in "
                        "Pset_StairCommon.RiserHeight / .TreadLength deklarieren."
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
        }
        return declared(
            value,
            unit="m",
            from_=_sources(global_id, *[e for e in (count_on, riser_on, tread_on, width_on) if e]),
            method=method,
            caveat=(
                "Ausschließlich aus den deklarierten Eigenschaften gelesen — dieses Bauteil trägt in der "
                "Datei keinen auswertbaren Körper. Die Werte sind also das, was jemand eingetragen hat, und "
                "nicht das, was gebaut wird; ob die Steigungen tatsächlich gleich sind, lässt sich daraus "
                "grundsätzlich nicht sagen."
            ),
        )

    risers: list[float] = []
    goings: list[float] = []
    per_flight: list[dict[str, Any]] = []
    for element, flight in measured:
        risers.extend(flight.risers)
        goings.extend(flight.goings)
        per_flight.append(
            {
                "globalId": element.GlobalId,
                "name": model.label(element),
                "risers": len(flight.risers),
                "riserHeight": _spread(flight.risers) if flight.risers else None,
                "treadDepth": _spread(flight.goings) if flight.goings else None,
                "clearWidth": flight.clear_width,
                "totalRise": flight.total_rise,
                "totalGoing": flight.total_going,
                "treadSurfaces": len(flight.treads),
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
        "landings": len(landings),
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
        caveats.append(
            f"Auch die Auftritte sind ungleich ({tread_stats['min']:.3f} m bis {tread_stats['max']:.3f} m). "
            "Eine einzelne deutlich tiefere Stufe ist oft ein Podest, das im selben Körper steckt und hier "
            "als Stufe mitgemessen wird — stepsOf() zeigt, ob die Datei ein eigenes Podest führt."
        )
    if not all(flight.base_riser_used for _, flight in measured):
        caveats.append(
            "Die unterste Steigung ist nicht mitgemessen: die Unterseite dieses Körpers liegt nicht auf der "
            "Höhe des Antritts (eine Laufplatte mit Untersicht). Gezählt und gemessen sind nur die Steigungen "
            "zwischen zwei sichtbaren Trittflächen."
        )
    caveats.append(
        f"Nutzbreite {clear_width:.3f} m ist die schmalste gemessene Trittfläche. Sie ist eine Rohbaulichte: "
        "Handläufe, Wandbekleidungen und Geländer schmälern sie und sind nur enthalten, soweit sie den "
        "Trittflächenkörper selbst begrenzen. Ist der Lauf samt Wangen als ein Körper exportiert, misst diese "
        "Zahl über die Wangen hinweg und ist dann zu groß."
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


def _rake_of(model: SpatialModel, element: Any) -> _Rake | None:
    """The raking plane a Durchgangshöhe is measured from.

    For a stair that is the plane through the NOSINGS — not the treads, not the
    soffit. The nosing line is what a person's head clears; a plane through the
    back of each tread sits half a going behind it and would report a headroom
    that is too large by ``going × sin(pitch)``, about 15 cm on an ordinary
    flight.

    For a ramp it is the running surface itself.
    """
    if element.is_a("IfcRampFlight") or element.is_a("IfcRamp"):
        surface = _running_surface(model, element)
        if surface is None:
            return None
        pitch = surface.uphill if surface.uphill is not None else np.array([1.0, 0.0, 0.0])
        if surface.uphill is not None:
            tangent = float(math.hypot(surface.normal[0], surface.normal[1]) / surface.normal[2])
            pitch = surface.uphill * math.cos(math.atan(tangent)) + np.array([0.0, 0.0, 1.0]) * math.sin(
                math.atan(tangent)
            )
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

    flight = _read_flight(model, element)
    if flight is None or len(flight.nosings) < 2:
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
    of :data:`~ifc_spatial.operators.FURNISHING` is tested with ``is_a`` because
    ``IfcFurniture`` is only a SUBTYPE of ``IfcFurnishingElement`` in IFC4 — in
    IFC2X3 it is not, and a chair once stopped a clear-height ray for that reason.
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
            if element.is_a() in AIR_TYPES or any(element.is_a(name) for name in FURNISHING):
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
    rakes = [(element, _rake_of(model, element)) for element in bodies]
    usable = [(element, rake) for element, rake in rakes if rake is not None]
    if not usable:
        geo, missing = _geometry_or_answer(model, subject, method)
        if geo is None:
            return missing  # type: ignore[return-value]
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine Lauflinie an {subject.is_a()} „{model.label(subject) or global_id}“",
                remedy=(
                    "Eine Durchgangshöhe wird über der Lauflinie gemessen, und die ergibt sich aus den "
                    "Trittflächen bzw. der Lauffläche. Dieser Körper zeigt keine — die Treppe bzw. Rampe mit "
                    "voller Körpergeometrie neu exportieren."
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
    excluded_self = {global_id}

    per_flight: list[dict[str, Any]] = []
    for element, rake in usable:
        samples = _rake_samples(rake)
        exclude = {*excluded_self, element.GlobalId}
        sampled, candidates = _overhead_hits(model, samples, rake.normal, exclude)
        vertical, _ = _overhead_hits(model, samples, np.array([0.0, 0.0, 1.0]), exclude)
        exact, culprit = _exact_clearance(model, rake, candidates)
        per_flight.append(
            {
                "globalId": element.GlobalId,
                "name": model.label(element),
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
    caveats.append(
        "Gemessen von der Ebene durch die Stufenvorderkanten (bei einer Rampe: von der Lauffläche) bis zur "
        "Oberfläche des nächstliegenden Bauteils darüber. Möblierung ist ausgenommen; Unterzüge, abgehängte "
        "Decken und Leitungen zählen mit, soweit sie als Körper im Modell stehen."
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

    An empty result on a stair that plainly has flights is a real finding and
    gets a caveat rather than a bare ``[]``: Revit writes staircases as a single
    ``IfcStair`` with one body and no parts at all, and „diese Treppe hat keine
    Läufe" would be a statement about the building where the truth is a statement
    about the export.
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
        caveat = (
            "Diese Treppe bzw. Rampe ist in der Datei nicht in Läufe gegliedert: sie trägt keine "
            "IfcRelAggregates-Beziehung auf IfcStairFlight/IfcRampFlight. Das heißt NICHT, dass sie aus einem "
            "einzigen Lauf besteht — mehrere Exporte (Revit an erster Stelle) schreiben die ganze Treppe als "
            "einen Körper. Eine Aussage „so viele Steigungen je Lauf ohne Podest“ ist an dieser Datei deshalb "
            "nicht zu treffen; stairGeometry() misst den Körper als Ganzes. Abhilfe: im CAD die Treppe als "
            "Treppenbauteil mit Läufen und Podesten exportieren."
        )
    else:
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
    "HEADROOM_LATERAL",
    "HEADROOM_REACH",
    "HEADROOM_SAMPLE_SPACING",
    "RAMP_TYPES",
    "STAIR_TYPES",
    "TREAD_FLATNESS",
    "TREAD_NORMAL_DOT",
    "headroom",
    "ramp_slope",
    "stair_geometry",
    "steps_of",
]
