"""Plane, clip and box helpers — the parts of the TS geometry pass that survive.

IfcOpenShell replaces most of `pass.ts`: bounding boxes, areas, footprints and
volumes are one call each on `ifcopenshell.util.shape`. What it does **not**
supply is the reference plane an architect means by "die Fassade", and the
constructive operators are all measured from that plane. So three things stay
hand-written, and they are ported here rather than re-invented:

1. :func:`dominant_vertical_plane` — the element's largest vertical planar
   cluster, which is the glazing plane of a window and the face of a wall.
2. :func:`outermost_parallel_face` — the plane re-seated onto a REAL outermost
   face. The TS package learnt this the hard way: binning faces by normal alone
   put the sample house's north facade at y = 4.4221, which lies on no surface of
   the building (a blend of faces at 4.409 and 4.521), and every overhang
   measured from it was 0.28 m too large.
3. :func:`clip_polygon` — Sutherland–Hodgman against the light prism's convex
   half-spaces. A vertex-inside test would miss this file entirely: the roof is
   376 triangles over 108 m², and a triangle spanning the whole prism can have
   every corner outside it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

#: |dot| above which two unit normals count as parallel (≈ 10°).
PARALLEL_DOT = 0.985

#: |n_z| above which a face counts as horizontal for `plan_footprint` (≈ 25°).
#:
#: Deliberately loose. A room floor is flat, but a triangulated one picks up
#: a degree or two of noise, and a threshold tight enough to be "horizontal"
#: in the strict sense drops facets the footprint needs — leaving a polygon
#: with holes in it, which reads as a room a grid point can fall outside of.
HORIZONTAL_DOT = 0.9
#: A parallel face smaller than this fraction of the largest one is a sliver.
FACE_AREA_FRACTION = 0.05
#: Absolute floor under the sliver test, m² — keeps tiny elements usable.
MIN_FACE_AREA = 0.01
#: Offsets closer than this along the normal are the same face, metres.
FACE_MERGE = 0.01
#: |normal.z| below which a face counts as vertical.
VERTICAL_TOLERANCE = 0.05


@dataclass(frozen=True)
class Plane:
    """A seated reference plane: where it sits, which way it looks, how strongly.

    ``support`` is **not a face area** and is deliberately not called one. It is
    the summed area of every triangle that voted this bin into the seating, and
    the sum double-counts: coincident and overlapping triangles are added
    together, and both facings of a surface land in the same bin because the
    winding is unreliable. On the sample house's south wall
    ``3cUkl32yn9qRSPvBJVyWy4`` it comes to **23.527 m²** over 30 triangles, while
    the union of those same triangles projected onto the plane — the real outer
    face — is **17.776 m²**. Published as an area, that is a 32 % overstatement
    of a facade, in a package whose whole point is that a number an architect
    signs must be right.

    It is kept because the seating needs it: the winner is chosen by offset among
    the bins that clear a fraction of the largest bin's vote, and that comparison
    is between like and like. It is a **selection weight**, and the name now says
    so, so that no caller can read it as a surface. ``facade_plane_of`` used to
    publish it as ``"area"`` under „(m)"; it does not any more.
    """

    normal: np.ndarray
    point: np.ndarray
    #: Summed triangle area of the winning bin, in m² — a vote weight for
    #: choosing the plane, never the area of the face. See the class docstring.
    support: float


def triangle_normals_areas(triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Unit normals and areas of an (F, 3, 3) triangle array."""
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    doubled = np.linalg.norm(cross, axis=1)
    ok = doubled > 1e-12
    normals = np.zeros_like(cross)
    normals[ok] = cross[ok] / doubled[ok, None]
    return normals, doubled / 2.0


