"""The operator vocabulary, on IfcOpenShell.

A port of `packages/ifc-spatial/src/operators/{topology,metric,constructive}.ts`,
one function per TS operator, every one returning an :class:`~ifc_spatial.envelope.Answer`.
The German wording of `missing.what`, `missing.remedy` and every `caveat` is kept
verbatim wherever the TypeScript has one, because the sentence an architect reads
must not change when the engine underneath does.

## Three outcomes, never two — unchanged from the TS

  - **a value** — with provenance, tolerance and a method that reads like the call.
  - **undecidable** — the question was well-formed and this file cannot answer it.
    Carries the IFC relation or property that would settle it, in German.
  - **exception** — the GlobalId names nothing in this model
    (:class:`~ifc_spatial.model.UnknownElementError`). Never an undecidable: a
    hallucinated id must not be reportable as "das Modell sagt dazu nichts".

## Where IfcOpenShell is better than what it replaces, and it is used

Marked ``BESSER`` in the docstrings and listed in ``COVERAGE.md``:

  - :func:`floor_area` — ``util.shape.get_footprint_area`` UNIONS the projected
    faces (shapely) instead of summing them, so overlapping horizontal faces
    cannot double-count.
  - :func:`floor_area` also finds the declared quantity itself and triangulates
    against it; the TS operator takes it as a parameter and answers with one
    route when the host forgets to pass it.
  - :func:`ray` — ``geom.tree.select_ray`` intersects the real OCCT surface, not
    a retained triangle subset, and returns the surface normal and dot product
    besides the hit. The TS ray silently skips elements whose triangles the
    geometry pass dropped and says so in a caveat; there is nothing to drop here.
  - :func:`opens_to` and :func:`bounds` — ``geom.tree.select(element, extend=…)``
    is an exact solid proximity query, so the space a window opens into is found
    at a 5 cm contact tolerance instead of the TS derivation's 30 cm.
  - :func:`clear_height` — the TS operator returns the modelled space height and
    says in its caveat that the real clear height needs an intersection test it
    does not have. IfcOpenShell has it, so this one measures the lichte Höhe by
    casting rays up from the floor.

## Where it is worse, and the code says so rather than pretending

``tree.clash_collision_many`` / ``clash_clearance_many`` /
``clash_intersection_many`` return an EMPTY tuple for every input on the shipped
0.8.5 wheel — including two walls that visibly touch — without raising. §7 of the
design doc maps `adjacentTo` and `distance` onto exactly those calls. They are
therefore not used anywhere in this module: a primitive that answers "keine
Nachbarn" by failing silently is the single most dangerous thing this library
could be built on. :func:`distance` measures box gaps as the TS does, and
:func:`adjacent_spaces` goes through shared bounding elements.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from collections.abc import Sequence
from typing import Any

import ifcopenshell.util.shape as us
import numpy as np

from .envelope import Answer
from .envelope import ElementRef
from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import triangulate
from .envelope import undecidable
from .geometry import box_gap
from .geometry import boxes_overlap
from .geometry import clip_polygon
from .geometry import dominant_vertical_plane
from .geometry import outermost_parallel_face
from .geometry import signed_distance
from .geometry import triangle_normals_areas
from .model import AIR_TYPES
from .model import CONTACT_BUDGET_SECONDS
from .model import DERIVED_BOUNDARY_MAX_PRODUCTS
from .model import ElementGeometry
from .model import SpatialModel

# ── the error model, ported verbatim from metric.ts ─────────────────────────

#: One coordinate off a tessellated solid, in metres. Covers the kernel's chord
#: deviation on curved surfaces plus the millimetre sloppiness of ordinary
#: authoring. A stated assumption, not a measurement of this kernel.
COORDINATE_TOLERANCE = 0.005
#: A linear dimension: ``max − min`` subtracts two independently tessellated
#: faces, so both errors are in it.
DIMENSION_TOLERANCE = 2 * COORDINATE_TOLERANCE
#: Areas, relative. 1 % of a 50 m² room is what 5 mm of edge error over a ~30 m
#: perimeter actually produces.
AREA_RELATIVE_TOLERANCE = 0.01
#: A compass bearing, in degrees.
AZIMUTH_TOLERANCE_DEGREES = 3
#: Tessellation error on a surface-based measurement, metres.
TESSELLATION_TOLERANCE = 0.005
#: Tolerance on a measurement taken from a bounding box instead of surfaces.
BOX_TOLERANCE = 0.05
#: Below this, an intrusion into a volume is tessellation noise, metres.
MIN_INTRUSION = 0.005
#: Contact tolerance for the exact solid proximity queries, metres. Five
#: centimetres rather than the TS derivation's thirty, because ``tree.select``
#: tests real solids and not bounding boxes.
CONTACT = 0.05
#: |cos| between the facade normal and the direction out of the plan centre,
#: below which "outward" is not established.
OUTWARD_MIN_DOT = 0.15
#: Minimum distance from the plan centre for the outward test to mean anything.
OUTWARD_MIN_SPAN = 0.25

#: German 16-point compass, in the notation an Austrian or German architect
#: writes: **O** for east, not E.
COMPASS = ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

#: The types :func:`sill_and_head` will measure. ``IfcOpeningElement`` is in the
#: list deliberately: an agent chaining off ``hosts()`` holds the opening's id.
FENESTRATION = {
    "IfcWindow",
    "IfcWindowStandardCase",
    "IfcDoor",
    "IfcDoorStandardCase",
    "IfcOpeningElement",
}

#: Excluded from the clear-height scan. A chair is not a Raumhöhe.
FURNISHING = ("IfcFurnishingElement", "IfcFurniture", "IfcSystemFurnitureElement")

# The IFC relation behind each answer, and what to tell the architect. Lifted
# verbatim from topology.ts so that the same gap produces the same German
# sentence whichever engine discovered it.
_RELATIONS = {
    "voids": ("IfcRelVoidsElement", "Öffnungen und Füllungen mitexportieren"),
    "fills": ("IfcRelFillsElement", "Öffnungen und Füllungen mitexportieren"),
    "interfaceOf": (
        "IfcRelSpaceBoundary",
        "Space Boundaries (2nd level) mitexportieren — in Revit/ArchiCAD eine Exporteinstellung",
    ),
    "connects": (
        "IfcRelConnectsElements / IfcRelConnectsPathElements",
        "Bauteilverbindungen mitexportieren — viele Exporte lassen sie weg",
    ),
    "containsElement": (
        "IfcRelContainedInSpatialStructure",
        "Bauteile der Ebene bzw. dem Raum zuordnen und die räumliche Struktur mitexportieren",
    ),
}

_DERIVED_BOUNDARY_CAVEAT = (
    "Aus der Geometrie abgeleitet (geom.tree.select, Berührungstoleranz {contact:.2f} m), nicht in der Datei "
    "deklariert: dieser Export enthält keine IfcRelSpaceBoundary. Die gemessenen Beziehungen tragen eine "
    "Toleranz und können danebenliegen."
)


# ── guards ──────────────────────────────────────────────────────────────────


def _require(model: SpatialModel, global_id: str, method: str) -> Any:
    return model.by_id(global_id, method)


def _wrong_kind(
    model: SpatialModel,
    subject: Any,
    method: str,
    operator: str,
    expected: str,
    suggestion: str,
    provenance: str = "declared",
) -> Answer[Any]:
    """The operator was aimed at the wrong kind of element.

    ``missing.what`` is German here, unlike everywhere else, because nothing is
    in fact missing from the file. What is missing is a match between the
    question and the subject, and naming an IFC relation would send the architect
    off to re-export something that is already there. ``remedy`` names the
    operator that WOULD answer it.
    """
    return undecidable(
        from_=[subject.GlobalId],
        method=method,
        provenance=provenance,  # type: ignore[arg-type]
        missing=MissingFact(
            what=f"{operator}() erwartet {expected}, bekam {subject.is_a()}",
            remedy=suggestion,
            elements=[subject.GlobalId],
        ),
    )


def _no_geometry(model: SpatialModel, subject: Any, method: str, from_: list[str] | None = None) -> Answer[Any]:
    """The element has no usable body in this file — a finding, never an exception.

    Two different findings, and the corpus showed that saying the wrong one sends
    the architect to fix the wrong thing:

    - **no representation** — normal for whole classes of entity, and a real
      export defect for a wall;
    - **the kernel could not build it** — the element carries a full ``Body`` and
      OCCT rejects it. 94 of the 100 rooms in the corpus's ArchiCAD 18 export are
      in exactly this state. Re-exporting "with geometry" changes nothing there;
      the room boundary itself is what the kernel will not accept.
    """
    name = model.label(subject) or subject.GlobalId
    reason = model.geometry_failure(subject.GlobalId) or ""

    if reason.startswith("shape-failed") or reason == "empty-mesh":
        detail = reason.split(": ", 1)[1] if ": " in reason else reason
        what = f"Körpergeometrie von {subject.is_a()} „{name}“ ist nicht auswertbar"
        remedy = (
            "Dieses Bauteil trägt eine Body-Repräsentation, aber der Geometriekern kann daraus keinen "
            f"Körper bauen ({detail[:160]}). Ein erneuter Export „mit Geometrie“ ändert daran nichts — die "
            "Form selbst wird abgelehnt. Typische Ursachen: eine sich selbst schneidende Umrandung, ein "
            "Profil mit Nullfläche, eine nicht geschlossene Schale. Im CAD das Bauteil bzw. den Raum neu "
            "aufziehen und den Export prüfen."
        )
    else:
        what = f"keine geometrische Repräsentation für {subject.is_a()} „{name}“ in dieser Datei"
        remedy = (
            "Dieses Bauteil trägt in dieser Datei keinen Körper (kein auswertbares IfcProductDefinitionShape). "
            "Manche Einträge haben von Haus aus keinen — IfcDoorLiningProperties, IfcWindowLiningProperties, "
            "die Hülle einer Vorhangfassade, deren Paneele die Geometrie tragen. Sonst: das Modell mit "
            "Körpergeometrie neu exportieren (Body-Repräsentation, kein reiner Bounding-Box-Export)."
        )

    return undecidable(
        from_=from_ or [subject.GlobalId],
        method=method,
        provenance="computed",
        missing=MissingFact(what=what, remedy=remedy, elements=[subject.GlobalId]),
    )


def _relation_missing(model: SpatialModel, kinds: Sequence[str]) -> MissingFact:
    ifc = " + ".join(dict.fromkeys(_RELATIONS[k][0] for k in kinds))
    remedy = "; ".join(dict.fromkeys(_RELATIONS[k][1] for k in kinds))
    return MissingFact(what=ifc, remedy=remedy)


def _has(model: SpatialModel, ifc_type: str) -> bool:
    try:
        return len(model.file.by_type(ifc_type)) > 0
    except RuntimeError:
        return False


def _geometry_or_answer(
    model: SpatialModel, subject: Any, method: str, from_: list[str] | None = None
) -> tuple[ElementGeometry | None, Answer[Any] | None]:
    geo = model.geometry(subject.GlobalId)
    if geo is None:
        return None, _no_geometry(model, subject, method, from_)
    return geo, None


# ════════════════════════════════════════════════════════════════════════════
# topology — every one of these is an inverse-attribute read, no geometry
# ════════════════════════════════════════════════════════════════════════════


def hosts(model: SpatialModel, global_id: str) -> Answer[list[ElementRef]]:
    """Openings cut out of this element — the window and door reveals in a wall.

    ``IfcElement.HasOpenings`` → ``IfcRelVoidsElement.RelatedOpeningElement``.
    Returns the OPENINGS, not what fills them: an opening with no filler is a
    hole, and telling the two apart matters for a wall-area takeoff. Chain
    :func:`filler_of` on each result for the windows and doors.
    """
    method = f"hosts({global_id})"
    subject = _require(model, global_id, method)
    kind = model.kind_of(subject)

    if kind == "opening":
        return _wrong_kind(
            model,
            subject,
            method,
            "hosts",
            "ein durchbrochenes Bauteil (Wand, Decke)",
            "für eine Öffnung: fillerOf() liefert ihre Füllung",
        )
    if kind != "element":
        return _wrong_kind(
            model,
            subject,
            method,
            "hosts",
            "ein Bauteil (Wand, Decke)",
            "für Räume: bounds(), für Geschosse: elementsOfStorey()",
        )
    if not _has(model, "IfcRelVoidsElement"):
        return undecidable(from_=[global_id], method=method, missing=_relation_missing(model, ["voids"]))

    openings = [rel.RelatedOpeningElement for rel in getattr(subject, "HasOpenings", []) or []]
    refs = model.refs(openings)
    return declared(refs, from_=[global_id, *[o.GlobalId for o in openings]], method=method)


def filler_of(model: SpatialModel, opening_global_id: str) -> Answer[list[ElementRef]]:
    """What fills this opening — the window, door or louvre placed in the hole.

    An empty result on an opening that exists is a real finding: unfilled
    openings are how a wall ends up with an area a schedule cannot account for.
    """
    method = f"fillerOf({opening_global_id})"
    subject = _require(model, opening_global_id, method)
    if model.kind_of(subject) != "opening":
        return _wrong_kind(
            model,
            subject,
            method,
            "fillerOf",
            "eine Öffnung (IfcOpeningElement)",
            "für ein Bauteil: hosts() liefert seine Öffnungen, hostedIn() das umgebende Bauteil",
        )
    if not _has(model, "IfcRelFillsElement"):
        return undecidable(from_=[opening_global_id], method=method, missing=_relation_missing(model, ["fills"]))

    fillers = [rel.RelatedBuildingElement for rel in getattr(subject, "HasFillings", []) or []]
    return declared(
        model.refs(fillers),
        from_=[opening_global_id, *[e.GlobalId for e in fillers]],
        method=method,
    )


def hosted_in(model: SpatialModel, global_id: str) -> Answer[list[ElementRef]]:
    """The wall or slab this window or door sits in.

    Computed, not declared: IFC never states "this window is in that wall". It
    states that the wall is voided by an opening (``IfcRelVoidsElement``) and
    that the opening is filled by the window (``IfcRelFillsElement``), and this
    walks the two hops — ``FillsVoids → RelatingOpeningElement → VoidsElements →
    RelatingBuildingElement``. The distinction is worth carrying: the answer is
    only as good as the export's opening bookkeeping, and an agent quoting it in
    front of a building authority must be able to say so.

    A list rather than one element because a filler CAN legitimately sit in more
    than one opening (a window band split across two wall segments); one result
    is the normal case, not a guarantee.
    """
    method = f"hostedIn({global_id})"
    subject = _require(model, global_id, method)
    kind = model.kind_of(subject)

    if kind not in ("element", "opening"):
        return _wrong_kind(
            model,
            subject,
            method,
            "hostedIn",
            "ein Fenster oder eine Tür",
            "für Räume: bounds(), für Bauteile einer Ebene: elementsOfStorey()",
            "computed",
        )

    absent = [k for k in ("voids", "fills") if not _has(model, _RELATIONS[k][0])]
    if absent:
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=_relation_missing(model, absent),
        )

    if kind == "opening":
        openings = [subject]
    else:
        openings = [rel.RelatingOpeningElement for rel in getattr(subject, "FillsVoids", []) or []]
    hosts_ = [
        rel.RelatingBuildingElement for opening in openings for rel in (getattr(opening, "VoidsElements", []) or [])
    ]

    refs = model.refs(hosts_, via="voids+fills")
    caveat = (
        "Aus zwei deklarierten Beziehungen abgeleitet (voids+fills) — die Datei sagt nirgends direkt, "
        "in welcher Wand dieses Fenster sitzt."
    )
    if not refs and subject.is_a() in FENESTRATION:
        # An empty list here is true and reads as false. The corpus has an
        # ArchiCAD 18 export with 464 windows and doors and 79 IfcRelVoidsElement
        # — 84 % of its fenestration carries no opening at all, because the wall
        # body was exported with the hole already subtracted. `[]` on its own
        # would be rendered as "dieses Fenster sitzt in keiner Wand", which is a
        # statement about the building; the truth is a statement about the file.
        caveat = (
            "Für dieses Bauteil ist in der Datei keine Öffnungskette hinterlegt (IfcRelFillsElement → "
            "IfcRelVoidsElement fehlt), obwohl die Datei solche Ketten grundsätzlich enthält. Das heißt "
            "NICHT, dass das Fenster in keiner Wand sitzt — es heißt, dass dieser Export die Rohbauöffnung "
            "nicht mitgeschrieben hat und die Wand ihren Ausschnitt bereits im Körper trägt. Abhilfe: den "
            "Export mit Öffnungen und Füllungen wiederholen."
        )
    return computed(
        refs,
        from_=[global_id, *[h.GlobalId for h in hosts_]],
        method=method,
        caveat=caveat,
    )


def bounds(model: SpatialModel, space_global_id: str) -> Answer[list[ElementRef]]:
    """The elements bounding this space — its walls, floor, ceiling, and the
    windows and doors in them when the export writes 2nd-level boundaries.

    Declared route first: ``IfcSpace.BoundedBy`` → ``IfcRelSpaceBoundary``.

    BESSER: when the export writes none — which is the common case, and the case
    of this fixture — the TS package needs a whole derived-boundary pass over the
    tessellation before ``bounds()`` answers at all. Here the fallback is one
    ``geom.tree.select(space, extend=0.05)`` against the real solids, filtered to
    the elements that actually BOUND rather than sit inside: an element bounds the
    space when it reaches outside the space's own extent. That is what keeps the
    dining chairs out of the list and the roof in it.
    """
    method = f"bounds({space_global_id})"
    subject = _require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        return _wrong_kind(
            model,
            subject,
            method,
            "bounds",
            "einen Raum (IfcSpace)",
            "für ein Bauteil: enclosedBy() liefert die Räume, die es begrenzt",
        )

    declared_boundaries = [
        rel.RelatedBuildingElement
        for rel in (getattr(subject, "BoundedBy", []) or [])
        if rel.RelatedBuildingElement is not None
    ]
    if declared_boundaries:
        return declared(
            model.refs(declared_boundaries),
            from_=[space_global_id, *[e.GlobalId for e in declared_boundaries]],
            method=method,
        )

    found, answer = _derived_bounds(model, subject, method)
    if answer is not None:
        return answer
    return computed(
        model.refs(found, via="geom.tree.select"),
        from_=[space_global_id, *[e.GlobalId for e in found]],
        method=method,
        caveat=_DERIVED_BOUNDARY_CAVEAT.format(contact=CONTACT),
    )


def _too_big_to_derive(model: SpatialModel, method: str, subject_id: str) -> Answer[Any]:
    """This export has no space boundaries and is too large to derive them.

    A refusal stated before anything is started, because once an OCCT offset is
    running there is no way to stop it — see
    :data:`~ifc_spatial.model.DERIVED_BOUNDARY_MAX_PRODUCTS`.
    """
    return undecidable(
        from_=[subject_id],
        method=method,
        provenance="computed",
        missing=MissingFact(
            what="IfcRelSpaceBoundary",
            remedy=(
                f"Dieser Export enthält für dieses Bauteil keine Raumgrenzen, und das Modell ist mit "
                f"{model.product_count} Bauteilen zu groß, um sie aus den Körpern abzuleiten (Grenze "
                f"{DERIVED_BOUNDARY_MAX_PRODUCTS}). Eine einzelne Verschneidungsabfrage läuft auf einem Modell "
                "dieser Größe über 200 Sekunden und lässt sich nicht abbrechen — deshalb wird sie gar nicht "
                "erst gestartet. Abhilfe: Space Boundaries (2nd level) mitexportieren — in Revit/ArchiCAD eine "
                "Exporteinstellung — oder dieses Modell in einem Worker ohne Anfragezeitlimit auswerten."
            ),
            elements=[subject_id],
        ),
    )


def _derived_bounds(model: SpatialModel, space: Any, method: str) -> tuple[list[Any], Answer[Any] | None]:
    if not model.derivable_boundaries:
        return [], _too_big_to_derive(model, method, space.GlobalId)
    geo, missing = _geometry_or_answer(model, space, method)
    if geo is None:
        return [], missing
    low, high = geo.box
    found: list[Any] = []
    # One offset of THIS space, not of every space in the file: the model-wide
    # map costs 0.5–2 s per room and answers a question nobody asked here.
    for global_id in sorted(model.contacts_of(space, CONTACT)):
        element = model.file.by_guid(global_id)
        if element.is_a() in AIR_TYPES:
            continue
        other = model.geometry(element.GlobalId)
        if other is None:
            continue
        o_low, o_high = other.box
        # An element BOUNDS the space when it reaches outside it. Furniture
        # standing in the room is contained, not bounding, and reporting a piano
        # as a room boundary would make every downstream envelope figure wrong.
        if bool((o_low < low - 0.01).any() or (o_high > high + 0.01).any()):
            found.append(element)
    return found, None


def enclosed_by(model: SpatialModel, element_global_id: str) -> Answer[list[ElementRef]]:
    """The spaces this element bounds — the inverse of :func:`bounds`.

    Two results on a wall mean it separates those two rooms, which is the input
    to every Trennwand question (sound insulation, fire compartmentation). One
    result means the far side is outside the model or unbounded, which is not the
    same as "outside the building" and must not be reported as such.
    """
    method = f"enclosedBy({element_global_id})"
    subject = _require(model, element_global_id, method)
    if model.kind_of(subject) == "space":
        return _wrong_kind(
            model,
            subject,
            method,
            "enclosedBy",
            "ein Bauteil (Wand, Decke, Fenster)",
            "für einen Raum: bounds() liefert die begrenzenden Bauteile, adjacentSpaces() die Nachbarräume",
        )

    provides = [
        rel.RelatingSpace for rel in (getattr(subject, "ProvidesBoundaries", []) or []) if rel.RelatingSpace is not None
    ]
    if provides:
        return declared(
            model.refs(provides),
            from_=[element_global_id, *[s.GlobalId for s in provides]],
            method=method,
        )

    spaces = _spaces_touching(model, subject, method)
    if isinstance(spaces, Answer):
        return spaces
    return computed(
        model.refs(spaces, via="geom.tree.select"),
        from_=[element_global_id, *[s.GlobalId for s in spaces]],
        method=method,
        caveat=_DERIVED_BOUNDARY_CAVEAT.format(contact=CONTACT),
    )


def _spaces_touching(model: SpatialModel, subject: Any, method: str) -> Any:
    """The spaces this element touches, read out of the model-wide contact map.

    Asked from the SPACES' side rather than the element's: see
    :meth:`SpatialModel.space_contacts` for the measurement that decided it
    (2.9 s to offset one window against 0.55 s to offset one room).
    """
    if not model.derivable_boundaries:
        return _too_big_to_derive(model, method, subject.GlobalId)
    if model.geometry(subject.GlobalId) is None:
        return _no_geometry(model, subject, method)
    contacts = model.space_contacts(CONTACT)
    if not model.contacts_complete:
        # The map is a SUBSET. Reporting the rooms found so far would be a short
        # list wearing the shape of a complete one, which is the failure this
        # library exists to prevent — so it refuses, and says how far it got.
        total = len(model.file.by_type("IfcSpace"))
        return undecidable(
            from_=[subject.GlobalId],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="IfcRelSpaceBoundary (die Ableitung aus der Geometrie ist für dieses Modell zu teuer)",
                remedy=(
                    f"Dieser Export enthält keine Raumgrenzen, und die Ableitung aus den Körpern wurde nach "
                    f"{model.contacts_covered} von {total} Räumen abgebrochen (Zeitbudget "
                    f"{int(CONTACT_BUDGET_SECONDS)} s). Eine unvollständige Liste wäre nicht von einer "
                    "vollständigen zu unterscheiden, deshalb wird keine ausgegeben. Abhilfe: Space Boundaries "
                    "(2nd level) mitexportieren — in Revit/ArchiCAD eine Exporteinstellung — oder die "
                    "Auswertung dieses Modells in einem Worker ohne Anfragezeitlimit fahren."
                ),
                elements=[subject.GlobalId],
            ),
        )
    return [model.file.by_guid(space_id) for space_id, touching in contacts.items() if subject.GlobalId in touching]


def opens_to(model: SpatialModel, global_id: str) -> Answer[list[ElementRef]]:
    """The spaces a window or door opens into.

    Declared route: the ``IfcRelSpaceBoundary`` entries that name this element.

    BESSER: when the export writes none, ``geom.tree.select(window, extend=0.05)``
    filtered to ``IfcSpace`` answers it directly, because the window's solid
    genuinely touches the room's solid. The TS package reaches the same answer
    through `hostedIn` + a derived boundary at a 30 cm contact test; this is one
    exact query at 5 cm and does not depend on the wall's boundaries existing.

    Two results on a door is the answer to "which rooms does this door connect";
    one result is a door to the outside, or a door whose far room the export did
    not model as a space.
    """
    method = f"opensTo({global_id})"
    subject = _require(model, global_id, method)
    if model.kind_of(subject) not in ("element", "opening"):
        return _wrong_kind(
            model,
            subject,
            method,
            "opensTo",
            "ein Fenster oder eine Tür",
            "für einen Raum: adjacentSpaces() liefert die Nachbarräume",
            "computed",
        )

    provides = [
        rel.RelatingSpace for rel in (getattr(subject, "ProvidesBoundaries", []) or []) if rel.RelatingSpace is not None
    ]
    if provides:
        return declared(model.refs(provides), from_=[global_id, *[s.GlobalId for s in provides]], method=method)

    if not model.file.by_type("IfcSpace"):
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="IfcSpace",
                remedy=(
                    "Dieser Export enthält keine Räume. Räume im CAD als IfcSpace exportieren — ohne sie "
                    "ist keine Zuordnung Fenster→Raum ableitbar."
                ),
            ),
        )

    spaces = _spaces_touching(model, subject, method)
    if isinstance(spaces, Answer):
        return spaces
    return computed(
        model.refs(spaces, via="geom.tree.select"),
        from_=[global_id, *[s.GlobalId for s in spaces]],
        method=method,
        caveat=_DERIVED_BOUNDARY_CAVEAT.format(contact=CONTACT),
    )


def contains(model: SpatialModel, container_global_id: str) -> Answer[list[ElementRef]]:
    """The elements this container holds directly.

    ``IfcRelContainedInSpatialStructure``. Whenever the export assigns elements
    to spaces rather than only to storeys, this is the answer to "welche Bauteile
    sind in Raum X". Many exports assign everything to the storey instead, in
    which case a space returns an empty list — honest either way, and calling it
    on the storey shows which convention this file follows.
    """
    method = f"contains({container_global_id})"
    subject = _require(model, container_global_id, method)
    if model.kind_of(subject) not in ("project", "site", "building", "storey", "space"):
        return _wrong_kind(
            model,
            subject,
            method,
            "contains",
            "einen räumlichen Container (Geschoss, Raum, Gebäude)",
            "für ein Bauteil: containerOf() liefert seinen Container, hosts() seine Öffnungen",
        )
    if not _has(model, "IfcRelContainedInSpatialStructure"):
        return undecidable(
            from_=[container_global_id], method=method, missing=_relation_missing(model, ["containsElement"])
        )

    elements = [e for rel in (getattr(subject, "ContainsElements", []) or []) for e in rel.RelatedElements]
    aggregated = [e for rel in (getattr(subject, "IsDecomposedBy", []) or []) for e in rel.RelatedObjects]
    caveat = None
    if aggregated:
        caveat = (
            f"Zusätzlich hängen {len(aggregated)} Objekt(e) über IfcRelAggregates an diesem Container "
            "(Räume, Baugruppen). Die stehen nicht in dieser Liste — contains() zeigt nur die räumliche "
            "Zuordnung IfcRelContainedInSpatialStructure."
        )
    return declared(
        model.refs(elements),
        from_=[container_global_id, *[e.GlobalId for e in elements]],
        method=method,
        caveat=caveat,
    )


def container_of(model: SpatialModel, global_id: str) -> Answer[ElementRef | None]:
    """The immediate spatial container of this element — the storey, or the space
    when the export assigns elements that finely.

    ``None`` is a decidable answer: a storey's parent building travels on
    aggregation, not on containment, and an element the exporter left unassigned
    really has no container. Both are worth reporting; neither is a missing
    relation.
    """
    method = f"containerOf({global_id})"
    subject = _require(model, global_id, method)
    if not _has(model, "IfcRelContainedInSpatialStructure"):
        return undecidable(from_=[global_id], method=method, missing=_relation_missing(model, ["containsElement"]))

    containers = [rel.RelatingStructure for rel in (getattr(subject, "ContainedInStructure", []) or [])]
    if not containers:
        return declared(None, from_=[global_id], method=method)

    caveat = None
    if len(containers) > 1:
        # IFC allows an element to be contained in exactly one spatial structure.
        # More than one is an export defect, and reporting the first silently
        # would hide it behind an answer that looks ordinary.
        caveat = (
            f"Dieses Bauteil ist {len(containers)} räumlichen Containern zugeordnet, IFC erlaubt genau einen. "
            "Gemeldet ist der erste — ein Befund über den Export."
        )
    return declared(
        model.ref(containers[0]),
        from_=[global_id, containers[0].GlobalId],
        method=method,
        caveat=caveat,
    )


def adjacent_spaces(model: SpatialModel, space_global_id: str) -> Answer[list[ElementRef]]:
    """The rooms next door — spaces sharing a bounding element with this one.

    Purely topological over :func:`bounds`: two spaces bounded by the same wall
    are neighbours. What it does NOT say is whether they are connected — a shared
    wall with no door in it still makes neighbours. Use :func:`opens_to` on the
    doors for connectivity.

    §7 of the design doc maps this onto ``geom.tree.clash_collision_many``. That
    call returns an empty tuple for every input on the shipped 0.8.5 wheel (see
    the module docstring), so it is deliberately not used: an adjacency operator
    that reports "keine Nachbarn" because a primitive failed silently is worse
    than one that does not exist.
    """
    method = f"adjacentSpaces({space_global_id})"
    subject = _require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        return _wrong_kind(
            model,
            subject,
            method,
            "adjacentSpaces",
            "einen Raum (IfcSpace)",
            "für ein Bauteil: enclosedBy() liefert die Räume, die es begrenzt",
            "computed",
        )

    own = bounds(model, space_global_id)
    if not own.decidable or own.value is None:
        return own
    own_ids = {ref.global_id for ref in own.value}

    neighbours: list[Any] = []
    for other in model.file.by_type("IfcSpace"):
        if other.GlobalId == space_global_id:
            continue
        other_bounds = bounds(model, other.GlobalId)
        if not other_bounds.decidable or other_bounds.value is None:
            continue
        if own_ids & {ref.global_id for ref in other_bounds.value}:
            neighbours.append(other)

    provenance_declared = own.provenance == "declared"
    refs = model.refs(neighbours, via="shared bounding element")
    if provenance_declared:
        return declared(refs, from_=[space_global_id, *[s.GlobalId for s in neighbours]], method=method)
    return computed(
        refs,
        from_=[space_global_id, *[s.GlobalId for s in neighbours]],
        method=method,
        caveat=_DERIVED_BOUNDARY_CAVEAT.format(contact=CONTACT)
        + " Nachbarschaft heißt gemeinsames begrenzendes Bauteil, NICHT begehbare Verbindung.",
    )


# ════════════════════════════════════════════════════════════════════════════
# metric — numbers off the geometry, each with its error attached
# ════════════════════════════════════════════════════════════════════════════


def extent(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The element's bounding box and its three axis-aligned dimensions, in metres.

    ``ifcopenshell.util.shape.get_bbox`` over the world-coordinate vertices.

    The box is **axis-aligned to the MODEL**, not to the element: a wall running
    at 30° in plan has a bounding box far wider and deeper than the wall, and
    reporting that box's ``width`` as the wall's length would be wrong by a
    factor. When the element's own facade plane shows it is skewed to the model
    axes, the answer says so in a caveat rather than leaving the reader to notice.
    """
    method = f"extent({global_id})"
    subject = _require(model, global_id, method)
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    low, high = us.get_bbox(geo.verts)
    width, depth, height = (high - low).tolist()

    caveat = None
    normal = dominant_vertical_plane(geo.triangles)
    if normal is not None and abs(normal[0]) > 0.1 and abs(normal[1]) > 0.1:
        caveat = (
            "Dieses Bauteil steht schräg zu den Modellachsen. Breite und Tiefe sind die Ausdehnung der "
            "achsparallelen Hüllbox, NICHT Länge und Dicke des Bauteils selbst — diese Zahlen sind für ein "
            "schräges Bauteil systematisch zu groß."
        )

    return computed(
        {
            "box": {"min": low.tolist(), "max": high.tolist()},
            "width": width,
            "depth": depth,
            "height": height,
            "centroid": geo.centroid.tolist(),
        },
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[global_id],
        method=method,
        caveat=caveat,
    )


