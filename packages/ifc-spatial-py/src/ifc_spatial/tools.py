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
import ipaddress
import math
import os
import socket
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import accessibility as acc
from . import circulation as circ
from . import clearance as clr
from . import daylight as dl

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.
from . import envelope_geometry as env
from . import fire as fi
from . import operators as op
from . import relations as extra
from . import stairs as st
from .briefing import GERMAN_KIND
from .briefing import briefing as build_briefing
from .briefing import content_hash
from .briefing import inventory
from .briefing import render_briefing
from .briefing import storey_heights
from .cache import SpatialCache
from .envelope import Answer
from .model import SpatialModel
from .model import UnknownElementError
from .model import WrongKindError


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
    "above": "Was liegt direkt über diesem Bauteil oder Raum? (Strahlen nach oben, Möblierung ausgenommen)",
    "below": "Was liegt direkt darunter?",
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
    "above": dl.above,
    "below": dl.below,
}

#: The relations that fall back to the geometric contact map when the export
#: declares no ``IfcRelSpaceBoundary`` — which is the common case.
#:
#: Named as a set rather than left implicit because two things depend on it: the
#: warning in the ``relations`` description, and ``element``'s refusal to probe
#: them just to list what is available. A six-second contact map is a reasonable
#: price for an answer somebody asked for and an unreasonable one for a menu.
GEOMETRIC_RELATIONS = frozenset(
    {
        "bounds",
        "enclosedBy",
        "opensTo",
        "adjacentSpaces",
        # `above`/`below` cast rays, so they need the OCCT tree. Left out of this
        # set they were probed by `element` to build its "available relations"
        # menu — which ran the geometry pass on a model whose caller had only
        # asked what an element is called. That is the one rule this file has.
        "above",
        "below",
    }
)

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
    "egressPath": (
        "Kürzester begehbarer Weg eines RAUMS ins Freie, über Türen — Räume, Türen und eine Länge. "
        "Nachbarschaft ist keine Begehbarkeit: zwei Räume an derselben Wand ohne Tür dazwischen "
        "grenzen aneinander und sind unerreichbar. Die Länge ist ein Streckenzug über Raum- und "
        "Türmittelpunkte und damit eine UNTERGRENZE, keine Fluchtweglänge im Sinne der OIB 2."
    ),
    "reachableFrom": (
        "Alle über Türen erreichbaren Räume mit Anzahl der Türen dazwischen. Beantwortet „welche "
        "Räume liegen hinter dieser Tür, und findet Räume ganz ohne Ausgang — was selbst ein Befund ist."
    ),
    "clearWidth": (
        "LICHTE Breite und Höhe einer Öffnung, an der Öffnung selbst gemessen (Rohbaulichte) — die "
        "Zahl, die eine Durchgangs- oder Fluchtwegbreite verlangt. NICHT distance: dessen Modi messen "
        "Schwerpunkte und Hüllboxen und liefern einen Achsabstand."
    ),
    "orientedExtent": (
        "Länge, Breite und Höhe entlang der EIGENEN Achsen des Bauteils, plus seine Verdrehung gegen "
        "Norden. Für alles, was schräg im Modell steht: extent() ist achsparallel und meldet dort "
        "systematisch zu große Werte, die weder Länge noch Dicke sind."
    ),
    "roomDepth": (
        "Raumtiefe senkrecht zur belichtenden Fassade, dazu die Breite entlang dieser Fassade und das "
        "Verhältnis zur lichten Raumhöhe — für Tageslichtfragen, bei denen die Tiefe zählt. Die "
        "gewählte Fassade wird genannt; bei einem Eckraum steht die zweitbeste dabei."
    ),
    "stairGeometry": (
        "Steigungshöhe, Auftrittsbreite, Anzahl der Steigungen und die NUTZBREITE eines Treppenlaufs "
        "— und die STREUUNG der Steigungen über den Lauf. Ungleiche Steigungen sind selbst der Befund: "
        "eine Treppe kann im Mittel stimmen und trotzdem unbegehbar sein. Deklarierte Werte werden "
        "gegen die Geometrie geprüft und ein Widerspruch gemeldet."
    ),
    "rampSlope": (
        "Neigung einer Rampe als Prozent UND als Verhältnis, dazu Lauflänge, Höhenunterschied und "
        "lichte Breite. Beide Formen, weil eine Bestimmung mal die eine und mal die andere nennt."
    ),
    "headroom": (
        "Durchgangshöhe über einem Treppenlauf oder einer Rampe, SENKRECHT ZUR LAUFEBENE gemessen — "
        "nicht lotrecht. Die Engstelle liegt dort, wo der Lauf unter die Decke darüber läuft, und ein "
        "lotrechter Strahl vom Auftritt geht daran vorbei (1,35 m gegen 1,65 m im Testfall)."
    ),
    "stepsOf": (
        "Die Läufe und Podeste, aus denen eine Treppe zusammengesetzt ist — um einen einzelnen Lauf zu "
        "befragen statt der Baugruppe. Podeste zählen, weil Bestimmungen die Zahl der Steigungen je "
        "Lauf ohne Podest begrenzen."
    ),
    "turningCircle": (
        "Der größte Kreis, der auf der freien Bodenfläche eines RAUMS Platz hat — die Zahl, auf die ein "
        "Wendekreis hinausläuft. Gezählt werden nur feste Einbauten; die Möblierung steht separat unter "
        "mitMoeblierung, weil eine Baubewilligung für das Gebäude gilt und nicht für die Stühle. Kein "
        "Grenzwert angewandt."
    ),
    "thresholdHeight": (
        "Die Stufe an einer Tür: der Höhenunterschied der Böden beiderseits. Enthält der Export keinen "
        "Fußbodenaufbau, ist es ein ROHBAUMASS — dann sagt die Antwort das, denn Estrich, Belag und "
        "Dichtung machen die Stufe erst aus, und 0 mm am Rohbau heißt nichts über die fertige Schwelle."
    ),
    "balustrade": (
        "Wo es an einer Öffnung hinuntergeht: die Absturzhöhe und was dort steht, samt seiner Höhe. "
        "Fehlen IfcRailing im Export ganz, ist die Antwort nicht entscheidbar — kein Geländer im Modell "
        "heißt nicht kein Geländer am Bau."
    ),
    "clearApproach": (
        "Die freie Bodenfläche vor einer Tür, beidseitig, und was sie begrenzt — was jemand braucht, um "
        "die Tür überhaupt öffnen zu können."
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
    "egressPath": circ.egress_path,
    "reachableFrom": circ.reachable_from,
    "clearWidth": clr.clear_opening_width,
    "orientedExtent": clr.oriented_extent,
    "roomDepth": dl.room_depth,
    "stairGeometry": st.stair_geometry,
    "rampSlope": st.ramp_slope,
    "headroom": st.headroom,
    "stepsOf": st.steps_of,
    "turningCircle": acc.turning_circle,
    "thresholdHeight": acc.threshold_height,
    "balustrade": acc.balustrade_check,
    "clearApproach": acc.clear_approach,
}