def dominant_plane(triangles: np.ndarray) -> np.ndarray | None:
    """The unit normal of the element's largest planar cluster, any orientation.

    :func:`dominant_vertical_plane` throws the horizontal faces away BEFORE it
    looks for the winner, so it answers "which vertical face is biggest" even on
    a body that is overwhelmingly flat. This answers the prior question — what
    plane is this element mostly made of — and it is what tells a wall from a
    slab.

    The failure it exists to catch: ``azimuth`` on the sample house's ground slab
    ``3cUkl32yn9qRSPvBJVyWgQ``. The slab's 7.9 m² of vertical EDGE faces were the
    only ones the vertical filter kept, so a floor plate reported a compass
    bearing of 0.0° / „N" off its own rim. Its dominant plane is horizontal
    (``|n_z| = 1``) by two orders of magnitude of area, and a floor plate has no
    facade bearing to report.

    ``None`` for a mesh with no non-degenerate triangle.
    """
    normals, areas = triangle_normals_areas(triangles)
    # Gated on the NORMAL, not on `areas > 0`. `triangle_normals_areas` zeroes a
    # normal at |cross| <= 1e-12 and still reports area = |cross| / 2, so a
    # triangle in the band 0 < |cross| <= 1e-12 passes an area filter carrying no
    # direction at all: it folds to the sign fallback 1.0, lands in the (0, 0, 0)
    # bin and votes with a zero vector. For a mesh whose triangles are ALL in that
    # band this returned array([0., 0., 0.]) instead of None, and `azimuth` reads
    # |n_z| = 0.0 as vertical — a compass bearing off a body with no measurable
    # face, which is the exact failure this function was added to prevent.
    # No triangle in any fixture is anywhere near the band (the sample house's
    # smallest of 25 312 has |cross| = 2.6e-07, five orders above it), so this
    # moves no measured number; it closes the door.
    usable = np.linalg.norm(normals, axis=1) > 0
    if not usable.any():
        return None
    normals = normals[usable]
    areas = areas[usable]

    # ±n folded together and binned at ~3°, as in `dominant_vertical_plane` — a
    # mesh's winding is not a statement about which side is outside, so the top
    # and bottom faces of a slab have to land in ONE bin or neither wins.
    # The sign is taken from the first component that is not numerically zero,
    # in the order z, x, y. A fixed reference direction would be unstable for
    # normals nearly orthogonal to it, and this rule is exact for every normal.
    sign = np.zeros(len(normals))
    for axis in (2, 0, 1):
        undecided = sign == 0
        sign = np.where(undecided & (np.abs(normals[:, axis]) > 1e-9), np.sign(normals[:, axis]), sign)
    sign[sign == 0] = 1.0
    folded = normals * sign[:, None]
    keys = np.round(folded / 0.05).astype(np.int64)

    best_area = -1.0
    best: np.ndarray | None = None
    for key in np.unique(keys, axis=0):
        member = (keys == key).all(axis=1)
        area = float(areas[member].sum())
        if area > best_area:
            best_area = area
            mean = (folded[member] * areas[member, None]).sum(axis=0)
            norm = np.linalg.norm(mean)
            best = mean / norm if norm > 1e-12 else folded[member][0]
    return best


def dominant_vertical_plane(triangles: np.ndarray) -> np.ndarray | None:
    """The unit normal of the element's largest vertical planar cluster.

    Vertical faces are binned by their quantised normal — both facings folded
    together, because the winding of an exported mesh is not a reliable statement
    about which side is outside — and the bin with the greatest total AREA wins.
    Area rather than triangle count: a finely tessellated sliver must not
    outvote a 26 m² wall face.

    ``None`` when the element has no vertical surface at all (a slab, a flat
    roof). That is undecidable, not zero: a floor plate has no bearing.
    """
    normals, areas = triangle_normals_areas(triangles)
    vertical = np.abs(normals[:, 2]) < VERTICAL_TOLERANCE
    if not vertical.any():
        return None
    normals = normals[vertical]
    areas = areas[vertical]

    # Fold ±n together by forcing a canonical sign, then bin at ~3°.
    flip = (normals[:, 0] < 0) | ((np.abs(normals[:, 0]) < 1e-9) & (normals[:, 1] < 0))
    folded = np.where(flip[:, None], -normals, normals)
    keys = np.round(folded[:, :2] / 0.05).astype(np.int64)

    best_area = -1.0
    best: np.ndarray | None = None
    for key in np.unique(keys, axis=0):
        member = (keys == key).all(axis=1)
        area = float(areas[member].sum())
        if area > best_area:
            best_area = area
            # Area-weighted mean direction of the bin, re-normalised.
            mean = (folded[member] * areas[member, None]).sum(axis=0)
            mean[2] = 0.0
            norm = np.linalg.norm(mean)
            best = mean / norm if norm > 1e-12 else folded[member][0]
    return best


