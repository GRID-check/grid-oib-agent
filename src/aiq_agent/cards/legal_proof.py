"""The server's half of a ``legal_basis`` card: is its wording the source's, and where.

A ``legal_basis`` card is the product's proof: the norm's wording, the project
facts it is applied to, and what follows (``models.LegalBasisCard``). The model
writes all of that. What it cannot write is the one thing that makes the card
checkable: the finding that a passage this turn retrieved holds the wording,
and which passage. That is stamped here, as ``verification``, after the
answer's citations are settled and before the card reaches the reader.

The test is the one the prose's quotes pass (``citation_verification
.quote_coverage`` against ``QUOTE_MATCH_THRESHOLD``), so a sentence the card
calls "wörtlich belegt" is one the answer could have quoted, and the other way
round. Cited passages are tried first, so when two retrieved pages hold the
same sentence the card names the one the answer's ``[N]`` points at. A passage
that was read but not cited still proves the wording; it carries no number.

Fail-safe in one direction only: nothing to check against is ``unchecked``,
never ``verbatim``. A card whose stamp is lost on the way (a later re-validation
discards it, see ``LegalBasisCard._server_owned``) renders as unchecked too.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from aiq_agent.common.citation_verification import MIN_QUOTE_LEN
from aiq_agent.common.citation_verification import QUOTE_MATCH_THRESHOLD
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import quote_coverage
from aiq_agent.common.citation_verification import source_entry_to_wire

LEGAL_BASIS = "legal_basis"

#: What the card needs to open the passage: the same fields a citation chip
#: opens its document from (``source_entry_to_wire``), and nothing that
#: restates the evidence.
_LOCATION_KEYS = ("title", "file_name", "page", "punkt", "url")

#: A cited passage and the ``[N]`` it carries in the answer, or ``None``.
Cited = tuple[SourceEntry, int | None]


def prove_card(card: dict[str, Any], cited: Sequence[Cited], read: Sequence[SourceEntry]) -> dict[str, Any]:
    """``card`` with every ``legal_basis`` in it stamped; any other card is returned as it is.

    A surface's ``legal_basis`` leaves are stamped in place: a leaf is the same
    card, drawn by the same renderer.
    """
    if card.get("type") == LEGAL_BASIS:
        return {**card, "verification": verification_for(card.get("original_text"), cited, read)}
    if card.get("type") != "surface":
        return card
    components = card.get("components", [])
    if not any(component.get("component") == LEGAL_BASIS for component in components):
        return card
    return {
        **card,
        "components": [
            {**component, "verification": verification_for(component.get("original_text"), cited, read)}
            if component.get("component") == LEGAL_BASIS
            else component
            for component in components
        ],
    }


def verification_for(quote: Any, cited: Sequence[Cited], read: Sequence[SourceEntry]) -> dict[str, Any]:
    """The stamp for one wording: ``verbatim`` with the passage that holds it, ``not_found``, or ``unchecked``."""
    text = quote.strip() if isinstance(quote, str) else ""
    candidates = _candidates(cited, read)
    # A short span ("§ 3", "GK 4") matches half the corpus; the prose's check
    # skips it for that reason and so does this one.
    if len(text) < MIN_QUOTE_LEN or not candidates:
        return {"status": "unchecked"}
    for entry, number in candidates:
        if quote_coverage(text, entry.chunk_text or "") >= QUOTE_MATCH_THRESHOLD:
            return _located(entry, number)
    return {"status": "not_found"}


def _candidates(cited: Sequence[Cited], read: Sequence[SourceEntry]) -> list[Cited]:
    """The passages with text to check against, cited ones first, each once."""
    seen = {id(entry) for entry, _ in cited}
    ordered = [*cited, *((entry, None) for entry in read if id(entry) not in seen)]
    return [(entry, number) for entry, number in ordered if entry.chunk_text]


def _located(entry: SourceEntry, number: int | None) -> dict[str, Any]:
    wire = source_entry_to_wire(entry, number=number)
    location = {key: wire[key] for key in _LOCATION_KEYS if key in wire}
    return {"status": "verbatim", **({"number": number} if number is not None else {}), **location}
