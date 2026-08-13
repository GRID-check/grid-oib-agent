"""The thermal envelope — the geometry every OIB-6 energy calculation starts from.

Three operators, and between them they answer the three questions that come
before any Energieausweis: **which** elements separate heated inside from
outside, **how much** area each compass bearing carries and how much of it is
glass, and **how compact** the resulting body is.

Not to be confused with :mod:`ifc_spatial.envelope`, which is the answer
contract (``Answer``, ``computed``, ``undecidable``) and has nothing to do with
buildings. This module imports it like every other operator module does.

## The line this module does not cross

OIB Richtlinie 6 names maximum U-values, reference values and an
Energiekennzahl. **None of them are in here, and none of them may ever be.**
This layer measures; the Bestimmung decides. So there is no threshold, no
"erfüllt", no energy rating, and no U-value limit anywhere below — for the same
reason :func:`~ifc_spatial.operators.prism` takes its 45° as a parameter and
:func:`~ifc_spatial.operators.light_entry_area` refuses to apply the percentage
it computes against.

The sharpest form of that boundary is the U-value itself. Where an export
DECLARES ``ThermalTransmittance``, it is reported as ``declared`` and passed
through untouched. It is never recomputed from the material layers, even though
the layers are usually right there in ``IfcMaterialLayerSet``: a U-value derived
from a layer list is a *different number* from the one the architect signed —
different in the surface resistances, in the Wärmebrückenzuschlag, and in which
layer counts as the load-bearing one — and quietly substituting ours for theirs
would put our arithmetic behind their signature. The sample house declares
0.2359 W/(m²·K) on its external walls and 6.7069 on its curtain-wall panes;
those two numbers travel out of here exactly as they came in.

## Which route decided each element, and why that has to be visible

An element is in the envelope by one of two routes, tried in this order:

1. **``Pset_*Common.IsExternal``** — the architect's own statement, and it wins
   outright. ``operators._faces_outside`` already establishes exactly this
   ordering for openings, so openings are handed to it rather than to a second,
   differently-wrong copy of the same rule.
2. **The spaces the element bounds.** An element that bounds exactly one
   ``IfcSpace`` has outside on its other face, because there is no IfcSpace
   outdoors. Two or more spaces means it separates rooms. Weaker than a
   declaration — a wall onto an unmodelled Wintergarten reads as external — so
   it is second, and it says so in every entry it decides.

The route travels with each element because the two are not equally trustworthy
and a reader who cannot tell them apart cannot weight them. It also surfaces
findings that no total would: in the sample house the ground slab
``3cUkl32yn9qRSPvBJVyWgQ`` declares ``Pset_SlabCommon.IsExternal = False`` and is
therefore **not** in the envelope here, all 146.199 m² of it — because IFC's
``IsExternal`` means "gegen Außenluft" while OIB 6 counts a Bodenplatte gegen
Erdreich as part of the thermal envelope. That is a finding about the export the
architect can act on, and it is named rather than silently corrected: overruling
a declaration with our own guess is the substitution this package exists to
prevent.

## How an area is measured, and against what it was checked

Each element is measured on its own dominant plane:

- **Vertical elements** (walls, panes, windows, doors) — the union of the faces
  lying in that plane, i.e. ``operators._clear_opening_area``, the same
  projection the daylight operators use. For a wall that is the elevation area
  with the window and door holes already subtracted, which is what makes
  wall + opening add back up to the gross facade instead of double-counting it:
  the sample house's south wall measures 19.254 m² against a gross
  8.955 × 2.821 = 25.262 m² and its door (3.809) and window (2.190) close the
  gap to the millimetre.
- **Horizontal elements** (slabs, roofs) — two numbers, because a pitched or
  curved roof has two and an energy calculation wants the larger.
  ``projectedArea`` is ``operators._footprint_area``, the plan projection;
  ``area`` is the developed surface, the one-sided sum over the faces that are
  not vertical.

Both routes are checked against a declaration this module does not otherwise
use. ``Pset_RoofCommon`` of the sample house's roof states
``TotalArea = 117.4305`` and ``ProjectedArea = 108.1177``; measured here they
come out at **117.3984** (0.03 % apart) and **108.1157** (0.002 % apart). Two
independent statements about a 390-triangle curved shell agreeing to that is the
only reason the developed area is trusted as the primary one.

## What is left out, and by how much

Curtain-wall **mullions** (``IfcMember``) are not counted: the brief for the
envelope is walls, slabs, roofs, windows, doors and panes. In the sample house
that is 20 members totalling 1.311 m², which is why its west facade comes back
at a window-to-wall ratio of 1.0 — a fully glazed elevation with no opaque area
at all in the count. The caveat names the number so nobody has to rediscover it.
"""

from __future__ import annotations

from typing import Any

import ifcopenshell.util.element as ue
import numpy as np

from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import triangulate
from .envelope import undecidable
from .geometry import triangle_normals_areas
from .model import SpatialModel
from .operators import AREA_RELATIVE_TOLERANCE
from .operators import COMPASS
from .operators import _clear_opening_area
from .operators import _faces_outside
from .operators import _footprint_area
from .operators import azimuth
from .operators import enclosed_by

# ── what counts as envelope, and what it is called in German ────────────────
#
# Ordered: the report is read top to bottom and an architect reads a facade
# before a roof. `IfcCurtainWall` is in the list even though it almost never
# carries a body of its own — it is a real envelope element and leaving it out
# would make the count of external elements disagree with the file.

_KIND_OF_TYPE: dict[str, str] = {
    "IfcWall": "Wand",
    "IfcWallStandardCase": "Wand",
    "IfcCurtainWall": "Wand",
    "IfcSlab": "Boden/Decke",
    "IfcRoof": "Dach",
    "IfcWindow": "Fenster",
    "IfcWindowStandardCase": "Fenster",
    "IfcDoor": "Tür",
    "IfcDoorStandardCase": "Tür",
    "IfcPlate": "Verglasungsfeld",
}

