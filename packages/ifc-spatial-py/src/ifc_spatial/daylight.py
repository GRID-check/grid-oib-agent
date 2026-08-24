"""Room daylight geometry — how deep a room runs, what sits over it, where the sun is.

Three operators that `operators.py` leaves open, all of them named in §5 and §7 of
`docs/roadmap/agent-spatial-reasoning.md`. They share one subject: an OIB 3
daylight question is not settled by `light_entry_area` alone.

## Why depth is a separate number from area

`light_entry_area` answers *how much glass per square metre of floor*. It cannot
answer *how far back the floor runs from that glass*, and the two are different
questions about the same room. Daylight falls off with distance from the
aperture; a 5.66 m deep living room under a 2.20 m ceiling — a depth-to-height
ratio of 2.57 — is lit differently at its back wall than the 3.46 m bedroom next
to it at 1.57, and both may carry the same percentage of window. :func:`room_depth`
supplies the missing half, always **relative to a named facade**, because a
corner room has two and the answer changes with the choice. The choice is
therefore part of the answer, not an implementation detail.

Depth is measured by projecting the room's own FOOTPRINT onto the facade normal,
never by reading an axis-aligned bounding box. For the sample house the two agree
to the millimetre because the building is square to the model axes; for a room
skewed 30° to them, the AABB extent is the diagonal of the room and is too large
by up to 40 %, silently, in exactly the direction that makes a deep room look
compliant. The whole point of naming a facade is that the measurement is taken
against IT.

## Why above/below have to exist

Nothing in the operator vocabulary can say what is directly over an element. That
is how one finds the storey above a flat, the terrace over a living room, the
slab a downstand hangs from — and, for daylight, the roof over the window whose
overhang `overhang()` measures. :func:`above` and :func:`below` cast the same
kind of ray :func:`~ifc_spatial.operators.clear_height` does, with the same
exclusions, for the same reason: an unfiltered upward ray off the sample house's
ground slab reports a **couch at 0.135 m** as the thing above the floor.

## Why the sun position refuses more often than it answers

:func:`sun_position` is real astronomy over a real coordinate, and it is
undecidable for every model that does not carry one. A building has no compass
bearing until somebody states its latitude, longitude and true north; computing a
solar altitude against an assumed 0° north and an assumed Austrian latitude would
produce a number that looks like a measurement and is a guess about the two facts
the file withholds.
"""

from __future__ import annotations

import datetime as dt
import math
from typing import Any

import numpy as np

from . import operators as op
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import undecidable
from .geometry import triangle_normals_areas
from .model import AIR_TYPES
from .model import SpatialModel

# ── the error model ─────────────────────────────────────────────────────────
# The geometric tolerances are the ones `operators.py` already states, imported
# rather than restated so that a room's depth and a wall's length carry the same
# stated error. Only the two constants below are new, and both are new because
# nothing in `operators.py` measures the thing they bound.

#: Published accuracy of the solar position algorithm used here, in degrees.
#: Michalsky (1988), *The Astronomical Almanac's algorithm for approximate solar
#: position (1950–2050)*, Solar Energy 40(3):227–235: 0.01° over 1950–2050. This
#: deliberately does NOT reuse ``operators.AZIMUTH_TOLERANCE_DEGREES`` (3°) —
#: that number is tessellation error on a facade normal, an entirely different
#: quantity that happens to share a unit, and 3° on a sun position would be six
#: solar diameters.
SOLAR_TOLERANCE_DEGREES = 0.01
#: Outside Michalsky's validated span the polynomial drifts. The value is still
#: returned, with this tolerance and a caveat, because the drift is gradual —
#: refusing outright would be a bigger lie than a widened error bar.
SOLAR_TOLERANCE_DEGREES_EXTRAPOLATED = 0.1

#: Grid resolution for the overhead scan, per axis. 5 × 5 = 25 rays, matching
#: :func:`~ifc_spatial.operators.clear_height`'s default so the two operators
#: can miss the same narrow downstand and nobody has to reconcile two answers.
OVERHEAD_SAMPLES = 5
#: How far above/below the subject's own extent a scan ray starts, metres. Large
#: enough to clear the tessellation of the subject's own top face, small enough
#: that it cannot jump a real contact.
OVERHEAD_OFFSET = 0.01
#: A second facade carrying at least this share of the winner's aperture makes
#: the room a corner room, and the caveat says the choice was close.
CORNER_ROOM_SHARE = 0.5
#: Relative gap between depth × width and the measured floor area above which the
#: room is not a rectangle and the product must not be read as its area. Tight —
#: half a percent — because both numbers come out of the SAME tessellation and
#: share its error, so the difference between them is shape and not noise. At the
#: 2 % that would be defensible for two independent measurements, the sample
#: house's living room passes at 1.23 % and gets called rectangular; it has a
#: 0.639 m² notch out of one corner.
RECTANGULARITY_TOLERANCE = 0.005

#: Curtain-wall glazing is carried by these types, and they are NOT counted as
#: apertures — see :func:`_facade_candidates` for why, and for what is said
#: about it instead.
CURTAIN_WALL_TYPES = ("IfcPlate", "IfcMember", "IfcCurtainWall")


# ════════════════════════════════════════════════════════════════════════════
# room depth
# ════════════════════════════════════════════════════════════════════════════


def _footprint_points(triangles: np.ndarray) -> np.ndarray | None:
    """The room's plan outline as a point set, from its horizontal faces.

    The same both-windings discipline as
    :func:`~ifc_spatial.operators._footprint_area`, and for the same reason: a
    Revit IFC2X3 ``IfcSpace`` can be wound inside-out, and keeping only the
    up-facing triangles then yields an empty silhouette rather than a footprint.
    Both projections are taken and the one with the larger union area wins.

    The points are the union polygon's own vertices, not the triangle corners,
    so an L-shaped room contributes its re-entrant corner and nothing interior.
    ``None`` when the solid has no horizontal face at all — the caller falls
    back to every vertex, which for a prism is the same silhouette.
    """
    import shapely
    import shapely.ops

    if triangles is None or len(triangles) == 0:
        return None
    normals, _ = triangle_normals_areas(triangles)
    best_area = 0.0
    best: Any = None
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
            merged = shapely.ops.unary_union(polygons)
        except Exception:
            continue
        if merged.area > best_area:
            best_area = merged.area
            best = merged
    if best is None or best.is_empty:
        return None

    coords: list[tuple[float, float]] = []
    for part in getattr(best, "geoms", [best]):
        exterior = getattr(part, "exterior", None)
        if exterior is None:
            continue
        coords.extend((float(x), float(y)) for x, y in exterior.coords)
        for ring in part.interiors:
            coords.extend((float(x), float(y)) for x, y in ring.coords)
    return np.array(coords) if coords else None