def outermost_parallel_face(triangles: np.ndarray, normal: np.ndarray) -> Plane | None:
    """The outermost face of an element parallel to ``normal``.

    Triangles are binned by offset along the normal (both facings, since the
    winding is unreliable), near-equal offsets are merged, slivers are dropped,
    and the surviving bin with the greatest offset wins. That is the wall's outer
    leaf, the opening's outer face, the roof's fascia — the surface an architect
    points at, rather than the area-weighted average of every parallel face.

    Slivers cannot win the seating: a face carries the plane only if it holds at
    least :data:`FACE_AREA_FRACTION` of the largest parallel face's area, so a
    3 cm chamfer or a reveal return does not move the facade 3 cm outward.

    The returned :class:`Plane` carries ``support``, not an area. What this
    function measures per bin is a sum of triangle areas, and a sum is the wrong
    operation for an area whenever two triangles overlap — read its docstring
    before publishing that number anywhere.
    """
    normals, areas = triangle_normals_areas(triangles)
    parallel = np.abs(normals @ normal) >= PARALLEL_DOT
    if not parallel.any():
        return None
    tris = triangles[parallel]
    areas = areas[parallel]
    offsets = tris[:, 0] @ normal
    centroids = tris.mean(axis=1)

    bins: list[dict[str, float | np.ndarray]] = []
    for offset, area, centroid in zip(offsets, areas, centroids):
        placed = False
        for b in bins:
            if abs(float(b["offset"]) - float(offset)) <= FACE_MERGE:
                # Area-weighted so the merged offset tracks the dominant face
                # rather than drifting toward whichever sliver was within range.
                total = float(b["area"]) + float(area)
                b["offset"] = (float(b["offset"]) * float(b["area"]) + float(offset) * float(area)) / total
                b["sum"] = b["sum"] + centroid * float(area)  # type: ignore[operator]
                b["area"] = total
                placed = True
                break
        if not placed:
            bins.append({"offset": float(offset), "area": float(area), "sum": centroid * float(area)})

    largest = max(float(b["area"]) for b in bins)
    floor = max(largest * FACE_AREA_FRACTION, MIN_FACE_AREA)
    usable = [b for b in bins if float(b["area"]) >= floor]
    if not usable:
        return None
    winner = max(usable, key=lambda b: float(b["offset"]))
    return Plane(
        normal=normal,
        point=np.asarray(winner["sum"]) / float(winner["area"]),
        support=float(winner["area"]),
    )


def signed_distance(points: np.ndarray, plane_normal: np.ndarray, plane_point: np.ndarray) -> np.ndarray:
    """How far each point lies in front of the plane. Negative is behind."""
    return (np.atleast_2d(points) - plane_point) @ plane_normal


def clip_polygon(polygon: Sequence[np.ndarray], normal: np.ndarray, point: np.ndarray) -> list[np.ndarray]:
    """Sutherland–Hodgman: keep the part of ``polygon`` with ``dot(x−p, n) ≥ 0``.

    The prism is convex, so clipping successively against its four half-spaces is
    exact — the result is the true intersection polygon, not an approximation of
    it.
    """
    out: list[np.ndarray] = []
    n = len(polygon)
    if n == 0:
        return out
    for i in range(n):
        current = polygon[i]
        previous = polygon[i - 1]
        d_current = float((current - point) @ normal)
        d_previous = float((previous - point) @ normal)
        if d_current >= 0:
            if d_previous < 0:
                t = d_previous / (d_previous - d_current)
                out.append(previous + (current - previous) * t)
            out.append(current)
        elif d_previous >= 0:
            t = d_previous / (d_previous - d_current)
            out.append(previous + (current - previous) * t)
    return out


