"""The door/space traversal graph — what `adjacent_spaces` deliberately is not.

:func:`~ifc_spatial.operators.adjacent_spaces` answers *which rooms border which*
and says in its own caveat that neighbourhood is "NICHT begehbare Verbindung".
Two rooms sharing a wall with no door between them are neighbours and mutually
unreachable, and no operator in this package could tell those apart from two
rooms joined by a door. That gap is item 9 of §5 of
``docs/roadmap/agent-spatial-reasoning.md`` ("Door/space traversal graph + path
lengths"), and §7 lists it as ``pathBetween(space, target)`` with Solibri's
escape-route analysis and Cypher4BIM's *space accessibility* category as the
prior art. This module is that item.

It exists because OIB Richtlinie 2 turns on **Fluchtweglängen** — how far it is
from a room to the outside along a route a person can actually walk. Three
operators, one graph:

  - :func:`door_graph` — the graph itself: ``IfcSpace`` nodes plus one synthetic
    OUTSIDE node, doors as edges.
  - :func:`egress_path` — the shortest route from a room to OUTSIDE, with a
    length.
  - :func:`reachable_from` — everything behind this room's doors, with hop
    counts, and therefore also the rooms with no way out at all.

## The length is the part that can be misread, so read this

:func:`egress_path` returns a **polyline through centroids**: room centre → door
→ room centre → …, measured in plan. That is a defensible ordering of rooms by
distance and it is **not** a Fluchtweglänge. A Fluchtweg is measured along the
path a person walks — around furniture, around corners, through the detour a
door leaf forces. The centroid polyline cuts corners and goes diagonally through
walls, so it is normally SHORTER than the real route, and a too-short escape
route is the dangerous direction: it makes an over-long path look unremarkable.
Every answer says so in German, at length, and the number is stated as an
*Untergrenze*.

The opposite error is in this file too, and it is worth naming because it shows
the method's character rather than a bug: routing through the *centre* of a
large room can be longer than walking along its edge. On the sample house the
bedroom's route detours through the living room's centroid and comes back, which
adds roughly 2 m to a 15.5 m figure. The polyline sorts rooms; it does not
measure a Fluchtweg.

## What is NOT a walkable edge, and why each exclusion is here

  - **Windows are never edges.** A window is an opening, not a passage. This is
    not pedantry: in the sample house the bedroom's window (``…VyWcE``) touches
    only the bedroom, so if windows were edges the bedroom would get a direct
    exit **1.93 m** long instead of its real 15.49 m route through two other
    rooms — an eight-fold understatement of the only number this module exists
    to produce.
  - **``PredefinedType = TRAPDOOR`` is excluded.** A hatch in a floor or ceiling
    is a connection, but not a *walkable* one — a Fluchtweg cannot run through a
    ladder. The door is recorded under ``excluded`` with its reason, never
    silently dropped.
  - **``GATE``, ``USERDEFINED``, ``NOTDEFINED`` and a missing PredefinedType are
    included.** IFC2X3 has no ``PredefinedType`` on ``IfcDoor`` at all and a
    large share of IFC4 exports write ``NOTDEFINED``; excluding those would
    empty the graph on ordinary files and report every room as having no way
    out. Strictness here does not produce caution, it produces a wrong finding.
  - **Revolving doors are included.** Escape-route rules frequently discount
    them — but that is a fact about the *clause*, and this layer applies no
    clauses. It reports the door and its ``OperationType`` is visible on the
    type; the rule decides.
  - **A door touching no space is not an edge.** It connects nothing this file
    models. Recorded under ``excluded``.
  - **A door touching exactly one space is an exit only if it faces outside.**
    :func:`~ifc_spatial.operators._faces_outside` already makes exactly this
    distinction and prefers the architect's own ``Pset_*Common.IsExternal`` on
    the host wall over the geometric fallback. When the wall declares
    ``IsExternal = False`` and only one space is found, the far side is a room
    the export did not model — **not** the open air. Inventing an OUTSIDE edge
    there would hand a room a way out that does not exist, which is the
    dangerous direction again, so it is recorded under ``excluded`` instead.

## What the graph cannot see, and therefore what it will get wrong

  - **Stairs, ramps and lifts are not edges.** Doors are the only edge type, so
    a route that leaves the storey is not representable. On a multi-storey
    building every length here is a *within-storey* figure and the vertical
    travel is missing entirely.
  - **Openings without a door are invisible.** A wall opening between kitchen
    and living room, or an ``IfcVirtualElement`` boundary, is walkable and
    produces no edge — so the graph may report a longer route, or none, where a
    shorter one exists. That direction is the conservative one, which is why it
    is a caveat and not a refusal.
  - The centroid is the *area-weighted* mesh centroid (see
    :class:`~ifc_spatial.model.ElementGeometry`). For an L-shaped room it can
    fall outside the room's own footprint.

## No verdicts, and no thresholds — including the obvious one

OIB Richtlinie 2 names a maximum length. That number is a fact about the clause,
not about the building, and it appears nowhere in this module: the same refusal
that keeps ``light_incidence`` from supplying its own 45° keeps this from
reporting whether a route is short enough. No answer here passes or fails
anything, and no metre threshold is written down.

## Cost, and the admission test that bounds it

``opens_to`` answers from ``IfcRelSpaceBoundary`` when the export writes it, at
dictionary speed. When it does not — and the sample house does not, it holds
**zero** ``IfcRelSpaceBoundary`` entries — it falls back to
:meth:`~ifc_spatial.model.SpatialModel.space_contacts`, one OCCT offset per
room. Measured on the sample house: **7.9 s** for the whole graph, of which
6.3 s is the contact map (4 rooms, ~1.6 s each) and 1.0 s the OCCT tree; the
second build is 0.0006 s because both are cached on the model. Shaping the seven
elements the graph needs a centroid for costs 0.011 s, so no model-wide
:meth:`~ifc_spatial.model.SpatialModel.geometry_pass` is triggered — that would
be 2.3 s for products nobody asked about.

Three bounds, all of them borrowed rather than invented:

  1. :data:`~ifc_spatial.model.DERIVED_BOUNDARY_MAX_PRODUCTS` — checked BEFORE
     any offset starts, because a single ``tree.select`` on a 3 729-product
     export ran over 200 s and cannot be interrupted. If no door carries a
     declared boundary and the model is over the limit, the graph is refused
     rather than begun.
  2. :data:`~ifc_spatial.model.CONTACT_BUDGET_SECONDS` — if the contact map came
     back truncated, the graph is a SUBSET and is refused outright. A missing
     door edge is a missing escape route, and a short graph is not
     distinguishable from a building with fewer doors.
  3. The built graph is memoised on the ``SpatialModel``. Not in a module-level
     dict keyed by path: :mod:`ifc_spatial.cache` already keys models by the
     **sha256 of the bytes**, so one model instance *is* one content hash, and a
     memo that lives and dies with it can never serve a graph built from
     different bytes. A path-keyed table can, exactly once, and that is the
     failure nobody debugs.
"""