#: The order kinds are reported in. Not `sorted()`: a stable, meaningful order is
#: what lets two runs of the same model be diffed by eye.
KIND_ORDER = ["Wand", "Fenster", "Tür", "Verglasungsfeld", "Boden/Decke", "Dach"]

#: Types whose area is counted as TRANSPARENT.
#:
#: A curtain-wall ``IfcPlate`` is a pane in this file (``System Panel:Glazed``,
#: material ``Glass``, declared U 6.7069) and in most exports, but the type says
#: nothing: a spandrel panel is an ``IfcPlate`` too and is opaque. The
#: misclassification is named in the caveat rather than guessed at from a vendor
#: material name, because a wrong glass fraction moves an energy balance more
#: than almost anything else this module reports.
TRANSPARENT_TYPES = {"IfcWindow", "IfcWindowStandardCase", "IfcPlate"}

#: Types handed to :func:`~ifc_spatial.operators._faces_outside` rather than
#: decided here. That function already runs declaration → host wall → space
#: count for openings and panes, and a second implementation of the same ladder
#: is a second place for it to go wrong.
_OPENING_TYPES = {"IfcWindow", "IfcWindowStandardCase", "IfcDoor", "IfcDoorStandardCase", "IfcPlate"}

#: Relative error on a volume. A volume is a threefold product of lengths where
#: an area is a twofold one, so it carries half again the relative error of
#: :data:`~ifc_spatial.operators.AREA_RELATIVE_TOLERANCE` — derived from it
#: rather than picked, so the two cannot drift apart.
VOLUME_RELATIVE_TOLERANCE = 1.5 * AREA_RELATIVE_TOLERANCE

#: |n_z| above which a face counts as part of a floor or roof surface rather
#: than as an edge of it. This is IfcOpenShell's own ``normal_tol`` and the same
#: value ``operators._footprint_area`` projects with, so the developed area and
#: the projected area are taken over the identical set of faces.
_HORIZONTAL_NORMAL_TOLERANCE = 0.01

#: Above this relative difference, an element's developed surface and its plan
#: projection are reported as two different numbers instead of one. Below it they
#: are the same flat slab measured twice.
SLOPE_REPORT_FRACTION = 0.01


# ── measuring one element ───────────────────────────────────────────────────


def _declared_u_value(element: Any) -> tuple[float | None, str | None]:
    """The declared ``ThermalTransmittance`` and the pset it was declared in.

    Read, never derived. The pset PATH comes back with the value for the same
    reason :class:`~ifc_spatial.model.DeclaredQuantity` carries one: a reviewer
    checking a U-value needs to find it in their own software, and
    ``Pset_WallCommon`` and a vendor pset are not equally authoritative.
    """
    psets = ue.get_psets(element, qtos_only=False) or {}
    for pset_name, values in psets.items():
        if not isinstance(values, dict):
            continue
        found = values.get("ThermalTransmittance")
        if isinstance(found, (int, float)) and not isinstance(found, bool):
            return float(found), f"{pset_name}.ThermalTransmittance"
    return None, None


def _developed_horizontal_area(triangles: np.ndarray) -> float:
    """The developed (abgewickelte) area of a floor or roof shell, in m².

    The one-sided sum over the non-vertical faces, taken for both signs with the
    larger winning — the same fold ``operators._footprint_area`` performs, and
    for the same reason: the winding of an exported mesh does not reliably say
    which side faces the weather, and a Revit ``IfcSpace`` really does come out
    inside out.

    Why this rather than the projection, for the number that goes into A: a
    curved or pitched roof loses its slope in plan. The sample house's roof is
    390 triangles over a barrel, and the two differ by 8.6 % — 117.398 m² of
    surface against 108.116 m² of footprint. Heat leaves through the surface.

    Why the projection is still reported beside it: this sum cannot union, so a
    slab modelled as one solid with its screed on top would count both of its
    horizontal faces. The projection cannot double-count and the developed area
    cannot lose a slope, so both travel and the caveat names the difference.
    """
    normals, areas = triangle_normals_areas(triangles)
    upward = normals[:, 2]
    return max(
        float(areas[upward > _HORIZONTAL_NORMAL_TOLERANCE].sum()),
        float(areas[upward < -_HORIZONTAL_NORMAL_TOLERANCE].sum()),
    )