#: Which IFC types each measure is ABOUT, read off the operators' own
#: signatures — `clear_height(model, space_global_id)` takes a space, and
#: `threshold_height(model, door_global_id)` takes a door.
#:
#: An empty tuple means the measure is about geometry as such and applies to
#: anything with a shape (`extent`, `elevation`, `orientedExtent`, `floorArea`).
#:
#: This is deliberately NOT wired into `measure` as a refusal. Asking for the
#: floor area of a wall is odd but answerable, and a guard here would turn a
#: type this table happens not to list — IfcSpatialZone, a proxy standing in for
#: a room — into a refusal for a measurement that would have worked. The table
#: exists to CHOOSE, in `profile`, not to forbid.
MEASURE_SUBJECT: dict[str, tuple[str, ...]] = {
    "extent": (),
    "elevation": (),
    "orientedExtent": (),
    "floorArea": (),
    "clearHeight": ("IfcSpace",),
    "lightEntryArea": ("IfcSpace",),
    "egressPath": ("IfcSpace",),
    "reachableFrom": ("IfcSpace",),
    "roomDepth": ("IfcSpace",),
    "turningCircle": ("IfcSpace",),
    "balustrade": ("IfcSpace",),
    "sillAndHead": ("IfcWindow", "IfcDoor"),
    "clearWidth": ("IfcOpeningElement", "IfcDoor", "IfcWindow"),
    "azimuth": ("IfcWall", "IfcWallStandardCase", "IfcCurtainWall", "IfcPlate", "IfcWindow", "IfcDoor"),
    "thresholdHeight": ("IfcDoor",),
    "clearApproach": ("IfcDoor",),
    "stairGeometry": ("IfcStair", "IfcStairFlight"),
    "rampSlope": ("IfcRamp", "IfcRampFlight"),
    "headroom": ("IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"),
    "stepsOf": ("IfcStair", "IfcStairFlight", "IfcRamp", "IfcRampFlight"),
}

#: Measures that walk the door graph or sample a raster over the whole model.
#: `profile` runs them only when asked, because a profile is meant to be the
#: cheap „was ist das für ein Bauteil" call and these are seconds, not
#: milliseconds — the same budget argument that motivates `survey`.
MEASURE_EXPENSIVE: frozenset[str] = frozenset({"egressPath", "reachableFrom", "turningCircle", "clearApproach"})

#: The `what` values `fire` accepts.
FIRE_ASPECTS: dict[str, str] = {
    "fluchtniveau": (
        "Höhe des obersten Aufenthaltsgeschoßes über dem tiefsten anschließenden Gelände — die Zahl, "
        "an der die Gebäudeklasse hängt. Welche Geschoße gezählt wurden, steht in der Antwort"
    ),
    "compartmentArea": "Bodenfläche eines Brandabschnitts über mehrere Räume, mit jedem Raum einzeln",
    "separatingElements": (
        "Was zwischen zwei Räumen liegt — Wand, Decke, und die Türen darin — je mit seinem "
        "DEKLARIERTEN FireRating, und ausdrücklich mit dessen Fehlen"
    ),
    "siteBoundary": (
        "Abstand zur Grundgrenze (Brandübertragung). Auf den meisten Exporten nicht entscheidbar: "
        "eine Grundgrenze wird selten mitexportiert, und geraten wird sie hier nicht"
    ),
    "doorGraph": (
        "Der begehbare Graph des GANZEN Gebäudes: Räume als Knoten, DRAUSSEN als eigener Knoten, "
        "Türen als Kanten — und ausdrücklich die Türen, die zu keiner Kante wurden (unbestimmt, "
        "ausgeschlossen). Ein Raum ohne Kante hat keinen Ausgang, und eine unbestimmte Tür ist ein "
        "Loch in JEDEM Weg dieses Gebäudes. measure/egressPath nennt EINE Route; das hier sagt, wie "
        "vollständig die Grundlage aller Routen ist. Teilt sich den Aufbau mit egressPath und "
        "reachableFrom, kostet also nur beim ersten der drei Aufrufe Sekunden"
    ),
}

#: The `what` values `envelope` accepts.
#:
#: Grouped for the same reason as `FIRE_ASPECTS`: one subject — the building as
#: a heat-loss problem — asked three ways. All three take the WHOLE model and no
#: GlobalId, which is what separates them from `measure`: an envelope is not a
#: property of an element, it is the set of elements that happens to bound the
#: heated volume, and asking about it one wall at a time is how the wall that
#: was left out stays invisible.
ENVELOPE_ASPECTS: dict[str, str] = {
    "thermalEnvelope": (
        "Welche Bauteile die Grenze zwischen beheiztem Innen und Außen bilden, nach Art gruppiert, "
        "je mit Fläche und DEKLARIERTEM U-Wert. Jeder Eintrag nennt, WORAUS die Zuordnung folgt — "
        "IsExternal deklariert oder aus den Raumberührungen abgeleitet ist nicht dieselbe Aussage. "
        "Dazu die zwei Listen, die die Summe überprüfbar machen: innenliegend (entschieden und "
        "weggelassen) und unbestimmt (nicht entschieden, also weder gezählt noch verworfen)"
    ),
    "areaByOrientation": (
        "Hüllfläche je Himmelsrichtung, opak und transparent getrennt, mit dem Fensterflächenanteil "
        "(WWR) je Fassade. Braucht einen deklarierten TrueNorth — ohne den wird die Richtung nicht "
        "geraten, sondern verweigert"
    ),
    "compactness": (
        "A/V in 1/m, mit der charakteristischen Länge l_c = V/A daneben. A und V kommen einzeln "
        "zurück, weil ein Verhältnis, dessen Eingangsgrößen unsichtbar sind, von der Person, die es "
        "unterschreibt, nicht geprüft werden kann. V ist das NETTO-Volumen (Summe der IfcSpace-Körper)"
    ),
}

#: How many elements one `measure` call may take.
#:
#: The cap exists because the geometry is real work — a `clearHeight` is a
#: 25-ray raster per room — and an agent that pastes a whole building into
#: the field would sit inside one tool call for minutes with no way to see
#: progress. Fifty covers every storey in the corpus (the largest is 22
#: rooms) and refuses the paste.
MAX_BATCH = 50

KINDS = ["project", "site", "building", "storey", "space", "element", "opening", "group"]

#: Downloads are capped. A tool that will read whatever a URL hands it is a way
#: to fill a disk from a chat message.
MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

#: Set to ``1`` when the host KNOWS its own network and wants ``open_model(url=…)``
#: to reach it anyway — a presigned URL served by a MinIO on the same compose
#: network is the case this exists for.
#:
#: It is opt-in and not opt-out because the two failure modes are not
#: symmetric. A deployment that needed it and did not set it gets a refusal it
#: can read and fix in one environment variable; a deployment that did not need
#: it and was never asked gets an agent-controlled URL fetched from inside its
#: own perimeter, and nobody finds out.
ALLOW_PRIVATE_URLS_ENV = "IFC_SPATIAL_ALLOW_PRIVATE_URLS"

