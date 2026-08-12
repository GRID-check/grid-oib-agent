"""The tool surface, defined without a transport.

A port of ``packages/ifc-spatial/src/mcp/tools.ts``.

## Why this file has no MCP import

MCP is how these tools are *delivered*, not what they *are*. Keeping the
definitions transport-free means the same handlers serve an MCP server, an HTTP
route inside a host application, or a direct in-process call from a test, and
none of those three has to reimplement the argument checking. It also keeps the
SDK out of the dependency path of anyone who wants the library and not the
server — which on Python matters more than it did on Node, because ``pip
install mcp`` pulls pydantic, starlette, uvicorn and httpx behind it.

## Why one `relations` tool rather than eleven

Every topological operator has the same signature — a model, an element, a list
back — so eleven tools would be eleven copies of one schema, and a model
choosing between them is choosing a name, not a shape. What must NOT be coarse
is the meaning, so the enum documents each relation individually and the answer
says which one ran.

The operators whose *shape* differs — a briefing, a table of storey heights, a
room inventory, a drawing — get their own tools, because folding them into the
same enum would produce a return type that is a union of four things and a model
that guesses which one it got.

## The one rule that is not the TS file's

**Nothing here may run geometry behind the caller's back.** On the TS engine the
geometry pass happens once inside ``openModel`` and everything afterwards is a
lookup. On IfcOpenShell the pass costs 1.6–2.4 s for a house and the space
contact map another 6 s, and both are lazy. So ``open_model``, ``briefing``,
``find_elements`` and ``element`` stay purely topological, and the tools that do
pay — ``measure``, ``distance``, ``draw``, and the four relations that need the
contact map — say so in their own description. An agent that is told a call
costs five seconds can decide it is worth it; one that finds out afterwards
cannot.
"""

from __future__ import annotations

import base64
import binascii
import dataclasses
import math
import os
import tempfile
import time
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import operators as op
from . import relations as extra
from .briefing import briefing as build_briefing
from .briefing import content_hash
from .briefing import inventory
from .briefing import render_briefing
from .briefing import storey_heights
from .cache import SpatialCache
from .envelope import Answer
from .model import SpatialModel
from .model import UnknownElementError


@dataclass(frozen=True)
class ToolDef:
    """JSON-Schema-shaped input description. Deliberately plain dicts."""

    name: str
    title: str
    description: str
    input_schema: dict[str, Any]
    handler: Callable[[dict[str, Any]], Any]


class ToolError(Exception):
    """A mistake the model can correct, phrased for the model.

    Distinct from every ``decidable: false`` answer: this means the call could
    not be made at all — no such model handle, no such GlobalId, no source. A
    "the file cannot say" is a successful result and must never arrive here.
    """


#: The relation names ``relations`` accepts, and what each one answers.
RELATIONS: dict[str, str] = {
    "hostedIn": "Welche Wand trägt dieses Fenster / diese Tür? (aus voids+fills abgeleitet)",
    "hosts": "Welche Öffnungen sind aus diesem Bauteil ausgeschnitten?",
    "fillerOf": "Was füllt diese Öffnung?",
    "bounds": "Welche Bauteile begrenzen diesen Raum?",
    "enclosedBy": "Welche Räume begrenzt dieses Bauteil?",
    "opensTo": "In welche Räume öffnet dieses Fenster / diese Tür?",
    "connects": "Welche Bauteile schließen an dieses an?",
    "contains": "Welche Bauteile liegen in diesem Geschoß oder Raum?",
    "containerOf": "In welchem Geschoß oder Raum liegt dieses Bauteil?",
    "adjacentSpaces": "Welche Räume grenzen an diesen Raum?",
    "elementsOfStorey": "Alle Bauteile dieses Geschoßes (auch die in Räumen).",
}

RELATION_FN: dict[str, Callable[[SpatialModel, str], Answer[Any]]] = {
    "hostedIn": op.hosted_in,
    "hosts": op.hosts,
    "fillerOf": op.filler_of,
    "bounds": op.bounds,
    "enclosedBy": op.enclosed_by,
    "opensTo": op.opens_to,
    "connects": extra.connects,
    "contains": op.contains,
    "containerOf": op.container_of,
    "adjacentSpaces": op.adjacent_spaces,
    "elementsOfStorey": extra.elements_of_storey,
}