def _element_area(model: SpatialModel, element: Any) -> dict[str, Any]:
    """This element's envelope area, on whichever of its two planes is larger.

    The branch is decided by measurement rather than by IFC type, because the
    type is not a reliable statement about orientation — an ``IfcSlab`` can be a
    wall panel and an ``IfcRoof`` in this file is a curved shell whose largest
    vertical face is a 4.5 m² fascia. Both candidate areas are computed and the
    bigger one is the element's face: the sample house's ground slab measures
    7.9 m² vertically against 146.2 m² in plan, its north wall 27.4 m²
    vertically against 4.1 m² in plan, and neither needs a type to say so.

    Returns a dict with ``area`` (``None`` when nothing could be measured),
    ``projectedArea`` — the projection onto that same plane, identical to
    ``area`` for a planar element and smaller for a sloped or curved one —
    ``via`` in German, and ``horizontal``.
    """
    geometry = model.geometry(element.GlobalId)
    if geometry is None:
        reason = model.geometry_failure(element.GlobalId) or ""
        if reason.startswith(("shape-failed", "empty-mesh")):
            why = "Körpergeometrie vorhanden, aber vom Geometriekern nicht auswertbar"
        elif element.is_a() == "IfcCurtainWall":
            # Not a defect. A curtain wall exports its geometry through its
            # panels and mullions; the shell itself legitimately has no body,
            # and `facade_plane_of` says the same thing about the same file.
            why = "kein eigener Körper — eine Vorhangfassade trägt ihre Geometrie über Paneele und Pfosten"
        else:
            why = "keine Körpergeometrie in dieser Datei"
        return {"area": None, "projectedArea": None, "via": why, "horizontal": None}

    # The vertical candidate is `_clear_opening_area`, unchanged: the element's
    # faces projected onto its own dominant vertical plane and unioned. On a
    # wall that subtracts the window and door holes, which is what keeps the
    # wall and its openings from being counted twice over.
    vertical = _clear_opening_area(model, element)
    projected = _footprint_area(geometry.triangles)

    if vertical is not None and vertical >= projected:
        return {
            "area": round(vertical, 6),
            "projectedArea": round(vertical, 6),
            "via": "Ansichtsfläche in der Bauteilebene (Öffnungen abgezogen)",
            "horizontal": False,
        }
    if projected <= 0.0:
        return {
            "area": None,
            "projectedArea": None,
            "via": "Körper ohne auswertbare Fläche (weder senkrechte Ebene noch Grundrissfläche)",
            "horizontal": None,
        }

    developed = _developed_horizontal_area(geometry.triangles)
    area = max(developed, projected)
    return {
        "area": round(area, 6),
        "projectedArea": round(projected, 6),
        "via": (
            "abgewickelte Oberfläche (geneigt oder gekrümmt)"
            if area > projected * (1.0 + SLOPE_REPORT_FRACTION)
            else "Grundrissprojektion"
        ),
        "horizontal": True,
    }


#: The route label for an element decided by somebody's declaration of
#: ``IsExternal``, and for one decided by counting the spaces it bounds.
ROUTE_DECLARED = "IsExternal (deklariert)"
ROUTE_BOUNDED_SPACES = "Raumbegrenzung"
ROUTE_UNDECIDED = "unbestimmt"


def _external_route(model: SpatialModel, element: Any) -> tuple[bool | None, str, str]:
    """Whether this element separates inside from outside, what route said so,
    and the sentence that route wrote.

    Openings and panes go to :func:`~ifc_spatial.operators._faces_outside`
    untouched — declaration on the element, then the host wall's declaration,
    then the count of spaces the opening touches. Everything else runs the same
    ladder without the middle rung, which does not apply to a wall:

    1. ``Pset_*Common.IsExternal`` on the element itself.
    2. The number of spaces it bounds. Exactly one and the other face is
       outside, because no ``IfcSpace`` is ever modelled outdoors; two or more
       and it is a Trennbauteil. Zero decides nothing — an element the export
       assigned to no room is not thereby an external one.

    Note that rung 2 is not always geometry: :func:`~ifc_spatial.operators.enclosed_by`
    answers from ``IfcRelSpaceBoundary`` when the export writes them (as
    ``geschossdecke-und-fenster.ifc`` does, which has boundaries and no bodies at
    all) and derives them from the solids only when it must. Its provenance is
    carried through instead of being assumed, because "die Datei sagt, diese Wand
    begrenzt zwei Räume" and "wir haben zwei Räume daran gemessen" are different
    claims.

    ``None`` is a real answer and must be reported as such. Guessing here is how
    a 146 m² floor slab silently joins or leaves an envelope area.
    """
    if element.is_a() in _OPENING_TYPES:
        outside, why = _faces_outside(model, element)
        if outside is None:
            return None, ROUTE_UNDECIDED, why
        # Matched on the property path rather than on the word "deklariert",
        # which also appears in that function's undecided sentence — a substring
        # test there would file an undecided element under the declared route.
        route = ROUTE_DECLARED if why.startswith("Pset_") else ROUTE_BOUNDED_SPACES
        return outside, route, why

    own = model.declared_property(element, ("IsExternal",))
    if isinstance(own, bool):
        return own, ROUTE_DECLARED, "Pset_*Common.IsExternal am Bauteil selbst (deklariert)"

    spaces = enclosed_by(model, element.GlobalId)
    if spaces.decidable and spaces.value is not None:
        source = "deklarierte Raumgrenzen" if spaces.provenance == "declared" else "aus der Geometrie abgeleitet"
        count = len(spaces.value)
        if count >= 2:
            return False, ROUTE_BOUNDED_SPACES, f"begrenzt {count} Räume (Trennbauteil, {source})"
        if count == 1:
            return (
                True,
                ROUTE_BOUNDED_SPACES,
                f"begrenzt genau einen Raum — auf der anderen Seite liegt kein IfcSpace ({source})",
            )
        return None, ROUTE_UNDECIDED, f"berührt keinen Raum ({source}) — daraus folgt weder außen noch innen"
    return None, ROUTE_UNDECIDED, "weder IsExternal deklariert noch aus den Raumberührungen ableitbar"


def _survey(model: SpatialModel) -> list[dict[str, Any]]:
    """Every candidate envelope element, classified and measured, once.

    Shared by all three operators so that they cannot disagree with each other
    about which wall is external — three separate scans is three chances for the
    orientation report and the A/V ratio to be built on different sets.
    """
    found: list[dict[str, Any]] = []
    for element in model.file.by_type("IfcProduct"):
        kind = _KIND_OF_TYPE.get(element.is_a())
        if kind is None:
            continue
        external, route, because = _external_route(model, element)
        entry: dict[str, Any] = {
            "globalId": element.GlobalId,
            "ifcType": element.is_a(),
            "name": model.label(element),
            "kind": kind,
            "external": external,
            "route": route,
            "because": because,
            "transparent": element.is_a() in TRANSPARENT_TYPES,
        }
        entry.update(_element_area(model, element))
        u_value, u_path = _declared_u_value(element)
        entry["thermalTransmittance"] = u_value
        entry["thermalTransmittanceVia"] = u_path
        found.append(entry)
    found.sort(key=lambda e: (KIND_ORDER.index(e["kind"]), e["globalId"]))
    return found