def box_gap(a: tuple[np.ndarray, np.ndarray], b: tuple[np.ndarray, np.ndarray]) -> np.ndarray:
    """Per-axis separation of two boxes; negative where they already overlap."""
    return np.maximum(a[0] - b[1], b[0] - a[1])


def boxes_overlap(a: tuple[np.ndarray, np.ndarray], b: tuple[np.ndarray, np.ndarray]) -> bool:
    return bool((box_gap(a, b) < 0).all())


def box_corners(box: tuple[np.ndarray, np.ndarray]) -> np.ndarray:
    low, high = box
    return np.array(
        [
            [low[0], low[1], low[2]],
            [high[0], low[1], low[2]],
            [low[0], high[1], low[2]],
            [high[0], high[1], low[2]],
            [low[0], low[1], high[2]],
            [high[0], low[1], high[2]],
            [low[0], high[1], high[2]],
            [high[0], high[1], high[2]],
        ]
    )


def plan_footprint(triangles: np.ndarray) -> Any | None:
    """The element's outline in plan, as a shapely polygon — or ``None``.

    Answers „is this (x, y) inside the room" WITHOUT asking OCCT to classify a
    point against a solid, which is the whole reason this exists.

    ``geom.tree.select(point)`` needs a closed, orientable solid to classify
    against. ArchiCAD writes its `IfcSpace` bodies as `Brep` shells that OCCT
    accepts into the tree — `select_box` finds them — and will not classify as
    solids, so the point query returns nothing for every room in the file. On
    `AC20-Institute-Var-2.ifc` that was **82 of 82 spaces**, and `clear_height`
    answered „kein Rasterpunkt lag im Raumkörper" about an 11.6 × 11.4 m
    seminar room. The operator then blamed the room's shape („zu schmal oder zu
    zerklüftet"), the agent fell back to the declared storey height, and a
    structural 3.00 m was reported where the modelled room is 2.70 m.

    A mesh needs no such classification. The triangles are already in world
    coordinates and they already build for these rooms — 82 of 82 — so the
    footprint is the union of the DOWNWARD-facing ones, which for a prismatic
    room is exactly its floor. Downward-facing rather than all of them because
    the silhouette of a mesh with sloped soffits is larger than its floor, and
    because it halves the union.

    ``None`` when the mesh has no usable horizontal face, so the caller can keep
    whatever it did before rather than treat an empty polygon as an empty room.
    """
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    if triangles.size == 0:
        return None
    normals, areas = triangle_normals_areas(triangles)
    # Downward-facing and non-degenerate. The normal gate rather than `areas > 0`
    # for the reason `dominant_plane` documents: a zeroed normal still reports an
    # area, and it would vote here as a horizontal face pointing nowhere.
    usable = (np.linalg.norm(normals, axis=1) > 0) & (normals[:, 2] < -HORIZONTAL_DOT) & (areas > 1e-9)
    if not usable.any():
        # A room whose floor was not modelled as a distinct facet still has a
        # silhouette, and a silhouette is a better answer than refusing.
        usable = (np.linalg.norm(normals, axis=1) > 0) & (areas > 1e-9)
        if not usable.any():
            return None

    polygons = []
    for tri in triangles[usable]:
        polygon = Polygon(tri[:, :2])
        if polygon.is_valid and polygon.area > 1e-9:
            polygons.append(polygon)
    if not polygons:
        return None
    merged = unary_union(polygons)
    return merged if not merged.is_empty else None


__all__ = [
    "Plane",
    "box_corners",
    "box_gap",
    "boxes_overlap",
    "clip_polygon",
    "dominant_plane",
    "dominant_vertical_plane",
    "outermost_parallel_face",
    "plan_footprint",
    "signed_distance",
    "triangle_normals_areas",
]