#: The relations that fall back to the geometric contact map when the export
#: declares no ``IfcRelSpaceBoundary`` — which is the common case.
#:
#: Named as a set rather than left implicit because two things depend on it: the
#: warning in the ``relations`` description, and ``element``'s refusal to probe
#: them just to list what is available. A six-second contact map is a reasonable
#: price for an answer somebody asked for and an unreasonable one for a menu.
GEOMETRIC_RELATIONS = frozenset({"bounds", "enclosedBy", "opensTo", "adjacentSpaces"})

#: The measurements ``measure`` exposes, and what each one answers.
MEASURES: dict[str, str] = {
    "extent": "Abmessungen und Schwerpunkt: Breite, Tiefe, Höhe, Mittelpunkt.",
    "floorArea": (
        "Bodenfläche aus der Geometrie — auch wenn das Modell keine Raumfläche deklariert. Deklariert das "
        "Modell eine, werden beide Wege gegeneinander geprüft und ein Widerspruch gemeldet."
    ),
    "sillAndHead": "Brüstungs- und Sturzhöhe eines Fensters oder einer Tür über SEINEM Geschoß.",
    "elevation": "Unter- und Oberkante, absolut und über dem eigenen Geschoß.",
    # NOT the TS wording. The TS operator returns the height of the space solid
    # and its own caveat says the real clear height needs an intersection test
    # it does not have; this engine has that test and measures the lichte Höhe
    # under the lowest obstruction. On the sample house the two differ by 30 cm
    # — under a suspended ceiling — and the TS number is the unsafe side of an
    # OIB minimum room height. Keeping the old sentence would describe an
    # operator that no longer exists.
    "clearHeight": (
        "Lichte Raumhöhe: vom Boden senkrecht nach oben bis zum untersten hineinragenden Bauteil "
        "(abgehängte Decke, Unterzug, Leitung). NICHT die Höhe des Raumkörpers — die liefert extent(). "
        "Möblierung ist ausgenommen. Rasterabtastung, ~0,5 s."
    ),
    "azimuth": "Himmelsrichtung der Fassadenebene. Ohne TrueNorth in der Datei nicht entscheidbar.",
    "lightEntryArea": (
        "Lichteintrittsfläche eines RAUMS und ihr Anteil an der Bodenfläche — die Zahl, auf die ein "
        "Tageslichtnachweis nach OIB 3 hinausläuft. Summiert nur die AUSSENLIEGENDEN Öffnungen "
        "(Innentüren belichten nicht) und misst die Rohbaulichte, nicht die Glasfläche. Kein Grenzwert "
        "angewandt — der Prozentsatz steht im Regelwerk, nicht im Modell."
    ),
}

MEASURE_FN: dict[str, Callable[[SpatialModel, str], Answer[Any]]] = {
    "extent": op.extent,
    "floorArea": op.floor_area,
    "sillAndHead": op.sill_and_head,
    "elevation": op.elevation,
    "clearHeight": op.clear_height,
    "azimuth": op.azimuth,
    "lightEntryArea": op.light_entry_area,
}

KINDS = ["project", "site", "building", "storey", "space", "element", "opening", "group"]

#: Downloads are capped. A tool that will read whatever a URL hands it is a way
#: to fill a disk from a chat message.
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024


