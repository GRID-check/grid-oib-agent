"""Barrierefreiheit as geometry — the four clearances OIB 4 is decided on, measured.

OIB Richtlinie 4 covers *Nutzungssicherheit und Barrierefreiheit*, and almost
every barrier-free requirement in it comes down to a distance this engine could
not measure: can a wheelchair turn in this room, is there a step at this door,
is anything standing at an edge you can fall over, is there room to stand beside
the door while pulling it open. All four are geometry. None of them is a
verdict, and this module produces none.

## Why a module about accessibility is the one that must not judge

Every other operator here refuses to judge for the same reason — the number
belongs to the model and the threshold belongs to the Bestimmung. This module is
the one where that discipline is hardest to keep and most expensive to lose.
OIB 4 names 1.50 m of Bewegungsfläche and it names a maximum step, so the
temptation to write ``fits >= 1.50 → barrierefrei`` is right there in the
requirement. Two things make that wrong, and both of them hurt a real person:

  - **A false „erfüllt"** is a building that a wheelchair user cannot use, signed
    off by a machine that measured the Rohbau and called it the finished floor.
    Every caveat in this file names a way that can happen: a 0 mm threshold on a
    slab that has no screed on it yet, a turning circle in a room whose fitted
    wardrobe was never exported, a clear approach measured with the door leaf in
    its modelled — that is, closed — position.
  - **A false „nicht erfüllt"** costs an applicant a redesign for a defect that
    lives in the export rather than in the building, which is how an architect
    learns to stop reading the tool.

So: this layer measures what IS there, says what it measured it ON, and hands
the number to the clause. The words „barrierefrei", „erfüllt" and „entspricht"
do not appear in any answer this module returns, and the thresholds do not
appear in its code.

## What is new here, and what is deliberately not

Read together with the three modules it stands on and does not duplicate:
:func:`~ifc_spatial.clearance.clear_opening_width` measures a door *aperture*
(this measures the floor in front of it), :func:`~ifc_spatial.circulation.egress_path`
walks a door *graph* (this never leaves one room), and
:func:`~ifc_spatial.daylight.above` / :func:`~ifc_spatial.daylight.below` cast
vertical *rays* (this uses them, for the surface on the far side of a wall).

The one genuinely new primitive is the **largest inscribed circle in a free
floor polygon** — the room's own footprint minus the plan silhouette of
everything standing on it — because that is the shape of the Bewegungsfläche
question and nothing in this library could produce it.

## The parameters, and why they are not defaulted

:func:`turning_circle` takes a ``diameter`` and :func:`balustrade_check` takes a
``fall_height``. Both default to ``None``, and neither is ever supplied by this
module. That is a weaker refusal than the one ``light_incidence`` makes about
its 45°, and the difference is argued at each call site: an incidence prism
without an angle is not a smaller answer, it is *no geometry at all*, so that
operator must refuse. A turning circle without a diameter is still a complete
measurement — the largest circle that fits — and refusing to hand it over would
withhold a number that needs no clause. So the parameter is optional rather than
required, and hard-coding 1.50 m as its default is the one thing that is out of
the question: that would put an OIB number in this file.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .geometry import PARALLEL_DOT
from .geometry import VERTICAL_TOLERANCE
from .geometry import dominant_vertical_plane
from .geometry import triangle_normals_areas
from .model import AIR_TYPES
from .model import SpatialModel
from .operators import CONTACT
from .operators import COORDINATE_TOLERANCE
from .operators import DIMENSION_TOLERANCE
from .operators import FENESTRATION
from .operators import FURNISHING
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind

# ── the error model, and the cost bounds ────────────────────────────────────
#
# No tolerance is invented here. The two that travel with these answers are
# `operators.DIMENSION_TOLERANCE` (10 mm — a dimension is a difference of two
# independently tessellated faces, so both errors are in it) and
# `operators.COORDINATE_TOLERANCE` (5 mm — one surface). The constants below are
# MODELLING decisions and cost bounds, and each says which failure it prevents.

#: How far above a room's floor an element's underside may sit and still count as
#: standing ON that floor, in metres.
#:
#: The rule this implements is the whole obstacle filter: an element takes floor
#: away from a wheelchair when it reaches down to the floor. Without it the
#: sample house's every room measures **zero** free floor, because the ceiling
#: covering, the roof and the upper slab each project over 100 % of the plan —
#: 15.42 m² of "obstacle" in a 15.42 m² bedroom. 20 mm is one tessellation
#: tolerance plus a fitting gap, not a construction dimension.
FLOOR_CONTACT = 0.02

#: Below this, an element's intrusion into a room's plan is tessellation noise
#: and not an obstacle, in m². 1 cm².
#:
#: A door leaf modelled flush in its wall shares an EDGE with the room polygon,
#: and floating point turns a shared edge into a sliver of a few µm². Subtracting
#: those slivers costs shapely a great deal and changes no answer.
MIN_OBSTACLE_AREA = 1e-4

#: Quadrant segments in the negative buffer that erodes the free-floor polygon.
#:
#: Eroding by ``r`` and asking whether anything is left is exactly the test "does
#: a disc of radius r fit", and GEOS approximates the disc with a polygon
#: INSIDE it — so the eroded region comes out slightly too large and the radius
#: slightly too generous. 16 segments per quadrant is a 64-gon, whose error is
#: ``1 − cos(π/64) = 0.12 %`` of r: 0.9 mm on a 0.75 m radius, an order below
#: `DIMENSION_TOLERANCE`. The default of 8 would be 3.6 mm, which is still
#: inside the tolerance but no longer negligible against it.
BUFFER_QUAD_SEGS = 16

#: Bisection steps for the largest inscribed circle. Over a bracket no wider
#: than a room, 40 halvings land far below any tolerance this answer carries;
#: the count is fixed rather than adaptive so the number is reproducible.
INSCRIBED_STEPS = 40

#: How far past the outer face of a wall the ground on the far side is sampled,
#: in metres.
#:
#: Far enough to clear the wall itself and the cill projecting past it — the
#: sample house's external door has a 30 mm cill projection declared — and close
#: enough that the surface found is still the one at the opening rather than the
#: garden path beyond it.
OUTSIDE_PROBE = 0.30

#: How far above an opening's underside the probe for the far-side surface
#: starts, in metres. The ray goes DOWN from there, so anything the probe finds
#: is at or below the opening's own sill: that is what makes it a surface
#: somebody could land on rather than the roof overhang above their head, which
#: is what a probe started at the opening's head finds on this very fixture
#: (2.018 m of flat roof, 30 cm outside the bedroom window).
PROBE_LIFT = 0.10

#: Horizontal reach, in metres, within which an ``IfcRailing`` counts as standing
#: AT an edge rather than merely somewhere in the building. A balustrade is built
#: on the edge it protects; a metre of slack covers a railing set back behind a
#: planter and stops one on the far side of a terrace from being credited here.
RAILING_REACH = 1.0

#: How far above the walking level a railing's own FOOT may sit and still be
#: that level's balustrade, in metres.
#:
#: Not a tolerance — a modelling allowance. A balustrade is regularly set on an
#: upstand, a kerb or a plinth, and its body then starts 50 to 300 mm above the
#: floor; a millimetre-tight test would drop it and report an unprotected edge
#: at a protected one, which is the dangerous direction. Half a metre is five
#: times any such detail and a fifth of the smallest storey pitch, so the
#: balustrade of the floor ABOVE — the thing this test exists to exclude, since
#: every storey of a building has the same plan — is never inside it.
RAILING_FOOT = 0.5

#: Host types at which an aperture is a hole in a WALL whatever its proportions,
#: and is never measured as a floor void. Subtypes are covered — the test is
#: ``entity.is_a(name)`` — so ``IfcWallStandardCase`` needs no entry of its own.
_VERTICAL_HOSTS = ("IfcWall", "IfcCurtainWall", "IfcColumn", "IfcBeam", "IfcMember")

#: Probe points across a floor void's plan rectangle, as fractions of its extent.
#:
#: Five and not one. The rectangle is a BOUNDING box: an L-shaped or a
#: stair-shaped void has solid slab inside it, and a probe that lands there
#: reads the slab's own top and reports a fall of zero. The deepest of the five
#: is taken, which is also the answer at a stairwell void whose centre happens to
#: sit over a tread — the drop past the tread is the one somebody falls.
_VOID_PROBES = ((0.5, 0.5), (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75))

#: Triangles the free-floor construction may union before it refuses.
#:
#: A cost bound in the spirit of ``clearance.CLEARANCE_MAX_TRIANGLE_PAIRS``, not
#: a tolerance. Every candidate standing on the floor has each of its triangles
#: projected and unioned, and shapely's union is superlinear in the count. The
#: sample house's living room — the worst room in it, with a curtain wall, six
#: glazed panels and twelve pieces of furniture — needs under 5 000. The bound
#: sits two orders above that, because past it the honest answer is that this
#: operator wants a plan-section primitive and does not have one.
FREE_FLOOR_MAX_TRIANGLES = 500_000

#: Contact slack for the broad phase around a room, metres. The same 5 cm
#: ``operators.CONTACT`` uses, spelled separately because this one bounds a BOX
#: query and not a solid offset — a candidate list is allowed to be generous,
#: since every entry is then tested exactly against the room's footprint.
CONTACT_EXTEND = 0.05

#: The types :func:`threshold_height` will measure a step at. Deliberately not
#: :data:`~ifc_spatial.operators.FENESTRATION`: a window has no threshold, and
#: answering "0 mm" for one would be a number about nothing.
DOORWAY = {"IfcDoor", "IfcDoorStandardCase", "IfcOpeningElement"}

_NOT_A_VERDICT = (
    "Gemessene Geometrie, kein Befund: dieses Modul kennt keinen Grenzwert und wendet keinen an. "
    "Ob das gemessene Maß genügt, entscheidet die Bestimmung."
)


# ════════════════════════════════════════════════════════════════════════════
# plan geometry — the polygons the four operators are all built out of
# ════════════════════════════════════════════════════════════════════════════


def _plan_footprint(triangles: np.ndarray) -> Any | None:
    """A solid's floor polygon, by exactly the method ``_footprint_area`` measures.

    Kept in step with :func:`~ifc_spatial.operators._footprint_area` on purpose,
    down to the 0.01 normal tolerance and the both-windings sweep: that function
    returns the AREA of this union and a polygon cannot be recovered from an
    area, but the two must not drift apart, so ``test_accessibility`` asserts
    that this polygon's area equals what that function reports for all three
    rooms of the sample house.

    Both windings are taken and the larger wins for the reason spelled out
    there — a Revit IFC2X3 ``IfcSpace`` is routinely wound inside-out, and
    keeping only the faces pointing one way returns an empty polygon for a room
    that plainly has a floor. A confident zero is the worst thing this library
    can produce.
    """
    import shapely
    import shapely.ops

    if triangles is None or len(triangles) == 0:
        return None
    normals, _ = triangle_normals_areas(triangles)
    best = None
    for sign in (1.0, -1.0):
        facing = triangles[normals[:, 2] * sign > 0.01]
        if len(facing) == 0:
            continue
        polygons = []
        for tri in facing:
            polygon = shapely.Polygon(tri[:, :2])
            if polygon.is_valid and polygon.area > 0:
                polygons.append(polygon)
        if not polygons:
            continue
        try:
            union = shapely.ops.unary_union(polygons)
        except Exception:
            continue
        if best is None or union.area > best.area:
            best = union
    return best


def _plan_silhouette(triangles: np.ndarray) -> Any | None:
    """A solid's outline in plan — every triangle projected, unioned.

    Not the horizontal faces this time: an obstacle blocks the floor over its
    whole shadow, and a bed's shadow is bounded by its sides, not by its top.
    Taking only the horizontal faces of the sample house's bed would leave the
    mattress and lose the frame; taking all of them gives 3.61 m², which is the
    bed.

    The projection is a SHADOW and knows nothing about height, so a table is
    subtracted over its whole top even though a footrest fits under it. That is
    the conservative direction — it makes the circle smaller — and it is named in
    every caveat that uses this.
    """
    import shapely
    import shapely.ops

    if triangles is None or len(triangles) == 0:
        return None
    polygons = []
    for tri in triangles:
        polygon = shapely.Polygon(tri[:, :2])
        if polygon.is_valid and polygon.area > 1e-9:
            polygons.append(polygon)
    if not polygons:
        return None
    try:
        return shapely.ops.unary_union(polygons)
    except Exception:
        return None


def _is_furnishing(element: Any) -> bool:
    """Loose furniture, by the same three-way test :func:`daylight._is_excluded` uses.

    Every entry of ``FURNISHING`` is checked rather than only the base type,
    because IFC2X3 has no subtype relation between ``IfcFurniture`` and
    ``IfcFurnishingElement`` and a single-entry test would let an IFC2X3 chair
    count as a fixed installation.

    IFC has **no** flag for fixed versus loose — ``Pset_FurnitureTypeCommon``
    carries none — so the classification is by entity type and nothing else. A
    built-in wardrobe exported as ``IfcFurniture`` is counted as loose here, and
    the caveat says so, because there is no fact in the file that would separate
    it from a chair.
    """
    for kind in FURNISHING:
        try:
            if element.is_a(kind):
                return True
        except Exception:
            continue
    return False


def _largest_circle(polygon: Any) -> tuple[float, tuple[float, float]] | None:
    """The largest circle inscribed in a polygon: its radius and a centre.

    Erosion and bisection, which is the definition rather than an approximation
    of it: a disc of radius ``r`` fits inside ``P`` exactly when ``P`` eroded by
    ``r`` is non-empty, and the erosion is ``P.buffer(-r)`` with round joins. So
    the largest radius is found by halving the bracket ``[0, half the longer
    side]``, and the centre is a point of the last non-empty erosion — any point
    of it is a valid centre, and ``representative_point`` is guaranteed to lie
    inside even when that erosion has collapsed to a sliver.

    Cross-checked in the suite against GEOS's own ``maximum_inscribed_circle``,
    which is a completely different algorithm (a Voronoi-based cell search) and
    therefore a real oracle. On the sample house the two agree to 4 mm, and
    where they differ this one is the exact answer: the bedroom's largest circle
    is 3.4625 m, which is the room's own clear width to the millimetre, and
    GEOS's tolerance-bounded search returns a shade less.
    """
    if polygon is None or polygon.is_empty or polygon.area <= 0:
        return None
    min_x, min_y, max_x, max_y = polygon.bounds
    low = 0.0
    high = max(max_x - min_x, max_y - min_y) / 2.0 + COORDINATE_TOLERANCE
    best = None
    for _ in range(INSCRIBED_STEPS):
        mid = (low + high) / 2.0
        eroded = polygon.buffer(-mid, quad_segs=BUFFER_QUAD_SEGS)
        if eroded.is_empty or eroded.area <= 0:
            high = mid
        else:
            low = mid
            best = eroded
    if best is None:
        return None
    centre = best.representative_point()
    return low, (float(centre.x), float(centre.y))


class _FreeFloor:
    """A room's clear floor, and the bookkeeping of what was taken out of it."""

    __slots__ = ("footprint", "fixed", "furnished", "floor_z", "obstacles", "triangles")

    def __init__(self, footprint: Any, floor_z: float) -> None:
        self.footprint = footprint
        self.fixed = footprint
        self.furnished = footprint
        self.floor_z = floor_z
        self.obstacles: list[dict[str, Any]] = []
        self.triangles = 0


