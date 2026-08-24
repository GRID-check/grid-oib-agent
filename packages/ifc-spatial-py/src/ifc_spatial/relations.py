"""The two topological reads the spike left out, added for the tool surface.

``COVERAGE.md`` records ``connects`` and ``elementsOfStorey`` as **direct** and
**better than ours** respectively, and as *not ported* — they were skipped
because the parity table did not need them to answer its question. The tool
surface does need them: ``relations`` exposes eleven relation names with a
German gloss each, and shipping nine of them with two silently missing would
make the enum lie about what this engine can do.

They live here rather than in :mod:`ifc_spatial.operators` because that module
is the spike's frozen parity spec — the thing the 37 tests measure against — and
appending to it after the measurement would blur what was measured. Everything
else is unchanged: same envelope, same German, same rule that an unknown
GlobalId raises.
"""

from __future__ import annotations

from typing import Any

import ifcopenshell.util.element as ue

from .envelope import Answer
from .envelope import ElementRef
from .envelope import MissingFact
from .envelope import declared
from .envelope import undecidable
from .model import SpatialModel
from .operators import _RELATIONS
from .operators import _wrong_kind


def connects(model: SpatialModel, global_id: str) -> Answer[list[ElementRef]]:
    """Elements physically joined to this one — wall-to-wall corners and
    T-joints, beam-to-column connections.

    ``IfcRelConnectsPathElements`` and ``IfcRelConnectsElements``, traversed in
    BOTH directions. The relation is symmetric in meaning and IFC stores it once
    with a fixed relating/related orientation, so reading only ``ConnectedTo``
    would make the answer depend on which of two walls the caller happened to
    ask about — the kind of silent asymmetry that reads as a modelling defect
    and is not one.

    Most exports write no connections at all, which is why the absence is an
    ``undecidable`` with the relation named rather than an empty list: "diese
    Wand schließt an nichts an" is a claim about a building that would be false
    for every building ever built.

    ## Why the presence test is per TYPE and not per FILE

    The file-wide test — does this model contain any ``IfcRelConnects*`` at all
    — passes on an export that wrote connections for ONE kind of element, and
    then every other kind gets the confident empty list the paragraph above
    calls false for every building ever built. Both ArchiCAD files in the corpus
    do exactly that: ``AC20-Institute-Var-2.ifc`` carries 216
    ``IfcRelConnectsPathElements``, every one of them
    ``IfcWallStandardCase``-to-``IfcWallStandardCase``, so the guard passed and
    all 77 ``IfcDoor``, 206 ``IfcWindow``, 26 ``IfcSlab``, 12 ``IfcRailing``,
    4 ``IfcStair`` and 2 ``IfcColumn`` were answered „joined to nothing" with
    ``decidable=True``. ``AC20-FZK-Haus.ifc`` is the same shape at 16 + 16.

    So the subject's OWN type has to appear on at least one side of at least one
    connection relation in this file before an empty answer counts as a
    measurement. Subtypes count as their supertype (``subject.is_a(T)``), so a
    file that connects ``IfcWall`` still answers for an ``IfcWallStandardCase``.
    The type set is built once per model and cached on it, because this operator
    runs per element: re-deriving it would walk the Institute's 216 relations
    once for each of its 988 ``IfcElement``. Cached, the whole sweep of those
    988 takes 0.28 s.

    An element that DOES carry connections is answered from them without the
    type test ever being consulted — the traversal is the measurement, and it
    cannot be wrong about a relation it is holding.
    """
    method = f"connects({global_id})"
    subject = model.by_id(global_id, method)

    if not _has(model, "IfcRelConnectsElements") and not _has(model, "IfcRelConnectsPathElements"):
        return undecidable(
            from_=[global_id],
            method=method,
            missing=MissingFact(what=_RELATIONS["connects"][0], remedy=_RELATIONS["connects"][1]),
        )

    found: dict[str, Any] = {}
    for rel in getattr(subject, "ConnectedTo", None) or []:
        other = getattr(rel, "RelatedElement", None)
        if other is not None and other.GlobalId != global_id:
            found[other.GlobalId] = other
    for rel in getattr(subject, "ConnectedFrom", None) or []:
        other = getattr(rel, "RelatingElement", None)
        if other is not None and other.GlobalId != global_id:
            found[other.GlobalId] = other

    if not found:
        connected = _connected_types(model)
        if not any(subject.is_a(name) for name in connected):
            return _no_connections_for_this_type(subject, connected, method)

    ordered = [found[key] for key in sorted(found)]
    return declared(model.refs(ordered), from_=[global_id, *[e.GlobalId for e in ordered]], method=method)