def _extent_along(points: np.ndarray, direction: np.ndarray) -> float:
    """How far a plan point set reaches along a horizontal direction, in metres.

    This is the whole argument of the operator in two lines: the extent is taken
    along the FACADE's normal, so a room turned 30° to the model grid measures
    its true depth. ``operators.extent`` would report the axis-aligned box, whose
    Y span for that room is ``depth·cos30 + width·sin30`` — for the sample
    house's living room rotated 30° that would be 9.53 m against a real 5.66 m,
    a 68 % overstatement with no sign on the answer that anything went wrong.
    """
    projected = points @ direction
    return float(projected.max() - projected.min())


def _aperture_area(model: SpatialModel, element: Any) -> float | None:
    """The clear opening this window or door admits light through, m².

    Straight through ``FillsVoids → RelatingOpeningElement`` onto
    :func:`~ifc_spatial.operators._clear_opening_area`, exactly as
    :func:`~ifc_spatial.operators.light_entry_area` does — the two operators must
    rank facades and sum areas off the same number, or a room's chosen facade and
    its reported light-entry area could come from different windows.
    """
    for rel in getattr(element, "FillsVoids", []) or []:
        area = op._clear_opening_area(model, rel.RelatingOpeningElement)
        if area:
            return area
    return op._clear_opening_area(model, element)


def _facade_candidates(model: SpatialModel, space_global_id: str, bounding: list[Any]) -> list[dict[str, Any]]:
    """Every external wall bounding this room, ranked by the daylight it carries.

    An aperture counts towards a wall when the wall HOSTS it
    (``hosted_in``) and the aperture faces outside — the same
    :func:`~ifc_spatial.operators._faces_outside` test that keeps an interior
    door out of a Lichteintrittsfläche. Without it the sample house's bedroom
    would rank its 12 cm plasterboard partition (which hosts a 1.71 m² door to
    the hall) level with the external north wall's 2.19 m² window, and a depth
    measured perpendicular to the partition is the room's WIDTH, not its depth.

    Curtain-wall glazing is deliberately not an aperture here. The living room is
    bounded by 15 ``IfcMember`` mullions and 6 ``IfcPlate`` panes that carry no
    ``IfcOpeningElement`` and are not hosted in any wall; counting them would
    require a second, differently-defined aperture measure. They are reported in
    the caveat instead, so the reader can see that a west-facing glass wall was
    not in the ranking.
    """
    external: dict[str, dict[str, Any]] = {}
    for element in bounding:
        if model.kind_of(element) != "element":
            continue
        if element.is_a() not in ("IfcWall", "IfcWallStandardCase"):
            continue
        declared = model.declared_property(element, ("IsExternal",))
        if declared is False:
            continue
        if declared is not True:
            # Not declared. Measure the wall rather than drop it — the same
            # question `_faces_outside` asks two loops below for the apertures,
            # which makes it odd that the wall selection ever answered it
            # differently. `AC20-FZK-Haus.ifc` declares `IsExternal` on none of
            # its 26 walls, so this `continue` refused **all seven rooms** of a
            # real single-family house with „keine als außenliegend deklarierte
            # Wand begrenzt diesen Raum" — a sentence about a wall that is named
            # `Wand-Ext-ERDG-1` in the file it is describing.
            rooms = op.enclosed_by(model, element.GlobalId)
            if not rooms.decidable or not rooms.value:
                continue
            if op._rooms_on_one_side(model, element, rooms.value) is not True:
                continue
        external[element.GlobalId] = {
            "globalId": element.GlobalId,
            "name": model.label(element),
            "ifcType": element.is_a(),
            "apertureArea": 0.0,
            "apertures": [],
        }

    for element in bounding:
        if element.is_a() not in op.FENESTRATION:
            continue
        faces_outside, _why = op._faces_outside(model, element)
        if faces_outside is not True:
            continue
        hosts_ = op.hosted_in(model, element.GlobalId)
        area = _aperture_area(model, element)
        if not area:
            continue
        for ref in hosts_.value or []:
            candidate = external.get(ref.global_id)
            if candidate is None:
                continue
            candidate["apertureArea"] = float(candidate["apertureArea"]) + float(area)
            candidate["apertures"].append(element.GlobalId)

    ranked = sorted(external.values(), key=lambda c: (-float(c["apertureArea"]), c["globalId"]))
    return ranked


def _facade_geometry(model: SpatialModel, facade_id: str, method: str) -> tuple[np.ndarray, Answer[Any] | None, bool]:
    """The outward horizontal normal of a facade, via ``facadePlaneOf``.

    Returns ``(normal, refusal, outward)``. The normal is flattened into the
    horizontal plane and re-normalised: a wall leaning 2° out of plumb still
    defines one depth direction in plan, and carrying its Z component into the
    projection would shorten the measured depth by the cosine of the lean.
    """
    plane = op.facade_plane_of(model, facade_id)
    if not plane.decidable or plane.value is None:
        return (
            np.zeros(2),
            undecidable(
                from_=[facade_id],
                method=method,
                provenance="computed",
                missing=plane.missing
                or MissingFact(
                    what=f"keine Fassadenebene für {facade_id}",
                    remedy="Ohne Bezugsebene ist keine Raumtiefe messbar.",
                ),
            ),
            False,
        )
    normal = np.array(plane.value["normal"], dtype=float)[:2]
    length = float(np.linalg.norm(normal))
    if length < 1e-9:
        return (
            np.zeros(2),
            undecidable(
                from_=[facade_id],
                method=method,
                provenance="computed",
                missing=MissingFact(
                    what=f"die Fassadenebene von {facade_id} steht waagrecht",
                    remedy=(
                        "Eine Raumtiefe wird senkrecht zur Fassade im Grundriss gemessen. Dieses Bauteil hat "
                        "keine senkrechte Fläche (z. B. eine Decke oder ein Flachdach) und kann die "
                        "Bezugsrichtung nicht liefern. bounds() zeigt die Wände des Raums."
                    ),
                    elements=[facade_id],
                ),
            ),
            False,
        )
    return normal / length, None, bool(plane.value["outward"])


