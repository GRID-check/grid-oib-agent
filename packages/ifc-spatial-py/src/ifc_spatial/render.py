"""A plan the AGENT can look at — raster, labelled, and able to isolate.

## Why this exists next to `ifcopenshell.draw`

`tools.draw` already produces a floor plan, and it produces SVG. SVG is the
right format for a human: it scales, it prints, the frontend can hand it to a
browser. It is the wrong format for the model, and the gap is not cosmetic —
the agent generates a drawing it cannot see. It gets back a file path and a
byte count, which tells it nothing it did not already know.

A multimodal content block needs a RASTER behind its data URL, and the obvious
bridge — `cairosvg` — is not in this image and pulls native cairo, pango and
libffi behind it to serve one call. So the plan is drawn here directly, from the
same triangles every operator measures, with Pillow (already a dependency, pure
wheels).

That turned out to be the better trade for a second reason. `draw` renders the
whole storey and nothing else; what an agent actually needs is usually *this
window in that wall* — the ability to **isolate**, which is what a person does
in a viewer before they answer. `highlight` does that, and it is the parameter
this module exists for as much as the raster is.

## What a plan here is

A horizontal CUT at 1.2 m above the storey datum, which is where a floor plan is
cut by convention and, more usefully, where doors and windows are: an element
sliced at that height shows its openings as gaps, and a footprint projection
does not. Spaces are filled from their own footprint and labelled with name and
measured area, because a plan whose rooms are unnamed cannot settle "which room
did you mean".

## What it is not

It is not a source of numbers, and the caption says so where the model will read
it. Every dimension in this package is available from an operator that states
its own tolerance; a pixel measured off a raster states nothing. The drawing is
for *orientation and identification* — which element is meant, does this
arrangement look the way the numbers imply — and both of those are things a
picture does better than any table.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Any

import numpy as np

from .model import AIR_TYPES
from .model import SpatialModel

#: Height above the storey datum at which the plan is cut, metres.
#:
#: 1.2 m is the drafting convention, and it is convention for a reason that
#: matters here: it passes through every door and almost every window, so their
#: openings appear as gaps in the wall. A footprint projection — the cheaper
#: thing to build — shows a solid wall with no openings at all, which is the one
#: feature an agent looking at a plan is most likely to be asking about.
CUT_ABOVE_STOREY = 1.2

#: The most pixels this module will allocate for one plan.
#:
#: The height of a plan is not a parameter — it falls out of the model's own
#: aspect ratio, and an IFC file is untrusted input. Measured on this image with
#: ``Image.new("RGB", …)``: the sample house's default plan is 1400 × 702 px and
#: costs 4 MB; a 400 m × 2 m gallery (a real shape — a noise barrier, a covered
#: walkway, a tunnel section) derives a height of 260 942 px at the same width,
#: which is 365 megapixels and **1.41 GB** of RGB before a single line is drawn.
#: Pillow's own ``MAX_IMAGE_PIXELS`` (89 MP) does not help: it guards decoding,
#: not ``Image.new``, and the 365 MP allocation above went through it silently.
#:
#: 40 MP costs 171 MB resident, measured the same way. That is affordable in a
#: worker that also holds a parsed model, and it is 40× the largest plan anything
#: in this package actually asks for.
MAX_RASTER_PIXELS = 40_000_000

#: The widest canvas a caller may ask for. ``tools.view`` never passes
#: ``width_px`` at all, so anything above this is a library caller with a typo or
#: an argument that came from somewhere it should not have.
MAX_RASTER_WIDTH = 8_000

#: Below this the scale bar, the caption and the room labels stop being legible,
#: so a plan smaller than this is not a cheaper plan — it is a useless one.
_MIN_RASTER_EDGE = 320

#: Pixels reserved under the drawing for the caption and the scale bar.
_CAPTION_STRIP = 46

#: Anything whose triangles are drawn as background rather than as structure.
_FURNITURE = {"IfcFurniture", "IfcFurnishingElement", "IfcSystemFurnitureElement"}

#: Drawn from the cut, in draw order. Later entries paint over earlier ones.
_STRUCTURE = (
    "IfcWall",
    "IfcWallStandardCase",
    "IfcColumn",
    "IfcBeam",
    "IfcSlab",
    "IfcRoof",
    "IfcStair",
    "IfcCurtainWall",
    "IfcPlate",
    "IfcMember",
    "IfcDoor",
    "IfcWindow",
)


def _font(size: int) -> Any:
    """A legible font without depending on one being installed.

    Pillow's bitmap default is 11 px, which on a 1400 px plan is a smear the
    model cannot read — and the point of this module is that the model reads it.
    ``load_default(size=…)` ships a scalable face inside Pillow (≥10.1), so no
    system font has to exist in the image; the DejaVu path is tried first only
    because it hints better, and every failure falls back rather than raising.
    """
    from PIL import ImageFont

    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def _shorten(label: str, limit: int = 34) -> str:
    """A type name trimmed to something that fits beside a marker.

    `Windows_Sgl_Plain:1810x1210mm:286105` ran off the right edge and across the
    plan. The tail is the part worth keeping — it carries the size and the
    instance number — so the head is what gets dropped.
    """
    label = (label or "").strip()
    return label if len(label) <= limit else "…" + label[-(limit - 1) :]


def _fit_raster(
    width_px: int,
    margin_px: int,
    span_x: float,
    span_y: float,
) -> tuple[int, int, int, float]:
    """Canvas size and scale, bounded before anything is allocated.

    Returns ``(width, height, margin, scale)``.

    The height of a plan is derived, never given: ``height = span_y * scale``,
    and ``scale`` comes from the requested width divided by the model's own
    x-span. So a model that is long and thin sets the height, and an IFC file is
    untrusted input — a 400 m × 2 m gallery derives 260 942 px of height at the
    default 1400 px width, which is 1.41 GB of RGB and an OOM-killed worker
    rather than a refused request (see :data:`MAX_RASTER_PIXELS` for the
    measurements).

    What gives way is the SCALE, not the drawing. Cropping would produce a
    picture that is confidently wrong about where the building ends, which is
    the one failure this module's whole discipline is against; a plan drawn
    smaller is still a true plan, and the scale bar says by how much.
    """
    width = max(_MIN_RASTER_EDGE, min(int(width_px), MAX_RASTER_WIDTH))
    # A margin at or past half the width drives the scale to zero or negative,
    # which is a divide-by-nothing rather than a small plan.
    margin = max(0, min(int(margin_px), width // 4))

    scale = (width - 2 * margin) / span_x
    height = int(span_y * scale) + 2 * margin + _CAPTION_STRIP

    ceiling = max(_MIN_RASTER_EDGE, MAX_RASTER_PIXELS // width)
    if height > ceiling:
        scale = max(ceiling - 2 * margin - _CAPTION_STRIP, 1) / span_y
        height = int(span_y * scale) + 2 * margin + _CAPTION_STRIP
        # The width follows the shrunken drawing rather than staying where the
        # caller put it: a 2 m-wide building centred in a 1400 px page is a
        # thread of ink in an empty sheet, which reads as a broken render.
        # `width` only ever decreases here, so `width * height` stays under the
        # ceiling that was computed from the larger width.
        width = max(_MIN_RASTER_EDGE, min(width, int(span_x * scale) + 2 * margin))
    return width, height, margin, scale


_INK = (24, 24, 27)
_PAPER = (250, 250, 249)
_ROOM_FILL = (232, 237, 243)
_ROOM_EDGE = (150, 163, 180)
_FURNITURE_INK = (188, 192, 198)
_HIGHLIGHT = (220, 38, 38)
_LABEL = (63, 63, 70)


@dataclass(frozen=True)
class Plan:
    """A rendered plan and the facts about it worth putting in a caption."""

    png: bytes
    width: int
    height: int
    storey: str | None
    cut_z: float
    scale_px_per_m: float
    drawn: int
    highlighted: list[str]
    rooms: list[str]
    north_deg: float | None


def _segments_at_z(triangles: np.ndarray, z: float) -> list[tuple[float, float, float, float]]:
    """Where a triangle soup crosses the horizontal plane at ``z``.

    Plane-triangle intersection, vectorised over the whole element. A triangle
    contributes a segment when its vertices straddle the plane; the two crossing
    edges give the two endpoints by linear interpolation.

    Triangles lying exactly IN the plane are skipped rather than drawn. They are
    the top face of a slab whose surface happens to coincide with the cut, and
    drawing them fills the entire storey with ink — which is what a first
    implementation did to the sample house, producing a solid black page that
    looked like a rendering failure rather than a bad cut height.
    """
    if triangles is None or len(triangles) == 0:
        return []

    out: list[tuple[float, float, float, float]] = []
    heights = triangles[:, :, 2] - z
    above = heights > 1e-9
    below = heights < -1e-9
    # Straddles the plane only if it has a vertex strictly on each side.
    crossing = above.any(axis=1) & below.any(axis=1)
    for tri, h in zip(triangles[crossing], heights[crossing]):
        points = []
        for i in range(3):
            j = (i + 1) % 3
            if (h[i] > 0) == (h[j] > 0):
                continue
            denominator = h[i] - h[j]
            if abs(denominator) < 1e-12:
                continue
            t = h[i] / denominator
            point = tri[i] + (tri[j] - tri[i]) * t
            points.append((float(point[0]), float(point[1])))
        if len(points) >= 2:
            out.append((points[0][0], points[0][1], points[1][0], points[1][1]))
    return out


def _footprint_rings(triangles: np.ndarray) -> list[list[tuple[float, float]]]:
    """A space's plan outline, as polygons ready to fill.

    The union of the XY projection of its down- or up-facing faces — the same
    measurement `operators._footprint_area` makes, kept as geometry instead of
    reduced to a number, and taken from whichever side the mesh is wound so an
    inside-out `IfcSpace` (a Revit IFC2X3 staple) still draws.
    """
    import shapely
    import shapely.ops

    if triangles is None or len(triangles) == 0:
        return []
    edges = triangles[:, 1] - triangles[:, 0]
    others = triangles[:, 2] - triangles[:, 0]
    normals = np.cross(edges, others)
    lengths = np.linalg.norm(normals, axis=1)
    ok = lengths > 1e-12
    unit_z = np.zeros(len(triangles))
    unit_z[ok] = normals[ok][:, 2] / lengths[ok]

    best: list[list[tuple[float, float]]] = []
    best_area = 0.0
    for sign in (1.0, -1.0):
        facing = triangles[unit_z * sign > 0.01]
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
        if merged.area <= best_area:
            continue
        best_area = merged.area
        geoms = merged.geoms if hasattr(merged, "geoms") else [merged]
        best = [[(float(x), float(y)) for x, y in g.exterior.coords] for g in geoms if hasattr(g, "exterior")]
    return best


def _storey_of_interest(model: SpatialModel, storey: str | None) -> Any:
    if not model.storeys:
        return None
    if not storey:
        return model.file.by_guid(model.storeys[0].global_id)
    wanted = storey.strip().lower()
    for entry in model.storeys:
        if (entry.name or "").strip().lower() == wanted:
            return model.file.by_guid(entry.global_id)
    return None


def plan(
    model: SpatialModel,
    *,
    storey: str | None = None,
    highlight: list[str] | None = None,
    only: list[str] | None = None,
    width_px: int = 1400,
    margin_px: int = 48,
    label_rooms: bool = True,
) -> Plan | None:
    """Draw one storey as a PNG the model can be handed directly.

    ``highlight`` outlines the named elements in red and labels them; ``only``
    restricts the drawing to them entirely. The two answer different questions —
    "where is this in the building" wants the whole plan with one thing marked,
    "what does this look like" wants everything else out of the way — and
    collapsing them into one parameter forces the caller to lose one of them.

    Returns ``None`` when the storey holds nothing drawable, which the caller
    must report as such: an empty picture is indistinguishable from a broken
    renderer, and this package's whole discipline is that those two are
    different findings.
    """
    from PIL import Image
    from PIL import ImageDraw

    highlighted = {h for h in (highlight or []) if h}
    restricted = {o for o in (only or []) if o}

    target = _storey_of_interest(model, storey)
    if target is None:
        return None
    storey_name = getattr(target, "Name", None)
    elevation = next(
        (s.elevation for s in model.storeys if s.global_id == target.GlobalId),
        0.0,
    )
    cut_z = float(elevation or 0.0) + CUT_ABOVE_STOREY

    # ── collect ─────────────────────────────────────────────────────────────
    structure: list[tuple[str, list[tuple[float, float, float, float]]]] = []
    furniture: list[tuple[float, float, float, float]] = []
    rooms: list[tuple[str, list[list[tuple[float, float]]]]] = []
    room_names: list[str] = []

    for element in model.file.by_type("IfcProduct"):
        global_id = getattr(element, "GlobalId", None)
        if not global_id:
            continue
        if restricted and global_id not in restricted:
            continue
        ifc_type = element.is_a()
        own_storey = model.storey_of(element)
        # The storey filter holds in restricted mode too. `only` used to skip it,
        # so `plan(storey="Ground Floor", only=[<id on Roof>])` drew that element
        # at its own world coordinates onto a page captioned „Ground Floor,
        # Schnitt 1.20 m" — on the sample house the Roof storey's room outline
        # 09J5N7xMHBfQZeQGAEMota came back as rooms=['Roof'] on the Ground Floor
        # plan, a room that is 2.5 m above the cut. A drawing is ONE storey at ONE
        # cut height; an element from another storey drawn on it is a false
        # statement about where that element is, and `only` selects within the
        # drawing rather than overriding what the drawing is of.
        if own_storey is not None and own_storey.GlobalId != target.GlobalId:
            continue

        if ifc_type in ("IfcSpace", "IfcSpatialZone"):
            geo = model.geometry(global_id)
            if geo is None:
                continue
            rings = _footprint_rings(geo.triangles)
            if rings:
                rooms.append((global_id, rings))
                room_names.append(model.label(element) or global_id)
            continue

        if ifc_type in AIR_TYPES:
            continue
        drawable = ifc_type in _FURNITURE or ifc_type in _STRUCTURE or global_id in highlighted
        if not drawable:
            continue
        geo = model.geometry(global_id)
        if geo is None:
            continue
        segments = _segments_at_z(geo.triangles, cut_z)
        if not segments:
            continue
        if ifc_type in _FURNITURE and global_id not in highlighted:
            furniture.extend(segments)
        else:
            structure.append((global_id, segments))

    if not structure and not rooms:
        return None

    # ── world → pixels ──────────────────────────────────────────────────────
    xs: list[float] = []
    ys: list[float] = []
    for _, segments in structure:
        for x1, y1, x2, y2 in segments:
            xs += [x1, x2]
            ys += [y1, y2]
    for _, rings in rooms:
        for ring in rings:
            xs += [p[0] for p in ring]
            ys += [p[1] for p in ring]
    if not xs:
        return None

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    width_px, height_px, margin_px, scale = _fit_raster(width_px, margin_px, span_x, span_y)

    def to_px(x: float, y: float) -> tuple[float, float]:
        # Y is flipped: IFC +Y runs north and image +Y runs down, so a plan
        # drawn without the flip is mirrored — and a mirrored plan is worse
        # than none, because it is confidently wrong about which side a door
        # is on.
        return (margin_px + (x - min_x) * scale, margin_px + (max_y - y) * scale)

    image = Image.new("RGB", (width_px, height_px), _PAPER)
    canvas = ImageDraw.Draw(image, "RGBA")

    for _, rings in rooms:
        for ring in rings:
            if len(ring) >= 3:
                canvas.polygon([to_px(x, y) for x, y in ring], fill=_ROOM_FILL, outline=_ROOM_EDGE)

    for x1, y1, x2, y2 in furniture:
        canvas.line([to_px(x1, y1), to_px(x2, y2)], fill=_FURNITURE_INK, width=1)

    for global_id, segments in structure:
        marked = global_id in highlighted
        colour = _HIGHLIGHT if marked else _INK
        thickness = 4 if marked else 2
        for x1, y1, x2, y2 in segments:
            canvas.line([to_px(x1, y1), to_px(x2, y2)], fill=colour, width=thickness)

    room_font = _font(17)
    mark_font = _font(16)

    if label_rooms:
        for (global_id, rings), name in zip(rooms, room_names):
            ring = max(rings, key=len)
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
            canvas.text(to_px(cx, cy), name, fill=_LABEL, anchor="mm", font=room_font)

    for global_id in highlighted:
        try:
            element = model.file.by_guid(global_id)
        except (RuntimeError, KeyError):
            continue
        geo = model.geometry(global_id)
        if geo is None or geo.triangles is None or len(geo.triangles) == 0:
            continue
        centre = geo.triangles.reshape(-1, 3).mean(axis=0)
        px, py = to_px(float(centre[0]), float(centre[1]))
        canvas.ellipse([px - 7, py - 7, px + 7, py + 7], outline=_HIGHLIGHT, width=3)

        # OFF the element, not beside it. Placed to the right it ran off the
        # page; flipped left it printed straight across the red bar it was
        # labelling — a marker that hides what it marks. So it goes above or
        # below, whichever is further from the edge, with x clamped so a long
        # type name cannot leave the canvas either way.
        text = _shorten(model.label(element) or global_id)
        text_width = canvas.textlength(text, font=mark_font)
        label_y = py + 20 if py < height_px / 2 else py - 20
        label_x = min(max(px, margin_px + text_width / 2), width_px - margin_px - text_width / 2)
        canvas.text((label_x, label_y), text, fill=_HIGHLIGHT, anchor="mm", font=mark_font)

    # ── scale bar and north arrow ───────────────────────────────────────────
    _draw_scale_bar(canvas, margin_px, height_px - 30, scale, _font(15))
    north = _true_north_degrees(model)
    if north is not None:
        # Inset by the arrow's own reach plus the glyph, or the "N" is clipped
        # by the canvas edge — which reads as a rendering fault rather than as
        # a north arrow.
        _draw_north_arrow(canvas, width_px - margin_px - 40, margin_px + 40, north, _font(16))

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return Plan(
        png=buffer.getvalue(),
        width=width_px,
        height=height_px,
        storey=storey_name,
        cut_z=cut_z,
        scale_px_per_m=scale,
        drawn=len(structure),
        highlighted=sorted(highlighted),
        rooms=room_names,
        north_deg=north,
    )


def _draw_scale_bar(canvas: Any, x: int, y: int, scale: float, font: Any) -> None:
    """A metre bar, because a raster has no units.

    Without it the picture is unscaled and an agent has no way to know whether
    it is looking at a cupboard or a hall — and the caption's metre figures
    cannot be tied to anything on the page.
    """
    for metres in (10, 5, 2, 1):
        if metres * scale <= 220:
            break
    length = metres * scale
    canvas.line([(x, y), (x + length, y)], fill=_INK, width=3)
    for tick in (0.0, length):
        canvas.line([(x + tick, y - 6), (x + tick, y + 6)], fill=_INK, width=3)
    canvas.text((x + length + 8, y), f"{metres} m", fill=_INK, anchor="lm", font=font)


def _true_north_degrees(model: SpatialModel) -> float | None:
    """The declared north, or ``None`` — never a guess.

    An invented north arrow is worse than no north arrow: it makes an
    orientation claim about a file that never made one, on a picture that reads
    as authoritative.
    """
    for context in model.file.by_type("IfcGeometricRepresentationContext") or []:
        direction = getattr(context, "TrueNorth", None)
        ratios = getattr(direction, "DirectionRatios", None) if direction else None
        if ratios and len(ratios) >= 2:
            return math.degrees(math.atan2(float(ratios[0]), float(ratios[1])))
    return None


def _draw_north_arrow(canvas: Any, x: int, y: int, north_deg: float, font: Any) -> None:
    angle = math.radians(north_deg)
    dx, dy = math.sin(angle), -math.cos(angle)
    canvas.line([(x - dx * 18, y - dy * 18), (x + dx * 18, y + dy * 18)], fill=_INK, width=3)
    canvas.text((x + dx * 26, y + dy * 26), "N", fill=_INK, anchor="mm", font=font)


__all__ = ["CUT_ABOVE_STOREY", "Plan", "plan"]