def floor_area(model: SpatialModel, global_id: str, declared_area: float | None = None) -> Answer[float]:
    """The element's floor area in m² — for a space, its usable plan area.

    BESSER, twice over:

    1. The TS operator sums the XY-projected areas of downward-facing triangles.
       :func:`_footprint_area` projects them and takes the shapely UNION, so two
       horizontal faces at different heights over the same plan — a stepped
       floor, a slab modelled with its screed — cannot double-count. It also
       measures from **both** sides, because an inside-out ``IfcSpace`` is not
       rare; see that function for the 0 m² room that made it necessary.
    2. The declared quantity is found here instead of being passed in. The TS
       operator takes ``declaredArea`` as a parameter because that library has no
       property access, so a host that forgets to read the quantity set gets a
       single-route answer. This searches every pset — which matters, because the
       corpus publishes room areas under four different names in four dialects
       (``BaseQuantities``, ``SpaceQuantities``, ``GSA Space Areas``,
       ``PSet_Revit_Dimensions``) and a search restricted to the canonical
       ``Qto_SpaceBaseQuantities`` finds none of them — and converts the value
       out of the file's own unit, because an export in square feet is not a
       disagreement with an export in square metres.

    Agreement raises confidence in the schedule; DISAGREEMENT is a finding about
    the export the architect can act on. :func:`~ifc_spatial.envelope.triangulate`
    writes the German caveat and reports the measured value when the two differ.
    """
    subject_id = global_id
    method = (
        f"floorArea({subject_id})" if declared_area is None else f"floorArea({subject_id}, declared={declared_area})"
    )
    subject = _require(model, global_id, method)
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    area = _footprint_area(geo.triangles)
    caveat = None
    if area == 0:
        caveat = (
            "Gemessene Grundfläche 0 m²: dieses Bauteil hat Geometrie, aber keine horizontalen Flächen "
            "(eine Wand, ein Pfosten). Das ist ein Messergebnis, keine fehlende Angabe."
        )
    measured = computed(
        area,
        unit="m²",
        tolerance=abs(area) * AREA_RELATIVE_TOLERANCE,
        from_=[global_id],
        method=method,
        caveat=caveat,
    )

    found = None
    declared_method = f"NetFloorArea({global_id})"
    declared_caveat = None
    if declared_area is None:
        # `Area` and `NetArea` mean "floor area" only on something that HAS a
        # floor. On a wall, Revit's `Dimensions.Area` is the elevation area —
        # 26.48 m² against this wall's 4.10 m² of footprint — and triangulating
        # the two produced "die Datei widerspricht sich" on every wall of every
        # Revit export. Both numbers were right; they measure different things,
        # and it is the comparison that was wrong. So the ambiguous names are
        # only consulted for a spatial element.
        names = ("NetFloorArea", "GrossFloorArea")
        if model.kind_of(subject) == "space":
            names = ("NetFloorArea", "NetArea", "GrossFloorArea", "Area")
        found = model.declared_quantity(subject, names)
        if found is None:
            return measured
        declared_area = found.value
        declared_method = f"{found.path}({global_id})"
        if found.scale != 1.0:
            declared_caveat = (
                f"Die Datei deklariert {found.raw:.4f} {found.unit_label or '(Einheit der Datei)'}; "
                f"umgerechnet {found.value:.4f} m². Verglichen wird in Metern."
            )
    else:
        # A caller-supplied number is assumed to be SI already; it has to be,
        # because nothing here can tell which unit the caller measured in.
        declared_area = float(declared_area)

    # The measured value goes in first because `triangulate` reports the COMPUTED
    # side when the two disagree: a declared quantity that contradicts the
    # geometry it describes is the thing under suspicion.
    answer = triangulate(
        measured,
        declared(declared_area, unit="m²", from_=[global_id], method=declared_method),
        method=method,
    )
    if declared_caveat:
        answer.caveat = f"{answer.caveat} {declared_caveat}" if answer.caveat else declared_caveat
    return answer


