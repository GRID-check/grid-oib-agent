"""Golden-set schema, loader, and the Punkt -> ``(file_name, page)`` expansion. PURE.

No NAT, no chroma, no network: this module reads two JSON files and returns dataclasses.

WHY THE GOLDEN SET IS LABELLED IN PUNKTE BUT SCORED IN PAGES
------------------------------------------------------------
A human labelling this corpus thinks in Punkte — "the 40 m Gehweglänge is OIB-Richtlinie 2,
Punkt 5.1.1" — because that is the citation an Austrian fire engineer writes down and the
only label that survives a re-chunking. Retrieval, on the other hand, returns chunks, and
the only thing every chunking strategy agrees on is which page a chunk came from. So the
labels are authored as ``(richtlinie, punkt, grade)`` and expanded here, through the
committed ``fixtures/punkt_index.json``, into the ``(file_name, page)`` units the metrics
score. A Punkt that spans three pages expands to three units at the same grade, and every
one of them counts toward that question's recall denominator (see :mod:`metrics`).

This indirection is the reason the same golden file can score the page-chunked arm and the
Punkt-chunked arm without relabelling: the labels never mention a chunk.

EXPANSION IS STRICT
-------------------
A label naming a Richtlinie or Punkt the index does not contain raises. A golden set is a
measuring instrument, and an instrument that silently drops the labels it cannot resolve
reports a better number the more broken it is. There is deliberately no "skip unknown"
mode.

THE FORBIDDEN SET IS A FILE-NAME RULE, NOT A LIST OF UNITS
-----------------------------------------------------------
``data/oib/`` ships three families of PDF per Richtlinie: the Richtlinie itself, an
``erlaeuterungen_*`` commentary, and an ``aenderungen_*`` change log that says only what
moved between the 2019 and 2023 editions. The change log is never the answer to "what is
required" — its sentences read exactly like requirements, so a hit there is a wrong answer
wearing a correct-looking citation. Forbidding it by file-name prefix rather than by an
enumerated unit list means the rule keeps working when a page is added, and it applies to
EVERY question rather than only to the ones somebody remembered to annotate.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any
from typing import NamedTuple


class Unit(NamedTuple):
    """The judged atom of retrieval: one page of one file, as the product cites it."""

    file_name: str
    page: int


@dataclass(frozen=True)
class PunktLabel:
    """One graded label: a Punkt of a Richtlinie, and how relevant it is to the question.

    Grades are 1-3 and the scale is stated here rather than in the fixture so every entry
    means the same thing: 3 = this Punkt states the answer; 2 = the answer is incomplete
    or wrong without it (an exception, a second limit, the table it points at); 1 =
    related context an expert would want next to it but would not cite alone.
    """

    richtlinie: str
    punkt: str
    grade: int

    def __post_init__(self) -> None:
        if self.grade not in (1, 2, 3):
            raise ValueError(f"grade must be 1, 2 or 3; got {self.grade!r} for {self.richtlinie} Punkt {self.punkt}")


@dataclass(frozen=True)
class GoldenEntry:
    """One golden question and everything needed to audit its labels later.

    ``need_id`` is the information need, shared by the German entry, its English sibling
    and any morphology variants — it is what makes the language-parity delta a comparison
    of the same question rather than of two different ones. ``variant_of`` is set on the
    German morphology variants (identical qrels, different wording) so the parity
    computation can exclude them from the per-language aggregate without losing them from
    the corpus-wide one.
    """

    id: str
    need_id: str
    language: str
    question: str
    question_class: str
    relevant: tuple[PunktLabel, ...]
    provenance: str
    label_method: str
    notes: str
    calibration_pending: bool
    variant_of: str | None = None

    @property
    def should_refuse(self) -> bool:
        """True when no Punkt in this corpus answers the question.

        Scored through :func:`metrics.fill_rate`, never through recall — see there.
        """
        return not self.relevant


@dataclass(frozen=True)
class GoldenSet:
    """The loaded golden file: entries plus the corpus-wide forbidden-file rule."""

    entries: tuple[GoldenEntry, ...]
    forbidden_file_prefixes: tuple[str, ...]
    description: str = ""
    schema_version: int = 1

    def by_language(self, language: str) -> tuple[GoldenEntry, ...]:
        return tuple(entry for entry in self.entries if entry.language == language)

    def primary(self) -> tuple[GoldenEntry, ...]:
        """Entries that are not morphology variants of another entry."""
        return tuple(entry for entry in self.entries if entry.variant_of is None)

    def sibling_pairs(self, left: str = "de", right: str = "en") -> tuple[tuple[GoldenEntry, GoldenEntry], ...]:
        """``(left_entry, right_entry)`` per need that has exactly one primary entry in each.

        The language-parity delta is computed over these pairs and nothing else: comparing
        the two languages' full aggregates would fold the German-only morphology variants
        into the German mean and report a wording effect as a language effect.
        """
        by_need: dict[str, dict[str, GoldenEntry]] = {}
        for entry in self.primary():
            by_need.setdefault(entry.need_id, {})[entry.language] = entry
        pairs = []
        for need_id in sorted(by_need):
            languages = by_need[need_id]
            if left in languages and right in languages:
                pairs.append((languages[left], languages[right]))
        return tuple(pairs)


class ForbiddenUnits:
    """``in``-testable view of "this unit came from a file we must never cite".

    A ``Container`` rather than a set so :func:`metrics.forbidden_rate` can take it
    unchanged; the rule is evaluated per unit instead of materialised, because the
    forbidden files are never indexed as units until retrieval returns one.
    """

    __slots__ = ("prefixes",)

    def __init__(self, prefixes: Iterable[str]) -> None:
        self.prefixes = tuple(prefixes)

    def __contains__(self, unit: object) -> bool:
        file_name = getattr(unit, "file_name", None)
        if file_name is None and isinstance(unit, tuple) and unit:
            file_name = unit[0]
        if not isinstance(file_name, str):
            return False
        return file_name.startswith(self.prefixes)


class PunktIndex:
    """``fixtures/punkt_index.json``: 946 Punkte across 12 Richtlinien, as committed.

    The index is ground truth for two different things, and both are load-bearing:
    it is the label vocabulary the golden set is written in, and it is the independent
    inventory the structural before/after in :mod:`structure` measures the two chunking
    strategies against. It is committed, and this harness never regenerates it — a
    ground truth that moves when the thing it measures moves is not a ground truth.
    """

    __slots__ = ("_by_richtlinie", "unresolved")

    def __init__(self, payload: dict[str, Any]) -> None:
        self._by_richtlinie: dict[str, dict[str, dict[str, Any]]] = {
            key: value for key, value in payload.items() if key != "_unresolved"
        }
        self.unresolved: dict[str, Any] = payload.get("_unresolved", {})

    @property
    def richtlinien(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_richtlinie))

    def punkte(self, richtlinie: str) -> dict[str, dict[str, Any]]:
        try:
            return self._by_richtlinie[richtlinie]
        except KeyError:
            raise KeyError(
                f"Richtlinie {richtlinie!r} is not in the Punkt index; known: {', '.join(self.richtlinien)}"
            ) from None

    def file_name(self, richtlinie: str) -> str:
        """The PDF every Punkt of this Richtlinie lives in (the index has exactly one)."""
        punkte = self.punkte(richtlinie)
        return next(iter(punkte.values()))["file_name"]

    def total_punkte(self) -> int:
        return sum(len(punkte) for punkte in self._by_richtlinie.values())

    def units(self, richtlinie: str, punkt: str) -> tuple[Unit, ...]:
        """Every ``(file_name, page)`` this Punkt occupies, in page order."""
        punkte = self.punkte(richtlinie)
        try:
            entry = punkte[punkt]
        except KeyError:
            raise KeyError(f"Punkt {punkt!r} is not in the index for Richtlinie {richtlinie!r}") from None
        return tuple(Unit(entry["file_name"], int(page)) for page in entry["pages"])

    def has_children(self, richtlinie: str, punkt: str) -> bool:
        """True when another indexed Punkt is nested under this one (``3.1`` under ``3``).

        Structural parents carry no requirement of their own — their body is the heading
        line and their children hold the text — so :mod:`structure` measures the citable
        unit over the leaves only. Derived from the index rather than from any chunker's
        opinion, which is what keeps that measurement non-circular.
        """
        prefix = f"{punkt}."
        return any(other != punkt and other.startswith(prefix) for other in self.punkte(richtlinie))

    def leaf_punkte(self, richtlinie: str) -> tuple[str, ...]:
        return tuple(punkt for punkt in self.punkte(richtlinie) if not self.has_children(richtlinie, punkt))


def load_punkt_index(path: str | Path) -> PunktIndex:
    """Load the committed Punkt index."""
    with open(path, encoding="utf-8") as handle:
        return PunktIndex(json.load(handle))


def load_golden(path: str | Path) -> GoldenSet:
    """Load and validate the golden set, raising on any structural defect.

    Validated here rather than at use: a duplicate id, a missing sibling or a grade
    outside 1-3 makes every downstream number quietly wrong, and the cheapest place to
    find that is the moment the file is read.
    """
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)

    entries: list[GoldenEntry] = []
    seen_ids: set[str] = set()
    for raw in payload["entries"]:
        entry = GoldenEntry(
            id=raw["id"],
            need_id=raw["need_id"],
            language=raw["language"],
            question=raw["question"],
            question_class=raw["question_class"],
            relevant=tuple(
                PunktLabel(richtlinie=str(label["richtlinie"]), punkt=str(label["punkt"]), grade=int(label["grade"]))
                for label in raw["relevant"]
            ),
            provenance=raw["provenance"],
            label_method=raw["label_method"],
            notes=raw["notes"],
            calibration_pending=bool(raw["calibration_pending"]),
            variant_of=raw.get("variant_of"),
        )
        if entry.id in seen_ids:
            raise ValueError(f"duplicate golden entry id: {entry.id!r}")
        if entry.language not in ("de", "en"):
            raise ValueError(f"{entry.id!r}: language must be 'de' or 'en', got {entry.language!r}")
        seen_ids.add(entry.id)
        entries.append(entry)

    for entry in entries:
        if entry.variant_of is not None and entry.variant_of not in seen_ids:
            raise ValueError(f"{entry.id!r}: variant_of {entry.variant_of!r} is not a golden entry id")

    return GoldenSet(
        entries=tuple(entries),
        forbidden_file_prefixes=tuple(payload["forbidden_file_prefixes"]),
        description=payload.get("description", ""),
        schema_version=int(payload.get("schema_version", 1)),
    )


def expand(entry: GoldenEntry, index: PunktIndex) -> dict[Unit, int]:
    """Expand one entry's Punkt labels into graded ``(file_name, page)`` units.

    When two labelled Punkte share a page (common: a page holds several Punkte), the
    HIGHER grade wins. Taking the lower would let a grade-1 context label demote the page
    that also carries the grade-3 answer, which is a labelling artefact, not a retrieval
    property.
    """
    graded: dict[Unit, int] = {}
    for label in entry.relevant:
        for unit in index.units(label.richtlinie, label.punkt):
            graded[unit] = max(graded.get(unit, 0), label.grade)
    return graded


@dataclass(frozen=True)
class Judgements:
    """Everything the metrics need for one query, resolved against the index."""

    entry: GoldenEntry
    graded: dict[Unit, int] = field(default_factory=dict)

    @property
    def relevant(self) -> frozenset[Unit]:
        return frozenset(self.graded)


def build_judgements(golden: GoldenSet, index: PunktIndex) -> tuple[Judgements, ...]:
    """Resolve every golden entry against the Punkt index, in file order."""
    return tuple(Judgements(entry=entry, graded=expand(entry, index)) for entry in golden.entries)


def assert_siblings_share_qrels(golden: GoldenSet, index: PunktIndex) -> None:
    """Raise unless every German question and its English sibling expand identically.

    This is the load-bearing invariant of the language-parity number. The requirement is
    "English should perform just as well as German"; if the two languages' expected
    outputs differed at all, a measured gap could always be argued away as a labelling
    artefact. Identical qrels remove that argument: any gap is retrieval.
    """
    for german, english in golden.sibling_pairs():
        left = expand(german, index)
        right = expand(english, index)
        if left != right:
            raise ValueError(
                f"sibling qrels differ for need {german.need_id!r}: "
                f"{german.id} -> {sorted(left)} vs {english.id} -> {sorted(right)}"
            )