def room_depth(
    model: SpatialModel,
    space_global_id: str,
    facade_element_global_id: str | None = None,
) -> Answer[dict[str, Any]]:
    """How far a room runs back from its daylight facade, in metres.

    Three numbers plus the reasoning behind them: ``depth`` perpendicular to a
    named facade, ``width`` along it, and ``depthToHeight`` — the ratio a
    daylight rule of thumb is stated in — against the room's **lichte Höhe**.

    ## Why the clear height and not the space solid's height

    :func:`~ifc_spatial.operators.clear_height` measures floor to the lowest
    thing actually above it; the ``IfcSpace`` body's Z extent measures what the
    modeller drew. On this fixture those are 2.200 m and 2.500 m — a 30 cm
    suspended ceiling that the room solid does not know about. Taken on the
    bedroom's 3.4625 m depth the ratio is 1.574 against the honest height and
    1.385 against the modelled one, and the modelled one is the flattering side.
    A depth-to-height ratio computed against a height that no occupant will ever
    stand under is not a daylight number.

    ## Why a facade must be named, and how one is picked

    A corner room has two external walls and two different depths — for the
    sample house's living room, 5.655 m from the north facade and 9.3075 m from
    the east. There is no room depth without a facade, so when the caller does
    not name one this picks the **external wall carrying the largest outward
    aperture** and reports the ranking it chose from, every candidate with its
    aperture area. The reader can see the runner-up and disagree.

    ## Why the footprint and not the bounding box

    The extent is taken along the facade's own normal over the room's projected
    footprint. On this fixture the two routes agree because the building is
    square to the model axes; on a room turned to the grid, the axis-aligned box
    reports the room's diagonal spread and overstates the depth without any sign
    that it did. See :func:`_extent_along`.

    ``depth × width`` is returned beside the measured floor area precisely so
    that the reconciliation is visible: they agree to 1e-11 m² on the two
    rectangular rooms here and differ by 1.2 % on the living room, which is not
    a rectangle. No verdict, no threshold: OIB names the limits.
    """
    method = f"roomDepth({space_global_id})"
    subject = op._require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        op._wrong_kind(
            subject,
            method,
            "roomDepth",
            "einen Raum (IfcSpace)",
            "für die Ausdehnung eines Bauteils: extent() liefert sie",
        )

    geo, missing = op._geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    bounding = op.bounds(model, space_global_id)
    if not bounding.decidable:
        return bounding  # type: ignore[return-value]
    bounding_elements = [model.file.by_guid(ref.global_id) for ref in (bounding.value or [])]

    candidates = _facade_candidates(model, space_global_id, bounding_elements)
    curtain_wall = [e for e in bounding_elements if e.is_a() in CURTAIN_WALL_TYPES]

    if facade_element_global_id is not None:
        facade = op._require(model, facade_element_global_id, method)
        facade_id = facade.GlobalId
        chosen = next((c for c in candidates if c["globalId"] == facade_id), None)
        why = "vom Aufrufer vorgegeben"
    else:
        chosen = candidates[0] if candidates and float(candidates[0]["apertureArea"]) > 0 else None
        if chosen is None:
            return _no_facade(model, space_global_id, method, candidates, curtain_wall)
        facade_id = str(chosen["globalId"])
        why = (
            f"größte außenliegende Öffnungsfläche der begrenzenden Außenwände "
            f"({float(chosen['apertureArea']):.4f} m² aus {len(chosen['apertures'])} Öffnung(en))"
        )

    method = f"roomDepth({space_global_id}, facade={facade_id})"
    normal, refusal, outward = _facade_geometry(model, facade_id, method)
    if refusal is not None:
        return refusal  # type: ignore[return-value]

    points = _footprint_points(geo.triangles)
    from_footprint = points is not None
    if points is None:
        points = geo.verts[:, :2]

    along = np.array([-normal[1], normal[0]])
    depth = _extent_along(points, normal)
    width = _extent_along(points, along)

    floor = op.floor_area(model, space_global_id)
    floor_value = float(floor.value) if floor.decidable and floor.value else None
    height = op.clear_height(model, space_global_id)
    height_value = float(height.value) if height.decidable and height.value else None

    facade_element = model.file.by_guid(facade_id)
    bearing = op.azimuth(model, facade_id)

    value = {
        "depth": round(depth, 4),
        "width": round(width, 4),
        "clearHeight": None if height_value is None else round(height_value, 4),
        "depthToHeight": None if not height_value else round(depth / height_value, 4),
        "floorArea": None if floor_value is None else round(floor_value, 4),
        "depthTimesWidth": round(depth * width, 4),
        "facade": {
            "globalId": facade_id,
            "name": model.label(facade_element),
            "ifcType": facade_element.is_a(),
            "normal": [round(float(normal[0]), 6), round(float(normal[1]), 6)],
            "azimuth": bearing.value if bearing.decidable else None,
            "why": why,
        },
        "candidates": candidates,
    }

    return computed(
        value,
        unit="m",
        tolerance=op.DIMENSION_TOLERANCE,
        from_=[space_global_id, facade_id, *(chosen["apertures"] if chosen else [])],
        method=method,
        caveat=_depth_caveat(
            model,
            chosen=chosen,
            candidates=candidates,
            facade_id=facade_id,
            outward=outward,
            depth=depth,
            width=width,
            floor_value=floor_value,
            height=height,
            height_value=height_value,
            from_footprint=from_footprint,
            curtain_wall=curtain_wall,
            bounding=bounding,
            caller_supplied=facade_element_global_id is not None,
        ),
    )


def _no_facade(
    model: SpatialModel,
    space_global_id: str,
    method: str,
    candidates: list[dict[str, Any]],
    curtain_wall: list[Any],
) -> Answer[Any]:
    """No external wall of this room carries a measurable outward aperture.

    Undecidable rather than "pick the biggest external wall". A room's depth is
    only defined against the facade its daylight comes through; measuring
    perpendicular to whichever external wall happens to be longest would produce
    a confident number about a direction nobody chose, and it would be the room's
    WIDTH as often as its depth.
    """
    if candidates:
        what = "keine außenliegende Fensteröffnung an den Außenwänden dieses Raums"
        remedy = (
            f"Dieser Raum wird von {len(candidates)} Außenwand/Außenwänden begrenzt, aber keine davon trägt "
            "eine messbare, nach außen gerichtete Öffnung. Entweder hat der Raum kein Fenster — dann gibt es "
            "keine Belichtungsfassade und keine Raumtiefe zu ihr — oder der Export hat die Öffnungen ohne "
            "Geometrie geschrieben. Abhilfe: mit Öffnungen und Füllungen neu exportieren, oder roomDepth() "
            "mit der gewünschten Fassade als zweitem Argument aufrufen."
        )
    else:
        what = "keine als außenliegend deklarierte Wand begrenzt diesen Raum"
        remedy = (
            "Die Belichtungsfassade wird unter den Außenwänden des Raums gesucht, und außen heißt hier: "
            "Pset_WallCommon.IsExternal ist an der Wand gesetzt. In diesem Modell ist das für keine "
            "begrenzende Wand der Fall. Abhilfe: IsExternal an den Außenwänden setzen und neu exportieren, "
            "oder roomDepth() mit der gewünschten Fassade als zweitem Argument aufrufen."
        )
    if curtain_wall:
        remedy += (
            f" Hinweis: {len(curtain_wall)} Bauteil(e) einer Vorhangfassade (IfcPlate/IfcMember) begrenzen "
            "diesen Raum. Vorhangfassaden tragen ihre Verglasung ohne IfcOpeningElement und werden hier "
            "nicht als Öffnung gezählt — sie sind aber eine Belichtungsfassade und können ausdrücklich "
            "übergeben werden."
        )
    return undecidable(
        from_=[space_global_id, *[c["globalId"] for c in candidates]],
        method=method,
        provenance="computed",
        missing=MissingFact(what=what, remedy=remedy, elements=[space_global_id]),
    )