from __future__ import annotations

import heapq
import math
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import operators as op
from .envelope import Answer
from .envelope import ElementRef
from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import undecidable
from .model import CONTACT_BUDGET_SECONDS
from .model import SpatialModel

#: The synthetic node standing for "outdoors". A GlobalId is 22 characters of
#: base64; this is six letters, so it cannot collide with one — which matters,
#: because the node id travels in the same list as real ids.
OUTSIDE = "AUSSEN"

#: How the OUTSIDE node names itself. It is deliberately an :class:`ElementRef`
#: like every other node: a caller rendering the route must not need a special
#: case for the one node that has no ``IfcSpace`` behind it.
OUTSIDE_REF = ElementRef(
    global_id=OUTSIDE,
    ifc_type="—",
    name="Freie (außerhalb des Gebäudes)",
    kind="outside",
    via="synthetischer Knoten — außen liegt kein IfcSpace",
)

#: ``IfcDoorTypeEnum`` values that are a connection but not a walkable one.
#: ``GATE`` is walkable and is not in here; ``TRAPDOOR`` needs a ladder.
NON_TRAVERSABLE_DOOR_TYPES = frozenset({"TRAPDOOR"})

_POLYLINE_CAVEAT = (
    "Die Länge ist ein POLYGONZUG durch die Raumschwerpunkte und die Türmittelpunkte, in der Grundrissebene "
    "gemessen: Raummitte → Tür → Raummitte → … Das ist NICHT die Fluchtweglänge, wie sie geprüft wird. Ein "
    "Fluchtweg wird entlang des tatsächlich begehbaren Weges gemessen — um Möbel, Einbauten und Ecken herum, "
    "mit den Umwegen, die ein Türblatt und sein Schwenkbereich erzwingen. Dieser Polygonzug schneidet Ecken "
    "ab, verläuft diagonal durch Wände und kennt keine Einrichtung; er ist deshalb in aller Regel KÜRZER als "
    "der wirkliche Weg. Das ist die gefährliche Richtung: ein zu kurz gemessener Weg lässt einen zu langen "
    "Weg unauffällig aussehen. Diese Zahl ist eine UNTERGRENZE und darf nicht als Fluchtweglänge im Sinne "
    "der OIB-Richtlinie 2 verwendet werden. Sie kann umgekehrt auch zu lang werden, wenn sie durch die Mitte "
    "eines großen Raums führt, obwohl man an dessen Rand entlangginge. Kurz: die Zahl ordnet Räume nach "
    "Entfernung, sie bemisst keinen Weg."
)

_STRUCTURE_CAVEAT = (
    "Der Graph kennt ausschließlich Türen. Treppen, Rampen und Aufzüge sind keine Kanten, ein Weg über ein "
    "anderes Geschoss ist damit nicht abbildbar. Wanddurchbrüche ohne Tür und IfcVirtualElement-Grenzen sind "
    "ebenfalls unsichtbar — dort kann der Graph einen längeren Weg oder gar keinen melden, obwohl ein "
    "kürzerer begehbar ist."
)

