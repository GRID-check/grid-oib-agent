"""[4] Which paragraphs answer the question. CAP: six, across two documents.

Two paths, and the first one is free:

* **Deterministic** — the caller named a § or Artikel, so ``grammar`` finds it
  by number and returns it with its Absätze. No LLM call at all, which is the
  whole reason ``address.py`` runs first.
* **Ranked** — nobody named one, so ONE call to the picker model reads the
  law's § HEADINGS (never a body: that is what keeps this call's input bounded
  by the table of contents rather than by the length of the law) and returns up
  to six ids. The grammar then cuts those §§ out, so what reaches the answering
  model is the law's own text, not the picker's summary of it.

A document the grammar finds no §§ in (a court decision) is one passage. A
document whose §§ answer nothing puts its headings on the trace, as an INDEX —
see ``miss.miss_message``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from ris_adapter.lookup.address import Address
from ris_adapter.lookup.address import section_in
from ris_adapter.lookup.fetch import FetchedDocument
from ris_adapter.lookup.grammar import SECTION_MAX_CHARS
from ris_adapter.lookup.grammar import Section
from ris_adapter.lookup.grammar import headings_index
from ris_adapter.lookup.grammar import split_sections
from ris_adapter.lookup.trace import LookupTrace

logger = logging.getLogger(__name__)

#: Passages returned per call, across at most :data:`MAX_DOCUMENTS` documents.
MAX_PASSAGES = 6
MAX_DOCUMENTS = 2


@dataclass(frozen=True)
class Selection:
    """The sections picked out of ONE document, each with its Absatz (or none)."""

    fetched: FetchedDocument
    picks: tuple[tuple[Section, str], ...]


async def select_passages(picker, question: str, address: Address, documents, trace: LookupTrace):
    """At most six passages across at most two documents, as ``Selection``s."""
    selections: list[Selection] = []
    budget = MAX_PASSAGES
    for fetched in documents[:MAX_DOCUMENTS]:
        sections = split_sections(fetched.document.text)
        picks = await _pick(picker, question, address, sections, fetched)
        if not picks and sections:
            trace.headings.append(_index_for(fetched, sections))
        selections.append(Selection(fetched=fetched, picks=tuple(picks[:budget])))
        budget -= len(picks[:budget])
        if budget <= 0:
            break
    return [selection for selection in selections if selection.picks]


def _index_for(fetched: FetchedDocument, sections: list[Section]) -> str:
    """One read-but-unanswering document's heading index, titled."""
    title = fetched.document.title or fetched.candidate.title
    return f"{title}:\n{headings_index(sections)}"


async def _pick(picker, question, address: Address, sections, fetched) -> list[tuple[Section, str]]:
    """``(section, absatz)`` pairs to return: deterministic first, LLM second."""
    if not sections:
        return _whole_document(fetched)
    if address.has_section:
        return [
            pick for section in sections if _is_addressed(section, address) for pick in _addressed(section, address)
        ]
    if picker is None:
        return []
    return await _picker_picks(picker, question, sections)


def _addressed(section: Section, address: Address) -> list[tuple[Section, str]]:
    """The named Absatz first, and the whole § beside it when the § fits.

    "Abs 2 means Abs 2" keeps the citation precise, but read alone it was a
    keyhole: asked for § 2 Abs 2 of the Salzburger Baupolizeigesetz, the agent
    came back for Abs 4, 5 and 3 one lookup at a time (answer suite, 92 s). The
    § under its own key costs one passage and ends that.
    """
    if not address.absatz or len(section.body) > SECTION_MAX_CHARS:
        return [(section, address.absatz)]
    return [(section, address.absatz), (section, "")]


def _is_addressed(section: Section, address: Address) -> bool:
    return section.kind == address.kind and section.number.lower() == address.number.lower()


def _whole_document(fetched: FetchedDocument) -> list[tuple[Section, str]]:
    """A document with no § grammar (a court decision) is one passage, unnumbered."""
    document = fetched.document
    return [(Section(kind="", number="", heading=document.title, body=document.text), "")]


async def _picker_picks(picker, question: str, sections: list[Section]) -> list[tuple[Section, str]]:
    """One picker call over the § HEADINGS; unknown ids are dropped, not guessed."""
    try:
        plan = await picker(question, headings_index(sections))
    except Exception:  # noqa: BLE001 — a failed pick returns the index, never a guess
        logger.warning("ris_lookup: § picker failed, returning the document index instead", exc_info=True)
        return []
    by_label = {_normalize_label(section.label): section for section in sections}
    picked = [by_label.get(_normalize_label(pick.section)) for pick in plan.picks[:MAX_PASSAGES]]
    return [(section, "") for section in picked if section is not None]


def _normalize_label(label: str) -> str:
    """``"§ 63."`` / ``"Artikel 5"`` → ``"§63"`` / ``"art5"`` for lookup."""
    kind, number = section_in(label)
    return f"{kind.lower()}{number.lower()}" if number else label.strip().casefold()