def _free_floor(model: SpatialModel, space: Any, skip: set[str] | None = None) -> _FreeFloor | Answer[Any] | None:
    """The room's footprint minus the plan shadow of everything standing on it.

    Two polygons come back, not one, and which of them is the answer is the
    judgment this module is most exposed on:

      - ``fixed`` — the footprint less everything that is not
        ``IfcFurnishingElement`` and its kin: walls bulging in, columns, stairs,
        sanitary fittings, the door leaf where the export modelled it.
      - ``furnished`` — the same, less the loose furniture as well.

    The **headline is ``fixed``**, and the reason is what a building permit is
    granted on. The furniture in an IFC export is a presentation layer — the
    sample house's living room carries a piano, a couch, two Viper chairs and
    six dining chairs, placed by whoever made the visualisation — and an
    applicant is not bound to any of it. Reporting a room as too small to turn in
    because somebody left a coffee table in the render would be a finding about
    the render. But the furnished figure travels beside it in every answer,
    because a room that only turns when it is empty is a real design finding and
    the architect is the one who gets to decide which of the two matters.

    Candidates come from ``tree.select_box`` — the cheap broad phase — rather
    than from ``bounds()``, which is the right list for a different question:
    ``bounds`` deliberately drops anything CONTAINED in the room, and containment
    is exactly what a turning circle is about.
    """
    geo = model.geometry(space.GlobalId)
    if geo is None:
        return None
    footprint = _plan_footprint(geo.triangles)
    if footprint is None or footprint.is_empty:
        return None

    floor_z = float(geo.box[0][2])
    free = _FreeFloor(footprint, floor_z)
    skip = skip or set()

    for element in model.tree.select_box(space, extend=CONTACT_EXTEND):
        global_id = getattr(element, "GlobalId", None)
        if not global_id or global_id == space.GlobalId or global_id in skip:
            continue
        if element.is_a() in AIR_TYPES:
            continue
        other = model.geometry(global_id)
        if other is None:
            continue
        # The floor-contact rule. An element obstructs the clear floor when it
        # reaches DOWN to it: a ceiling at 2.20 m and a roof at 2.50 m project
        # over the whole room and take none of its floor away.
        if not (float(other.box[0][2]) <= floor_z + FLOOR_CONTACT < float(other.box[1][2])):
            continue
        free.triangles += len(other.triangles)
        if free.triangles > FREE_FLOOR_MAX_TRIANGLES:
            return _too_many_triangles(model, space, free.triangles)
        silhouette = _plan_silhouette(other.triangles)
        if silhouette is None:
            continue
        try:
            intruding = silhouette.intersection(footprint)
        except Exception:
            continue
        if intruding.area <= MIN_OBSTACLE_AREA:
            continue
        loose = _is_furnishing(element)
        free.furnished = free.furnished.difference(silhouette)
        if not loose:
            free.fixed = free.fixed.difference(silhouette)
        free.obstacles.append(
            {
                "globalId": global_id,
                "name": model.label(element),
                "ifcType": element.is_a(),
                "area": round(float(intruding.area), 4),
                "zaehlt": "möbliert" if loose else "fest",
            }
        )

    free.obstacles.sort(key=lambda o: (-o["area"], o["globalId"]))
    return free


def _too_many_triangles(model: SpatialModel, space: Any, count: int) -> Answer[Any]:
    name = model.label(space) or space.GlobalId
    return undecidable(
        from_=[space.GlobalId],
        method=f"freieBodenfläche({space.GlobalId})",
        provenance="computed",
        missing=MissingFact(
            what=f"die freie Bodenfläche von „{name}“ ist für diese Auswertung zu fein tesselliert",
            remedy=(
                f"In diesem Raum stehen Bauteile mit zusammen über {count} Dreiecken. Die Grundrissprojektion "
                f"wird ab {FREE_FLOOR_MAX_TRIANGLES} Dreiecken nicht begonnen, weil ihre Laufzeit überlinear "
                "wächst und eine Anfrage sonst nicht zurückkommt. Abhilfe: das Modell mit gröberer "
                "Tessellierung exportieren, oder diesen Raum in einem Worker ohne Anfragezeitlimit auswerten."
            ),
            elements=[space.GlobalId],
        ),
    )


# ════════════════════════════════════════════════════════════════════════════
# opening geometry — the frame the three door/window operators share
# ════════════════════════════════════════════════════════════════════════════


class _Frame:
    """An opening's own coordinate frame in plan: ``lateral`` across it, ``normal``
    through it, and how far the wall reaches on either side.

    Every one of the three opening operators needs the same four things — which
    way is through, how wide the opening is, where its two faces are, and how
    high its underside sits — so they are built once.
    """

    __slots__ = (
        "normal",
        "lateral",
        "u_min",
        "u_max",
        "v_min",
        "v_max",
        "z_min",
        "z_max",
        "host_min",
        "host_max",
    )

    def __init__(self, normal: np.ndarray, lateral: np.ndarray) -> None:
        self.normal = normal
        self.lateral = lateral
        self.host_min: float | None = None
        self.host_max: float | None = None

    def point(self, u: float, v: float) -> np.ndarray:
        """A point of the opening's plane, in model plan coordinates."""
        return self.lateral * u + self.normal * v

    @property
    def u_centre(self) -> float:
        return (self.u_min + self.u_max) / 2.0

    def outer_face(self, sign: float) -> float:
        """How far through the construction, on the given side, the outer face lies.

        The HOST wall's extent wins when it reaches further than the element's
        own, which it usually does: a door leaf is 44 mm thick and the wall it
        sits in is 300 mm, so a probe 30 cm past the LEAF is still inside the
        masonry, and the ray cast there finds the wall's own underside instead
        of the ground outside.
        """
        own = self.v_max if sign > 0 else self.v_min
        host = self.host_max if sign > 0 else self.host_min
        if host is None:
            return own
        return max(own, host) if sign > 0 else min(own, host)