def create_tools(cache: SpatialCache | None = None) -> list[ToolDef]:
    """The tool list, closed over one cache and one handle table."""
    cache = cache or SpatialCache()

    # Models are addressed by the sha256 of their bytes, abbreviated the way a
    # git object is. A handle that IS the content means two uploads of the same
    # file are one model without anybody comparing filenames, and it means a
    # stale handle cannot silently resolve to a different building.
    #
    # Held here as well as in the cache because the cache EVICTS: a handle the
    # agent was given three turns ago must still resolve, and re-reading the
    # file to honour it is exactly what the content address is for. The cache
    # bounds what a fresh open costs; this table bounds nothing and is the
    # process's real retention — a host that serves many models from one process
    # should recycle the process, which is the only isolation this server has.
    models: dict[str, SpatialModel] = {}

    def register(model: SpatialModel) -> str:
        digest = content_hash(model)
        models[digest] = model
        return digest

    def resolve(raw: Any) -> SpatialModel:
        key = str(raw or "").strip().lower()
        if not key:
            raise ToolError("model fehlt — zuerst open_model aufrufen")
        exact = models.get(key)
        if exact is not None:
            return exact
        if len(key) >= 8:
            matches = [h for h in models if h.startswith(key)]
            if len(matches) == 1:
                return models[matches[0]]
            if len(matches) > 1:
                raise ToolError(f'model "{key}" ist mehrdeutig ({len(matches)} Treffer) — mehr Stellen angeben')
        offen = ", ".join(_short(h) for h in models) or "keines"
        raise ToolError(f'model "{key}" ist nicht geöffnet — open_model aufrufen. Offen: {offen}')

    def run(fn: Callable[[], Any]) -> Any:
        """An operator that raises :class:`UnknownElementError` means the caller
        could not look, which is a different thing from having looked and found
        nothing — so it becomes a tool error, while every "the file cannot say"
        stays a successful result carrying ``decidable: false``. Collapsing the
        two would let a typo in a GlobalId read as a finding about the building.
        """
        try:
            return fn()
        except UnknownElementError as error:
            raise ToolError(f"{error} — GlobalId mit find_elements prüfen") from None

    # ── open_model ──────────────────────────────────────────────────────────

    def open_model(args: dict[str, Any]) -> Any:
        source = str(args.get("path") or "").strip()
        started = time.perf_counter()
        try:
            if source:
                if not os.path.isfile(source):
                    raise ToolError(f'Datei nicht gefunden: "{source}"')
                model = cache.load(source)
            else:
                data = _read_source(args)
                model = cache.load_bytes(data)
        except ToolError:
            raise
        except Exception as error:  # noqa: BLE001
            # `SpatialModel` refuses unreadable files with a German reason an
            # architect can act on — truncated upload, wrong format, too large
            # for a request process. That sentence is the answer; burying it
            # under a traceback would leave the agent with "es hat nicht
            # funktioniert", which nobody can do anything with.
            raise ToolError(f"Modell konnte nicht geöffnet werden: {error}") from None
        digest = register(model)
        return {
            "model": _short(digest),
            "contentHash": digest,
            "briefing": render_briefing(model),
            "seconds": round(time.perf_counter() - started, 3),
            # The geometry pass is LAZY on this engine, and saying so here is
            # the difference between an agent that plans two cheap calls and one
            # that is surprised by five seconds in the middle of an answer.
            "geometry": {
                "pass": "gelaufen" if model.geometry_seconds > 0 else "noch nicht gelaufen",
                "note": (
                    "Der Geometrie-Pass läuft beim ersten Maß automatisch (~2 s für ein Einfamilienhaus). "
                    "Topologische Fragen brauchen ihn nicht."
                ),
            },
        }

    # ── find_elements ───────────────────────────────────────────────────────

    def find_elements(args: dict[str, Any]) -> Any:
        model = resolve(args.get("model"))
        limit = _clamp(args.get("limit", 50), 1, 500)
        wanted_type = _lower(args.get("ifcType"))
        wanted_name = _lower(args.get("nameContains"))
        wanted_storey = _lower(args.get("storey"))
        wanted_kind = _lower(args.get("kind"))

        matches: list[Any] = []
        total = 0
        for element in _nodes(model):
            if wanted_type and element.is_a().lower() != wanted_type:
                continue
            if wanted_kind and model.kind_of(element) != wanted_kind:
                continue
            if wanted_storey:
                storey = model.storey_of(element)
                if (getattr(storey, "Name", None) or "").lower() != wanted_storey:
                    continue
            if wanted_name:
                haystack = f"{getattr(element, 'Name', '') or ''} {getattr(element, 'LongName', '') or ''}".lower()
                if wanted_name not in haystack:
                    continue
            total += 1
            if len(matches) < limit:
                matches.append(element)

        out: dict[str, Any] = {
            "elements": [model.ref(e).to_dict() for e in matches],
            "total": total,
            # Stated rather than implied: a page presented as a total is the
            # failure this whole library is built to avoid.
            "truncated": total > len(matches),
        }
        if total == 0:
            out["hint"] = (
                'Keine Treffer. Vor der Schlussfolgerung „gibt es nicht" das Briefing prüfen: '
                "Geschoßnamen und Typen stammen aus diesem Export."
            )
        return out

    # ── element ─────────────────────────────────────────────────────────────

    def element(args: dict[str, Any]) -> Any:
        model = resolve(args.get("model"))
        global_id = str(args.get("globalId") or "")
        try:
            subject = model.file.by_guid(global_id)
        except (RuntimeError, KeyError):
            raise ToolError(
                f"Bauteil {global_id} ist in diesem Modell nicht enthalten — GlobalId mit find_elements prüfen"
            ) from None

        storey = model.storey_of(subject)
        container = run(lambda: op.container_of(model, global_id))
        # Only the relations that are attribute reads are probed. The four in
        # GEOMETRIC_RELATIONS fall back to a contact map that costs seconds, and
        # building a menu is not worth that; they are listed separately as
        # "askable" instead of as "available", which is the honest distinction.
        available = []
        for name, fn in RELATION_FN.items():
            if name in GEOMETRIC_RELATIONS:
                continue
            answer = run(lambda fn=fn: fn(model, global_id))
            if not answer.decidable:
                continue
            value = answer.value
            present = len(value) > 0 if isinstance(value, list) else value is not None
            if present:
                available.append(name)

        return {
            "element": model.ref(subject).to_dict(),
            "storey": getattr(storey, "Name", None),
            "elevation": next(
                (s.elevation for s in model.storeys if storey is not None and s.global_id == storey.GlobalId),
                None,
            ),
            "predefinedType": getattr(subject, "PredefinedType", None),
            "container": _jsonable(container.value),
            "available": available,
            "hinweis": (
                "bounds, enclosedBy, opensTo und adjacentSpaces stehen nicht in dieser Liste: sie sind in "
                "einem Export ohne IfcRelSpaceBoundary nur aus der Geometrie ableitbar und kosten einmalig "
                "einige Sekunden. Über relations sind sie normal abrufbar."
            ),
        }

    # ── relations / measure / distance ──────────────────────────────────────

    def relations(args: dict[str, Any]) -> Any:
        model = resolve(args.get("model"))
        name = str(args.get("relation") or "")
        fn = RELATION_FN.get(name)
        if fn is None:
            raise ToolError(f'relation "{name}" gibt es nicht. Erlaubt: {", ".join(RELATIONS)}')
        return run(lambda: fn(model, str(args.get("globalId") or "")))

    def measure(args: dict[str, Any]) -> Any:
        model = resolve(args.get("model"))
        name = str(args.get("measure") or "")
        fn = MEASURE_FN.get(name)
        if fn is None:
            raise ToolError(f'measure "{name}" gibt es nicht. Erlaubt: {", ".join(MEASURES)}')
        return run(lambda: fn(model, str(args.get("globalId") or "")))

    def distance(args: dict[str, Any]) -> Any:
        model = resolve(args.get("model"))
        mode = str(args.get("mode") or "min")
        return run(lambda: op.distance(model, str(args.get("a") or ""), str(args.get("b") or ""), mode))

    # ── draw ────────────────────────────────────────────────────────────────

    def draw(args: dict[str, Any]) -> Any:
        import ifcopenshell.draw as drawing

        model = resolve(args.get("model"))
        settings = drawing.draw_settings(
            # A landscape sheet, because a floor plan of a building that is
            # wider than it is deep — which is most of them — otherwise arrives
            # scaled down to fit a portrait page it never needed.
            width=float(args.get("widthMm") or 420.0),
            height=float(args.get("heightMm") or 297.0),
            # No hidden-line projection. It is what makes `draw` slow and it
            # produces an elevation-like overlay that reads as clutter in a
            # plan; the cells and the poché are the drawing.
            include_projection=False,
            space_names=True,
        )
        if args.get("storey"):
            settings.storey_filter = str(args["storey"])
        if args.get("include"):
            settings.include_entities = ",".join(str(v) for v in args["include"])

        started = time.perf_counter()
        data = drawing.main(settings, [model.file])
        seconds = time.perf_counter() - started

        # The SVG goes to a file rather than into the reply. A whole-building
        # plan is a few hundred kilobytes of path data — putting that in an
        # agent's context would evict the conversation to deliver something the
        # agent cannot read anyway. The host shows the file; the agent gets the
        # facts about the drawing.
        directory = tempfile.mkdtemp(prefix="ifc-spatial-")
        path = os.path.join(directory, f"plan-{_short(content_hash(model))}.svg")
        with open(path, "wb") as handle:
            handle.write(data)

        return {
            "path": path,
            "bytes": len(data),
            "seconds": round(seconds, 2),
            "note": (
                "Die Zeichnung liegt als Datei vor und kann dem Nutzer gezeigt werden. "
                "Maße nicht aus dem Bild ablesen — dafür measure/distance verwenden."
            ),
        }

    # ── definitions ─────────────────────────────────────────────────────────

    return [
        ToolDef(
            name="open_model",
            title="IFC-Modell öffnen",
            description=(
                "Liest eine IFC-Datei ein und gibt eine model-Kennung plus das Gebäude-Briefing zurück. "
                "IMMER zuerst aufrufen. Das Briefing nennt die Geschoßnamen, das Property-Vokabular dieser "
                "Datei und — wichtig — was diese Datei NICHT beantworten kann. Dieselbe Datei zweimal zu "
                "öffnen ist gratis: das Ergebnis ist über den Inhalt adressiert und wird zwischengespeichert."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Lokaler Dateipfad zur .ifc-Datei"},
                    "url": {"type": "string", "description": "HTTP(S)-URL, z. B. eine presigned URL"},
                    "base64": {
                        "type": "string",
                        "description": "Dateiinhalt base64-kodiert (nur für kleine Modelle sinnvoll)",
                    },
                },
            },
            handler=open_model,
        ),
        ToolDef(
            name="briefing",
            title="Gebäude-Briefing",
            description=(
                "Das Briefing eines bereits geöffneten Modells noch einmal: Geschoße mit Höhen, Zählungen, "
                "das Property-Vokabular dieser Datei und die blinden Flecken. Aufrufen, bevor auf einen "
                "Property- oder Geschoßnamen gefiltert wird — ein Name, den dieser Export nie geschrieben "
                'hat, liefert null Treffer und liest sich wie „das Gebäude hat keine".'
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "format": {
                        "type": "string",
                        "enum": ["text", "json"],
                        "default": "text",
                        "description": "text = der Block für den Kontext, json = dieselben Fakten als Daten",
                    },
                },
                "required": ["model"],
            },
            handler=lambda args: (
                {"briefing": render_briefing(resolve(args.get("model")))}
                if _lower(args.get("format")) != "json"
                else build_briefing(resolve(args.get("model"))).to_dict()
            ),
        ),
        ToolDef(
            name="find_elements",
            title="Bauteile suchen",
            description=(
                "Findet Bauteile nach IFC-Typ, Namensbestandteil, Geschoß oder Art und gibt ihre GlobalIds "
                "zurück — die Eingabe für jedes andere Werkzeug hier. Geschoßnamen wörtlich aus dem Briefing "
                "übernehmen."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "ifcType": {"type": "string", "description": "z. B. IfcWall, IfcWindow, IfcSpace"},
                    "nameContains": {"type": "string"},
                    "storey": {"type": "string", "description": "Geschoßname, wörtlich aus dem Briefing"},
                    "kind": {"type": "string", "enum": KINDS},
                    "limit": {"type": "number", "default": 50},
                },
                "required": ["model"],
            },
            handler=find_elements,
        ),
        ToolDef(
            name="element",
            title="Ein Bauteil",
            description=(
                "Alles über EIN Bauteil: Typ, Name, Geschoß, Container — und welche Relationen es überhaupt "
                "hat. Kostet keine Geometrie."
            ),
            input_schema={
                "type": "object",
                "properties": {"model": {"type": "string"}, "globalId": {"type": "string"}},
                "required": ["model", "globalId"],
            },
            handler=element,
        ),
        ToolDef(
            name="relations",
            title="Räumliche Beziehungen",
            description=(
                "Die topologischen Operatoren. Jede Antwort sagt, WOHER sie kommt: `declared` steht so in "
                "der Datei, `computed` haben wir aus anderen Relationen oder aus der Geometrie abgeleitet. "
                'Ein leeres Ergebnis heißt „dieses Bauteil hat keine solche Beziehung"; `decidable: false` '
                'heißt „dieser Export schreibt diese Relation gar nicht" — das ist ein Befund über den '
                "Export, nicht über das Gebäude, und `missing` sagt, was ihn behebt.\n\n"
                + "\n".join(f"  {name} — {meaning}" for name, meaning in RELATIONS.items())
                + "\n\nbounds, enclosedBy, opensTo und adjacentSpaces greifen auf die Geometrie zurück, wenn "
                "die Datei keine IfcRelSpaceBoundary schreibt (der Normalfall). Der erste solche Aufruf "
                "baut eine Kontaktkarte über alle Räume — einige Sekunden, danach sofort."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "globalId": {"type": "string"},
                    "relation": {"type": "string", "enum": list(RELATIONS)},
                },
                "required": ["model", "globalId", "relation"],
            },
            handler=relations,
        ),
        ToolDef(
            name="measure",
            title="Maße aus der Geometrie",
            description=(
                "Misst ein Bauteil am Modell. Diese Zahlen stammen aus der GEOMETRIE, nicht aus deklarierten "
                "Eigenschaften — sie sind also auch dann verfügbar, wenn der Export keine Mengen schreibt, "
                "und sie tragen immer eine Toleranz. Genau deshalb sind Raumflächen und Brüstungshöhen hier "
                "beantwortbar, wo eine reine Property-Abfrage leer zurückkommt.\n\n"
                + "\n".join(f"  {name} — {meaning}" for name, meaning in MEASURES.items())
                + "\n\nDer erste Aufruf tesselliert das Modell (~2 s für ein Einfamilienhaus), danach sind "
                "die Maße Millisekunden."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "globalId": {"type": "string"},
                    "measure": {"type": "string", "enum": list(MEASURES)},
                },
                "required": ["model", "globalId", "measure"],
            },
            handler=measure,
        ),
        ToolDef(
            name="distance",
            title="Abstand zwischen zwei Bauteilen",
            description=(
                "Abstand zwischen zwei Bauteilen. mode: min (kürzester Abstand der Hüllkörper — 0, wenn sie "
                "sich überschneiden), centroid, horizontal, vertical. Ein Reviewer, der eine lichte Breite "
                "prüft, will horizontal; wer eine Höhe prüft, vertical. Der schräge Abstand beantwortet "
                "keines von beiden."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "a": {"type": "string"},
                    "b": {"type": "string"},
                    "mode": {
                        "type": "string",
                        "enum": ["min", "centroid", "horizontal", "vertical"],
                        "default": "min",
                    },
                },
                "required": ["model", "a", "b"],
            },
            handler=distance,
        ),
        ToolDef(
            name="draw",
            title="Das Gebäude zeichnen",
            description=(
                "Zeichnet einen Grundriss als SVG — Wandschnitt-Poché, Raumzellen mit Namen, Öffnungen als "
                "Lücken, aus demselben Modell, aus dem auch gemessen wird. Frei einsetzbar, wann immer "
                "Hinsehen hilft: um zu verstehen, wie etwas angeordnet ist, um zu klären, welches Bauteil "
                "gemeint ist, oder um zu prüfen, ob eine Zahl überhaupt plausibel sein kann.\n\n"
                "EINE Regel: Zahlen kommen nie aus dem Bild. Maße liefern measure/distance; das Bild zeigt "
                "die Anordnung. Ein aus einer Zeichnung abgelesener Wert ist geraten, auch wenn er stimmt.\n\n"
                "DAUER: rund 5 Sekunden für ein Einfamilienhaus, mehr für ein großes Modell — vor dem Aufruf "
                "einplanen. Das SVG wird als Datei geschrieben und der Pfad zurückgegeben, nicht der Inhalt: "
                "ein Grundriss sind hunderte Kilobyte Pfaddaten, die im Kontext nichts nützen."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "storey": {
                        "type": "string",
                        "description": "Geschoßname, wörtlich aus dem Briefing; ohne Angabe alle Geschoße",
                    },
                    "include": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "IFC-Typen, auf die eingeschränkt wird (z. B. IfcWall)",
                    },
                    "widthMm": {"type": "number", "default": 420},
                    "heightMm": {"type": "number", "default": 297},
                },
                "required": ["model"],
            },
            handler=draw,
        ),
        ToolDef(
            name="overhang",
            title="Auskragung über eine Fassadenebene",
            description=(
                "Wie weit ein Bauteil über die Fassadenebene eines anderen hinausragt, senkrecht zu "
                "dieser Ebene, in Metern. Das ist die Zahl für einen Dachüberstand, einen Balkon oder ein "
                "Vordach.\n\n"
                "projecting: das auskragende Bauteil (Dach, Balkon). facade: das Bauteil, dessen "
                "Außenfläche die Bezugsebene ist — meist die Wand darunter, die relations hostedIn zu "
                "einem Fenster liefert.\n\n"
                "Gemessen (`computed`) mit Toleranz. Nie als Modellangabe berichten."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "projecting": {"type": "string", "description": "GlobalId des auskragenden Bauteils"},
                    "facade": {"type": "string", "description": "GlobalId des Bauteils, dessen Fassadenebene gilt"},
                },
                "required": ["model", "projecting", "facade"],
            },
            handler=lambda args: _jsonable(
                op.overhang(resolve(args.get("model")), _require(args, "projecting"), _require(args, "facade"))
            ),
        ),
        ToolDef(
            name="light_incidence",
            title="Freier Lichteinfall auf eine Öffnung",
            description=(
                "Baut das Lichtprisma über der Unterkante einer Öffnung und meldet, welche Bauteile "
                'hineinragen und wie tief. Beantwortet „ist der Lichteinfall frei" GEOMETRISCH.\n\n'
                "angle und swivel sind PARAMETER AUS DER BESTIMMUNG, nicht aus dem Modell. Für OIB 3 "
                "sind das 45 und 30 Grad — sie sind trotzdem zu übergeben, weil dieses Werkzeug kein "
                "Regelwerk kennt und keines kennen soll.\n\n"
                "WICHTIG: Das Ergebnis ist keine Beurteilung. Ein geschnittenes Prisma VERGRÖSSERT nach "
                "OIB 3 die erforderliche Lichteintrittsfläche — es verbietet das Fenster nicht. Aus "
                '„blockiert" ein „nicht erfüllt" zu machen überspringt die Bestimmung, statt sie '
                "anzuwenden. Berichte, was hineinragt und wie tief, und wende dann die Klausel an.\n\n"
                "exclude: GlobalIds, die nicht als Hindernis zählen — die eigene Wand gehört meist dazu.\n"
                "Braucht Geometrie: einige Sekunden beim ersten Aufruf auf ein Modell."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "globalId": {"type": "string", "description": "GlobalId der Öffnung oder ihrer Füllung"},
                    "angle": {"type": "number", "description": "Lichteinfallswinkel in Grad, aus der Bestimmung"},
                    "swivel": {"type": "number", "default": 0, "description": "seitliche Verschwenkung in Grad"},
                    "exclude": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "GlobalIds, die nicht als Hindernis zählen",
                    },
                },
                "required": ["model", "globalId", "angle"],
            },
            handler=lambda args: _light_incidence(resolve(args.get("model")), args),
        ),
        ToolDef(
            name="storey_heights",
            title="Geschoßhöhen",
            description=(
                "Geschoßhöhen als Differenz der Geschoß-Elevationen. Das ist die STRUKTURELLE Höhe von "
                "Rohdecke zu Rohdecke, nicht die lichte Raumhöhe — die Antwort sagt das selbst und der "
                "Hinweis gehört in jede Aussage darüber. Die lichte Raumhöhe liefert measure/clearHeight."
            ),
            input_schema={
                "type": "object",
                "properties": {"model": {"type": "string"}},
                "required": ["model"],
            },
            handler=lambda args: storey_heights(resolve(args.get("model"))),
        ),
        ToolDef(
            name="room_inventory",
            title="Räume nach vermuteter Nutzung",
            description=(
                "Ordnet Räume nach Namen einer vermuteten Nutzung zu (Aufenthaltsraum, Nebenraum, "
                "Erschließung). Das Ergebnis ist ausdrücklich `inferred`: ob ein Raum ein Aufenthaltsraum "
                "ist, ist eine rechtliche Einstufung und keine geometrische. Als Vorschlag zur Bestätigung "
                "behandeln, nie als Feststellung."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "kind": {
                        "type": "string",
                        "enum": ["aufenthaltsraum", "nebenraum", "erschliessung"],
                    },
                },
                "required": ["model", "kind"],
            },
            handler=lambda args: inventory(resolve(args.get("model")), str(args.get("kind") or "")),  # type: ignore[arg-type]
        ),
    ]


