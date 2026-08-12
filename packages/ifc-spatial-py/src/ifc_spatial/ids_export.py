"""The shopping list as a file the architect can run — buildingSMART IDS 1.0.

This package's most valuable output is often not a number. It is
``decidable: false`` with a ``missing.what`` and a ``missing.remedy``: *the
question is well-formed, this export cannot answer it, and here is what to
change in the CAD*. Today that arrives as German prose inside one chat turn,
which means it is read once, by one person, and is gone.

**IDS** — *Information Delivery Specification*, buildingSMART's standard for
stating machine-readably what a model must contain — turns the same finding
into a file. The architect drops it into Solibri, BIMcollab, usBIM or
``ifctester``, runs it against their own model in their own tool on their own
schedule, and re-runs it after the fix to prove it landed. §5 item 11 of
``docs/roadmap/agent-spatial-reasoning.md`` names exactly this.

## The one rule this module may never break

**Never state a VALUE.** Not a minimum room height, not a maximum U-value, not
a fire rating class. IDS is perfectly capable of saying ``FireRating = EI90``
and this module will not, ever. Every specification here asserts only that a
fact is PRESENT and measurable in the export.

The reason is not taste. The thresholds live in the OIB-Richtlinien and their
Länder-specific adoptions; they depend on the Bauklasse, the Gebäudeklasse, the
use of the room and the year the Bestimmung was adopted. They belong to the
knowledge base, which cites them, and to the reviewer who signs them. An IDS
file that ships an invented limit into an architect's checker under our name is
the worst failure available in this module: it is unsigned, unsourced, wears the
authority of a standard file format, is executed by a tool the architect
trusts, and produces red rows against a building that may be perfectly legal.
A missing property is a fact about an export. A threshold is a legal claim.
Only the first is ours to make.

The same rule kills ``dataType`` on the property facet, which we could emit and
do not: requiring ``IFCLENGTHMEASURE`` where the exporter wrote
``IfcPositiveLengthMeasure`` fails a model that has the fact we asked for. That
is a finding about the exporter's type spelling dressed up as a finding about
the building.

## Degrade loudly

Most of what this library reports as blind is **not expressible in IDS 1.0**.
There is no facet for geometry, none for ``IfcRelSpaceBoundary`` (see
:data:`WHY_NO_SPACE_BOUNDARY`), none for the ``TrueNorth`` of a representation
context. A shopping list that quietly drops those items is worse than no export
at all, because what the architect gets back is a green checker report about a
model that still cannot answer the question. So every finding that goes in
comes out on one of two lists — :attr:`IdsShoppingList.exported` or
:attr:`IdsShoppingList.not_exportable`, the second carrying WHY in German — and
the counts are reported together: *4 von 6 Befunden sind als IDS ausdrückbar*.

## What was measured, on the version installed here

``ifctester`` 0.8.5, shipped with IfcOpenShell, against its bundled
``ids.xsd`` version ``1.0.0``. In that schema the cardinality of a
specification lives on ``<applicability>`` as ``minOccurs``/``maxOccurs``
(``1``/``unbounded`` = required, ``0``/``unbounded`` = optional, ``0``/``0`` =
prohibited), while individual requirement facets carry ``@cardinality`` with
``required``/``optional``/``prohibited``. Earlier IDS drafts spelled this
differently, and a file using the draft spelling is rejected by every current
checker — so the XML is produced through ``ifctester``'s own encoder and
validated against its XSD before it is ever written to disk
(:func:`to_xml` raises rather than hand an architect a file no tool will open).
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from ifcopenshell import ifcopenshell_wrapper
from ifctester import ids as ifctester_ids
from ifctester.facet import Attribute
from ifctester.facet import Entity
from ifctester.facet import Facet
from ifctester.facet import PartOf
from ifctester.facet import Property
from ifctester.facet import Restriction

from .briefing import DECISIVE_PROPERTIES
from .briefing import Briefing
from .briefing import briefing as build_briefing
from .briefing import content_hash
from .envelope import Answer
from .model import SpatialModel

# ── the constants a reviewer will want to argue with ────────────────────────

#: Schema versions every specification declares.
#:
#: All three, not the schema of the model we derived them from. ``ifctester``
#: and most checkers skip a specification whose ``ifcVersion`` does not match
#: the file under test, and a skipped specification is indistinguishable from a
#: passing one in every checker UI there is. An architect who re-exports as
#: IFC2X3 to satisfy a client would silently lose the whole shopping list.
IFC_VERSIONS: tuple[str, ...] = ("IFC2X3", "IFC4", "IFC4X3_ADD2")

#: Appended to every requirement's ``instructions``, where a checker shows it
#: to the architect. It is the module's central promise, stated where the
#: person acting on the file can read it.
NO_THRESHOLD_NOTE = (
    "Diese Prüfung verlangt nur, DASS das Merkmal vorhanden und auswertbar ist. Welcher Wert zulässig ist, "
    "steht in der OIB-Richtlinie und wird hier nicht geprüft."
)

#: Why the single most common blind spot in this repository's corpus does not
#: become a specification.
#:
#: IDS 1.0 has no facet for it. The ``partOf`` facet's ``relation`` attribute is
#: a closed enumeration — ``IFCRELAGGREGATES``, ``IFCRELASSIGNSTOGROUP``,
#: ``IFCRELCONTAINEDINSPATIALSTRUCTURE``, ``IFCRELNESTS`` and
#: ``IFCRELVOIDSELEMENT IFCRELFILLSELEMENT`` — and space boundaries are not in
#: it. (The 2024 paper *Extending IDS for digital building permit requirements*
#: had to add ``IfcRelSpaceBoundary`` to that enumeration to express this, which
#: is the clearest possible evidence that stock IDS 1.0 cannot.)
#:
#: The entity facet would technically accept ``IFCRELSPACEBOUNDARY`` as an
#: applicability, and ``ifctester`` even evaluates it correctly — measured, it
#: fails the sample house and passes ``haus-mit-raeumen.ifc``. It is still not
#: emitted: the IDS user manual describes the entity facet in terms of object
#: occurrences throughout, so a conforming checker is free to find no applicable
#: entities and report the specification as passed. A silent pass on the finding
#: that matters most is exactly the failure this module exists to avoid.
WHY_NO_SPACE_BOUNDARY = (
    "IDS 1.0 kennt dafür kein Facet: die relation-Aufzählung des partOf-Facets umfasst nur IfcRelAggregates, "
    "IfcRelAssignsToGroup, IfcRelContainedInSpatialStructure, IfcRelNests und "
    "IfcRelVoidsElement+IfcRelFillsElement — Raumbegrenzungen sind nicht darunter. Über das entity-Facet ließe "
    "sich IfcRelSpaceBoundary zwar anwendbar machen, aber ein Prüfprogramm darf Beziehungsobjekte übergehen "
    "und meldet die Spezifikation dann als bestanden. Ein stiller Haken auf einen Befund, der offen ist, wäre "
    "schlimmer als dieser Hinweis."
)

WHY_NO_GEOMETRY = (
    "IDS beschreibt, welche Merkmale und Beziehungen ein Modell führen muss, nicht seine Geometrie. Für "
    "Körper, Abstände, lichte Maße und fehlende Volumenkörper gibt es kein Facet."
)

WHY_NOT_ABOUT_THE_MODEL = (
    "Kein Befund über das Modell, sondern über diesen Auswertungslauf. So etwas gehört nicht in eine Datei, "
    "die der Architekt gegen sein Modell laufen lässt — sie würde ihn zu einer Änderung auffordern, die an "
    "seinem Export nichts zu ändern hat."
)

WHY_NO_TRUE_NORTH = (
    "Die Nordrichtung hängt am IfcGeometricRepresentationContext. Das ist kein IfcObjectDefinition, also für "
    "die Anwendbarkeit einer IDS-Spezifikation nicht erreichbar, und TrueNorth ist weder Merkmal noch "
    "Beziehung im Sinne der IDS-Facets."
)

WHY_NO_FACET = (
    "Für diesen Befund ist kein IDS-Facet bekannt: er benennt weder ein Merkmal in einem Property-Set noch "
    "ein Attribut eines Bauteils noch eine der fünf Beziehungen, die IDS 1.0 ausdrücken kann."
)

WHY_NO_ELEMENTS = (
    "Dieses Modell enthält keine Bauteile der Klassen, an denen dieses Merkmal geführt wird — eine "
    "IDS-Spezifikation darauf hätte nichts, worauf sie anwendbar wäre."
)


# ── what a property finding turns into ──────────────────────────────────────


@dataclass(frozen=True)
class PropertyTarget:
    """One (Merkmal, Property-Set, Bauteilklassen) triple worth demanding.

    IDS cannot say "this property, somewhere". A specification needs an
    applicability — a concrete set of IFC classes — and a property set to look
    in, and both of those are choices we make on the architect's behalf.

    The list below is deliberately short and hand-picked rather than derived
    from the IFC property-set templates in full. Derived in full, ``FireRating``
    alone lands in fifteen ``Pset_*Common`` sets and would demand a fire rating
    on every curtain-wall mullion in the model. A file like that gets one look
    and then gets ignored, and an ignored shopping list buys nothing. So: the
    classes an OIB question actually turns on.

    ``standard`` records the footing. ``True`` means the IFC property-set
    template itself puts this property in this set for this class — the demand
    is the schema's, not ours. ``False`` means it is a convention (see
    ``SillHeight``), and the specification says so in the architect's own
    language rather than borrowing authority it does not have.
    ``test_ids_export.py`` verifies both halves against
    ``ifcopenshell.util.pset``, so the flag cannot rot into a lie.
    """

    #: German, as the briefing spells it.
    concept: str
    property: str
    pset: str
    #: Concrete IFC classes. Concrete because a checker matches the entity facet
    #: exactly: ``IFCWALL`` does not select an ``IfcWallStandardCase``, which is
    #: what most IFC2X3 exports and half the IFC4 ones actually write.
    classes: tuple[str, ...]
    standard: bool = True


_WALLS = ("IfcWall", "IfcWallStandardCase")
_DOORS = ("IfcDoor", "IfcDoorStandardCase")
_WINDOWS = ("IfcWindow", "IfcWindowStandardCase")
_SLABS = ("IfcSlab", "IfcSlabStandardCase", "IfcSlabElementedCase")

#: Where each decisive property is demanded, and on what.
PROPERTY_TARGETS: tuple[PropertyTarget, ...] = (
    PropertyTarget("Feuerwiderstand", "FireRating", "Pset_WallCommon", _WALLS),
    PropertyTarget("Feuerwiderstand", "FireRating", "Pset_DoorCommon", _DOORS),
    PropertyTarget("Feuerwiderstand", "FireRating", "Pset_SlabCommon", _SLABS),
    PropertyTarget("Brennbarkeit", "Combustible", "Pset_WallCommon", _WALLS),
    PropertyTarget("Brennbarkeit", "Combustible", "Pset_SlabCommon", _SLABS),
    PropertyTarget("Brennbarkeit", "Combustible", "Pset_CoveringCommon", ("IfcCovering",)),
    PropertyTarget("U-Wert", "ThermalTransmittance", "Pset_WallCommon", _WALLS),
    PropertyTarget("U-Wert", "ThermalTransmittance", "Pset_WindowCommon", _WINDOWS),
    PropertyTarget("U-Wert", "ThermalTransmittance", "Pset_DoorCommon", _DOORS),
    PropertyTarget("U-Wert", "ThermalTransmittance", "Pset_SlabCommon", _SLABS),
    PropertyTarget("Schallschutz", "AcousticRating", "Pset_WallCommon", _WALLS),
    PropertyTarget("Schallschutz", "AcousticRating", "Pset_DoorCommon", _DOORS),
    PropertyTarget("Schallschutz", "AcousticRating", "Pset_SlabCommon", _SLABS),
    PropertyTarget("tragend", "LoadBearing", "Pset_WallCommon", _WALLS),
    PropertyTarget("tragend", "LoadBearing", "Pset_SlabCommon", _SLABS),
    PropertyTarget("tragend", "LoadBearing", "Pset_ColumnCommon", ("IfcColumn",)),
    PropertyTarget("tragend", "LoadBearing", "Pset_BeamCommon", ("IfcBeam",)),
    PropertyTarget("außenliegend", "IsExternal", "Pset_WallCommon", _WALLS),
    PropertyTarget("außenliegend", "IsExternal", "Pset_WindowCommon", _WINDOWS),
    PropertyTarget("außenliegend", "IsExternal", "Pset_DoorCommon", _DOORS),
    PropertyTarget("Raumfläche", "NetFloorArea", "Qto_SpaceBaseQuantities", ("IfcSpace",)),
    PropertyTarget("Höhe", "Height", "Qto_SpaceBaseQuantities", ("IfcSpace",)),
    # The one entry the IFC standard does not back. Pset_WindowCommon defines
    # HasSillExternal and HasSillInternal — booleans about whether there IS a
    # sill — and nowhere in IFC4 or IFC2X3 is there a templated property for the
    # height of it. `SillHeight` in `Pset_WindowCommon` is what exporters
    # write and what this library reads, and that is a weaker claim than "the
    # schema says so". The specification's description says as much, out loud,
    # in the checker.
    PropertyTarget("Brüstungshöhe", "SillHeight", "Pset_WindowCommon", _WINDOWS, standard=False),
)

_CONVENTION_NOTE = {
    "SillHeight": (
        "Achtung: SillHeight ist in IFC4 kein Merkmal der Vorlage Pset_WindowCommon — dort stehen nur "
        "HasSillExternal und HasSillInternal. Wo ein Exporteur die Brüstungshöhe ablegt, ist nicht genormt; "
        "diese Spezifikation verlangt den Pfad, den dieses Werkzeug liest."
    )
}


# ── the result ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class NotExportable:
    """A finding that stays German prose, and the reason it has to."""

    #: The finding in the words the briefing or the answer used.
    what: str
    #: Why IDS 1.0 cannot state it. German, and specific — "not supported" tells
    #: the reader nothing they can act on or contradict.
    why: str

    def to_dict(self) -> dict[str, str]:
        return {"what": self.what, "why": self.why}


@dataclass(frozen=True)
class IdsShoppingList:
    """An IDS document plus the honest account of what did not fit in it."""

    #: The ``ifctester.ids.Ids`` document. Kept as the library's own object so a
    #: caller can validate it in-process without a file round trip.
    ids: Any
    #: Findings that became specifications, in the words they arrived in.
    exported: list[str]
    not_exportable: list[NotExportable]
    #: What this list was derived from — a content hash for a model, a count for
    #: a list of answers. Travels so a file found on disk months later can still
    #: be matched to the export it describes.
    source: str

    @property
    def specifications(self) -> int:
        return len(self.ids.specifications)

    def summary(self) -> str:
        """The sentence a caller may print verbatim. German, and never rounded.

        Says the ratio, not just the numerator. "10 Spezifikationen" reads like
        a complete shopping list; "4 von 6 Befunden" is the truth, and the two
        differ by exactly the items the architect will not be told about if
        nobody prints the second one.
        """
        total = len(self.exported) + len(self.not_exportable)
        if total == 0:
            return "Keine Befunde — es gibt nichts zu exportieren."
        head = (
            f"{len(self.exported)} von {total} Befunden sind als IDS ausdrückbar "
            f"({self.specifications} Spezifikation{'' if self.specifications == 1 else 'en'})."
        )
        if not self.not_exportable:
            return head
        return head + " Nicht ausdrückbar: " + "; ".join(entry.what for entry in self.not_exportable) + "."

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "specifications": self.specifications,
            "exported": list(self.exported),
            "notExportable": [entry.to_dict() for entry in self.not_exportable],
            "summary": self.summary(),
        }


class IdsExportError(Exception):
    """The document cannot be produced — as opposed to being empty.

    An empty shopping list is a result (:func:`write_ids` reports it as one). A
    document that fails its own schema is a defect in this module, and it must
    never reach an architect's checker as a file that silently does nothing.
    """


# ── blind_spots_as_ids() ────────────────────────────────────────────────────


def blind_spots_as_ids(
    model: SpatialModel,
    *,
    title: str | None = None,
    author: str | None = None,
    date: str | None = None,
    brief: Briefing | None = None,
) -> IdsShoppingList:
    """This model's blind spots and unfilled properties, as an IDS document.

    Two inputs, both already computed by :func:`ifc_spatial.briefing.briefing`
    and neither invented here: ``blindSpots`` (what this file cannot answer) and
    ``absentProperties`` — the FEHLT block, the decisive properties that are
    filled nowhere in the export. Those are the two lists an architect can act
    on, and this function is only a translation of them into a format their own
    tools execute.

    ``author`` must be an e-mail address: the IDS 1.0 XSD constrains the field
    with a pattern, and ``ifctester`` silently drops anything else. ``date`` is
    not defaulted to today on purpose — two runs over the same file must produce
    the same bytes, and a caller that wants a date can pass one. ``brief`` takes
    an already-computed briefing, so a caller that has one does not pay for the
    property-set walk twice and cannot end up exporting a shopping list that
    disagrees with the briefing it just showed the user.
    """
    b = brief if brief is not None else build_briefing(model)
    present = _classes_present(model)

    specifications: list[Any] = []
    exported: list[str] = []
    not_exportable: list[NotExportable] = []

    for spot in b.blind_spots:
        built, reason = _blind_spot_specification(spot.what, spot.remedy, present)
        if built is None:
            not_exportable.append(NotExportable(what=spot.what, why=reason or WHY_NO_FACET))
        else:
            _append(specifications, built)
            exported.append(spot.what)

    for entry in b.absent_properties:
        finding = f"{entry['concept']} ({entry['property']}) nirgends befüllt"
        built = [
            _property_specification(target, present)
            for target in PROPERTY_TARGETS
            if target.property == entry["property"] and _intersect(target.classes, present)
        ]
        if not built:
            not_exportable.append(NotExportable(what=finding, why=_why_no_property_target(entry["property"], present)))
            continue
        _append(specifications, built)
        exported.append(finding)

    identity = f"{b.source_name or 'IFC-Datei ohne Namen im Header'} (sha {b.content_hash[:8]})"
    document = _document(
        title=title or "Was diesem Modell fehlt",
        description=(
            f"Abgeleitet aus {identity} durch ifc-spatial. Jede Spezifikation verlangt, dass eine Angabe "
            "VORHANDEN ist — keine verlangt einen bestimmten Wert."
        ),
        author=author,
        date=date,
        specifications=specifications,
    )
    return IdsShoppingList(
        ids=document,
        exported=exported,
        not_exportable=not_exportable,
        source=content_hash(model),
    )


# ── answers_as_ids() ────────────────────────────────────────────────────────


def answers_as_ids(
    answers: Sequence[Answer[Any]],
    *,
    title: str | None = None,
    author: str | None = None,
    date: str | None = None,
    model: SpatialModel | None = None,
) -> IdsShoppingList:
    """Every ``decidable: false`` among these answers, as an IDS document.

    This is the one that closes the loop. The agent measured a building, some
    questions came back unanswerable, and the architect gets a file naming
    exactly those — not a summary of them, not a screenshot of the chat, a file
    their checker runs before and after the fix.

    The mapping is driven by ``missing.what``, which the envelope defines as the
    absent fact *in the file's own vocabulary*: a property path
    (``Pset_WindowCommon.SillHeight``), an entity (``IfcSpace``) or a relation
    (``IfcRelFillsElement``). Those three shapes are exactly the three IDS can
    express, which is not a coincidence — it is why the envelope was worth
    porting unchanged.

    Decidable answers are skipped in silence; they are not findings. Answers
    whose ``missing.what`` is German prose about geometry ("keine senkrechte
    Fläche an …") land in :attr:`IdsShoppingList.not_exportable` with the reason,
    because a shopping list that loses items quietly is worse than one that
    admits its own edges.

    ``model`` is optional and buys one thing: when an answer's ``missing``
    names elements, their IFC classes can be read from the file and the
    applicability aimed at those classes instead of at a guess.
    """
    present = _classes_present(model) if model is not None else None

    specifications: list[Any] = []
    exported: list[str] = []
    not_exportable: list[NotExportable] = []
    seen: set[str] = set()
    undecided = 0

    for answer in answers:
        if answer.decidable or answer.missing is None:
            continue
        undecided += 1
        what = answer.missing.what
        if what in seen:
            # The same gap answered five questions. It is one thing to author in
            # the CAD, so it is one finding, counted once — otherwise the summary
            # would suggest the file asks for more than it does.
            continue
        seen.add(what)
        built, reason = _missing_specification(answer, model, present)
        if built is None:
            not_exportable.append(NotExportable(what=what, why=reason or WHY_NO_FACET))
        else:
            # `_append` drops a specification that is already in the document.
            # Two answers phrased differently — `IfcBuildingStorey.Elevation` and
            # `IfcBuildingStorey.Elevation für IfcWall „W1"` — are one demand on
            # the architect, and a checker showing it twice invites the reading
            # that they are two different things to fix.
            _append(specifications, built)
            exported.append(what)

    document = _document(
        title=title or "Was für diese Fragen im Modell fehlt",
        description=(
            f"Aus {undecided} unentscheidbaren von {len(answers)} Antworten abgeleitet. Jede Spezifikation "
            "verlangt, dass eine Angabe VORHANDEN ist — keine verlangt einen bestimmten Wert."
        ),
        author=author,
        date=date,
        specifications=specifications,
    )
    return IdsShoppingList(
        ids=document,
        exported=exported,
        not_exportable=not_exportable,
        source=f"{undecided} von {len(answers)} Antworten unentscheidbar",
    )


# ── to_xml() / write_ids() ──────────────────────────────────────────────────


def to_xml(document: IdsShoppingList | Any) -> str:
    """The IDS 1.0 XML, validated against the bundled XSD before it is returned.

    Validation is not belt-and-braces. An IDS that a checker refuses to open
    produces no rows, and no rows in a checker reads as "nothing wrong" to
    everyone who did not watch the import fail. So an invalid document raises
    here and never reaches a file.
    """
    ids_document = document.ids if isinstance(document, IdsShoppingList) else document
    if not ids_document.specifications:
        raise IdsExportError(
            "Ein IDS ohne Spezifikation ist nach der XSD ungültig (specifications verlangt mindestens eine). "
            "Es gibt für dieses Modell nichts in IDS auszudrücken."
        )
    xml = ids_document.to_string()
    if not ifctester_ids.get_schema().is_valid(xml):
        raise IdsExportError("Das erzeugte IDS ist nach ids.xsd 1.0 ungültig — es wird nicht geschrieben.")
    return xml


def write_ids(
    document: IdsShoppingList,
    *,
    directory: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    """Write the document and return FACTS about it, never the document.

    Same discipline as ``tools.draw``: a whole IDS is kilobytes of XML that a
    language model cannot act on and that would evict the conversation to
    deliver. The host shows the file to the human; the agent gets the path, the
    count, and — the part that must not be lost — the findings that could not be
    expressed.

    An empty shopping list is not an error. It returns ``path: None`` with a
    German note saying so, because "there was nothing to demand" is a real and
    good outcome, and raising on it would push callers into treating a clean
    model as a failure.
    """
    if not document.ids.specifications:
        return {
            "path": None,
            "specifications": 0,
            "exported": list(document.exported),
            "notExportable": [entry.to_dict() for entry in document.not_exportable],
            "note": (
                "Kein IDS geschrieben: aus den Befunden dieses Modells lässt sich keine IDS-Spezifikation "
                "bilden. " + document.summary()
            ),
        }

    xml = to_xml(document)
    payload = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml
    target_directory = directory or tempfile.mkdtemp(prefix="ifc-spatial-")
    os.makedirs(target_directory, exist_ok=True)
    # Addressed by its own content, like everything else this package writes: two
    # runs over an unchanged model produce the same name, so a file already on
    # disk is visibly the same shopping list rather than a second copy of it.
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]
    path = os.path.join(target_directory, name or f"fehlt-{digest}.ids")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(payload)

    return {
        "path": path,
        "bytes": len(payload.encode("utf-8")),
        "specifications": document.specifications,
        "exported": list(document.exported),
        "notExportable": [entry.to_dict() for entry in document.not_exportable],
        "note": (
            "Die Datei ist eine buildingSMART IDS 1.0 und läuft in Solibri, BIMcollab, usBIM oder ifctester "
            "gegen das eigene Modell. Sie verlangt ausschließlich das VORHANDENSEIN von Angaben, keine "
            "Grenzwerte — Grenzwerte stehen in der OIB-Richtlinie. " + document.summary()
        ),
    }


# ── building the specifications ─────────────────────────────────────────────


def _document(
    *,
    title: str,
    description: str,
    author: str | None,
    date: str | None,
    specifications: Sequence[Any],
) -> Any:
    document = ifctester_ids.Ids(
        title=title,
        description=description,
        author=author,
        date=date,
        purpose="Nachweis, dass die für eine OIB-Prüfung nötigen Angaben im Modell vorhanden sind",
    )
    document.specifications = list(specifications)
    return document


def _specification(
    *,
    name: str,
    description: str,
    instructions: str,
    applicability: Sequence[Facet],
    requirements: Sequence[Facet] = (),
    required: bool = False,
) -> Any:
    """One specification, with the cardinality decision made explicitly.

    ``required`` (``minOccurs=1``) says *the model must contain at least one of
    these*. It is used only where the absence IS the finding — no ``IfcSpace``,
    no ``IfcSite``. Everywhere else the applicability is optional
    (``minOccurs=0``), which reads as *if such elements exist, they must carry
    this*.

    The distinction is the whole rule of this library applied to a file format:
    a required specification for ``IFCDOOR`` on a model with no doors fails, and
    that failure is a claim about the BUILDING — that it ought to have doors —
    which we have no standing to make. An optional one is a claim about the
    export, which is the only kind we make.
    """
    spec = ifctester_ids.Specification(
        name=name,
        minOccurs=1 if required else 0,
        maxOccurs="unbounded",
        ifcVersion=list(IFC_VERSIONS),
        description=description,
        instructions=instructions,
    )
    spec.applicability = list(applicability)
    spec.requirements = list(requirements)
    return spec


def _property_specification(target: PropertyTarget, present: Sequence[str] | None) -> Any:
    classes = _intersect(target.classes, present) if present is not None else list(target.classes)
    footing = _CONVENTION_NOTE.get(target.property) if not target.standard else None
    description = (
        f"{target.concept} ist in diesem Export nirgends befüllt. Eine Abfrage darauf liefert leer — das "
        "liest sich wie „nein“, ist aber „unbekannt“."
    )
    if footing:
        description = f"{description} {footing}"
    return _specification(
        name=f"{target.concept} vorhanden ({target.pset}.{target.property})",
        description=description,
        instructions=(
            f"{target.concept} im CAD pflegen und im Property-Set {target.pset} mitexportieren. {NO_THRESHOLD_NOTE}"
        ),
        applicability=[_entity_facet(classes)],
        # cardinality="required" on the facet: the property must be there for
        # every applicable element. `optional` would pass a model that publishes
        # the property for one wall out of four hundred, which is the fill rate
        # the briefing already warns about.
        requirements=[Property(propertySet=target.pset, baseName=target.property, cardinality="required")],
    )


def _blind_spot_specification(what: str, remedy: str, present: Sequence[str]) -> tuple[list[Any] | None, str | None]:
    """Map one blind spot onto specifications, or say why it cannot be mapped.

    Matched on a distinctive fragment of the German wording rather than on an
    id, because :class:`~ifc_spatial.briefing.BlindSpot` has no id — it is a
    German sentence with counts interpolated into it. That is a coupling to
    another module's prose and it is deliberate: the failure mode when the
    wording changes is that the spot falls through to "no known facet" and is
    REPORTED as not exportable. It degrades into the honest bucket rather than
    into silence, which is the only kind of coupling worth having here.
    """
    if "keine IfcSpace-Elemente" in what:
        return [
            _specification(
                name="Räume als IfcSpace exportiert",
                description=(
                    "Dieser Export enthält keine IfcSpace. Ohne Räume ist keine Raumfläche, keine Raumtiefe "
                    "und nichts je Aufenthaltsraum ableitbar."
                ),
                instructions=f"{remedy}. {NO_THRESHOLD_NOTE}",
                applicability=[Entity(name="IFCSPACE")],
                required=True,
            )
        ], None

    if "IfcRelSpaceBoundary" in what:
        return None, WHY_NO_SPACE_BOUNDARY

    if "IfcRelFillsElement" in what or "ohne auflösbare Wandzuordnung" in what:
        return [_openings_hosted_specification(remedy, present)], None

    if "keine Nordrichtung" in what:
        return None, WHY_NO_TRUE_NORTH

    if "keine Georeferenzierung" in what:
        return [_georeference_specification(remedy)], None

    if "Geometrie-Pass" in what or "Stichprobe" in what:
        return None, WHY_NOT_ABOUT_THE_MODEL

    if "ohne Volumenkörper" in what:
        return None, WHY_NO_GEOMETRY

    return None, WHY_NO_FACET


def _openings_hosted_specification(remedy: str, present: Sequence[str] | None) -> Any:
    """Every window and door must fill an opening cut into something.

    The host is required to be *an element*, not *a wall*: a dormer window sits
    in a roof and a rooflight in a slab, and a specification that failed those
    would be reporting a correctly modelled building as defective. The name
    restriction is therefore a pattern over IFC classes rather than
    ``IFCWALL`` — what the ``hostedIn`` operator needs is a host, of whatever
    class.
    """
    # The fallback is not dead code: this specification can also be reached from
    # an answer produced against one model and exported alongside another, and a
    # missing intersection there must widen the applicability rather than abort
    # the whole export over one item.
    classes = (_intersect((*_WINDOWS, *_DOORS), present) if present else []) or [*_WINDOWS, *_DOORS]
    return _specification(
        name="Fenster und Türen einer Öffnung zugeordnet",
        description=(
            "Ohne IfcRelVoidsElement + IfcRelFillsElement lässt sich zu keinem Fenster und keiner Tür sagen, "
            "in welchem Bauteil sie sitzt. Jede Frage nach der Wand hinter einem Fenster bleibt dann offen."
        ),
        instructions=f"{remedy}. {NO_THRESHOLD_NOTE}",
        applicability=[_entity_facet(classes)],
        requirements=[
            PartOf(
                name=Restriction(options={"pattern": ["IFC.*"]}),
                relation="IFCRELVOIDSELEMENT IFCRELFILLSELEMENT",
                cardinality="required",
            )
        ],
    )


def _georeference_specification(remedy: str) -> Any:
    """Georeferencing, as far as IDS reaches — which is not all the way.

    The blind spot's remedy names two routes, ``IfcMapConversion`` or
    ``RefLatitude``/``RefLongitude``. Only the second is an attribute of an
    object, so only the second is an IDS facet. The description says so rather
    than letting a green row imply the model is georeferenced when it carries
    neither a map conversion nor a projected CRS.
    """
    return _specification(
        name="Georeferenzierung am IfcSite",
        description=(
            "Ohne Georeferenzierung sind Sonnenstand und Besonnung nicht berechenbar. IDS erreicht davon nur "
            "den Weg über IfcSite.RefLatitude/RefLongitude — ein IfcMapConversion kann IDS 1.0 nicht "
            "verlangen, dieser Nachweis ist also der kleinere von beiden."
        ),
        instructions=f"{remedy}. {NO_THRESHOLD_NOTE}",
        applicability=[Entity(name="IFCSITE")],
        requirements=[
            Attribute(name="RefLatitude", cardinality="required"),
            Attribute(name="RefLongitude", cardinality="required"),
        ],
        # The absence of an IfcSite is itself the gap: a file whose spatial
        # structure starts at IfcBuilding has nowhere to put a coordinate.
        required=True,
    )


def _missing_specification(
    answer: Answer[Any], model: SpatialModel | None, present: Sequence[str] | None
) -> tuple[list[Any] | None, str | None]:
    """One ``MissingFact`` onto specifications, by the shape of ``missing.what``.

    The vocabulary is the envelope's, so the grammar is small: ``Set.Property``,
    ``IfcClass.Attribute``, ``IfcClass``, or one of the two relation strings the
    operators build. Anything else is German prose about geometry or about the
    question itself, and prose is where this stops.
    """
    missing = answer.missing
    assert missing is not None  # guarded by the caller
    what = missing.what
    remedy = missing.remedy
    # Strip the qualifiers the operators append — `IfcBuildingStorey.Elevation
    # für IfcSpace „Wohnen"`, `IfcRelSpaceBoundary (die Ableitung ... ist zu
    # teuer)`. The head is the vocabulary; the tail is the sentence around it.
    head = re.split(r"\s+[(„]|\s+für\s+", what)[0].strip()

    if head in ("IfcRelVoidsElement + IfcRelFillsElement", "IfcRelFillsElement", "IfcRelVoidsElement"):
        return [_openings_hosted_specification(remedy, present)], None

    if head == "IfcRelContainedInSpatialStructure":
        classes = _classes_of(model, missing.elements)
        if not classes:
            return None, (
                "IfcRelContainedInSpatialStructure ist als partOf-Facet ausdrückbar, aber eine "
                "IDS-Spezifikation braucht dafür konkrete Bauteilklassen. Diese Antwort nennt nur GlobalIds; "
                "ohne das Modell ist nicht bestimmbar, für welche Klassen die Zuordnung verlangt werden soll."
            )
        return [
            _specification(
                name="Bauteile einem Geschoß zugeordnet",
                description=(
                    "Ohne IfcRelContainedInSpatialStructure ist zu diesen Bauteilen kein Geschoß bestimmbar — "
                    "jede Auswertung je Geschoß lässt sie aus, ohne dass es auffällt."
                ),
                instructions=f"{remedy}. {NO_THRESHOLD_NOTE}",
                applicability=[_entity_facet(classes)],
                requirements=[
                    PartOf(
                        name=Restriction(options={"pattern": ["IFCBUILDINGSTOREY|IFCBUILDING|IFCSITE"]}),
                        relation="IFCRELCONTAINEDINSPATIALSTRUCTURE",
                        cardinality="required",
                    )
                ],
            )
        ], None

    if head.startswith("IfcRel"):
        return None, (
            WHY_NO_SPACE_BOUNDARY
            if head.startswith("IfcRelSpaceBoundary")
            else (
                f"{head} gehört nicht zu den fünf Beziehungen, die das partOf-Facet von IDS 1.0 kennt "
                "(IfcRelAggregates, IfcRelAssignsToGroup, IfcRelContainedInSpatialStructure, IfcRelNests, "
                "IfcRelVoidsElement+IfcRelFillsElement)."
            )
        )

    dotted = re.fullmatch(r"([A-Za-z][\w]*)\.([A-Za-z][\w]*)", head)
    if dotted:
        owner, member = dotted.group(1), dotted.group(2)
        if owner.startswith(("Pset_", "Qto_", "CPset_")):
            return _property_path_specification(owner, member, remedy, present)
        if _object_class(owner):
            return [
                _specification(
                    name=f"{owner}.{member} vorhanden",
                    description=(
                        f"Dieser Export lässt {member} an {owner} offen. Die Frage ist damit nicht "
                        "unbeantwortbar, sondern unbeantwortet — die Angabe fehlt in der Datei."
                    ),
                    instructions=f"{remedy} {NO_THRESHOLD_NOTE}",
                    applicability=[Entity(name=owner.upper())],
                    requirements=[Attribute(name=member, cardinality="required")],
                    # The attribute is demanded of whatever instances exist; that
                    # such instances must exist is a separate claim we do not make
                    # here.
                    required=False,
                )
            ], None
        return None, (
            f"{owner} ist kein IfcObjectDefinition — eine IDS-Spezifikation kann darauf nicht anwendbar sein, "
            f"und {member} ist damit weder als Attribut- noch als Merkmals-Facet erreichbar."
        )

    if re.fullmatch(r"Ifc[A-Za-z0-9]+", head):
        if not _object_class(head):
            return None, (
                f"{head} ist im IFC-Schema kein IfcObjectDefinition — als Anwendbarkeit einer "
                "IDS-Spezifikation ist die Klasse nicht erreichbar."
            )
        return [
            _specification(
                name=f"{head} im Modell vorhanden",
                description=f"Dieser Export enthält keine {head}. Alles, was darauf aufbaut, bleibt offen.",
                instructions=f"{remedy} {NO_THRESHOLD_NOTE}",
                applicability=[Entity(name=head.upper())],
                required=True,
            )
        ], None

    return None, WHY_NO_FACET


def _property_path_specification(
    pset: str, name: str, remedy: str, present: Sequence[str] | None
) -> tuple[list[Any] | None, str | None]:
    """``Pset_X.Prop`` from an answer, aimed at the classes that carry it."""
    known = [t for t in PROPERTY_TARGETS if t.pset == pset and t.property == name]
    if known:
        target = known[0]
        classes = _intersect(target.classes, present) if present is not None else list(target.classes)
        if not classes:
            return None, WHY_NO_ELEMENTS
        return [_property_specification(target, classes)], None

    classes = _pset_classes(pset)
    if not classes:
        return None, (
            f"Zu {pset} ist keine Bauteilklasse bestimmbar — weder aus der IFC-Vorlage noch aus der Tabelle "
            "dieses Moduls. Eine IDS-Spezifikation ohne Anwendbarkeit gibt es nicht."
        )
    narrowed = _intersect(classes, present) if present is not None else classes
    if not narrowed:
        return None, WHY_NO_ELEMENTS
    target = PropertyTarget(concept=name, property=name, pset=pset, classes=tuple(narrowed), standard=True)
    return [
        _specification(
            name=f"{pset}.{name} vorhanden",
            description=f"Dieser Export befüllt {pset}.{name} nicht. Eine Abfrage darauf liefert leer.",
            instructions=f"{remedy} {NO_THRESHOLD_NOTE}",
            applicability=[_entity_facet(narrowed)],
            requirements=[Property(propertySet=pset, baseName=name, cardinality="required")],
        )
    ], None


# ── small shared helpers ────────────────────────────────────────────────────


def _entity_facet(classes: Sequence[str]) -> Entity:
    """An applicability over one or several concrete classes.

    A single class goes in as a plain value and several as an enumeration
    restriction, rather than a pattern over a prefix: ``IFCWALL.*`` would also
    select ``IfcWallType``, and a specification that demands a fire rating on a
    type object rather than on the wall is a specification the architect cannot
    satisfy without authoring a property they were never asked for.
    """
    names = sorted(dict.fromkeys(c.upper() for c in classes))
    if not names:
        raise IdsExportError("Eine IDS-Anwendbarkeit ohne IFC-Klasse gibt es nicht.")
    if len(names) == 1:
        return Entity(name=names[0])
    return Entity(name=Restriction(options={"enumeration": names}))


def _classes_present(model: SpatialModel) -> list[str]:
    """The IFC classes this file actually instantiates.

    Every applicability is narrowed to these. Demanding a property on
    ``IfcDoor`` in a model that publishes no door produces a specification that
    can only ever be vacuous, and a checker report padded with vacuous rows is
    one the architect stops reading.
    """
    try:
        return sorted({element.is_a() for element in model.file.by_type("IfcProduct")})
    except RuntimeError:
        return []


def _classes_of(model: SpatialModel | None, global_ids: Sequence[str] | None) -> list[str]:
    """The classes behind a ``missing.elements`` list, when a model is at hand."""
    if model is None or not global_ids:
        return []
    found: list[str] = []
    for global_id in global_ids:
        try:
            found.append(model.file.by_guid(global_id).is_a())
        except (RuntimeError, KeyError):
            continue
    return sorted(dict.fromkeys(found))


def _pset_classes(pset: str) -> list[str]:
    """Which classes a property set belongs to, per the IFC property templates.

    Asked of the schema rather than guessed from the name, so an unknown set
    yields nothing and the caller says so instead of inventing an applicability
    from a string like ``Pset_MeineFirma_Bauteile``.
    """
    import ifcopenshell.util.pset as pset_util

    for schema in ("IFC4", "IFC2X3"):
        try:
            template = pset_util.get_template(schema).get_by_name(pset)
        except Exception:
            continue
        if template is None or not template.ApplicableEntity:
            continue
        # `ApplicableEntity` is comma-separated and may carry a predefined type
        # after a slash (`IfcBuildingElementProxy/PROVISIONFORVOID`), which is
        # not a class name.
        return sorted({part.split("/")[0].strip() for part in template.ApplicableEntity.split(",") if part.strip()})
    return []


_OBJECT_ROOT = "IfcObjectDefinition"


def _object_class(name: str) -> bool:
    """Is this a class an IDS applicability can name?

    Asked of the IFC schema, not of a naming convention, because the answer
    decides whether a finding becomes a specification or a documented refusal.
    ``IfcRelSpaceBoundary`` and ``IfcGeometricRepresentationContext`` both look
    like ordinary class names and neither is an object.
    """
    for schema_name in ("IFC4", "IFC4X3_ADD2", "IFC2X3"):
        try:
            schema = ifcopenshell_wrapper.schema_by_name(schema_name)
            entity = schema.declaration_by_name(name).as_entity()
        except Exception:
            continue
        while entity is not None:
            if entity.name() == _OBJECT_ROOT:
                return True
            entity = entity.supertype()
    return False


def _intersect(classes: Iterable[str], present: Sequence[str] | None) -> list[str]:
    if present is None:
        return list(classes)
    available = {name.lower() for name in present}
    return [name for name in classes if name.lower() in available]


def _append(specifications: list[Any], built: Sequence[Any]) -> None:
    """Add specifications, skipping any whose name is already in the document.

    The name is the identity a checker shows and a human argues about, so two
    specifications sharing one is not a duplicate row — it is the same demand
    printed twice, which reads as two separate things to fix.
    """
    names = {spec.name for spec in specifications}
    for spec in built:
        if spec.name in names:
            continue
        names.add(spec.name)
        specifications.append(spec)


def _why_no_property_target(property_name: str, present: Sequence[str]) -> str:
    targets = [t for t in PROPERTY_TARGETS if t.property == property_name]
    if not targets:
        concept = next((c for c, p in DECISIVE_PROPERTIES if p == property_name), property_name)
        return (
            f"Für {concept} ({property_name}) ist in diesem Modul kein Property-Set und keine Bauteilklasse "
            "hinterlegt — ohne beides gibt es keine IDS-Spezifikation."
        )
    wanted = sorted({name for target in targets for name in target.classes})
    return f"{WHY_NO_ELEMENTS} Verlangt würde es an: {', '.join(wanted)}."


__all__ = [
    "IFC_VERSIONS",
    "PROPERTY_TARGETS",
    "IdsExportError",
    "IdsShoppingList",
    "NotExportable",
    "PropertyTarget",
    "answers_as_ids",
    "blind_spots_as_ids",
    "to_xml",
    "write_ids",
]
