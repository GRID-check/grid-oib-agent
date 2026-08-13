"""True clearances and oriented extents — the dimensions ``distance`` and ``extent`` cannot give.

Three operators, all of them answers to the same defect: the metric operators in
:mod:`~ifc_spatial.operators` measure **boxes and centroids**, and an architect
asking for a *lichte Breite* is asking about **surfaces**.

## The defect, with the numbers that name it

``distance(a, b, 'min')`` is the gap between two axis-aligned bounding BOXES, and
``distance(a, b, 'horizontal')`` is the distance between two area-weighted mesh
CENTROIDS — an Achsabstand. On a 1.00 m doorway between two 30 cm walls the
centroid route returns **1.30 m**: too large by half of each wall, in the
direction that turns a failed escape-route width into a passing one. Measured in
this repository's own sample house, the same shape of error appears between the
bedroom and the living room, which are separated by one 95 mm partition:
``distance(…, 'horizontal')`` reports **7.082 m** (centre of one room to centre
of the other) and :func:`clear_width` reports **0.095 m**, the partition itself.
Both numbers are correctly computed; only one of them is a clearance.

``extent()`` has the mirror-image problem: its box is axis-aligned to the MODEL.
For the sample house's two skewed chairs (type ``1120x940x350mm``, set at 37° and
55° in plan) the axis-aligned footprint measures 1.428 × 1.400 m — an area of
2.00 m² against the true 1.09 m², **84 % too large** — while
:func:`oriented_extent` returns 1.116 × 0.973 m, which is the chair.

## What this module refuses to do

Nothing here judges. A clear width is measured and handed over with its
tolerance, the pair of points it was measured between, and a caveat naming what
kind of clearance it is (Rohbaulichte, not lichte Durchgangsbreite). Whether
0.810 m is enough is a question about a Bestimmung, and the Bestimmung answers
it.
"""

from __future__ import annotations

import math
import time
from typing import Any

import numpy as np

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .geometry import box_gap
from .geometry import dominant_vertical_plane
from .geometry import triangle_normals_areas
from .model import AIR_TYPES
from .model import ElementGeometry
from .model import SpatialModel
from .operators import DIMENSION_TOLERANCE
from .operators import FENESTRATION
from .operators import _geometry_or_answer
from .operators import _require
from .operators import _wrong_kind

# ── budgets ─────────────────────────────────────────────────────────────────
#
# Not tolerances — the tolerances are `operators.DIMENSION_TOLERANCE` and
# `operators.TESSELLATION_TOLERANCE` and are reused as they stand. These bound
# COST, in the same spirit as `model.CONTACT_BUDGET_SECONDS`: a refusal that
# names its reason is an answer, and a request that never returns is not.

#: Above this product of triangle counts, :func:`clear_width` refuses before it
#: starts rather than after it has run.
#:
#: The pre-filter is a per-triangle box test, so the work is bounded by
#: ``len(A) × len(B)`` box comparisons however well the pruning goes. Measured on
#: the sample house: the worst pair of real elements in it is chair against chair
#: at 3 618 × 3 618 ≈ 13.1 M, and that pair costs under 0.05 s. The limit sits two
#: orders of magnitude above it, which is roughly 40 000 × 40 000 — around a
#: second of pure box arithmetic before a single exact triangle test — because
#: past that point the honest answer is that this operator is the wrong tool and
#: a BVH is the right one.
CLEARANCE_MAX_TRIANGLE_PAIRS = 1_600_000_000

#: Seconds one :func:`clear_width` may spend in the pruning loop.
#:
#: The admission test above bounds the box arithmetic but not the exact
#: triangle-pair tests, and those are unbounded in the SHAPE of the two meshes:
#: two long, finely tessellated, nearly parallel surfaces keep every candidate
#: alive because every one of them really is near-minimal. The budget is
#: checkable here — unlike the OCCT offsets in ``model.space_contacts``, this
#: loop is Python and regains control between triangles — so it is checked, and
#: an overrun becomes an undecidable that names the elapsed time.
CLEARANCE_BUDGET_SECONDS = 20.0

#: Degrees below which an oriented box and the axis-aligned box are the same box.
#:
#: Measured, not assumed: every wall, window and door of the sample house comes
#: out of the rotating-caliper search at |angle| < 1e-13 °, because their hull
#: edges really are on the model axes. So anything above floating-point noise is
#: a real skew — the threshold is set at half a degree, which over a 14.1 m wall
#: (the sample house's north wall) is 12 cm of end deviation, enough to be a
#: modelling fact rather than a rounding artefact.
AXIS_ALIGNED_DEGREES = 0.5

#: Below this, a triangle has no area and is dropped before any distance test.
#: Degenerate triangles are common in exported meshes and they poison the
#: closest-point arithmetic (the barycentric denominator goes to zero) while
#: contributing no surface.
_MIN_TRIANGLE_AREA = 1e-12

# ════════════════════════════════════════════════════════════════════════════
# triangle-soup minimum distance — the primitive `geom.tree.clash_*` does not
# supply on this wheel
# ════════════════════════════════════════════════════════════════════════════
#
# §7 of the design doc maps a true clearance onto
# `geom.tree.clash_clearance_many`. It returns an EMPTY TUPLE for every input on
# the shipped 0.8.5 wheel and does not raise — verified again here, not taken on
# trust: `clash_collision_many`, `clash_clearance_many` and
# `clash_intersection_many` all return `()` for the sample house's bedroom
# against its living room, two spaces 95 mm apart, at any clearance. The cause is
# visible in the wrapper: the module has no `has_occ` symbol at all, i.e. this
# build carries no OCCT clash kernel. A primitive that answers "keine Kollision"
# by failing silently is the single most dangerous thing this library could be
# built on, so the distance is computed from the triangulations instead.


