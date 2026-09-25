"""[1] The address the caller's words already carry. Deterministic, no LLM.

A legal question usually states where its answer sits: a § or Artikel, a named
law, a Bundesland. Reading that out is text matching, not reasoning, and doing
it here is what lets the rest of the pipeline skip both LLM calls — the search
planner AND the § extractor — whenever the caller already said "§ 63 BO Wien".

Pure: every function here takes strings and returns values. The one exception
is the project brief, which is a request fact and is read through
``norm_registry.resolve_bundesland``; it is isolated in its own function so the
rest stays testable without a request context.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from urllib.parse import urlparse

from ris_adapter.client import ALLOWED_DOCUMENT_HOSTS
from ris_adapter.register import _CATALOG_AVAILABLE
from ris_adapter.register import extract_bundesland

logger = logging.getLogger(__name__)

PARAGRAPH_RE = re.compile(r"§+\s*(\d+[a-z]?)")
ARTIKEL_RE = re.compile(r"\bArt(?:ikel)?\.?\s*(\d+[a-z]?)\b", re.IGNORECASE)
ABSATZ_RE = re.compile(r"\bAbs(?:atz|\.)?\s*(\d+[a-z]?)\b", re.IGNORECASE)

#: A LIST of §§ or Artikel: "§§ 75 und 81", "§§ 2, 3", "§§ 63 bis 65",
#: "§ 5 und § 7", "§ 5 Abs 2 und § 7", "Art. 5 und 7". Every one it names is
#: addressed. Read as one it dropped all but the first and left "und 81" in the
#: law's name, and the agent spent a round fetching the § it had already asked
#: for. Read by a cursor from the first § the caller named (:func:`_list_from`),
#: not by one regex: whether "und 3" continues the §§ or the Absatz before it
#: depends on what came just before.
_SIGNED = {
    "§": re.compile(r"\s*§+\s*(\d+)([a-z]?)\b", re.IGNORECASE),
    "Art": re.compile(r"\s*\bArt(?:ikel)?\.?\s*(\d+)([a-z]?)\b", re.IGNORECASE),
}
#: An item with no sign of its own: at most three digits (a year is not a §).
_BARE = re.compile(r"\s*(\d{1,3})([a-z]?)\b", re.IGNORECASE)
#: After a comma, "2. Satz" is an ordinal, not § 2.
_ORDINAL_AHEAD = re.compile(r"\.\s*\w")
_JOIN_RE = re.compile(r"\s*(,|\bund\b|\bsowie\b|\bu\.|\bbis\b|–|-)", re.IGNORECASE)
_RANGE_JOINS = frozenset({"bis", "–", "-"})
#: What narrows one § ("Abs 2", "Abs. 2 und 3", "Z 4", "lit. b", ", 2. Satz"). Bare numbers
#: joined after it are more Absätze, never more §§.
_QUALIFIER_RE = re.compile(
    r"\s*(?:Abs(?:atz|\.)?\s*\d+[a-z]?|Z(?:iffer|\.)?\s*\d+|lit\.?\s*[a-z]\b|,?\s*\d+\.\s*Satz\b)"
    r"(?:\s*(?:,|\bund\b|\bbis\b|–|-)\s*\d+[a-z]?\b(?!\.\s*\w))*",
    re.IGNORECASE,
)
#: An Absatz with a list after it, where no § stands before it: taken out of
#: the law's name whole, so no "und 3" is left to be read as the law.
_ABSATZ_LIST_RE = re.compile(r"\bAbs(?:atz|\.)?\s*\d+[a-z]?(?:\s*(?:,|und|bis|–|-)\s*\d+[a-z]?)*", re.IGNORECASE)

#: How many §§ one list may address: the tool's own passage budget
#: (``extract.MAX_PASSAGES``). A longer list or range addresses its first six,
#: and the result says which it did not read (``Address.unread``).
MAX_ADDRESSED_SECTIONS = 6

#: A bare RIS document number as an ``instrument=`` argument ("NOR40217157",
#: "JWT_2020130074_20210415J00"). The four-digit lookahead is load-bearing:
#: without it "Bauordnung" reads as a document number, and a NAMED LAW is then
#: treated as an address nothing can resolve — the catalog is skipped and the
#: question misses. Every RIS document number carries a year-length run of
#: digits; no law's short title does.
_DOCUMENT_NUMBER_RE = re.compile(r"^(?=[A-Za-z0-9_.\-]*\d{4})[A-Za-z]{2,4}[A-Za-z0-9_.\-]{4,}$")

#: Where the assumed Bundesland came from, in precedence order. The reader of a
#: miss needs the PROVENANCE, not just the value: a wrong jurisdiction is the
#: commonest silent RIS failure, and ``focus_entries`` drops other states' law
#: without saying so.
LAND_FROM_ARGUMENT = "jurisdiction argument"
LAND_FROM_INSTRUMENT = "instrument argument"
LAND_FROM_QUESTION = "the question"
LAND_FROM_BRIEF = "the project brief"


@dataclass(frozen=True)
class Address:
    """What the caller's words already say about WHERE the answer sits."""

    kind: str = ""  # "§" | "Art" | ""
    number: str = ""
    #: Every § the caller named, ``number`` first; one entry for a single §.
    numbers: tuple[str, ...] = ()
    #: The §§ a list named past :data:`MAX_ADDRESSED_SECTIONS`, not read.
    unread: tuple[str, ...] = ()
    absatz: str = ""
    law: str = ""
    url: str = ""
    document_number: str = ""
    bundesland: str = ""
    bundesland_source: str = ""

    @property
    def has_section(self) -> bool:
        """Whether a § or Artikel was named — the deterministic path's trigger."""
        return bool(self.kind and self.number)

    @property
    def sections(self) -> tuple[str, ...]:
        """Every addressed number: the list when one was named, else the one §."""
        return self.numbers or ((self.number,) if self.number else ())