def _facing_area(triangles: np.ndarray, normal: np.ndarray) -> float:
    """Area of the vertical faces that look along ``normal`` — the frame's own face.

    The same selection :func:`geometry.dominant_vertical_plane` makes when it
    picks the winning bin, re-summed here because that function returns a
    direction and not the area that won it, and the area is what
    :func:`_is_floor_void` weighs.
    """
    normals, areas = triangle_normals_areas(triangles)
    facing = (np.abs(normals[:, 2]) < VERTICAL_TOLERANCE) & (np.abs(normals[:, :2] @ normal) >= PARALLEL_DOT)
    return float(areas[facing].sum())


def _is_floor_void(model: SpatialModel, element: Any, geo: Any) -> bool:
    """Is this aperture a hole in a FLOOR rather than a hole in a wall?

    The failure this decides: ``AC20-FZK-Haus``'s gallery void
    ``16PF6khT5_p$Z03P73inyv`` („Slab Opening", 4.26 × 3.71 m in plan, 0.20 m
    thick, hosted in the ``IfcSlab`` „Slab-033"). It has vertical faces — the
    four sides of the prism — so ``dominant_vertical_plane`` happily returns one
    of them and the wall measurement then probes 0.30 m to either side IN PLAN,
    lands on the room below on one side and the terrain on the other, both at
    z = 0.0, and reports „fall 0.000 m, parapet 2.500 m" at the one edge in the
    house that carries both of the model's railings. A parapet of 2.5 m at a
    floor void is not a physical quantity.

    Two independent signals, and the geometric one decides:

    - **plan against face.** The frame would be built from the largest vertical
      face; the aperture's plan rectangle is the hole itself. When the hole seen
      from above is LARGER than the face the frame would stand on, the body is a
      slab void and not a wall reveal. Measured: the gallery void is 15.805 m²
      of plan against 1.484 m² of face, a factor of ten. Every opening in
      ``Ifc4_SampleHouse`` runs the other way by as much — its window reveals
      0.525 m² of plan against 4.380 m² of face, its internal doors 0.077 m²
      against 3.418 m². The ratio rather than any absolute thickness is what
      keeps a wide, low strip window on the wall side where it belongs: at
      3.00 × 0.50 × 0.40 m that is 1.50 m² of plan against 2.40 m² of face.
    - **the host.** An aperture hosted in an ``IfcWall`` is a wall opening
      whatever its proportions, and is refused here rather than measured
      downward. ``hosted_in`` is consulted only to VETO, so a file with no
      ``IfcRelVoidsElement`` still gets the geometric answer.
    """
    from .operators import hosted_in

    normal3 = dominant_vertical_plane(geo.triangles)
    if normal3 is not None:
        normal = np.array([float(normal3[0]), float(normal3[1])])
        length = float(np.linalg.norm(normal))
        if length >= 1e-9:
            normal = normal / length
            lateral = np.array([-normal[1], normal[0]])
            points = geo.verts[:, :2]
            across = points @ lateral
            through = points @ normal
            plan = float(across.max() - across.min()) * float(through.max() - through.min())
            if plan <= _facing_area(geo.triangles, normal):
                return False

    host = hosted_in(model, element.GlobalId)
    if host.decidable and host.value:
        hosting = model.file.by_guid(host.value[0].global_id)
        if any(hosting.is_a(name) for name in _VERTICAL_HOSTS):
            return False
    return True


def _frame_of(model: SpatialModel, element: Any) -> _Frame | None:
    """The opening's plan frame, or ``None`` when it has no vertical plane.

    ``None`` is a real case and not a failure: a roof light in a flat roof has no
    vertical plane, so "in front of it" and "on the far side of it" are not
    defined in plan. Every caller turns this into an undecidable that says so.

    A body that HAS vertical faces can still be a hole in a floor — the sides of
    the prism are vertical — and for those this returns ``None`` as well. See
    :func:`_is_floor_void` for the measured numbers; ``balustrade_check`` then
    measures the fall downward through it instead, and the other two callers
    refuse, which is right: a threshold height and a clear approach at a gallery
    void are not defined either.
    """
    from .operators import hosted_in

    geo = model.geometry(element.GlobalId)
    if geo is None or len(geo.triangles) == 0:
        return None
    normal3 = dominant_vertical_plane(geo.triangles)
    if normal3 is None:
        return None
    normal = np.array([float(normal3[0]), float(normal3[1])])
    length = float(np.linalg.norm(normal))
    if length < 1e-9:
        return None
    if _is_floor_void(model, element, geo):
        return None
    normal = normal / length
    frame = _Frame(normal, np.array([-normal[1], normal[0]]))

    points = geo.verts[:, :2]
    across = points @ frame.lateral
    through = points @ frame.normal
    frame.u_min, frame.u_max = float(across.min()), float(across.max())
    frame.v_min, frame.v_max = float(through.min()), float(through.max())
    frame.z_min, frame.z_max = float(geo.box[0][2]), float(geo.box[1][2])

    host = hosted_in(model, element.GlobalId)
    if host.decidable and host.value:
        host_geo = model.geometry(host.value[0].global_id)
        if host_geo is not None:
            host_through = host_geo.verts[:, :2] @ frame.normal
            frame.host_min = float(host_through.min())
            frame.host_max = float(host_through.max())
    return frame


def _no_plane(model: SpatialModel, element: Any, method: str) -> Answer[Any]:
    name = model.label(element) or element.GlobalId
    return undecidable(
        from_=[element.GlobalId],
        method=method,
        provenance="computed",
        missing=MissingFact(
            what=f"keine senkrechte Öffnungsebene an {element.is_a()} „{name}“",
            remedy=(
                "Diese Messung braucht die Ebene der Öffnung, um „davor“ und „dahinter“ überhaupt zu "
                "definieren. Dieses Bauteil hat entweder keinen Körper im Export, oder es liegt waagrecht "
                "(ein Dachflächenfenster in einem Flachdach) und hat damit keine senkrechte Ebene. Abhilfe: "
                "den Export mit Körpergeometrie sowie mit Öffnungen und Füllungen wiederholen."
            ),
            elements=[element.GlobalId],
        ),
    )


def _spaces_by_side(model: SpatialModel, element: Any, frame: _Frame) -> dict[float, Any]:
    """Which room lies on which side of the opening, keyed by the sign along ``n``.

    ``opens_to`` gives the rooms; it does not say which side each is on, and for
    a door between two rooms that is the entire question. The test is the
    projection of the room's own area-weighted centroid onto the opening's
    normal — a room is on the ``+`` side when its centre is beyond the opening's
    own extent in ``+n``. A centroid rather than a box centre because an L-shaped
    room's box centre can sit outside the room.
    """
    from .operators import opens_to

    found: dict[float, Any] = {}
    answer = opens_to(model, element.GlobalId)
    if not answer.decidable or not answer.value:
        return found
    for ref in answer.value:
        geo = model.geometry(ref.global_id)
        if geo is None:
            continue
        through = float(np.array(geo.centroid[:2]) @ frame.normal)
        sign = 1.0 if through > (frame.v_min + frame.v_max) / 2.0 else -1.0
        # First room wins a side. Two rooms projecting onto the same side happens
        # when a door sits in a re-entrant corner; reporting the second as if it
        # were the far side would invent a step that is not there.
        found.setdefault(sign, model.file.by_guid(ref.global_id))
    return found


def _surface_below(model: SpatialModel, x: float, y: float, z: float) -> tuple[float, Any] | None:
    """The solid surface a person standing at ``(x, y)`` would be standing on.

    Cast downward from ``z``, first hit wins, air and furniture excluded — a
    doormat is not a floor level. When the probe point is already INSIDE a solid
    the ray would come out of its far side, so that case is answered from the
    occupying solid's box top instead: the ground outside is HIGHER than the
    opening's underside, which is a step up rather than a step down, and the box
    top is exact for the flat slab that produces it and an upper bound for a
    sloping one.
    """
    point = (float(x), float(y), float(z))
    occupying = [
        e
        for e in model.tree.select(point)
        if getattr(e, "GlobalId", None) and e.is_a() not in AIR_TYPES and not _is_furnishing(e)
    ]
    if occupying:
        best = None
        for element in occupying:
            geo = model.geometry(element.GlobalId)
            if geo is None:
                continue
            top = float(geo.box[1][2])
            if best is None or top > best[0]:
                best = (top, element)
        if best is not None:
            return best

    hits = sorted(
        model.tree.select_ray(point, (0.0, 0.0, -1.0), length=model.diagonal),
        key=lambda h: float(h.distance),
    )
    for hit in hits:
        element = model.file.by_id(hit.instance.id())
        if element.is_a() in AIR_TYPES or _is_furnishing(element):
            continue
        return float(point[2]) - float(hit.distance), element
    return None


def _standing_level(model: SpatialModel, element: Any, frame: _Frame, sign: float, space: Any | None) -> dict[str, Any]:
    """The level of the surface somebody stands on, on one side of an opening.

    Two routes, and the answer says which one it took, because they are not the
    same claim:

      - **the room body** — ``IfcSpace``'s own underside. That is the finished
        floor if and only if the room was modelled from finished floor level,
        which is the usual convention and not a guarantee. Cross-checked against
        the slab under it, and a disagreement is reported rather than resolved.
      - **a ray outside** — when no ``IfcSpace`` is on this side, which is the
        normal case for an external door. Then the level is whatever solid the
        ray finds, and its type travels with it: an ``IfcSlab`` under a door is a
        threshold; an ``IfcRoof`` would mean the probe went somewhere unintended.
    """
    from .daylight import below

    entry: dict[str, Any] = {
        "direction": [round(float(frame.normal[0] * sign), 4), round(float(frame.normal[1] * sign), 4)],
        "space": None,
        "spaceName": None,
        "level": None,
        "via": None,
        "surface": None,
    }
    if space is not None:
        geo = model.geometry(space.GlobalId)
        if geo is not None:
            entry["space"] = space.GlobalId
            entry["spaceName"] = model.label(space)
            entry["level"] = round(float(geo.box[0][2]), 4)
            entry["via"] = "Unterkante des Raumkörpers (IfcSpace)"
            under = below(model, space.GlobalId, samples=3)
            if under.decidable and under.value:
                nearest = under.value[0]
                entry["surface"] = {
                    "globalId": nearest["globalId"],
                    "name": nearest["name"],
                    "ifcType": nearest["ifcType"],
                    "top": round(float(entry["level"]) - float(nearest["gap"]), 4),
                    "gap": nearest["gap"],
                }
            return entry

    face = frame.outer_face(sign)
    plan = frame.point(frame.u_centre, face + sign * OUTSIDE_PROBE)
    found = _surface_below(model, float(plan[0]), float(plan[1]), frame.z_min + PROBE_LIFT)
    if found is None:
        return entry
    level, hit = found
    entry["level"] = round(level, 4)
    entry["via"] = f"Strahl nach unten, {OUTSIDE_PROBE:.2f} m vor der Öffnung (kein IfcSpace auf dieser Seite)"
    entry["surface"] = {
        "globalId": hit.GlobalId,
        "name": model.label(hit),
        "ifcType": hit.is_a(),
        "top": round(level, 4),
        "gap": None,
    }
    return entry