def _closest_on_triangles(points: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """Closest point on each triangle to each point — Ericson, vectorised.

    ``points`` is (n, 3) and ``tris`` is (n, 3, 3); both may be broadcast views,
    which is how one point is tested against many triangles and vice versa.

    The seven Voronoi regions of a triangle (three vertices, three edges, the
    interior) are evaluated as masks rather than branches, applied in REVERSE
    priority so that the higher-priority region overwrites: interior, BC, CA, C,
    AB, B, A. Getting that order wrong is silent — it produces a point on the
    triangle, just not the nearest one — which is why it is spelled out.
    """
    a, b, c = tris[..., 0, :], tris[..., 1, :], tris[..., 2, :]
    ab, ac = b - a, c - a
    d1 = ((points - a) * ab).sum(-1)
    d2 = ((points - a) * ac).sum(-1)
    d3 = ((points - b) * ab).sum(-1)
    d4 = ((points - b) * ac).sum(-1)
    d5 = ((points - c) * ab).sum(-1)
    d6 = ((points - c) * ac).sum(-1)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2

    def _ratio(numerator: np.ndarray, denominator: np.ndarray) -> np.ndarray:
        safe = np.where(np.abs(denominator) < 1e-30, 1.0, denominator)
        return np.clip(numerator / safe, 0.0, 1.0)[..., None]

    out = a + ab * _ratio(vb, va + vb + vc) + ac * _ratio(vc, va + vb + vc)
    edge_bc = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
    out = np.where(edge_bc[..., None], b + (c - b) * _ratio(d4 - d3, (d4 - d3) + (d5 - d6)), out)
    edge_ca = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    out = np.where(edge_ca[..., None], a + ac * _ratio(d2, d2 - d6), out)
    out = np.where(((d6 >= 0) & (d5 <= d6))[..., None], c, out)
    edge_ab = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    out = np.where(edge_ab[..., None], a + ab * _ratio(d1, d1 - d3), out)
    out = np.where(((d3 >= 0) & (d4 <= d3))[..., None], b, out)
    return np.where(((d1 <= 0) & (d2 <= 0))[..., None], a, out)


def _closest_between_segments(
    p1: np.ndarray, q1: np.ndarray, p2: np.ndarray, q2: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """The closest pair of points on two segments — Ericson, vectorised.

    Needed because vertex-to-surface tests alone are not a distance between
    solids: two crossing edges (a beam over a rail, the two reveals of a doorway
    seen in plan) realise their minimum in the interior of both edges, where no
    vertex of either is involved.
    """
    d1, d2, r = q1 - p1, q2 - p2, p1 - p2
    a = (d1 * d1).sum(-1)
    e = (d2 * d2).sum(-1)
    f = (d2 * r).sum(-1)
    c = (d1 * r).sum(-1)
    b = (d1 * d2).sum(-1)
    a_safe = np.where(a < 1e-30, 1.0, a)
    e_safe = np.where(e < 1e-30, 1.0, e)
    denominator = a * e - b * b
    den_safe = np.where(np.abs(denominator) < 1e-30, 1.0, denominator)

    s = np.where(np.abs(denominator) < 1e-30, 0.0, np.clip((b * f - c * e) / den_safe, 0.0, 1.0))
    t = (b * s + f) / e_safe
    # Ericson clamps t into [0, 1] and then re-solves s for the clamped t. Doing
    # it the other way round returns a point pair that is on the segments but not
    # the nearest one, and the error is small enough to look plausible.
    s = np.where(t < 0.0, np.clip(-c / a_safe, 0.0, 1.0), s)
    s = np.where(t > 1.0, np.clip((b - c) / a_safe, 0.0, 1.0), s)
    t = np.clip(t, 0.0, 1.0)
    # A degenerate first segment (a zero-length edge) has no parameter to solve
    # for; the whole distance is then point-to-segment.
    degenerate = a < 1e-30
    s = np.where(degenerate, 0.0, s)
    t = np.where(degenerate, np.clip(f / e_safe, 0.0, 1.0), t)
    return p1 + d1 * s[..., None], p2 + d2 * t[..., None]


def _segments_hit_triangles(p: np.ndarray, q: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """Möller–Trumbore: which segments p→q pass through their triangle.

    All three arguments broadcast against each other — (n, 3), (n, 3), (n, 3, 3)
    — so one call covers a triangle's three edges against many triangles and the
    reverse.

    Without this the pair distance is wrong for INTERSECTING solids, and wrong in
    the dangerous direction. Two triangles crossing in an X have no vertex inside
    the other and no pair of edges that meet: all fifteen vertex/edge tests come
    back with a positive number, and a clearance of several centimetres gets
    reported between two bodies that pass straight through each other. A segment
    that crosses a triangle is a distance of exactly zero.

    Coplanar (parallel) overlaps need no special case here: a coplanar pair that
    overlaps always has either a vertex inside the other triangle or a pair of
    crossing edges, and the fifteen tests already return zero for both.
    """
    edge1 = tris[..., 1, :] - tris[..., 0, :]
    edge2 = tris[..., 2, :] - tris[..., 0, :]
    direction = q - p
    h = np.cross(direction, edge2)
    determinant = (edge1 * h).sum(-1)
    parallel = np.abs(determinant) < 1e-14
    inverse = 1.0 / np.where(parallel, 1.0, determinant)
    s = p - tris[..., 0, :]
    u = inverse * (s * h).sum(-1)
    qv = np.cross(s, edge1)
    v = inverse * (direction * qv).sum(-1)
    t = inverse * (edge2 * qv).sum(-1)
    return ~parallel & (u >= 0.0) & (v >= 0.0) & (u + v <= 1.0) & (t >= 0.0) & (t <= 1.0)


#: The 3 × 3 edge pairing of two triangles, as index arrays — 9 combinations run
#: as one batch rather than as nine calls. See :func:`_triangle_distances`.
_EDGE_A = np.repeat([0, 1, 2], 3)
_EDGE_B = np.tile([0, 1, 2], 3)


def _triangle_distances(tri: np.ndarray, tris: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Exact distance from one triangle to many, with the witness points.

    Fifteen tests, which together are the triangle-triangle distance, plus six
    crossing tests:

      - 9 edge-edge closest pairs,
      - 3 vertices of ``tri`` against each of ``tris`` and 3 the other way,
      - 6 segment-through-triangle tests, the only thing that catches a proper
        crossing (see :func:`_segments_hit_triangles`).

    ## Why all fifteen are one batch

    Because this is called once per surviving candidate block and the arrays are
    SMALL — a few dozen triangles — the cost is NumPy call overhead, not
    arithmetic. Written as fifteen separate calls (the obvious way, and how this
    started) one invocation costs 3.0 ms on 41 candidates and the sample house's
    worst pair — the sliding door against a chair — took **3.09 s**. Stacked into
    three batched calls over 9k, 3k and 3k rows it costs 1.36 ms and the same pair
    takes **1.44 s**. Identical arithmetic, identical answer to the last bit, less
    than half the Python.

    Returns ``(distance, point_on_tri, point_on_tris)`` — the witnesses travel
    with the number because a clearance nobody can point at cannot be checked
    against a drawing.
    """
    count = len(tris)
    rows = np.arange(count)

    # 9 edge-edge pairs, laid out as (9, count, …) and flattened.
    p1 = np.broadcast_to(tri[_EDGE_A][:, None, :], (9, count, 3)).reshape(-1, 3)
    q1 = np.broadcast_to(tri[(_EDGE_A + 1) % 3][:, None, :], (9, count, 3)).reshape(-1, 3)
    p2 = tris[:, _EDGE_B, :].transpose(1, 0, 2).reshape(-1, 3)
    q2 = tris[:, (_EDGE_B + 1) % 3, :].transpose(1, 0, 2).reshape(-1, 3)
    edge_a, edge_b = _closest_between_segments(p1, q1, p2, q2)

    # 3 vertices of `tri` against every triangle of `tris`, and the reverse.
    vertices_a = np.broadcast_to(tri[:, None, :], (3, count, 3)).reshape(-1, 3)
    repeated = np.broadcast_to(tris, (3, count, 3, 3)).reshape(-1, 3, 3)
    near_b = _closest_on_triangles(vertices_a, repeated)
    vertices_b = tris.transpose(1, 0, 2).reshape(-1, 3)
    fixed = np.broadcast_to(tri, (3 * count, 3, 3))
    near_a = _closest_on_triangles(vertices_b, fixed)

    on_a = np.concatenate([edge_a, vertices_a, near_a])
    on_b = np.concatenate([edge_b, near_b, vertices_b])
    distances = np.linalg.norm(on_a - on_b, axis=1).reshape(15, count)
    which = np.argmin(distances, axis=0)
    best = distances[which, rows]
    point_a = on_a.reshape(15, count, 3)[which, rows]
    point_b = on_b.reshape(15, count, 3)[which, rows]

    # Only worth running where something could still be positive. Two solids that
    # already touch at a vertex or an edge are done.
    if (best > 0.0).any():
        ends_a = np.broadcast_to(np.roll(tri, -1, axis=0)[:, None, :], (3, count, 3)).reshape(-1, 3)
        ends_b = np.roll(tris, -1, axis=1).transpose(1, 0, 2).reshape(-1, 3)
        hit = _segments_hit_triangles(vertices_a, ends_a, repeated).reshape(3, count).any(axis=0)
        hit |= _segments_hit_triangles(vertices_b, ends_b, fixed).reshape(3, count).any(axis=0)
        if hit.any():
            best = np.where(hit, 0.0, best)
            # The witness of a crossing lies on both surfaces; the midpoint of the
            # nearest vertex/edge pair is inside the intersection region and is
            # the honest thing to point at.
            middle = (point_a + point_b) / 2.0
            point_a = np.where(hit[:, None], middle, point_a)
            point_b = np.where(hit[:, None], middle, point_b)
    return best, point_a, point_b


def _usable_triangles(geo: ElementGeometry) -> np.ndarray:
    """The element's triangles with the degenerate ones dropped."""
    tris = geo.triangles
    _, areas = triangle_normals_areas(tris)
    return tris[areas > _MIN_TRIANGLE_AREA]


def _soup_distance(
    tris_a: np.ndarray, tris_b: np.ndarray, budget: float
) -> tuple[float, np.ndarray, np.ndarray, int, bool]:
    """Minimum distance between two triangle soups, with the witness pair.

    ## Complexity, and what it costs on real meshes

    The exact test is O(1) per triangle PAIR, so all-pairs is O(n·m) and a naive
    version of it is hopeless. Measured on the two worst pairs in the sample
    house, both of which a caller could legitimately ask about:

    ============================  =========================  =====================
    2 636-tri door / 3 618-tri chair
    all pairs, no pre-filter      9 537 048 exact tests      ~73 s (extrapolated)
    box pre-filter, natural order 104 233 exact tests        2.84 s
    box pre-filter, sorted+break  41 657 exact tests         **1.44 s**
    3 618-tri chair / 3 618-tri chair
    all pairs, no pre-filter      13 089 924 exact tests     ~102 s (extrapolated)
    box pre-filter, natural order 4 250 exact tests          0.81 s
    box pre-filter, sorted+break  3 678 exact tests          **0.041 s**
    ============================  =========================  =====================

    Two things do that, and neither changes the answer by a bit:

    1. **A box lower bound per triangle.** The axis-aligned gap between two
       triangles' boxes is a true lower bound on their distance and costs six
       comparisons, vectorised over the whole of B at once. Only triangles whose
       bound is below the best distance so far are tested exactly. Worth 90× on
       the door and the chair.
    2. **Sorted order plus a break.** The triangles of A are visited in ascending
       order of their box's lower bound to the WHOLE of B, so the minimum is
       usually found in the first few and the bound tightens immediately.
       Ascending order is what makes the break sound: the first triangle whose
       bound is not below the best proves that no LATER one can beat it either, so
       the loop stops instead of continuing. Note the second row of the chair
       pair: the break saves barely any exact TESTS (4 250 → 3 678) and still
       makes it about 20× faster, because what it really saves is 3 600 outer
       iterations, each of which was computing a 3 618-element bound array for a
       triangle that could not win.

    Two further ideas were implemented, measured and thrown away rather than
    kept on the strength of how sensible they sound: seeding ``best`` with a
    centroid-sampled upper bound, and testing the candidates in bound order in
    blocks so that ``best`` tightens inside one triangle's sweep. Together they
    take the door/chair pair from 41 657 exact tests to 38 295 (8 %, and 1.44 s to
    1.43 s) and the chair pair from 0.041 s to 0.022 s, at the price of a
    sampling threshold and a nested loop. Neither is in this function.

    What remains is O(n·m) in the box arithmetic, which is vectorised, and
    O(surviving pairs) in the exact tests. It stops being viable at roughly 10⁴
    triangles per element on ADVERSARIAL input — two long, finely meshed,
    near-parallel faces, where there is nothing to prune because every pair really
    is near-minimal. That is what :data:`CLEARANCE_BUDGET_SECONDS` is for; past it
    the right structure is a BVH over each mesh, which is a bigger change than
    this module.

    Returns ``(distance, point_on_a, point_on_b, exact_pairs_tested, aborted)``.
    """
    lo_a, hi_a = tris_a.min(axis=1), tris_a.max(axis=1)
    lo_b, hi_b = tris_b.min(axis=1), tris_b.max(axis=1)
    whole_b = (lo_b.min(axis=0), hi_b.max(axis=0))

    # Lower bound of every A triangle against the whole of B — both the sort key
    # and the break test.
    outer = np.maximum(lo_a - whole_b[1], whole_b[0] - hi_a)
    outer_bound = np.linalg.norm(np.maximum(outer, 0.0), axis=1)
    order = np.argsort(outer_bound)

    best = float("inf")
    point_a = np.zeros(3)
    point_b = np.zeros(3)
    tested = 0
    started = time.perf_counter()

    for index in order:
        if outer_bound[index] >= best:
            break
        if time.perf_counter() - started > budget:
            return best, point_a, point_b, tested, True
        gap = np.maximum(lo_a[index] - hi_b, lo_b - hi_a[index])
        bound = np.linalg.norm(np.maximum(gap, 0.0), axis=1)
        candidates = np.flatnonzero(bound < best)
        if candidates.size == 0:
            continue
        distances, pa, pb = _triangle_distances(tris_a[index], tris_b[candidates])
        tested += candidates.size
        winner = int(np.argmin(distances))
        if float(distances[winner]) < best:
            best = float(distances[winner])
            point_a = pa[winner]
            point_b = pb[winner]
        if best <= 0.0:
            # Touching or interpenetrating. Nothing can be smaller, and carrying
            # on would only be an expensive way to find another zero.
            break
    return best, point_a, point_b, tested, False


# ════════════════════════════════════════════════════════════════════════════
# the operators
# ════════════════════════════════════════════════════════════════════════════


def clear_width(model: SpatialModel, a_global_id: str, b_global_id: str) -> Answer[dict[str, Any]]:
    """The true minimum surface-to-surface distance between two solids, in metres.

    This is a **lichte Breite**, and it is the number ``distance()`` does not
    have. Its four modes are a box gap (``min``) and three mesh-centroid
    distances (``centroid``, ``horizontal``, ``vertical``); a box gap of 0 does
    not prove that two solids touch, and a centroid distance is an *Achsabstand*
    that includes half of each element. On a 1.00 m doorway between two 30 cm
    walls the Achsabstand is 1.30 m — 30 % too generous, on the side that turns a
    failed escape route into a passing one.

    Measured here on the sample house, bedroom against living room, separated by
    one 95 mm partition:

    ==========================  =========
    ``distance('min')``         0.095 m
    ``distance('horizontal')``  7.082 m
    ``clear_width``             0.095 m
    ==========================  =========

    The box gap agrees there **because both spaces are axis-aligned boxes**, which
    is the one case in which a box gap is a clearance. Where it fails, it fails
    silently and in the dangerous direction. The pitched roof against the interior
    partition wall, in the same file:

    ==========================  =========
    ``distance('min')``         0.000 m
    ``clear_width``             0.995 m
    ==========================  =========

    Zero, because the roof's bounding box swallows the wall's — and a caller
    reading 0 m as "these touch" would be wrong by a metre. A box gap is a lower
    bound on the clearance and never an upper one, so it can only ever err on the
    side of reporting elements as closer than they are.

    The answer carries the two points it was measured between, so a reviewer can
    put a dimension line on it in their own model. It also carries ``boxGap``, the
    number ``distance('min')`` would have returned, because the size of that
    difference is the finding.
    """
    method = f"clearWidth({a_global_id}, {b_global_id})"
    first = _require(model, a_global_id, method)
    second = _require(model, b_global_id, method)

    if a_global_id == b_global_id:
        return undecidable(
            from_=[a_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="clearWidth() hat zweimal dasselbe Bauteil bekommen",
                remedy=(
                    "Ein lichtes Maß braucht zwei verschiedene Bauteile — die beiden Laibungen einer "
                    "Öffnung, zwei Wände eines Gangs, Handlauf und Wand. Für das lichte Maß EINER Öffnung "
                    "ist clearOpeningWidth() der richtige Aufruf, für die Höhe eines Raums clearHeight()."
                ),
                elements=[a_global_id],
            ),
        )

    geo_a, missing = _geometry_or_answer(model, first, method, [a_global_id, b_global_id])
    if geo_a is None:
        return missing  # type: ignore[return-value]
    geo_b, missing = _geometry_or_answer(model, second, method, [a_global_id, b_global_id])
    if geo_b is None:
        return missing  # type: ignore[return-value]

    tris_a = _usable_triangles(geo_a)
    tris_b = _usable_triangles(geo_b)
    if len(tris_a) == 0 or len(tris_b) == 0:
        empty = first if len(tris_a) == 0 else second
        return undecidable(
            from_=[a_global_id, b_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"{empty.is_a()} „{model.label(empty) or empty.GlobalId}“ hat nur entartete Dreiecke",
                remedy=(
                    "Der Körper dieses Bauteils besteht aus Dreiecken ohne Fläche — im Export ist die Form "
                    "zusammengefallen (ein Profil mit Nullfläche, eine Extrusion der Länge 0). Das Bauteil im "
                    "CAD neu aufziehen und erneut exportieren."
                ),
                elements=[empty.GlobalId],
            ),
        )

    pairs = len(tris_a) * len(tris_b)
    if pairs > CLEARANCE_MAX_TRIANGLE_PAIRS:
        return undecidable(
            from_=[a_global_id, b_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=(f"zu fein vernetzt für eine exakte Flächenmessung: {len(tris_a)} × {len(tris_b)} Dreiecke"),
                remedy=(
                    "Das lichte Maß wird zwischen den Dreiecken beider Körper gemessen; bei dieser "
                    "Netzfeinheit dauert das zu lange. Abhilfe: die Frage an den tragenden Bauteilen stellen "
                    "statt an möblierten oder detaillierten Modellen (Wand gegen Wand statt Türblatt gegen "
                    "Möbel), oder das Modell mit gröberer Tessellierung exportieren."
                ),
                elements=[a_global_id, b_global_id],
            ),
        )

    started = time.perf_counter()
    value, point_a, point_b, tested, aborted = _soup_distance(tris_a, tris_b, CLEARANCE_BUDGET_SECONDS)
    seconds = time.perf_counter() - started

    if aborted:
        return undecidable(
            from_=[a_global_id, b_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=(
                    f"Messung nach {seconds:.0f} s abgebrochen ({len(tris_a)} × {len(tris_b)} Dreiecke, "
                    f"{tested} exakte Paarvergleiche)"
                ),
                remedy=(
                    "Diese beiden Körper liegen über eine große, fein vernetzte Fläche fast parallel "
                    "zueinander — dabei ist kein Dreieckspaar ausschließbar. Abhilfe: einen kleineren "
                    "Ausschnitt vergleichen (etwa die Laibung statt der ganzen Wand) oder das Modell mit "
                    "gröberer Tessellierung exportieren. Ein Zwischenergebnis wird bewusst nicht gemeldet: "
                    "eine abgebrochene Suche liefert eine OBERGRENZE, und eine Obergrenze als lichtes Maß zu "
                    "lesen ist genau der Fehler, den diese Messung verhindern soll."
                ),
                elements=[a_global_id, b_global_id],
            ),
        )

    gap = box_gap(geo_a.box, geo_b.box)
    box_distance = float(np.linalg.norm(np.maximum(gap, 0.0)))

    caveat = (
        "Gemessen zwischen den Oberflächen der beiden tessellierten Körper, nicht zwischen ihren Hüllboxen "
        "und nicht zwischen ihren Schwerpunkten. Das ist ein lichtes Maß im Rohbau: Putz, Bekleidungen, "
        "Beschläge und Türblätter im geöffneten Zustand sind nur enthalten, soweit sie im Modell als Körper "
        "vorhanden sind."
    )
    if value <= 0.0:
        caveat = (
            "Die beiden Körper berühren oder durchdringen einander — das lichte Maß ist 0 m. Das ist ein "
            "Messergebnis an den Flächen, keine Hüllbox-Aussage: hier schneiden sich tatsächlich Dreiecke "
            "beider Körper. Bei einem Fenster in seiner Laibung ist das normal, bei zwei tragenden Bauteilen "
            "ein Befund."
        )
    air = [e for e in (first, second) if e.is_a() in AIR_TYPES]
    if air:
        caveat += (
            " Mindestens eines der beiden Bauteile ist kein fester Körper, sondern Luft bzw. eine Aussparung ("
            + ", ".join(sorted({e.is_a() for e in air}))
            + "). Der Abstand wird dann zu einer gedachten Fläche gemessen, nicht zu einer gebauten."
        )
    if box_distance < value - DIMENSION_TOLERANCE:
        caveat += (
            f" Zum Vergleich: distance('min') hätte {box_distance:.3f} m gemeldet — der Hüllbox-Abstand "
            "unterschätzt das lichte Maß hier, wie immer bei schräg stehenden oder nicht quaderförmigen "
            "Bauteilen."
        )

    return computed(
        {
            "distance": value,
            "pointOnA": [float(v) for v in point_a],
            "pointOnB": [float(v) for v in point_b],
            "boxGap": box_distance,
            "trianglesA": int(len(tris_a)),
            "trianglesB": int(len(tris_b)),
            "exactPairsTested": int(tested),
            "seconds": round(seconds, 4),
        },
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[a_global_id, b_global_id],
        method=method,
        caveat=caveat,
    )


def _aperture_polygon(model: SpatialModel, element: Any) -> tuple[Any, np.ndarray] | None:
    """The element's faces projected onto its own plane, unioned — and the plane.

    This is exactly the projection ``operators._clear_opening_area`` performs, and
    it is kept in step with it deliberately: that function returns only the AREA
    of the union, and a width cannot be recovered from an area. ``test_clearance``
    asserts that the union built here has the same area as
    ``_clear_opening_area`` reports for all three openings of the sample house, so
    the two cannot drift apart unnoticed.

    Returns ``(polygon, normal)`` in the plane's own 2D frame — x along the
    horizontal in-plane axis, y along the vertical one — or ``None`` when the
    element has no usable body or no vertical plane to project along (a skylight
    in a flat roof).
    """
    import shapely
    import shapely.ops

    global_id = getattr(element, "GlobalId", None)
    if not global_id:
        return None
    geo = model.geometry(global_id)
    if geo is None or len(geo.triangles) == 0:
        return None
    normal = dominant_vertical_plane(geo.triangles)
    if normal is None:
        return None

    up = np.array([0.0, 0.0, 1.0])
    up = up - normal * float(up @ normal)
    if np.linalg.norm(up) < 1e-9:
        return None
    up = up / np.linalg.norm(up)
    across = np.cross(normal, up)

    normals, _ = triangle_normals_areas(geo.triangles)
    # Only faces lying IN the aperture plane. The reveal (the prism's side walls)
    # is perpendicular to it and projects to slivers that would inflate the union
    # — and, for a width, would widen it by the wall thickness.
    facing = geo.triangles[np.abs(normals @ normal) > 0.9]
    if len(facing) == 0:
        return None

    polygons = []
    for tri in facing:
        flat = shapely.Polygon([(float(p @ across), float(p @ up)) for p in tri])
        if flat.is_valid and flat.area > 0:
            polygons.append(flat)
    if not polygons:
        return None
    try:
        return shapely.ops.unary_union(polygons), normal
    except Exception:
        return None


def clear_opening_width(model: SpatialModel, opening_or_filler_global_id: str) -> Answer[dict[str, Any]]:
    """The clear width and height of one opening, measured on its own aperture.

    The number an OIB door-width or escape-route-width check actually wants, and
    the reason it is a separate operator from :func:`clear_width`: a clear width
    measured BETWEEN two neighbouring elements needs the right two neighbours, and
    the two reveals of a doorway are usually the same wall. An opening knows its
    own aperture.

    The method is ``operators._clear_opening_area``'s: the opening is a prism
    driven through the wall, so its faces projected along its own plane normal
    land on top of each other and the shapely union of that projection is the
    clear aperture. This takes the union's extent along the horizontal in-plane
    axis as the width and along the vertical one as the height, which is right for
    a round-headed or trapezoidal window where a bounding box in model coordinates
    is not.

    Verified against the sample house's own type names, which is the only oracle
    worth having: ``810x2110mm`` → 0.810 × 2.110 m, ``1810x1210mm`` →
    1.810 × 1.210 m, ``1810x2110mm`` → 1.810 × 2.110 m. Exact to the millimetre in
    all three.

    ## What is measured, and what a Bestimmung may instead mean

    This is the **Rohbaulichte** — the clear structural opening. A lichte
    Durchgangsbreite is measured between the finished frame rebates and is
    15–25 % smaller on an ordinary door. The two are not interchangeable and the
    caveat says which one this is; deciding which the clause means is the clause's
    job.

    ## The fallback, and which way it is wrong

    A window or door is followed through ``FillsVoids → RelatingOpeningElement``
    to its opening. When no opening carries geometry — 84 % of the fenestration in
    one ArchiCAD export in the corpus, because the wall body was written with the
    hole already subtracted — the element's own body is measured instead, and that
    number is **too LARGE**, not too small. Measured on this file: the internal
    door's body projects to 0.880 m against its opening's 0.810 m, and both
    1810 mm units project to 1.860 m against 1.810 m. The lining and the
    architrave overlap the wall face on both sides, so the silhouette is 50–70 mm
    wider than the hole it sits in. That is the direction that turns a failing
    escape route into a passing one, so the fallback is labelled as an upper
    bound every time it is used.
    """
    method = f"clearOpeningWidth({opening_or_filler_global_id})"
    subject = _require(model, opening_or_filler_global_id, method)
    kind = model.kind_of(subject)

    if kind != "opening" and subject.is_a() not in FENESTRATION:
        _wrong_kind(
            subject,
            method,
            "clearOpeningWidth",
            "eine Öffnung, ein Fenster oder eine Tür",
            (
                "für eine Wand: hosts() liefert ihre Öffnungen, danach clearOpeningWidth() je Öffnung; "
                "für den lichten Abstand zwischen zwei Bauteilen: clearWidth()"
            ),
        )

    if kind == "opening":
        openings = [subject]
    else:
        openings = [rel.RelatingOpeningElement for rel in (getattr(subject, "FillsVoids", []) or [])]

    projection = None
    measured_on = None
    via = "IfcOpeningElement"
    for opening in openings:
        projection = _aperture_polygon(model, opening)
        if projection is not None:
            measured_on = opening
            break
    if projection is None:
        projection = _aperture_polygon(model, subject)
        measured_on = subject
        via = "Bauteilkörper (Rahmen und Bekleidung enthalten)"

    if projection is None or measured_on is None:
        name = model.label(subject) or subject.GlobalId
        return undecidable(
            from_=[opening_or_filler_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine in einer senkrechten Ebene liegende Öffnungsfläche an {subject.is_a()} „{name}“",
                remedy=(
                    "Das lichte Maß wird auf der Öffnungsebene gemessen. Diese Öffnung hat entweder keinen "
                    "Körper im Export, oder sie liegt waagrecht (ein Dachflächenfenster in einem Flachdach) "
                    "und hat damit keine senkrechte Ebene. Abhilfe: den Export mit Öffnungen und Füllungen "
                    "sowie mit Körpergeometrie wiederholen. Für ein waagrechtes Fenster ist die lichte "
                    "Öffnung im Grundriss zu messen — dafür ist extent() bzw. orientedExtent() zuständig."
                ),
                elements=[subject.GlobalId],
            ),
        )

    polygon, normal = projection
    min_x, min_y, max_x, max_y = polygon.bounds
    width = float(max_x - min_x)
    height = float(max_y - min_y)
    area = float(polygon.area)
    # 1.000 for a rectangular opening. Below it, the aperture is narrower than
    # `width` over part of its height — a Rundbogen, a trapezoid, a mullioned
    # opening whose union has a notch — and the width is then the widest point
    # rather than a passable width. All three sample-house openings come out at
    # exactly 1.0.
    filled = area / (width * height) if width > 0 and height > 0 else 0.0

    caveat = (
        "Gemessen ist die ROHBAULICHTE — die lichte Öffnung im Rohbau, projiziert auf die Öffnungsebene. "
        "Die lichte DURCHGANGSBREITE einer Tür wird zwischen den fertigen Zargenfalzen gemessen und ist bei "
        "einer üblichen Tür 15–25 % kleiner. Welches der beiden Maße die Bestimmung meint, entscheidet die "
        "Bestimmung; hier wird nur gemessen."
    )
    if via != "IfcOpeningElement":
        caveat += (
            " Für dieses Bauteil ist keine Öffnung mit Geometrie hinterlegt (IfcRelFillsElement → "
            "IfcRelVoidsElement fehlt oder trägt keinen Körper), deshalb wurde der BAUTEILKÖRPER gemessen. "
            "Dieser schließt Rahmen und Bekleidung ein, die beidseitig auf der Wand aufliegen: das Maß ist "
            "damit eine OBERGRENZE und um einige Zentimeter zu groß (in dieser Datei 50–70 mm). Als "
            "Nachweis einer Mindestbreite ist es nicht verwendbar."
        )
    if filled < 0.98:
        caveat += (
            f" Die Öffnung ist nicht rechteckig ({filled * 100:.0f} % der Umschreibenden sind Öffnungsfläche): "
            "über einen Teil der Höhe ist sie schmäler als die angegebene Breite. Die Breite ist das größte "
            "Maß, nicht das durchgehend lichte."
        )

    return computed(
        {
            "width": width,
            "height": height,
            "area": area,
            "rectangularity": round(filled, 4),
            "measuredOn": measured_on.GlobalId,
            "via": via,
            "planeNormal": [float(v) for v in normal],
        },
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[opening_or_filler_global_id, measured_on.GlobalId],
        method=method,
        caveat=caveat,
    )


def _minimum_area_rectangle(points: np.ndarray) -> tuple[float, float, np.ndarray] | None:
    """The minimum-area rectangle enclosing a 2D point set — rotating calipers.

    Returns ``(long_side, short_side, long_axis_unit_vector)``, or ``None`` when
    the points are collinear and there is no rectangle to speak of.

    Only the convex hull's own edge directions are tried, which is not an
    approximation but the theorem: the minimum-area enclosing rectangle of a
    convex polygon has a side collinear with one of its edges. So the hull is
    walked once and every edge is tried, and the result is exact.

    Sampling angles instead is the obvious alternative and it is wrong. Measured
    on the sample house's skewed chair, whose true minimum is 1.0862 m² at 37°: a
    5° sweep returns **1.1481 m² at 35°** (5.7 % too large, the axis 2° off), a 2°
    sweep 1.1154 m² at 36°, and only a 1° sweep finds 37° — because 37 happens to
    be an integer. A degree of axis error is 25 cm at the end of a 14 m wall, and
    the too-large area is the direction that makes a room look bigger than it is.
    Trying |hull| directions costs less than the 90 evaluations of the 1° sweep.
    """
    import shapely

    hull = shapely.MultiPoint([(float(p[0]), float(p[1])) for p in points]).convex_hull
    if hull.geom_type != "Polygon":
        return None
    ring = np.asarray(hull.exterior.coords)[:-1]
    if len(ring) < 3:
        return None

    best: tuple[float, float, float, np.ndarray] | None = None
    for i in range(len(ring)):
        edge = ring[(i + 1) % len(ring)] - ring[i]
        length = float(np.linalg.norm(edge))
        if length < 1e-12:
            continue
        along = edge / length
        across = np.array([-along[1], along[0]])
        u = ring @ along
        v = ring @ across
        extent_u = float(u.max() - u.min())
        extent_v = float(v.max() - v.min())
        area = extent_u * extent_v
        if best is None or area < best[0] - 1e-15:
            best = (area, extent_u, extent_v, along)

    if best is None:
        return None
    _, extent_u, extent_v, along = best
    if extent_u >= extent_v:
        return extent_u, extent_v, along
    return extent_v, extent_u, np.array([-along[1], along[0]])


def oriented_extent(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The element's own length, width and height — a minimum-area oriented box.

    ``extent()`` returns a box axis-aligned to the MODEL, and for anything skewed
    to the model axes its ``width`` and ``depth`` are systematically too large and
    are not the element's length and thickness. Measured on the sample house's
    chair ``Furniture_Chair_Viper:1120x940x350mm``, which stands 37° off the model
    axes:

    ===================  ================  ==================
    ``extent()``         1.428 × 1.400 m   footprint 2.000 m²
    ``oriented_extent``  1.116 × 0.973 m   footprint 1.086 m²
    ===================  ================  ==================

    The axis-aligned footprint is **84 % too large**, and its ``width`` of 1.428 m
    is a dimension of nothing: the chair's own long side is 1.116 m, four
    millimetres off the 1120 mm in its type name. The second chair, at 35°, gives
    the identical 1.116 × 0.973 m from a different axis-aligned box (1.424 ×
    1.389 m) — which is the point, since it is the same chair. A wall skewed in
    plan fails the same way, and there the wrong number is a wall thickness.

    ## How, and why only hull edges are tried

    The footprint is hulled in plan and the minimum-area enclosing rectangle is
    found by rotating calipers — the minimum-area rectangle of a convex polygon
    has a side collinear with a hull EDGE, so trying every hull edge is exact and
    sampling angles is not. See :func:`_minimum_area_rectangle`.
    ``shapely.minimum_rotated_rectangle`` does exist in the installed 2.1.2 and it
    is trustworthy — it agrees with this to 2.2e-16 m² on the chair and on a
    hand-rotated 2 × 1 rectangle, and ``test_clearance`` keeps checking that it
    does. It is not used because a polygon does not hand back the axis and the two
    extents, and re-deriving them from its corners is the same rotating-caliper
    arithmetic with an extra parse in front of it.

    Height is the Z extent, unchanged from ``extent()``: no rotation about a
    horizontal axis is attempted, because a building element that is tilted out of
    plumb is a different question and a rectangle in plan is what a floor plan
    dimensions.

    ## The two angles, which are not the same angle

    ``rotation`` is where the LONG AXIS points, in degrees clockwise from north,
    folded into [0, 180) because an axis has no direction. ``deviation`` is how
    far the box is turned out of the model axes, in [0, 45], because a rectangle
    maps onto itself every 90°. The chair at ``rotation`` 53° has ``deviation``
    37°; the second chair at 125° has 35°.

    Unlike :func:`~ifc_spatial.operators.azimuth`, this does not refuse when the
    file declares no ``TrueNorth``. The shape is measured in model coordinates and
    is a fact either way, so the answer stands and ``northKnown`` is ``False``,
    ``rotation`` is then relative to model +Y, and the caveat says so. Refusing
    would withhold a correct length and width over a compass question nobody
    asked.

    ## When ``extent()`` would have been fine

    ``axisAligned`` says so outright. Every wall, window, door and room of the
    sample house comes back with ``deviation`` below 1.2e-13 °, which is the
    answer "use ``extent()``, it costs less and says the same thing".
    """
    method = f"orientedExtent({global_id})"
    subject = _require(model, global_id, method)
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    rectangle = _minimum_area_rectangle(geo.verts[:, :2])
    if rectangle is None:
        name = model.label(subject) or global_id
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"kein Grundriss an {subject.is_a()} „{name}“ — alle Punkte liegen auf einer Geraden",
                remedy=(
                    "Der umschließende Rechteckkörper wird über den Grundriss des Bauteils gebildet. Dieses "
                    "Bauteil hat keinen: sein Körper ist eine senkrechte Fläche ohne Dicke oder eine Linie "
                    "(eine Achse, eine Annotation). Für ein flächiges Bauteil den Export mit echter "
                    "Körpergeometrie wiederholen; für eine senkrechte Öffnungsfläche ist "
                    "clearOpeningWidth() das passende Maß."
                ),
                elements=[global_id],
            ),
        )

    length, width, axis = rectangle
    low, high = geo.box
    height = float(high[2] - low[2])

    # Bearing conventions taken verbatim from `operators.azimuth`: `true_north` is
    # the angle from +Y toward +X, north = (sin θ, cos θ), east is north turned
    # 90° clockwise. An AXIS has no direction, so the bearing is folded into
    # [0, 180): a wall running north-south is at 0°, not at 0° and 180°.
    theta = model.true_north if model.true_north is not None else 0.0
    north = np.array([math.sin(theta), math.cos(theta)])
    east = np.array([north[1], -north[0]])
    bearing = math.degrees(math.atan2(float(axis @ east), float(axis @ north)))
    bearing = math.fmod(math.fmod(bearing, 180.0) + 180.0, 180.0)

    # How far the oriented box is turned out of the axis-aligned one. A rectangle
    # maps onto itself every 90°, so the deviation lives in [0, 45].
    from_model_y = math.degrees(math.atan2(float(axis[0]), float(axis[1])))
    quarter = math.fmod(math.fmod(from_model_y, 90.0) + 90.0, 90.0)
    deviation = min(quarter, 90.0 - quarter)
    aligned = deviation <= AXIS_ALIGNED_DEGREES

    box_width = float(high[0] - low[0])
    box_depth = float(high[1] - low[1])
    box_area = box_width * box_depth
    oriented_area = length * width

    if aligned:
        caveat = (
            "Dieses Bauteil steht achsparallel zum Modell (Abweichung "
            f"{deviation:.2f}°): Länge und Breite stimmen hier mit der achsparallelen Hüllbox überein, "
            "extent() liefert dieselben Zahlen. Gemessen ist die kleinste umschreibende Rechteckfläche im "
            "Grundriss, nicht das Bauteil selbst — bei einem L-förmigen oder gekrümmten Bauteil ist sie "
            "größer als jede seiner Seiten."
        )
    else:
        caveat = (
            f"Dieses Bauteil steht um {deviation:.1f}° schräg zu den Modellachsen. Länge und Breite sind am "
            "gedrehten Rechteck gemessen und beschreiben das Bauteil; die achsparallele Hüllbox aus extent() "
            f"meldet stattdessen {box_width:.3f} × {box_depth:.3f} m, also eine um "
            f"{(box_area / oriented_area - 1) * 100:.0f} % zu große Grundfläche. Die Höhe ist in beiden "
            "Fällen dieselbe: gedreht wird nur im Grundriss."
        )
    if model.true_north is None:
        caveat += (
            " Die Datei deklariert keine Nordrichtung (IfcGeometricRepresentationContext.TrueNorth), deshalb "
            "ist „rotation“ auf die Modellachse +Y bezogen und KEINE Himmelsrichtung."
        )

    return computed(
        {
            "length": length,
            "width": width,
            "height": height,
            "rotation": bearing,
            "deviation": deviation,
            "axisAligned": aligned,
            "longAxis": [float(axis[0]), float(axis[1])],
            "footprintArea": oriented_area,
            "axisAlignedFootprintArea": box_area,
            "northKnown": model.true_north is not None,
        },
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[global_id],
        method=method,
        caveat=caveat,
    )


__all__ = [
    "AXIS_ALIGNED_DEGREES",
    "CLEARANCE_BUDGET_SECONDS",
    "CLEARANCE_MAX_TRIANGLE_PAIRS",
    "clear_opening_width",
    "clear_width",
    "oriented_extent",
]