def _no_envelope(method: str, surveyed: list[dict[str, Any]]) -> Answer[Any]:
    """Nothing in this file could be placed on the outside — a named refusal.

    Deliberately not an empty envelope. "Dieses Gebäude hat keine Außenbauteile"
    is a statement about a building; the truth is a statement about an export
    that declares no ``IsExternal`` and models no rooms to derive it from. The
    two cases are told apart, because they send the architect to different
    settings: a file with no candidate elements at all (an infrastructure model,
    a structure-only export) is not a file whose walls forgot to say which side
    they face.
    """
    if not surveyed:
        return undecidable(
            from_=[],
            method=method,
            provenance="declared",
            missing=MissingFact(
                what="keine Bauteile der thermischen Hülle (Wand, Decke, Dach, Fenster, Tür, Paneel)",
                remedy=(
                    "Diese Datei enthält keinen einzigen IfcWall, IfcSlab, IfcRoof, IfcWindow, IfcDoor oder "
                    "IfcPlate. Entweder ist es kein Hochbaumodell (eine Infrastruktur- oder Geländedatei), oder "
                    "der Export enthält nur die räumliche Struktur ohne Bauteile."
                ),
            ),
        )
    candidates = [e["globalId"] for e in surveyed]
    return undecidable(
        from_=candidates,
        method=method,
        provenance="declared",
        missing=MissingFact(
            what="Pset_*Common.IsExternal und keine aus der Geometrie ableitbare Raumbegrenzung",
            remedy=(
                f"In dieser Datei stehen {len(candidates)} Bauteile, die zur thermischen Hülle gehören könnten, "
                "aber für keines davon ist entscheidbar, ob es außen liegt: es ist weder IsExternal deklariert "
                "noch berührt es genau einen Raum. Abhilfe: im CAD die Außenbauteile als außenliegend kennzeichnen "
                "(Pset_WallCommon.IsExternal und die entsprechenden Psets für Decke, Dach, Fenster, Tür, Paneel) "
                "und die Räume als IfcSpace mit Körpergeometrie mitexportieren. Ohne eines von beiden ist keine "
                "Hüllfläche bestimmbar, und eine geratene wäre in einer Energiebilanz nicht zu erkennen."
            ),
            elements=candidates or None,
        ),
    )


# ════════════════════════════════════════════════════════════════════════════
# the operators
# ════════════════════════════════════════════════════════════════════════════


def thermal_envelope(model: SpatialModel) -> Answer[dict[str, Any]]:
    """Which elements form the boundary between heated inside and outside.

    The first thing an OIB 6 calculation needs and the one thing this engine had
    nothing for. Every element is placed by the ladder in :func:`_external_route`
    — declaration first, geometry second — and every entry says which rung
    decided it, because "the architect wrote IsExternal = True" and "it touches
    one room, so probably" are not the same claim and a total that mixes them
    without saying so cannot be argued with.

    Returned grouped by kind, with each element's own area, its declared U-value
    where the file states one, and the two lists that make the total checkable:
    ``innenliegend`` (decided, and left out) and ``unbestimmt`` (not decided,
    and therefore neither counted nor discarded).

    On the sample house the declared route decides all 23 candidates outright —
    5 walls, 2 curtain-wall shells, 6 panes, 4 windows, 3 doors, 2 slabs and
    1 roof. 17 of them are external and 15 of those carry a measurable area,
    **225.700 m²** in total; the two without one are the curtain-wall shells,
    which legitimately have no body of their own. The two slabs are not in the
    envelope at all: both declare ``IsExternal = False``, including the
    146.199 m² ground slab, which is exactly the finding an architect wants back
    rather than an area quietly adjusted to look right.

    No threshold, no U-value limit, no verdict. A U-value that the file declares
    is repeated; a U-value that it does not is absent, never derived from the
    layers.
    """
    method = "thermalEnvelope()"
    surveyed = _survey(model)
    outside = [e for e in surveyed if e["external"] is True]
    inside = [e for e in surveyed if e["external"] is False]
    unknown = [e for e in surveyed if e["external"] is None]
    if not outside:
        return _no_envelope(method, surveyed)

    by_kind: dict[str, list[dict[str, Any]]] = {}
    area_by_kind: dict[str, float] = {}
    for entry in outside:
        by_kind.setdefault(entry["kind"], []).append(entry)
        if entry["area"] is not None:
            area_by_kind[entry["kind"]] = round(area_by_kind.get(entry["kind"], 0.0) + entry["area"], 6)

    measured = [e for e in outside if e["area"] is not None]
    without_area = [e for e in outside if e["area"] is None]
    # None, not 0.0, when nothing could be measured. A confident zero is a number
    # an agent will put in a sentence, and "die Hüllfläche beträgt 0 m²" is the
    # worst thing this module could say about a file that simply has no bodies.
    total = round(sum(e["area"] for e in measured), 6) if measured else None

    routes: dict[str, int] = {}
    for entry in outside:
        routes[entry["route"]] = routes.get(entry["route"], 0) + 1

    caveat = (
        "Zugehörigkeit zur Hülle: erst die Deklaration (Pset_*Common.IsExternal), dann die Geometrie (ein "
        "Bauteil, das genau einen Raum begrenzt). Jeder Eintrag nennt unter „because“, welcher der beiden Wege "
        "ihn entschieden hat — die beiden sind nicht gleich belastbar. Kein Grenzwert, kein U-Wert-Höchstwert "
        "und keine Bewertung: erklärte U-Werte werden weitergereicht, nie aus den Schichten nachgerechnet."
    )
    slabs_inside = [e for e in inside if e["kind"] == "Boden/Decke" and e["area"]]
    if slabs_inside:
        # The sample house's 146.199 m² ground slab lands here. Loud, because a
        # reader who does not notice it is short an entire floor of envelope.
        named = ", ".join(f"{e['name'] or e['globalId']} ({e['area']:.3f} m²)" for e in slabs_inside[:3])
        caveat += (
            f" ACHTUNG: {len(slabs_inside)} Boden- bzw. Deckenbauteil(e) sind als IsExternal = False deklariert "
            f"und deshalb NICHT in der Hülle enthalten: {named}. In IFC heißt „external“ gegen Außenluft, "
            "während eine Bodenplatte gegen Erdreich nach OIB 6 sehr wohl zur wärmeübertragenden Hülle zählt. "
            "Diese Deklaration wird hier nicht überstimmt — das wäre eine Vermutung an der Stelle einer Aussage. "
            "Abhilfe: im CAD entscheiden, ob die Bodenplatte außenliegend gekennzeichnet gehört."
        )
    if without_area:
        caveat += (
            f" Für {len(without_area)} außenliegende(s) Bauteil(e) ist keine Fläche messbar; sie stehen mit "
            "area = null in der Liste und fehlen in der Summe, die insofern eine Untergrenze ist."
        )
    if unknown:
        caveat += (
            f" Bei {len(unknown)} Bauteil(en) ließ sich außen/innen nicht bestimmen — sie sind WEDER "
            "eingerechnet noch verworfen und stehen unter „unbestimmt“."
        )
    members = len(model.file.by_type("IfcMember"))
    if members:
        caveat += (
            f" Nicht enthalten sind {members} IfcMember (Pfosten und Riegel einer Vorhangfassade): gezählt "
            "werden Wände, Decken, Dächer, Fenster, Türen und Paneele. Bei einer Pfosten-Riegel-Fassade fehlt "
            "damit der Rahmenanteil."
        )

    return computed(
        {
            "byKind": {kind: by_kind[kind] for kind in KIND_ORDER if kind in by_kind},
            "areaByKind": area_by_kind,
            "totalArea": total,
            "elementCount": len(outside),
            "routes": routes,
            "innenliegend": inside,
            "unbestimmt": unknown,
        },
        unit="m²",
        tolerance=abs(total) * AREA_RELATIVE_TOLERANCE if total else None,
        from_=[e["globalId"] for e in outside],
        method=method,
        caveat=caveat,
    )


