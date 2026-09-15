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


def section_in(text: str) -> tuple[str, str]:
    """The first ``(kind, number)`` a text names, or ``("", "")``."""
    paragraph = PARAGRAPH_RE.search(text)
    if paragraph:
        return "§", paragraph.group(1)
    artikel = ARTIKEL_RE.search(text)
    return ("Art", artikel.group(1)) if artikel else ("", "")


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
    kind, section = section_in(instrument) if instrument and not url and not number else ("", "")
    if not section:
        kind, section = section_in(question or "")
    absatz = ABSATZ_RE.search(instrument) or ABSATZ_RE.search(question or "")
    land, land_source = resolve_land(jurisdiction, instrument, question or "")
    return Address(
        kind=kind,
        number=section,
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
    return PARAGRAPH_RE.sub("", ABSATZ_RE.sub("", instrument)).strip(" ,.;")


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