def _vector_text(value: Any) -> str:
    """A vector as it should read back in a `method`, whatever was passed in."""
    try:
        return "[" + ", ".join(f"{float(c):.3f}" for c in value) + "]"
    except (TypeError, ValueError):
        return repr(value)


def _footprint_area(triangles: np.ndarray) -> float:
    """The plan area of a solid, measured from whichever side its faces point.

    ``util.shape.get_footprint_area`` keeps only triangles whose normal points
    **towards** the given direction, so it silently returns ``0.0`` for a mesh
    wound inside-out. Which is exactly what a Revit IFC2X3 ``IfcSpace`` is: the
    Duplex apartment's *Hallway* has 28 downward-facing faces, no upward ones,
    and reported **0 m² of floor** against a declared 7.80 m² — with a caveat
    claiming the element has no horizontal surfaces, which was false. A confident
    zero is the worst thing this library can produce, because zero is a number an
    agent will put in a sentence.

    Asking IfcOpenShell for the other direction is not a fix: ``direction=(0, 0,
    -1)`` builds a degenerate basis inside ``get_footprint_area`` and raises
    ``GEOSException: Points of LinearRing do not form a closed linestring``
    (0.8.5, ``util/shape.py:611``) — so the down-facing projection is done here.
    The method is the same one: keep the faces whose normal points along the
    direction, project them to the plane, and take the shapely UNION so
    overlapping horizontal faces cannot double-count.

    Both projections are taken and the larger wins. For a closed solid the two
    silhouettes have the same area, so nothing changes where the winding was
    already right: the sample house's rooms still measure 15.41678125 /
    51.994825 / 8.69350625 m², identical to the IfcOpenShell values the parity
    suite asserts.
    """
    import shapely
    import shapely.ops

    if triangles is None or len(triangles) == 0:
        return 0.0
    normals, _ = triangle_normals_areas(triangles)
    best = 0.0
    for sign in (1.0, -1.0):
        # 0.01 is IfcOpenShell's own `normal_tol`: close to perpendicular, with
        # a fuzz for numerical noise. Kept identical so the two agree face for
        # face on a correctly wound mesh.
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
            best = max(best, float(shapely.ops.unary_union(polygons).area))
        except Exception:
            continue
    return best