def _depth_caveat(
    model: SpatialModel,
    *,
    chosen: dict[str, Any] | None,
    candidates: list[dict[str, Any]],
    facade_id: str,
    outward: bool,
    depth: float,
    width: float,
    floor_value: float | None,
    height: Answer[float],
    height_value: float | None,
    from_footprint: bool,
    curtain_wall: list[Any],
    bounding: Answer[Any],
    caller_supplied: bool,
) -> str:
    """Everything the depth is not valid without, in one German paragraph."""
    parts: list[str] = [
        "Tiefe und Breite sind aus dem Grundriss des Raumkörpers gemessen, auf die Fassadennormale bzw. auf "
        "die Fassadenrichtung projiziert — NICHT aus der achsparallelen Hüllbox. Für einen zur Modellachse "
        "verdrehten Raum wären die Boxmaße systematisch zu groß."
    ]

    if caller_supplied and chosen is None:
        parts.append(
            "Die Fassade wurde übergeben und gehört nicht zu den außenliegenden Wänden, die dieser Raum "
            "über bounds() als Begrenzung führt — die Tiefe ist trotzdem senkrecht zu ihr gemessen."
        )
    runners = [c for c in candidates if c["globalId"] != facade_id and float(c["apertureArea"]) > 0]
    if chosen is not None and runners:
        best = float(chosen["apertureArea"])
        second = runners[0]
        share = float(second["apertureArea"]) / best if best > 0 else 0.0
        listed = ", ".join(f"{c['name'] or c['globalId']} ({float(c['apertureArea']):.3f} m²)" for c in runners[:3])
        # `candidates` is every external wall bounding the room — the first loop
        # of `_facade_candidates` enters a blank gable with apertureArea 0.0 so
        # that a caller may still name it. Counting those under the words
        # „Außenwände mit Öffnungen" told the reader a room with one window and
        # three blank external walls had four daylight facades, and the ranking
        # printed right beside the sentence shows only one. The total is kept in
        # the parenthesis: a wall that carries no opening is still a wall the
        # depth could be measured to.
        with_openings = [c for c in candidates if float(c["apertureArea"]) > 0]
        # Only the three largest runners-up are named, so the sentence must not
        # read as the whole list — see `Answer.caveat`: a caller that drops the
        # qualifier is reporting a subset as a total.
        more = "" if len(runners) <= 3 else f" (die 3 größten von {len(runners)})"
        parts.append(
            f"Dieser Raum hat {len(with_openings)} Außenwand/Außenwände mit Öffnungen (von "
            f"{len(candidates)} begrenzenden Außenwänden insgesamt); "
            + ("gewählt ist eine davon. " if float(chosen["apertureArea"]) > 0 else "die gewählte trägt keine. ")
            + f"Weitere{more}: {listed}. Zu jeder gehört eine andere Raumtiefe."
        )
        if share >= CORNER_ROOM_SHARE:
            parts.append(
                f"Die zweitgrößte Fassade trägt {share * 100:.0f} % der Öffnungsfläche der gewählten — das ist "
                "ein Eckraum, und die Wahl ist keine deutliche. Für die andere Richtung roomDepth() mit "
                f"facade={second['globalId']} aufrufen."
            )

    if not outward:
        parts.append(
            "Die Außenseite dieser Fassadenebene ist ungesichert (das Bauteil steht zu nahe an der "
            "Grundriss-Mitte). Die Tiefe selbst ist davon unberührt — sie ist eine Ausdehnung, kein "
            "Vorzeichen — die genannte Himmelsrichtung kann aber um 180° gedreht sein."
        )

    if height_value is None:
        parts.append(
            "Ohne lichte Höhe ist kein Verhältnis Tiefe/Höhe gebildet: "
            + (
                (height.missing.what + ". " + height.missing.remedy)
                if height.missing
                else "clearHeight() liefert nichts."
            )
        )
    else:
        parts.append(
            f"Das Verhältnis Tiefe/Höhe ist gegen die LICHTE Höhe {height_value:.3f} m gebildet (clearHeight, "
            "senkrecht nach oben gemessen), nicht gegen die Höhe des Raumkörpers. Abgehängte Decken und "
            "Unterzüge verkürzen die lichte Höhe, ohne den Raumkörper zu verkürzen; das Verhältnis gegen den "
            "Raumkörper fiele günstiger aus und wäre die unsichere Seite."
        )

    if floor_value is not None:
        product = depth * width
        delta = abs(product - floor_value) / floor_value if floor_value else 0.0
        if delta <= RECTANGULARITY_TOLERANCE:
            parts.append(
                f"Gegenprobe: Tiefe × Breite = {product:.4f} m² gegen die gemessene Bodenfläche "
                f"{floor_value:.4f} m² ({delta * 100:.2f} % Abweichung) — der Grundriss füllt das Rechteck "
                "aus Tiefe und Breite aus, die Tiefe gilt damit über die ganze Breite."
            )
        else:
            parts.append(
                f"Gegenprobe: Tiefe × Breite = {product:.4f} m² gegen die gemessene Bodenfläche "
                f"{floor_value:.4f} m² ({delta * 100:.2f} % Abweichung). Dieser Raum ist NICHT rechteckig — "
                "Tiefe und Breite sind die größten Ausdehnungen und gelten nicht an jeder Stelle. Das Produkt "
                "ist keine Fläche des Raums; die Fläche liefert floorArea()."
            )

    if not from_footprint:
        parts.append(
            "Der Raumkörper hat keine waagrechte Fläche, aus der sich ein Grundriss bilden ließe — gemessen "
            "ist die Projektion aller Körperpunkte. Für einen senkrechten Raumkörper ist das dieselbe "
            "Silhouette; für einen geneigten ist sie größer als der Boden."
        )

    if curtain_wall:
        names = ", ".join(sorted({(model.label(e) or e.GlobalId).split(":")[0] for e in curtain_wall}))
        parts.append(
            f"{len(curtain_wall)} Bauteil(e) einer Vorhangfassade ({names}) begrenzen diesen Raum und sind in "
            "der Fassadenwahl NICHT enthalten: Vorhangfassaden tragen ihre Verglasung als IfcPlate/IfcMember "
            "ohne IfcOpeningElement, ihre Öffnungsfläche ist mit demselben Maß nicht messbar. Wenn die "
            "Belichtung über die Glasfassade läuft, roomDepth() mit einem ihrer Bauteile als Fassade aufrufen."
        )

    if bounding.provenance == "computed" and bounding.caveat:
        parts.append(f"Raumbegrenzung: {bounding.caveat}")

    return " ".join(parts)


# ════════════════════════════════════════════════════════════════════════════
# above / below
# ════════════════════════════════════════════════════════════════════════════


def _is_excluded(element: Any) -> bool:
    """Air and furniture — the two classes that make an overhead ray lie.

    ``clear_height`` tests ``element.is_a(FURNISHING[0])``, which catches
    ``IfcFurniture`` and ``IfcSystemFurnitureElement`` too because both are
    IFC4 subtypes of ``IfcFurnishingElement``. Every entry of the tuple is
    checked here anyway: in IFC2X3 the subtype relation does not exist, and a
    single-entry test would let an IFC2X3 ``IfcFurniture`` decide a room's
    headroom.
    """
    if element.is_a() in AIR_TYPES:
        return True
    for kind in op.FURNISHING:
        try:
            if element.is_a(kind):
                return True
        except Exception:
            continue
    return False


