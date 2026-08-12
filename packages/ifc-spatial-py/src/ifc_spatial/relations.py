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

    ordered = [found[key] for key in sorted(found)]
    return declared(model.refs(ordered), from_=[global_id, *[e.GlobalId for e in ordered]], method=method)


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
        return _wrong_kind(
            model,
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