def call(tools: list[ToolDef], name: str, args: dict[str, Any]) -> Any:
    """Run one tool by name and return a JSON-ready result.

    The single entry point every transport uses, so an HTTP route and the MCP
    server cannot disagree about what a tool returns.
    """
    for tool in tools:
        if tool.name == name:
            return _jsonable(tool.handler(args))
    raise ToolError(f'Unbekanntes Werkzeug "{name}". Verfügbar: {", ".join(t.name for t in tools)}')


# ── helpers ─────────────────────────────────────────────────────────────────


def _nodes(model: SpatialModel) -> list[Any]:
    return [
        *model.file.by_type("IfcProject"),
        *model.file.by_type("IfcProduct"),
        *model.file.by_type("IfcGroup"),
    ]


def _read_source(args: dict[str, Any]) -> bytes:
    url = str(args.get("url") or "").strip()
    if url:
        if not url.lower().startswith(("http://", "https://")):
            raise ToolError("url muss mit http:// oder https:// beginnen")
        try:
            with urllib.request.urlopen(url, timeout=60) as response:  # noqa: S310 — scheme checked above
                data = response.read(MAX_DOWNLOAD_BYTES + 1)
        except Exception as error:  # noqa: BLE001
            raise ToolError(f"Modell konnte nicht geladen werden: {error}") from None
        if len(data) > MAX_DOWNLOAD_BYTES:
            raise ToolError(
                f"Modell ist größer als {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MB — lokal ablegen und path verwenden"
            )
        return data
    encoded = str(args.get("base64") or "").strip()
    if encoded:
        try:
            return base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            raise ToolError("base64 ist nicht dekodierbar") from None
    raise ToolError("Eine Quelle angeben: path, url oder base64")