def _overhead(model: SpatialModel, global_id: str, upward: bool, samples: int) -> Answer[list[dict[str, Any]]]:
    """The shared body of :func:`above` and :func:`below`."""
    direction = "above" if upward else "below"
    method = f"{direction}({global_id}, samples={samples})"
    subject = op._require(model, global_id, method)
    geo, missing = op._geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    low, high = geo.box
    thickness = float(high[2] - low[2])
    start_z = float(high[2]) + OVERHEAD_OFFSET if upward else float(low[2]) - OVERHEAD_OFFSET
    scan = (0.0, 0.0, 1.0) if upward else (0.0, 0.0, -1.0)
    back = (0.0, 0.0, -1.0) if upward else (0.0, 0.0, 1.0)
    reach = model.diagonal
    tree = model.tree

    found: dict[str, dict[str, Any]] = {}
    tested = 0
    for ix in range(samples):
        for iy in range(samples):
            x = float(low[0] + (high[0] - low[0]) * (ix + 0.5) / samples)
            y = float(low[1] + (high[1] - low[1]) * (iy + 0.5) / samples)

            # Is this grid point really over the element? The bounding box of an
            # L-shaped room, a pitched roof or a curved wall covers plan area the
            # element does not occupy, and a ray from there reports what is above
            # the BOX. The test is a short ray back into the element rather than
            # a point-inside test, because the point just above the top face is
            # by construction outside the solid — a `tree.select` there answers
            # nothing.
            hits_back = tree.select_ray((x, y, start_z), back, length=thickness + 2 * OVERHEAD_OFFSET)
            if not any(model.file.by_id(h.instance.id()).GlobalId == global_id for h in hits_back):
                continue
            tested += 1

            # Elements whose solid already contains the ray's origin are in
            # CONTACT, and their gap is zero. Without this the ray starts inside
            # them and OCCT returns the far side: the sample house's window
            # `…VyWcE` sits in a wall whose parapet it touches, and the exit face
            # of that parapet is at floor level — reported as "0.90 m below the
            # window", which is the sill height and not a clearance at all.
            here = {e.GlobalId for e in tree.select((x, y, start_z))}
            seen: set[str] = set()
            for global_id_here in here:
                element = model.file.by_guid(global_id_here)
                if global_id_here == global_id or _is_excluded(element):
                    continue
                seen.add(global_id_here)
                _record(found, model, element, 0.0)

            for hit in tree.select_ray((x, y, start_z), scan, length=reach):
                element = model.file.by_id(hit.instance.id())
                if element.GlobalId == global_id or element.GlobalId in seen or _is_excluded(element):
                    continue
                if element.GlobalId in here:
                    continue
                seen.add(element.GlobalId)
                _record(found, model, element, float(hit.distance) + OVERHEAD_OFFSET)

    if tested == 0:
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="kein Rasterpunkt lag über bzw. unter diesem Bauteil",
                remedy=(
                    f"Das Raster von {samples}×{samples} Punkten über der Hüllbox hat das Bauteil selbst nicht "
                    f"getroffen — es ist dafür zu schmal oder zu zerklüftet. {direction}() mit einem höheren "
                    "samples-Wert aufrufen."
                ),
                elements=[global_id],
            ),
        )

    result = sorted(found.values(), key=lambda f: (f["gap"], f["globalId"]))
    for entry in result:
        entry["gap"] = round(float(entry["gap"]), 4)
        entry["gapMax"] = round(float(entry["gapMax"]), 4)

    word = "über" if upward else "unter"
    caveat = (
        f"Senkrecht {word} der Hüllbox dieses Bauteils gemessen (geom.tree.select_ray), aus {tested} von "
        f"{samples * samples} Rasterpunkten, die wirklich über dem Körper liegen. `gap` ist der kleinste, "
        "`gapMax` der größte Abstand, den ein Rasterpunkt zu diesem Bauteil gefunden hat — bei einem geneigten "
        "Dach liegen die beiden weit auseinander; `samples` sagt, über wie vielen Punkten es steht. "
        "Ein Abstand von 0 heißt Berührung oder Durchdringung: der Strahl startete bereits in diesem Körper. "
        "Möblierung (IfcFurnishingElement, IfcFurniture) und Luftkörper (IfcSpace, IfcOpeningElement) sind "
        "ausgenommen — ein unbefiltertes Raster über der Bodenplatte dieses Modells meldet sonst eine Couch "
        "in 0,135 m als das, was über dem Boden liegt. Ein Raster kann ein schmales Bauteil zwischen zwei "
        "Punkten verfehlen; die Liste ist damit keine Vollständigkeitsaussage."
    )
    if not result:
        caveat += (
            f" Kein Bauteil {word} diesem: über allen geprüften Rasterpunkten ist bis zum Modellrand "
            f"({reach:.1f} m) nichts. Das ist ein Ergebnis, kein fehlender Wert."
        )

    return computed(
        result,
        unit="m",
        tolerance=op.DIMENSION_TOLERANCE,
        from_=[global_id, *[entry["globalId"] for entry in result]],
        method=method,
        caveat=caveat,
    )


def _record(found: dict[str, dict[str, Any]], model: SpatialModel, element: Any, gap: float) -> None:
    entry = found.get(element.GlobalId)
    if entry is None:
        found[element.GlobalId] = {
            "globalId": element.GlobalId,
            "name": model.label(element),
            "ifcType": element.is_a(),
            "gap": gap,
            "gapMax": gap,
            "samples": 1,
        }
        return
    entry["gap"] = min(float(entry["gap"]), gap)
    entry["gapMax"] = max(float(entry["gapMax"]), gap)
    entry["samples"] = int(entry["samples"]) + 1


def above(model: SpatialModel, global_id: str, samples: int = OVERHEAD_SAMPLES) -> Answer[list[dict[str, Any]]]:
    """What sits directly over this element, nearest first, with the vertical gap.

    The operator §7 of the design document calls ``above(element)`` and lists as
    "bbox overlap + elevation". A bounding-box overlap is not enough: it reports
    the roof as being over every element in the building, and it cannot tell a
    slab resting on a wall from one 2 m clear of it. So this casts the same
    upward rays :func:`~ifc_spatial.operators.clear_height` does, from a grid
    over the element's own top, and keeps the same exclusions.

    ## What the exclusions are worth, measured on this file

    Unfiltered, the nearest five things "above" the sample house's ground slab
    `3cUkl32yn9qRSPvBJVyWgQ` are a chair at 0.119 m, a second chair at 0.124 m, a
    couch at 0.135 m, a bed at 0.203 m and a dining chair at 0.225 m. Filtered,
    the first real answer is the roof at 1.993 m and the suspended ceilings at
    2.200 m. Furniture is not what is above a floor in any sense a building code
    uses.

    ## Reading the result

    ``gap`` is the smallest clearance any grid point found, ``gapMax`` the
    largest, ``samples`` the number of grid points over which the element stands.
    A gap of ``0`` means contact or interpenetration, not "measured zero". The
    empty list is a decidable answer — free sky, or the underside of the lowest
    slab — and must not be rendered as "nicht ermittelbar".
    """
    return _overhead(model, global_id, upward=True, samples=samples)


