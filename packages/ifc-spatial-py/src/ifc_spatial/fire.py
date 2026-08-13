"""Brandabschnitte, Trennbauteile und Grundstücksabstände — the geometry OIB 2 turns on.

:mod:`~ifc_spatial.circulation` already answers the escape-ROUTE half of OIB
Richtlinie 2 (*welcher Weg, wie lang*). This module is the other half, the one
about **compartments and distances**, and it deliberately overlaps with nothing
there:

  - :func:`fluchtniveau` — the height of the topmost floor level intended for
    occupancy, above the lowest adjoining ground.
  - :func:`compartment_area` — the floor area a Brandabschnitt is measured on,
    over a group of spaces taken together.
  - :func:`separating_elements` — what lies BETWEEN two spaces, and the declared
    ``FireRating`` of each, including the door in the fire wall.
  - :func:`distance_to_site_boundary` — how far the building stands from the
    site boundary, for Brandübertragung auf Nachbargrundstücke.

## The line this module does not cross, and why it is drawn here

**No verdict, no threshold, and above all no Gebäudeklasse.**

:func:`fluchtniveau` returns a HEIGHT IN METRES. Which Gebäudeklasse that height
implies is a *legal* classification: OIB Richtlinie 2 sets the bands, the
Landesrecht adopts them with its own amendments, and the classification also
depends on the number of Geschoße, the Brutto-Grundfläche and the use — none of
which is a fact about this file's geometry. A tool that answers „GK5“ has
applied a rule it never read, and the sentence it produces reads exactly like a
measurement. ``light_incidence`` refuses to supply its own 45° for the same
reason and :mod:`~ifc_spatial.circulation` refuses to know the maximum
Fluchtweglänge; this module refuses to know the Gebäudeklasse bands. The height
goes out, the classification stays with whoever signs it.

The same applies downward: :func:`separating_elements` reports the
``FireRating`` an export declares and never says whether REI 90 is *enough*, and
:func:`compartment_area` reports square metres and never compares them against
the maximum Brandabschnittsfläche.

## Two of these four are ordinarily underivable, and the module says which

Measured on this repository's five fixtures:

  - **Not one of them carries a site boundary.** All five have an ``IfcSite``
    with ``Representation = None``, and there is no ``IfcAnnotation``,
    ``IfcGeographicElement`` or ``IfcExternalSpatialElement`` in any of them.
    The sample house even carries ``RefLatitude`` — it is georeferenced and
    still has no boundary, which is the normal state of an architectural export.
    :func:`distance_to_site_boundary` therefore returns ``undecidable`` on every
    one of them, and it does **not** fall back to the site's bounding box. See
    that function's docstring for why an honest refusal is worth more than the
    number a bounding box would produce.
  - **``Ifc4_SampleHouse.ifc`` declares ``FireRating`` nowhere** — zero of its
    75 products carry the property, in any pset. That is the single most common
    finding in Austrian exports, and :func:`separating_elements` names it as a
    gap in the EXPORT rather than reporting a wall with no fire resistance.

## What is inferred here, and why it may not be anything else

"Intended for occupancy" is not measurable. A 16 m² room on the top floor is a
Büro or a Lüftungszentrale depending on what the plan says it is, and the plan
is not in the file. :func:`fluchtniveau` therefore reuses this package's own
room lexicon (:func:`~ifc_spatial.briefing.classify_rooms`) plus the storey's
name, returns ``inferred``, and reports **every** storey it looked at with the
reason it was counted or not — so a reviewer can correct the one storey that is
wrong instead of discarding the number.

When the evidence is absent rather than negative, the storey is **counted**. A
Fluchtniveau reported too LOW is the dangerous direction: it understates the
height on which the Gebäudeklasse turns, and every requirement downstream of
that classification gets looser. Silence in an export is not evidence that a
floor is uninhabited, so silence does not remove a storey.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

import numpy as np

from . import operators as op
from .briefing import classify_rooms
from .briefing import normalise
from .envelope import Answer
from .envelope import MissingFact
from .envelope import computed
from .envelope import declared
from .envelope import inferred
from .envelope import undecidable
from .model import AIR_TYPES
from .model import SpatialModel

# ── vocabulary ──────────────────────────────────────────────────────────────
#
# Normalised the way `briefing.normalise` normalises room names — lower case,
# umlauts transliterated — because a storey called `Dachgeschoß` and one called
# `Dachgeschoss` are the same storey and an exporter picks the spelling.

#: STOREY names that are evidence AGAINST occupancy. Each entry is a substring
#: match on the normalised name.
#:
#: **This is a tie-breaker, not a veto.** It is consulted only after the room
#: lexicon has been asked and returned nothing — see :func:`_judge_one_storey`.
#: Tested ahead of the rooms it struck out the 107 m² Galerie in the
#: „Dachgeschoss" of ``AC20-FZK-Haus.ifc`` and reported a Fluchtniveau of
#: **1.000 m** instead of **3.700 m**.
#:
#: Never used to remove a room the lexicon has PLACED. Run that way these terms
#: struck „Dachzimmer" and „Attikazimmer" out of the habitable list and dropped
#: the storey holding them, reporting a Fluchtniveau of 0.000 m for a house
#: whose upper floor sits at 3.500 m. What a room is used for is the room
#: lexicon's question, and :func:`~ifc_spatial.briefing.classify_rooms` answers
#: it; these terms only corroborate a storey name over the room names it could
#: not answer for.
#:
#: ``dach`` is in the list and ``dachgeschoss`` is not a separate entry: the
#: substring covers both, and a *Dachgeschoss* that is genuinely occupied is
#: exactly the case a reviewer is expected to correct — which is why every
#: storey travels back with its reason instead of only the surviving one.
NOT_OCCUPIED_TERMS: tuple[str, ...] = (
    "dach",
    "attika",
    "technik",
    "haustechnik",
    "maschinenraum",
    "aufzugsmaschin",
    "lueftungszentrale",
    "roof",
    "plant",
    "attic",
    "mechanical",
)

#: Names that mark an ``IfcAnnotation`` (or an ``IfcSite``'s own name) as the
#: site boundary. German first, because the files this reads are Austrian.
BOUNDARY_TERMS: tuple[str, ...] = (
    "grundstuecksgrenze",
    "grundstueckgrenze",
    "grundgrenze",
    "bauplatzgrenze",
    "baugrundstueck",
    "parzelle",
    "vermessung",
    "site boundary",
    "property line",
    "plot boundary",
    "lot line",
)

#: How far a separating element may overrun the gap between two space bodies,
#: in metres, and still count as lying between them.
#:
#: Not a guess: in ``Ifc4_SampleHouse.ifc`` the living room and the bedroom are
#: separated by a 95 mm partition whose body fills the gap exactly, while the
#: door in it (``…VyWax``) stands **63 mm proud on each side** — its lining and
#: leaf are wider than the wall core. A slack below 0.063 m drops the door out
#: of the answer, and the door is the weak point of a fire wall: it is the one
#: element that must not go missing.
SEPARATION_SLACK = 0.15

#: Below this, two space footprints that overlap in plan are overlapping by
#: tessellation noise rather than by being modelled twice, in m².
MIN_OVERLAP_AREA = 0.01

#: Where the "does this file declare any FireRating at all, and how many of them
#: are blank" scan is memoised. On the model, for the reason
#: :mod:`~ifc_spatial.circulation` gives for its own memo — see
#: :func:`_fire_rating_scan`.
_FIRE_RATING_MEMO = "_ifc_spatial_fire_declares_rating"

_NO_GEBAEUDEKLASSE = (
    "Diese Zahl ist eine HÖHE in Metern, keine Einstufung. Welche Gebäudeklasse sich daraus ergibt, "
    "bestimmt die OIB-Richtlinie 2 zusammen mit dem jeweiligen Landesrecht und hängt außerdem von der "
    "Anzahl der Geschoße, der Brutto-Grundfläche und der Nutzung ab — nichts davon ist eine geometrische "
    "Eigenschaft dieser Datei. Diese Bibliothek nennt deshalb keine Gebäudeklasse."
)

_GROUND_CAVEAT = (
    "Maßgeblich ist nach OIB das TIEFER gelegene anschließende Gelände. Ein Gelände ist in einem "
    "Architekturexport fast nie modelliert; welcher Bezug hier tatsächlich verwendet wurde, steht in "
    "„groundReference“ und muss gegen den Einreichplan geprüft werden. Fällt das Gelände zur Traufe hin ab, "
    "ist das wirkliche Fluchtniveau GRÖSSER als die hier gemeldete Zahl."
)


# ════════════════════════════════════════════════════════════════════════════
# fluchtniveau — the highest-value scalar in OIB 2, and the one most easily
# turned into a classification it must not become
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class StoreyJudgement:
    """One storey, its elevation, and whether it was counted — with the reason.

    Both halves travel. A caller that renders only the counted storeys has
    published a number nobody can correct: the whole point of reporting the
    Technikgeschoss that was dropped is that a reviewer who knows it is a
    Wohnung can say so, and the arithmetic is one subtraction away.
    """

    global_id: str
    name: str | None
    elevation: float | None
    counted: bool
    #: German, and specific: which signal decided it.
    warum: str
    #: The spaces found on this storey, with the lexicon's own classification.
    spaces: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "elevation": self.elevation,
            "gezaehlt": self.counted,
            "warum": self.warum,
            "raeume": list(self.spaces),
        }


def fluchtniveau(model: SpatialModel) -> Answer[dict[str, Any]]:
    """The topmost occupied floor level above the lowest adjoining ground, in metres.

    ``Fluchtniveau`` in the OIB sense: *die Höhenlage des höchstgelegenen zum
    Aufenthalt von Menschen bestimmten Fußbodenniveaus über dem tiefer gelegenen
    anschließenden Gelände*. Both halves of that sentence are geometric, and
    neither of them is trivial.

    ## The upper half is a judgement, so it is ``inferred``

    "Zum Aufenthalt von Menschen bestimmt" is a statement about intent. Nothing
    in an IFC file settles it — a 16 m² room under the roof is a Kinderzimmer or
    a Lüftungszentrale depending on the Einreichplan. Two signals are used, both
    of them evidence and neither of them proof, **and they are ranked**:

    1. the rooms on it, classified by this package's existing room lexicon
       (:func:`~ifc_spatial.briefing.classify_rooms`) — one Aufenthaltsraum
       counts the storey, and a storey whose every room is a Neben- or
       Erschließungsfläche is not a level people stay on;
    2. only where the lexicon places nothing at all: the storey's own NAME
       against :data:`NOT_OCCUPIED_TERMS` (``Technikgeschoss``,
       ``Dachgeschoss``, ``Attika``), and then only while every unplaceable room
       name falls in that same vocabulary.

    The order is not cosmetic. Tested first, the name vetoed unconditionally and
    reported **1.00 m** instead of **3.70 m** for ``AC20-FZK-Haus.ifc``, whose
    „Dachgeschoss" holds a 107 m² Galerie — see :func:`_judge_one_storey`.

    A storey is removed only on **positive** evidence. A storey with no rooms in
    the export, or with rooms the lexicon cannot place and a name nothing
    corroborates, is COUNTED, because a Fluchtniveau reported too low is the
    dangerous direction: it understates the height the Gebäudeklasse turns on,
    and every requirement behind that classification loosens with it. Every
    storey comes back in ``storeys`` with its reason, counted or not.

    ## The lower half is a measurement with three possible references

    In priority order, and the one actually used is named in
    ``groundReference.via``:

    1. **``IfcSite`` body geometry** — the lowest point of the modelled terrain.
       The only route that measures *Gelände* at all, and the one almost no
       architectural export supports.
    2. **the lowest declared storey elevation** (``IfcBuildingStorey.Elevation``).
       This is a FLOOR level, not a terrain level; on a building with a
       basement it sits metres below the ground and the answer comes out too
       large, on a building whose ground floor is raised above the terrain it
       comes out too small.
    3. **the lowest point of the built geometry** — the underside of the lowest
       slab or footing, when no storey declares an elevation at all.

    ``RefElevation`` is deliberately NOT a route: it is defined relative to sea
    level, the geometry is not, and mixing the two produces exactly the
    tens-of-metres datum error that
    :func:`~ifc_spatial.operators._storey_datum_drift` exists to catch. It is
    reported under ``candidates`` for a human to compare, never subtracted.

    ## What this returns, and what it never returns

    A height in metres. **Never a Gebäudeklasse** — see the module docstring;
    that classification is law plus Landesrecht plus facts this file does not
    hold, and a library that emits „GK5“ has quietly applied a rule it never
    read.
    """
    method = "fluchtniveau(model)"
    storeys = model.storeys
    if not storeys:
        return undecidable(
            from_=[],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="IfcBuildingStorey",
                remedy=(
                    "Dieser Export enthält keine Geschoße. Geschoße im CAD anlegen und mit ihrer Höhenlage "
                    "(Elevation) mitexportieren — ohne Geschoßebenen gibt es kein Fußbodenniveau, dessen Höhe "
                    "gemessen werden könnte."
                ),
            ),
        )

    with_elevation = [s for s in storeys if s.elevation is not None]
    if not with_elevation:
        return undecidable(
            from_=[s.global_id for s in storeys],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="IfcBuildingStorey.Elevation",
                remedy=(
                    f"Dieser Export enthält {len(storeys)} Geschoß(e), aber keines davon deklariert eine "
                    "Höhenlage. Im CAD die Geschoßhöhen setzen und neu exportieren — aus der Reihenfolge der "
                    "Geschoße allein lässt sich keine Höhe bilden, und eine geschätzte Geschoßhöhe wäre in der "
                    "Antwort nicht mehr als Schätzung erkennbar."
                ),
                elements=[s.global_id for s in storeys],
            ),
        )

    judgements = _judge_storeys(model, storeys)
    counted = [j for j in judgements if j.counted and j.elevation is not None]
    if not counted:
        return undecidable(
            from_=[j.global_id for j in judgements],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="ein Geschoß, das erkennbar zum Aufenthalt von Menschen bestimmt ist",
                remedy=(
                    "Auf keinem Geschoß dieses Exports deutet etwas auf Aufenthalt hin: entweder trägt jedes "
                    "Geschoß einen Namen aus dem Technik-/Dachbereich, oder alle Räume darauf sind Neben- und "
                    "Erschließungsflächen. Abhilfe: Räume als IfcSpace mit sprechendem Namen bzw. LongName "
                    "exportieren und Pset_SpaceCommon setzen. Die Einstufung „zum Aufenthalt bestimmt“ ist "
                    "eine Nutzungsangabe und steht nicht in der Geometrie."
                ),
                elements=[j.global_id for j in judgements],
            ),
        )

    top = max(counted, key=lambda j: (j.elevation, j.global_id))
    ground = _ground_reference(model)
    if ground is None:
        return undecidable(
            from_=[top.global_id],
            method=method,
            provenance="inferred",
            missing=MissingFact(
                what="ein Geländebezug (IfcSite mit Körpergeometrie, sonst eine Geschoßhöhenlage)",
                remedy=(
                    "Weder ein Geländemodell noch eine deklarierte Geschoßhöhenlage noch auswertbare "
                    "Bauteilgeometrie ist vorhanden. Ohne einen unteren Bezugspunkt ist eine Höhe ÜBER etwas "
                    "nicht bildbar. Abhilfe: das Gelände als IfcSite mit Körpergeometrie exportieren."
                ),
            ),
        )

    value = round(float(top.elevation) - ground["z"], 4)
    because, confidence = _fluchtniveau_reasons(judgements, top, ground)

    caveat = [_NO_GEBAEUDEKLASSE, _GROUND_CAVEAT]
    caveat.append(
        f"Gezählt wurden {len(counted)} von {len(judgements)} Geschoß(en); maßgeblich ist "
        f"„{top.name or top.global_id}“ auf {_metres(top.elevation)}. Die vollständige Liste mit Begründung "
        "je Geschoß steht unter „storeys“ — ein Geschoß, das hier falsch eingestuft ist, lässt sich dort "
        "benennen und die Zahl mit einer Subtraktion korrigieren."
    )
    dropped = [j for j in judgements if not j.counted]
    if dropped:
        caveat.append("NICHT gezählt: " + ", ".join(f"„{j.name or j.global_id}“ ({j.warum})" for j in dropped) + ".")
    caveat.append(
        "Gemessen wird auf die deklarierte Geschoßebene (Rohbau-Oberkante), nicht auf den fertigen Fußboden; "
        "ein Fußbodenaufbau darüber hebt das wirkliche Fußbodenniveau um seine Dicke an."
    )

    return inferred(
        {
            "fluchtniveau": value,
            "topOccupiedFloor": {
                "globalId": top.global_id,
                "name": top.name,
                "elevation": top.elevation,
            },
            "groundReference": ground,
            "storeys": [j.to_dict() for j in judgements],
        },
        unit="m",
        from_=[top.global_id, *ground["from"]],
        method=method,
        confidence=confidence,
        because=because,
        caveat=" ".join(caveat),
    )


def _judge_storeys(model: SpatialModel, storeys: Sequence[Any]) -> list[StoreyJudgement]:
    """Every storey, with the occupancy call and the signal that made it.

    The room classification is taken from :func:`classify_rooms` rather than
    re-derived here, for the reason that function itself gives: two independent
    classifiers over one model is a contradiction waiting to be quoted, and this
    module would be the one quoting it.
    """
    rooms = {room.global_id: room for room in classify_rooms(model)}
    per_storey: dict[str, list[Any]] = {}
    for space in model.file.by_type("IfcSpace"):
        storey = model.storey_of(space)
        if storey is not None:
            per_storey.setdefault(storey.GlobalId, []).append(space)

    out: list[StoreyJudgement] = []
    for storey in sorted(storeys, key=lambda s: (s.elevation is None, s.elevation or 0.0, s.global_id)):
        spaces = per_storey.get(storey.global_id, [])
        described = [
            {
                "globalId": space.GlobalId,
                "name": model.label(space),
                "nutzung": rooms[space.GlobalId].kind if space.GlobalId in rooms else None,
            }
            for space in spaces
        ]

        counted, warum = _judge_one_storey(storey, described)

        out.append(
            StoreyJudgement(
                global_id=storey.global_id,
                name=storey.name,
                elevation=storey.elevation,
                counted=counted and storey.elevation is not None,
                warum=(
                    warum
                    if storey.elevation is not None
                    else warum + ", aber dieses Geschoß deklariert keine Höhenlage und kann deshalb nicht "
                    "maßgeblich sein"
                ),
                spaces=described,
            )
        )
    return out


def _judge_one_storey(storey: Any, described: Sequence[dict[str, Any]]) -> tuple[bool, str]:
    """Counted or not, and the German reason — rooms first, storey name last.

    ## The order is the fix, and it is the second time it had to be made

    The room evidence is read FIRST and the storey's own name only breaks a tie.
    Until this ordering the storey name was tested ahead of everything and
    vetoed unconditionally, which is the same mistake the comment below records
    against ROOM names, one level up: a substring is not the positive evidence
    the rule demands, and it was outranking the rooms that are.

    Measured on ``AC20-FZK-Haus.ifc``: the „Dachgeschoss" at elevation 2.70 m
    holds the 107 m² **Galerie** — two windows, a stair up to it, a 2.70 m drop
    into the living room — and was struck out because the German word for an
    attic storey contains „dach". The Fluchtniveau came back **1.00 m** instead
    of **3.70 m**, on the one number the Gebäudeklasse hangs on and in the
    direction the module docstring names as the dangerous one.

    ## Why the name still has a job, and exactly how small a one

    ``Ifc4_SampleHouse.ifc`` has a storey called „Roof" at 2.50 m whose single
    space is also called „Roof" — a bungalow, Fluchtniveau **0.00 m**, and
    counting that level would report 2.50 m for a single-storey house. Nothing
    in the lexicon places a room called „Roof", so the room evidence there is
    silent and only the names are left. So the name decides ONLY where the
    lexicon has no opinion at all, and only while the rooms do not dispute it:
    every room the lexicon could not place must itself fall in the same
    not-occupied vocabulary. „Roof" in a „Roof" corroborates; „Galerie" in a
    „Dachgeschoss" does not, and 107 m² of Galerie is precisely the thing a
    substring must not be allowed to overrule.

    Note what this is NOT: :data:`NOT_OCCUPIED_TERMS` never removes a room the
    lexicon has placed — that veto was taken out once already (see below) and
    stays out. It is read over room names only to corroborate a storey name
    where the lexicon returned nothing, and never to contradict it.

    ``AC20-Institute-Var-2.ifc`` needs none of this: its „Dachgeschoss" at
    9.00 m holds ``Dachboden-1``, ``Dachboden-2`` and a Flur, all three placed
    by the lexicon as Neben-/Erschließungsflächen, so the room branch drops it
    on room evidence alone and the Fluchtniveau stays **9.30 m**. That is the
    proof that the name was never carrying this case.
    """
    # The lexicon's classification is the whole of the positive room signal. The
    # veto that used to sit here ran `NOT_OCCUPIED_TERMS` — a STOREY vocabulary,
    # matched on substrings — over ROOM names, so a „Dachzimmer" or
    # „Attikazimmer" that `classify_rooms` had placed as `aufenthaltsraum` was
    # struck out. With no habitable room left, the branch below then read „Alle
    # Räume … sind Neben- oder Erschließungsflächen" and dropped the storey: on
    # a two-storey house whose upper storey is cleanly named „1. Obergeschoss"
    # and holds one Dachzimmer, the Fluchtniveau came back 0.000 m instead of
    # 3.500 m. That is the direction the module docstring names as the dangerous
    # one, the reason given was untrue, and a substring on a room name is not
    # the positive evidence the rule demands.
    habitable = [entry for entry in described if entry["nutzung"] == "aufenthaltsraum"]
    placed = [entry for entry in described if entry["nutzung"] is not None]
    unplaced = [entry for entry in described if entry["nutzung"] is None]

    if habitable:
        return (
            True,
            f"{len(habitable)} von {len(described)} Raum/Räumen auf diesem Geschoß sind dem Lexikon "
            f"nach Aufenthaltsräume (z. B. „{habitable[0]['name']}“)",
        )
    if described and not unplaced:
        return (
            False,
            f"Alle {len(described)} Räume auf diesem Geschoß sind dem Lexikon nach Neben- oder "
            f"Erschließungsflächen (z. B. „{placed[0]['name']}“) — kein Raum, in dem sich Menschen "
            "dauernd aufhalten",
        )

    # No positive and no negative room signal. Only here does the storey name
    # count, and only while every unplaceable room name agrees with it.
    hit = _matching_term(storey.name)
    corroborating = [(entry, _matching_term(entry["name"])) for entry in unplaced]
    if hit is not None and all(term is not None for _, term in corroborating):
        if not described:
            return (
                False,
                f"Geschoßname „{storey.name}“ enthält „{hit}“ — das deutet auf ein Technik-, Dach- oder "
                "Attikageschoß und damit nicht auf Aufenthalt; ein Raum, der dem widerspräche, ist auf "
                "diesem Geschoß nicht exportiert",
            )
        return (
            False,
            f"Geschoßname „{storey.name}“ enthält „{hit}“ — das deutet auf ein Technik-, Dach- oder "
            f"Attikageschoß und damit nicht auf Aufenthalt; die Raumnamen bestätigen das "
            f"(z. B. „{corroborating[0][0]['name']}“ enthält „{corroborating[0][1]}“) und kein Raum "
            "dieses Geschoßes ist dem Lexikon nach ein Aufenthaltsraum",
        )

    if not described:
        return (
            True,
            "Auf diesem Geschoß ist kein IfcSpace exportiert — über die Nutzung sagt die Datei nichts. "
            "Im Zweifel MITGEZÄHLT: ein zu niedrig gemeldetes Fluchtniveau ist die gefährliche Richtung",
        )
    naming = (
        f"; der Geschoßname enthält zwar „{hit}“, wird aber von den Raumnamen nicht bestätigt"
        if hit is not None
        else ""
    )
    return (
        True,
        f"{len(unplaced)} von {len(described)} Raumnamen passen zu keinem Lexikoneintrag; die Nutzung "
        f"dieses Geschoßes ist damit offen{naming}. Im Zweifel MITGEZÄHLT: ein zu niedrig gemeldetes "
        "Fluchtniveau ist die gefährliche Richtung",
    )


def _ground_reference(model: SpatialModel) -> dict[str, Any] | None:
    """The lower datum, the route it came from, and every route that was available.

    ``candidates`` is not decoration. The three routes disagree by the depth of
    a foundation, and a reviewer who knows the terrain falls 1.8 m to the north
    can only substitute their own number if they can see which one was used.
    """
    candidates: list[dict[str, Any]] = []

    site_low: float | None = None
    site_id: str | None = None
    for site in model.file.by_type("IfcSite"):
        geo = model.geometry(site.GlobalId)
        if geo is None:
            continue
        low = float(geo.box[0][2])
        if site_low is None or low < site_low:
            site_low, site_id = low, site.GlobalId
    if site_low is not None and site_id is not None:
        candidates.append(
            {
                "z": round(site_low, 4),
                "via": "IfcSite-Körpergeometrie, tiefster Punkt des modellierten Geländes",
                "from": [site_id],
            }
        )

    elevations = [s for s in model.storeys if s.elevation is not None]
    if elevations:
        lowest = min(elevations, key=lambda s: (s.elevation, s.global_id))
        candidates.append(
            {
                "z": round(float(lowest.elevation), 4),
                "via": (
                    f"tiefste deklarierte Geschoßebene „{lowest.name or lowest.global_id}“ "
                    "(IfcBuildingStorey.Elevation) — eine FUSSBODENebene, kein Gelände"
                ),
                "from": [lowest.global_id],
            }
        )

    if model.bounds is not None:
        candidates.append(
            {
                "z": round(float(model.bounds[0][2]), 4),
                "via": "tiefster Punkt der Modellgeometrie (Unterkante des untersten Bauteils) — kein Gelände",
                "from": [],
            }
        )

    if not candidates:
        return None

    chosen = dict(candidates[0])
    # `RefElevation` is reported and never used: it is declared relative to SEA
    # LEVEL while every coordinate here is on the project origin, and subtracting
    # one from the other is the tens-of-metres datum error `_storey_datum_drift`
    # was written to catch. A human comparing the two numbers can spot it; an
    # operator that silently mixes them cannot be spotted at all.
    declared_elevations = [
        {
            "refElevation": float(site.RefElevation),
            "globalId": site.GlobalId,
            "via": "IfcSite.RefElevation (Meereshöhe)",
        }
        for site in model.file.by_type("IfcSite")
        if getattr(site, "RefElevation", None) is not None
    ]
    chosen["candidates"] = candidates
    chosen["nichtVerwendet"] = declared_elevations
    return chosen


def _fluchtniveau_reasons(
    judgements: Sequence[StoreyJudgement], top: StoreyJudgement, ground: dict[str, Any]
) -> tuple[list[str], float]:
    """The `because` list and a confidence that moves for stated reasons only."""
    because = [
        f"Oberstes mitgezähltes Geschoß: „{top.name or top.global_id}“ auf {_metres(top.elevation)} ({top.warum}).",
        f"Unterer Bezug: {ground['via']}, {_metres(ground['z'])}.",
        f"{sum(1 for j in judgements if j.counted)} von {len(judgements)} Geschoß(en) als zum Aufenthalt "
        "bestimmt gewertet; die Begründung je Geschoß steht in „storeys“.",
    ]
    confidence = 0.85
    if not ground["via"].startswith("IfcSite"):
        confidence -= 0.15
        because.append(
            "Kein Geländemodell in dieser Datei — der untere Bezug ist eine Bauwerkskante, nicht das "
            "anschließende Gelände."
        )
    uncertain = [j for j in judgements if j.counted and "Im Zweifel" in j.warum]
    if uncertain:
        confidence -= 0.15
        because.append(
            f"{len(uncertain)} Geschoß(e) wurden ohne positives Nutzungssignal mitgezählt — das ist die "
            "vorsichtige Richtung und macht die Zahl eher zu groß als zu klein."
        )
    if top is judgements[-1] and not any(not j.counted for j in judgements):
        because.append("Kein Geschoß musste ausgeschieden werden; das oberste Geschoß ist das maßgebliche.")
    return because, round(max(0.3, confidence), 2)


# ════════════════════════════════════════════════════════════════════════════
# compartment_area — what a Brandabschnitt is measured on
# ════════════════════════════════════════════════════════════════════════════


def compartment_area(model: SpatialModel, storey_or_space_ids: str | Sequence[str]) -> Answer[dict[str, Any]]:
    """The floor area of a group of spaces taken together, in m².

    Takes one id or a list of them, and each may be:

      - an **``IfcZone`` or ``IfcGroup``** — the export's OWN declaration of what
        belongs together. When one is passed the grouping is ``declared``, and
        the answer says so: a declared compartment is the architect's statement
        and outranks anything this library would assemble from a storey.
      - an **``IfcBuildingStorey``** — every space aggregated into or contained
        in it. Convenient and *not* the same thing: a storey is not a
        Brandabschnitt, and the caveat says so every time.
      - an **``IfcSpace``** — itself.

    ## Why the constituents travel with the sum

    A single number is unauditable. Each space comes back with its own area and
    the provenance of that area, so a reviewer who thinks the total is wrong can
    point at the one room that is wrong. It also makes the two ways the sum can
    lie visible:

      - **double counting.** The same space reached twice — passed directly and
        again through its storey — is de-duplicated by GlobalId and the drop is
        reported. This is exact, not heuristic.
      - **overlap.** Two space bodies that overlap in plan at the same height
        are one room modelled twice, and their areas add up to more floor than
        the building has. The overlapping area is measured with shapely and
        reported; it is NOT subtracted, because which of the two rooms is the
        spurious one is not something geometry can decide.

    Spaces at *different* heights are never treated as overlapping: a
    Brandabschnitt over two storeys is measured as the sum of both floors, and
    unioning their footprints in plan would halve it.

    ## No threshold

    OIB Richtlinie 2 names a maximum Brandabschnittsfläche. That number is a
    fact about the clause and appears nowhere here; this returns square metres.
    """
    ids = [storey_or_space_ids] if isinstance(storey_or_space_ids, str) else list(storey_or_space_ids)
    method = f"compartmentArea([{', '.join(ids)}])"
    if not ids:
        return undecidable(
            from_=[],
            method="compartmentArea([])",
            provenance="computed",
            missing=MissingFact(
                what="kein Bezugsobjekt übergeben",
                remedy=(
                    "compartmentArea() braucht mindestens eine GlobalId — eine Zone (IfcZone/IfcGroup), ein "
                    "Geschoß oder einen Raum."
                ),
            ),
        )

    spaces: list[Any] = []
    seen: set[str] = set()
    duplicates: list[dict[str, Any]] = []
    grouping: list[dict[str, Any]] = []

    for global_id in ids:
        subject = op._require(model, global_id, method)
        resolved, via, is_declared = _resolve_group(model, subject)
        if resolved is None:
            op._wrong_kind(
                subject,
                method,
                "compartmentArea",
                "eine Zone (IfcZone/IfcGroup), ein Geschoß (IfcBuildingStorey) oder einen Raum (IfcSpace)",
                "für ein Bauteil: floorArea() misst seine Grundfläche einzeln",
            )
        grouping.append(
            {
                "globalId": global_id,
                "name": model.label(subject),
                "ifcType": subject.is_a(),
                "via": via,
                "deklariert": is_declared,
                "raumzahl": len(resolved),
            }
        )
        for space in resolved:
            if space.GlobalId in seen:
                duplicates.append({"globalId": space.GlobalId, "name": model.label(space), "ueber": global_id})
                continue
            seen.add(space.GlobalId)
            spaces.append(space)

    if not spaces:
        return undecidable(
            from_=list(ids),
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="IfcSpace unterhalb der übergebenen Objekte",
                remedy=(
                    "Keines der übergebenen Objekte führt auf einen Raum. Räume im CAD als IfcSpace "
                    "exportieren und sie dem Geschoß bzw. der Zone zuordnen (IfcRelAggregates, "
                    "IfcRelAssignsToGroup) — eine Brandabschnittsfläche wird auf Räumen gemessen."
                ),
                elements=list(ids),
            ),
        )

    measured: list[dict[str, Any]] = []
    without: list[dict[str, Any]] = []
    total = 0.0
    tolerance = 0.0
    for space in spaces:
        answer = op.floor_area(model, space.GlobalId)
        if not answer.decidable or not isinstance(answer.value, (int, float)):
            without.append(
                {
                    "globalId": space.GlobalId,
                    "name": model.label(space),
                    "warum": answer.missing.what if answer.missing else "floorArea() war nicht entscheidbar",
                    "abhilfe": answer.missing.remedy if answer.missing else None,
                }
            )
            continue
        area = float(answer.value)
        total += area
        tolerance += float(answer.tolerance or abs(area) * op.AREA_RELATIVE_TOLERANCE)
        measured.append(
            {
                "globalId": space.GlobalId,
                "name": model.label(space),
                "ifcType": space.is_a(),
                "area": round(area, 4),
                "provenance": answer.provenance,
                "agreement": answer.agreement,
            }
        )

    if not measured:
        return undecidable(
            from_=[s.GlobalId for s in spaces],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="für keinen der Räume ist eine Grundfläche bestimmbar",
                remedy=(
                    "Kein Raum dieser Gruppe trägt eine auswertbare Körpergeometrie oder eine deklarierte "
                    "Fläche. Abhilfe im CAD: die Räume mit Körpergeometrie neu exportieren (Body-"
                    "Repräsentation, kein reiner Bounding-Box-Export) oder die Raumflächen als Mengen "
                    "mitexportieren (Qto_SpaceBaseQuantities.NetFloorArea). floorArea() nennt je Raum, was "
                    "genau fehlt. Ohne Flächen ist keine Brandabschnittsfläche bildbar."
                ),
                elements=[s.GlobalId for s in spaces],
            ),
        )

    overlaps = _plan_overlaps(model, spaces)
    caveat = _compartment_caveat(model, grouping, measured, without, duplicates, overlaps)

    value = {
        "area": round(total, 4),
        "spaceCount": len(measured),
        "spaces": measured,
        "grouping": grouping,
        "ohneFlaeche": without,
        "doppelt": duplicates,
        "ueberschneidungen": overlaps,
        "deklarierteZonen": _declared_zones(model),
    }
    # `computed`, always, even when the GROUPING is the architect's own IfcZone:
    # the envelope carries one provenance and the number is the sum of measured
    # areas. That the grouping was declared is stated in `grouping[].deklariert`
    # and in the caveat, where it can be read as what it is — a statement about
    # which rooms belong together, not about how large they are.
    return computed(
        value,
        unit="m²",
        tolerance=round(tolerance, 6),
        from_=[entry["globalId"] for entry in measured],
        method=method,
        caveat=caveat,
    )


def _resolve_group(model: SpatialModel, subject: Any) -> tuple[list[Any] | None, str, bool]:
    """The spaces behind one id, how they were reached, and whether that is declared."""
    kind = model.kind_of(subject)
    if kind == "space":
        return [subject], "Raum unmittelbar übergeben", True
    if subject.is_a("IfcGroup"):
        # `IfcZone` is a subtype of `IfcGroup`, so both arrive here. Only the
        # spaces are taken: a zone may legitimately group other zones and
        # elements, and an IfcWall inside a zone is not floor area.
        members = [
            member
            for rel in (getattr(subject, "IsGroupedBy", []) or [])
            for member in (rel.RelatedObjects or [])
            if member.is_a("IfcSpace")
        ]
        return members, f"deklarierte Gruppe {subject.is_a()} → IfcRelAssignsToGroup", True
    if kind == "storey":
        spaces = [space for space in model.file.by_type("IfcSpace") if _storey_id(model, space) == subject.GlobalId]
        return spaces, "alle Räume dieses Geschoßes (IfcRelAggregates / IfcRelContainedInSpatialStructure)", True
    # A building or a site is deliberately NOT accepted. "Alle Räume des
    # Gebäudes" is a plausible-looking call that produces the Brutto-Grundfläche
    # of the whole house under the name of a Brandabschnitt, and the answer would
    # carry no sign of the substitution. The caller has to name the storeys or
    # the zone it means.
    return None, "", False


def _storey_id(model: SpatialModel, space: Any) -> str | None:
    storey = model.storey_of(space)
    return None if storey is None else storey.GlobalId


def _plan_overlaps(model: SpatialModel, spaces: Sequence[Any]) -> list[dict[str, Any]]:
    """Pairs of spaces that occupy the same plan area at the same height.

    Only pairs whose Z ranges actually overlap are tested. Two rooms stacked on
    different storeys share their whole footprint in plan and are not double
    counting — a Brandabschnitt spanning two floors is the sum of both — so a
    plan-only union would silently halve exactly the compartment this operator
    is asked about most.
    """
    import shapely
    import shapely.ops

    footprints: list[tuple[Any, Any, tuple[float, float]]] = []
    for space in spaces:
        geo = model.geometry(space.GlobalId)
        if geo is None or geo.triangles is None or len(geo.triangles) == 0:
            continue
        polygons = []
        for triangle in geo.triangles:
            polygon = shapely.Polygon(triangle[:, :2])
            if polygon.is_valid and polygon.area > 0:
                polygons.append(polygon)
        if not polygons:
            continue
        try:
            merged = shapely.ops.unary_union(polygons)
        except Exception:
            continue
        footprints.append((space, merged, (float(geo.box[0][2]), float(geo.box[1][2]))))

    out: list[dict[str, Any]] = []
    for index, (space, shape, span) in enumerate(footprints):
        for other, other_shape, other_span in footprints[index + 1 :]:
            if min(span[1], other_span[1]) - max(span[0], other_span[0]) <= op.COORDINATE_TOLERANCE:
                continue
            try:
                area = float(shape.intersection(other_shape).area)
            except Exception:
                continue
            if area > MIN_OVERLAP_AREA:
                out.append(
                    {
                        "a": {"globalId": space.GlobalId, "name": model.label(space)},
                        "b": {"globalId": other.GlobalId, "name": model.label(other)},
                        "area": round(area, 4),
                    }
                )
    return out


def _declared_zones(model: SpatialModel) -> list[dict[str, Any]]:
    """Every zone or group this file declares over spaces, with its members.

    Reported on every answer, even when the caller asked about a storey. If the
    export states its own compartments, that statement is worth more than a
    storey-shaped guess and the caller should be told it exists.
    """
    out: list[dict[str, Any]] = []
    for ifc_type in ("IfcZone", "IfcGroup"):
        try:
            groups = model.file.by_type(ifc_type)
        except RuntimeError:
            continue
        for group in groups:
            if ifc_type == "IfcGroup" and group.is_a("IfcZone"):
                continue  # already listed under its own type
            members = [
                member
                for rel in (getattr(group, "IsGroupedBy", []) or [])
                for member in (rel.RelatedObjects or [])
                if member.is_a("IfcSpace")
            ]
            if not members:
                continue
            out.append(
                {
                    "globalId": group.GlobalId,
                    "name": model.label(group),
                    "ifcType": group.is_a(),
                    "spaces": [m.GlobalId for m in members],
                }
            )
    return out


def _compartment_caveat(
    model: SpatialModel,
    grouping: Sequence[dict[str, Any]],
    measured: Sequence[dict[str, Any]],
    without: Sequence[dict[str, Any]],
    duplicates: Sequence[dict[str, Any]],
    overlaps: Sequence[dict[str, Any]],
) -> str:
    parts = [
        "Summe der Einzelgrundflächen der genannten Räume. Nichts aus dem Regelwerk angewandt: die "
        "größtmögliche Brandabschnittsfläche steht in der Bestimmung, nicht im Modell, und wird hier mit "
        "nichts verglichen."
    ]
    if any(entry["ifcType"] == "IfcBuildingStorey" for entry in grouping):
        parts.append(
            "Mindestens eine der übergebenen Gruppen ist ein GESCHOSS. Ein Geschoß ist kein Brandabschnitt — "
            "ein Geschoß kann mehrere Brandabschnitte enthalten und ein Brandabschnitt mehrere Geschoße "
            "umfassen. Die Zahl ist die Geschoßfläche, solange nichts anderes deklariert ist."
        )
    if any(entry["deklariert"] and entry["ifcType"] in ("IfcZone", "IfcGroup") for entry in grouping):
        parts.append(
            "Die Zusammenstellung stammt aus einer im Export DEKLARIERTEN Gruppe (IfcZone/IfcGroup) — das ist "
            "die Aussage des Verfassers darüber, was zusammengehört, und wurde deshalb einer eigenen "
            "Zusammenstellung vorgezogen."
        )
    zones = _declared_zones(model)
    if zones and not any(entry["ifcType"] in ("IfcZone", "IfcGroup") for entry in grouping):
        parts.append(
            f"Dieser Export deklariert selbst {len(zones)} Zone(n)/Gruppe(n) über Räume ("
            + ", ".join(f"„{z['name'] or z['globalId']}“" for z in zones[:3])
            + "). Diese Zusammenstellung ist die Aussage des Verfassers; compartmentArea() mit deren GlobalId "
            "aufrufen misst genau sie."
        )
    if duplicates:
        parts.append(
            f"{len(duplicates)} Raum/Räume wurden über mehr als einen Weg erreicht und nur EINMAL gezählt; "
            "sie stehen unter „doppelt“. Ohne diese Entdopplung wäre die Fläche um deren Größe zu groß."
        )
    if overlaps:
        overlapping = round(sum(entry["area"] for entry in overlaps), 3)
        parts.append(
            f"{len(overlaps)} Raumpaar(e) überlappen sich auf derselben Höhe im Grundriss um zusammen "
            f"{overlapping} m². Das ist ein Befund über den Export — ein Raum ist vermutlich doppelt "
            "modelliert. Die Fläche wurde NICHT bereinigt, weil die Datei nicht sagt, welcher der beiden "
            "Räume der überzählige ist; die Summe ist insoweit zu groß."
        )
    if without:
        parts.append(
            f"{len(without)} Raum/Räume ohne bestimmbare Fläche sind NICHT enthalten — die Summe ist "
            "insofern eine Untergrenze. Was je Raum fehlt, steht unter „ohneFlaeche“."
        )
    if any(entry["agreement"] == "disagree" for entry in measured):
        parts.append(
            "Bei mindestens einem Raum widersprechen sich deklarierte und gemessene Fläche; floorArea() "
            "nennt für diesen Raum beide Zahlen."
        )
    parts.append(
        "Gemessen ist die Netto-Grundfläche der Raumkörper. Ob die Bestimmung die Brutto-Grundfläche meint — "
        "also einschließlich der umschließenden Wände — entscheidet die Bestimmung; der Unterschied liegt bei "
        "einem üblichen Grundriss im Bereich von 10–15 %."
    )
    return " ".join(parts)


# ════════════════════════════════════════════════════════════════════════════
# separating_elements — the wall, the slab, and the door that is the weak point
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class SeparatingElement:
    """One element between two spaces, with what the file declares about it."""

    global_id: str
    name: str | None
    ifc_type: str
    #: ``trennend`` — it lies between the two rooms; ``gemeinsam`` — it bounds
    #: both but does not separate them (a facade running past both).
    rolle: str
    #: German, naming the test that decided ``rolle``.
    warum: str
    #: Exactly as declared, or ``None``. ``None`` is a finding about the export,
    #: and a property carrying an empty string is one of those — see
    #: :func:`_fire_rating`.
    fire_rating: str | None
    #: ``Pset_*Common.Compartmentation`` — the architect saying this element is
    #: meant to compartmentalise. Rarely present, decisive when it is.
    compartmentation: bool | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "ifcType": self.ifc_type,
            "rolle": self.rolle,
            "warum": self.warum,
            "fireRating": self.fire_rating,
            "fireRatingDeklariert": self.fire_rating is not None,
            "compartmentation": self.compartmentation,
        }


def separating_elements(model: SpatialModel, space_a: str, space_b: str) -> Answer[dict[str, Any]]:
    """The elements between two spaces — the wall, the slab, and the door in it.

    :func:`~ifc_spatial.operators.bounds` gives each space's boundary; this is
    their INTERSECTION, plus the two things an intersection alone gets wrong.

    ## A shared bounding element is not necessarily a separating one

    A continuous south facade bounds every room along it and separates none of
    them. So each shared element is classified rather than reported flat, by two
    independent geometric tests, and an element passing **either** is
    ``trennend``:

    1. **Achsentest** — the two room bodies are disjoint along one axis, and the
       element lies inside that gap (within :data:`SEPARATION_SLACK`) while
       overlapping both rooms on the other two. This is what catches the
       partition and misses the facade.
    2. **Sichtlinie** — the straight segment between the two room centroids
       passes through the element's body. This catches the floor slab between a
       room and the room above it, where the gap is zero-width and the slab's
       body reaches into the space solid.

    Either test alone loses a real fire wall on ordinary geometry, and losing
    one is the dangerous direction, so the union is taken and every element says
    which test found it. Elements that pass neither are still reported, under
    ``gemeinsam`` with their reason — nothing is dropped silently.

    When the spaces carry no body at all (a topology-only export), no test can
    run: the shared bounding elements are reported as ``trennend`` with
    ``warum`` saying betweenness was **not** checked. Excluding an element on no
    evidence would be worse.

    ## The openings, because the door is the weak point

    For every separating element the opening chain is walked
    (:func:`~ifc_spatial.operators.hosts` → ``filler_of``) and each filler comes
    back under ``oeffnungen`` with its OWN declared ``FireRating``. A REI 90
    wall with an undeclared door in it is a finding, and it is invisible if only
    the wall is reported.

    ## FireRating, and the sentence that is worth more than a number

    Every element carries ``Pset_*Common.FireRating`` exactly as declared, and
    ``None`` when no pset carries it — searched across all psets and inherited
    from the type, because the SET the property lands in is not standardised.
    ``Ifc4_SampleHouse.ifc`` declares it on **none** of its 75 products, which
    is the most common finding in Austrian exports and the reason the caveat
    says so in full rather than leaving an empty field to be read as "kein
    Feuerwiderstand".

    A property present but EMPTY is not a declaration either, and is reported as
    if it were absent — see :func:`_fire_rating`. ``AC20-FZK-Haus.ifc`` carries
    ``FireRating = ''`` on four ArchiCAD placeholders and nothing else; reading
    those as declarations turned a finding about the export into a finding about
    the design.

    No verdict: whether REI 90 is sufficient is a question about the
    Bestimmung, and the Bestimmung answers it.
    """
    method = f"separatingElements({space_a}, {space_b})"
    first = op._require(model, space_a, method)
    second = op._require(model, space_b, method)

    for subject in (first, second):
        if model.kind_of(subject) != "space":
            op._wrong_kind(
                subject,
                method,
                "separatingElements",
                "zwei Räume (IfcSpace)",
                "für ein Bauteil: enclosedBy() liefert die Räume, die es begrenzt",
            )
    if space_a == space_b:
        return undecidable(
            from_=[space_a],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="zweimal derselbe Raum übergeben",
                remedy=(
                    "separatingElements() braucht zwei verschiedene Räume. Für die begrenzenden Bauteile eines "
                    "einzelnen Raums: bounds()."
                ),
                elements=[space_a],
            ),
        )

    bounds_a = op.bounds(model, space_a)
    bounds_b = op.bounds(model, space_b)
    for answer in (bounds_a, bounds_b):
        if not answer.decidable or answer.value is None:
            return answer  # type: ignore[return-value]

    by_id = {ref.global_id: ref for ref in bounds_a.value}
    shared = [by_id[ref.global_id] for ref in bounds_b.value if ref.global_id in by_id]

    geo_a = model.geometry(space_a)
    geo_b = model.geometry(space_b)
    testable = geo_a is not None and geo_b is not None
    axis = _separating_axis(geo_a, geo_b) if testable else None

    walls: list[SeparatingElement] = []
    alongside: list[SeparatingElement] = []
    openings: list[dict[str, Any]] = []
    seen_openings: set[str] = set()
    #: Fenestration the BOUNDARIES named directly, held back until the void
    #: chains have been walked. Order matters: the chain knows which wall the
    #: door sits in and a 2nd-level boundary does not, so processing the chain
    #: first is what puts a host in `inBauteil` instead of a null.
    from_boundaries: list[Any] = []

    for ref in sorted(shared, key=lambda r: r.global_id):
        element = model.file.by_guid(ref.global_id)
        rating = _fire_rating(model, element)
        compartmentation = model.declared_property(element, ("Compartmentation",))
        rolle, warum = _classify(model, element, geo_a, geo_b, axis, testable)
        entry = SeparatingElement(
            global_id=ref.global_id,
            name=ref.name,
            ifc_type=ref.ifc_type,
            rolle=rolle,
            warum=warum,
            fire_rating=rating,
            compartmentation=compartmentation if isinstance(compartmentation, bool) else None,
        )
        if element.is_a() in op.FENESTRATION and rolle == "trennend":
            # A door found through the boundaries is an OPENING in this answer,
            # never a separating element in its own right: listing it in both
            # places would let a reader count one door as two barriers. A
            # fenestration element that is only `gemeinsam` still goes to
            # `alongside` below — nothing leaves this loop unreported.
            from_boundaries.append(element)
            continue
        (walls if rolle == "trennend" else alongside).append(entry)

    for entry in walls:
        for opening in _openings_in(model, entry.global_id):
            if opening["globalId"] in seen_openings:
                continue
            seen_openings.add(opening["globalId"])
            openings.append(opening)

    for element in from_boundaries:
        if element.GlobalId in seen_openings:
            continue
        seen_openings.add(element.GlobalId)
        openings.append(_opening_entry(model, element, host=None, via="als Raumgrenze deklariert"))

    missing_rating = [e.global_id for e in walls if e.fire_rating is None]
    missing_rating += [o["globalId"] for o in openings if o["fireRating"] is None]

    caveat = _separating_caveat(model, walls, alongside, openings, missing_rating, testable, axis, bounds_a, bounds_b)
    value = {
        "spaceA": model.ref(first).to_dict(),
        "spaceB": model.ref(second).to_dict(),
        "trennend": [entry.to_dict() for entry in walls],
        "gemeinsam": [entry.to_dict() for entry in alongside],
        "oeffnungen": openings,
        "ohneFeuerwiderstand": missing_rating,
    }
    from_ = [space_a, space_b, *[entry.global_id for entry in walls], *[o["globalId"] for o in openings]]
    if bounds_a.provenance == "declared" and bounds_b.provenance == "declared":
        return declared(value, from_=from_, method=method, caveat=caveat)
    return computed(value, from_=from_, method=method, caveat=caveat)


def _separating_axis(geo_a: Any, geo_b: Any) -> tuple[int, float, float] | None:
    """The one axis the two bodies are disjoint on, and the gap between them.

    ``None`` when they overlap on every axis (interpenetrating rooms — a finding
    in itself) or on more than one (diagonal neighbours, which share a corner
    and no separating element).
    """
    a_low, a_high = geo_a.box
    b_low, b_high = geo_b.box
    gaps: list[tuple[int, float, float]] = []
    for i in range(3):
        if float(a_high[i]) <= float(b_low[i]):
            gaps.append((i, float(a_high[i]), float(b_low[i])))
        elif float(b_high[i]) <= float(a_low[i]):
            gaps.append((i, float(b_high[i]), float(a_low[i])))
    if len(gaps) != 1:
        return None
    return gaps[0]


def _classify(
    model: SpatialModel,
    element: Any,
    geo_a: Any,
    geo_b: Any,
    axis: tuple[int, float, float] | None,
    testable: bool,
) -> tuple[str, str]:
    """``trennend`` or ``gemeinsam``, and the German reason."""
    if not testable:
        return (
            "trennend",
            "gemeinsames begrenzendes Bauteil beider Räume. Ob es ZWISCHEN ihnen liegt, ist hier nicht "
            "geprüft: mindestens einer der beiden Räume trägt in dieser Datei keinen Körper",
        )
    geo = model.geometry(element.GlobalId)
    if geo is None:
        return (
            "trennend",
            "gemeinsames begrenzendes Bauteil beider Räume; dieses Bauteil trägt keinen auswertbaren Körper, "
            "die Lage zwischen den Räumen ist deshalb nicht geprüft",
        )

    if axis is not None and _in_gap(geo, geo_a, geo_b, axis):
        names = ("x", "y", "z")
        return (
            "trennend",
            f"Achsentest: die beiden Raumkörper sind in {names[axis[0]]} getrennt, und dieses Bauteil liegt in "
            f"der Lücke zwischen ihnen ({axis[1]:.3f} m bis {axis[2]:.3f} m, Toleranz "
            f"{SEPARATION_SLACK:.2f} m)",
        )
    if _segment_hits_box(geo_a.centroid, geo_b.centroid, geo.box):
        return (
            "trennend",
            "Sichtlinie: die gerade Verbindung zwischen den beiden Raumschwerpunkten führt durch dieses Bauteil",
        )
    if axis is None:
        return (
            "gemeinsam",
            "begrenzt beide Räume. Die beiden Raumkörper sind auf keiner einzelnen Achse voneinander "
            "getrennt (sie durchdringen einander oder liegen über Eck), und die Sichtlinie führt nicht durch "
            "dieses Bauteil",
        )
    return (
        "gemeinsam",
        "begrenzt beide Räume, liegt aber nicht zwischen ihnen — das Bauteil läuft an beiden Räumen entlang "
        "(eine durchlaufende Fassade begrenzt jeden Raum an ihr und trennt keinen davon)",
    )


def _in_gap(geo: Any, geo_a: Any, geo_b: Any, axis: tuple[int, float, float]) -> bool:
    """Does this body sit in the gap between the two rooms, and span both?"""
    index, low, high = axis
    e_low, e_high = geo.box
    if float(e_low[index]) < low - SEPARATION_SLACK or float(e_high[index]) > high + SEPARATION_SLACK:
        return False
    for other in range(3):
        if other == index:
            continue
        for room in (geo_a, geo_b):
            overlap = min(float(e_high[other]), float(room.box[1][other])) - max(
                float(e_low[other]), float(room.box[0][other])
            )
            if overlap <= op.COORDINATE_TOLERANCE:
                return False
    return True


def _segment_hits_box(start: np.ndarray, end: np.ndarray, box: tuple[np.ndarray, np.ndarray]) -> bool:
    """Slab method: does the segment ``start → end`` cross this axis-aligned box?

    The 3D form of the test a plan drawing does by eye. Written out rather than
    delegated to ``tree.select_ray`` because the ray would report the FIRST hit
    only — and the question here is asked once per candidate element, not once
    per pair.
    """
    direction = np.asarray(end, dtype=float) - np.asarray(start, dtype=float)
    low, high = np.asarray(box[0], dtype=float), np.asarray(box[1], dtype=float)
    t_enter, t_exit = 0.0, 1.0
    for i in range(3):
        if abs(direction[i]) < 1e-12:
            if start[i] < low[i] - op.COORDINATE_TOLERANCE or start[i] > high[i] + op.COORDINATE_TOLERANCE:
                return False
            continue
        first = (low[i] - float(start[i])) / float(direction[i])
        second = (high[i] - float(start[i])) / float(direction[i])
        if first > second:
            first, second = second, first
        t_enter = max(t_enter, first)
        t_exit = min(t_exit, second)
        if t_enter > t_exit:
            return False
    return True


def _openings_in(model: SpatialModel, global_id: str) -> list[dict[str, Any]]:
    """The windows and doors sitting in this element, each with its own FireRating."""
    hosted = op.hosts(model, global_id)
    if not hosted.decidable or not hosted.value:
        return []
    out: list[dict[str, Any]] = []
    for opening_ref in hosted.value:
        fillers = op.filler_of(model, opening_ref.global_id)
        if not fillers.decidable or not fillers.value:
            out.append(
                {
                    "globalId": opening_ref.global_id,
                    "name": opening_ref.name,
                    "ifcType": opening_ref.ifc_type,
                    "inBauteil": global_id,
                    "via": "IfcRelVoidsElement — Öffnung ohne Füllung",
                    "fireRating": None,
                    "fireRatingDeklariert": False,
                }
            )
            continue
        for ref in fillers.value:
            element = model.file.by_guid(ref.global_id)
            out.append(_opening_entry(model, element, host=global_id, via="IfcRelVoidsElement + IfcRelFillsElement"))
    return out


def _opening_entry(model: SpatialModel, element: Any, host: str | None, via: str) -> dict[str, Any]:
    rating = _fire_rating(model, element)
    return {
        "globalId": element.GlobalId,
        "name": model.label(element),
        "ifcType": element.is_a(),
        "inBauteil": host,
        "via": via,
        "fireRating": rating,
        "fireRatingDeklariert": rating is not None,
    }


def _separating_caveat(
    model: SpatialModel,
    walls: Sequence[SeparatingElement],
    alongside: Sequence[SeparatingElement],
    openings: Sequence[dict[str, Any]],
    missing_rating: Sequence[str],
    testable: bool,
    axis: tuple[int, float, float] | None,
    bounds_a: Answer[Any],
    bounds_b: Answer[Any],
) -> str:
    parts: list[str] = []
    if not walls and not openings:
        parts.append(
            "Zwischen diesen beiden Räumen liegt in diesem Export KEIN gemeinsames Bauteil. Das heißt "
            "zunächst, dass die beiden Räume hier nicht aneinandergrenzen — es kann aber auch heißen, dass "
            "die Raumgrenzen unvollständig exportiert sind. adjacentSpaces() zeigt, welche Räume dieser "
            "Export als benachbart führt."
        )
    if not testable:
        parts.append(
            "Mindestens einer der beiden Räume trägt in dieser Datei keinen Körper. Es wurde deshalb NICHT "
            "geprüft, ob die gemeinsamen Bauteile wirklich zwischen den Räumen liegen — die Liste ist die "
            "Schnittmenge der begrenzenden Bauteile und kann durchlaufende Bauteile enthalten, die beide "
            "Räume begrenzen, ohne sie zu trennen."
        )
    else:
        parts.append(
            "Trennend heißt: das Bauteil liegt in der Lücke zwischen den beiden Raumkörpern (Achsentest, "
            f"Toleranz {SEPARATION_SLACK:.2f} m) ODER die gerade Verbindung der beiden Raumschwerpunkte führt "
            "hindurch (Sichtlinie). Beide Tests arbeiten mit achsparallelen Hüllboxen; ein schräg stehendes "
            "Trennbauteil kann dabei unter „gemeinsam“ landen, obwohl es trennt. Nichts wird verworfen — die "
            "Begründung steht je Bauteil."
        )
        if axis is None:
            parts.append(
                "Die beiden Raumkörper sind auf keiner einzelnen Achse voneinander getrennt: sie "
                "durchdringen einander, stoßen über Eck aneinander oder einer liegt im anderen. Der "
                "Achsentest ist damit ausgefallen, geprüft wurde allein über die Sichtlinie."
            )
    if alongside:
        parts.append(
            f"{len(alongside)} Bauteil(e) begrenzen beide Räume, ohne zwischen ihnen zu liegen; sie stehen "
            "unter „gemeinsam“ mit Begründung."
        )
    if openings:
        parts.append(
            f"{len(openings)} Öffnung(en) in den trennenden Bauteilen sind mitgeführt: eine Tür in einer "
            "Brandwand ist die schwache Stelle des Abschlusses und wird getrennt vom Bauteil ausgewiesen."
        )
    else:
        parts.append(
            "In den trennenden Bauteilen ist keine Öffnung hinterlegt. Das heißt NICHT zwingend, dass keine "
            "Tür darin sitzt: viele Exporte schreiben die Rohbauöffnung nicht mit (IfcRelVoidsElement / "
            "IfcRelFillsElement fehlen) und tragen den Ausschnitt bereits im Wandkörper."
        )

    declared_anywhere, blanks = _fire_rating_scan(model)
    if missing_rating and not declared_anywhere:
        parts.append(
            "In dieser Datei ist NIRGENDS ein Feuerwiderstand deklariert — kein einziges Bauteil trägt "
            "Pset_*Common.FireRating. Das ist ein Befund über den EXPORT und keine Aussage über das Gebäude: "
            "die Wände haben einen Feuerwiderstand, dieser Export nennt ihn nur nicht. Abhilfe: im CAD den "
            "Feuerwiderstand am Bauteil bzw. am Bauteiltyp setzen (Pset_WallCommon.FireRating, "
            "Pset_DoorCommon.FireRating, Pset_SlabCommon.FireRating) und mitexportieren."
        )
        if blanks:
            # Named separately because the file LOOKS like it declares something.
            # In `AC20-FZK-Haus.ifc` four ArchiCAD placeholders carry FireRating
            # as the empty string; counting those as declarations sent the whole
            # answer down the „Lücke in genau diesen Bauteilen" branch below and
            # blamed the architect for a defect that is the export's.
            parts.append(
                f"{blanks} Bauteil(e) führen das Merkmal FireRating zwar mit, aber LEER — ein Platzhalter, "
                "wie ihn manche CAD-Vorlagen mitexportieren. Ein leerer Wert ist keine Deklaration und wird "
                "hier wie ein fehlender behandelt; im CAD ist an diesen Bauteilen ein Wert einzutragen."
            )
    elif missing_rating:
        parts.append(
            f"{len(missing_rating)} der genannten Bauteile tragen keinen deklarierten Feuerwiderstand, obwohl "
            "die Datei ihn andernorts deklariert — das ist eine Lücke in genau diesen Bauteilen und steht "
            "unter „ohneFeuerwiderstand“. Fehlend heißt fehlend, nicht null."
        )
    parts.append(
        "Der Feuerwiderstand ist wörtlich übernommen, wie die Datei ihn schreibt. Ob die angegebene Klasse "
        "für diesen Abschluss ausreicht, entscheidet die Bestimmung — hier wird nichts geprüft und nichts "
        "verglichen."
    )
    for answer in (bounds_a, bounds_b):
        if answer.provenance == "computed" and answer.caveat:
            parts.append(f"Raumbegrenzung: {answer.caveat}")
            break
    return " ".join(parts)


def _fire_rating(model: SpatialModel, element: Any) -> str | None:
    """The declared ``FireRating`` of one element, or ``None`` — blank is ``None``.

    The single place this property is turned into an answer, because the empty
    string has to mean the same thing at every one of them.

    ``AC20-FZK-Haus.ifc`` carries ``FireRating = ''`` on four ArchiCAD
    placeholder properties (two ``IfcDoor``, two ``IfcWindow``) and declares a
    fire resistance nowhere else. ``''`` is not ``None``, so every reader of the
    raw property counted those four as declarations:
    :func:`_declares_fire_rating` answered ``True`` and
    :func:`_separating_caveat` therefore told the reader the gap was „eine Lücke
    in genau diesen Bauteilen" — a finding about the DESIGN, addressed to the
    architect — where the truth is a finding about the EXPORT, addressed to
    whoever runs the CAD, with a different remedy attached. ``_opening_entry``
    published ``{'fireRating': '', 'fireRatingDeklariert': True}``: a declared
    class that is blank.

    Whitespace counts as blank for the same reason: ``' '`` is what a cleared
    field leaves behind, and it is not a fire resistance class either.
    """
    value = model.declared_property(element, ("FireRating",))
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _fire_rating_scan(model: SpatialModel) -> tuple[bool, int]:
    """``(does any product declare a FireRating, how many declare it BLANK)``.

    The difference between "this wall has no fire rating" and "this export has
    no fire ratings at all" is the difference between a finding about a building
    and a finding about a file, and only the second one is true here. The blank
    count is carried alongside because a file with four empty placeholders looks
    from the outside like the first case and is the second.

    Memoised on the ``SpatialModel`` and not in a module-level table, for the
    reason :mod:`~ifc_spatial.circulation` gives for its own memo: one model
    instance is one content hash, so a memo that lives and dies with it cannot
    serve an answer derived from different bytes. The scan reads every product's
    psets once — 75 products on the sample house — and
    :func:`separating_elements` may be called once per room pair.
    """
    cached = getattr(model, _FIRE_RATING_MEMO, None)
    if isinstance(cached, tuple):
        return cached
    declared_anywhere = False
    blanks = 0
    for element in model.file.by_type("IfcProduct"):
        raw = model.declared_property(element, ("FireRating",))
        if raw is None:
            continue
        if str(raw).strip():
            declared_anywhere = True
        else:
            blanks += 1
    result = (declared_anywhere, blanks)
    setattr(model, _FIRE_RATING_MEMO, result)
    return result


def _declares_fire_rating(model: SpatialModel) -> bool:
    """Does ANY product in this file declare a NON-BLANK FireRating?"""
    return _fire_rating_scan(model)[0]


# ════════════════════════════════════════════════════════════════════════════
# distance_to_site_boundary — the one that usually has to refuse
# ════════════════════════════════════════════════════════════════════════════


def distance_to_site_boundary(model: SpatialModel, global_id: str | None = None) -> Answer[dict[str, Any]]:
    """Horizontal distance from the building — or from one element — to the site boundary, in metres.

    The geometric input to Brandübertragung auf Nachbargrundstücke, and the
    operator in this module most likely to return nothing.

    ## Why there is no bounding-box fallback, deliberately

    Every ``IfcSite`` has a placement and most have a bounding box implied by
    whatever geometry hangs beneath them. It would take four lines to take the
    site's extent and report the distance from the building to its edge, and the
    number would be **fiction**: the site's extent in an architectural export is
    the extent of the *modelled* content — the terrain patch someone drew, or
    the building itself — and it has no relationship to the Grundstücksgrenze in
    the Katasterplan. A wrong Abstand zur Grundstücksgrenze is not a rounding
    error; it is the input to whether a facade may have openings at all, and it
    would arrive wearing a unit, a tolerance and ``provenance = computed`` like
    every honest number in this library.

    So: a boundary is measured only against a boundary that is actually in the
    file, and otherwise the answer is ``undecidable`` with a remedy naming what
    to export. **Measured on this repository's fixtures: none of the five
    carries one.** All five have ``IfcSite.Representation = None`` and not one
    ``IfcAnnotation`` between them. The sample house is even georeferenced
    (``RefLatitude`` 51° 30′) and still has no boundary — georeferencing places
    a model on the earth, it does not draw the plot.

    ## What counts as a boundary when it is there

    In order: a curve in the ``IfcSite``'s own representation (``FootPrint`` is
    where exporters put it), then an ``IfcAnnotation`` whose name matches
    :data:`BOUNDARY_TERMS`. Polylines and indexed poly-curves are read straight
    off the entity and transformed by their placement, rather than through the
    tessellator: a 2D ``FootPrint`` curve is not a body, and asking a solid
    kernel for one produces nothing at all.

    ## What is measured

    The shortest **horizontal** distance from the subject's body to the boundary
    polygon, over every vertex. With no ``global_id`` the subject is every
    physical element in the model — spaces and openings are air and are skipped
    — and the answer names the element that comes closest, because "das Gebäude
    steht 3,00 m von der Grenze" is only usable if you can see which corner of
    it that is.

    No verdict: how close is permissible depends on the Bestimmung, the
    Bebauungsplan and the neighbour's building, none of which is in this file.
    """
    method = "distanceToSiteBoundary(model)" if global_id is None else f"distanceToSiteBoundary({global_id})"
    subject = None if global_id is None else op._require(model, global_id, method)

    boundary = _site_boundary(model)
    if boundary is None:
        return undecidable(
            from_=[] if global_id is None else [global_id],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="Grundstücksgrenze — keine Geometrie am IfcSite und keine IfcAnnotation dafür",
                remedy=(
                    "Dieser Export enthält die Grundstücksgrenze nicht. Ein IfcSite ist zwar vorhanden, trägt "
                    "aber keine Repräsentation, und es gibt keine Annotation, die eine Grenze beschreibt. "
                    "Abhilfe im CAD: die Grundstücksgrenze aus dem Kataster- bzw. Vermessungsplan als "
                    "geschlossenen Linienzug am IfcSite mitexportieren (Repräsentation „FootPrint“) oder als "
                    "IfcAnnotation mit sprechendem Namen („Grundstücksgrenze“). Eine Georeferenzierung "
                    "(RefLatitude/RefLongitude, IfcMapConversion) genügt dafür NICHT — sie verortet das "
                    "Modell auf der Erde, sie zeichnet die Parzelle nicht. Ein Abstand aus der Hüllbox des "
                    "Geländes wird hier bewusst NICHT gebildet: er sähe wie eine Messung aus und wäre eine "
                    "Erfindung."
                ),
                elements=None if global_id is None else [global_id],
            ),
        )

    subjects: list[Any]
    if subject is not None:
        subjects = [subject]
    else:
        subjects = [
            element
            for element in model.file.by_type("IfcProduct")
            if element.is_a() not in AIR_TYPES
            and model.kind_of(element) == "element"
            and getattr(element, "GlobalId", None)
        ]
    if not subjects:
        return undecidable(
            from_=[],
            method=method,
            provenance="computed",
            missing=MissingFact(
                what="kein Bauteil mit Körpergeometrie",
                remedy=(
                    "Dieses Modell enthält kein physisches Bauteil, dessen Abstand zur Grenze gemessen werden "
                    "könnte. Das Modell mit Körpergeometrie exportieren."
                ),
            ),
        )

    measured: list[dict[str, Any]] = []
    for element in subjects:
        geo = model.geometry(element.GlobalId)
        if geo is None:
            continue
        distance, on_element, on_boundary = _distance_to_polygon(geo.verts[:, :2], boundary["points"])
        measured.append(
            {
                "globalId": element.GlobalId,
                "name": model.label(element),
                "ifcType": element.is_a(),
                "distance": round(distance, 4),
                "pointOnElement": [round(float(c), 4) for c in on_element],
                "pointOnBoundary": [round(float(c), 4) for c in on_boundary],
            }
        )

    if not measured:
        return op._no_geometry(model, subjects[0], method, [s.GlobalId for s in subjects])

    measured.sort(key=lambda entry: (entry["distance"], entry["globalId"]))
    nearest = measured[0]
    # `None`, not `False`, on an open polyline: an even-odd crossing test has to
    # close the ring to run at all, and on three drawn sides of a parcel that
    # closing line is a line nobody drew. Reporting `False` would be an answer
    # about a shape this file does not contain.
    outside = _outside_polygon(np.array(nearest["pointOnElement"]), boundary["points"]) if boundary["closed"] else None

    caveat = [
        "Waagrechter Abstand zwischen dem Bauteilkörper und dem Grenzlinienzug, in der Grundrissebene "
        "gemessen. Nichts aus dem Regelwerk angewandt: welchen Abstand die Bestimmung verlangt, ergibt sich "
        "aus ihr und aus dem Bebauungsplan, nicht aus diesem Modell.",
        f"Die Grenze stammt aus: {boundary['via']}. Ihre Richtigkeit ist eine Eigenschaft des Exports — "
        "maßgeblich ist der Vermessungs- bzw. Katasterplan.",
    ]
    if not boundary["closed"]:
        caveat.append(
            "Der Linienzug ist NICHT geschlossen (erster und letzter Punkt fallen nicht zusammen). Gemessen "
            "wurde ausschließlich auf die GEZEICHNETEN Strecken — der Zug wird nicht rechnerisch geschlossen, "
            "denn die Schlusslinie hat niemand gezeichnet und ein Abstand darauf wäre erfunden. Fehlt hier "
            "eine Seite des Grundstücks, ist der gemeldete Abstand zu GROSS, und das ist die gefährliche "
            "Richtung: die fehlende Seite kann die nächstgelegene sein. Ob innen oder außen liegt, wird für "
            "einen offenen Zug nicht bestimmt."
        )
    if outside:
        caveat.append(
            "Der nächstgelegene Punkt des Bauwerks liegt AUSSERHALB des Grenzlinienzugs. Das ist zuerst ein "
            "Befund über den Export — Modell und Grenze stehen vermutlich auf verschiedenen Bezugspunkten — "
            "und erst danach eine Aussage über das Bauwerk. Der gemeldete Abstand ist in diesem Fall der "
            "Abstand nach außen."
        )
    # `elemente` carries the ten nearest, never all of them, and the caveat has
    # to say which of the two it is. On a model with 12 candidate elements the
    # sentence „Die vollständige … Liste steht unter „elemente““ stood over a
    # payload of 10: a truncation that reads as „das ist alles" is exactly what
    # `Answer.caveat` means by "a caller that drops this is reporting a subset
    # as a total".
    listed = measured[:10]
    if global_id is None:
        caveat.append(
            f"Geprüft wurden {len(measured)} Bauteile; genannt ist das nächstgelegene "
            f"(„{nearest['name'] or nearest['globalId']}“). Räume und Öffnungen sind ausgenommen, sie sind "
            f"Luft. Unter „elemente“ stehen die {len(listed)} nächstgelegenen der {len(measured)} geprüften "
            "Bauteile, nach Abstand sortiert"
            + (
                "; das sind alle."
                if len(listed) == len(measured)
                else f" — die {len(measured) - len(listed)} entfernteren sind NICHT enthalten."
            )
        )

    return computed(
        {
            "distance": nearest["distance"],
            "nearest": nearest,
            "boundary": {
                "via": boundary["via"],
                "globalId": boundary["globalId"],
                "punkte": len(boundary["points"]),
                "geschlossen": boundary["closed"],
            },
            "ausserhalb": outside,
            "elemente": listed,
        },
        unit="m",
        tolerance=op.DIMENSION_TOLERANCE,
        from_=[boundary["globalId"], nearest["globalId"]],
        method=method,
        caveat=" ".join(caveat),
    )


def _site_boundary(model: SpatialModel) -> dict[str, Any] | None:
    """The site boundary polygon in world XY, or ``None`` when the file has none."""
    for site in model.file.by_type("IfcSite"):
        found = _curve_points(model, site)
        if found is not None:
            return {
                "globalId": site.GlobalId,
                "via": f"IfcSite „{model.label(site) or site.GlobalId}“, Repräsentation „{found[1]}“",
                "points": found[0],
                "closed": _is_closed(found[0]),
            }

    try:
        annotations = model.file.by_type("IfcAnnotation")
    except RuntimeError:
        annotations = []
    for annotation in annotations:
        label = " ".join(
            str(value)
            for value in (annotation.Name, getattr(annotation, "ObjectType", None), annotation.Description)
            if value
        )
        if _matching_term(label, BOUNDARY_TERMS) is None:
            continue
        found = _curve_points(model, annotation)
        if found is not None:
            return {
                "globalId": annotation.GlobalId,
                "via": f"IfcAnnotation „{model.label(annotation) or annotation.GlobalId}“",
                "points": found[0],
                "closed": _is_closed(found[0]),
            }
    return None


def _curve_points(model: SpatialModel, product: Any) -> tuple[np.ndarray, str] | None:
    """World-coordinate XY points of the first usable curve on this product.

    Read off the entity and transformed by its placement rather than shaped: a
    ``FootPrint`` is a 2D curve, ``ifcopenshell.geom.create_shape`` builds solids
    and surfaces, and asking it for a plot boundary returns nothing at all —
    which would be indistinguishable from the file not having one.
    """
    import ifcopenshell.util.placement as placement_util

    representation = getattr(product, "Representation", None)
    if representation is None:
        return None
    try:
        matrix = placement_util.get_local_placement(product.ObjectPlacement)
    except Exception:
        matrix = np.eye(4)

    for shape in representation.Representations or []:
        points = _points_of_items(shape.Items or [])
        if len(points) < 2:
            continue
        local = np.array(points, dtype=float)
        world = (matrix[:3, :3] @ local.T).T + matrix[:3, 3]
        return world[:, :2] * model.unit_scale, shape.RepresentationIdentifier or shape.RepresentationType or "?"
    return None


def _points_of_items(items: Sequence[Any]) -> list[tuple[float, float, float]]:
    """Cartesian points out of the curve kinds an exporter actually writes."""
    out: list[tuple[float, float, float]] = []
    for item in items:
        if item.is_a("IfcPolyline"):
            out.extend(_xyz(point) for point in item.Points)
        elif item.is_a("IfcIndexedPolyCurve"):
            coordinates = getattr(item.Points, "CoordList", None) or []
            out.extend(_xyz_tuple(entry) for entry in coordinates)
        elif item.is_a("IfcGeometricSet") or item.is_a("IfcGeometricCurveSet"):
            out.extend(_points_of_items(item.Elements or []))
        elif item.is_a("IfcCompositeCurve"):
            for segment in item.Segments or []:
                out.extend(_points_of_items([segment.ParentCurve]))
    return out


def _xyz(point: Any) -> tuple[float, float, float]:
    return _xyz_tuple(point.Coordinates)


def _xyz_tuple(coordinates: Sequence[float]) -> tuple[float, float, float]:
    values = [float(c) for c in coordinates]
    while len(values) < 3:
        values.append(0.0)
    return values[0], values[1], values[2]


def _is_closed(points: np.ndarray) -> bool:
    return bool(len(points) >= 3 and float(np.linalg.norm(points[0] - points[-1])) < op.COORDINATE_TOLERANCE)


def _distance_to_polygon(vertices: np.ndarray, boundary: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Shortest distance from a vertex cloud to a polyline, with both witnesses.

    Both endpoints come back because a bare number is not checkable: a reviewer
    with the two coordinates can put a dimension line on the plan and see
    whether it lands where they expect.
    """
    best = math.inf
    on_element = vertices[0]
    on_boundary = boundary[0]
    # Only the segments the file actually draws. An open polyline is NOT closed
    # here, deliberately: a survey layer routinely carries three sides of a
    # parcel, and the fourth side this code would invent lands wherever the
    # first and last point happen to be. Measured on a three-sided fixture, that
    # fabricated closing line came out **1.06 m** from a wall that is 7.70 m
    # from the nearest drawn boundary — a plausible, precise, invented number,
    # which is the same substitution this operator refuses to make from the
    # site's bounding box. The caveat says a missing side makes the distance too
    # large instead.
    for start, end in zip(boundary[:-1], boundary[1:], strict=False):
        edge = end - start
        length_squared = float(edge @ edge)
        if length_squared < 1e-18:
            projected = np.repeat(start[None, :], len(vertices), axis=0)
        else:
            t = np.clip(((vertices - start) @ edge) / length_squared, 0.0, 1.0)
            projected = start + t[:, None] * edge
        distances = np.linalg.norm(vertices - projected, axis=1)
        index = int(np.argmin(distances))
        if float(distances[index]) < best:
            best = float(distances[index])
            on_element = vertices[index]
            on_boundary = projected[index]
    return best, on_element, on_boundary