def _levels_both_sides(model: SpatialModel, element: Any, frame: _Frame) -> list[dict[str, Any]]:
    spaces = _spaces_by_side(model, element, frame)
    return [_standing_level(model, element, frame, sign, spaces.get(sign)) for sign in (1.0, -1.0)]


# ════════════════════════════════════════════════════════════════════════════
# 1 — turning circle
# ════════════════════════════════════════════════════════════════════════════


def turning_circle(model: SpatialModel, space_global_id: str, diameter: float | None = None) -> Answer[dict[str, Any]]:
    """The largest circle that fits in this room's clear floor, and where it sits.

    The Bewegungsfläche question, as geometry: the room's own footprint polygon,
    less the plan shadow of everything standing on it, eroded until nothing is
    left. See :func:`_largest_circle` for why erosion IS the inscribed-circle
    test rather than an approximation of it, and :func:`_free_floor` for what
    gets subtracted.

    ## The diameter, and why it is optional rather than required

    ``diameter`` defaults to ``None`` and this module never supplies one. OIB 4
    names 1.50 m; that number is a fact about the clause and writing it as a
    default here would make this file believe in it.

    The choice against a hard refusal — the one ``light_incidence`` makes about
    its 45° — is deliberate and rests on a difference between the two questions.
    A light prism without an angle is not a smaller answer, it is no geometry at
    all: there is nothing to build and nothing to report, so refusing is the only
    honest move. A turning circle without a diameter is a complete measurement —
    *the largest circle that fits is 3.46 m and its centre is here* — and that
    number is useful, checkable and clause-free. Refusing to hand it over would
    withhold a measurement in order to enforce a parameter it does not need.

    When a diameter IS given it adds one field, ``requested.fits``, which is a
    comparison of two measured lengths and not a verdict: it says the circle fits
    on this geometry, not that the room complies. A nonsensical diameter is
    refused outright rather than silently clamped.

    ## What was counted, which is a judgment and not a measurement

    ``value["diameter"]`` counts **fixed** obstruction only — walls intruding,
    columns, stairs, the door leaf as modelled. Loose furniture
    (``IfcFurnishingElement`` and its subtypes) is reported in the parallel
    ``mitMoeblierung`` block and is NOT in the headline, because a permit is
    granted on the building and the piano in this fixture's living room was
    placed by whoever made the visualisation. IFC carries no fixed/loose flag at
    all, so the split is by entity type: a built-in wardrobe exported as
    ``IfcFurniture`` lands on the loose side and the caveat says so.

    Measured on ``Ifc4_SampleHouse``: bedroom 3.463 m fixed / 2.478 m furnished,
    living room 5.606 / 4.402, entrance hall 1.953 / 1.953. The bedroom's fixed
    figure is its own clear width to the millimetre, which is the check that the
    polygon is the room and not something near it.

    ## What this does not see

    The shadow is taken over the full height of each obstacle, so a wall cabinet
    hung clear of the floor is not counted (it fails the floor-contact test) and
    a table is counted over its whole top (a footrest fits under it). The first
    error makes the circle too large and the second too small; both are named in
    the caveat, because a clearance whose error direction is invisible cannot be
    argued with.
    """
    method = (
        f"turningCircle({space_global_id})" if diameter is None else f"turningCircle({space_global_id}, {diameter})"
    )
    subject = _require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        _wrong_kind(
            subject,
            method,
            "turningCircle",
            "einen Raum (IfcSpace)",
            "für die freie Fläche vor einer Tür: clearApproach(); für ein lichtes Maß: clearOpeningWidth()",
        )

    if diameter is not None:
        if isinstance(diameter, bool) or not isinstance(diameter, (int, float)) or not math.isfinite(diameter):
            diameter = float("nan")
        if not (0 < float(diameter) < 100):
            return undecidable(
                from_=[space_global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what="brauchbarer Durchmesser (0 m < diameter < 100 m)",
                    remedy=(
                        "Der Durchmesser der Bewegungsfläche stammt aus der Bestimmung, nicht aus dem Modell — "
                        "turningCircle() mit dem Wert der Klausel aufrufen, oder ohne Durchmesser, dann wird "
                        "nur der größte einbeschriebene Kreis gemeldet."
                    ),
                    elements=[space_global_id],
                ),
            )
        diameter = float(diameter)

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    free = _free_floor(model, subject)
    if isinstance(free, Answer):
        return free
    if free is None:
        return _no_footprint(model, subject, method)

    fixed = _largest_circle(free.fixed)
    furnished = _largest_circle(free.furnished)
    if fixed is None:
        return undecidable(
            from_=[space_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine freie Bodenfläche in „{model.label(subject) or space_global_id}“",
                remedy=(
                    "Die Grundrissfläche dieses Raums ist von Bauteilen vollständig überdeckt. Das ist fast "
                    "immer ein Befund über den Export — ein Bauteil, dessen Körper den ganzen Raum füllt — "
                    "und selten über den Raum. bounds() zeigt, was den Raum begrenzt."
                ),
                elements=[space_global_id],
            ),
        )

    loose = [o for o in free.obstacles if o["zaehlt"] == "möbliert"]
    payload: dict[str, Any] = {
        "diameter": round(2 * fixed[0], 4),
        "radius": round(fixed[0], 4),
        "centre": [round(fixed[1][0], 4), round(fixed[1][1], 4), round(free.floor_z, 4)],
        "freeArea": round(float(free.fixed.area), 4),
        "footprintArea": round(float(free.footprint.area), 4),
        "counted": "feste Einbauten (alles außer IfcFurnishingElement und Untertypen)",
        "mitMoeblierung": None
        if furnished is None
        else {
            "diameter": round(2 * furnished[0], 4),
            "radius": round(furnished[0], 4),
            "centre": [round(furnished[1][0], 4), round(furnished[1][1], 4), round(free.floor_z, 4)],
            "freeArea": round(float(free.furnished.area), 4),
            "pieces": len(loose),
        },
        "obstacles": free.obstacles,
        "requested": None
        if diameter is None
        else {
            "diameter": diameter,
            "fits": bool(2 * fixed[0] + DIMENSION_TOLERANCE >= diameter),
            "fitsWithFurnishing": None
            if furnished is None
            else bool(2 * furnished[0] + DIMENSION_TOLERANCE >= diameter),
        },
    }

    caveat = (
        f"{_NOT_A_VERDICT} Gemeldet ist der größte Kreis, der in die freie Bodenfläche passt, mit seinem "
        "Mittelpunkt — nachprüfbar im Grundriss. Abgezogen sind die Grundrissschatten der FESTEN Bauteile, "
        "die bis auf den Fußboden reichen; lose Möblierung steht getrennt unter „mitMoeblierung“ und ist im "
        "Hauptwert NICHT enthalten. IFC kennt kein Merkmal fest/lose — die Trennung erfolgt allein über den "
        "Bauteiltyp, ein als IfcFurniture exportierter Einbauschrank zählt hier deshalb als lose."
    )
    if loose:
        caveat += f" In diesem Raum stehen {len(loose)} Möbel; ohne sie ist der Kreis um "
        caveat += (
            f"{2 * fixed[0] - 2 * furnished[0]:.3f} m größer." if furnished else "einen nicht messbaren Betrag größer."
        )
    caveat += (
        " Der Schatten eines Hindernisses wird über seine volle Höhe genommen: ein Tisch wird über die ganze "
        "Tischplatte abgezogen, obwohl Fußstützen darunter passen (das Maß ist insofern zu KLEIN), und ein "
        "frei über dem Boden hängender Einbau wird gar nicht gezählt (insofern zu GROSS). Ein Türblatt zählt "
        "in der Lage, in der es modelliert ist — in den meisten Exporten geschlossen, der Schwenkbereich "
        "ist damit nicht berücksichtigt."
    )

    return computed(
        payload,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[space_global_id, *[o["globalId"] for o in free.obstacles]],
        method=method,
        caveat=caveat,
    )


def _no_footprint(model: SpatialModel, subject: Any, method: str) -> Answer[Any]:
    name = model.label(subject) or subject.GlobalId
    return undecidable(
        from_=[subject.GlobalId],
        method=method,
        provenance="computed",
        missing=MissingFact(
            what=f"keine waagrechte Fläche an {subject.is_a()} „{name}“ — kein Grundriss ableitbar",
            remedy=(
                "Dieser Körper hat keine waagrechten Flächen, aus denen sich eine Grundrissfläche bilden "
                "ließe. Bei einem Raum heißt das fast immer, dass der Raumkörper im Export beschädigt ist. "
                "Abhilfe: den Raum im CAD neu aufziehen und mit Körpergeometrie exportieren."
            ),
            elements=[subject.GlobalId],
        ),
    )


# ════════════════════════════════════════════════════════════════════════════
# 2 — threshold height
# ════════════════════════════════════════════════════════════════════════════