_ENDPOINT_CAVEAT = (
    "Die letzte Teilstrecke endet an der Außentür, nicht an einem sicheren Ort im Freien: außerhalb des "
    "Gebäudes gibt es keinen IfcSpace und damit keinen Punkt, auf den gemessen werden könnte."
)

_CENTROID_CAVEAT = (
    "Gemessen wird auf den flächengewichteten Schwerpunkt des Raumkörpers. Bei L-förmigen oder anderweitig "
    "nicht konvexen Räumen kann dieser Punkt außerhalb des Raums liegen."
)

#: Where the memoised build hangs. On the model, not in a module-level table —
#: see the module docstring for why the difference is not cosmetic.
_MEMO_ATTR = "_ifc_spatial_circulation_build"


@dataclass(frozen=True)
class DoorEdge:
    """One door, as an undirected edge between two nodes.

    ``length`` is the whole traverse — centroid of ``a`` → door → centroid of
    ``b`` — so that summing the edges of a route gives the route's polyline
    without the caller having to hold any coordinates. For an edge to
    :data:`OUTSIDE` it is the half-leg room → door, because there is no point
    outdoors to measure to. ``None`` means at least one endpoint has no usable
    body in this file; the edge is still traversable, it is just not measurable.
    """

    global_id: str
    name: str | None
    ifc_type: str
    predefined_type: str | None
    #: Node ids, sorted, so an edge has one spelling. :data:`OUTSIDE` sorts as
    #: the plain string it is.
    a: str
    b: str
    length: float | None
    external: bool
    #: How the door's rooms were resolved — the provenance of THIS edge.
    via: str
    #: True when the door touched more than two spaces, which no real door does:
    #: the derivation caught a neighbouring room at the contact tolerance. The
    #: edges are kept (dropping a real external door would strand a room) and
    #: the ambiguity is stated.
    ambiguous: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "ifcType": self.ifc_type,
            "predefinedType": self.predefined_type,
            "verbindet": [self.a, self.b],
            "length": self.length,
            "external": self.external,
            "via": self.via,
            "ambiguous": self.ambiguous,
        }


@dataclass(frozen=True)
class DoorGraph:
    """Nodes, edges, and — just as important — the doors that became neither.

    ``unresolved`` and ``excluded`` are not diagnostics to be dropped by a
    renderer. A door whose rooms could not be determined is a hole in every
    route this graph produces, and a reader who sees only ``edges`` cannot tell
    a building with three doors from a building with five doors of which two
    were unreadable.
    """

    nodes: tuple[ElementRef, ...]
    edges: tuple[DoorEdge, ...]
    #: Doors whose rooms ``opens_to`` could not determine, each with the German
    #: ``what`` it gave as the reason.
    unresolved: tuple[dict[str, Any], ...]
    #: Doors deliberately not made into edges, each with the reason.
    excluded: tuple[dict[str, Any], ...]
    #: Wall-clock seconds the build cost, first time. Reported because the cost
    #: is unbounded in the model and a caller sizing a request needs the number.
    build_seconds: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodes": [ref.to_dict() for ref in self.nodes],
            "edges": [edge.to_dict() for edge in self.edges],
            "unbestimmt": list(self.unresolved),
            "ausgeschlossen": list(self.excluded),
            "buildSeconds": round(self.build_seconds, 3),
        }


@dataclass(frozen=True)
class _Build:
    """The memoised result — either a graph, or the reason there is none.

    A :class:`MissingFact` is cached rather than a finished ``Answer`` because
    ``method`` differs per caller (``doorGraph()`` against ``egressPath(<id>)``)
    and an ``Answer`` is mutable. Handing the same object to two callers is how
    a caveat written by one shows up in the other's answer.
    """

    graph: DoorGraph | None
    missing: MissingFact | None
    provenance: str
    from_: list[str]
    caveat: str | None


# ── the graph ───────────────────────────────────────────────────────────────


def door_graph(model: SpatialModel) -> Answer[DoorGraph]:
    """The walkable graph: ``IfcSpace`` nodes plus OUTSIDE, doors as edges.

    Every ``IfcSpace`` in the file is a node whether or not a door reaches it,
    because a room with no edges is the finding — that is how "dieser Raum hat
    keinen Ausgang" becomes visible instead of the room simply being absent from
    a list.

    Each edge is built from :func:`~ifc_spatial.operators.opens_to`. A door
    touching two spaces joins them; a door touching one space joins it to
    :data:`OUTSIDE`, but only when
    :func:`~ifc_spatial.operators._faces_outside` agrees — there is no
    ``IfcSpace`` outdoors, which is exactly how an external door is detectable,
    and the same absence is produced by a room the exporter never modelled. See
    the module docstring for the full list of what is not an edge and why.

    ``provenance`` is ``declared`` only when every edge came from an
    ``IfcRelSpaceBoundary``; one derived edge makes the whole graph ``computed``,
    because a route is only as trustworthy as its weakest hop.
    """
    method = "doorGraph()"
    build = _cached_build(model)
    if build.graph is None:
        return _refuse(build, method)
    graph = build.graph
    from_ = [ref.global_id for ref in graph.nodes if ref.global_id != OUTSIDE]
    from_ += [edge.global_id for edge in graph.edges]
    if build.provenance == "declared":
        return declared(graph, from_=from_, method=method, caveat=build.caveat)
    return computed(graph, from_=from_, method=method, caveat=build.caveat)