def _jsonable(value: Any) -> Any:
    """Everything this package returns, as plain JSON types.

    Answers, element refs and room proposals all carry a ``to_dict``; NumPy
    scalars and arrays arrive from the geometry operators and are not JSON at
    all. Converting here rather than in each handler is what keeps a new
    operator from silently serialising as ``"<ndarray object at 0x…>"``.
    """
    if isinstance(value, (str, bool, int)) or value is None:
        return value
    if isinstance(value, float):
        # NaN and ±Inf are not JSON. They arrive from a degenerate mesh, and a
        # transport-level crash is a worse report than a null.
        return value if math.isfinite(value) else None
    if hasattr(value, "to_dict") and callable(value.to_dict):
        return _jsonable(value.to_dict())
    if isinstance(value, np.generic):
        return _jsonable(value.item())
    if isinstance(value, np.ndarray):
        return [_jsonable(v) for v in value.tolist()]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _jsonable(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    return str(value)


def _short(digest: str) -> str:
    return digest[:12]


def _lower(value: Any) -> str:
    return value.strip().lower() if isinstance(value, str) else ""


def _clamp(value: Any, low: int, high: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return low
    return max(low, min(high, number))


__all__ = [
    "GEOMETRIC_RELATIONS",
    "MEASURES",
    "RELATIONS",
    "ToolDef",
    "ToolError",
    "call",
    "create_tools",
]


def _require(args: dict[str, Any], key: str) -> str:
    """A required GlobalId, or a mistake the model can correct."""
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ToolError(f"{key} fehlt — eine GlobalId angeben (aus find_elements)")
    return value.strip()


def _light_incidence(model: SpatialModel, args: dict[str, Any]) -> Any:
    """The prism and what intrudes into it, in one call.

    Composed here rather than left to the caller because the halves are not
    independently useful: a prism nobody tested against the building answers
    nothing, and ``obstructions`` needs a volume the caller cannot build without
    this module's facade-plane resolution. One call also keeps the seconds of
    geometry work behind a single deliberate request rather than two.

    What it does not do is decide. The angles arrive from the clause and the
    intrusion depths go back to it; the verdict belongs to the rulebook, and the
    description says so where the model will read it.
    """
    opening = _require(args, "globalId")

    angle = args.get("angle")
    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not 0 < float(angle) < 90:
        raise ToolError("angle muss ein Winkel zwischen 0 und 90 Grad sein — der Wert kommt aus der Bestimmung")
    swivel = args.get("swivel") or 0
    if isinstance(swivel, bool) or not isinstance(swivel, (int, float)) or not 0 <= float(swivel) < 90:
        raise ToolError("swivel muss zwischen 0 und 90 Grad liegen")

    built = op.prism(model, opening, float(angle), float(swivel))
    if not built.decidable or built.value is None:
        return _jsonable(built)

    exclude = [e for e in (args.get("exclude") or []) if isinstance(e, str)]
    found = op.obstructions(model, built.value, exclude=exclude or None)
    payload = _jsonable(found)
    if isinstance(payload, dict):
        blocking = found.value or []
        payload["free"] = bool(found.decidable and not blocking)
        payload["prism"] = {"angleDeg": float(angle), "swivelDeg": float(swivel), "openingId": opening}
        note = (
            "Diese Antwort ist Geometrie, kein Befund: ein geschnittenes Prisma vergrößert nach OIB 3 "
            "die erforderliche Lichteintrittsfläche, es verbietet das Fenster nicht. Die Bewertung "
            "gehört zum Regelwerk."
        )
        # `obstructions` already carries this warning, in its own words. Appending
        # unconditionally printed it twice, and a caveat repeated is a caveat
        # skimmed — the second copy teaches the reader that this paragraph is
        # boilerplate, which is the opposite of what it is for.
        existing = payload.get("caveat") or ""
        if "kein Befund" not in existing:
            payload["caveat"] = f"{existing} {note}".strip() if existing else note
    return payload