def threshold_height(model: SpatialModel, door_global_id: str) -> Answer[dict[str, Any]]:
    """The step at a door: the height difference between the floors on either side.

    ## The number is only as honest as what it was measured on

    Barrier-free design allows almost no step, so this is a measurement in
    millimetres — and that is exactly why it must say what it measured. Two
    caveats travel with every answer and neither is boilerplate:

    1. **The precision the export can support.** A level difference is a
       difference of two independently tessellated faces, so it carries
       ``DIMENSION_TOLERANCE`` = **10 mm**. The step a barrier-free doorway is
       allowed is of the same order. A measured 0 mm and a measured 15 mm are
       therefore *not* reliably distinguishable by this route, and the answer
       says so instead of printing three decimals and letting the reader assume
       them.
    2. **Whether there is a finished floor in the file at all.** If no
       ``IfcCovering`` of ``PredefinedType`` ``FLOORING`` exists, the levels are
       those of the room bodies and the structural slabs — the Rohbau. A 0 mm
       threshold on raw slabs says nothing whatever about the finished floor,
       because the screed, the tiles and the door seal are the things that make
       the step, and none of them is in the file. Reporting that 0 mm without
       the caveat would be the most misleading number this module could produce,
       and on this repository's own fixture it is exactly the number that comes
       out: both rooms' bodies start at z = 0.000, the ground slab's top is
       z = 0.000, and the file contains three ``IfcCovering`` — all of them
       ceilings.

    ## The declared route, which is NOT triangulated against this

    ``IfcDoorLiningProperties`` carries ``ThresholdThickness``,
    ``ThresholdDepth`` and ``ThresholdOffset``, and where they are set they are
    reported under ``declared`` — beside the measurement, never merged with it.
    They describe the threshold BOARD, not the difference in floor level, and
    triangulating one against the other would produce the expensive kind of
    wrong: a number right to the millimetre that answers a different question.
    The sample house is instructive here too — it carries an
    ``IfcDoorLiningProperties`` for each of its three doors and every attribute
    of all three is unset.

    Never a verdict: the permitted step is in the Bestimmung, not here.
    """
    method = f"thresholdHeight({door_global_id})"
    subject = _require(model, door_global_id, method)
    if subject.is_a() not in DOORWAY:
        _wrong_kind(
            subject,
            method,
            "thresholdHeight",
            "eine Tür oder eine Türöffnung (IfcDoor, IfcOpeningElement)",
            (
                "ein Fenster hat keine Schwelle — für seine Brüstung: sillAndHead(), für eine Absturzkante: "
                "balustradeCheck(); für die Höhenlage eines beliebigen Bauteils: elevation()"
            ),
        )

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]
    frame = _frame_of(model, subject)
    if frame is None:
        return _no_plane(model, subject, method)

    sides = _levels_both_sides(model, subject, frame)
    known = [s for s in sides if s["level"] is not None]
    if len(known) < 2:
        return _one_sided(model, subject, method, sides)

    step = abs(float(known[0]["level"]) - float(known[1]["level"]))
    finishes = _floor_finishes(model)
    declared_lining = _lining_thresholds(model, subject)

    # The room body and the slab under it are two independent statements about
    # the same floor. Where they disagree the export is saying two things, and
    # the difference is usually the unmodelled build-up — which is the whole
    # subject of this operator, so it is reported and not averaged away.
    drift = [
        s
        for s in known
        if s["surface"] is not None
        and s["surface"]["gap"] is not None
        and abs(float(s["surface"]["gap"])) > COORDINATE_TOLERANCE
    ]

    payload = {
        "threshold": round(step, 4),
        "thresholdMm": round(step * 1000.0, 1),
        "sides": sides,
        "basis": "Fertigfußboden" if finishes else "Rohbau (Raumkörper bzw. Rohdecke)",
        "floorFinishes": finishes,
        "declared": declared_lining,
    }

    caveat = (
        f"{_NOT_A_VERDICT} Die Toleranz dieser Messung beträgt ±{DIMENSION_TOLERANCE * 1000:.0f} mm und liegt "
        "damit in derselben Größenordnung wie das Maß selbst: eine gemessene Differenz unterhalb der Toleranz "
        "ist von 0 mm NICHT zu unterscheiden. Ein Nachweis im Millimeterbereich lässt sich aus einem "
        "tessellierten Export grundsätzlich nicht führen — dafür ist der Detailschnitt zuständig."
    )
    if not finishes:
        caveat += (
            " Diese Datei enthält keinen Fußbodenaufbau (kein IfcCovering mit PredefinedType FLOORING). "
            "Gemessen ist damit der ROHBAU — die Unterkante der Raumkörper bzw. die Oberkante der Rohdecken. "
            "Über die Höhe des FERTIGEN Fußbodens sagt dieses Maß nichts: Estrich, Belag und Türdichtung "
            "erzeugen die Schwelle und stehen nicht in der Datei. Abhilfe: den Fußbodenaufbau als "
            "IfcCovering (FLOORING) mitexportieren."
        )
    else:
        caveat += (
            f" Diese Datei enthält {len(finishes)} Bodenbelag/Bodenbeläge als IfcCovering (FLOORING). Die hier "
            "gemeldeten Niveaus stammen trotzdem aus den Raumkörpern bzw. den Bauteilen unter ihnen — ob der "
            "Belag über oder unter der Raumunterkante liegt, ist Konvention des Exports und nicht prüfbar."
        )
    if drift:
        caveat += (
            " Raumkörper und darunterliegendes Bauteil liegen auf mindestens einer Seite nicht auf gleicher "
            "Höhe (siehe „surface.gap“). Das ist ein Befund über den Export: entweder trägt der Raum einen "
            "Aufbau, der nicht modelliert ist, oder der Raumkörper steht nicht auf seiner Decke."
        )
    if declared_lining:
        caveat += (
            " Die Datei deklariert Schwellenmaße an IfcDoorLiningProperties. Sie stehen unter „declared“ und "
            "sind NICHT mit der Messung verrechnet: sie beschreiben das Schwellenprofil, nicht den "
            "Höhenversatz der beiden Fußböden — zwei verschiedene Größen."
        )
    if any(s["space"] is None and s["level"] is not None for s in sides):
        caveat += (
            f" Auf mindestens einer Seite liegt kein IfcSpace; dort wurde das Niveau {OUTSIDE_PROBE:.2f} m vor "
            "der Öffnung mit einem Strahl nach unten bestimmt. Das ist die Oberfläche an genau diesem einen "
            "Punkt und keine Aussage über das Gelände ringsum."
        )

    return computed(
        payload,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[door_global_id, *[s["space"] for s in sides if s["space"]]],
        method=method,
        caveat=caveat,
    )


def _one_sided(model: SpatialModel, subject: Any, method: str, sides: list[dict[str, Any]]) -> Answer[Any]:
    """One side of the door has no measurable floor at all — undecidable, with why."""
    name = model.label(subject) or subject.GlobalId
    return undecidable(
        from_=[subject.GlobalId],
        method=method,
        provenance="computed",
        missing=MissingFact(
            what=f"das Fußbodenniveau auf einer Seite von {subject.is_a()} „{name}“",
            remedy=(
                "Eine Schwelle ist die Differenz zweier Fußböden; auf einer Seite dieser Tür ist keiner "
                "bestimmbar. Auf dieser Seite liegt weder ein IfcSpace noch ein Bauteil unter der "
                f"Türunterkante ({OUTSIDE_PROBE:.2f} m vor der Öffnung nach unten geprüft). Abhilfe: den "
                "angrenzenden Raum als IfcSpace exportieren, oder das Gelände bzw. die Bodenplatte "
                "mitmodellieren — bei einer Außentür ist das der übliche Fall."
            ),
            elements=[subject.GlobalId],
        ),
    )


def _floor_finishes(model: SpatialModel) -> list[dict[str, Any]]:
    """Every ``IfcCovering`` the file marks as flooring — the finished-floor evidence."""
    try:
        coverings = model.file.by_type("IfcCovering")
    except RuntimeError:
        return []
    found = []
    for covering in coverings:
        if str(getattr(covering, "PredefinedType", "") or "").upper() != "FLOORING":
            continue
        found.append({"globalId": covering.GlobalId, "name": model.label(covering), "ifcType": covering.is_a()})
    return found


def _lining_thresholds(model: SpatialModel, door: Any) -> list[dict[str, Any]]:
    """``IfcDoorLiningProperties`` threshold attributes, where the file sets any.

    Reached through the door's type — ``IsTypedBy`` in IFC4, ``IsDefinedBy`` in
    IFC2X3 where an ``IfcDoorStyle`` carries the same property sets — because
    lining properties hang off the TYPE and not the occurrence.
    ``model.declared_property`` cannot find them: they are entity attributes,
    not pset values, and a pset search reports „nicht deklariert" about a file
    that declares them.
    """
    found: list[dict[str, Any]] = []
    types = []
    for rel in getattr(door, "IsTypedBy", []) or []:
        types.append(rel.RelatingType)
    for rel in getattr(door, "IsDefinedBy", []) or []:
        related = getattr(rel, "RelatingType", None)
        if related is not None:
            types.append(related)
    for door_type in types:
        for pset in getattr(door_type, "HasPropertySets", []) or []:
            try:
                if not pset.is_a("IfcDoorLiningProperties"):
                    continue
            except Exception:
                continue
            values = {
                name: getattr(pset, name, None) for name in ("ThresholdDepth", "ThresholdThickness", "ThresholdOffset")
            }
            if all(v is None for v in values.values()):
                continue
            found.append(
                {
                    "globalId": pset.GlobalId,
                    **{k: None if v is None else round(float(v) * model.unit_scale, 4) for k, v in values.items()},
                }
            )
    return found


# ════════════════════════════════════════════════════════════════════════════
# 3 — balustrade check
# ════════════════════════════════════════════════════════════════════════════