def envelope_area_by_orientation(model: SpatialModel) -> Answer[dict[str, Any]]:
    """The envelope area per compass bearing, opaque and transparent apart.

    A facade's glass fraction is what an energy balance turns on — solar gain in
    one direction, transmission loss in every direction — so the split is the
    point of the operator and the totals are a by-product of it. Each bearing
    reports ``opaque``, ``transparent``, ``total`` and the
    **window-to-wall ratio** ``transparent / total``.

    Measured on the sample house, whose north wall
    ``3cUkl32yn9qRSPvBJVyWw5`` bears 0°:

    ======  ========  =============  =====
    Bearing  opak      transparent    WWR
    ======  ========  =============  =====
    N        27.408    6.574          19.4 %
    O        17.981    0.000           0.0 %
    S        23.062   15.673          40.5 %
    W         0.000   17.604         100.0 %
    ======  ========  =============  =====

    The 100 % on the west is not a bug and not rounded away: that elevation is a
    curtain wall whose three panes are the entire facade, and the mullions that
    would be its opaque share are ``IfcMember`` and out of scope. A caveat says
    so, because a WWR of 1.0 read without that sentence is a modelling error
    rather than a building.

    ## Without a declared north

    ``operators.azimuth`` refuses without
    ``IfcGeometricRepresentationContext.TrueNorth``, and it is right to: a
    building rotated 40° would be reported as having a south facade it does not
    have, and nothing in the answer would show it. So this operator does not
    invent one either. On such a file — ``haus-mit-raeumen.ifc`` is one — the
    areas still come back, opaque and transparent still separated, with
    ``orientationKnown`` false, no ``byOrientation`` at all, and the German
    remedy for setting the north. Withholding a correct total area over a
    compass question nobody asked would be the worse failure.

    Horizontal elements have no bearing by construction and are reported under
    ``ohneAusrichtung`` rather than folded into a direction.
    """
    method = "envelopeAreaByOrientation()"
    surveyed = _survey(model)
    outside = [e for e in surveyed if e["external"] is True]
    if not outside:
        return _no_envelope(method, surveyed)

    measured = [e for e in outside if e["area"] is not None]
    if not measured:
        return undecidable(
            from_=[e["globalId"] for e in outside],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="keine messbare Fläche an den außenliegenden Bauteilen",
                remedy=(
                    f"Die Datei kennzeichnet {len(outside)} Bauteile als außenliegend, aber keines davon trägt "
                    "einen auswertbaren Körper. Das Modell mit Körpergeometrie neu exportieren "
                    "(Body-Repräsentation, kein reiner Bounding-Box-Export)."
                ),
                elements=[e["globalId"] for e in outside],
            ),
        )

    vertical = [e for e in measured if e["horizontal"] is False]
    horizontal = [e for e in measured if e["horizontal"] is not False]
    opaque_total = round(sum(e["area"] for e in measured if not e["transparent"]), 6)
    transparent_total = round(sum(e["area"] for e in measured if e["transparent"]), 6)
    whole = opaque_total + transparent_total

    payload: dict[str, Any] = {
        "orientationKnown": model.true_north is not None,
        "opaque": opaque_total,
        "transparent": transparent_total,
        "total": round(whole, 6),
        "windowWallRatio": round(transparent_total / whole, 6) if whole > 0 else None,
        "ohneAusrichtung": [
            {"globalId": e["globalId"], "name": e["name"], "kind": e["kind"], "area": e["area"]} for e in horizontal
        ],
    }

    caveat = (
        "Transparent sind IfcWindow und IfcPlate, opak alles Übrige. Ein Paneel einer Vorhangfassade IST in "
        "diesem Modell verglast (System Panel:Glazed), aber der IFC-Typ sagt das nicht: ein Brüstungspaneel ist "
        "ebenfalls ein IfcPlate und wäre hier fälschlich als Glas gezählt. Eine verglaste Tür zählt umgekehrt "
        "als opak. Kein Grenzwert und keine Bewertung — der Fensterflächenanteil ist eine Messung."
    )
    if horizontal:
        caveat += (
            f" {len(horizontal)} waagrechte(s) Bauteil(e) (Dach, Decke, Bodenplatte) haben keine Himmelsrichtung "
            "und stehen unter „ohneAusrichtung“; sie sind in „opaque“/„transparent“ enthalten, aber in keiner "
            "Richtung."
        )

    if model.true_north is None:
        # Decidable, and deliberately so: the areas were measured and are true.
        # Only the compass is missing, and inventing one is the failure mode
        # `azimuth` exists to refuse.
        caveat += (
            " Diese Datei deklariert keine Nordrichtung "
            "(IfcGeometricRepresentationContext.TrueNorth), deshalb sind die Flächen OHNE Himmelsrichtungen "
            "ausgegeben. Sie werden nicht geraten: die Modellachse +Y ist nur dann Norden, wenn es jemand gesagt "
            "hat, und ein um 40° gedrehtes Gebäude bekäme sonst eine Südfassade, die es nicht hat. Abhilfe: die "
            "Nordrichtung im CAD setzen und mitexportieren."
        )
        return computed(
            payload,
            unit="m²",
            tolerance=abs(whole) * AREA_RELATIVE_TOLERANCE,
            from_=[e["globalId"] for e in measured],
            method=method,
            caveat=caveat,
        )

    by_orientation: dict[str, dict[str, Any]] = {}
    unoriented: list[dict[str, Any]] = []
    for entry in vertical:
        bearing = azimuth(model, entry["globalId"])
        if not bearing.decidable or bearing.value is None:
            unoriented.append({"globalId": entry["globalId"], "name": entry["name"], "area": entry["area"]})
            continue
        bucket = by_orientation.setdefault(
            bearing.value["compass"],
            {"opaque": 0.0, "transparent": 0.0, "total": 0.0, "windowWallRatio": None, "elements": []},
        )
        bucket["transparent" if entry["transparent"] else "opaque"] += entry["area"]
        bucket["elements"].append(
            {
                "globalId": entry["globalId"],
                "name": entry["name"],
                "kind": entry["kind"],
                "area": entry["area"],
                "degrees": round(float(bearing.value["degrees"]), 3),
                "transparent": entry["transparent"],
            }
        )

    for bucket in by_orientation.values():
        bucket["opaque"] = round(bucket["opaque"], 6)
        bucket["transparent"] = round(bucket["transparent"], 6)
        bucket["total"] = round(bucket["opaque"] + bucket["transparent"], 6)
        bucket["windowWallRatio"] = round(bucket["transparent"] / bucket["total"], 6) if bucket["total"] > 0 else None

    fully_glazed = [name for name, bucket in by_orientation.items() if bucket["windowWallRatio"] == 1.0]
    if fully_glazed:
        caveat += (
            f" Der Fensterflächenanteil ist auf {', '.join(sorted(fully_glazed))} genau 1,0 — an dieser Fassade "
            "ist keine opake Fläche gezählt. Das ist die Vorhangfassade: ihre Pfosten und Riegel sind IfcMember "
            "und gehören nicht zu den hier gezählten Bauteilarten, und die IfcCurtainWall selbst trägt keinen "
            "eigenen Körper. Der Rahmenanteil fehlt also, er ist nicht null."
        )
    if unoriented:
        caveat += (
            f" {len(unoriented)} senkrechte(s) Bauteil(e) haben keine bestimmbare Himmelsrichtung und sind in "
            "keiner Richtung enthalten, wohl aber in den Summen."
        )

    payload["byOrientation"] = {name: by_orientation[name] for name in COMPASS if name in by_orientation}
    payload["ohneHimmelsrichtung"] = unoriented
    return computed(
        payload,
        unit="m²",
        tolerance=abs(whole) * AREA_RELATIVE_TOLERANCE,
        from_=[e["globalId"] for e in measured],
        method=method,
        caveat=caveat,
    )