def elevation(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """How high the element sits: its lowest and highest point in the model's own
    frame, and its bottom relative to the storey it belongs to.

    ``bottom`` and ``top`` are absolute Z in the file's frame — the project
    datum, which is what "±0,00" means on the drawing. ``heightAboveStorey``
    re-bases the bottom onto the element's own storey, which is the number a
    person actually asks for and which differs from the absolute Z on every
    storey but the ground floor.

    ``heightAboveStorey`` is ``None`` — decidably so — when the element resolves
    to no storey, or to a storey the file gives no ``Elevation``. That is a
    weaker claim than undecidable and the right one: ``bottom`` and ``top`` are
    still measured and still useful.
    """
    method = f"elevation({global_id})"
    subject = _require(model, global_id, method)
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    bottom = float(geo.box[0][2])
    top = float(geo.box[1][2])
    drift = _storey_datum_drift(model)
    datum = None if drift > 0 else model.storey_datum(subject)

    caveat = None
    if datum is None:
        mismatch = _datum_mismatch(model, drift) if drift > 0 else None
        caveat = (
            f"{mismatch.what}. {mismatch.remedy}"
            if mismatch
            else (
                "Dieses Bauteil ist keinem Geschoss mit Höhenangabe zugeordnet — die Höhe über dem Geschoss "
                "ist deshalb offen. Die absoluten Höhen beziehen sich auf den Projektnullpunkt."
            )
        )

    return computed(
        {
            "bottom": bottom,
            "top": top,
            "heightAboveStorey": None if datum is None else bottom - datum.elevation,
        },
        unit="m",
        tolerance=COORDINATE_TOLERANCE,
        from_=[global_id] if datum is None else [global_id, datum.global_id],
        method=method,
        caveat=caveat,
    )


def sill_and_head(model: SpatialModel, global_id: str) -> Answer[dict[str, float]]:
    """Brüstungshöhe and Sturzhöhe of a window or door — the two numbers a file
    this size almost never declares.

    Both are measured **above the element's OWN storey**, not above the project
    zero. That distinction is the whole point of the operator: a window on the
    first floor sits at absolute z 3.90 and at a sill height of 0.90, and only
    the second number answers "ist die Brüstung hoch genug". Reporting 3.90 as a
    Brüstungshöhe would clear an absturzsichernde Brüstung that does not exist.

    Which is why the storey datum is REQUIRED here, unlike in :func:`elevation`:
    a sill height with an unknown datum is not a weaker answer, it is a different
    number wearing the same name.
    """
    method = f"sillAndHead({global_id})"
    subject = _require(model, global_id, method)
    if subject.is_a() not in FENESTRATION:
        return _wrong_kind(
            model,
            subject,
            method,
            "sillAndHead",
            "ein Fenster, eine Tür oder eine Öffnung",
            "für die absolute Höhe eines beliebigen Bauteils: elevation(); für seine Abmessungen: extent()",
            "computed",
        )
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    datum = model.storey_datum(subject)
    if datum is None:
        name = model.label(subject) or global_id
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"IfcBuildingStorey.Elevation für {subject.is_a()} „{name}“",
                remedy=(
                    "Das Bauteil einem Geschoss zuordnen (IfcRelContainedInSpatialStructure) und die "
                    "Geschosshöhe setzen. Ohne Geschossnull ist eine Brüstungshöhe nicht bestimmbar — die "
                    "absolute Höhe über dem Projektnullpunkt liefert elevation()."
                ),
                elements=[global_id],
            ),
        )

    # The storey datum is DECLARED and the box is MEASURED; nothing in IFC makes
    # them share a reference, and a file where they do not produced sills 58 m
    # below their own floor in the TS package. See `_storey_datum_drift`.
    drift = _storey_datum_drift(model)
    if drift > 0:
        return undecidable(
            from_=[global_id, datum.global_id],
            method=method,
            provenance="computed",
            missing=_datum_mismatch(model, drift),
        )

    sill = float(geo.box[0][2]) - datum.elevation
    head = float(geo.box[1][2]) - datum.elevation
    return computed(
        {"sill": sill, "head": head, "height": head - sill},
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[global_id, datum.global_id],
        method=method,
        caveat=(
            f"Höhen über der Geschossebene „{datum.name or datum.global_id}“ ({datum.elevation} m). "
            "Gemessen an der Rohbauöffnung bzw. am Bauteilkörper — ein Fußbodenaufbau über der Geschossebene "
            "verringert die tatsächliche Brüstungshöhe um seine Dicke."
        ),
    )