#: Every network failure that is not an HTTP status answers with THIS sentence
#: and no detail.
#:
#: „Connection refused" and „timed out" are different words for two ports on the
#: same host, which is a port scanner: the agent picks the URL, so the difference
#: between the two is a readout on a network the agent cannot otherwise see.
_UNREACHABLE_TEXT = (
    "Modell konnte nicht geladen werden: die URL war nicht abrufbar. "
    "Datei lokal ablegen und path verwenden, oder base64 übergeben."
)


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

        :class:`WrongKindError` is the same class of mistake one step further in:
        the id is real and the question does not apply to it. It is a caller
        error too — an architect cannot re-export their way out of a wall being
        asked for its clear opening width — so it also becomes a ``ToolError``
        and never a finding about the export.
        """
        try:
            return fn()
        except UnknownElementError as error:
            raise ToolError(f"{error} — GlobalId mit find_elements prüfen") from None
        except WrongKindError as error:
            raise ToolError(str(error)) from None

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

    def _select(model: SpatialModel, args: dict[str, Any], limit: int) -> tuple[list[Any], int]:
        """The selection half of `find_elements`, shared with `survey`.

        Kept as one function so the two tools cannot drift: a caller who scopes
        a survey with `storey="Keller"` has to get exactly the set that
        `find_elements(storey="Keller")` lists, or the names beside the numbers
        would be answering a different question than the numbers.
        """
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
        return matches, total

    def find_elements(args: dict[str, Any]) -> Any:
        model = resolve(args.get("model"))
        limit = _clamp(args.get("limit", 50), 1, 500)
        matches, total = _select(model, args, limit)

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
            try:
                answer = fn(model, global_id)
            except WrongKindError:
                # The ONE place a wrong kind is a question rather than a
                # mistake: this loop asks every relation whether it applies to
                # this element, and `hosts` on an IfcSpace answering "no" is the
                # menu working. Everywhere else the same refusal is the caller's
                # error and must reach them — so it is caught here by hand and
                # nowhere else, rather than softened at the source.
                continue
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
        """One measurement, of one element or of MANY.

        `globalId` takes a comma-separated list, the way `view` and
        `fire/compartmentArea` already do. That is not a convenience — it is
        what makes the common question answerable inside a caller's budget.

        „Wie hoch ist der Keller?" is one question and seventeen rooms. Asked
        one call at a time it costs seventeen tool calls, and the agent that
        reported this had a budget of FIVE: it spent them on two briefings and
        a storey table, was cut off before the first `clearHeight`, and fell
        back to the declared storey pitch of 3.00 m for rooms whose measured
        clear height is 2.70 m. The measurement was available and correct the
        whole time; nothing in the answer was wrong except which number it
        reached for, and it ran out of turns before it could reach the right
        one.

        A list also answers a question a single measurement cannot: whether the
        rooms AGREE. „Alle 17 Kellerräume 2.70 m" is a different and much
        stronger statement than one room measured and sixteen assumed, and it
        is the statement a Raumhöhennachweis actually needs.
        """
        model = resolve(args.get("model"))
        name = str(args.get("measure") or "")
        fn = MEASURE_FN.get(name)
        if fn is None:
            raise ToolError(f'measure "{name}" gibt es nicht. Erlaubt: {", ".join(MEASURES)}')

        ids = [part.strip() for part in str(args.get("globalId") or "").split(",") if part.strip()]
        if not ids:
            raise ToolError("globalId fehlt — eine GlobalId angeben (aus find_elements)")
        if len(ids) == 1:
            return run(lambda: fn(model, ids[0]))
        if len(ids) > MAX_BATCH:
            raise ToolError(
                f"höchstens {MAX_BATCH} GlobalIds je Aufruf — {len(ids)} übergeben. "
                "In mehreren Aufrufen messen, oder mit find_elements eingrenzen."
            )

        # Each element keeps its OWN answer, with its own provenance, tolerance
        # and refusal. A batch that merged them into one number would be the
        # error this package exists to prevent: seventeen rooms measured and
        # one of them undecidable is not „the basement is 2.70 m", and the
        # caller has to be able to see which one.
        results = [{"globalId": gid, "answer": _jsonable(run(lambda gid=gid: fn(model, gid)))} for gid in ids]
        decided = [r for r in results if (r["answer"] or {}).get("decidable")]
        values = [(r["answer"] or {}).get("value") for r in decided]
        numeric = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
        agreement: dict[str, Any] = {
            "measured": len(decided),
            "of": len(ids),
            "undecidable": [r["globalId"] for r in results if not (r["answer"] or {}).get("decidable")],
        }
        if numeric:
            low, high = min(numeric), max(numeric)
            agreement |= {"min": round(low, 6), "max": round(high, 6), "spread": round(high - low, 6)}
        return {"measure": name, "results": results, "summary": agreement}

    def survey(args: dict[str, Any]) -> Any:
        """One measurement over a NAMED SET — selection, measurement and names
        in a single call.

        This exists because of the shape of the questions, not the shape of the
        code. „Wie hoch ist der Keller?" is not a question about a room; it is a
        question about seventeen rooms, and the honest answer is a range with an
        outlier in it. Composed from primitives it costs `find_elements` +
        `measure` + a GlobalId→Name join the caller has to carry in its head —
        four turns of a five-turn budget, which is exactly how a real query came
        back quoting the declared storey pitch of 3.00 m for rooms that measure
        2.70 m, with one at 0.25 m nobody saw.

        `find_elements` and `measure` stay: a caller who needs an unusual set,
        or one element, should not pay for a survey. This is the composition of
        the two, not a replacement for either — and it deliberately reports the
        same set `find_elements` would, because names beside numbers are only
        useful if they belong to the same rooms.
        """
        model = resolve(args.get("model"))
        name = str(args.get("measure") or "")
        fn = MEASURE_FN.get(name)
        if fn is None:
            raise ToolError(f'measure "{name}" gibt es nicht. Erlaubt: {", ".join(MEASURES)}')

        limit = _clamp(args.get("limit", MAX_BATCH), 1, MAX_BATCH)
        matches, total = _select(model, args, limit)
        if not matches:
            return {
                "measure": name,
                "results": [],
                "summary": {"measured": 0, "of": 0, "undecidable": []},
                "hint": (
                    "Kein Bauteil passt zu dieser Auswahl — gemessen wurde daher nichts. "
                    "Geschoßnamen und Typen stehen im Briefing; sie stammen aus diesem Export "
                    "und lauten selten so, wie die Frage sie nennt."
                ),
            }

        results: list[dict[str, Any]] = []
        for element in matches:
            ref = model.ref(element).to_dict()
            storey = model.storey_of(element)
            results.append(
                {
                    "globalId": ref.get("globalId"),
                    # The name is the whole point of surveying rather than
                    # batching: a caller that has to report WHICH room is the
                    # outlier cannot do it from a GlobalId.
                    "name": ref.get("name"),
                    "storey": getattr(storey, "Name", None),
                    "answer": _jsonable(run(lambda gid=str(ref.get("globalId") or ""): fn(model, gid))),
                }
            )

        decided = [r for r in results if (r["answer"] or {}).get("decidable")]
        numeric = [
            v
            for v in ((r["answer"] or {}).get("value") for r in decided)
            if isinstance(v, (int, float)) and not isinstance(v, bool)
        ]
        summary: dict[str, Any] = {
            "measured": len(decided),
            "of": len(results),
            "undecidable": [
                {"globalId": r["globalId"], "name": r["name"]}
                for r in results
                if not (r["answer"] or {}).get("decidable")
            ],
        }
        if numeric:
            low, high = min(numeric), max(numeric)
            summary |= {"min": round(low, 6), "max": round(high, 6), "spread": round(high - low, 6)}

        # Where the numbers CAME FROM, counted. A set answered half from the
        # file's own declarations and half from geometry is not one finding, and
        # the split is the caller's business: a declared value is wrong only if
        # the export is wrong, a computed one carries a tolerance. `disagree`
        # counts the elements where an operator ran both routes and they did not
        # match — those are export defects, and they are the reason a reviewer
        # asked in the first place.
        provenances = [(r["answer"] or {}).get("provenance") for r in decided]
        summary["provenance"] = {
            kind: provenances.count(kind) for kind in ("declared", "computed", "inferred") if provenances.count(kind)
        }
        disagreeing = [r for r in decided if (r["answer"] or {}).get("agreement") == "disagree"]
        if disagreeing:
            summary["disagree"] = [{"globalId": r["globalId"], "name": r["name"]} for r in disagreeing]

        out: dict[str, Any] = {"measure": name, "results": results, "summary": summary}
        if total > len(results):
            # Said out loud, never inferred. A survey of 50 of 200 rooms
            # reported as „the rooms" is the one error this package exists to
            # prevent, and silence would produce it every time.
            out["truncated"] = True
            out["summary"]["selected"] = total
            out["hint"] = (
                f"{total} Bauteile passen zur Auswahl, gemessen wurden die ersten {len(results)}. "
                "Die Spanne gilt NUR für diese; enger auswählen (storey, nameContains) und erneut messen."
            )
        return out

    def profile(args: dict[str, Any]) -> Any:
        """Every measure that applies to ONE element — the inverse of `survey`.

        `survey` is one measure over many elements; this is many measures over
        one. Both exist for the same reason: the expensive thing is not the
        measurement, it is the turn. „Erzähl mir alles über diesen Raum" is a
        normal opening move for a reviewer who has just been pointed at an
        outlier, and composed from primitives it costs one `measure` call per
        kind — twenty turns for a question that has one answer.

        Which measures apply is read from `MEASURE_SUBJECT`, so a door is not
        asked for its lichte Raumhöhe and a room is not asked for its
        Schwellenhöhe. The refusals that would produce are not useful output;
        they are noise that pushes the real numbers out of the context window.
        """
        model = resolve(args.get("model"))
        global_id = _require(args, "globalId")
        try:
            subject = model.file.by_guid(global_id)
        except (RuntimeError, KeyError):
            raise ToolError(
                f"GlobalId {global_id} steht nicht in diesem Modell. "
                "Mit find_elements suchen — GlobalIds sind exakt 22 Zeichen und gelten je Datei."
            ) from None

        ifc_type = subject.is_a()
        applicable = [
            name
            for name in MEASURES
            if not MEASURE_SUBJECT.get(name, ())
            or any(subject.is_a(subject_type) for subject_type in MEASURE_SUBJECT[name])
        ]
        if not _lower(args.get("include")) == "expensive":
            applicable = [name for name in applicable if name not in MEASURE_EXPENSIVE]

        measures: dict[str, Any] = {}
        for name in applicable:
            fn = MEASURE_FN[name]
            try:
                measures[name] = _jsonable(run(lambda fn=fn: fn(model, global_id)))
            except Exception as exc:  # noqa: BLE001
                # One measure that throws must not cost the caller the other
                # fifteen. The failure is reported in place, as a failure, and
                # the profile still comes back — the alternative is a dead call
                # and another turn spent finding out which kind was to blame.
                measures[name] = {"decidable": False, "error": f"{type(exc).__name__}: {exc}"}

        skipped = [name for name in MEASURES if name not in applicable]
        out: dict[str, Any] = {
            "element": model.ref(subject).to_dict(),
            "storey": getattr(model.storey_of(subject), "Name", None),
            "measures": measures,
        }
        if skipped:
            out["notMeasured"] = {
                "kinds": skipped,
                "why": (
                    f"Diese Kennwerte sind nicht über ein {ifc_type} definiert (oder sind teuer und "
                    'wurden übersprungen — dann include="expensive" setzen). Kein Befund über das '
                    "Bauteil, sondern über die Frage."
                ),
            }
        return out

    def distance(args: dict[str, Any]) -> Any:
        model = resolve(args.get("model"))
        mode = str(args.get("mode") or "min")
        return run(lambda: op.distance(model, str(args.get("a") or ""), str(args.get("b") or ""), mode))

    # ── fire (OIB 2) ────────────────────────────────────────────────────────

    def fire_op(args: dict[str, Any]) -> Any:
        """The four OIB-2 operators behind one name.

        Grouped rather than given a tool each because they share a subject —
        the building as a fire problem — and four tools whose only difference
        is a name make a model choose a word instead of a question.
        """
        model = resolve(args.get("model"))
        # Matched case-insensitively against the real keys rather than
        # lowercased into them: `_lower` turned "compartmentArea" into
        # "compartmentarea", which matched nothing and refused a correct call.
        wanted = str(args.get("what") or "fluchtniveau").strip().lower()
        what = next((k for k in FIRE_ASPECTS if k.lower() == wanted), wanted)
        ids = [part.strip() for part in str(args.get("globalId") or "").split(",") if part.strip()]
        if what == "fluchtniveau":
            return run(lambda: fi.fluchtniveau(model))
        if what == "compartmentArea":
            if not ids:
                raise ToolError(
                    "compartmentArea braucht globalId: ein Geschoß oder die Räume des Abschnitts, "
                    "mehrere durch Komma getrennt. GlobalIds liefert find_elements."
                )
            return run(lambda: fi.compartment_area(model, ids))
        if what == "separatingElements":
            if len(ids) != 2:
                raise ToolError(
                    "separatingElements braucht ZWEI Räume in globalId, durch Komma getrennt — "
                    "gefragt ist, was zwischen ihnen liegt."
                )
            return run(lambda: fi.separating_elements(model, ids[0], ids[1]))
        if what == "siteBoundary":
            return run(lambda: fi.distance_to_site_boundary(model, ids[0] if ids else None))
        if what == "doorGraph":
            # No `globalId`, like `fluchtniveau`: the graph IS the building. It
            # was reachable from nothing while `egressPath` and `reachableFrom`
            # — both of which are views ONTO it — were on the surface, so an
            # agent could get a route and never the two lists that say how many
            # doors the route-finder could not read. A route out of a graph with
            # four unresolved doors is not wrong, it is unfounded, and the
            # difference was invisible from here.
            return run(lambda: circ.door_graph(model))
        raise ToolError(f'what "{what}" gibt es nicht. Erlaubt: {", ".join(FIRE_ASPECTS)}')

    # ── envelope (OIB 6) ────────────────────────────────────────────────────

    def envelope_op(args: dict[str, Any]) -> Any:
        """The three OIB-6 operators behind one name.

        These existed, were tested, and were on NO tool surface — so an agent
        asked a Kompaktheit or Hüllfläche question reached nothing and said the
        export could not answer it, while the operator sat in the package with
        30 passing tests. A capability nobody can call is indistinguishable from
        a missing one, and the second is what the user was told.

        No `globalId`: all three take the whole model. `measure` is the tool for
        a named element; this one is for a set that has to be DERIVED before it
        can be measured, and the derivation is most of the answer.
        """
        model = resolve(args.get("model"))
        # Matched case-insensitively against the real keys rather than
        # lowercased into them — the same trap `fire_op` documents: lowercasing
        # turns "areaByOrientation" into "areabyorientation", which matches no
        # key and refuses a correct call.
        wanted = str(args.get("what") or "thermalEnvelope").strip().lower()
        what = next((k for k in ENVELOPE_ASPECTS if k.lower() == wanted), wanted)
        if what == "thermalEnvelope":
            return run(lambda: env.thermal_envelope(model))
        if what == "areaByOrientation":
            return run(lambda: env.envelope_area_by_orientation(model))
        if what == "compactness":
            return run(lambda: env.compactness(model))
        raise ToolError(f'what "{what}" gibt es nicht. Erlaubt: {", ".join(ENVELOPE_ASPECTS)}')

    # ── sun_position ────────────────────────────────────────────────────────

    def sun_position(args: dict[str, Any]) -> Any:
        """Where the sun stood — from the FILE's georeference and nowhere else.

        The operator accepts ``latitude``/``longitude`` to override the model,
        and this tool deliberately does not forward them. On a library call an
        override is a surveyor handing over a better coordinate; on a tool
        surface it is a field an agent can fill, and an agent that CAN supply a
        latitude will supply one — which is exactly the substitution the
        operator refuses to make on its own. An assumed 48°N Vienna on a
        Vorarlberg project is 1.4° out in solar altitude and comes back as a
        `computed` number with a tolerance, indistinguishable from a measured
        one. A host that really has a survey coordinate calls the operator.

        ``when`` gets its own check rather than ``_require``: that helper's
        refusal names a GlobalId and find_elements, which for a timestamp sends
        the caller looking in the model for something that is not in it.
        """
        model = resolve(args.get("model"))
        when = args.get("when")
        if not isinstance(when, str) or not when.strip():
            raise ToolError(
                "when fehlt — den Zeitpunkt nach ISO 8601 MIT Zeitzone angeben, "
                "z. B. 2026-06-21T12:00:00+02:00 (Sommerzeit) oder 2026-06-21T10:00:00Z."
            )
        return run(lambda: dl.sun_position(model, when.strip()))

    # ── ids ─────────────────────────────────────────────────────────────────

    def shopping_list(args: dict[str, Any]) -> Any:
        """The model's blind spots as a buildingSMART IDS file.

        The one output of this package that leaves the conversation and keeps
        working. Everything else is a sentence an architect reads once; this is
        a file they run in their own checker, on their own schedule, and re-run
        after the fix to prove it landed.
        """
        # Imported HERE, not at module scope. `ids_export` needs `ifctester`,
        # which ships with IfcOpenShell as a separate distribution and is not
        # guaranteed present — and a module-level import made a missing optional
        # dependency take down the ENTIRE tool surface, so a deployment without
        # it could not measure a wall either. One tool degrading is a fact about
        # one capability; eleven tools vanishing is an outage.
        try:
            from . import ids_export as ids
        except ImportError as error:
            raise ToolError(
                "Die IDS-Ausgabe steht in dieser Installation nicht zur Verfügung (ifctester fehlt). "
                "Die fehlenden Angaben stehen weiterhin im Briefing unter FEHLT und BLIND und können "
                "dort berichtet werden."
            ) from error

        model = resolve(args.get("model"))
        document = ids.blind_spots_as_ids(
            model,
            title=(str(args["title"]).strip() if args.get("title") else None),
            author=(str(args["author"]).strip() if args.get("author") else None),
        )
        written = ids.write_ids(document)
        return {**written, "summary": document.summary()}

    # ── the caption ─────────────────────────────────────────────────────────

    def _plan_note(drawn: Any) -> str:
        """What the picture actually shows — which is not always a floor plan.

        ``render.plan`` returns ``None`` only when there is neither structure NOR
        a room. A storey that has a room outline and no structural element
        crossing the 1.2 m cut therefore comes back as a page holding one filled
        rectangle, with ``elementsDrawn: 0``. On the sample house that is
        ``view(storey='Roof')``: rooms ``['Roof']``, 0 elements, and a caption
        reading „auf dieser Höhe erscheinen Tür- und Fensteröffnungen als Lücken
        in der Wand" — a sentence about walls, in front of a picture with no
        walls in it. An agent that looks at that concludes the loft is open on
        every side.

        The page is not refused, because a room outline IS information and a
        blank page must stay distinguishable from a broken renderer (the module
        docstring's rule). What changes is that the caption stops describing a
        drawing that is not there.
        """
        head = f"Grundriss „{drawn.storey}“, waagrechter Schnitt {drawn.cut_z:.2f} m über Null"
        tail = "Maße NICHT aus dem Bild ablesen; dafür measure/distance."
        if drawn.drawn == 0:
            return (
                f"{head}. ACHTUNG: auf dieser Schnitthöhe wurde KEIN Bauteil gezeichnet "
                "(elementsDrawn = 0) — kein Bauteil dieses Geschoßes schneidet die Ebene. Im Bild "
                "stehen nur die Raumumrisse; das Fehlen von Wänden, Türen und Fenstern im Bild ist "
                f"keine Aussage über das Gebäude. {tail}"
            )
        return f"{head} — auf dieser Höhe erscheinen Tür- und Fensteröffnungen als Lücken in der Wand. {tail}"

    # ── room_inventory ──────────────────────────────────────────────────────

    def room_inventory(args: dict[str, Any]) -> Any:
        """``kind`` is validated here, exactly like ``relation`` and ``measure``.

        It used to go straight through as ``str(args.get("kind") or "")``, and
        ``briefing.inventory`` indexed ``GERMAN_KIND`` with it — so an omitted or
        misspelt kind came back as ``KeyError: ''`` from ``briefing.py:799``. A
        Python traceback is not a refusal: the caller cannot read it, cannot act
        on it, and an MCP client sees a crash where every other enum in this file
        produces a German sentence naming the allowed values. The NAT tool layer
        happened to validate ``kind`` before this was reached, but this module is
        documented as transport-free and ``mcp_server`` hands arguments here
        unfiltered.
        """
        model = resolve(args.get("model"))
        kind = str(args.get("kind") or "").strip()
        if kind not in GERMAN_KIND:
            raise ToolError(
                f'kind "{kind}" gibt es nicht. Erlaubt: {", ".join(GERMAN_KIND)}'
                if kind
                else f"kind fehlt. Erlaubt: {', '.join(GERMAN_KIND)}"
            )
        return inventory(model, kind)  # type: ignore[arg-type]

    # ── view ────────────────────────────────────────────────────────────────

    def view(args: dict[str, Any]) -> Any:
        """A plan as base64 PNG, for a transport that can show it to the model.

        The bytes come back here rather than going to a file, which is the
        opposite of `draw`'s rule — and deliberately. `draw` writes a file
        because a few hundred kilobytes of SVG path data in a context window
        buys nothing: the agent cannot read path data. A raster is the reverse
        case; it is the only form the agent CAN read, and a path to it is worth
        exactly nothing to a model that has no eyes on the filesystem.

        The caller decides what to do with the base64 — an MCP client wraps it
        as an image content block, an HTTP host may hand back a URL instead.
        This layer does not know which, so it returns the bytes and the facts.
        """
        from . import render as rendering

        model = resolve(args.get("model"))
        started = time.perf_counter()
        drawn = rendering.plan(
            model,
            storey=(str(args["storey"]).strip() if args.get("storey") else None),
            highlight=[str(v) for v in (args.get("highlight") or [])],
            only=[str(v) for v in (args.get("only") or [])],
        )
        seconds = time.perf_counter() - started
        if drawn is None:
            # Not an empty picture. A blank page and a broken renderer are
            # indistinguishable to a reader, so the two must not share a result.
            raise ToolError(
                "Für dieses Geschoß gibt es nichts zu zeichnen — kein Bauteil dieses Geschoßes trägt "
                "Geometrie, oder der Geschoßname trifft nichts. Geschoßnamen stehen im Briefing."
            )

        return {
            "pngBase64": base64.b64encode(drawn.png).decode("ascii"),
            "mediaType": "image/png",
            "width": drawn.width,
            "height": drawn.height,
            "storey": drawn.storey,
            "cutHeight": round(drawn.cut_z, 3),
            "rooms": drawn.rooms,
            "highlighted": drawn.highlighted,
            "elementsDrawn": drawn.drawn,
            "northDeclared": drawn.north_deg is not None,
            "seconds": round(seconds, 2),
            "note": _plan_note(drawn),
        }

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
                    "url": {
                        "type": "string",
                        "description": (
                            "HTTP(S)-URL, z. B. eine presigned URL. Nur öffentlich erreichbare Adressen — "
                            "loopback, private und link-local Adressen werden nicht abgerufen."
                        ),
                    },
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
                + "\n\nGilt für EIN Bauteil. Für ein ganzes Geschoß oder eine Raumgruppe `survey` nehmen — "
                "gleiche Kennwerte, aber mit Namen und Spanne, und in einem Aufruf statt in zwanzig. "
                "(globalId nimmt hier auch eine kommagetrennte Liste, wenn die Menge schon feststeht.)\n\n"
                "Der erste Aufruf tesselliert das Modell (~2 s für ein Einfamilienhaus), danach sind "
                "die Maße Millisekunden."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "globalId": {
                        "type": "string",
                        "description": (
                            f"Eine GlobalId, oder bis zu {MAX_BATCH} kommagetrennt für eine Messung über "
                            "mehrere Bauteile."
                        ),
                    },
                    "measure": {"type": "string", "enum": list(MEASURES)},
                },
                "required": ["model", "globalId", "measure"],
            },
            handler=measure,
        ),
        ToolDef(
            name="survey",
            title="Eine Messung über ein ganzes Geschoß",
            description=(
                "Misst EINEN Kennwert an ALLEN Bauteilen einer Auswahl und nennt sie beim Namen. "
                "Der erste Griff, sobald die Frage im Plural steht — „wie hoch ist der Keller“, „wie groß "
                "sind die Büros“, „haben alle Aufenthaltsräume genug Licht“: das ist je eine Frage über "
                "viele Räume, und sie ist erst beantwortet, wenn alle gemessen sind.\n\n"
                "Ausgewählt wird wie bei find_elements (storey, ifcType, nameContains, kind); gemessen wird "
                "mit den Kennwerten aus `measure`, die dort erklärt sind. Zurück kommen Name, Geschoß und "
                "eigene Antwort je Bauteil, dazu die Spanne.\n\n"
                "Die Spanne ist der eigentliche Befund. „Alle 17 Kellerräume 2,70 m“ und „16 davon 2,70 m, "
                "einer 0,25 m“ sind verschiedene Antworten auf dieselbe Frage, und aus einem einzeln "
                "gemessenen Raum folgt keine von beiden."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "measure": {"type": "string", "enum": list(MEASURES)},
                    "storey": {"type": "string", "description": "Geschoßname exakt wie im Briefing"},
                    "ifcType": {"type": "string", "description": "z. B. IfcSpace, IfcWindow, IfcDoor"},
                    "nameContains": {"type": "string"},
                    "kind": {"type": "string"},
                    "limit": {"type": "integer", "description": f"höchstens {MAX_BATCH}"},
                },
                "required": ["model", "measure"],
            },
            handler=survey,
        ),
        ToolDef(
            name="profile",
            title="Alles Messbare an einem Bauteil",
            description=(
                "Misst ALLE Kennwerte, die für dieses eine Bauteil definiert sind, in einem Aufruf — "
                "welche das sind, ergibt sich aus seinem IFC-Typ. Der Griff, sobald ein Bauteil "
                "interessant geworden ist: der Ausreißer aus einem survey, der Raum aus der Frage, die "
                "Tür, um die es geht. Statt zwanzig Mal `measure` mit geratenem Kennwert.\n\n"
                "Teure Kennwerte (Fluchtweg, Erreichbarkeit, Bewegungsfläche, Türvorfeld) laufen nur mit "
                'include="expensive" mit; sie brauchen den Türgraph oder ein Raster über das Modell. '
                "Was NICHT gemessen wurde, steht mit Begründung in der Antwort — das ist eine Aussage "
                "über die Frage, nicht über das Gebäude."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "globalId": {"type": "string"},
                    "include": {
                        "type": "string",
                        "enum": ["expensive"],
                        "description": "Teure Kennwerte mitmessen (Sekunden statt Millisekunden).",
                    },
                },
                "required": ["model", "globalId"],
            },
            handler=profile,
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
            name="clearance",
            title="Lichtes Maß zwischen zwei Bauteilen",
            description=(
                "Der kleinste Abstand OBERFLÄCHE zu OBERFLÄCHE zwischen zwei Körpern, in Metern — das "
                "lichte Maß, das distance nicht hat. Für den Gang zwischen zwei Wänden, den Abstand "
                "Handlauf/Wand, den Durchgang zwischen zwei Einbauten.\n\n"
                "NICHT distance: dessen min ist der Abstand der HÜLLBOXEN. Am Pultdach gegen die "
                "Innenwand des Musterhauses meldet min 0,000 m — die Box des Daches verschluckt die der "
                "Wand — wo das lichte Maß 0,995 m beträgt. Eine Boxlücke ist immer eine Untergrenze und "
                "nie eine Obergrenze: sie meldet Bauteile näher beieinander als sie sind, also in der "
                "Richtung, in der zu eng als frei durchgeht.\n\n"
                "Für das lichte Maß EINER Öffnung ist measure/clearWidth der Aufruf — eine Öffnung hat "
                "zwei Laibungen, aber nur ein Bauteil, und dieses Werkzeug braucht zwei.\n\n"
                "Die Antwort trägt die beiden Punkte, zwischen denen gemessen wurde (für eine Maßlinie "
                "im eigenen Modell), und boxGap: die Zahl, die distance('min') geliefert hätte. Der "
                "Unterschied der beiden ist selbst der Befund.\n\n"
                "Braucht Geometrie: einige Sekunden beim ersten Aufruf auf ein Modell."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "a": {"type": "string", "description": "GlobalId des ersten Bauteils"},
                    "b": {"type": "string", "description": "GlobalId des zweiten Bauteils"},
                },
                "required": ["model", "a", "b"],
            },
            handler=lambda args: _jsonable(
                clr.clear_width(resolve(args.get("model")), _require(args, "a"), _require(args, "b"))
            ),
        ),
        ToolDef(
            name="fire",
            title="Brandschutz-Geometrie (OIB 2)",
            description=(
                "Die geometrischen Größen, auf die OIB 2 hinausläuft:\n"
                + "\n".join(f"  {k} — {v}" for k, v in FIRE_ASPECTS.items())
                + "\n\nKEINE Gebäudeklasse. fluchtniveau liefert eine HÖHE; welche Klasse daraus folgt, "
                "ist eine rechtliche Einstufung nach OIB 2 samt Landesrecht. Ein Werkzeug, das GK5 "
                "zurückgibt, hat eine Regel angewandt, die es nie gelesen hat."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "what": {"type": "string", "enum": list(FIRE_ASPECTS)},
                    "globalId": {
                        "type": "string",
                        "description": "Je nach what: Geschoß/Räume (Komma-getrennt), zwei Räume, oder leer",
                    },
                },
                "required": ["model", "what"],
            },
            handler=fire_op,
        ),
        ToolDef(
            name="envelope",
            title="Thermische Gebäudehülle (OIB 6)",
            description=(
                "Die geometrischen Größen, die eine OIB-6-Rechnung als Eingang braucht:\n"
                + "\n".join(f"  {k} — {v}" for k, v in ENVELOPE_ASPECTS.items())
                + "\n\nKEIN U-Wert wird gerechnet. Ein deklarierter U-Wert wird wiedergegeben; ein "
                "nicht deklarierter FEHLT und wird NICHT aus den Schichten hergeleitet — ein aus einer "
                "Materialliste gerechneter U-Wert ist eine andere Zahl als die, die die Architektin "
                "unterschrieben hat, und sieht genauso aus.\n\n"
                "KEIN Grenzwert und kein „erfüllt“: welcher U-Wert oder welches A/V zulässig ist, steht "
                "in OIB 6 und im Energieausweis-Verfahren, nicht in der Geometrie.\n\n"
                "Kostet Geometrie (Sekunden, nicht Millisekunden): alle drei bauen die Körper der "
                "Hüllbauteile auf."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "what": {"type": "string", "enum": list(ENVELOPE_ASPECTS)},
                },
                "required": ["model", "what"],
            },
            handler=envelope_op,
        ),
        ToolDef(
            name="shopping_list",
            title="Fehlende Angaben als IDS-Datei",
            description=(
                "Schreibt die blinden Flecken dieses Modells als buildingSMART-IDS-Datei (Version 1.0) "
                "— also das, was der Export NICHT hergibt, in einem Format, das die Architektin in "
                "Solibri, BIMcollab oder ifctester gegen ihr eigenes Modell laufen lassen kann. Nach der "
                "Korrektur nochmals laufen lassen beweist, dass die Ergänzung angekommen ist.\n\n"
                "Die Datei verlangt nur, DASS ein Merkmal vorhanden und auswertbar ist, nie WELCHEN WERT "
                "es haben muss: Grenzwerte stehen in der OIB-Richtlinie, und einen erfundenen Grenzwert "
                "in das Prüfwerkzeug einer Architektin zu schreiben wäre der schwerste Fehler, den "
                "dieses Werkzeug machen könnte.\n\n"
                "Nicht jeder blinde Fleck lässt sich als IDS ausdrücken — fehlende IfcRelSpaceBoundary "
                "etwa nicht. Was nicht ausdrückbar ist, wird gemeldet und NICHT stillschweigend "
                "weggelassen; die Zusammenfassung nennt beide Zahlen."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "title": {"type": "string", "description": "Titel der IDS-Datei"},
                    "author": {"type": "string", "description": "E-Mail oder Name für den IDS-Kopf"},
                },
                "required": ["model"],
            },
            handler=shopping_list,
        ),
        ToolDef(
            name="view",
            title="Den Grundriss ansehen",
            description=(
                "Rendert ein Geschoß als PNG und gibt es so zurück, dass das Modell es TATSÄCHLICH SEHEN "
                "kann — im Unterschied zu draw, das eine SVG-Datei schreibt und nur den Pfad nennt.\n\n"
                "Dafür gedacht, sich zu orientieren, bevor gemessen wird: welches Bauteil ist gemeint, "
                "wie sind die Räume angeordnet, liegt das Fenster wirklich in der Wand, die hostedIn "
                "nennt. `highlight` markiert einzelne Bauteile rot im gesamten Grundriss (wo ist das?), "
                "`only` blendet alles andere aus (wie sieht das aus?). GlobalIds kommen aus "
                "find_elements oder relations.\n\n"
                "EINE Regel: Zahlen kommen nie aus dem Bild. Ein abgelesenes Maß ist geraten, auch wenn "
                "es zufällig stimmt — dafür measure und distance."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "storey": {
                        "type": "string",
                        "description": "Geschoßname, wörtlich aus dem Briefing; ohne Angabe das unterste",
                    },
                    "highlight": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "GlobalIds, die rot markiert werden — der Rest bleibt sichtbar",
                    },
                    "only": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "GlobalIds, auf die die Zeichnung eingeschränkt wird",
                    },
                },
                "required": ["model"],
            },
            handler=view,
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
            name="sun_position",
            title="Sonnenstand über diesem Gebäude",
            description=(
                "Azimut (Grad im Uhrzeigersinn ab Nord) und Höhenwinkel der Sonne zu einem Zeitpunkt, "
                "dazu die Richtung ZUR Sonne in den Koordinaten DIESES Modells — die Eingangsgröße "
                "jeder Verschattungsbetrachtung, und die Zahl, an der eine Besonnungsfrage anfängt.\n\n"
                "KEINE Besonnungsstudie. Ein Sonnenstand sagt, dass die Sonne 61,9° hoch und 178,9° "
                "herum stand; er sagt NICHT, ob der Giebel des Nachbarn davorstand, ob der Balkon "
                "darüber den Strahl schnitt oder wie viele Stunden Sonne das Fenster über den Tag "
                "bekam. Das sind Verschattungsfragen, und sie brauchen zusätzlich alles außerhalb der "
                "Grundgrenze — was in dieser Datei nicht steht. Der Caveat sagt das in jeder Antwort.\n\n"
                "Ohne IfcSite.RefLatitude/RefLongitude nicht entscheidbar, und es wird KEINE Breite "
                "angenommen: ein unterstelltes Wien auf einem Vorarlberger Projekt liegt 1,4° im "
                "Höhenwinkel daneben, ein unterstelltes Nord auf einem um 40° gedrehten Gebäude 40° — "
                "beides käme als gemessene Zahl mit Toleranz zurück. Aus demselben Grund nimmt dieses "
                "Werkzeug auch keine Koordinaten entgegen.\n\n"
                "when MUSS eine Zeitzone tragen. 2026-06-21T12:00:00 ohne Zone als UTC zu lesen "
                "verschiebt die Sonne in Österreich um 30° — zwei Stunden Schatten, bei einer Eingabe, "
                "die vollständig aussah.\n\n"
                "Genauigkeit 0,01° (Michalsky 1988) für 1950–2050, außerhalb 0,1°; die Toleranz steht "
                "in der Antwort. Keine Geometrie, Millisekunden."
            ),
            input_schema={
                "type": "object",
                "properties": {
                    "model": {"type": "string"},
                    "when": {
                        "type": "string",
                        "description": (
                            "Zeitpunkt nach ISO 8601 MIT Zeitzone, z. B. 2026-06-21T12:00:00+02:00 "
                            "oder 2026-06-21T10:00:00Z"
                        ),
                    },
                },
                "required": ["model", "when"],
            },
            handler=sun_position,
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
            handler=room_inventory,
        ),
    ]


def call(tools: list[ToolDef], name: str, args: dict[str, Any]) -> Any:
    """Run one tool by name and return a JSON-ready result.

    The single entry point every transport uses, so an HTTP route and the MCP
    server cannot disagree about what a tool returns.

    The two caller mistakes are converted here as well as inside ``run``, so that
    a handler which forgot to wrap its operator cannot leak a Python traceback to
    an MCP client. ``mcp_server`` hands raw arguments straight to this function
    and has no second net.
    """
    for tool in tools:
        if tool.name == name:
            try:
                return _jsonable(tool.handler(args))
            except UnknownElementError as error:
                raise ToolError(f"{error} — GlobalId mit find_elements prüfen") from None
            except WrongKindError as error:
                raise ToolError(str(error)) from None
    raise ToolError(f'Unbekanntes Werkzeug "{name}". Verfügbar: {", ".join(t.name for t in tools)}')


# ── helpers ─────────────────────────────────────────────────────────────────


def _nodes(model: SpatialModel) -> list[Any]:
    return [
        *model.file.by_type("IfcProject"),
        *model.file.by_type("IfcProduct"),
        *model.file.by_type("IfcGroup"),
    ]


def _refuse_unroutable_destination(url: str) -> None:
    """Refuse a URL that resolves anywhere but the public internet.

    The scheme check this replaces stopped ``file://`` and stopped nothing else.
    ``http://169.254.169.254/latest/meta-data/`` passed it, and so did
    ``http://127.0.0.1:9200/``, ``http://10.0.0.5/`` and every other address
    reachable from wherever this process happens to sit. That is the whole of
    SSRF: the URL comes from an agent, the connection comes from the server, and
    the server's network position is the thing being borrowed.

    ``mcp_server``'s docstring gives the host authentication and tenancy. This
    is neither, and the host cannot add it: by the time a request leaves this
    process the destination is already decided.

    **What this does not close.** The name is resolved here and resolved again
    by the socket, so a DNS entry that answers with a public address once and a
    private one a moment later gets through (rebinding). Closing it means
    pinning the resolved IP through the connection, which for TLS means owning
    SNI and certificate verification by hand — a larger and more fragile piece
    of code than the hole it shuts, in a tool whose supported path is ``path``.
    Stated rather than hidden.
    """
    if os.environ.get(ALLOW_PRIVATE_URLS_ENV, "").strip().lower() in ("1", "true", "yes"):
        return

    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme.lower() not in ("http", "https"):
        raise ToolError("url muss mit http:// oder https:// beginnen")
    host = parsed.hostname
    if not host:
        raise ToolError("url nennt keinen Host")
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError:
        raise ToolError("url nennt keinen gültigen Port") from None

    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise ToolError(_UNREACHABLE_TEXT) from None
    if not infos:
        raise ToolError(_UNREACHABLE_TEXT)

    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        # ``::ffff:127.0.0.1`` is loopback wearing an IPv6 hat, and a check that
        # only reads the outer form lets it through.
        address = getattr(address, "ipv4_mapped", None) or address
        if not address.is_global or address.is_multicast:
            raise ToolError(
                "url zeigt auf eine Adresse außerhalb des öffentlichen Netzes (loopback, privat, "
                "link-local oder multicast). Diese Quelle wird nicht abgerufen — Datei lokal ablegen "
                "und path verwenden."
            )


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Every hop is a new destination, and every hop is checked like the first.

    A public URL that answers ``302 Location: http://169.254.169.254/…`` is the
    standard way past a guard that only reads what the caller typed, and urllib
    follows redirects by default.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        _refuse_unroutable_destination(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_GuardedRedirectHandler)


def _read_source(args: dict[str, Any]) -> bytes:
    url = str(args.get("url") or "").strip()
    if url:
        _refuse_unroutable_destination(url)
        try:
            with _opener.open(url, timeout=60) as response:  # noqa: S310 — destination checked above
                data = response.read(MAX_DOWNLOAD_BYTES + 1)
        except ToolError:
            # A refused redirect hop. It is already the sentence the agent needs.
            raise
        except urllib.error.HTTPError as error:
            # The status IS safe to name: the guard has already established that
            # this host is on the public internet, so its status code says
            # nothing about our network position that the host does not tell
            # anyone who asks. It is also the one detail that makes an expired
            # presigned URL (403) diagnosable instead of mysterious.
            raise ToolError(f"Modell konnte nicht geladen werden: HTTP {error.code}") from None
        except Exception:  # noqa: BLE001
            raise ToolError(_UNREACHABLE_TEXT) from None
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
