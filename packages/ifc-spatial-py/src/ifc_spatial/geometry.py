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

import numpy as np

#: |dot| above which two unit normals count as parallel (≈ 10°).
PARALLEL_DOT = 0.985
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
    normal: np.ndarray
    point: np.ndarray
    area: float


def triangle_normals_areas(triangles: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Unit normals and areas of an (F, 3, 3) triangle array."""
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    doubled = np.linalg.norm(cross, axis=1)
    ok = doubled > 1e-12
    normals = np.zeros_like(cross)
    normals[ok] = cross[ok] / doubled[ok, None]
    return normals, doubled / 2.0


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
        area=float(winner["area"]),
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


__all__ = [
    "Plane",
    "box_corners",
    "box_gap",
    "boxes_overlap",
    "clip_polygon",
    "dominant_vertical_plane",
    "outermost_parallel_face",
    "signed_distance",
    "triangle_normals_areas",
]