#: A range is expanded in full, so every § past the first six is named as not
#: read. This bounds only nonsense input ("§§ 1 bis 999999"): past it the range
#: ends here, which no law reaches.
_MAX_RANGE_SPAN = 1000


def _first_section(text: str) -> tuple[str, str, int]:
    """``(kind, number, where)`` of the first § (or else Artikel) in ``text``; ``("", "", -1)`` without one."""
    paragraph = PARAGRAPH_RE.search(text)
    if paragraph:
        return "§", paragraph.group(1), paragraph.start()
    artikel = ARTIKEL_RE.search(text)
    return ("Art", artikel.group(1), artikel.start()) if artikel else ("", "", -1)


def _list_from(text: str, kind: str, start: int) -> tuple[tuple[str, ...], int]:
    """Every § (or Artikel) a list starting at ``start`` names, and where the list ends.

    Ranges expanded (:func:`_extend`); an Absatz, Ziffer or litera after an
    item is part of it; after one, only a SIGNED item continues the list. Not
    capped: :func:`parse_address` addresses the first
    :data:`MAX_ADDRESSED_SECTIONS` and reports the rest as unread.
    """
    first = _SIGNED[kind].match(text, start)
    if first is None:
        return (), start
    items, end = [first.group(1) + first.group(2).lower()], first.end()
    while True:
        qualifier = _QUALIFIER_RE.match(text, end)
        end = qualifier.end() if qualifier else end
        join = _JOIN_RE.match(text, end)
        item = join and _next_item(text, kind, join, qualified=qualifier is not None)
        if not item:
            return tuple(dict.fromkeys(items)), end
        _extend(items, item.group(1), item.group(2).lower(), ranged=join.group(1).lower() in _RANGE_JOINS)
        end = item.end()


def _next_item(text: str, kind: str, join: re.Match[str], *, qualified: bool) -> re.Match[str] | None:
    """The item after ``join``: signed always; bare only after an unqualified item, and not an ordinal."""
    signed = _SIGNED[kind].match(text, join.end())
    if signed or qualified:
        return signed
    bare = _BARE.match(text, join.end())
    if bare and join.group(1) == "," and _ORDINAL_AHEAD.match(text, bare.end()):
        return None
    return bare


def _extend(items: list[str], digits: str, letter: str, *, ranged: bool) -> None:
    """Add one item, or the range from the last one to it ("7a bis 9" → 8, 9; "5a-5c" → 5b, 5c).

    A range that does not ascend ("§ 12 bis 3") names nothing anyone meant,
    and adds nothing.
    """
    if not ranged:
        items.append(digits + letter)
        return
    previous = re.match(r"(\d+)([a-z]?)", items[-1])
    start, start_letter, end = int(previous.group(1)), previous.group(2), int(digits)
    if end == start and letter and letter > start_letter:
        first = chr(ord(start_letter) + 1) if start_letter else "a"
        items.extend(f"{end}{chr(code)}" for code in range(ord(first), ord(letter) + 1))
        return
    if end <= start:
        return
    last = min(end, start + _MAX_RANGE_SPAN)
    items.extend(str(value) for value in range(start + 1, last + 1))
    if letter and last == end:
        items.append(f"{end}{letter}")