def balustrade_check(
    model: SpatialModel, space_or_element_global_id: str, fall_height: float | None = None
) -> Answer[dict[str, Any]]:
    """Where there is a fall, how deep it is, and what stands at the edge.

    ``sillAndHead`` already measures a parapet, so the new work here is finding
    the **drop**: an opening with a floor far below on the far side. For every
    window, door and unfilled opening at this room, both standing levels are
    measured (:func:`_standing_level`) and the difference is the Absturzhöhe.
    The classic case is a window with a low sill over a two-storey drop, and it
    falls straight out of the two numbers.

    ## The height is the caller's, exactly as in :func:`turning_circle`

    ``fall_height`` defaults to ``None`` and nothing here supplies one. Without
    it every opening is reported with its measured fall and **nothing is called
    an Absturzkante** — which is coherent rather than evasive: whether a fall
    needs protecting is precisely what the parameter decides, so with no
    parameter there is no edge to protect. With it, the openings whose fall
    exceeds it are collected under ``kanten`` and each carries what stands
    there.

    ## Why a missing railing is undecidable and not „kein Geländer"

    An IFC export that contains no ``IfcRailing`` at all has not told you the
    building has no railings; it has told you the exporter did not write them,
    which is extremely common — balustrades live in the architectural model as
    generic components, in a separate metalwork model, or nowhere until detail
    design. So when an edge IS found over the caller's height and the file
    contains not one ``IfcRailing``, this returns **undecidable**, with the edges
    and their measured falls spelled out in ``missing.what`` so no number is
    lost. Reporting „Absturzkante ohne Geländer" from such a file would be a
    finding about the export dressed as a finding about the building — and in
    this direction it is the finding that gets an applicant a redesign for a
    defect that is not there.

    Where the file DOES carry railings, each edge reports the ones standing
    within :data:`RAILING_REACH` of it and how high they rise above the floor
    on the inside. The parapet — the sill height over the inside floor — is
    measured either way, because a wall under a window is protection too.

    ## Two kinds of opening, two measurements — ``lage``

    A hole in a WALL and a hole in a FLOOR are both Absturzkanten and they are
    not the same geometry, so every entry says which it is:

    - ``lage`` „senkrecht" — the fall runs sideways past the opening, from the
      floor inside to the ground :data:`OUTSIDE_PROBE` in front of it, and
      ``parapet`` is the sill height over the inside floor.
    - ``lage`` „waagrecht" — a gallery void, a stairwell, any slab opening. The
      fall runs straight DOWN through it (:func:`_fall_through`) and ``parapet``
      is ``null``, because a hole in a floor has no Brüstung.

    Measuring the second as if it were the first is what this operator used to
    do, and on ``AC20-FZK-Haus``'s gallery void it produced „fall 0.000 m,
    parapet 2.500 m" at the one edge in the house where both of the model's
    railings stand — while the real drop from „Galerie" (floor z = 2.700) to
    „Wohnen" (floor z = 0.000) is 2.700 m. It now reads 2.700 m with both
    railings at 1.000 m over the gallery floor.

    A „waagrecht" entry with ``fall = null`` is not a failed measurement: it is
    a floor void that reaches this room's list without being an edge OF this
    room — because it sits in its ceiling, or because it is somewhere else in
    the same slab. ``outside.via`` says which, in numbers.

    ## What is scanned, and what is not

    Openings: windows, doors, and openings with no filler — which is how a
    balcony door hole reaches an export, and how a gallery void does, and the
    second is measured as the floor void it is. A free floor EDGE with no
    opening in it — the unwalled side of a loggia, the open side of a ramp, a
    gallery whose void was modelled by simply not drawing slab there — is
    **not** found by this and no answer here should be read as covering it. That
    gap is named in the caveat rather than left for the reader to discover.
    """
    method = (
        f"balustradeCheck({space_or_element_global_id})"
        if fall_height is None
        else f"balustradeCheck({space_or_element_global_id}, {fall_height})"
    )
    subject = _require(model, space_or_element_global_id, method)

    if fall_height is not None:
        if (
            isinstance(fall_height, bool)
            or not isinstance(fall_height, (int, float))
            or not math.isfinite(fall_height)
            or float(fall_height) <= 0
        ):
            return undecidable(
                from_=[space_or_element_global_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what="brauchbare Absturzhöhe (fallHeight > 0 m)",
                    remedy=(
                        "Ab welcher Fallhöhe eine Absturzsicherung verlangt ist, steht in der Bestimmung und "
                        "nicht im Modell — balustradeCheck() mit dem Wert der Klausel aufrufen, oder ohne "
                        "Höhe, dann werden alle gemessenen Höhenunterschiede ohne Bewertung gemeldet."
                    ),
                    elements=[space_or_element_global_id],
                ),
            )
        fall_height = float(fall_height)

    kind = model.kind_of(subject)
    if kind == "space":
        openings = _openings_at(model, subject)
        if isinstance(openings, Answer):
            return openings
    elif subject.is_a() in FENESTRATION:
        openings = [subject]
    else:
        _wrong_kind(
            subject,
            method,
            "balustradeCheck",
            "einen Raum (IfcSpace), ein Fenster, eine Tür oder eine Öffnung",
            "für eine Wand: hosts() liefert ihre Öffnungen, danach balustradeCheck() je Öffnung",
        )

    railings = _railings(model)
    results: list[dict[str, Any]] = []
    unmeasurable: list[str] = []
    for opening in openings:
        entry = _fall_at(model, opening, railings, subject if kind == "space" else None)
        if entry is None:
            unmeasurable.append(opening.GlobalId)
            continue
        results.append(entry)
    results.sort(key=lambda e: (-(e["fall"] if e["fall"] is not None else -1e9), e["globalId"]))

    edges = (
        []
        if fall_height is None
        else [e for e in results if e["fall"] is not None and e["fall"] > fall_height + DIMENSION_TOLERANCE]
    )

    if edges and not railings:
        listed = "; ".join(_edge_text(e) for e in edges)
        return undecidable(
            from_=[space_or_element_global_id, *[e["globalId"] for e in edges]],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=(
                    f"IfcRailing — diese Datei enthält kein einziges. Gemessen sind {len(edges)} Kante(n) mit "
                    f"einer Fallhöhe über {fall_height:.3f} m: {listed}. Was dort steht, ist offen."
                ),
                remedy=(
                    "Ob an diesen Kanten eine Absturzsicherung steht, ist aus diesem Export nicht zu "
                    "entnehmen: er enthält überhaupt kein IfcRailing. Das heißt NICHT, dass keine Geländer "
                    "geplant sind — Geländer fehlen in Architekturexporten regelmäßig, weil sie im "
                    "Metallbaumodell liegen oder erst in der Ausführungsplanung entstehen. Abhilfe: Geländer "
                    "als IfcRailing mitexportieren. Die gemessenen Fallhöhen und Brüstungshöhen oben gelten "
                    "unabhängig davon."
                ),
                elements=[e["globalId"] for e in edges],
            ),
        )

    payload = {
        "openings": results,
        "kanten": edges,
        "fallHeight": fall_height,
        "railingsInModel": len(railings),
    }

    caveat = (
        f"{_NOT_A_VERDICT} An einer SENKRECHTEN Öffnung (lage „senkrecht“: Fenster, Tür, Wandöffnung) ist "
        f"„fall“ der gemessene Höhenunterschied zwischen dem Fußboden innen und der Fläche "
        f"{OUTSIDE_PROBE:.2f} m vor der Öffnung, „parapet“ die Höhe der Öffnungsunterkante über dem Fußboden "
        "innen. An einer WAAGRECHTEN Öffnung (lage „waagrecht“: Deckendurchbruch, Galerieöffnung) ist „fall“ "
        "der Abstand vom Fußboden am Rand der Öffnung senkrecht hinab zur tiefsten von fünf Sondierungen "
        "durch die Öffnung, und „parapet“ ist null, weil eine Bodenöffnung keine Brüstung hat. Welche "
        "Fallhöhe eine Absturzsicherung verlangt und wie hoch sie sein muss, steht in der Bestimmung."
    )
    if fall_height is None:
        caveat += (
            " Ohne fallHeight ist keine Kante als Absturzkante ausgewiesen — die Grenze kommt aus der "
            "Bestimmung, deshalb sind hier nur die gemessenen Höhenunterschiede aufgeführt."
        )
    if not railings:
        caveat += (
            " Diese Datei enthält kein IfcRailing. Solange keine Kante die vorgegebene Fallhöhe überschreitet, "
            "ist das folgenlos; überschreitet eine, ist nicht bestimmbar, was dort steht."
        )
    caveat += (
        " Gesucht wird an ÖFFNUNGEN — Fenstern, Türen und ungefüllten Öffnungen. Eine freie Bodenkante ohne "
        "Öffnung (die offene Seite einer Loggia, ein Galeriedurchbruch ohne IfcOpeningElement) wird hier "
        "NICHT gefunden; diese Antwort ist keine Vollständigkeitsaussage über die Absturzkanten des Gebäudes."
    )
    if unmeasurable:
        caveat += (
            f" {len(unmeasurable)} Öffnung(en) ohne senkrechte Ebene oder ohne bestimmbares Niveau auf einer "
            "Seite sind nicht enthalten — die Liste ist insofern unvollständig."
        )
    without_fall = [e for e in results if e["fall"] is None]
    if without_fall:
        caveat += (
            f" {len(without_fall)} waagrechte Öffnung(en) sind mit fall = null aufgeführt: sie liegen in der "
            "DECKE dieses Raums oder überhaupt nicht an ihm — von hier aus führt durch sie kein Absturz. Der "
            "Grund steht je Öffnung unter outside.via; gemessen wird die Fallhöhe an dem Raum, dessen "
            "Fußboden an der Öffnung endet."
        )

    return computed(
        payload,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[space_or_element_global_id, *[e["globalId"] for e in results]],
        method=method,
        caveat=caveat,
    )


def _edge_text(edge: dict[str, Any]) -> str:
    """One edge, spelled out for ``missing.what``.

    The measurement does not disappear because the answer is undecidable: an
    ``undecidable`` carries no value by contract, so the falls and parapets that
    WERE measured are written into the German sentence the architect reads.
    Dropping them would turn a partial answer into no answer.
    """
    if edge["parapet"] is not None:
        parapet = f"Brüstungshöhe {edge['parapet']:.3f} m"
    elif edge.get("lage") == "waagrecht":
        parapet = "keine Brüstung (waagrechte Öffnung im Boden)"
    else:
        parapet = "Brüstungshöhe nicht messbar"
    return (
        f"{edge['ifcType']} „{edge['name'] or edge['globalId']}“ ({edge['globalId']}): "
        f"Fallhöhe {edge['fall']:.3f} m, {parapet}"
    )


def _openings_at(model: SpatialModel, space: Any) -> list[Any] | Answer[Any]:
    """Windows, doors and unfilled holes at this room.

    The filled ones come off ``bounds()``; the unfilled ones off the bounding
    walls' ``hosts()``, because an opening with no filler is a HOLE and a hole is
    the purest form of the edge this operator is looking for.
    """
    from .operators import bounds
    from .operators import hosts

    bounding = bounds(model, space.GlobalId)
    if not bounding.decidable:
        return bounding
    found: dict[str, Any] = {}
    for ref in bounding.value or []:
        if ref.ifc_type in FENESTRATION:
            found[ref.global_id] = model.file.by_guid(ref.global_id)
            continue
        holes = hosts(model, ref.global_id)
        if not holes.decidable or not holes.value:
            continue
        for hole in holes.value:
            opening = model.file.by_guid(hole.global_id)
            if getattr(opening, "HasFillings", None):
                continue
            found[hole.global_id] = opening
    return [found[key] for key in sorted(found)]


def _railings(model: SpatialModel) -> list[Any]:
    try:
        return [r for r in model.file.by_type("IfcRailing") if getattr(r, "GlobalId", None)]
    except RuntimeError:
        # A schema that has never heard of IfcRailing is not a file without
        # railings; both are handled the same way by the caller, which reports
        # the absence as undecidable rather than as an answer.
        return []


def _fall_at(model: SpatialModel, opening: Any, railings: list[Any], space: Any | None = None) -> dict[str, Any] | None:
    """One opening: the levels on both sides, the parapet, and what stands outside.

    ``space`` is the room the caller asked about, when it asked about a room. It
    is not used for a wall opening — the two sides speak for themselves — and it
    decides everything for a hole in a floor, which is a fall for the room ABOVE
    it and a hole in the ceiling for the room below. See :func:`_fall_through`.
    """
    frame = _frame_of(model, opening)
    if frame is None:
        return _fall_through(model, opening, railings, space)
    sides = _levels_both_sides(model, opening, frame)
    known = [s for s in sides if s["level"] is not None]
    if len(known) < 2:
        return None

    # "Inside" is the side with the room on it; with rooms on both sides the
    # higher floor is inside, because the fall is measured from where somebody
    # stands down to where they land.
    with_space = [s for s in sides if s["space"] is not None]
    if len(with_space) == 1:
        inside = with_space[0]
    else:
        inside = max(known, key=lambda s: float(s["level"]))
    outside = next(s for s in sides if s is not inside)
    if outside["level"] is None:
        return None

    fall = float(inside["level"]) - float(outside["level"])
    parapet = round(frame.z_min - float(inside["level"]), 4)
    sign = 1.0 if outside["direction"][0] * frame.normal[0] + outside["direction"][1] * frame.normal[1] > 0 else -1.0

    return {
        "globalId": opening.GlobalId,
        "name": model.label(opening),
        "ifcType": opening.is_a(),
        "fall": round(fall, 4),
        "parapet": parapet,
        "lage": "senkrecht",
        "inside": inside,
        "outside": outside,
        "railings": _railings_at(model, frame, sign, float(inside["level"]), railings),
    }