def _cached_build(model: SpatialModel) -> _Build:
    cached = getattr(model, _MEMO_ATTR, None)
    if isinstance(cached, _Build):
        return cached
    built = _build(model)
    setattr(model, _MEMO_ATTR, built)
    return built


def _build(model: SpatialModel) -> _Build:
    t0 = time.perf_counter()
    spaces = list(model.file.by_type("IfcSpace"))
    doors = list(model.file.by_type("IfcDoor"))

    # Both of these are refusals about the EXPORT, and both have to come before
    # anything is measured. An empty graph would render as "es gibt keinen Weg
    # nach draußen", which is a statement about a building; "dieser Export
    # enthält keine Türen" is a statement about a file, and only the second one
    # is true.
    if not spaces:
        return _Build(
            graph=None,
            missing=MissingFact(
                what="IfcSpace",
                remedy=(
                    "Dieser Export enthält keine Räume. Räume im CAD als IfcSpace exportieren — ohne Räume "
                    "gibt es keine Knoten, zwischen denen ein Weg verlaufen könnte."
                ),
            ),
            provenance="declared",
            from_=[],
            caveat=None,
        )
    if not doors:
        return _Build(
            graph=None,
            missing=MissingFact(
                what="IfcDoor",
                remedy=(
                    "Dieser Export enthält keine Türen. Türen als IfcDoor mit Raumbezug exportieren "
                    "(idealerweise zusätzlich Space Boundaries 2nd level) — ohne Türen hat der Graph keine "
                    "Kanten, und jeder Raum sähe ausweglos aus, obwohl das eine Aussage über den Export wäre "
                    "und nicht über das Gebäude."
                ),
            ),
            provenance="declared",
            from_=[],
            caveat=None,
        )

    # The admission test, stated before the first offset rather than discovered
    # during it. `opens_to` would reach the same refusal per door, but only
    # after `space_contacts` has already been entered — and on a model this size
    # a single OCCT offset has been measured at over 200 s with no interruption
    # point. Reading `ProvidesBoundaries` on every door to find out whether the
    # cheap route exists costs nothing.
    declared_route = any(getattr(door, "ProvidesBoundaries", None) for door in doors)
    if not declared_route and not model.derivable_boundaries:
        refusal = op._too_big_to_derive(model, "doorGraph()", doors[0].GlobalId)
        return _Build(
            graph=None,
            missing=refusal.missing,
            provenance="computed",
            from_=[doors[0].GlobalId],
            caveat=None,
        )

    nodes = [model.ref(space) for space in spaces]
    nodes.append(OUTSIDE_REF)
    known = {space.GlobalId for space in spaces}

    edges: list[DoorEdge] = []
    unresolved: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    derived_any = False

    for door in sorted(doors, key=lambda d: d.GlobalId):
        predefined = getattr(door, "PredefinedType", None)
        predefined = str(predefined) if predefined is not None else None
        if predefined in NON_TRAVERSABLE_DOOR_TYPES:
            excluded.append(
                {
                    "globalId": door.GlobalId,
                    "name": model.label(door),
                    "ifcType": door.is_a(),
                    "predefinedType": predefined,
                    "warum": (
                        "PredefinedType = TRAPDOOR: eine Boden- oder Deckenluke verbindet zwar, ist aber "
                        "nicht begehbar — ein Fluchtweg führt nicht über eine Leiter."
                    ),
                }
            )
            continue

        touching = op.opens_to(model, door.GlobalId)
        if not touching.decidable or touching.value is None:
            unresolved.append(
                {
                    "globalId": door.GlobalId,
                    "name": model.label(door),
                    "ifcType": door.is_a(),
                    "warum": touching.missing.what if touching.missing else "opensTo() war nicht entscheidbar",
                    "abhilfe": touching.missing.remedy if touching.missing else None,
                }
            )
            continue
        if touching.provenance != "declared":
            derived_any = True

        via = "IfcRelSpaceBoundary" if touching.provenance == "declared" else "geom.tree.select"
        rooms = sorted({ref.global_id for ref in touching.value if ref.kind == "space" and ref.global_id in known})

        if not rooms:
            excluded.append(
                {
                    "globalId": door.GlobalId,
                    "name": model.label(door),
                    "ifcType": door.is_a(),
                    "warum": (
                        "Diese Tür berührt keinen der modellierten Räume. Sie verbindet in dieser Datei "
                        "nichts — möglicherweise fehlt der Raum dahinter im Export."
                    ),
                }
            )
            continue

        if len(rooms) == 1:
            outside, why = op._faces_outside(model, door)
            if outside is not True:
                # One room and NOT declared external: the far side is a room the
                # export did not model, not the open air. An OUTSIDE edge here
                # would hand this room an exit it does not have, and a fabricated
                # exit shortens every route behind it.
                excluded.append(
                    {
                        "globalId": door.GlobalId,
                        "name": model.label(door),
                        "ifcType": door.is_a(),
                        "warum": (
                            f"Diese Tür berührt nur einen Raum, liegt aber nicht außen ({why}). Der Bereich "
                            "auf der anderen Seite ist im Export nicht als IfcSpace modelliert. Als Ausgang "
                            "ins Freie wird sie deshalb NICHT gewertet — das wäre ein erfundener Ausweg."
                        ),
                        "abhilfe": (
                            "Den Bereich hinter dieser Tür als IfcSpace modellieren, oder an der zugehörigen "
                            "Wand Pset_WallCommon.IsExternal setzen, wenn sie tatsächlich ins Freie führt."
                        ),
                    }
                )
                continue
            edges.append(
                DoorEdge(
                    global_id=door.GlobalId,
                    name=model.label(door),
                    ifc_type=door.is_a(),
                    predefined_type=predefined,
                    a=rooms[0],
                    b=OUTSIDE,
                    length=_leg(model, rooms[0], door.GlobalId),
                    external=True,
                    via=f"{via} + {why}",
                )
            )
            continue

        ambiguous = len(rooms) > 2
        for i, first in enumerate(rooms):
            for second in rooms[i + 1 :]:
                edges.append(
                    DoorEdge(
                        global_id=door.GlobalId,
                        name=model.label(door),
                        ifc_type=door.is_a(),
                        predefined_type=predefined,
                        a=first,
                        b=second,
                        length=_traverse(model, first, door.GlobalId, second),
                        external=False,
                        via=via,
                        ambiguous=ambiguous,
                    )
                )

    # Checked AFTER the loop, because that is when the contact map has been
    # asked for. A truncated map means some doors reported fewer rooms than they
    # touch, and a graph missing edges is indistinguishable from a building
    # missing doors — so nothing is returned rather than a subset.
    #
    # NOT gated on `derived_any`, and that was a bug for one revision: when the
    # budget runs out, EVERY door comes back undecidable, so no edge is ever
    # derived and a `derived_any` gate would let the truncation through as a
    # graph with zero edges and a mild caveat — the exact "short list wearing
    # the shape of a complete one" this library exists to prevent. The flag is
    # only ever set by `space_contacts`, so it stays True when the declared
    # route answered everything and nothing geometric was attempted.
    if not model.contacts_complete:
        total = len(spaces)
        return _Build(
            graph=None,
            missing=MissingFact(
                what="IfcRelSpaceBoundary (die Ableitung aus der Geometrie ist für dieses Modell zu teuer)",
                remedy=(
                    f"Dieser Export enthält keine Raumgrenzen, und die Ableitung aus den Körpern wurde nach "
                    f"{model.contacts_covered} von {total} Räumen abgebrochen (Zeitbudget "
                    f"{int(CONTACT_BUDGET_SECONDS)} s). Ein unvollständiger Türgraph wäre von einem Gebäude "
                    "mit weniger Türen nicht zu unterscheiden — eine fehlende Kante ist ein fehlender Weg — "
                    "deshalb wird keiner ausgegeben. Abhilfe: Space Boundaries (2nd level) mitexportieren — "
                    "in Revit/ArchiCAD eine Exporteinstellung — oder dieses Modell in einem Worker ohne "
                    "Anfragezeitlimit auswerten."
                ),
            ),
            provenance="computed",
            from_=[door.GlobalId for door in doors],
            caveat=None,
        )

    graph = DoorGraph(
        nodes=tuple(nodes),
        edges=tuple(edges),
        unresolved=tuple(unresolved),
        excluded=tuple(excluded),
        build_seconds=time.perf_counter() - t0,
    )
    return _Build(
        graph=graph,
        missing=None,
        provenance="computed" if derived_any else "declared",
        from_=[],
        caveat=_graph_caveat(graph, derived_any),
    )