def section_in(text: str) -> tuple[str, str]:
    """The first ``(kind, number)`` a text names, or ``("", "")``."""
    kind, number, _where = _first_section(text)
    return kind, number


def is_ris_url(value: str) -> bool:
    """Whether ``value`` is a URL this adapter is allowed to fetch."""
    if not value.lower().startswith(("http://", "https://")):
        return False
    try:
        return urlparse(value).hostname in ALLOWED_DOCUMENT_HOSTS
    except ValueError:
        return False


def parse_address(question: str, instrument: str, jurisdiction: str) -> Address:
    """Read the address out of the caller's arguments.

    The ``instrument`` argument outranks the question for the § and the law: it
    is what the caller chose to state as an address, while the question is
    prose that may mention a § in passing.
    """
    instrument = (instrument or "").strip()
    url = instrument if is_ris_url(instrument) else ""
    number = instrument if not url and _DOCUMENT_NUMBER_RE.match(instrument) else ""
    source = instrument if instrument and not url and not number else ""
    kind, section, where = _first_section(source)
    if not section:
        source = question or ""
        kind, section, where = _first_section(source)
    items = _list_from(source, kind, where)[0] if kind else ()
    listed = items if len(items) > 1 else ()
    # An Absatz narrows ONE §; with a list it would narrow all of them to the
    # same number, which is never what "§ 5 Abs 2 und § 7" means.
    absatz = None if listed else (ABSATZ_RE.search(instrument) or ABSATZ_RE.search(question or ""))
    land, land_source = resolve_land(jurisdiction, instrument, question or "")
    return Address(
        kind=kind,
        number=section,
        numbers=listed[:MAX_ADDRESSED_SECTIONS],
        unread=listed[MAX_ADDRESSED_SECTIONS:],
        absatz=absatz.group(1) if absatz else "",
        law=_law_name(instrument, url, number),
        url=url,
        document_number=number,
        bundesland=land,
        bundesland_source=land_source,
    )


def _law_name(instrument: str, url: str, number: str) -> str:
    """The named law inside ``instrument``, with the § and Absatz taken out."""
    if url or number:
        return ""
    rest = instrument
    # Every § or Artikel list goes, with its Absätze: the first is the
    # address, any later one a reference the law's name does not contain.
    for _ in range(8):
        kind, _number, where = _first_section(rest)
        if not kind:
            break
        _items, end = _list_from(rest, kind, where)
        rest = f"{rest[:where]} {rest[max(end, where + 1) :]}"
    rest = _ABSATZ_LIST_RE.sub("", rest)
    return re.sub(r"\s{2,}", " ", rest).strip(" ,.;-–")


def resolve_land(jurisdiction: str, instrument: str, question: str) -> tuple[str, str]:
    """The Bundesland to work in, and WHERE it came from.

    Precedence is the caller's explicit word, then the instrument they named,
    then the question, then the project brief's structured ``bundesland=``
    fact. Both halves travel: a miss states the assumption AND its source,
    because "Wien, because you said so" and "Wien, because the project is in
    Wien" call for different corrections.
    """
    if not _CATALOG_AVAILABLE:
        return "", ""
    for value, origin in (
        (jurisdiction, LAND_FROM_ARGUMENT),
        (instrument, LAND_FROM_INSTRUMENT),
        (question, LAND_FROM_QUESTION),
    ):
        land = extract_bundesland(value) if value else None
        if land:
            return land, origin
    return _land_from_brief()


def land_sentence(address: Address) -> str:
    """The assumed jurisdiction and where it came from, as one sentence.

    Rendered on a HIT as well as on a miss: ``focus_entries`` silently drops
    every other state's law, so the assumption that did the dropping has to be
    visible in the result it produced, not only in the result it prevented.
    """
    if not address.bundesland:
        return (
            "No Bundesland was resolved (not in the arguments, the question or the project brief), "
            "so state law was not narrowed to one Land."
        )
    return f"Assumed Bundesland: {address.bundesland} (from {address.bundesland_source})."


def _land_from_brief() -> tuple[str, str]:
    """The project brief's structured jurisdiction, or ``("", "")``.

    ``resolve_bundesland(None)`` reads the validated token off the signed
    request envelope and probes no text — with no live request (tests, the
    adapter standalone) there simply is no project, which is not an error.
    """
    try:
        from aiq_agent.common.norm_registry import resolve_bundesland

        land = resolve_bundesland(None)
    except Exception:  # noqa: BLE001 — no request context is the normal case off-request
        logger.debug("ris_lookup: no project-brief jurisdiction available", exc_info=True)
        return "", ""
    return (land, LAND_FROM_BRIEF) if land else ("", "")