def azimuth(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """Which way this element faces, as a compass bearing in degrees clockwise
    from north, plus the German 16-point name.

    ## Why this refuses without TrueNorth

    The model's +Y axis is north only if somebody said so.
    ``IfcGeometricRepresentationContext.TrueNorth`` is where they say it, and
    when it is absent the file genuinely does not know which way the building
    points. Defaulting to zero would produce a confident sentence — "diese
    Fassade liegt im Süden" — about a building that may be rotated forty degrees,
    and the sentence would be wrong in exactly the way nobody checks.

    ## Which side is "out"

    A plane has two normals and the mesh's winding does not reliably say which
    one faces the weather. Outward is decided geometrically: of the two normals,
    the one pointing AWAY from the model's plan centre. Right for every facade of
    a convex-ish building and wrong for the inner face of a courtyard wing, which
    is stated in the caveat rather than hidden.
    """
    method = f"azimuth({global_id})"
    subject = _require(model, global_id, method)

    # Checked before the geometry, because it is a fact about the whole file: an
    # answer that first complained about this element's mesh would send the
    # architect to fix the wrong thing.
    if model.true_north is None:
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="IfcGeometricRepresentationContext.TrueNorth",
                remedy=(
                    "Die Nordrichtung im Modell setzen und mitexportieren. Ohne sie ist jede Himmelsrichtung "
                    'geraten: ein um 40° gedrehtes Gebäude würde als "Südfassade" berichtet, und der Fehler ist '
                    "an der Antwort nicht zu erkennen."
                ),
            ),
        )

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    normal = dominant_vertical_plane(geo.triangles)
    if normal is None:
        name = model.label(subject) or global_id
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine senkrechte Fläche an {subject.is_a()} „{name}“",
                remedy=(
                    "Die Himmelsrichtung wird aus der größten senkrechten Fläche eines Bauteils bestimmt. "
                    "Dieses Bauteil hat keine (z. B. eine Decke oder ein Flachdach). Für die Ausrichtung eines "
                    "Raumes die begrenzende Außenwand abfragen: bounds() liefert sie."
                ),
                elements=[global_id],
            ),
        )

    centre = model.plan_centre
    if centre is None:
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="keine Modellausdehnung (kein Bauteil mit Geometrie)",
                remedy=(
                    "Ohne die Grundriss-Mitte des Modells lässt sich nicht entscheiden, welche der beiden "
                    "Flächennormalen nach außen zeigt. Das Modell mit Geometrie exportieren."
                ),
            ),
        )

    away = geo.centroid[:2] - centre[:2]
    n = normal[:2].copy()
    if float(n @ away) < 0:
        n = -n

    # North in model coordinates: `true_north` is the angle from +Y toward +X, so
    # north = (sin θ, cos θ), and east is north turned 90° clockwise.
    theta = model.true_north
    north = np.array([np.sin(theta), np.cos(theta)])
    east = np.array([north[1], -north[0]])
    # ((x % 360) + 360) % 360 with a sign-preserving fmod, exactly as the TS
    # `normaliseDegrees` does: a plain Python `%` maps −1e-14 onto 360.0 and a
    # north-facing wall would be reported as bearing 360°.
    raw_degrees = float(np.degrees(np.arctan2(float(n @ east), float(n @ north))))
    degrees = math.fmod(math.fmod(raw_degrees, 360.0) + 360.0, 360.0)

    return computed(
        {"degrees": degrees, "compass": COMPASS[int(round(degrees / 22.5)) % 16]},
        unit="°",
        tolerance=AZIMUTH_TOLERANCE_DEGREES,
        from_=[global_id],
        method=method,
        caveat=(
            "Außen ist die Normale, die von der Grundriss-Mitte des Modells wegzeigt. Für eine Wand am "
            "Innenhof oder in einem einspringenden Baukörper kann das die falsche Seite sein — dann ist die "
            "Angabe um 180° gedreht."
        ),
    )


def distance(model: SpatialModel, a: str, b: str, mode: str = "min") -> Answer[float]:
    """How far apart two elements are, in metres — in one of four senses, because
    "Abstand" means four different things and picking the wrong one silently is
    how a clearance gets certified.

      - ``min`` — the shortest distance between the two bounding BOXES. Zero when
        the boxes overlap, and the answer says so: overlapping boxes do NOT prove
        the solids touch.
      - ``centroid`` — centre to centre in 3D (Achsabstand).
      - ``horizontal`` — centre to centre in plan, Z ignored. What a plan
        drawing measures.
      - ``vertical`` — the difference in centre height. What a section measures.

    §7 maps ``min`` onto ``geom.tree.clash_clearance_many``, which WOULD give the
    true solid-to-solid distance instead of a box gap. It returns an empty tuple
    for every input on the shipped 0.8.5 wheel, so the box gap is what is
    reported — and the caveat says a box gap is what it is.
    """
    method = f"distance({a}, {b}, '{mode}')"
    first = _require(model, a, method)
    second = _require(model, b, method)
    geo_a, missing = _geometry_or_answer(model, first, method, [a, b])
    if geo_a is None:
        return missing  # type: ignore[return-value]
    geo_b, missing = _geometry_or_answer(model, second, method, [a, b])
    if geo_b is None:
        return missing  # type: ignore[return-value]

    if mode == "min":
        gap = box_gap(geo_a.box, geo_b.box)
        overlapping = boxes_overlap(geo_a.box, geo_b.box)
        value = 0.0 if overlapping else float(np.linalg.norm(np.maximum(gap, 0.0)))
        return computed(
            value,
            unit="m",
            tolerance=DIMENSION_TOLERANCE,
            from_=[a, b],
            method=method,
            caveat=(
                "Die Hüllboxen der beiden Bauteile überschneiden sich, der Abstand ist deshalb 0 m. Das heißt "
                "NICHT, dass sich die Körper berühren — eine achsparallele Hüllbox ist großzügiger als das "
                "Bauteil darin. Für eine echte Kollision sind die Flächen zu prüfen."
                if overlapping
                else "Abstand zwischen den achsparallelen Hüllboxen, nicht zwischen den Körpern. Für ein schräg "
                "stehendes oder nicht quaderförmiges Bauteil ist der wahre Abstand größer, nie kleiner."
            ),
        )

    ca, cb = geo_a.centroid, geo_b.centroid
    if mode == "centroid":
        value = float(np.linalg.norm(ca - cb))
    elif mode == "horizontal":
        value = float(np.linalg.norm(ca[:2] - cb[:2]))
    elif mode == "vertical":
        value = float(abs(ca[2] - cb[2]))
    else:
        return undecidable(
            from_=[a, b],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"unbekannter Abstandsbegriff „{mode}“",
                remedy="distance() kennt 'min', 'centroid', 'horizontal' und 'vertical'.",
            ),
        )

    return computed(
        value,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[a, b],
        method=method,
        caveat=(
            "Gemessen zwischen den Schwerpunkten. Diese sind flächengewichtet über die Dreiecke des Netzes, "
            "nicht der Volumenschwerpunkt — bei stark ungleich vernetzten Bauteilen kann der Punkt um einige "
            "Zentimeter wandern."
        ),
    )


def clear_height(model: SpatialModel, space_global_id: str, samples: int = 5) -> Answer[float]:
    """The lichte Raumhöhe — floor to the lowest thing above it, in metres.

    BESSER, and this is the operator where the engine swap changes an ANSWER and
    not just a runtime. The TS `clearHeight` returns the Z extent of the IfcSpace
    solid and says in its own caveat:

        *"Das ist die Höhe des modellierten Raumkörpers, NICHT die lichte Höhe.
        Unterzüge, Lüftungsleitungen und abgehängte Decken ragen in den Raum,
        ohne den Raumkörper zu verkürzen. Die lichte Höhe ergibt sich erst aus
        den Bauteilen im Raum — dafür fehlt dieser Bibliothek noch der
        Verschneidungstest."*

    IfcOpenShell has the intersection test. This casts ``samples × samples`` rays
    straight up from just above the floor — Solibri's free-height check — keeps
    only the sample points that are really inside the room solid, and reports the
    SHORTEST clear run found. On the sample house that is 2.20 m under the
    suspended ceiling against the 2.50 m space solid: a 30 cm difference on
    exactly the number an OIB minimum room height is checked against, and the
    modelled height is the unsafe side of it.

    Furniture is excluded by type and named in the caveat: a piano is not a
    Raumhöhe. Everything else counts, including the ceiling that made the
    difference here.
    """
    method = f"clearHeight({space_global_id}, samples={samples})"
    subject = _require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        return _wrong_kind(
            model,
            subject,
            method,
            "clearHeight",
            "einen Raum (IfcSpace)",
            "für die Höhe eines Bauteils: extent() liefert sie als height",
            "computed",
        )
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    low, high = geo.box
    modelled = float(high[2] - low[2])
    floor_z = float(low[2]) + 0.01

    tree = model.tree
    tested = 0
    shortest = modelled
    hit_by: dict[str, float] = {}
    for ix in range(samples):
        for iy in range(samples):
            x = float(low[0] + (high[0] - low[0]) * (ix + 0.5) / samples)
            y = float(low[1] + (high[1] - low[1]) * (iy + 0.5) / samples)
            # An L-shaped room's bounding box covers plan area the room does not.
            # Only points really inside the space solid may lower the answer.
            inside = [e.GlobalId for e in tree.select((x, y, floor_z + 0.05))]
            if space_global_id not in inside:
                continue
            tested += 1
            for hit in tree.select_ray((x, y, floor_z), (0.0, 0.0, 1.0), length=modelled + 5.0):
                element = model.file.by_id(hit.instance.id())
                # Every entry of FURNISHING, not just the first. `is_a(
                # "IfcFurnishingElement")` happens to catch the other two in
                # IFC4 because they are subtypes — but that subtype relation
                # does not exist in IFC2X3, where the tuple's remaining names
                # were dead code and a chair could stop a clear-height ray.
                if element.is_a() in AIR_TYPES or any(element.is_a(name) for name in FURNISHING):
                    continue
                if element.GlobalId == space_global_id:
                    continue
                # The ray starts 10 mm above the floor so it does not begin
                # inside the slab; the clear run is measured from the floor.
                run = float(hit.distance) + (floor_z - float(low[2]))
                if run <= 0.01:
                    continue
                shortest = min(shortest, run)
                hit_by.setdefault(element.GlobalId, run)
                break

    if tested == 0:
        return undecidable(
            from_=[space_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="kein Rasterpunkt lag im Raumkörper",
                remedy=(
                    "Der Raum ist für dieses Raster zu schmal oder zu zerklüftet. clearHeight() mit einem "
                    "höheren samples-Wert aufrufen; extent() liefert die modellierte Höhe ohne Rasterprüfung."
                ),
                elements=[space_global_id],
            ),
        )

    lowering = sorted(((gid, run) for gid, run in hit_by.items() if run < modelled - MIN_INTRUSION), key=lambda p: p[1])
    named = ", ".join(f"{model.label(model.file.by_guid(gid)) or gid} ({run:.3f} m)" for gid, run in lowering[:3])
    caveat = (
        f"Lichte Höhe aus {tested} von {samples * samples} Rasterpunkten, senkrecht nach oben gemessen "
        f"(geom.tree.select_ray). Der modellierte Raumkörper ist {modelled:.3f} m hoch. "
        + (
            f"Darunter hängt: {named}. "
            if lowering
            else "Kein Bauteil ragt in den Raum — lichte Höhe und Raumkörper stimmen überein. "
        )
        + "Möblierung (IfcFurnishingElement) ist ausgenommen. Ein Raster kann eine schmale Unterzugslage "
        "zwischen zwei Punkten verfehlen — für einen Nachweis das Raster verfeinern."
    )

    return computed(
        shortest,
        unit="m",
        tolerance=DIMENSION_TOLERANCE,
        from_=[space_global_id, *[gid for gid, _ in lowering]],
        method=method,
        caveat=caveat,
    )