def below(model: SpatialModel, global_id: str, samples: int = OVERHEAD_SAMPLES) -> Answer[list[dict[str, Any]]]:
    """What sits directly under this element, nearest first, with the vertical gap.

    The mirror of :func:`above`, and the operator that finds the storey below, the
    slab a room stands on, the beam a duct is hung under. Everything in
    :func:`above`'s docstring applies with the sign reversed, including the
    contact rule: the window `3cUkl32yn9qRSPvBJVyWcE` sits in a wall it touches,
    and this reports that wall at 0 m rather than at the 0.90 m where the wall's
    far side happens to be.
    """
    return _overhead(model, global_id, upward=False, samples=samples)


# ════════════════════════════════════════════════════════════════════════════
# sun position
# ════════════════════════════════════════════════════════════════════════════


def _by_type(model: SpatialModel, ifc_type: str) -> list[Any]:
    """``file.by_type`` that survives a schema which has never heard of the type.

    ``IfcMapConversion`` arrived in IFC4, and asking an IFC2X3 file for it raises
    ``RuntimeError: Entity with name 'IfcMapConversion' not found in schema
    'IFC2X3'`` — not an empty list. ``einheiten-fuss.ifc`` is such a file, and an
    unguarded lookup turns "dieses Modell ist nicht georeferenziert" into a
    traceback. ``operators._has`` guards the same call for the same reason.
    """
    try:
        return list(model.file.by_type(ifc_type))
    except RuntimeError:
        return []


def _compound_angle(value: Any) -> float | None:
    """An ``IfcCompoundPlaneAngleMeasure`` in decimal degrees, sign included.

    The tuple is ``(degrees, minutes, seconds[, millionths of a second])``, and
    the schema requires every component to carry the SAME sign — which means the
    sign of a coordinate west of Greenwich or south of the equator can live in a
    component that is not the first. The sample house declares
    ``(0, -7, -34, -450321)``: reading the sign off ``degrees`` alone gives
    ``+0.126°``, putting the building in Essex instead of west London, and every
    solar azimuth after it is wrong by half a degree with nothing to show for it.

    So the sign is taken from the first non-zero component and applied to the
    magnitude of the whole.
    """
    if not value:
        return None
    try:
        parts = [int(component) for component in value]
    except (TypeError, ValueError):
        return None
    if len(parts) < 3:
        return None
    sign = -1.0 if any(part < 0 for part in parts) else 1.0
    magnitude = abs(parts[0]) + abs(parts[1]) / 60.0 + abs(parts[2]) / 3600.0
    if len(parts) > 3:
        # The fourth component is millionths of an arc second.
        magnitude += abs(parts[3]) / 3.6e9
    return sign * magnitude


def _site_coordinates(model: SpatialModel) -> tuple[float, float, str] | None:
    """``(latitude, longitude, site GlobalId)`` from ``IfcSite``, or ``None``."""
    for site in _by_type(model, "IfcSite"):
        latitude = _compound_angle(getattr(site, "RefLatitude", None))
        longitude = _compound_angle(getattr(site, "RefLongitude", None))
        if latitude is None or longitude is None:
            continue
        if not (-90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0):
            continue
        return latitude, longitude, site.GlobalId
    return None


def _map_conversion_north(model: SpatialModel) -> float | None:
    """North from ``IfcMapConversion``, radians from model +Y, or ``None``.

    ``XAxisAbscissa``/``XAxisOrdinate`` give the model +X axis in the map's own
    frame, so grid north back in model coordinates is
    ``(XAxisOrdinate, XAxisAbscissa)`` and the angle from +Y to it is
    ``atan2(XAxisOrdinate, XAxisAbscissa)`` — the same convention
    :attr:`~ifc_spatial.model.SpatialModel.true_north` uses for ``TrueNorth``.

    This is GRID north, not true north. In a UTM zone the two differ by the
    meridian convergence, up to about 3° at the zone edge, so it is used only
    when the file states no ``TrueNorth`` and it is named in the caveat.
    """
    for conversion in _by_type(model, "IfcMapConversion"):
        abscissa = getattr(conversion, "XAxisAbscissa", None)
        ordinate = getattr(conversion, "XAxisOrdinate", None)
        if abscissa is None or ordinate is None:
            continue
        if abs(float(abscissa)) < 1e-12 and abs(float(ordinate)) < 1e-12:
            continue
        return float(np.arctan2(float(ordinate), float(abscissa)))
    return None


def _julian_day(when: dt.datetime) -> float:
    """Julian Day of a UTC instant — the Gregorian conversion from Meeus §7."""
    year, month = when.year, when.month
    if month <= 2:
        year -= 1
        month += 12
    century = year // 100
    gregorian = 2 - century + century // 4
    day = when.day + (when.hour + when.minute / 60.0 + (when.second + when.microsecond / 1e6) / 3600.0) / 24.0
    return math.floor(365.25 * (year + 4716)) + math.floor(30.6001 * (month + 1)) + day + gregorian - 1524.5


def _solar_azimuth_altitude(when: dt.datetime, latitude: float, longitude: float) -> dict[str, float]:
    """Solar azimuth and altitude, degrees — Michalsky (1988) / the Astronomical
    Almanac's low-precision algorithm.

    Michalsky, J. J. (1988), *The Astronomical Almanac's algorithm for approximate
    solar position (1950–2050)*, Solar Energy 40(3):227–235. Stated accuracy
    **0.01°** over 1950–2050, which is what :data:`SOLAR_TOLERANCE_DEGREES`
    carries. Measured against the two published references in
    ``tests/test_daylight.py`` this implementation lands within 0.006°.

    Implemented rather than imported because this package's whole dependency set
    is ``numpy``, ``shapely``, ``ifcopenshell`` — twenty lines of arithmetic do
    not justify a fourth.

    The result is the **geometric** (true) position. Atmospheric refraction lifts
    the apparent sun by about 0.02° at 40° altitude and by up to 0.57° at the
    horizon; it is not applied, because a shadow is cast by the geometric sun and
    every downstream use here is a shadow.

    Azimuth is degrees clockwise from true north (east = 90°); altitude is
    degrees above the horizon and goes negative at night, which is a real answer.
    """
    n = _julian_day(when) - 2451545.0
    hour = when.hour + when.minute / 60.0 + (when.second + when.microsecond / 1e6) / 3600.0

    mean_longitude = (280.460 + 0.9856474 * n) % 360.0
    mean_anomaly = math.radians((357.528 + 0.9856003 * n) % 360.0)
    ecliptic_longitude = math.radians(
        (mean_longitude + 1.915 * math.sin(mean_anomaly) + 0.020 * math.sin(2 * mean_anomaly)) % 360.0
    )
    obliquity = math.radians(23.439 - 0.0000004 * n)

    right_ascension = math.atan2(math.cos(obliquity) * math.sin(ecliptic_longitude), math.cos(ecliptic_longitude))
    declination = math.asin(math.sin(obliquity) * math.sin(ecliptic_longitude))

    # Greenwich mean sidereal time. The fractional part of `n` already carries
    # the UT hours at 1.0027 sidereal days per solar day; adding `hour` supplies
    # the remaining one solar rotation, which is Michalsky's own arrangement.
    gmst = (6.697375 + 0.0657098242 * n + hour) % 24.0
    local_sidereal = (gmst + longitude / 15.0) % 24.0
    hour_angle = math.radians((local_sidereal * 15.0 - math.degrees(right_ascension) + 180.0) % 360.0 - 180.0)

    phi = math.radians(latitude)
    altitude = math.asin(
        math.sin(phi) * math.sin(declination) + math.cos(phi) * math.cos(declination) * math.cos(hour_angle)
    )
    azimuth = math.atan2(
        -math.cos(declination) * math.sin(hour_angle),
        math.cos(phi) * math.sin(declination) - math.sin(phi) * math.cos(declination) * math.cos(hour_angle),
    )
    return {
        "azimuth": math.degrees(azimuth) % 360.0,
        "altitude": math.degrees(altitude),
        "declination": math.degrees(declination),
        "hourAngle": math.degrees(hour_angle),
    }