def _graph_caveat(graph: DoorGraph, derived_any: bool) -> str:
    caveat = _STRUCTURE_CAVEAT
    if derived_any:
        caveat += " " + op._DERIVED_BOUNDARY_CAVEAT.format(contact=op.CONTACT)
    if graph.unresolved:
        caveat += (
            f" Bei {len(graph.unresolved)} Tür(en) ließen sich die angrenzenden Räume NICHT bestimmen; sie "
            "sind keine Kante und stehen unter „unbestimmt“. Jede davon ist ein möglicher Weg, den dieser "
            "Graph nicht kennt — die Wege sind insofern höchstens so gut wie dieser Export."
        )
    if graph.excluded:
        caveat += (
            f" {len(graph.excluded)} Tür(en) wurden bewusst nicht als Kante geführt; die Begründung steht "
            "je Tür unter „ausgeschlossen“."
        )
    if any(edge.ambiguous for edge in graph.edges):
        caveat += (
            " Mindestens eine Tür berührt mehr als zwei Räume — das tut keine wirkliche Tür, die Ableitung "
            "hat an der Berührungstoleranz einen Nachbarraum mitgenommen. Die Kanten sind trotzdem gesetzt "
            "(eine echte Außentür zu verwerfen würde einen Raum ausweglos erscheinen lassen), sind aber als "
            "„ambiguous“ markiert."
        )
    joined = {edge.a for edge in graph.edges} | {edge.b for edge in graph.edges}
    isolated = [ref for ref in graph.nodes if ref.global_id != OUTSIDE and ref.global_id not in joined]
    if isolated:
        caveat += (
            f" {len(isolated)} Raum/Räume haben überhaupt keine Türkante: "
            + ", ".join(f"„{ref.name or ref.global_id}“" for ref in isolated)
            + ". Das ist ein Befund und keine Nebensache — entweder fehlen dort Türen im Export, oder der "
            "Raum ist nur über Treppe, Leiter oder eine Öffnung ohne Tür erreichbar, die dieser Graph "
            "nicht kennt."
        )
    return caveat