def _storey_datum_drift(model: SpatialModel) -> float:
    """How far the declared storey elevations sit outside the model's measured
    height, in metres — ``0`` when they sit inside it.

    ``IfcBuildingStorey.Elevation`` is a DECLARED datum and the geometry is
    MEASURED, and nothing in IFC guarantees the two share a reference. The TS
    package found a Revit-in-feet file whose storeys sit on the survey datum and
    whose geometry sits on the project origin, and reported sills 58 m below
    their own floor — with a unit, a 10 mm tolerance and a `computed` provenance.
    The slack is one generous storey height, because the failure being caught is
    off by tens of metres, not by one.
    """
    bounds = model.bounds
    if bounds is None:
        return 0.0
    elevations = [s.elevation for s in model.storeys if s.elevation is not None]
    if not elevations:
        return 0.0
    below = float(bounds[0][2]) - 5.0 - min(elevations)
    above = max(elevations) - (float(bounds[1][2]) + 5.0)
    return max(0.0, below, above)


def _datum_mismatch(model: SpatialModel, drift: float) -> MissingFact:
    bounds = model.bounds
    elevations = [s.elevation for s in model.storeys if s.elevation is not None]
    return MissingFact(
        what="IfcBuildingStorey.Elevation und die Modellgeometrie liegen auf verschiedenen Höhenbezügen",
        remedy=(
            f"Die Geschosshöhen der Datei laufen von {min(elevations):.2f} m bis {max(elevations):.2f} m, "
            f"die gemessene Geometrie von {float(bounds[0][2]):.2f} m bis {float(bounds[1][2]):.2f} m — sie "
            f"verfehlen einander um {drift:.2f} m. Eine Höhe über Geschossebene wäre um diesen Betrag falsch "
            "und wird deshalb nicht ausgegeben. Ursache ist fast immer ein Export, dessen Geschosshöhen auf "
            "Meereshöhe bzw. den Vermessungspunkt bezogen sind, während die Bauteilkoordinaten auf dem "
            "Projektnullpunkt stehen. Abhilfe: im CAD Projekt- und Vermessungspunkt angleichen oder die "
            "Geschosshöhen auf den Projektnullpunkt beziehen. Die absoluten Höhen im Modellbezug liefert "
            "elevation() unverändert."
        ),
    )


# ════════════════════════════════════════════════════════════════════════════
# constructive — geometry the file does not contain, built from geometry it does
# ════════════════════════════════════════════════════════════════════════════


def facade_plane_of(model: SpatialModel, global_id: str) -> Answer[dict[str, Any]]:
    """The element's facade plane, with its normal pointing away from the building.

    The reference plane every other constructive operator measures from:

    1. **Orientation** against the model's plan centre, because a face normal
       says which orientation a face has, never which side is outside.
    2. **Seating** onto the OUTERMOST parallel face — a real surface. An
       area-weighted average over every face sharing a normal lands *inside* the
       masonry on a layered wall, and an overhang measured from there is too
       large by the wall's build-up.

    ``outward=False`` means the side could not be established (an interior
    partition near the middle of the plan). The plane is still returned — it is
    real, only its side is a guess — with a caveat saying so.
    """
    method = f"facadePlaneOf({global_id})"
    subject = _require(model, global_id, method)
    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        # A body the kernel REJECTED is a different finding from a body that was
        # never exported, and `_no_geometry` carries the kernel's own message.
        # The curtain-wall hint below only applies to the second case.
        if (model.geometry_failure(global_id) or "").startswith(("shape-failed", "empty-mesh")):
            return missing  # type: ignore[return-value]
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine Körpergeometrie für {subject.is_a()} in dieser Datei",
                remedy=(
                    "Dieses Bauteil trägt keinen eigenen Körper — eine Vorhangfassade exportiert ihre "
                    "Geometrie über Paneele und Pfosten. Die Unterbauteile abfragen, oder das Modell mit "
                    "Körpergeometrie exportieren."
                ),
                elements=[global_id],
            ),
        )

    normal = dominant_vertical_plane(geo.triangles)
    if normal is None:
        name = model.label(subject) or global_id
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine senkrechte Fläche an {subject.is_a()} „{name}“",
                remedy=(
                    "Eine Fassadenebene braucht eine senkrechte Fläche. Dieses Bauteil hat keine "
                    "(z. B. eine Decke oder ein Flachdach)."
                ),
                elements=[global_id],
            ),
        )

    centre = model.plan_centre
    away = geo.centroid[:2] - (centre[:2] if centre is not None else geo.centroid[:2])
    span = float(np.linalg.norm(away))
    n = np.array([normal[0], normal[1], 0.0])
    outward = False
    if span >= OUTWARD_MIN_SPAN:
        cos = float(n[:2] @ (away / span))
        if abs(cos) >= OUTWARD_MIN_DOT:
            outward = True
            if cos < 0:
                n = -n

    seated = outermost_parallel_face(geo.triangles, n)
    if seated is None:
        return undecidable(
            from_=[global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what=f"keine auswertbare Fassadenfläche an {subject.is_a()}",
                remedy="Das Bauteil hat senkrechte Dreiecke, aber keine zusammenhängende Fläche brauchbarer Größe.",
                elements=[global_id],
            ),
        )

    return computed(
        {
            "normal": n.tolist(),
            "point": seated.point.tolist(),
            "area": seated.area,
            "outward": outward,
        },
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[global_id],
        method=method,
        caveat=None
        if outward
        else (
            "Die Außenseite dieser Ebene ist ungesichert: das Bauteil steht zu nahe an der Grundriss-Mitte "
            "oder seine Normale zeigt quer dazu. Alle daran gemessenen Werte können im Vorzeichen kippen."
        ),
    )


def overhang(model: SpatialModel, projecting_id: str, facade_element_id: str) -> Answer[float]:
    """How far one element projects past another's facade plane, in metres.

    The number the product reported as *"Überstand nicht messbar"* on a file that
    measures it fine. Measured perpendicular to the facade plane, over every
    vertex of the projecting element's real body — so a barrel roof is measured
    at its furthest point and not at its bounding box.

    Never negative: an element that does not reach the plane reports 0 with a
    caveat saying how far behind it stops.
    """
    method = f"overhang({projecting_id}, facadePlaneOf({facade_element_id}))"
    _require(model, projecting_id, method)
    _require(model, facade_element_id, method)

    plane_answer = facade_plane_of(model, facade_element_id)
    if not plane_answer.decidable or plane_answer.value is None:
        return undecidable(
            from_=[projecting_id, facade_element_id],
            method=method,
            provenance="computed",
            missing=plane_answer.missing
            or MissingFact(
                what=f"Fassadenebene von {facade_element_id}",
                remedy="Ohne Bezugsebene ist kein Überstand messbar",
            ),
        )
    plane = plane_answer.value

    geo = model.geometry(projecting_id)
    if geo is None:
        return _no_geometry(model, model.file.by_guid(projecting_id), method, [projecting_id, facade_element_id])

    normal = np.array(plane["normal"])
    point = np.array(plane["point"])
    depths = signed_distance(geo.verts, normal, point)
    furthest = float(depths.max())

    caveats: list[str] = []
    if not plane["outward"]:
        caveats.append(plane_answer.caveat or "Die Außenseite der Bezugsebene ist ungesichert.")
    if furthest < -TESSELLATION_TOLERANCE:
        caveats.append(
            f"Das Bauteil erreicht die Fassadenebene nicht — es bleibt {abs(furthest):.3f} m dahinter. "
            "Gemeldet ist 0, nicht ein negativer Überstand."
        )

    return computed(
        max(0.0, furthest),
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[projecting_id, facade_element_id],
        method=method,
        caveat=" ".join(caveats) if caveats else None,
    )


def ray(
    model: SpatialModel,
    origin: Sequence[float],
    direction: Sequence[float],
    length: float | None = None,
    exclude: Iterable[str] | None = None,
) -> Answer[dict[str, Any] | None]:
    """The first surface a ray meets — ``geom.tree.select_ray``.

    BESSER: the intersection is against the real OCCT surface, so the hit point
    is on the building rather than on a triangle that approximates it, and the
    call also returns the **surface normal** and the **dot product** with the ray
    — which is what tells a grazing hit from a square one. The TS ray tests
    retained triangles only and has to warn, in a caveat, about elements whose
    triangles the geometry pass dropped; there is nothing to drop here.

    Spaces and openings are skipped: air does not stop light. A decidable
    ``None`` means the ray reached ``length`` without meeting anything — which is
    a real answer and must never be confused with "could not look".
    """
    # Built defensively: the arguments are not validated yet, and a `method`
    # string that formats them as floats crashed on `ray(model, "x", ...)` —
    # before the check that was supposed to reject it could run.
    method = f"ray({_vector_text(origin)}, {_vector_text(direction)}" + (f", {length})" if length is not None else ")")
    try:
        d = np.array(direction, dtype=float).reshape(3)
        o = np.array(origin, dtype=float).reshape(3)
    except (TypeError, ValueError):
        d = np.zeros(3)
        o = np.full(3, np.nan)
    bad_length = length is not None and (not np.isfinite(length) or float(length) <= 0)
    if not np.isfinite(d).all() or float(np.linalg.norm(d)) < 1e-9 or not np.isfinite(o).all() or bad_length:
        return undecidable(
            from_=[],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="brauchbarer Strahl (Richtung ≠ 0, endlicher Ursprung, Länge > 0)",
                remedy=(
                    "ray() mit einem Richtungsvektor ungleich Null, endlichen Koordinaten und einer "
                    "positiven, endlichen Länge aufrufen. Eine negative Länge liefert bei OCCT einen "
                    "Treffer hinter dem Ursprung — die Antwort sähe gültig aus und wäre es nicht."
                ),
            ),
        )
    if length is None and model.bounds is None:
        # `model.diagonal` falls back to a flat 100.0 when nothing in the file
        # has a body. Casting 100 m into a model with no geometry and reporting
        # "nichts getroffen" as decidable would dress a could-not-look up as a
        # result — the one substitution this library exists to prevent.
        return undecidable(
            from_=[],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="keine Modellausdehnung (kein Bauteil mit Geometrie)",
                remedy=(
                    "Ohne Geometrie im Modell gibt es keine Reichweite, über die ein Strahl etwas aussagen "
                    "könnte. Entweder das Modell mit Körpergeometrie exportieren oder ray() mit einer "
                    "ausdrücklichen Länge aufrufen."
                ),
            ),
        )
    d = d / np.linalg.norm(d)
    reach = float(length) if length is not None else model.diagonal
    skip = set(exclude or ())

    best: dict[str, Any] | None = None
    for hit in model.tree.select_ray(tuple(float(c) for c in o), tuple(float(c) for c in d), length=reach):
        element = model.file.by_id(hit.instance.id())
        if element.is_a() in AIR_TYPES or element.GlobalId in skip:
            continue
        if best is None or hit.distance < best["distance"]:
            best = {
                "hit": element.GlobalId,
                "name": model.label(element),
                "point": [float(c) for c in hit.position],
                "distance": float(hit.distance),
                "normal": [float(c) for c in hit.normal],
                "dotProduct": float(hit.dot_product),
            }

    return computed(
        best,
        unit="m" if best else None,
        tolerance=TESSELLATION_TOLERANCE if best else None,
        from_=[best["hit"]] if best else [],
        method=method,
    )