def _fall_through(model: SpatialModel, opening: Any, railings: list[Any], space: Any | None) -> dict[str, Any] | None:
    """A hole in a FLOOR: the fall goes down through it, not sideways past it.

    Reached when :func:`_frame_of` refused, and it measures only what
    :func:`_is_floor_void` recognises; anything else stays ``None`` and is
    reported as unmeasurable, which is what the caveat already says honestly.

    ## Which room the fall belongs to

    One void, two rooms, and the same 2.700 m means opposite things to them.
    ``AC20-FZK-Haus``'s gallery void reaches BOTH „Galerie" (floor at z = 2.700,
    the room you can fall out of) and „Wohnen" (floor at z = 0.000, the room you
    would land in) through ``bounds()`` → ``hosts()``, because one slab is both
    rooms' slab. So the fall is measured only for the room whose floor is AT the
    void, and the room below gets the same entry with ``fall = null`` and a
    ``via`` that says why. Reporting 2.700 m to „Wohnen" would invent an
    Absturzkante in a ceiling — a defect an applicant would be asked to redesign
    that is not there.

    With no room in the question (``balustradeCheck`` aimed straight at the
    opening) the walking level is the void's own top face, which is the same
    number wherever the slab was modelled from.

    ## …and whether it belongs to that room at all

    A slab bounds EVERY room on its storey, and ``hosts()`` hands back every
    void that slab carries, so `_openings_at` lists a stairwell void at rooms
    on the far side of the building. Measured on ``AC20-Institute-Var-2``: its
    two „Slab Opening" voids (18.30…23.70 × 11.70…15.70) are listed at all 82
    spaces, „Buero" ``3zaEFaiGrF1ftyFPQrOe_i`` among them — **13.370 m** away in
    plan. Left alone, this function would have handed that office a 2.591 m
    Absturzkante and 64 other rooms one with it.

    So the void's plan rectangle has to come within ``CONTACT`` of the room's
    own plan extent, which is the same tolerance that decided the slab bounds
    the room in the first place. On that file it keeps the two stairwell
    corridors („Flur 2.OG Treppe", „Flur 3.OG Treppe", gap 0.000 m) and drops
    the rooms across the wall („Dachboden-1" and „Dachboden-2", gap 0.300 m —
    the corridor wall). The test is against the room's bounding box, so a room
    bent round a corner can still claim a void sitting in the notch of its
    L; that is the same over-inclusion ``bounds()`` itself carries and it is
    bounded by the room's own extent rather than by the storey's.

    ## The two levels

    Top: the floor of the room at the void — measured, not the void's nominal
    top. Bottom: the deepest of :data:`_VOID_PROBES` rays cast down through the
    void, air and furniture excluded by :func:`_surface_below`, exactly as the
    wall case probes the ground outside. ``parapet`` is ``None`` and not zero: a
    hole in a floor has no Brüstung, and zero is a number an agent puts in a
    sentence.
    """
    geo = model.geometry(opening.GlobalId)
    if geo is None or len(geo.triangles) == 0:
        return None
    if not _is_floor_void(model, opening, geo):
        return None

    x_min, y_min, z_min = (float(v) for v in geo.box[0])
    x_max, y_max, z_max = (float(v) for v in geo.box[1])
    rect = (x_min, y_min, x_max, y_max)
    top, inside_space = z_max, None
    if space is not None:
        space_geo = model.geometry(space.GlobalId)
        if space_geo is None:
            return None
        floor = float(space_geo.box[0][2])
        reach = _plan_gap(rect, space_geo.box)
        if reach > CONTACT:
            return _void_away_from(model, opening, space, floor, reach)
        if floor < z_min - DIMENSION_TOLERANCE:
            return _void_overhead(model, opening, space, floor, (z_min, z_max))
        if floor > z_max + DIMENSION_TOLERANCE:
            return None
        top, inside_space = floor, space

    # Cast from the middle of the void's own thickness: below the floor it is cut
    # into, above whatever is beneath it, and inside the hole for every void
    # thicker than nothing.
    probe_z = (z_min + z_max) / 2.0
    deepest: tuple[float, Any] | None = None
    for fx, fy in _VOID_PROBES:
        found = _surface_below(model, x_min + fx * (x_max - x_min), y_min + fy * (y_max - y_min), probe_z)
        if found is not None and (deepest is None or found[0] < deepest[0]):
            deepest = found
    if deepest is None:
        return None
    level, hit = deepest

    return {
        "globalId": opening.GlobalId,
        "name": model.label(opening),
        "ifcType": opening.is_a(),
        "fall": round(top - level, 4),
        "parapet": None,
        "lage": "waagrecht",
        "inside": {
            "direction": [0.0, 0.0],
            "space": None if inside_space is None else inside_space.GlobalId,
            "spaceName": None if inside_space is None else model.label(inside_space),
            "level": round(top, 4),
            "via": (
                "Fußboden am Rand der waagrechten Öffnung (Unterkante des Raumkörpers)"
                if inside_space is not None
                else "Oberkante der waagrechten Öffnung (kein Raum in der Anfrage)"
            ),
            "surface": None,
        },
        "outside": {
            "direction": [0.0, 0.0],
            "space": None,
            "spaceName": None,
            "level": round(level, 4),
            "via": f"Strahl senkrecht nach unten durch die Öffnung, tiefster von {len(_VOID_PROBES)} Punkten",
            "surface": {
                "globalId": hit.GlobalId,
                "name": model.label(hit),
                "ifcType": hit.is_a(),
                "top": round(level, 4),
                "gap": None,
            },
        },
        "railings": _railings_at_void(model, (x_min, y_min, x_max, y_max), top, railings),
    }


def _plan_gap(rect: tuple[float, float, float, float], box: Any) -> float:
    """Shortest distance in plan between a rectangle and a body's bounding box.

    Zero when they overlap or touch, which is the case that matters: a gallery
    void lies AT the floor it interrupts, and „at" includes sharing an edge with
    it. One function so that the reach of a railing and the reach of a room are
    the same arithmetic.
    """
    gap_x = max(rect[0] - float(box[1][0]), float(box[0][0]) - rect[2], 0.0)
    gap_y = max(rect[1] - float(box[1][1]), float(box[0][1]) - rect[3], 0.0)
    return math.hypot(gap_x, gap_y)


def _void_away_from(model: SpatialModel, opening: Any, space: Any, floor: float, reach: float) -> dict[str, Any]:
    """A void in the same slab, but not at this room — the 13.370 m case.

    Listed with the distance rather than dropped, because it explains why an
    opening nobody at this room can reach is in this room's list at all: the
    slab it is cut into bounds the room, so ``hosts()`` hands it over.
    """
    return {
        "globalId": opening.GlobalId,
        "name": model.label(opening),
        "ifcType": opening.is_a(),
        "fall": None,
        "parapet": None,
        "lage": "waagrecht",
        "inside": {
            "direction": [0.0, 0.0],
            "space": space.GlobalId,
            "spaceName": model.label(space),
            "level": round(floor, 4),
            "via": "Unterkante des Raumkörpers (IfcSpace)",
            "surface": None,
        },
        "outside": {
            "direction": [0.0, 0.0],
            "space": None,
            "spaceName": None,
            "level": None,
            "via": (
                f"waagrechte Öffnung derselben Decke, aber {reach:.3f} m von diesem Raum entfernt (im "
                "Grundriss) — sie liegt nicht an seinem Fußboden und ist hier keine Fallhöhe; sie steht in "
                "dieser Liste, weil die Decke, in der sie sitzt, den Raum begrenzt"
            ),
            "surface": None,
        },
        "railings": [],
    }


def _void_overhead(
    model: SpatialModel, opening: Any, space: Any, floor: float, span: tuple[float, float]
) -> dict[str, Any]:
    """The same floor void, seen from the room UNDERNEATH it.

    Listed rather than dropped, and with ``fall = null`` rather than a number:
    the opening genuinely bounds this room, and saying so with the reason beats
    letting it vanish into a count of unmeasurable openings — but nobody falls
    upward through their own ceiling.
    """
    return {
        "globalId": opening.GlobalId,
        "name": model.label(opening),
        "ifcType": opening.is_a(),
        "fall": None,
        "parapet": None,
        "lage": "waagrecht",
        "inside": {
            "direction": [0.0, 0.0],
            "space": space.GlobalId,
            "spaceName": model.label(space),
            "level": round(floor, 4),
            "via": "Unterkante des Raumkörpers (IfcSpace)",
            "surface": None,
        },
        "outside": {
            "direction": [0.0, 0.0],
            "space": None,
            "spaceName": None,
            "level": None,
            "via": (
                f"waagrechte Öffnung in der DECKE dieses Raums (Öffnung von {span[0]:.3f} m bis "
                f"{span[1]:.3f} m, Fußboden dieses Raums bei {floor:.3f} m) — von hier aus führt sie nicht "
                "abwärts; die Fallhöhe ist am darüberliegenden Raum zu messen"
            ),
            "surface": None,
        },
        "railings": [],
    }


def _railings_at_void(
    model: SpatialModel, rect: tuple[float, float, float, float], top: float, railings: list[Any]
) -> list[dict[str, Any]]:
    """Railings standing at a floor void's perimeter, with their height over it.

    The plan test is the gap between two rectangles rather than a signed
    distance through a wall face: a floor void has no inside and outside, it has
    a perimeter, and a balustrade stands on it. Both of ``AC20-FZK-Haus``'s
    railings sit 0.030 m and 0.000 m from the gallery void's rectangle, well
    inside :data:`RAILING_REACH`.

    Two height tests keep the railing on the right storey, which is the whole
    risk of a purely-plan test in a building where every floor has the same
    plan: it must rise above the walking level, or it protects nothing here, and
    its foot must not stand more than :data:`RAILING_FOOT` above that level, or
    it is the balustrade of the storey above.
    """
    found = []
    for railing in railings:
        geo = model.geometry(railing.GlobalId)
        if geo is None:
            continue
        base, crest = float(geo.box[0][2]), float(geo.box[1][2])
        if crest <= top + COORDINATE_TOLERANCE or base > top + RAILING_FOOT:
            continue
        if _plan_gap(rect, geo.box) > RAILING_REACH:
            continue
        found.append(
            {
                "globalId": railing.GlobalId,
                "name": model.label(railing),
                "ifcType": railing.is_a(),
                "height": round(crest - top, 4),
                "top": round(crest, 4),
            }
        )
    found.sort(key=lambda r: (-r["height"], r["globalId"]))
    return found


