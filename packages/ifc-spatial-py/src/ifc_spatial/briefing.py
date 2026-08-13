"""Model-level operators: what the agent is told before it asks anything.

A port of ``packages/ifc-spatial/src/operators/model.ts`` plus the two functions
in ``graph/build.ts`` that feed it — ``measureDialect`` and ``findBlindSpots`` —
onto IfcOpenShell. The German wording is verbatim; what changes underneath is
only where the facts come from, because there is no CSR graph here to read them
out of.

## Why a briefing exists at all

The expensive failures in model question-answering are not arithmetic failures.
They are GROUNDING failures: the agent filters on ``Pset_WallCommon`` in a file
whose exporter wrote ``AllplanAttributes``, asks for storey ``"Erdgeschoss"`` in
a file that calls it ``"EG 00"``, and gets back zero rows. Zero rows renders as
"no external walls on the ground floor" — a confident, fluent, wrong sentence
that nothing downstream can catch, because a filter that matched nothing and a
building that contains nothing produce the same empty list.

So the cure is not a warning ("check the property names first"); it is to hand
the agent the file's own vocabulary before it writes a query.
:func:`render_briefing` is that hand-over — a deterministic, rendered fact
sheet, not prose from a model, computed once per file and injected when a
conversation first touches it.

## The rule every line in here obeys

**An absent fact must never render as a zero.** ``0 Fenster mit Wandzuordnung``
is a sentence about a building. What this module actually knows, when
``IfcRelFillsElement`` was never exported, is a sentence about a FILE. The two
are told apart everywhere below: a population of zero says "the export contains
none", a resolution of zero out of many names the relation that is missing, and
neither is allowed to look like a measurement.

## What the briefing may and may not do to the model

**It never runs geometry.** §8.2 makes ``briefing()`` the free rung of the
disclosure ladder, and on this engine the geometry pass costs 1.6–2.4 s and the
space contact map another 6 s. A briefing that triggered them would make the
cheapest call the most expensive one. What it does instead is REPORT whether the
pass has already run, and say — as a blind spot, in German — that the measured
answers are unavailable until it does. That is the same discipline the TS
version applies from the other side: its briefing has no geometry because its
graph builder runs first, and the bug it had to fix was a hard-coded sentence
claiming the geometric answers were impossible on files where they were not.

## Where the facts come from now

The TS briefing reads a materialised graph: ``out(graph, 'hostedIn', id)``,
``graph.stats.edgesByKind``, ``graph.dialect``. None of that exists here, and
none of it needs to: ``FillsVoids``/``VoidsElements`` is the hostedIn coverage,
``IfcSpace.BoundedBy`` is the boundary coverage, and
``ifcopenshell.util.element.get_psets`` is the dialect. What survives unchanged
is every sentence and every cap.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from typing import Literal

import ifcopenshell.util.element as ue

from .envelope import Answer
from .envelope import MissingFact
from .envelope import declared
from .envelope import inferred
from .envelope import undecidable
from .model import SpatialModel
from .model import Storey

# ── The briefing, as data ───────────────────────────────────────────────────


@dataclass(frozen=True)
class BriefingStorey:
    global_id: str
    name: str | None
    #: Metres. ``None`` when the file declares no elevation for this storey.
    elevation: float | None
    #: Structural storey-to-storey height in metres — the NEXT storey's
    #: elevation minus this one. ``None`` for the topmost storey and wherever an
    #: elevation is missing, never a fallback value: a guessed room height is
    #: the input to a clear-height check, and a wrong one passes silently.
    height: float | None
    #: Elements that resolve to this storey by containment or aggregation.
    element_count: int
    space_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "elevation": self.elevation,
            "height": self.height,
            "elementCount": self.element_count,
            "spaceCount": self.space_count,
        }


@dataclass(frozen=True)
class BriefingCount:
    """A count, for ``byKind`` / ``byType`` tables."""

    key: str
    count: int

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "count": self.count}


@dataclass(frozen=True)
class Coverage:
    """How far a relation actually reaches, as ``n of m``.

    Both numbers travel together because either alone lies. ``n`` alone hides
    that the model has 300 windows and resolved 4 of them; ``of`` alone hides
    that the export wrote the relation at all. ``relation`` names the IFC
    construct that would supply the missing part, so a shortfall can be blamed
    on the export in the export's own vocabulary rather than reported as a
    property of the building.
    """

    id: Literal[
        "oeffnungenMitWand",
        "raeumeMitBegrenzung",
        "raeumeMitNamen",
        "geschosseMitHoehenlage",
        "bauteileMitGeschoss",
    ]
    #: German label for the population, printable as-is.
    what: str
    #: Members for which the fact resolves.
    n: int
    #: Members it could resolve for. ``0`` means the population itself is empty.
    of: int
    #: The IFC relation or attribute that supplies it.
    relation: str

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "what": self.what, "n": self.n, "of": self.of, "relation": self.relation}


@dataclass(frozen=True)
class BriefingDialectEntry:
    set: str
    property: str
    #: Elements carrying a non-null value, within the scanned set.
    filled: int
    #: Elements scanned — NOT elements that could carry the property.
    #:
    #: The distinction matters because ``filled / scanned`` looks like a fill
    #: rate and is not one: a FireRating found on 5 of 400 scanned elements is
    #: "5 elements publish it", not "1 % of walls do", and the second sentence
    #: would be wrong by however many of those 400 were windows.
    scanned: int
    #: German gloss when this property answers a question the rules ask.
    concept: str | None
    sample: list[Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "set": self.set,
            "property": self.property,
            "filled": self.filled,
            "scanned": self.scanned,
            "concept": self.concept,
            "sample": list(self.sample),
        }


@dataclass(frozen=True)
class BriefingRoomUse:
    aufenthaltsraum: int
    nebenraum: int
    erschliessung: int
    #: Spaces whose name matched no lexicon entry — including unnamed ones.
    unklassifiziert: int
    #: False when the model publishes no spaces; the counts are then meaningless.
    decidable: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "aufenthaltsraum": self.aufenthaltsraum,
            "nebenraum": self.nebenraum,
            "erschliessung": self.erschliessung,
            "unklassifiziert": self.unklassifiziert,
            "decidable": self.decidable,
        }


@dataclass(frozen=True)
class BlindSpot:
    what: str
    consequence: str
    remedy: str

    def to_dict(self) -> dict[str, Any]:
        return {"what": self.what, "consequence": self.consequence, "remedy": self.remedy}


@dataclass(frozen=True)
class Briefing:
    """The machine-readable précis.

    :func:`render_briefing` is a projection of this and adds no facts of its
    own, so anything a caller reads in the text block it can also read here
    without re-parsing German.
    """

    #: sha256 of the source bytes — the identity of everything below.
    content_hash: str
    schema: str
    source_name: str | None
    originating_system: str | None
    totals: dict[str, int]
    storeys: list[BriefingStorey]
    #: Whether storey heights could be derived at all. See :func:`storey_heights`.
    storey_heights_decidable: bool
    by_kind: list[BriefingCount]
    by_type: list[BriefingCount]
    #: IFC types not in ``by_type`` because the list is capped.
    types_omitted: int
    coverage: list[Coverage]
    room_use: BriefingRoomUse
    dialect: list[BriefingDialectEntry]
    dialect_omitted: int
    #: Elements the dialect measurement looked at.
    properties_scanned: int
    #: Decisive properties NOT found anywhere in this file.
    #:
    #: The dialect can only list what exists, so absence is invisible in it —
    #: and absence is exactly what makes a filter return nothing. Naming the gap
    #: here turns "no wall has a fire rating" into "this export publishes no
    #: fire rating", which is the true statement and the actionable one.
    absent_properties: list[dict[str, str]]
    blind_spots: list[BlindSpot]

    def to_dict(self) -> dict[str, Any]:
        return {
            "contentHash": self.content_hash,
            "schema": self.schema,
            "sourceName": self.source_name,
            "originatingSystem": self.originating_system,
            "totals": dict(self.totals),
            "storeys": [s.to_dict() for s in self.storeys],
            "storeyHeightsDecidable": self.storey_heights_decidable,
            "byKind": [c.to_dict() for c in self.by_kind],
            "byType": [c.to_dict() for c in self.by_type],
            "typesOmitted": self.types_omitted,
            "coverage": [c.to_dict() for c in self.coverage],
            "roomUse": self.room_use.to_dict(),
            "dialect": [d.to_dict() for d in self.dialect],
            "dialectOmitted": self.dialect_omitted,
            "propertiesScanned": self.properties_scanned,
            "absentProperties": [dict(entry) for entry in self.absent_properties],
            "blindSpots": [s.to_dict() for s in self.blind_spots],
        }


#: IFC types printed in the type table before it is capped.
MAX_TYPES = 15
#: Property lines printed in the DIALEKT block.
MAX_DIALECT = 10
#: Storeys printed in the GESCHOSSE block.
MAX_STOREYS = 12
#: Blind spots printed; the builder emits a handful, a cap guards the budget.
MAX_BLIND_SPOTS = 8
#: Elements whose property sets are read for the DIALEKT block. Same default as
#: the TS builder. ``get_psets`` is an entity walk rather than an index lookup,
#: so the sample matters more here than it did there.
DIALECT_SAMPLE_SIZE = 4000

#: Properties that decide a question somebody actually asks, with the German
#: word the question is asked in.
#:
#: Two jobs: promote these to the front of the DIALEKT block when present (a
#: list sorted purely by fill count is dominated by exporter boilerplate), and
#: report them in ``absent_properties`` when not. Deliberately short — every
#: entry costs tokens in every briefing for every model.
DECISIVE_PROPERTIES: tuple[tuple[str, str], ...] = (
    ("Feuerwiderstand", "FireRating"),
    ("Brennbarkeit", "Combustible"),
    ("U-Wert", "ThermalTransmittance"),
    ("Schallschutz", "AcousticRating"),
    ("tragend", "LoadBearing"),
    ("außenliegend", "IsExternal"),
    ("Raumfläche", "NetFloorArea"),
    ("Höhe", "Height"),
    ("Brüstungshöhe", "SillHeight"),
)


# ── briefing() ──────────────────────────────────────────────────────────────


def briefing(model: SpatialModel, *, dialect_sample_size: int = DIALECT_SAMPLE_SIZE) -> Briefing:
    """Compute the précis. Deterministic, and free of geometry.

    Deterministic matters more than it sounds: this text enters the model's
    context on every conversation about the file, so a briefing that varied
    between calls would make two answers about the same building differ for
    reasons nobody can reconstruct afterwards. Every list below is therefore
    sorted by a total order, and the scan walks the file in file order.
    """
    spaces = _spaces_of(model)
    windows = _by_type(model, "IfcWindow")
    doors = _by_type(model, "IfcDoor")
    nodes = _nodes_of(model)

    # Storey occupancy, counted from the RESOLVED storey rather than from the
    # containment relation: an element contained in a space is still on a
    # storey, and `SpatialModel.storey_of` walks containment and aggregation to
    # find it. Counting the relation would under-report every model whose
    # exporter nests elements inside spaces or assemblies.
    elements_per_storey: dict[str, int] = {}
    spaces_per_storey: dict[str, int] = {}
    kind_counts: dict[str, int] = {}
    for element in nodes:
        kind = model.kind_of(element)
        kind_counts[kind] = kind_counts.get(kind, 0) + 1
        if kind in ("project", "site", "building", "storey"):
            continue
        storey = model.storey_of(element)
        if storey is None:
            continue
        bucket = spaces_per_storey if kind == "space" else elements_per_storey
        if kind in ("space", "element", "opening"):
            bucket[storey.GlobalId] = bucket.get(storey.GlobalId, 0) + 1

    heights = _heights_of(model)
    storeys = [
        BriefingStorey(
            global_id=storey.global_id,
            name=storey.name,
            elevation=storey.elevation,
            height=heights.get(storey.global_id),
            element_count=elements_per_storey.get(storey.global_id, 0),
            space_count=spaces_per_storey.get(storey.global_id, 0),
        )
        for storey in _sorted_storeys(model)
    ]

    type_counts: dict[str, int] = {}
    for element in nodes:
        type_counts[element.is_a()] = type_counts.get(element.is_a(), 0) + 1
    by_type = [
        BriefingCount(key=key, count=count)
        for key, count in sorted(type_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    fillers = [*windows, *doors]
    hosted = sum(1 for e in fillers if _hosts_of(e))
    bounded = sum(1 for s in spaces if _declared_boundaries(s))
    named = sum(1 for s in spaces if model.label(s) is not None)
    with_elevation = sum(1 for s in model.storeys if s.elevation is not None)
    placeable = [e for e in nodes if model.kind_of(e) in ("element", "opening")]
    placed = sum(1 for e in placeable if model.storey_of(e) is not None)

    coverage = [
        Coverage(
            id="oeffnungenMitWand",
            what="Fenster/Türen einer Wand zugeordnet",
            n=hosted,
            of=len(fillers),
            relation="IfcRelVoidsElement + IfcRelFillsElement",
        ),
        Coverage(
            id="raeumeMitBegrenzung",
            what="Räume mit deklarierter Raumbegrenzung",
            n=bounded,
            of=len(spaces),
            relation="IfcRelSpaceBoundary",
        ),
        Coverage(
            id="raeumeMitNamen",
            what="Räume mit Namen",
            n=named,
            of=len(spaces),
            relation="IfcSpace.Name / LongName",
        ),
        Coverage(
            id="geschosseMitHoehenlage",
            what="Geschoße mit Höhenlage",
            n=with_elevation,
            of=len(model.storeys),
            relation="IfcBuildingStorey.Elevation",
        ),
        Coverage(
            id="bauteileMitGeschoss",
            what="Bauteile einem Geschoß zugeordnet",
            n=placed,
            of=len(placeable),
            relation="IfcRelContainedInSpatialStructure",
        ),
    ]

    classified = classify_rooms(model)
    room_use = BriefingRoomUse(
        aufenthaltsraum=sum(1 for r in classified if r.kind == "aufenthaltsraum"),
        nebenraum=sum(1 for r in classified if r.kind == "nebenraum"),
        erschliessung=sum(1 for r in classified if r.kind == "erschliessung"),
        unklassifiziert=sum(1 for r in classified if r.kind is None),
        decidable=len(spaces) > 0,
    )

    measured, scanned, sampled = measure_dialect(model, nodes, dialect_sample_size)
    dialect, omitted, absent = _summarise_dialect(measured)

    return Briefing(
        content_hash=content_hash(model),
        schema=str(model.file.schema),
        source_name=_header(model, "name"),
        originating_system=_header(model, "originating_system"),
        totals={
            "entities": _entity_count(model),
            "nodes": len(nodes),
            "edges": _edge_count(model),
            "buildings": len(_by_type(model, "IfcBuilding")),
            "storeys": len(model.storeys),
            "spaces": len(spaces),
            "windows": len(windows),
            "doors": len(doors),
        },
        storeys=storeys,
        storey_heights_decidable=with_elevation >= 2,
        by_kind=[
            BriefingCount(key=key, count=count)
            for key, count in sorted(kind_counts.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        by_type=by_type[:MAX_TYPES],
        types_omitted=max(0, len(by_type) - MAX_TYPES),
        coverage=coverage,
        room_use=room_use,
        dialect=dialect,
        dialect_omitted=omitted,
        properties_scanned=scanned,
        absent_properties=absent,
        blind_spots=find_blind_spots(model, dialect_sample_size if sampled else None),
    )


# ── render_briefing() ───────────────────────────────────────────────────────


def render_briefing(model: SpatialModel, *, dialect_sample_size: int = DIALECT_SAMPLE_SIZE) -> str:
    """The text block the agent gets in context. The single most important
    function in this module.

    ## Why render at all, when :func:`briefing` returns data

    Because this is read by a language model under a budget, and JSON spends a
    third of its tokens on punctuation and repeated keys. A fixed-column block
    with German labels also has a property JSON does not: it is quotable. An
    agent that copies ``Pset_WallCommon.ThermalTransmittance`` out of the
    DIALEKT block cannot mistype it, which was the failure this whole module
    exists to prevent.

    ## The budget is a correctness feature, not a cost feature

    Every list here is capped and every cap announces what it dropped
    (``+18 weitere Typen``). Silent truncation is the same bug as a subset
    reported as a total: an agent reading a list that ENDS believes it is
    complete, and then answers "the model contains no IfcRamp" from a table that
    was cut at 15 rows.
    """
    b = briefing(model, dialect_sample_size=dialect_sample_size)
    lines: list[str] = []

    def add(label: str, *body: str) -> None:
        for index, text in enumerate(body):
            lines.append(f"{label:<10}{text}" if index == 0 else f"{'':<10}{text}")

    # GEBÄUDE ─ identity first, so a briefing pasted into a transcript can still
    # be matched to the file it describes six turns later.
    identity = [
        b.source_name or "Datei ohne Namen im IFC-Header",
        b.schema,
        b.originating_system or "Herkunftssystem nicht im Header deklariert",
        f"sha {b.content_hash[:8]}",
    ]
    add(
        "GEBÄUDE",
        " · ".join(identity),
        " · ".join(
            [
                # A missing spatial container is named by its ENTITY, never
                # counted as zero: "0 Gebäude" is a sentence about a building
                # site, "kein IfcBuilding" is a sentence about this export —
                # which is the true one.
                _plural(b.totals["buildings"], "Gebäude", "Gebäude")
                if b.totals["buildings"] > 0
                else "kein IfcBuilding",
                _plural(b.totals["storeys"], "Geschoß", "Geschoße")
                if b.totals["storeys"] > 0
                else "keine IfcBuildingStorey",
                _plural(b.totals["spaces"], "Raum", "Räume") if b.totals["spaces"] > 0 else "keine IfcSpace",
                f"{b.totals['nodes']} Knoten",
                f"{b.totals['edges']} Beziehungen",
            ]
        ),
    )

    # GESCHOSSE ─ the names an agent must not invent. A model with no storey
    # structure says so; it never renders as an empty list.
    if not b.storeys:
        add("GESCHOSSE", "keine IfcBuildingStorey — dieser Export enthält keine Geschoßgliederung")
    else:
        shown = b.storeys[:MAX_STOREYS]
        cells = []
        for storey in shown:
            height = "" if storey.height is None else f" h {storey.height:.2f}"
            where = "ohne Höhenlage" if storey.elevation is None else _metres(storey.elevation)
            cells.append(f"{storey.name or storey.global_id} {where}{height} · {storey.element_count} Bauteile")
        overflow = len(b.storeys) - len(shown)
        add("GESCHOSSE", *_wrap(cells, " | ", f"(+{overflow} weitere Geschoße)" if overflow > 0 else None))
        add(
            "",
            "h = Rohbau-Geschoßhöhe OK–OK aus den Höhenlagen, kein Deckenaufbau abgezogen — nicht die lichte Raumhöhe"
            if b.storey_heights_decidable
            else "keine Geschoßhöhen: weniger als zwei Geschoße veröffentlichen eine Höhenlage",
        )

    # BAUTEILE ─ the type vocabulary. An agent filtering on
    # `IfcWallStandardCase` in an IFC4 file that only has `IfcWall` gets
    # nothing; this block is where it finds out which spelling this file uses.
    if not b.by_type:
        add("BAUTEILE", "keine Bauteile im Modell — dieser Export enthält keine IfcProduct-Instanzen")
    else:
        cells = [f"{entry.key} {entry.count}" for entry in b.by_type]
        add(
            "BAUTEILE",
            *_wrap(cells, " · ", f"(+{b.types_omitted} weitere Typen)" if b.types_omitted > 0 else None),
        )

    # RÄUME ─ every count here is `n von m` with the responsible relation named,
    # so a zero can be read as a statement about the export and not the building.
    if b.totals["spaces"] == 0:
        add(
            "RÄUME",
            "keine IfcSpace/IfcSpatialZone — Räume wurden nicht exportiert; über die Raumaufteilung des",
            "Gebäudes sagt das nichts",
        )
    else:
        add("RÄUME", f"{b.totals['spaces']} IfcSpace/IfcSpatialZone")
        for wanted in ("raeumeMitNamen", "raeumeMitBegrenzung"):
            entry = next((c for c in b.coverage if c.id == wanted), None)
            if entry:
                add("", _coverage_line(entry))
        use = b.room_use
        add(
            "",
            f"Lexikonvorschlag (unbestätigt): {use.aufenthaltsraum} Aufenthalts-, {use.nebenraum} Neben-, "
            f"{use.erschliessung} Erschließungsräume, {use.unklassifiziert} ohne Zuordnung",
        )
        add("", "Aufenthaltsraum ist eine rechtliche Einstufung — dieser Vorschlag ersetzt keine Prüfung")

    # ÖFFNUNGEN ─ window↔wall is the relation most exports drop, and its absence
    # is the difference between "no window in this wall" and "no relation in
    # this file".
    openings = next((c for c in b.coverage if c.id == "oeffnungenMitWand"), None)
    if b.totals["windows"] + b.totals["doors"] == 0:
        add("ÖFFNUNGEN", "keine IfcWindow/IfcDoor — Öffnungen wurden nicht exportiert")
    else:
        add("ÖFFNUNGEN", f"{b.totals['windows']} Fenster · {b.totals['doors']} Türen")
        if openings:
            add("", _coverage_line(openings))

    # DIALEKT ─ the reason this module exists. Absolute counts, not percentages
    # of a population nobody defined: the scan measures fill against every
    # scanned element, so "3 %" for a wall property would be arithmetic on the
    # wrong denominator, printed as a fact.
    if not b.dialect:
        add("DIALEKT", "keine Merkmale gefunden — dieser Export schreibt keine Property Sets an Bauteile")
    else:
        add("DIALEKT", f"{b.properties_scanned} Bauteile untersucht; Zahl = Bauteile mit befülltem Wert")
        for entry in b.dialect:
            gloss = f"{entry.concept} → " if entry.concept else ""
            sample = f"  [{', '.join(_shorten(v) for v in entry.sample[:2])}]" if entry.sample else ""
            add("", f"{gloss}{entry.set}.{entry.property} {entry.filled}{sample}")
        if b.dialect_omitted > 0:
            add("", f"(+{b.dialect_omitted} weitere Merkmale, nach Befüllung sortiert)")

    # FEHLT ─ what the DIALEKT block structurally cannot show. A property absent
    # from the file has no row to appear in, and a filter on it returns nothing
    # that looks exactly like a real negative answer.
    # Suppressed when the dialect is empty: the DIALEKT block has already said
    # that this export writes no property sets at all, and repeating every
    # decisive property underneath it would imply nine separate findings where
    # there is one.
    if b.absent_properties and b.dialect:
        add(
            "FEHLT",
            *_wrap([f"{e['concept']} ({e['property']})" for e in b.absent_properties], " · ", None),
        )
        add("", 'nirgends in dieser Datei befüllt — eine Abfrage darauf liefert leer, nicht „nein"')

    # BLIND ─ the honesty budget.
    spots = b.blind_spots[:MAX_BLIND_SPOTS]
    if spots:
        add("BLIND", *[f"{s.what} → {s.consequence}; Abhilfe: {s.remedy}" for s in spots])
        overflow = len(b.blind_spots) - len(spots)
        if overflow > 0:
            add("", f"(+{overflow} weitere)")

    return "\n".join(lines)


# ── storey_heights() ────────────────────────────────────────────────────────


def storey_heights(model: SpatialModel) -> Answer[list[dict[str, Any]]]:
    """Storey heights as the difference between consecutive declared elevations.

    ## Why the caveat is not optional

    This number is a *Rohbau-Geschoßhöhe*: top of slab to top of slab. The
    number an architect is usually being asked for — and the one OIB 3 §3 and
    every habitable-room check want — is the *lichte Raumhöhe*, which is this
    minus the floor build-up and the slab. The two differ by 30–50 cm, which is
    the entire margin of a 2.50 m minimum. Reporting the storey pitch as a room
    height turns a failing room into a passing one, and reads perfectly while
    doing it. So the caveat travels with the value, and a caller that drops it
    is publishing a different claim than the one this function makes.

    ## Why the top storey is ``None``

    There is no next elevation. Every fallback available — the storey below, an
    average, a default 2.80 — is a fabrication that the answer contract has no
    way to mark, since it would arrive as a number like all the others. ``None``
    survives into the render as "nicht bestimmbar", which is true.

    Storeys with no declared elevation are excluded rather than interpolated,
    and the caveat says how many, because a silently shortened list is a subset
    reported as a total.

    ## Why this is ``declared`` and not ``computed``

    It returned ``computed``, and the renderer prints that as „aus der Geometrie
    berechnet, nicht deklariert" — directly contradicting this function's own
    caveat two lines below it („gebildet aus den deklarierten Höhenlagen"), in
    the same answer. Nothing here touches geometry: ``elevation`` is
    ``IfcBuildingStorey.Elevation`` read verbatim, and ``height`` is one declared
    number minus the next. The reviewer verified it — ``model.geometry_seconds``
    stays 0.000 across the call.

    A subtraction of two numbers the file states does not change where they came
    from. If the elevations are wrong, this answer is wrong, and that is exactly
    what ``declared`` means: „wrong only if the export is wrong". Calling it
    ``computed`` claims a measurement error band this value does not have and
    hides the one error source it does have — the architect's own elevations. The
    subtraction is named in the caveat, where a reviewer can check it.
    """
    method = "storeyHeights(model)"
    ordered = _sorted_storeys(model)
    with_elevation = [s for s in ordered if s.elevation is not None]
    missing_elevation = len(ordered) - len(with_elevation)

    if len(with_elevation) < 2:
        return undecidable(
            from_=[s.global_id for s in ordered],
            # `provenance` on an undecidable records which ROUTE was attempted,
            # and the route here is the declared elevation — no geometry is read
            # on the way to this refusal either.
            provenance="declared",
            method=method,
            missing=MissingFact(
                what="IfcBuildingStorey.Elevation",
                remedy=(
                    "Das Modell enthält keine IfcBuildingStorey. Geschoße im CAD anlegen und mitexportieren."
                    if not ordered
                    else (
                        "Mindestens zwei Geschoße müssen eine Höhenlage (Elevation) deklarieren. "
                        "Im CAD die Geschoßhöhen setzen und neu exportieren."
                    )
                ),
                elements=[s.global_id for s in ordered],
            ),
        )

    value: list[dict[str, Any]] = []
    for index, storey in enumerate(with_elevation):
        nxt = with_elevation[index + 1] if index + 1 < len(with_elevation) else None
        value.append(
            {
                "storey": storey.name or storey.global_id,
                "elevation": storey.elevation,
                # Rounded to the millimetre: the difference of two
                # floating-point elevations produces 2.8499999999999996, and a
                # height printed with sixteen digits reads as a precision this
                # value does not have.
                "height": None if nxt is None else round((nxt.elevation - storey.elevation) * 1000) / 1000,  # type: ignore[operator]
            }
        )

    caveat = [
        "Rohbau-Geschoßhöhe von Geschoßoberkante zu Geschoßoberkante, gebildet aus den deklarierten "
        "Höhenlagen. Kein Deckenaufbau und keine Deckenstärke abgezogen — das ist NICHT die lichte "
        "Raumhöhe und nicht für einen Raumhöhennachweis verwendbar.",
        f"Das oberste Geschoß ({value[-1]['storey'] if value else '—'}) hat keine nächste Höhenlage; "
        "seine Höhe bleibt offen statt geschätzt.",
    ]
    if missing_elevation > 0:
        caveat.append(
            f"{missing_elevation} Geschoß(e) ohne deklarierte Höhenlage sind nicht enthalten — die Liste ist "
            "kein vollständiges Geschoßverzeichnis."
        )
    # A non-positive pitch is not a building; it is two storeys sharing an
    # elevation or an inverted export. Worth surfacing, because every downstream
    # height check would otherwise consume it as a measurement.
    suspicious = sum(1 for entry in value if entry["height"] is not None and entry["height"] <= 0)
    if suspicious > 0:
        caveat.append(
            f"{suspicious} Geschoßübergang(e) ergeben eine Höhe ≤ 0 — zwei Geschoße mit gleicher oder "
            "fallender Höhenlage. Das ist ein Befund über den Export, nicht über das Gebäude."
        )

    return declared(
        value,
        unit="m",
        from_=[s.global_id for s in with_elevation],
        method=method,
        caveat=" ".join(caveat),
    )


# ── inventory() ─────────────────────────────────────────────────────────────

RoomUseKind = Literal["aufenthaltsraum", "nebenraum", "erschliessung"]


@dataclass(frozen=True)
class RoomProposal:
    global_id: str
    name: str | None
    confidence: float
    because: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "confidence": self.confidence,
            "because": list(self.because),
        }


def inventory(model: SpatialModel, kind: RoomUseKind) -> Answer[list[RoomProposal]]:
    """Propose which rooms are Aufenthaltsräume, Nebenräume or
    Erschließungsflächen, from what they are CALLED.

    ## This is a proposal for a human, never a verdict

    **Aufenthaltsraum is a legal classification, not a geometric one.** OIB and
    the Länder-Bauordnungen define it by intended use — a room meant for more
    than transient occupancy — and that intent lives in the architect's head and
    the Einreichplan, not in the IFC file. Nothing measurable settles it: a 14 m²
    room with a window is a Kinderzimmer or a Lagerraum depending on what the
    plan says it is. This is the one operator no geometry kernel can take over,
    which is why ``COVERAGE.md`` lists it as *not available* from IfcOpenShell
    and why it stays hand-written and stays ``inferred``.

    What this function has is the name the architect typed. That is real
    evidence — people call bedrooms "Schlafen" — and it is *only* evidence. So
    every result is ``inferred``, carries a per-room confidence and the reasons
    behind it, and is phrased as a proposal a human confirms. An agent that
    reports "7 Aufenthaltsräume" as a finding has misused this function.

    ## Why the lexicon is German and umlaut-tolerant

    The room names in an Austrian or German model are German, and exporters
    mangle umlauts in three different ways depending on the file's encoding and
    the CAD's locale: ``Küche``, ``Kueche``, ``KÜCHE``, and NFD-decomposed
    ``Küche`` are all the same room. Matching on the raw string would classify
    the same building differently depending on which machine exported it.

    ## Why the longest match wins

    ``Waschküche`` contains ``küche``. Ranking matches by the length of the
    matched term puts a laundry in ``nebenraum`` where it belongs, instead of
    proposing it as a habitable room because it has a kitchen in its name.
    """
    method = f"inventory(model, '{kind}')"
    spaces = _spaces_of(model)

    if not spaces:
        return undecidable(
            from_=[],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="IfcSpace",
                remedy=(
                    "Dieser Export enthält keine Räume. Räume im CAD als IfcSpace exportieren — ohne sie ist "
                    "keine Raumnutzung ableitbar, weder aus Namen noch aus Geometrie."
                ),
            ),
        )

    classified = classify_rooms(model)
    matching = [room for room in classified if room.kind == kind]
    unnamed = sum(1 for room in classified if room.name is None)
    unclassified = sum(1 for room in classified if room.kind is None)

    value = [
        RoomProposal(global_id=room.global_id, name=room.name, confidence=room.confidence, because=list(room.because))
        for room in matching
    ]

    because = [
        f"Einstufung aus dem Raumnamen gegen ein deutsch/österreichisch-englisches Lexikon ({len(LEXICON)} Einträge), "
        "Groß-/Kleinschreibung und Umlautvarianten (Küche/Kueche/KÜCHE) vereinheitlicht.",
        "Bei mehreren Treffern gewinnt der längere Begriff (Waschküche vor Küche).",
        f"{len(matching)} von {len(spaces)} Räumen als {GERMAN_KIND[kind]} vorgeschlagen.",
    ]
    lit_source = _window_assignment(model)
    if lit_source is not None:
        because.append("Fensterzuordnung (opensTo) als Zusatzsignal, wo der Export sie hergibt.")
    else:
        because.append(
            "Keine Fensterzuordnung im Modell — die Einstufung stützt sich allein auf den Namen, nicht auf Belichtung."
        )

    caveat = [
        "Aufenthaltsraum ist eine RECHTLICHE Einstufung nach der Nutzung, keine geometrische Eigenschaft. "
        "Diese Liste ist ein Vorschlag aus Raumnamen und muss von einem Menschen bestätigt werden — sie "
        "ist kein Nachweis und keine Feststellung.",
    ]
    if unnamed > 0:
        caveat.append(f"{unnamed} Raum/Räume tragen keinen Namen und konnten gar nicht eingestuft werden.")
    if unclassified > unnamed:
        caveat.append(
            f"{unclassified - unnamed} weitere Raumnamen passen zu keinem Lexikoneintrag — ein Befund über die "
            "Raumbenennung im Export, nicht über die Nutzung."
        )
    if not value:
        caveat.append(
            f"Kein Raumname in diesem Modell deutet auf {GERMAN_KIND[kind]} hin. Das heißt nicht, dass das "
            "Gebäude keine hat — es heißt, dass die Benennung im Export nichts dazu sagt."
        )

    # The envelope's single confidence is the mean of the per-room values, so a
    # list built from three weak substring matches cannot present itself with
    # the same authority as a list of exact hits. Per-room numbers stay in
    # `value`; this one is what a renderer puts in front of the sentence.
    mean = 0.0 if not value else round(sum(r.confidence for r in value) / len(value) * 100) / 100

    return inferred(
        value,
        from_=[room.global_id for room in value],
        method=method,
        confidence=mean,
        because=because,
        caveat=" ".join(caveat),
    )


# ── the lexicon ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class LexiconEntry:
    #: Normalised search term — lower case, umlauts transliterated.
    term: str
    kind: RoomUseKind
    #: A term that is suggestive but not decisive on its own (``halle``,
    #: ``gang``). Caps confidence, because a "Halle" is a foyer in one plan and a
    #: workshop in the next.
    weak: bool = False
    #: A qualification that belongs in this room's ``because`` when it matches.
    note: str | None = None


GERMAN_KIND: dict[str, str] = {
    "aufenthaltsraum": "Aufenthaltsraum",
    "nebenraum": "Nebenraum",
    "erschliessung": "Erschließungsfläche",
}

_FREIBEREICH = "Freibereich — kein Aufenthaltsraum, aber auch kein Nebenraum im engeren Sinn"

#: The room-name lexicon, in normalised form (no umlauts, lower case).
#:
#: Ordering is irrelevant — matching ranks by term length, not by position —
#: which means an entry can be added without reasoning about what it shadows.
LEXICON: tuple[LexiconEntry, ...] = (
    # Aufenthaltsräume: rooms for more than transient occupancy.
    LexiconEntry("wohnzimmer", "aufenthaltsraum"),
    LexiconEntry("wohnraum", "aufenthaltsraum"),
    LexiconEntry("wohnkueche", "aufenthaltsraum"),
    LexiconEntry("wohnessbereich", "aufenthaltsraum"),
    LexiconEntry("wohnen", "aufenthaltsraum"),
    LexiconEntry("esszimmer", "aufenthaltsraum"),
    LexiconEntry("essplatz", "aufenthaltsraum"),
    LexiconEntry("essen", "aufenthaltsraum"),
    LexiconEntry("speisesaal", "aufenthaltsraum"),
    LexiconEntry("schlafzimmer", "aufenthaltsraum"),
    LexiconEntry("schlafraum", "aufenthaltsraum"),
    LexiconEntry("schlafen", "aufenthaltsraum"),
    LexiconEntry("kinderzimmer", "aufenthaltsraum"),
    LexiconEntry("jugendzimmer", "aufenthaltsraum"),
    LexiconEntry("gaestezimmer", "aufenthaltsraum"),
    LexiconEntry("zimmer", "aufenthaltsraum", weak=True, note='„Zimmer" allein sagt die Nutzung nicht'),
    LexiconEntry(
        "kueche",
        "aufenthaltsraum",
        note=(
            "Küchen zählen nur als Aufenthaltsraum, wenn sie zum nicht nur vorübergehenden Aufenthalt "
            "bestimmt sind — eine Kochnische nicht"
        ),
    ),
    LexiconEntry("kochen", "aufenthaltsraum"),
    LexiconEntry("arbeitszimmer", "aufenthaltsraum"),
    LexiconEntry("arbeitsraum", "aufenthaltsraum"),
    LexiconEntry("arbeiten", "aufenthaltsraum"),
    LexiconEntry("bueroraum", "aufenthaltsraum"),
    LexiconEntry("buero", "aufenthaltsraum"),
    LexiconEntry("aufenthaltsraum", "aufenthaltsraum"),
    LexiconEntry("aufenthalt", "aufenthaltsraum"),
    LexiconEntry("wintergarten", "aufenthaltsraum"),
    LexiconEntry("gastraum", "aufenthaltsraum"),
    LexiconEntry("besprechungsraum", "aufenthaltsraum"),
    LexiconEntry("besprechung", "aufenthaltsraum"),
    LexiconEntry("konferenzraum", "aufenthaltsraum"),
    LexiconEntry("seminarraum", "aufenthaltsraum"),
    LexiconEntry("klassenzimmer", "aufenthaltsraum"),
    LexiconEntry("gruppenraum", "aufenthaltsraum"),
    LexiconEntry("spielzimmer", "aufenthaltsraum"),
    LexiconEntry("spielraum", "aufenthaltsraum"),
    LexiconEntry("atelier", "aufenthaltsraum"),
    LexiconEntry("ordination", "aufenthaltsraum"),
    LexiconEntry("verkaufsraum", "aufenthaltsraum"),
    LexiconEntry("bibliothek", "aufenthaltsraum"),
    # Nebenräume: served rooms, not meant for lasting occupancy.
    LexiconEntry("badezimmer", "nebenraum"),
    LexiconEntry("baderaum", "nebenraum"),
    LexiconEntry("bad", "nebenraum"),
    LexiconEntry("dusche", "nebenraum"),
    LexiconEntry("duschbad", "nebenraum"),
    LexiconEntry("wc", "nebenraum"),
    LexiconEntry("toilette", "nebenraum"),
    LexiconEntry("sanitaer", "nebenraum"),
    LexiconEntry("abstellraum", "nebenraum"),
    LexiconEntry("abstell", "nebenraum"),
    LexiconEntry("abstellnische", "nebenraum"),
    LexiconEntry("vorratsraum", "nebenraum"),
    LexiconEntry("vorrat", "nebenraum"),
    LexiconEntry("speisekammer", "nebenraum"),
    LexiconEntry("speis", "nebenraum"),
    LexiconEntry("hauswirtschaftsraum", "nebenraum"),
    LexiconEntry("hausanschlussraum", "nebenraum"),
    LexiconEntry("hwr", "nebenraum"),
    LexiconEntry("technikraum", "nebenraum"),
    LexiconEntry("haustechnik", "nebenraum"),
    LexiconEntry("technik", "nebenraum"),
    LexiconEntry("heizraum", "nebenraum"),
    LexiconEntry("heizung", "nebenraum"),
    LexiconEntry("lueftungszentrale", "nebenraum"),
    LexiconEntry("elektroraum", "nebenraum"),
    LexiconEntry("serverraum", "nebenraum"),
    LexiconEntry("lagerraum", "nebenraum"),
    LexiconEntry("lager", "nebenraum"),
    LexiconEntry("kellerabteil", "nebenraum"),
    LexiconEntry("keller", "nebenraum"),
    LexiconEntry("waschkueche", "nebenraum"),
    LexiconEntry("waschraum", "nebenraum"),
    LexiconEntry("trockenraum", "nebenraum"),
    LexiconEntry("putzraum", "nebenraum"),
    LexiconEntry("muellraum", "nebenraum"),
    LexiconEntry("abfall", "nebenraum"),
    LexiconEntry("garage", "nebenraum"),
    LexiconEntry("carport", "nebenraum"),
    LexiconEntry("fahrradraum", "nebenraum"),
    LexiconEntry("kinderwagenraum", "nebenraum"),
    LexiconEntry("kinderwagen", "nebenraum"),
    LexiconEntry("schrankraum", "nebenraum"),
    LexiconEntry("ankleide", "nebenraum"),
    LexiconEntry("garderobe", "nebenraum"),
    LexiconEntry("sauna", "nebenraum"),
    LexiconEntry("dachboden", "nebenraum"),
    LexiconEntry("aufzugsschacht", "nebenraum"),
    LexiconEntry("schacht", "nebenraum", weak=True),
    # Freibereiche are neither: they cannot be Aufenthaltsräume, and calling
    # them Nebenräume is a stretch. They are placed here rather than left
    # unmatched so that a terrace never lands in the habitable-room proposal,
    # and the `note` carries the qualification into the reasons.
    LexiconEntry("balkon", "nebenraum", note=_FREIBEREICH),
    LexiconEntry("terrasse", "nebenraum", note=_FREIBEREICH),
    LexiconEntry("loggia", "nebenraum", note=_FREIBEREICH),
    LexiconEntry("dachterrasse", "nebenraum", note=_FREIBEREICH),
    # Erschließung: circulation.
    LexiconEntry("flur", "erschliessung"),
    LexiconEntry("gang", "erschliessung"),
    LexiconEntry("diele", "erschliessung"),
    LexiconEntry("vorraum", "erschliessung"),
    LexiconEntry("vorzimmer", "erschliessung"),
    LexiconEntry("stiegenhaus", "erschliessung"),
    LexiconEntry("stiege", "erschliessung"),
    LexiconEntry("treppenhaus", "erschliessung"),
    LexiconEntry("treppenraum", "erschliessung"),
    LexiconEntry("treppe", "erschliessung"),
    LexiconEntry("korridor", "erschliessung"),
    LexiconEntry("erschliessung", "erschliessung"),
    LexiconEntry("windfang", "erschliessung"),
    LexiconEntry("eingangsbereich", "erschliessung"),
    LexiconEntry("eingang", "erschliessung"),
    LexiconEntry("foyer", "erschliessung"),
    LexiconEntry("halle", "erschliessung", weak=True, note='„Halle" kann Eingangshalle oder Nutzungshalle sein'),
    LexiconEntry("liftvorraum", "erschliessung"),
    LexiconEntry("aufzug", "erschliessung"),
    LexiconEntry("lift", "erschliessung"),
    LexiconEntry("laubengang", "erschliessung"),
    LexiconEntry("rampe", "erschliessung"),
    LexiconEntry("fluchtweg", "erschliessung"),
    LexiconEntry("schleuse", "erschliessung"),
    LexiconEntry("podest", "erschliessung"),
    # ── English, because the export language is not the building's country ───
    #
    # The file this library was first measured against is an Austrian sample
    # house exported from Revit with its rooms named "Living room", "Bedroom",
    # "Entrance hall" — and a German-only lexicon classified none of the four.
    # That failure is the common case, not the exotic one: the authoring tool's
    # UI language decides these strings, and an office running an English Revit
    # produces English room names for a building in Vienna. A lexicon that only
    # reads German silently reports "0 Aufenthaltsräume" about a house full of
    # them, which is worse than saying nothing.
    LexiconEntry("living room", "aufenthaltsraum"),
    LexiconEntry("livingroom", "aufenthaltsraum"),
    LexiconEntry("sitting room", "aufenthaltsraum"),
    LexiconEntry("family room", "aufenthaltsraum"),
    LexiconEntry("dining room", "aufenthaltsraum"),
    LexiconEntry("dining", "aufenthaltsraum"),
    LexiconEntry("lounge", "aufenthaltsraum"),
    LexiconEntry("kitchen", "aufenthaltsraum"),
    LexiconEntry("master bedroom", "aufenthaltsraum"),
    LexiconEntry("bedroom", "aufenthaltsraum"),
    LexiconEntry("bed room", "aufenthaltsraum"),
    LexiconEntry("guest room", "aufenthaltsraum"),
    LexiconEntry("nursery", "aufenthaltsraum"),
    LexiconEntry("children", "aufenthaltsraum"),
    LexiconEntry("study", "aufenthaltsraum"),
    LexiconEntry("home office", "aufenthaltsraum"),
    LexiconEntry("office", "aufenthaltsraum"),
    LexiconEntry("workroom", "aufenthaltsraum"),
    LexiconEntry("classroom", "aufenthaltsraum"),
    LexiconEntry("meeting room", "aufenthaltsraum"),
    LexiconEntry(
        "living", "aufenthaltsraum", weak=True, note='„living" allein kann auch Wohnbereich einer Erschließung sein'
    ),
    LexiconEntry("room", "aufenthaltsraum", weak=True, note='„room" allein sagt die Nutzung nicht'),
    LexiconEntry("bathroom", "nebenraum"),
    LexiconEntry("shower room", "nebenraum"),
    LexiconEntry("bath", "nebenraum"),
    LexiconEntry("toilet", "nebenraum"),
    LexiconEntry("restroom", "nebenraum"),
    LexiconEntry("store room", "nebenraum"),
    LexiconEntry("storeroom", "nebenraum"),
    LexiconEntry("storage", "nebenraum"),
    LexiconEntry("utility room", "nebenraum"),
    LexiconEntry("utility", "nebenraum"),
    LexiconEntry("laundry", "nebenraum"),
    LexiconEntry("plant room", "nebenraum"),
    LexiconEntry("technical room", "nebenraum"),
    LexiconEntry("boiler room", "nebenraum"),
    LexiconEntry("basement", "nebenraum"),
    LexiconEntry("cellar", "nebenraum"),
    LexiconEntry("pantry", "nebenraum"),
    LexiconEntry("larder", "nebenraum"),
    LexiconEntry("wardrobe", "nebenraum"),
    LexiconEntry("closet", "nebenraum"),
    LexiconEntry("cloakroom", "nebenraum"),
    LexiconEntry("attic", "nebenraum"),
    LexiconEntry("bin store", "nebenraum"),
    LexiconEntry("bike store", "nebenraum"),
    LexiconEntry("balcony", "nebenraum", note=_FREIBEREICH),
    LexiconEntry("terrace", "nebenraum", note=_FREIBEREICH),
    LexiconEntry("entrance hall", "erschliessung"),
    LexiconEntry("entrance", "erschliessung"),
    LexiconEntry("hallway", "erschliessung"),
    LexiconEntry("corridor", "erschliessung"),
    LexiconEntry("passage", "erschliessung"),
    LexiconEntry("lobby", "erschliessung"),
    LexiconEntry("foyer", "erschliessung"),
    LexiconEntry("staircase", "erschliessung"),
    LexiconEntry("stairwell", "erschliessung"),
    LexiconEntry("stairs", "erschliessung"),
    LexiconEntry("stair", "erschliessung"),
    LexiconEntry("landing", "erschliessung"),
    LexiconEntry("vestibule", "erschliessung"),
    LexiconEntry("porch", "erschliessung"),
    LexiconEntry("elevator", "erschliessung"),
    LexiconEntry("circulation", "erschliessung"),
    LexiconEntry("hall", "erschliessung", weak=True, note='„hall" kann Eingangshalle oder Nutzungshalle sein'),
)

#: Confidence by how the term was found. Exact beats word beats substring.
MATCH_CONFIDENCE = {"exakt": 0.9, "wort": 0.8, "teil": 0.65}

#: Terms shorter than this are only matched on a word boundary.
#:
#: ``wc`` and ``bad`` as substrings hit room codes and foreign words
#: (``BAD-03`` is fine, ``Badminton`` is not, and a Revit room named ``WCB2`` is
#: a code). A short term inside a longer word carries almost no signal, and the
#: false positives are exactly the confident-wrong kind.
MIN_SUBSTRING_TERM = 4

QUALITY_TEXT = {"exakt": "exakter Name", "wort": "als ganzes Wort", "teil": "als Wortbestandteil"}


@dataclass(frozen=True)
class ClassifiedRoom:
    global_id: str
    name: str | None
    kind: str | None
    confidence: float
    because: list[str]


def classify_rooms(model: SpatialModel) -> list[ClassifiedRoom]:
    """Run the lexicon over every space once.

    Shared by :func:`inventory` and :func:`briefing` so the counts in the text
    block and the lists a caller requests cannot disagree — two independent
    classifiers over one model is a contradiction waiting to be quoted.
    """
    lit_rooms = _window_assignment(model)
    out: list[ClassifiedRoom] = []

    for space in _spaces_of(model):
        global_id = space.GlobalId
        name = model.label(space)
        if name is None:
            out.append(
                ClassifiedRoom(
                    global_id=global_id,
                    name=None,
                    kind=None,
                    confidence=0.0,
                    because=[
                        "Der Raum trägt weder Name noch LongName — nichts, worauf sich eine Einstufung stützen könnte."
                    ],
                )
            )
            continue

        normalised = normalise(name)
        best: dict[str, tuple[LexiconEntry, str]] = {}
        for entry in LEXICON:
            quality = match_quality(normalised, entry.term)
            if quality is None:
                continue
            current = best.get(entry.kind)
            # Longest term wins within a kind too, so the `note` that travels
            # into the reasons is the one from the most specific match.
            if current is None or len(entry.term) > len(current[0].term):
                best[entry.kind] = (entry, quality)

        if not best:
            out.append(
                ClassifiedRoom(
                    global_id=global_id,
                    name=name,
                    kind=None,
                    confidence=0.0,
                    because=[f'Der Name „{name}" passt zu keinem Lexikoneintrag.'],
                )
            )
            continue

        ranked = sorted(best.items(), key=lambda item: (-len(item[1][0].term), -MATCH_CONFIDENCE[item[1][1]]))
        kind, (winner, quality) = ranked[0]
        runner_up = ranked[1] if len(ranked) > 1 else None

        because = [f'Name „{name}" enthält „{winner.term}" ({QUALITY_TEXT[quality]}) → {GERMAN_KIND[kind]}.']
        confidence = MATCH_CONFIDENCE[quality]

        if winner.weak:
            confidence = min(confidence, 0.55)
            because.append(winner.note or f'„{winner.term}" ist ein schwaches Signal.')
        elif winner.note:
            because.append(winner.note)

        if runner_up is not None:
            other_kind, (other, _) = runner_up
            if len(other.term) == len(winner.term):
                confidence *= 0.85
                because.append(f'Mehrdeutig: „{other.term}" spricht gleich stark für {GERMAN_KIND[other_kind]}.')
            else:
                because.append(
                    f'„{winner.term}" schlägt „{other.term}" ({GERMAN_KIND[other_kind]}) als längerer Treffer.'
                )

        # The window signal is only evidence in a file that publishes the
        # relation at all. In a model with no window→room assignment, "this room
        # has no window" is a fact about the export — using it to lower a
        # confidence would let an export setting argue about a building.
        if lit_rooms is not None:
            if global_id in lit_rooms:
                confidence += 0.05
                because.append("Dem Raum ist mindestens ein Fenster zugeordnet (opensTo).")
            elif kind == "aufenthaltsraum":
                confidence -= 0.05
                because.append("Diesem Raum ist kein Fenster zugeordnet, obwohl das Modell Fensterzuordnungen führt.")

        out.append(
            ClassifiedRoom(
                global_id=global_id,
                name=name,
                kind=kind,
                confidence=round(min(0.95, max(0.3, confidence)) * 100) / 100,
                because=because,
            )
        )

    return out


def match_quality(normalised: str, term: str) -> str | None:
    if normalised == term:
        return "exakt"
    if re.search(rf"(^| ){re.escape(term)}( |$)", normalised):
        return "wort"
    if len(term) >= MIN_SUBSTRING_TERM and term in normalised:
        return "teil"
    return None


def normalise(raw: str) -> str:
    """Fold a room name into the lexicon's alphabet.

    NFC first: an exporter may write ``ü`` as ``u`` + combining diaeresis, in
    which case the umlaut rules below would not see a ``ü`` at all and ``Küche``
    would fold to ``kuche`` while a differently-encoded sibling folded to
    ``kueche``. Same building, two classifications, depending on the exporter's
    Unicode habits.

    The umlaut expansion runs BEFORE the generic diacritic strip, so ``ü``
    becomes ``ue`` (matching a file that already spells it ``Kueche``) rather
    than ``u``.
    """
    text = unicodedata.normalize("NFC", raw).lower()
    for umlaut, expansion in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(umlaut, expansion)
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


# ── the dialect, measured on this file ──────────────────────────────────────


@dataclass(frozen=True)
class DialectEntry:
    set: str
    property: str
    filled: int
    candidates: int
    sample: list[Any]


def measure_dialect(
    model: SpatialModel, nodes: Sequence[Any] | None = None, sample_size: int = DIALECT_SAMPLE_SIZE
) -> tuple[list[DialectEntry], int, bool]:
    """What this file calls things, measured on the elements themselves.

    Filter on a property name this exporter never wrote and the result is zero
    rows, which reads as "the building has none" — the single most common way a
    model question gets a confidently wrong answer. The cure is to publish the
    vocabulary rather than warn the reader to guess carefully.

    ``ifcopenshell.util.element.get_psets`` replaces the TS parser's property
    index, and it does one thing that index could not: it inherits from the
    element TYPE. That is the right behaviour for this measurement, because a
    filter written against the file will see the inherited value too — reporting
    a property as absent because it lives on ``IfcWindowType`` would send an
    architect to re-export something that is already there.

    Returns ``(entries, scanned, sampled)``. ``sampled`` is what turns into the
    blind spot: a fill count taken from the first 4 000 elements of a 60 000
    element model is a proportion of the sample and must not be read as one of
    the model.
    """
    candidates = [
        e for e in (nodes if nodes is not None else _nodes_of(model)) if model.kind_of(e) in ("element", "space")
    ]
    sampled = len(candidates) > sample_size
    scan = candidates[:sample_size] if sampled else candidates

    acc: dict[tuple[str, str], dict[str, Any]] = {}
    for element in scan:
        try:
            psets = ue.get_psets(element) or {}
        except Exception:
            continue
        for set_name, values in psets.items():
            if not isinstance(values, dict):
                continue
            for property_name, value in values.items():
                # `get_psets` injects the pset's own express id under `id`. It
                # is bookkeeping, not vocabulary, and printing it in the DIALEKT
                # block would offer the agent a property it cannot filter on.
                if property_name == "id":
                    continue
                if value is None or value == "":
                    continue
                key = (set_name, property_name)
                entry = acc.get(key)
                if entry is None:
                    entry = {"filled": 0, "sample": []}
                    acc[key] = entry
                entry["filled"] += 1
                if len(entry["sample"]) < 6 and isinstance(value, (str, int, float, bool)):
                    if value not in entry["sample"]:
                        entry["sample"].append(value)

    entries = [
        DialectEntry(
            set=set_name,
            property=property_name,
            filled=data["filled"],
            candidates=len(scan),
            sample=list(data["sample"]),
        )
        for (set_name, property_name), data in acc.items()
    ]
    entries.sort(key=lambda e: (-e.filled, e.set, e.property))
    return entries, len(scan), sampled


def _summarise_dialect(
    entries: Sequence[DialectEntry],
) -> tuple[list[BriefingDialectEntry], int, list[dict[str, str]]]:
    """Reshape the raw dialect for the briefing.

    Two changes. First, decisive properties are promoted: sorting purely by fill
    count puts ``Pset_*Common.Reference`` at the top of every Revit model and
    buries the one property a fire-rating question needs. Second, the list is
    capped and the remainder counted, because a dialect can run to hundreds of
    entries and an uncapped one would eat the whole context budget.
    """
    concept_of = {property_name.lower(): concept for concept, property_name in DECISIVE_PROPERTIES}

    seen: set[str] = set()
    shaped: list[BriefingDialectEntry] = []
    for entry in entries:
        key = entry.property.lower()
        seen.add(key)
        shaped.append(
            BriefingDialectEntry(
                set=entry.set,
                property=entry.property,
                filled=entry.filled,
                scanned=entry.candidates,
                concept=concept_of.get(key),
                sample=list(entry.sample),
            )
        )

    # Stable: decisive first, then by fill count, then alphabetically. Two runs
    # over the same file must produce the same briefing.
    ranked = sorted(shaped, key=lambda e: (0 if e.concept is not None else 1, -e.filled, f"{e.set}.{e.property}"))
    absent = [
        {"concept": concept, "property": property_name}
        for concept, property_name in DECISIVE_PROPERTIES
        if property_name.lower() not in seen
    ]
    return ranked[:MAX_DIALECT], max(0, len(ranked) - MAX_DIALECT), absent


# ── blind spots ─────────────────────────────────────────────────────────────


def find_blind_spots(model: SpatialModel, dialect_sample: int | None = None) -> list[BlindSpot]:
    """What this file cannot answer, worked out before anybody asks.

    The point is to move the discovery of a gap from the end of a long agent
    turn to the beginning of it. An agent told up front that this export wrote
    no space boundaries does not spend six tool calls finding out, and does not
    report "the building has no rooms" when the truth is "this export omitted a
    relation".

    Every test below is a read of the file, not of a graph: ``by_type`` for the
    relation entities, ``TrueNorth`` and ``IfcMapConversion`` for the two
    orientation facts, and the model's own record of whether the geometry pass
    has run.
    """
    spots: list[BlindSpot] = []
    spaces = len(_spaces_of(model))
    fillers = len(_by_type(model, "IfcWindow")) + len(_by_type(model, "IfcDoor"))
    boundaries = len(_by_type(model, "IfcRelSpaceBoundary"))
    fills = len(_by_type(model, "IfcRelFillsElement"))

    if spaces == 0:
        spots.append(
            BlindSpot(
                what="keine IfcSpace-Elemente",
                consequence="Raumflächen, Raumtiefen und alles je Aufenthaltsraum sind nicht ableitbar",
                remedy="Räume im CAD als IfcSpace exportieren",
            )
        )
    if boundaries == 0 and spaces > 0:
        spots.append(
            BlindSpot(
                what="keine IfcRelSpaceBoundary",
                consequence=(
                    "welche Wände einen Raum begrenzen und welche Räume aneinandergrenzen ist nicht deklariert"
                ),
                remedy=("Space Boundaries (2nd level) mitexportieren — in Revit/ArchiCAD eine Exporteinstellung"),
            )
        )
    if fills == 0 and fillers > 0:
        spots.append(
            BlindSpot(
                what="keine IfcRelFillsElement",
                consequence=f"{fillers} Fenster/Türen lassen sich keiner Wand zuordnen",
                remedy="Öffnungen und Füllungen mitexportieren",
            )
        )
    elif fillers > 0:
        # The relation exists — but existing and RESOLVING are different facts,
        # and only the second one answers "which wall is this window in". A file
        # with fills for the doors and none for the windows passes the test
        # above and still cannot answer the question for a window.
        unresolved = sum(1 for e in [*_by_type(model, "IfcWindow"), *_by_type(model, "IfcDoor")] if not _hosts_of(e))
        if unresolved > 0:
            spots.append(
                BlindSpot(
                    what=f"{unresolved} von {fillers} Fenstern/Türen ohne auflösbare Wandzuordnung",
                    consequence=(
                        "für diese Öffnungen ist hostedIn() nicht beantwortbar — die Datei schreibt "
                        "IfcRelFillsElement, aber nicht für sie"
                    ),
                    remedy="Öffnungen und Füllungen für ALLE Fenster/Türen mitexportieren",
                )
            )
    if model.true_north is None:
        spots.append(
            BlindSpot(
                what="keine Nordrichtung",
                consequence="Fassadenorientierung (Süd/Nord) ist nicht bestimmbar",
                remedy="TrueNorth im IfcGeometricRepresentationContext setzen",
            )
        )
    if not _georeferenced(model):
        spots.append(
            BlindSpot(
                what="keine Georeferenzierung",
                consequence=(
                    "Sonnenstand und Besonnung sind nicht berechenbar (der geometrische 45°-Nachweis bleibt möglich)"
                ),
                remedy="IfcMapConversion bzw. RefLatitude/RefLongitude setzen",
            )
        )
    spots.extend(_geometry_blind_spots(model))
    if dialect_sample is not None:
        spots.append(
            BlindSpot(
                what=f"Dialekt aus einer Stichprobe von {dialect_sample} Bauteilen",
                consequence="Befüllungsgrade sind Anteile der Stichprobe, nicht des Modells",
                remedy="dialect_sample_size erhöhen",
            )
        )
    return spots


def _products_with_representation(model: SpatialModel) -> int:
    """How many products carry a shape — an attribute read, never the kernel.

    Deliberately counts ``Representation`` rather than asking
    :meth:`SpatialModel.geometry`, because the point of this check is to keep the
    briefing free of geometry work: shaping a model to find out whether it has
    shapes is the cost the blind spot exists to save the caller. A product whose
    ``Representation`` the kernel later rejects is a different finding, and
    :func:`ifc_spatial.operators._no_geometry` reports that one per element.
    """
    try:
        products = model.file.by_type("IfcProduct")
    except RuntimeError:
        return 0
    return sum(1 for product in products if getattr(product, "Representation", None))


def _geometry_blind_spots(model: SpatialModel) -> list[BlindSpot]:
    """The geometry-related blind spots, which depend on whether geometry ran.

    ## The bug this shape exists to kill

    The TS ``findBlindSpots`` used to append, unconditionally,

        keine Geometrie in dieser Ausbaustufe → Abstände, lichte Maße,
        Auskragungen, Flächen aus Geometrie und der freie Lichteinfall sind noch
        nicht berechenbar

    because the list was assembled in ``buildGraph``, which by construction runs
    before the geometry pass. Every model the library opened therefore carried a
    sentence telling the reader that the geometric answers were impossible —
    printed under ``BLIND``, in front of an agent whose whole job is to decide
    what it can and cannot answer. A false "undecidable" is the exact failure
    this library was built to end, and the library was emitting one about
    itself on every file.

    So this asks the model. ``SpatialModel`` is lazy: the pass runs on the first
    model-wide question and not before, and ``geometry_seconds`` is the record
    of whether it has. When it has not, the blind spot says exactly that and
    names the remedy as a call rather than as a re-export — because nothing is
    missing from the file.

    ## And the mirror-image bug, which it then had

    „sie sind aber berechenbar, dieser Export trägt Geometrie" was emitted
    unconditionally, on files that contain no body at all. Four of the five
    fixtures — ``haus-mit-raeumen.ifc``, ``einheiten-fuss.ifc``,
    ``geschossdecke-und-fenster.ifc`` and ``strasse-ifc4x3.ifc`` — carry a
    ``Representation`` on **0** of their ``IfcProduct`` entities, and every one
    of them was told the geometric answers were only a call away. A false
    capability claim in the block whose whole job is to say what the file cannot
    answer is the same failure as the false „undecidable", pointing the other
    way: it costs the agent a geometry pass and a turn, and it propagates into
    the IDS summary.

    The honest test is one attribute read per product and no kernel work: does
    any ``IfcProduct`` carry a ``Representation`` at all.
    """
    if model.geometry_seconds <= 0:
        with_body = _products_with_representation(model)
        if with_body == 0:
            return [
                BlindSpot(
                    what="keine Körpergeometrie in dieser Datei (kein IfcProduct trägt eine Representation)",
                    consequence=(
                        "Abstände, lichte Maße, Auskragungen, Flächen aus Geometrie und der freie "
                        "Lichteinfall sind aus dieser Datei NICHT berechenbar — auch nicht nach einem "
                        "Geometrie-Pass. Der Export enthält nur Topologie und Eigenschaften"
                    ),
                    remedy=(
                        "Das Modell mit Körpergeometrie neu exportieren (Body-Repräsentation, kein reiner "
                        "Struktur- bzw. Eigenschaftsexport)"
                    ),
                )
            ]
        return [
            BlindSpot(
                what="Geometrie-Pass noch nicht gelaufen (nur Topologie gelesen)",
                consequence=(
                    "Abstände, lichte Maße, Auskragungen, Flächen aus Geometrie und der freie Lichteinfall "
                    f"sind noch nicht berechnet — sie sind aber berechenbar, {with_body} Bauteil(e) in "
                    "diesem Export tragen Geometrie"
                ),
                remedy=(
                    "measure/distance aufrufen — der Geometrie-Pass läuft dann automatisch "
                    "(einmalig ~2 s für ein Einfamilienhaus)"
                ),
            )
        ]

    spots: list[BlindSpot] = []
    spaces = _spaces_of(model)
    without_solid = [s for s in spaces if model.geometry(s.GlobalId) is None]
    if spaces and without_solid:
        spots.append(
            BlindSpot(
                what=f"{len(without_solid)} von {len(spaces)} Räumen ohne Volumenkörper",
                consequence=(
                    "für diese Räume sind Grundfläche, lichte Höhe und die aus Geometrie abgeleiteten "
                    "Raumbegrenzungen nicht bestimmbar — die Räume existieren, ihre Geometrie wurde nicht "
                    "exportiert oder nicht ausgewertet"
                ),
                remedy="Räume mit Körpergeometrie (Body-Representation) exportieren",
            )
        )
    return spots


# ── shared helpers ──────────────────────────────────────────────────────────


def _by_type(model: SpatialModel, ifc_type: str) -> list[Any]:
    """Instances of a type, or an empty list when the SCHEMA has no such type.

    ``IfcSpatialZone`` and ``IfcMapConversion`` are IFC4 entities and raise on
    an IFC2X3 file rather than returning nothing. The distinction is real — "the
    schema cannot express this" is not "the file omitted it" — but for every
    count in this module the two produce the same number, and letting a
    RuntimeError escape would make the briefing refuse to render at all for an
    entire schema generation.
    """
    try:
        return list(model.file.by_type(ifc_type))
    except RuntimeError:
        return []


def _spaces_of(model: SpatialModel) -> list[Any]:
    """Spaces AND spatial zones — :func:`find_blind_spots` counts both, so this
    must too."""
    return [*_by_type(model, "IfcSpace"), *_by_type(model, "IfcSpatialZone")]


def _georeferenced(model: SpatialModel) -> bool:
    """``SpatialModel.georeferenced``, survivable on IFC2X3.

    The model's own property reaches for ``IfcMapConversion``, which the 2X3
    schema does not define. That module is the spike's frozen parity spec and
    may not be edited, so the guard lives here: a schema with no map conversion
    is a file with no map conversion, which is what the blind spot says.
    """
    try:
        return bool(model.georeferenced)
    except RuntimeError:
        return False


def _nodes_of(model: SpatialModel) -> list[Any]:
    """Everything the TS graph would have made a node of.

    ``IfcProduct`` covers every physical and spatial element; ``IfcProject`` and
    ``IfcGroup`` are the two node kinds that are not products. Types
    (``IfcWindowType``), property definitions and relationships are deliberately
    not nodes: they are not things an agent asks a spatial question about, and
    counting them would inflate every total in the briefing.
    """
    return [*_by_type(model, "IfcProject"), *_by_type(model, "IfcProduct"), *_by_type(model, "IfcGroup")]


def _sorted_storeys(model: SpatialModel) -> list[Storey]:
    """Lowest first, storeys without an elevation last.

    The order is load-bearing: :func:`storey_heights` takes the difference of
    consecutive entries, and a file that lists its storeys top-down would
    otherwise produce negative heights that read like a finding about the
    building.
    """
    return sorted(model.storeys, key=lambda s: (s.elevation is None, s.elevation if s.elevation is not None else 0.0))


def _heights_of(model: SpatialModel) -> dict[str, float]:
    """Storey → derived height, shared by :func:`briefing` and
    :func:`storey_heights` so the two cannot disagree."""
    answer = storey_heights(model)
    out: dict[str, float] = {}
    if not answer.decidable or answer.value is None:
        return out
    # `Answer.from_` carries the storeys in the order the values were derived,
    # so the two lists line up by index without re-deriving which storey is
    # which.
    for index, entry in enumerate(answer.value):
        if index < len(answer.from_) and entry["height"] is not None:
            out[answer.from_[index]] = entry["height"]
    return out


def _hosts_of(element: Any) -> list[Any]:
    """The building elements a window or door resolves to, through the two
    declared relations ``FillsVoids`` → ``VoidsElements``."""
    return [
        rel.RelatingBuildingElement
        for fills in (getattr(element, "FillsVoids", None) or [])
        for rel in (getattr(fills.RelatingOpeningElement, "VoidsElements", None) or [])
        if rel.RelatingBuildingElement is not None
    ]


def _declared_boundaries(space: Any) -> list[Any]:
    return [
        rel.RelatedBuildingElement
        for rel in (getattr(space, "BoundedBy", None) or [])
        if rel.RelatedBuildingElement is not None
    ]


def _window_assignment(model: SpatialModel) -> set[str] | None:
    """Rooms with at least one window assigned, or ``None`` when this model
    cannot say.

    Three states, and the third is why this returns an ``Optional`` rather than
    a possibly-empty set:

      - the file declares ``IfcRelSpaceBoundary`` — read it;
      - it does not, but the geometric contact map has already been built by an
        earlier ``opens_to`` / ``bounds`` call — read that, at dictionary speed;
      - neither — return ``None``, and the classifier leaves the window signal
        out entirely.

    The third state is the one the TS version does not have, because its
    ``openModel`` derives boundaries eagerly during the geometry pass. Here the
    contact map costs 6 s for four rooms, and running it from a room-name
    lexicon would make the cheapest operator in the package the most expensive
    one. What must not happen is the silent version of that: treating "not
    computed" as "no window", which would push every Aufenthaltsraum's
    confidence down by 0.05 for a reason that has nothing to do with the file.

    Reads ``SpatialModel``'s contact cache directly because that module is the
    spike's frozen parity spec and may not be edited to expose an accessor.
    """
    lit: set[str] = set()
    boundaries = _by_type(model, "IfcRelSpaceBoundary")
    if boundaries:
        for rel in boundaries:
            element = rel.RelatedBuildingElement
            space = rel.RelatingSpace
            if element is not None and space is not None and element.is_a("IfcWindow"):
                lit.add(space.GlobalId)
        return lit

    contacts: dict[str, set[str]] = {}
    for cached in getattr(model, "_space_contacts", {}).values():
        for space_id, touching in cached.items():
            contacts.setdefault(space_id, set()).update(touching)
    if not contacts:
        return None
    for space_id, touching in contacts.items():
        for global_id in touching:
            try:
                element = model.file.by_guid(global_id)
            except (RuntimeError, KeyError):
                continue
            if element.is_a("IfcWindow"):
                lit.add(space_id)
    return lit


def _header(model: SpatialModel, field_name: str) -> str | None:
    """One STEP header field, with the empty string folded to ``None``.

    Exporters write ``''`` for a field they have nothing to say about, and an
    empty string rendered into the identity line looks like a name nobody can
    read rather than like an absent fact.
    """
    try:
        value = getattr(model.file.header.file_name, field_name, None)
    except Exception:
        return None
    if isinstance(value, (list, tuple)):
        value = ", ".join(str(v) for v in value if v)
    if not value or not str(value).strip():
        return None
    return str(value).strip()


def _entity_count(model: SpatialModel) -> int:
    try:
        return len(list(model.file))
    except Exception:
        return 0


def _edge_count(model: SpatialModel) -> int:
    """Declared relationship links, counted as the operators would traverse them.

    Not a graph edge count — there is no graph. This counts the individual
    LINKS the relation entities carry (an ``IfcRelContainedInSpatialStructure``
    with 18 related elements is 18), because that is the number the TS briefing
    printed and because a count of relation ENTITIES would understate the
    connectivity by an order of magnitude on any real file.
    """
    total = 0
    for ifc_type, attribute in (
        ("IfcRelContainedInSpatialStructure", "RelatedElements"),
        ("IfcRelAggregates", "RelatedObjects"),
        ("IfcRelVoidsElement", None),
        ("IfcRelFillsElement", None),
        ("IfcRelSpaceBoundary", None),
        ("IfcRelConnectsPathElements", None),
        ("IfcRelConnectsElements", None),
    ):
        try:
            instances = model.file.by_type(ifc_type)
        except RuntimeError:
            continue
        if attribute is None:
            total += len(instances)
            continue
        for rel in instances:
            total += len(getattr(rel, attribute, None) or ())
    return total


_HASHES: dict[tuple[str, int, int], str] = {}


def content_hash(model: SpatialModel) -> str:
    """sha256 of the file's bytes — the identity of everything in the briefing.

    Memoised on ``(path, size, mtime_ns)`` rather than on the path alone: a file
    that was edited in place must produce a different hash, and a hash that
    survives an edit is exactly the failure the content-addressing exists to
    prevent. See :mod:`ifc_spatial.cache` for the same rule applied to the model
    cache itself.
    """
    path = Path(model.path)
    try:
        stat = path.stat()
    except OSError:
        return hashlib.sha256(str(model.path).encode()).hexdigest()
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    cached = _HASHES.get(key)
    if cached is not None:
        return cached
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    _HASHES[key] = digest.hexdigest()
    return _HASHES[key]


def _coverage_line(coverage: Coverage) -> str:
    """Render one ``n of m`` fact.

    The three branches are the whole point. An empty population, an unresolved
    population and a partly resolved one are three different findings, and only
    the third is about the building.
    """
    if coverage.of == 0:
        return f"{coverage.what}: dieser Export enthält keine solchen Elemente"
    if coverage.n == 0:
        return (
            f"{coverage.what}: 0 von {coverage.of} — dieser Export schreibt kein {coverage.relation} "
            "(Aussage über den Export, nicht über das Gebäude)"
        )
    percent = round(coverage.n / coverage.of * 100)
    rest = f", {coverage.of - coverage.n} ohne" if coverage.n < coverage.of else ""
    return f"{coverage.what}: {coverage.n} von {coverage.of} ({percent} %{rest}, {coverage.relation})"


def _metres(value: float) -> str:
    """``+2.85`` / ``±0.00`` / ``−2.60``, matching the layout in §8.1.

    ``±0.00`` rather than ``+0.00`` because a storey at datum is the reference
    every other elevation is read against, and the plan convention says so.
    """
    if abs(value) < 0.005:
        return "±0.00"
    return f"{'+' if value > 0 else '−'}{abs(value):.2f}"


def _plural(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def _shorten(value: Any) -> str:
    text = str(value)
    return f"{text[:17]}…" if len(text) > 18 else text


#: Pack cells into lines of at most this many characters after the label column.
WRAP_WIDTH = 104


def _wrap(cells: Sequence[str], separator: str, tail: str | None) -> list[str]:
    lines: list[str] = []
    current = ""
    for cell in cells:
        candidate = cell if not current else f"{current}{separator}{cell}"
        if len(candidate) > WRAP_WIDTH and current:
            lines.append(current)
            current = cell
        else:
            current = candidate
    if current:
        lines.append(current)
    if tail:
        lines.append(tail)
    return lines


__all__ = [
    "BlindSpot",
    "Briefing",
    "BriefingCount",
    "BriefingDialectEntry",
    "BriefingRoomUse",
    "BriefingStorey",
    "ClassifiedRoom",
    "Coverage",
    "DialectEntry",
    "LEXICON",
    "LexiconEntry",
    "RoomProposal",
    "RoomUseKind",
    "briefing",
    "classify_rooms",
    "content_hash",
    "find_blind_spots",
    "inventory",
    "measure_dialect",
    "normalise",
    "render_briefing",
    "storey_heights",
]