def prism(model: SpatialModel, opening_id: str, angle_deg: float, swivel_deg: float) -> Answer[dict[str, Any]]:
    """The light prism of a light opening — a construction, not a check.

    Anchored on the LOWER EDGE of the opening, lying in the facade plane: a ray
    arriving at the window head at ``angle_deg`` passes above the plane drawn
    from the sill, so the sill-anchored volume covers every path by which light
    at that angle or steeper can reach any point of the opening.

    Four half-spaces — ``facade``, ``incline``, ``lateralLeft``,
    ``lateralRight`` — because the volume is unbounded (it opens to the sky) and
    every test against it is a dot product. A caller can serialise the four
    planes and rebuild the volume exactly.

    The angles are PARAMETERS the caller binds from the clause. This module knows
    geometry, not law: it contains no OIB numbers, and it returns no verdict.
    """
    method = f"prism({opening_id}, {angle_deg}, {swivel_deg})"
    subject = _require(model, opening_id, method)

    if not (0 < angle_deg < 90) or not (0 <= swivel_deg < 90):
        return undecidable(
            from_=[opening_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="brauchbare Winkel (0° < angleDeg < 90°, 0° ≤ swivelDeg < 90°)",
                remedy=(
                    "Die Winkel kommen aus der Bestimmung, nicht aus dem Modell — prism() mit den Werten der "
                    "Klausel aufrufen"
                ),
                elements=[opening_id],
            ),
        )

    geo, missing = _geometry_or_answer(model, subject, method)
    if geo is None:
        return missing  # type: ignore[return-value]

    # The host wall sets the DIRECTION — its facade is decided by tens of square
    # metres, an opening's by one or two — while the plane is seated on the
    # OPENING's own outer face, because light enters at the opening and seating
    # it on the wall would hide a recessed window's own reveal shading.
    host = hosted_in(model, opening_id)
    host_id = host.value[0].global_id if host.decidable and host.value else None
    plane_answer = facade_plane_of(model, host_id or opening_id)
    if not plane_answer.decidable or plane_answer.value is None:
        plane_answer = facade_plane_of(model, opening_id)
        host_id = None
    if not plane_answer.decidable or plane_answer.value is None:
        return undecidable(
            from_=[opening_id],
            method=method,
            provenance="computed",
            missing=plane_answer.missing
            or MissingFact(
                what=f"Fassadenebene für {opening_id}",
                remedy="Ohne Fassadenebene ist die Richtung des Prismas unbestimmt",
            ),
        )

    n = np.array(plane_answer.value["normal"], dtype=float)
    n[2] = 0.0
    n = n / np.linalg.norm(n)
    lateral = np.cross(np.array([0.0, 0.0, 1.0]), n)
    lateral = lateral / np.linalg.norm(lateral)

    points = geo.verts
    u = points @ lateral
    v = points @ n
    u_min, u_max, v_max = float(u.min()), float(u.max()), float(v.max())
    z_min = float(points[:, 2].min())

    left = lateral * u_min + n * v_max
    left[2] = z_min
    right = lateral * u_max + n * v_max
    right[2] = z_min

    a = np.radians(angle_deg)
    s = np.radians(swivel_deg)
    incline = np.array([-np.sin(a) * n[0], -np.sin(a) * n[1], np.cos(a)])
    incline = incline / np.linalg.norm(incline)
    left_normal = lateral * np.cos(s) + n * np.sin(s)
    right_normal = -lateral * np.cos(s) + n * np.sin(s)

    half_spaces = [
        {"role": "facade", "normal": n.tolist(), "point": left.tolist()},
        {"role": "incline", "normal": incline.tolist(), "point": left.tolist()},
        {"role": "lateralLeft", "normal": (left_normal / np.linalg.norm(left_normal)).tolist(), "point": left.tolist()},
        {
            "role": "lateralRight",
            "normal": (right_normal / np.linalg.norm(right_normal)).tolist(),
            "point": right.tolist(),
        },
    ]

    return computed(
        {
            "openingId": opening_id,
            "facadeElementId": host_id,
            "angleDeg": angle_deg,
            "swivelDeg": swivel_deg,
            "normal": n.tolist(),
            "lateral": lateral.tolist(),
            "lowerEdge": [left.tolist(), right.tolist()],
            "sillZ": z_min,
            "halfSpaces": half_spaces,
            "reach": model.diagonal,
        },
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[opening_id] + ([host_id] if host_id else []),
        method=method + (f" über facadePlaneOf({host_id})" if host_id else f" über facadePlaneOf({opening_id})"),
        caveat=plane_answer.caveat,
    )


def obstructions(
    model: SpatialModel, volume: dict[str, Any], exclude: Iterable[str] | None = None
) -> Answer[list[dict[str, Any]]]:
    """Elements occupying the prism, and how deep each reaches into it.

    After ``geom.tree.select_box`` (broad phase over the prism's bounded extent)
    and Solibri's free-area check: the question is not "does anything touch this
    volume" but "what, and by how much", because only the second form is
    something a design decision can be made from.

    Every candidate triangle is CLIPPED against the prism's half-spaces
    (Sutherland–Hodgman; the volume is convex, so the clip is exact), and the
    depth is the maximum distance past the inclined plane over the clipped
    polygon. A vertex-inside test would have missed this file entirely: the
    sample house's roof is 376 triangles over 108 m², and a triangle spanning the
    whole prism can have every corner outside it.

    Never a candidate: spaces (air), openings (a subtraction), and the subject
    opening together with whatever fills it — a window's frame projects 40 mm past
    the facade and would otherwise report itself as its own obstruction. The HOST
    WALL is not auto-excluded, because a recessed window genuinely is shaded by
    its own reveal; that is what ``exclude`` is for.

    Returns geometry, never a verdict: a cut prism ENLARGES the required
    Lichteintrittsfläche under OIB 3, it does not ban the window.
    """
    # `volume` comes back from `prism()` and travels through a caller — an agent,
    # a JSON round-trip, a cache from a DIFFERENT model. All three can hand back
    # something that is not a prism, and a KeyError or a bare RuntimeError from
    # deep inside the broad phase tells nobody what went wrong.
    required = ("openingId", "angleDeg", "swivelDeg", "halfSpaces", "lowerEdge", "normal", "reach", "sillZ")
    if not isinstance(volume, dict) or any(k not in volume for k in required):
        absent = [k for k in required if not isinstance(volume, dict) or k not in volume]
        return undecidable(
            from_=[],
            method="obstructions(<kein Prisma>)",
            provenance="computed",
            missing=MissingFact(
                what=f"kein auswertbares Prisma: {', '.join(absent) or 'kein dict'} fehlt",
                remedy="obstructions() nimmt den Rückgabewert von prism() entgegen, unverändert.",
            ),
        )

    opening_id = volume["openingId"]
    method = (
        f"obstructions(prism({opening_id}, {volume['angleDeg']}, {volume['swivelDeg']})"
        + (f", exclude: [{', '.join(exclude)}]" if exclude else "")
        + ")"
    )

    skip = {opening_id, *(exclude or ())}
    # Through `by_id`, so a prism built against another model raises the contract
    # error instead of a raw RuntimeError from the wrapper.
    subject = _require(model, opening_id, method)
    for rel in getattr(subject, "HasFillings", []) or []:
        skip.add(rel.RelatedBuildingElement.GlobalId)
    for rel in getattr(subject, "FillsVoids", []) or []:
        skip.add(rel.RelatingOpeningElement.GlobalId)

    planes = [(np.array(h["normal"]), np.array(h["point"])) for h in volume["halfSpaces"]]
    incline = next(
        (np.array(h["normal"]), np.array(h["point"])) for h in volume["halfSpaces"] if h["role"] == "incline"
    )

    # Broad phase: the prism is unbounded, so it is boxed by the model's own
    # extent in front of the facade before it is handed to the tree.
    bounds = model.bounds
    edge = np.array(volume["lowerEdge"][0]), np.array(volume["lowerEdge"][1])
    reach = float(volume["reach"])
    corners = np.array(
        [
            edge[0],
            edge[1],
            edge[0] + np.array(volume["normal"]) * reach,
            edge[1] + np.array(volume["normal"]) * reach,
        ]
    )
    low = corners.min(axis=0) - reach * np.tan(np.radians(volume["swivelDeg"]))
    high = corners.max(axis=0) + reach * np.tan(np.radians(volume["swivelDeg"]))
    low[2] = float(volume["sillZ"])
    high[2] = float(bounds[1][2]) if bounds is not None else float(volume["sillZ"]) + reach
    if bounds is not None:
        low = np.maximum(low, bounds[0])
        high = np.minimum(high, bounds[1])

    found: list[dict[str, Any]] = []
    for element in model.tree.select_box((tuple(low.tolist()), tuple(high.tolist()))):
        if element.GlobalId in skip or element.is_a() in AIR_TYPES:
            continue
        if model.kind_of(element) != "element":
            continue
        geo = model.geometry(element.GlobalId)
        if geo is None:
            continue
        depth = -np.inf
        for triangle in geo.triangles:
            polygon: list[np.ndarray] = [triangle[0], triangle[1], triangle[2]]
            for normal, point in planes:
                polygon = clip_polygon(polygon, normal, point)
                if not polygon:
                    break
            if not polygon:
                continue
            past = float(max((p - incline[1]) @ incline[0] for p in polygon))
            depth = max(depth, past)
        if depth > MIN_INTRUSION:
            found.append(
                {
                    "globalId": element.GlobalId,
                    "name": model.label(element),
                    "intrusionDepth": round(depth, 6),
                }
            )

    found.sort(key=lambda f: -f["intrusionDepth"])
    return computed(
        found,
        unit="m",
        tolerance=TESSELLATION_TOLERANCE,
        from_=[opening_id, *[f["globalId"] for f in found]],
        method=method,
        caveat=(
            "Das ist Geometrie, kein Befund: ein durchschnittenes Prisma VERGRÖSSERT nach OIB 3 die "
            "erforderliche Lichteintrittsfläche, es verbietet das Fenster nicht. Die Winkel stammen aus dem "
            "Regelwerk, nicht aus dem Modell."
        ),
    )


def _clear_opening_area(model: SpatialModel, opening: Any) -> float | None:
    """The area of an opening's clear aperture — the Rohbaulichte.

    An ``IfcOpeningElement`` is a prism driven through the wall. Projected along
    the wall's own normal, its two end faces land on top of each other and the
    shapely UNION of the projection is exactly the clear opening — which is what
    a Lichteintrittsfläche is measured on, and which no bounding box gives for a
    round-headed or triangular window.

    The projection direction comes from the opening's own dominant vertical
    plane rather than from the host wall, so this still works where the export
    voided a wall the operator was not handed.

    ``None`` when there is no usable body or no vertical plane to project along
    — a skylight in a flat roof, an opening exported without geometry. The
    caller reports that as a gap rather than substituting a guess.
    """
    import shapely
    import shapely.ops

    global_id = getattr(opening, "GlobalId", None)
    if not global_id:
        return None
    geo = model.geometry(global_id)
    if geo is None or geo.triangles is None or len(geo.triangles) == 0:
        return None
    normal = dominant_vertical_plane(geo.triangles)
    if normal is None:
        return None

    # An orthonormal basis in the opening's plane. `up` is world Z projected
    # into the plane, so the second axis is horizontal — which keeps the
    # projected coordinates readable if this ever needs debugging.
    up = np.array([0.0, 0.0, 1.0])
    up = up - normal * float(up @ normal)
    if np.linalg.norm(up) < 1e-9:
        return None
    up = up / np.linalg.norm(up)
    across = np.cross(normal, up)

    normals, _ = triangle_normals_areas(geo.triangles)
    # Only the faces that actually lie IN the aperture plane. The prism's side
    # walls (the reveal) are perpendicular to it and project to slivers that
    # would inflate the union.
    facing = geo.triangles[np.abs(normals @ normal) > 0.9]
    if len(facing) == 0:
        return None

    polygons = []
    for tri in facing:
        flat = [(float(p @ across), float(p @ up)) for p in tri]
        polygon = shapely.Polygon(flat)
        if polygon.is_valid and polygon.area > 0:
            polygons.append(polygon)
    if not polygons:
        return None
    try:
        return float(shapely.ops.unary_union(polygons).area)
    except Exception:
        return None