# ── geometry: the polyline, and nothing more ────────────────────────────────


def _centre(model: SpatialModel, global_id: str) -> np.ndarray | None:
    geo = model.geometry(global_id)
    return None if geo is None else geo.centroid


def _leg(model: SpatialModel, node: str, door_id: str) -> float | None:
    """Plan distance from a node's centre to a door's centre, metres.

    In PLAN, not in space. A person walks on the floor; the vertical difference
    between a room's mid-height centroid (1.25 m in the sample house) and a
    door's (1.04 m) is an artefact of where the two solids happen to have their
    mass, not distance anyone covers. Including it would add a few centimetres
    of noise per leg and pretend to a precision the method does not have. What
    this drops instead is real vertical travel — a stair — and the graph has no
    stair edges at all, so there is nothing here to drop it from. Both halves of
    that are in the caveat.
    """
    if node == OUTSIDE:
        return 0.0
    a = _centre(model, node)
    b = _centre(model, door_id)
    if a is None or b is None:
        return None
    return math.hypot(float(a[0] - b[0]), float(a[1] - b[1]))


def _traverse(model: SpatialModel, a: str, door_id: str, b: str) -> float | None:
    first = _leg(model, a, door_id)
    second = _leg(model, b, door_id)
    if first is None or second is None:
        return None
    return first + second


# ── search ──────────────────────────────────────────────────────────────────


#: One single-source search result: cost and hop count per node, and the edge
#: each node was reached by.
_Search = tuple[dict[str, tuple[float, int]], dict[str, tuple[str, DoorEdge]]]


def _search(graph: DoorGraph, start: str, unweighted: bool = False) -> _Search:
    """Dijkstra from one room over the whole graph, once.

    Dijkstra rather than breadth-first, because hop count and distance disagree
    the moment a building has a corridor: two doors along a 30 m hall is not a
    shorter escape route than three doors through small rooms, and a Fluchtweg
    is a length. With ``unweighted`` every edge costs 1 and this degenerates to
    breadth-first — which is the right search for "how many doors", the other
    question this module is asked.

    Ties break on hop count and then on node id, so the same file always
    produces the same route. An answer that alternates between two equally long
    paths from run to run cannot be reviewed, and being reviewable is the whole
    point of the envelope this returns into.

    The weighted search skips edges with no length (an endpoint with no usable
    body in this file). :func:`_shortest` retries unweighted when that leaves
    the goal unreachable, so a missing centroid costs the LENGTH of an answer
    and not the answer.
    """
    edges = graph.edges if unweighted else [edge for edge in graph.edges if edge.length is not None]
    adjacency: dict[str, list[tuple[str, DoorEdge]]] = {}
    for edge in edges:
        adjacency.setdefault(edge.a, []).append((edge.b, edge))
        adjacency.setdefault(edge.b, []).append((edge.a, edge))

    best: dict[str, tuple[float, int]] = {start: (0.0, 0)}
    came: dict[str, tuple[str, DoorEdge]] = {}
    queue: list[tuple[float, int, str]] = [(0.0, 0, start)]
    while queue:
        cost, hops, node = heapq.heappop(queue)
        if (cost, hops) > best.get(node, (math.inf, 0)):
            continue
        for other, edge in sorted(adjacency.get(node, []), key=lambda pair: pair[0]):
            step = 1.0 if unweighted else float(edge.length or 0.0)
            candidate = (cost + step, hops + 1)
            if candidate < best.get(other, (math.inf, 0)):
                best[other] = candidate
                came[other] = (node, edge)
                heapq.heappush(queue, (candidate[0], candidate[1], other))
    return best, came