def _railings_at(
    model: SpatialModel, frame: _Frame, sign: float, inside_level: float, railings: list[Any]
) -> list[dict[str, Any]]:
    """Railings standing at this edge, with their height over the inside floor.

    Tested in the opening's own frame rather than in model coordinates: a
    railing counts when it lies on the outside of the wall face, within
    :data:`RAILING_REACH` of it, and overlaps the opening laterally. Half a metre
    of lateral slack on each side, because a balustrade runs past the window it
    protects rather than stopping at its reveal.

    The through-wall test is done in a coordinate that increases OUTWARD —
    ``through × sign`` — so that the ``+`` and the ``−`` side are one piece of
    arithmetic instead of two mirrored ones. Mirrored comparisons are how a
    railing gets credited on the wrong side of a wall.
    """
    reference = frame.outer_face(sign) * sign
    found = []
    for railing in railings:
        geo = model.geometry(railing.GlobalId)
        if geo is None:
            continue
        points = geo.verts[:, :2]
        across = points @ frame.lateral
        outward = (points @ frame.normal) * sign
        if float(outward.min()) > reference + RAILING_REACH:
            continue  # entirely beyond reach of this edge
        if float(outward.max()) < reference - COORDINATE_TOLERANCE:
            continue  # entirely on the inside of the wall face
        if float(across.max()) < frame.u_min - 0.5 or float(across.min()) > frame.u_max + 0.5:
            continue
        found.append(
            {
                "globalId": railing.GlobalId,
                "name": model.label(railing),
                "ifcType": railing.is_a(),
                "height": round(float(geo.box[1][2]) - inside_level, 4),
                "top": round(float(geo.box[1][2]), 4),
            }
        )
    found.sort(key=lambda r: (-r["height"], r["globalId"]))
    return found


# ════════════════════════════════════════════════════════════════════════════
# 4 — clear approach
# ════════════════════════════════════════════════════════════════════════════


def clear_approach(model: SpatialModel, door_global_id: str) -> Answer[dict[str, Any]]:
    """The free floor in front of a door, on each side, and what ends it.

    A wheelchair user pulling a door open needs room to stand beside it, and
    ``clearOpeningWidth`` cannot see that: it measures the hole. This measures
    the floor. A strip as wide as the clear opening is pushed perpendicularly
    away from the door face into the room and the depth is the furthest it goes
    while staying entirely inside the free floor — the same free-floor polygon
    :func:`turning_circle` uses, so what counts as an obstacle is defined in one
    place and one way.

    Both sides are reported. A side with no ``IfcSpace`` — the outside of an
    external door — gets a null depth and a reason rather than a zero, because
    zero is a number an agent will put in a sentence.

    ``depth`` counts fixed obstruction only and ``withFurnishing`` repeats it
    with the loose furniture in, for the reason argued in :func:`_free_floor`.
    On this fixture the internal door `…VyWax` has 4.390 m into the bedroom and
    9.238 m into the living room with the rooms empty, and 2.383 m and 3.446 m
    once the bed and a chair are counted — the difference between a door you can
    open and a door you can open in a photograph.

    ``limitedBy`` names what the strip ran into. An empty ``limitedBy`` with
    ``boundedByRoom`` true means nothing stopped it but the far wall, which is
    the answer for a small room and not a failure.
    """
    method = f"clearApproach({door_global_id})"
    subject = _require(model, door_global_id, method)
    if subject.is_a() not in FENESTRATION:
        _wrong_kind(
            subject,
            method,
            "clearApproach",
            "eine Tür, ein Fenster oder eine Öffnung",
            "für die Bewegungsfläche eines ganzen Raums: turningCircle(); für das lichte Maß: clearOpeningWidth()",
        )

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]
    frame = _frame_of(model, subject)
    if frame is None:
        return _no_plane(model, subject, method)

    from .clearance import clear_opening_width

    aperture = clear_opening_width(model, door_global_id)
    if not aperture.decidable or not aperture.value:
        return undecidable(
            from_=[door_global_id],
            method=method,
            provenance="computed",
            missing=aperture.missing
            or MissingFact(
                what=f"die lichte Öffnungsbreite von {door_global_id}",
                remedy="Ohne lichte Breite ist die Breite des zu prüfenden Streifens unbestimmt.",
            ),
        )
    width = float(aperture.value["width"])

    spaces = _spaces_by_side(model, subject, frame)
    sides: list[dict[str, Any]] = []
    for sign in (1.0, -1.0):
        sides.append(_approach_on(model, subject, frame, sign, spaces.get(sign), width))

    caveat = (
        f"{_NOT_A_VERDICT} Gemessen ist die Tiefe eines {width:.3f} m breiten Streifens — der lichten "
        "Öffnungsbreite — senkrecht vor der Öffnung, bis er zum ersten Mal aus der freien Bodenfläche "
        f"herausragt. {aperture.value['via']} war die Grundlage der Breite. Der Hauptwert zählt nur FESTE "
        "Bauteile; „withFurnishing“ wiederholt ihn mit der losen Möblierung."
    )
    caveat += (
        " Nicht berücksichtigt ist der Schwenkbereich des Türblatts: es zählt in der Lage, in der es "
        "modelliert ist, und das ist in den meisten Exporten die geschlossene. Die seitliche Lage des "
        "Streifens ist die der Öffnung — ob daneben genug Platz zum Anfahren des Drückers ist, ist eine "
        "andere Frage als diese."
    )
    if any(s["space"] is None for s in sides):
        caveat += (
            " Auf mindestens einer Seite liegt kein IfcSpace: dort ist keine freie Bodenfläche definiert und "
            "die Tiefe bleibt offen (null, nicht 0). Abhilfe: den angrenzenden Raum als IfcSpace exportieren."
        )

    return computed(
        {"width": round(width, 4), "sides": sides},
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[door_global_id, *[s["space"] for s in sides if s["space"]]],
        method=method,
        caveat=caveat,
    )


def _approach_on(
    model: SpatialModel, element: Any, frame: _Frame, sign: float, space: Any | None, width: float
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "direction": [round(float(frame.normal[0] * sign), 4), round(float(frame.normal[1] * sign), 4)],
        "space": None,
        "spaceName": None,
        "depth": None,
        "limitedBy": [],
        "boundedByRoom": None,
        "withFurnishing": None,
        "because": "kein IfcSpace auf dieser Seite",
    }
    if space is None:
        return entry

    free = _free_floor(model, space, skip={element.GlobalId})
    if isinstance(free, Answer) or free is None:
        entry["because"] = "freie Bodenfläche dieses Raums nicht bestimmbar"
        return entry

    entry["space"] = space.GlobalId
    entry["spaceName"] = model.label(space)
    entry["because"] = None

    base = frame.outer_face(sign)
    reach = _reach_of(free.footprint) + OUTSIDE_PROBE
    fixed_depth = _strip_depth(frame, sign, base, width, free.fixed, reach)
    loose_depth = _strip_depth(frame, sign, base, width, free.furnished, reach)

    entry["depth"] = round(fixed_depth, 4)
    # What ENDED the strip: the room, or something standing in it. The test is
    # whether one step further leaves the room's own FOOTPRINT — not whether the
    # bisection ran out of bracket, which it never does because the bracket is
    # the room's diagonal. Told apart because "4.39 m and then the far wall" and
    # "4.39 m and then a wardrobe" are different findings for the architect.
    beyond = _strip(frame, sign, base, width, fixed_depth + 0.01)
    entry["boundedByRoom"] = bool(beyond.difference(free.footprint).area > MIN_OBSTACLE_AREA)
    entry["limitedBy"] = _limiting(model, frame, sign, base, width, fixed_depth, free, loose=False)
    entry["withFurnishing"] = {
        "depth": round(loose_depth, 4),
        "limitedBy": _limiting(model, frame, sign, base, width, loose_depth, free, loose=True),
    }
    return entry


def _reach_of(polygon: Any) -> float:
    min_x, min_y, max_x, max_y = polygon.bounds
    return float(math.hypot(max_x - min_x, max_y - min_y))


def _strip(frame: _Frame, sign: float, base: float, width: float, depth: float) -> Any:
    import shapely

    half = width / 2.0
    a = frame.point(frame.u_centre - half, base)
    b = frame.point(frame.u_centre + half, base)
    c = frame.point(frame.u_centre + half, base + sign * depth)
    d = frame.point(frame.u_centre - half, base + sign * depth)
    return shapely.Polygon([tuple(a), tuple(b), tuple(c), tuple(d)])


def _strip_depth(frame: _Frame, sign: float, base: float, width: float, free: Any, reach: float) -> float:
    """How far the strip goes before it leaves the free floor. Bisection, same as the circle."""
    if free is None or free.is_empty:
        return 0.0
    low, high = 0.0, reach
    for _ in range(INSCRIBED_STEPS):
        mid = (low + high) / 2.0
        try:
            outside = _strip(frame, sign, base, width, mid).difference(free).area
        except Exception:
            outside = 1.0
        if outside <= MIN_OBSTACLE_AREA:
            low = mid
        else:
            high = mid
    return low


def _limiting(
    model: SpatialModel,
    frame: _Frame,
    sign: float,
    base: float,
    width: float,
    depth: float,
    free: _FreeFloor,
    *,
    loose: bool,
) -> list[dict[str, Any]]:
    """What the strip would run into just past where it stopped.

    Probed a handspan beyond the measured depth rather than exactly at it: at the
    limit itself the strip only TOUCHES the obstacle, and a touching intersection
    has zero area and names nothing. 0.10 m past it is enough to overlap whatever
    stopped it and short enough not to collect the next thing along.
    """
    probe = _strip(frame, sign, base, width, depth + 0.10)
    found = []
    for obstacle in free.obstacles:
        if not loose and obstacle["zaehlt"] == "möbliert":
            continue
        geo = model.geometry(obstacle["globalId"])
        if geo is None:
            continue
        silhouette = _plan_silhouette(geo.triangles)
        if silhouette is None:
            continue
        try:
            overlap = float(silhouette.intersection(probe).area)
        except Exception:
            continue
        if overlap <= MIN_OBSTACLE_AREA:
            continue
        found.append({**obstacle, "overlap": round(overlap, 4)})
    found.sort(key=lambda o: (-o["overlap"], o["globalId"]))
    return found


__all__ = [
    "balustrade_check",
    "clear_approach",
    "threshold_height",
    "turning_circle",
]