def _faces_outside(model: SpatialModel, element: Any) -> tuple[bool | None, str]:
    """Whether this window or door lets daylight IN from outside.

    The first version of :func:`light_entry_area` summed every window and door
    bounding the room, and the sample house's bedroom came back at 25.3 % — of
    which an interior door to the hallway was 1.71 m². An internal door is not a
    Lichteintrittsfläche under any reading of OIB 3, and 25 % versus 14 % is the
    difference between two opposite answers to a daylight check.

    Two routes, and the declared one wins because it is the architect's own
    statement:

    1. ``Pset_*Common.IsExternal`` on the host wall.
    2. Otherwise the count of spaces the opening touches. An interior door joins
       two rooms; an external window touches one, because there is no IfcSpace
       outdoors. Weaker — a window onto an unmodelled conservatory reads as
       external — hence second.

    ``None`` means neither route decided, and the caller must report that rather
    than picking a side.
    """
    # The element's OWN declaration first. A window carries
    # `Pset_WindowCommon.IsExternal` and a curtain-wall pane carries
    # `Pset_PlateCommon.IsExternal`, and both outrank anything inferred — this
    # is the architect saying which side it faces.
    #
    # It also fixes a case the wall route cannot reach. A plate sits in no wall,
    # so `hosted_in` is empty and the space-count fallback decided it. That
    # fallback is a DOOR heuristic ("joins two rooms, therefore interior"), and
    # the sample house's glazed facade touches the living room AND the loft
    # above it — so every pane of a 4.49 m² glass wall was classified interior
    # and the room's largest daylight source counted as zero.
    own = model.declared_property(element, ("IsExternal",))
    if isinstance(own, bool):
        return own, "Pset_*Common.IsExternal am Bauteil selbst (deklariert)"

    hosts_ = hosted_in(model, element.GlobalId)
    if hosts_.decidable:
        for ref in hosts_.value or []:
            wall = model.file.by_guid(ref.global_id)
            found = model.declared_property(wall, ("IsExternal",))
            if isinstance(found, bool):
                return found, "Pset_*Common.IsExternal der Wand (deklariert)"

    touching = opens_to(model, element.GlobalId)
    if touching.decidable and touching.value is not None:
        count = len(touching.value)
        if count >= 2:
            return False, f"öffnet in {count} Räume (Innentür)"
        if count == 1:
            return True, "berührt nur einen Raum — außen liegt kein IfcSpace"
    return None, "weder IsExternal deklariert noch aus den Raumberührungen ableitbar"


def light_entry_area(model: SpatialModel, space_global_id: str) -> Answer[dict[str, Any]]:
    """The room's light-entry area, and what fraction of its floor that is.

    The other half of the answer this library was built because of. The agent
    could not measure the Dachüberstand, and it could not measure the *Raum-%*
    either — the ratio an OIB 3 daylight check is decided on. `overhang` closed
    the first gap; this closes the second.

    For every window and door bounding the room, the operator walks
    ``FillsVoids → RelatingOpeningElement`` and measures that opening's clear
    aperture (:func:`_clear_opening_area`), then divides the sum by
    :func:`floor_area`. Both numbers and the ratio come back together, because a
    ratio whose two inputs are not visible cannot be checked by the person who
    has to sign it.

    ## What this deliberately does not do

    It applies no threshold. OIB 3 names a percentage; that percentage is a fact
    about the *clause*, and the same refusal that keeps `light_incidence` from
    supplying its own 45° keeps this from reporting „erfüllt".

    It also does not decide WHICH area the clause means. This measures the
    structural clear opening — the Rohbaulichte. A regulation may instead mean
    the glazed area, or the clear opening less frame and sash, and the
    difference on an ordinary window is 15–25 %. Substituting one for the other
    silently would be the most expensive kind of wrong: a number that is right
    to the millimetre and answers a different question. So the caveat says which
    was measured, and the clause decides whether that is the one it wants.
    """
    method = f"lightEntryArea({space_global_id})"
    subject = _require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        return _wrong_kind(
            model,
            subject,
            method,
            "lightEntryArea",
            "ein Raum (IfcSpace)",
            "für ein einzelnes Fenster: measure/extent",
            "computed",
        )

    floor = floor_area(model, space_global_id)
    if not floor.decidable or not floor.value:
        return undecidable(
            from_=[space_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="die Bodenfläche des Raums",
                remedy=(
                    "Ohne Bodenfläche ist kein Flächenanteil bildbar. Zuerst measure/floorArea aufrufen — "
                    "die Antwort dort nennt, was fehlt."
                ),
            ),
        )

    bounding = bounds(model, space_global_id)
    if not bounding.decidable:
        return bounding  # type: ignore[return-value]

    openings: list[dict[str, Any]] = []
    without_geometry: list[str] = []
    # `IfcPlate` is here because of a real hole: the sample house's living room
    # is glazed with a curtain wall, and a curtain wall is exported as members
    # and PLATES, not as windows. Counting only IfcWindow/IfcDoor made the
    # largest glazed surface in the building contribute exactly nothing — a
    # fully glazed room reporting 0 % daylight. That is the safe direction for a
    # threshold and still a false finding, and an architect shown 0 % on a glass
    # wall stops trusting the number that is right.
    #
    # Plates carry no IfcOpeningElement (they fill no void; they ARE the wall),
    # so they land on the element-body route below and are labelled as such.
    GLAZING = ("IfcWindow", "IfcDoor", "IfcPlate")
    for ref in bounding.value or []:
        if ref.ifc_type not in GLAZING:
            continue
        element = model.file.by_guid(ref.global_id)
        voids = [rel.RelatingOpeningElement for rel in (getattr(element, "FillsVoids", []) or [])]
        area = None
        via = "IfcOpeningElement"
        for void in voids:
            area = _clear_opening_area(model, void)
            if area:
                break
        if not area:
            # No opening bookkeeping, or an opening without a body. The element's
            # own aperture is the next best thing and is NOT the same number —
            # it includes the frame — so it is labelled, not silently mixed in.
            area = _clear_opening_area(model, element)
            via = (
                "Verglasungsfeld (Vorhangfassade, Rahmen enthalten)"
                if ref.ifc_type == "IfcPlate"
                else "Bauteilkörper (Rahmen enthalten)"
            )
        if not area:
            without_geometry.append(ref.global_id)
            continue
        external, why = _faces_outside(model, element)
        openings.append(
            {
                "globalId": ref.global_id,
                "name": ref.name,
                "ifcType": ref.ifc_type,
                "area": round(area, 6),
                "via": via,
                "external": external,
                "because": why,
            }
        )

    if not openings:
        return undecidable(
            from_=[space_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="keine messbare Fensteröffnung an diesem Raum",
                remedy=(
                    "Entweder grenzt an diesen Raum kein Fenster und keine Tür, oder deren Öffnungen "
                    "tragen keine Geometrie. bounds() zeigt, was den Raum begrenzt."
                ),
            ),
        )

    # ONLY the openings that face outside are summed. An interior door is not a
    # Lichteintrittsfläche under any reading of OIB 3, and including one took the
    # sample house's bedroom from 14.2 % to 25.3 % — two opposite answers to the
    # same daylight check. The others stay in the payload, labelled, because a
    # number is only checkable when what was left out of it is visible.
    external = [entry for entry in openings if entry["external"] is True]
    internal = [entry for entry in openings if entry["external"] is False]
    unknown = [entry for entry in openings if entry["external"] is None]

    total = sum(entry["area"] for entry in external)
    ratio = total / float(floor.value)

    caveat = (
        "Gemessen ist die ROHBAULICHTE (die lichte Öffnung im Mauerwerk), nicht die Glasfläche und nicht "
        "die Öffnung abzüglich Rahmen und Flügel — der Unterschied beträgt bei einem üblichen Fenster "
        "15–25 %. Welche dieser Flächen die Bestimmung meint, entscheidet die Bestimmung. Kein Grenzwert "
        "angewandt: der Prozentsatz stammt aus dem Regelwerk, nicht aus dem Modell."
    )
    if internal:
        caveat += (
            f" {len(internal)} innenliegende Öffnung(en) sind NICHT eingerechnet (eine Innentür belichtet "
            "nicht von außen); sie stehen unter „innenliegend“ mit Begründung."
        )
    if unknown:
        caveat += (
            f" Bei {len(unknown)} Öffnung(en) ließ sich außen/innen nicht bestimmen — sie sind WEDER "
            "eingerechnet noch verworfen und stehen unter „unbestimmt“. Abhilfe: IsExternal an der Wand "
            "setzen. Solange das offen ist, ist der Anteil eine Untergrenze."
        )
    if not external:
        caveat += (
            " Keine einzige außenliegende Öffnung an diesem Raum: der Anteil ist 0 %, was ein Befund über "
            "die Zuordnung im Export sein kann und nicht zwingend über den Raum."
        )
    if any(entry["via"] != "IfcOpeningElement" for entry in openings):
        caveat += (
            " Für mindestens eine Öffnung war kein IfcOpeningElement mit Geometrie vorhanden; dort wurde "
            "der Bauteilkörper gemessen, der den Rahmen einschließt und damit zu GROSS ist."
        )
    if without_geometry:
        caveat += (
            f" {len(without_geometry)} Öffnung(en) ohne verwertbare Geometrie sind NICHT enthalten — "
            "die Summe ist insofern eine Untergrenze."
        )
    if bounding.provenance == "computed" and bounding.caveat:
        caveat += f" Raumbegrenzung: {bounding.caveat}"

    return computed(
        {
            "lightEntryArea": round(total, 4),
            "floorArea": round(float(floor.value), 4),
            "ratio": round(ratio, 5),
            "percent": round(ratio * 100.0, 2),
            "openings": external,
            "innenliegend": internal,
            "unbestimmt": unknown,
        },
        unit="m²",
        tolerance=abs(total) * AREA_RELATIVE_TOLERANCE,
        from_=[space_global_id, *[entry["globalId"] for entry in external]],
        method=method,
        caveat=caveat,
    )


__all__ = [
    "adjacent_spaces",
    "azimuth",
    "bounds",
    "clear_height",
    "container_of",
    "contains",
    "distance",
    "elevation",
    "enclosed_by",
    "extent",
    "facade_plane_of",
    "filler_of",
    "floor_area",
    "hosted_in",
    "hosts",
    "light_entry_area",
    "obstructions",
    "opens_to",
    "overhang",
    "prism",
    "ray",
    "sill_and_head",
]