def _space_volume(model: SpatialModel, space: Any) -> float | None:
    """The volume of one space solid, in m³, straight off its triangulation.

    The divergence theorem over the mesh — ``Σ a · (b × c) / 6``, absolute — and
    not ``ifcopenshell.util.shape.get_volume``, which agrees to the last bit
    (129.98706250000038 m³ for this file's living room, both ways) and is unsafe
    to call here. ``get_volume`` takes the live ``Triangulation``, whose ``verts``
    and ``faces`` are views into the shape's C++ buffer; ``SpatialModel`` hands
    that out from :meth:`~ifc_spatial.model.SpatialModel.triangulation` and then
    OVERWRITES ``_shapes[global_id]`` the next time
    :meth:`~ifc_spatial.model.SpatialModel.geometry` is called for the same
    element, which frees the buffer under the caller's feet. Measured on this
    fixture: ``get_volume`` returns 129.987 before the ``geometry()`` call and
    raises ``IndexError: list index out of range`` after it. ``ElementGeometry``
    holds NumPy copies and cannot be pulled out from under anyone.
    """
    geometry = model.geometry(space.GlobalId)
    if geometry is None or len(geometry.triangles) == 0:
        return None
    triangles = geometry.triangles
    signed = np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2]))
    return float(abs(signed.sum()) / 6.0)