def _parse_instant(when_iso: str, method: str) -> tuple[dt.datetime | None, Answer[Any] | None]:
    """The timestamp as a UTC instant, or a refusal.

    A timestamp without a zone is refused rather than assumed to be UTC. Austria
    runs UTC+1 in winter and UTC+2 in summer; reading ``2026-06-21T12:00:00`` as
    UTC puts the sun 30° east of where it stood over the site, which is two hours
    of shadow and precisely the error nobody re-checks because the input looked
    complete.
    """
    try:
        parsed = dt.datetime.fromisoformat(str(when_iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None, undecidable(
            from_=[],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"„{when_iso}“ ist kein lesbarer Zeitpunkt",
                remedy=(
                    "Den Zeitpunkt nach ISO 8601 mit Zeitzone angeben, z. B. 2026-06-21T12:00:00+02:00 "
                    "(Sommerzeit in Österreich) oder 2026-06-21T10:00:00Z."
                ),
            ),
        )
    if parsed.tzinfo is None:
        return None, undecidable(
            from_=[],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"Zeitzone fehlt im Zeitpunkt „{when_iso}“",
                remedy=(
                    "Den Zeitpunkt mit Zonenangabe wiederholen, z. B. 2026-06-21T12:00:00+02:00 oder "
                    "2026-06-21T10:00:00Z. Ohne Zone wird hier nichts angenommen: Österreich läuft im Winter "
                    "auf UTC+1 und im Sommer auf UTC+2, und eine als UTC gelesene Ortszeit verschiebt die "
                    "Sonne um bis zu 30° — zwei Stunden Schattenverlauf."
                ),
            ),
        )
    return parsed.astimezone(dt.UTC), None


def sun_position(
    model: SpatialModel,
    when_iso: str,
    latitude: float | None = None,
    longitude: float | None = None,
) -> Answer[dict[str, Any]]:
    """Where the sun stands over this building at a given instant — or nothing.

    Azimuth (degrees clockwise from true north) and altitude (degrees above the
    horizon) for ``when_iso``, plus the direction TOWARDS the sun expressed in the
    model's own coordinates, which is what :func:`~ifc_spatial.operators.ray` and
    :func:`~ifc_spatial.operators.obstructions` take as an argument.

    ## This is where the sun is, not what is shaded

    **Keine Besonnungsstudie.** A sun position says the sun stood 61.9° up and
    178.9° round at that moment; it says nothing about whether the neighbour's
    gable was in the way, whether the balcony above cut the beam, or how many
    hours of sun the window received over a day. Those are shading questions, and
    they need the sun direction plus :func:`~ifc_spatial.operators.obstructions`
    plus a model of everything outside the property line that this file does not
    contain. The caveat says so in the answer, every time.

    ## Undecidable unless the file is georeferenced

    ``IfcSite.RefLatitude`` / ``RefLongitude`` is where a project states where it
    is. Without them there is no sun to compute, and this returns undecidable
    with the German remedy — never a default latitude. An assumed 48°N Vienna on
    a Vorarlberg project is out by 1.4° of solar altitude, and an assumed north
    on a building rotated 40° is out by 40°; both would arrive as `computed`
    numbers with a tolerance, which is the single substitution this library
    exists to prevent.

    ``latitude``/``longitude`` may be passed to override the file. That is a
    legitimate route — a surveyor's coordinate is better than an exporter's
    default — and it is loudly caveated, because the number then rests on the
    caller and not on the model.

    ## Accuracy

    Michalsky (1988), the Astronomical Almanac's own low-precision algorithm:
    **0.01° over 1950–2050**, carried as the answer's ``tolerance``, widened to
    0.1° outside that span. Validated in ``tests/test_daylight.py`` against the
    NREL SPA reference case and three U.S. Naval Observatory almanac positions;
    the largest deviation found was 0.006°. The position is geometric — no
    refraction — because shadows are cast by the geometric sun.
    """
    method = f"sunPosition({when_iso})"
    when, refusal = _parse_instant(when_iso, method)
    if refusal is not None:
        return refusal  # type: ignore[return-value]
    assert when is not None

    from_: list[str] = []
    if (latitude is None) != (longitude is None):
        return undecidable(
            from_=[],
            method=method,
            provenance="declared",
            missing=MissingFact(
                what="nur eine der beiden Koordinaten übergeben",
                remedy=(
                    "sunPosition() braucht Breite UND Länge zusammen, in Dezimalgrad (Norden und Osten "
                    "positiv). Beide weglassen, um die Georeferenz des Modells zu verwenden."
                ),
            ),
        )

    if latitude is not None and longitude is not None:
        coordinate_source = "vom Aufrufer übergeben"
    else:
        site = _site_coordinates(model)
        if site is None:
            return _not_georeferenced(model, method)
        latitude, longitude, site_id = site
        from_.append(site_id)
        coordinate_source = f"IfcSite.RefLatitude/RefLongitude ({site_id})"

    sun = _solar_azimuth_altitude(when, float(latitude), float(longitude))

    north = model.true_north
    north_source = "IfcGeometricRepresentationContext.TrueNorth"
    if north is None:
        north = _map_conversion_north(model)
        north_source = "IfcMapConversion.XAxisAbscissa/XAxisOrdinate (Gitternord)"
    direction: list[float] | None = None
    if north is not None:
        # North and east in model coordinates, the same construction
        # `operators.azimuth` uses to turn a model normal into a bearing — read
        # backwards here, from a bearing to a model direction.
        north_vector = np.array([math.sin(north), math.cos(north), 0.0])
        east_vector = np.array([north_vector[1], -north_vector[0], 0.0])
        bearing = math.radians(sun["azimuth"])
        horizontal = math.cos(bearing) * north_vector + math.sin(bearing) * east_vector
        towards = math.cos(math.radians(sun["altitude"])) * horizontal + np.array(
            [0.0, 0.0, math.sin(math.radians(sun["altitude"]))]
        )
        direction = [round(float(c), 6) for c in towards]

    in_span = 1950 <= when.year <= 2050
    tolerance = SOLAR_TOLERANCE_DEGREES if in_span else SOLAR_TOLERANCE_DEGREES_EXTRAPOLATED

    value = {
        "azimuth": round(sun["azimuth"], 4),
        "altitude": round(sun["altitude"], 4),
        "compass": op.COMPASS[int(round(sun["azimuth"] / 22.5)) % 16],
        "aboveHorizon": bool(sun["altitude"] > 0.0),
        "declination": round(sun["declination"], 4),
        "latitude": round(float(latitude), 6),
        "longitude": round(float(longitude), 6),
        "utc": when.isoformat().replace("+00:00", "Z"),
        "directionInModel": direction,
        "trueNorthDegrees": None if north is None else round(math.degrees(north) % 360.0, 4),
    }

    return computed(
        value,
        unit="°",
        tolerance=tolerance,
        from_=from_,
        method=method,
        caveat=_sun_caveat(
            coordinate_source=coordinate_source,
            north=north,
            north_source=north_source,
            in_span=in_span,
            tolerance=tolerance,
            altitude=sun["altitude"],
            when=when,
        ),
    )