def _route(came: dict[str, tuple[str, DoorEdge]], start: str, goal: str) -> list[DoorEdge]:
    edges: list[DoorEdge] = []
    cursor = goal
    while cursor != start:
        previous, edge = came[cursor]
        edges.append(edge)
        cursor = previous
    edges.reverse()
    return edges


def _shortest(graph: DoorGraph, start: str, goal: str) -> tuple[list[DoorEdge], float | None] | None:
    """The shortest route by length, or by door count when no length exists."""
    if start == goal:
        return [], 0.0
    best, came = _search(graph, start)
    if goal in best:
        return _route(came, start, goal), best[goal][0]
    best, came = _search(graph, start, unweighted=True)
    if goal in best:
        return _route(came, start, goal), None
    return None


# ── the two operators an agent actually calls ───────────────────────────────


def egress_path(model: SpatialModel, space_global_id: str) -> Answer[dict[str, Any]]:
    """The shortest route from this room to outside, as rooms, doors and a length.

    The route comes back as ``legs``: each leg is one door traversal, ``von →
    Tür → nach``, with its own length, and the lengths sum to the total. A
    reviewer who disagrees with the total can therefore disagree with one leg of
    it rather than with the whole number, which is the only form of disagreement
    that leads anywhere.

    ## What the number is

    A polyline through room centroids and door centres, in plan. Read
    :data:`_POLYLINE_CAVEAT` — it travels on every answer and it is not
    decoration. In one sentence: this is a LOWER BOUND on the walking distance
    and must not be used as a Fluchtweglänge, because the direction it errs in
    is the direction that hides a problem.

    ## No threshold, on purpose

    OIB Richtlinie 2 names a maximum. This operator does not know it and will
    not learn it: the maximum is a fact about the clause, and mixing it in here
    would turn a measurement into a verdict that nobody could take apart again.

    ## When there is no route

    ``undecidable``, never ``value=None`` and never an empty list. "Aus diesem
    Raum führt kein Weg ins Freie" reads as a statement about the building, and
    what is actually true is that no door in this EXPORT connects the room to
    anything that reaches outside. The remedy names what to author.
    """
    method = f"egressPath({space_global_id})"
    subject = op._require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        op._wrong_kind(
            subject,
            method,
            "egressPath",
            "einen Raum (IfcSpace)",
            "für eine Tür: opensTo() liefert die Räume, die sie verbindet",
        )

    build = _cached_build(model)
    if build.graph is None:
        return _refuse(build, method)
    graph = build.graph

    found = _shortest(graph, space_global_id, OUTSIDE)
    if found is None:
        return undecidable(
            from_=[space_global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="eine Türverbindung von diesem Raum bis ins Freie",
                remedy=(
                    "In diesem Export führt von diesem Raum aus keine Kette von Türen nach außen. Das kann "
                    "zweierlei heißen und die Datei unterscheidet es nicht: entweder fehlen Türen (IfcDoor "
                    "mit Raumbezug — im CAD prüfen, ob die Türen exportiert und den Räumen zugeordnet sind), "
                    "oder der Weg führt über eine Treppe, eine Rampe oder eine Öffnung ohne Türblatt, und "
                    "solche Verbindungen sind in einem Türgraph nicht enthalten. reachableFrom() zeigt, "
                    "welche Räume von hier aus überhaupt erreichbar sind."
                ),
                elements=[space_global_id],
            ),
        )

    route, total = found
    legs: list[dict[str, Any]] = []
    node = space_global_id
    by_id = {ref.global_id: ref for ref in graph.nodes}
    for edge in route:
        other = edge.b if edge.a == node else edge.a
        legs.append(
            {
                "von": by_id[node].to_dict(),
                "tuer": {
                    "globalId": edge.global_id,
                    "name": edge.name,
                    "ifcType": edge.ifc_type,
                    "external": edge.external,
                    "via": edge.via,
                },
                "nach": by_id[other].to_dict(),
                "length": None if edge.length is None else round(edge.length, 3),
            }
        )
        node = other

    caveat = _POLYLINE_CAVEAT + " " + _ENDPOINT_CAVEAT + " " + _CENTROID_CAVEAT + " " + (build.caveat or "")
    if total is None:
        caveat += (
            " Für diesen Weg ist KEINE Länge angegeben: mindestens ein Raum oder eine Tür auf der Strecke "
            "trägt in dieser Datei keinen auswertbaren Körper. Die Abfolge der Räume und Türen stimmt "
            "trotzdem — nur die Entfernung fehlt."
        )

    value = {
        "space": model.ref(subject).to_dict(),
        "reachesOutside": True,
        "doorCount": len(route),
        "length": None if total is None else round(total, 3),
        "legs": legs,
        "spaces": [space_global_id, *[leg["nach"]["globalId"] for leg in legs if leg["nach"]["globalId"] != OUTSIDE]],
        "doors": [edge.global_id for edge in route],
    }
    return computed(
        value,
        unit="m",
        # The stated geometric error only: two centroids per leg, each carrying
        # one coordinate tolerance. It is the SMALL error here by two orders of
        # magnitude, and quoting it beside the caveat is the point — the number
        # is precise and it is still not a Fluchtweglänge.
        tolerance=None if total is None else len(route) * op.DIMENSION_TOLERANCE,
        from_=[space_global_id, *[edge.global_id for edge in route]],
        method=method,
        caveat=caveat.strip(),
    )