def _connected_types(model: SpatialModel) -> frozenset[str]:
    """The IFC types this file writes connections for, built once per model.

    Cached on the model rather than recomputed: ``connects`` is called per
    element, and the Institute's 216 relations would otherwise be walked once
    for each of its 988 ``IfcElement``.
    """
    cached = getattr(model, "_connected_types", None)
    if cached is not None:
        return cached
    names: set[str] = set()
    for relation_type in ("IfcRelConnectsElements", "IfcRelConnectsPathElements"):
        try:
            relations = model.file.by_type(relation_type)
        except RuntimeError:
            continue
        for relation in relations:
            for attribute in ("RelatingElement", "RelatedElement"):
                element = getattr(relation, attribute, None)
                if element is not None:
                    names.add(element.is_a())
    frozen = frozenset(names)
    model._connected_types = frozen  # type: ignore[attr-defined]
    return frozen


def _no_connections_for_this_type(subject: Any, connected: frozenset[str], method: str) -> Answer[Any]:
    """The refusal for an element whose whole TYPE the export left unconnected."""
    written = ", ".join(sorted(connected)) if connected else "keine"
    return undecidable(
        from_=[subject.GlobalId],
        method=method,
        missing=MissingFact(
            what=(
                f"{_RELATIONS['connects'][0]} für {subject.is_a()} — diese Datei schreibt Bauteil"
                f"verbindungen ausschließlich für: {written}. Für {subject.is_a()} steht in keiner einzigen "
                "Verbindungsbeziehung ein Bauteil, weder auf der einen noch auf der anderen Seite."
            ),
            remedy=(
                f"Dass hier nichts steht, heißt NICHT, dass dieses Bauteil an nichts anschließt: der Export "
                f"legt für {subject.is_a()} überhaupt keine Verbindungen an. ArchiCAD etwa schreibt nur "
                "Wand-an-Wand. Abhilfe: den Export mit Bauteilverbindungen für alle Bauteilarten wiederholen "
                "(IfcRelConnectsElements / IfcRelConnectsPathElements). Bis dahin ist der Anschluss "
                "geometrisch zu prüfen — hostedIn() für ein Bauteil in einer Wand, bounds() für die Bauteile "
                "an einem Raum, distance() für den Abstand zweier Bauteile."
            ),
            elements=[subject.GlobalId],
        ),
    )


def elements_of_storey(model: SpatialModel, storey_global_id: str) -> Answer[list[ElementRef]]:
    """Everything on this storey.

    BESSER: ``ifcopenshell.util.element.get_decomposition`` walks aggregation
    AND containment, which is exactly the chain the TS parser had to resolve by
    hand. The difference is not academic — a door assigned to a space, or a beam
    inside an assembly, is contained by the space or the assembly and would be
    missing from a walk of ``IfcRelContainedInSpatialStructure`` out of the
    storey. It is still on the storey, and every per-floor count ("wie viele
    Fenster im Erdgeschoß") is wrong if it is left out.

    The storey itself is excluded, and each element appears at most once.
    """
    method = f"elementsOfStorey({storey_global_id})"
    subject = model.by_id(storey_global_id, method)

    if model.kind_of(subject) != "storey":
        _wrong_kind(
            subject,
            method,
            "elementsOfStorey",
            "ein Geschoss (IfcBuildingStorey)",
            "für einen Raum oder ein Gebäude: contains()",
        )

    # The storey resolution is model-wide or absent — if the export wrote no
    # spatial containment at all, nothing decomposes out of any storey, and
    # "dieses Geschoss ist leer" would be a wrong answer about a building that
    # has floors.
    if not _has(model, "IfcRelContainedInSpatialStructure") and not _has(model, "IfcRelAggregates"):
        return undecidable(
            from_=[storey_global_id],
            method=method,
            missing=MissingFact(what=_RELATIONS["containsElement"][0], remedy=_RELATIONS["containsElement"][1]),
        )

    seen: dict[str, Any] = {}
    for element in ue.get_decomposition(subject) or []:
        global_id = getattr(element, "GlobalId", None)
        if not global_id or global_id == storey_global_id:
            continue
        seen.setdefault(global_id, element)

    ordered = [seen[key] for key in sorted(seen)]
    return declared(model.refs(ordered), from_=[storey_global_id, *[e.GlobalId for e in ordered]], method=method)


def _has(model: SpatialModel, ifc_type: str) -> bool:
    try:
        return len(model.file.by_type(ifc_type)) > 0
    except RuntimeError:
        return False


__all__ = ["connects", "elements_of_storey"]