def _sun_caveat(
    *,
    coordinate_source: str,
    north: float | None,
    north_source: str,
    in_span: bool,
    tolerance: float,
    altitude: float,
    when: dt.datetime,
) -> str:
    parts = [
        "Das ist der Sonnenstand, KEINE Besonnungsstudie: die Antwort sagt, wo die Sonne steht, nicht, was "
        "beschattet ist. Ob der Strahl beim Fenster ankommt, entscheiden Nachbargebäude, Gelände, Balkone "
        "und Dachüberstände — davon kennt diese Datei nur, was in ihr modelliert ist. Für die Verschattung "
        "die Richtung `directionInModel` an ray() bzw. obstructions() übergeben; alles außerhalb des Modells "
        "bleibt unberücksichtigt.",
        f"Koordinaten: {coordinate_source}."
        + (
            " Diese Koordinaten stehen NICHT in der Datei — sie stammen aus dem Aufruf. Ob sie zu diesem "
            "Gebäude gehören, kann hier niemand prüfen; der ganze Sonnenstand hängt daran."
            if coordinate_source.startswith("vom Aufrufer")
            else ""
        ),
        (
            "Algorithmus: Michalsky (1988), der Näherungsalgorithmus des Astronomical Almanac, angegebene "
            f"Genauigkeit 0,01° für 1950–2050; hier als Toleranz {tolerance} ° geführt."
        ),
        "Gerechnet ist die GEOMETRISCHE Sonnenposition ohne Refraktion — Schatten wirft die geometrische "
        "Sonne. Die scheinbare Sonne steht in Horizontnähe bis zu 0,57° höher.",
    ]
    if not in_span:
        parts.append(
            f"Der Zeitpunkt liegt im Jahr {when.year} und damit außerhalb des Gültigkeitsbereichs 1950–2050 "
            "des Algorithmus. Der Wert wird ausgegeben, die Toleranz ist dafür auf "
            f"{SOLAR_TOLERANCE_DEGREES_EXTRAPOLATED} ° erhöht."
        )
    if altitude <= 0.0:
        parts.append(
            f"Die Sonne steht zu diesem Zeitpunkt {abs(altitude):.2f}° UNTER dem Horizont — es ist Nacht. "
            "Der Azimut ist trotzdem angegeben und beschreibt die Richtung unter dem Horizont."
        )
    if north is None:
        parts.append(
            "Die Datei nennt keine Nordrichtung (weder IfcGeometricRepresentationContext.TrueNorth noch "
            "IfcMapConversion). Azimut und Höhe sind echte Himmelskoordinaten und davon unberührt, aber die "
            "Richtung im Modell (`directionInModel`) lässt sich nicht bilden: es ist unbekannt, wie das "
            "Gebäude zum Norden steht. Abhilfe: die Nordrichtung im CAD setzen und mitexportieren."
        )
    elif north_source.startswith("IfcMapConversion"):
        parts.append(
            "Die Nordrichtung stammt aus IfcMapConversion und ist damit GITTERNORD des Projektionssystems, "
            "nicht geografisch Nord. Die beiden weichen um die Meridiankonvergenz voneinander ab — in einer "
            "UTM-Zone bis etwa 3°. Abhilfe: TrueNorth im Geometriekontext setzen."
        )
    else:
        parts.append(f"Nordrichtung: {north_source}.")
    return " ".join(parts)


def _not_georeferenced(model: SpatialModel, method: str) -> Answer[Any]:
    """No coordinate, so no sun. The remedy names the CAD action, not the entity.

    Two different files land here and they need different sentences. A file with
    an ``IfcMapConversion`` but no ``IfcSite`` coordinate IS georeferenced — into
    a projected coordinate system whose back-conversion to latitude and longitude
    needs the projection's own parameters and a library this package does not
    have. Telling that architect "das Modell ist nicht georeferenziert" would be
    false, and they would go and set something that is already set.
    """
    map_conversion = _by_type(model, "IfcMapConversion")
    if map_conversion:
        crs = getattr(map_conversion[0], "TargetCRS", None)
        crs_name = getattr(crs, "Name", None) or "unbenannt"
        return undecidable(
            from_=[],
            method=method,
            provenance="declared",
            missing=MissingFact(
                what="IfcSite.RefLatitude / RefLongitude (geografische Koordinaten)",
                remedy=(
                    f"Dieses Modell ist georeferenziert, aber in ein projiziertes Koordinatensystem "
                    f"(IfcMapConversion, TargetCRS „{crs_name}“). Aus Rechts- und Hochwert lassen sich Breite "
                    "und Länge nur mit den Parametern genau dieser Projektion zurückrechnen — dafür fehlt "
                    "dieser Bibliothek die Projektionsbibliothek, und eine Näherung wäre um Kilometer "
                    "daneben. Abhilfe: am IfcSite zusätzlich RefLatitude und RefLongitude setzen (in Revit "
                    "und ArchiCAD der Standort des Projekts), oder sunPosition() mit latitude/longitude "
                    "aufrufen."
                ),
            ),
        )
    return undecidable(
        from_=[],
        method=method,
        provenance="declared",
        missing=MissingFact(
            what="IfcSite.RefLatitude / RefLongitude",
            remedy=(
                "Dieses Modell sagt nicht, wo es steht. Im CAD den Standort des Projekts setzen (Revit: "
                "Verwalten → Standort; ArchiCAD: Optionen → Projektstandort) und mitexportieren — dann "
                "stehen Breite und Länge am IfcSite. Ein angenommener Standort wird hier nicht eingesetzt: "
                "48° statt 47° Breite verschiebt die Sonnenhöhe um ein Grad, und der Fehler ist an der "
                "Antwort nicht zu erkennen. Wer die Koordinaten hat, kann sie sunPosition() direkt "
                "übergeben."
            ),
        ),
    )


__all__ = [
    "above",
    "below",
    "room_depth",
    "sun_position",
]