def _outside_polygon(point: np.ndarray, boundary: np.ndarray) -> bool:
    """Even-odd ray crossing in plan. Meaningless on an open polyline, and the
    caller says so in that case rather than suppressing the flag."""
    inside = False
    count = len(boundary)
    for index in range(count):
        x1, y1 = boundary[index]
        x2, y2 = boundary[(index + 1) % count]
        if (y1 > point[1]) != (y2 > point[1]):
            crossing = x1 + (point[1] - y1) / (y2 - y1) * (x2 - x1)
            if point[0] < crossing:
                inside = not inside
    return not inside


# ── shared helpers ──────────────────────────────────────────────────────────


def _matching_term(name: str | None, terms: Sequence[str] = NOT_OCCUPIED_TERMS) -> str | None:
    """The first term matching this name, normalised the way the lexicon is.

    Reuses :func:`~ifc_spatial.briefing.normalise` so ``Dachgeschoß``,
    ``Dachgeschoss`` and ``DACHGESCHOSS`` are one storey rather than three, and
    so a name only mangled by an exporter's encoding does not change the answer.
    """
    if not name:
        return None
    normalised = normalise(str(name))
    for term in terms:
        if term in normalised:
            return term
    return None


def _metres(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:.3f} m".replace(".", ",")


__all__ = [
    "BOUNDARY_TERMS",
    "MIN_OVERLAP_AREA",
    "NOT_OCCUPIED_TERMS",
    "SEPARATION_SLACK",
    "SeparatingElement",
    "StoreyJudgement",
    "compartment_area",
    "distance_to_site_boundary",
    "fluchtniveau",
    "separating_elements",
]