def compactness(model: SpatialModel) -> Answer[dict[str, Any]]:
    """The A/V ratio — envelope area over heated volume, in 1/m.

    A standard OIB 6 input and the reciprocal of the *charakteristische Länge*
    ``l_c = V/A``, which is reported beside it because half the Austrian
    literature is written in one and half in the other.

    A and V both come back separately, and that is not decoration: a ratio whose
    two inputs are invisible cannot be checked by the person who signs it, and
    the two inputs here are not measured the same way and do not sit on the same
    reference surface.

    ## Which volume, said out loud

    **The volume is the net one.** It is the sum of the ``IfcSpace`` solids —
    room air, bounded by the finished inner faces — and it is preferred over
    everything else because it is the only volume in the file that was modelled
    rather than inferred. A GROSS volume is bounded by the outer face of the
    construction and is larger by the whole build-up: with 290 mm external walls
    and a 470 mm floor, the difference on a house this size is tens of cubic
    metres. An energy calculation names which of the two it wants, and this one
    is the net one — so a caller that needs gross has to add the construction
    itself, from a number this module does not have.

    A is measured on the OUTER faces of the envelope elements. So the ratio
    mixes an outer-face area with an inner-face volume and is therefore slightly
    LARGER than a consistently gross A/V. Stated rather than corrected: the
    correction needs a thickness per element that only the layer sets know, and
    inventing one would put a fabricated number where a measured one belongs.

    Where the spaces declare a volume, the measured one is triangulated against
    it — agreement raises confidence, disagreement is a finding about the export.
    On the sample house all four spaces declare ``BaseQuantities.GrossVolume``
    and every one of them matches the mesh exactly (129.987 / 38.542 / 21.734 /
    76.466 m³, summing to 266.728 m³), so the two routes agree.

    Measured on the sample house: **A = 225.700 m², V = 266.728 m³,
    A/V = 0.846 1/m**, characteristic length l_c = 1.182 m.

    No threshold. OIB 6 relates a permitted Heizwärmebedarf to l_c; that
    relation belongs to the Bestimmung and not to a measuring instrument.
    """
    method = "compactness()"
    surveyed = _survey(model)
    outside = [e for e in surveyed if e["external"] is True]
    if not outside:
        return _no_envelope(method, surveyed)

    measured = [e for e in outside if e["area"] is not None]
    without_area = [e for e in outside if e["area"] is None]
    if not measured:
        return undecidable(
            from_=[e["globalId"] for e in outside],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="keine messbare Hüllfläche",
                remedy=(
                    f"Die Datei kennzeichnet {len(outside)} Bauteile als außenliegend, aber keines trägt einen "
                    "auswertbaren Körper — ohne Fläche gibt es kein A/V. Das Modell mit Körpergeometrie neu "
                    "exportieren."
                ),
                elements=[e["globalId"] for e in outside],
            ),
        )
    area = round(sum(e["area"] for e in measured), 6)

    spaces = model.file.by_type("IfcSpace")
    volumes: list[dict[str, Any]] = []
    without_body: list[Any] = []
    declared_total = 0.0
    declared_count = 0
    for space in spaces:
        volume = _space_volume(model, space)
        found = model.declared_quantity(space, ("NetVolume", "GrossVolume"))
        if volume is None:
            # The declared value is NOT accumulated for a space we could not
            # measure. Σ(declared over N spaces) against Σ(measured over N−1) is
            # not two routes to one number, it is two different questions, and
            # `triangulate` publishes the shortfall as „die Datei widerspricht
            # sich". Stripping the entrance hall's body out of the sample house
            # produced exactly that: 244.995 m³ (computed) against 266.728 m³
            # (declared), 8.1 % apart, on a file whose four declared volumes all
            # match their bodies to 1e-6 m³.
            without_body.append(space)
            continue
        if found is not None:
            declared_total += found.value
            declared_count += 1
        volumes.append(
            {
                "globalId": space.GlobalId,
                "name": model.label(space),
                "volume": round(volume, 6),
                "declaredVolume": None if found is None else round(found.value, 6),
                "declaredAt": None if found is None else found.path,
            }
        )

    if not volumes:
        return undecidable(
            from_=[e["globalId"] for e in measured],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="kein IfcSpace mit auswertbarem Körper" if spaces else "IfcSpace",
                remedy=(
                    "Das beheizte Volumen wird aus den Raumkörpern gebildet. Diese Datei enthält "
                    + ("keine Räume" if not spaces else f"{len(spaces)} Räume, aber keiner davon trägt einen Körper")
                    + ". Abhilfe: die Räume im CAD als IfcSpace mit Körpergeometrie exportieren. Ein Volumen aus "
                    "der Hüllbox des Gebäudes wird bewusst nicht ersatzweise gebildet — es enthielte Loggien, "
                    "Vordächer und den Luftraum über einem Pultdach und wäre in einer Energiebilanz nicht als "
                    "falsch zu erkennen."
                ),
            ),
        )

    volume_total = round(sum(v["volume"] for v in volumes), 6)
    measured_volume = computed(
        volume_total,
        unit="m³",
        tolerance=abs(volume_total) * VOLUME_RELATIVE_TOLERANCE,
        from_=[v["globalId"] for v in volumes],
        method=f"Σ Raumkörper ({len(volumes)} IfcSpace)",
    )
    volume_answer = measured_volume
    if declared_count == len(volumes) and declared_count > 0:
        # Only when EVERY MEASURED space declares one. A partial declared sum
        # against a complete measured sum is not two routes to the same number,
        # it is two different questions, and `triangulate` would report the
        # shortfall as "die Datei widerspricht sich". `len(volumes)`, not
        # `len(spaces)`: both sums have to run over the SAME set of spaces.
        volume_answer = triangulate(
            measured_volume,
            declared(
                round(declared_total, 6),
                unit="m³",
                from_=[v["globalId"] for v in volumes],
                method=f"Σ deklarierte Raumvolumina ({declared_count} IfcSpace)",
            ),
            method=f"Σ Raumkörper ({len(volumes)} IfcSpace)",
        )
    volume = float(volume_answer.value) if volume_answer.value is not None else volume_total

    ratio = area / volume if volume > 0 else None
    if ratio is None:
        return undecidable(
            from_=[e["globalId"] for e in measured],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="beheiztes Volumen 0 m³",
                remedy=(
                    "Die Raumkörper dieser Datei ergeben zusammen kein Volumen — sie sind flach oder entartet. "
                    "Die Räume im CAD neu aufziehen und den Export prüfen."
                ),
            ),
        )

    caveat = (
        f"A ist die Summe der außenliegenden Bauteilflächen ({len(measured)} Bauteile), gemessen an den "
        "AUSSENFLÄCHEN der Bauteile. V ist die Summe der Raumkörper, also ein NETTOVOLUMEN: Raumluft bis zu den "
        f"inneren Oberflächen, gebildet aus {len(volumes)} IfcSpace. Ein Bruttovolumen (bis zur Bauteilaußenkante) "
        "ist größer — bei 290 mm Außenwand und 470 mm Bodenaufbau bei einem Haus dieser Größe um einige "
        "Kubikmeter je Geschoss — und ist "
        "hier NICHT gebildet, weil dafür je Bauteil eine Dicke nötig wäre, die nur die Schichtaufbauten kennen. "
        "Das Verhältnis mischt damit eine Außenfläche mit einem Innenvolumen und liegt geringfügig über einem "
        "durchgehend brutto gebildeten A/V. Welches der beiden Volumina eine Berechnung meint, entscheidet die "
        "Berechnung; kein Grenzwert angewandt."
    )
    if volume_answer.caveat:
        caveat += f" {volume_answer.caveat}"
    if without_area:
        caveat += (
            f" {len(without_area)} außenliegende(s) Bauteil(e) ohne messbare Fläche sind in A nicht enthalten — "
            "A ist insofern eine Untergrenze und A/V zu klein."
        )
    if without_body:
        # V is silently a subtotal without this sentence: the reader is told V
        # comes from N IfcSpace and has no way to learn that the file holds
        # N+1. Naming them is also what makes the number repairable — the same
        # spaces are the ones held out of the declared sum above, so a reader
        # who fixes their bodies gets both routes back.
        named = ", ".join(f"„{model.label(s) or s.GlobalId}“" for s in without_body[:5])
        rest = "" if len(without_body) <= 5 else f" und {len(without_body) - 5} weitere"
        caveat += (
            f" {len(without_body)} von {len(spaces)} IfcSpace tragen keinen auswertbaren Körper ({named}{rest}) "
            "und sind in V NICHT enthalten — V ist insofern eine Untergrenze und A/V zu groß. Aus demselben "
            "Grund ist auch ihr deklariertes Volumen nicht mitsummiert: beide Summen laufen über dieselben "
            "Räume, sonst wäre die Differenz als Widerspruch der Datei gemeldet, den es nicht gibt."
        )
    sloped = [
        e for e in measured if e["projectedArea"] and e["area"] > e["projectedArea"] * (1 + SLOPE_REPORT_FRACTION)
    ]
    if sloped:
        difference = sum(e["area"] - e["projectedArea"] for e in sloped)
        caveat += (
            f" {len(sloped)} Bauteil(e) sind geneigt oder gekrümmt; für sie ist die ABGEWICKELTE Oberfläche "
            f"gezählt, zusammen {difference:.3f} m² mehr als ihre Grundrissprojektion."
        )
    counted = [v for v in volumes if v["volume"] > 0]
    caveat += (
        f" Als beheizt gelten alle {len(counted)} ausgewerteten Raumkörper: eine Unterscheidung beheizt/unbeheizt "
        "steht in diesem Export nicht (weder IfcZone noch Pset_SpaceThermalRequirements). Ein unbeheizter "
        "Keller oder Dachraum ist damit mitgezählt und macht V zu groß und A/V zu klein."
    )

    return computed(
        {
            "ratio": round(ratio, 6),
            "characteristicLength": round(volume / area, 6),
            "envelopeArea": area,
            "volume": round(volume, 6),
            "volumeIs": "netto (Raumkörper, bis zu den inneren Oberflächen)",
            "volumeAgreement": volume_answer.agreement,
            "areaByKind": {
                kind: round(sum(e["area"] for e in measured if e["kind"] == kind), 6)
                for kind in KIND_ORDER
                if any(e["kind"] == kind for e in measured)
            },
            "spaces": volumes,
            "elementCount": len(measured),
        },
        unit="1/m",
        tolerance=abs(ratio) * (AREA_RELATIVE_TOLERANCE + VOLUME_RELATIVE_TOLERANCE),
        from_=[e["globalId"] for e in measured] + [v["globalId"] for v in volumes],
        method=method,
        caveat=caveat,
    )


__all__ = [
    "KIND_ORDER",
    "ROUTE_BOUNDED_SPACES",
    "ROUTE_DECLARED",
    "ROUTE_UNDECIDED",
    "SLOPE_REPORT_FRACTION",
    "TRANSPARENT_TYPES",
    "VOLUME_RELATIVE_TOLERANCE",
    "compactness",
    "envelope_area_by_orientation",
    "thermal_envelope",
]