def reachable_from(model: SpatialModel, space_global_id: str) -> Answer[dict[str, Any]]:
    """Every room reachable from this one through doors, with hop counts.

    "Welche Räume liegen hinter dieser Tür" — Cypher4BIM's *space accessibility*
    question — and, by the same walk, the rooms that are behind nothing: a space
    that appears in ``nichtErreichbar`` on every other space's answer is a room
    the export connected to no other room at all.

    Both numbers travel per room, because they answer different questions and
    disagree: ``hops`` is how many doors a person passes and ``length`` is how
    far they walk. A room two doors away down a long hall is further than a room
    three doors away through small rooms; a fire-safety reading wants the second
    number and an accessibility reading often wants the first.

    ``outside`` is reported here as well, so a caller can ask one question
    instead of two. It is not a verdict about escape routes; when it says
    ``reachable: false`` the caveat says what that does and does not mean.
    """
    method = f"reachableFrom({space_global_id})"
    subject = op._require(model, space_global_id, method)
    if model.kind_of(subject) != "space":
        op._wrong_kind(
            subject,
            method,
            "reachableFrom",
            "einen Raum (IfcSpace)",
            "für eine Tür: opensTo() liefert die Räume, die sie verbindet",
        )

    build = _cached_build(model)
    if build.graph is None:
        return _refuse(build, method)
    graph = build.graph

    # Two passes over the whole graph, not one per room. Both are single-source,
    # so asking "how far is every other room" costs the same as asking about one
    # of them — and the alternative (a search per reported room) is quadratic in
    # the rooms for an answer that is a single fan-out.
    by_hops, _ = _search(graph, space_global_id, unweighted=True)
    by_length, _ = _search(graph, space_global_id)
    by_id = {ref.global_id: ref for ref in graph.nodes}

    reachable: list[dict[str, Any]] = []
    for node, (count, _) in sorted(by_hops.items(), key=lambda item: (item[1][0], item[0])):
        if node in (space_global_id, OUTSIDE):
            continue
        metres = by_length.get(node)
        reachable.append(
            {
                **by_id[node].to_dict(),
                "hops": int(count),
                "length": None if metres is None else round(metres[0], 3),
            }
        )

    unreachable = [ref.to_dict() for ref in graph.nodes if ref.global_id not in by_hops and ref.global_id != OUTSIDE]

    outside_route = _shortest(graph, space_global_id, OUTSIDE)
    outside: dict[str, Any] = {"reachable": outside_route is not None}
    if outside_route is not None:
        outside["doorCount"] = len(outside_route[0])
        outside["length"] = None if outside_route[1] is None else round(outside_route[1], 3)

    caveat = _STRUCTURE_CAVEAT + " " + (build.caveat or "")
    if outside_route is None:
        caveat += (
            " Von diesem Raum aus erreicht keine Türkette das Freie. Das ist eine Aussage über den "
            "Türgraph dieses Exports, nicht über das Gebäude: Treppen, Rampen und türlose Durchgänge sind "
            "hier keine Verbindungen. egressPath() nennt für denselben Fall, was zu ergänzen wäre."
        )
    if unreachable:
        caveat += (
            f" {len(unreachable)} Raum/Räume dieses Modells sind von hier aus über keine Tür erreichbar; "
            "sie stehen unter „nichtErreichbar“. Auch das ist zuerst ein Befund über den Export."
        )
    caveat += " " + _POLYLINE_CAVEAT

    value = {
        "space": model.ref(subject).to_dict(),
        "reachable": reachable,
        "nichtErreichbar": unreachable,
        "outside": outside,
    }
    return computed(
        value,
        from_=[space_global_id, *[entry["globalId"] for entry in reachable]],
        method=method,
        caveat=caveat.strip(),
    )


def _refuse(build: _Build, method: str) -> Answer[Any]:
    """Re-wrap the memoised refusal under THIS caller's method name.

    ``method`` is the operator expression a reviewer reads back, so it has to
    say ``egressPath(3w0z…)`` and not ``doorGraph()`` merely because the graph
    is where the refusal was discovered.
    """
    return undecidable(
        from_=build.from_,
        method=method,
        provenance=build.provenance,  # type: ignore[arg-type]
        missing=build.missing,  # type: ignore[arg-type]
    )


__all__ = [
    "NON_TRAVERSABLE_DOOR_TYPES",
    "OUTSIDE",
    "OUTSIDE_REF",
    "DoorEdge",
    "DoorGraph",
    "door_graph",
    "egress_path",
    "reachable_from",
]
