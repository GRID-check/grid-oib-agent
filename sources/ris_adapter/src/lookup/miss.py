"""What a lookup says when it found nothing.

Never empty and never a bare error, because an empty tool result is the one
thing that reliably produces an invented citation. Four facts, the same four
``knowledge_search``'s ``_empty_search_message`` carries, in RIS's vocabulary:

1. what was actually SEARCHED — the planner's terms, not the user's words, so
   the model can see the rewrite it did not write;
2. which Bundesland was assumed and WHERE THAT CAME FROM. A wrong jurisdiction
   is the commonest silent RIS failure, and ``focus_entries`` drops other
   states' law without saying so;
3. what matched but was not read, including the catalog's honest "Not in RIS"
   cases — the second of which hands the web tool its next move;
4. ONE concrete retry.

A document that was READ but answers nothing returns its § headings, labelled
as an index rather than as evidence: "the law is here, these are its
paragraphs, none of them answers this" is a real answer, and it is the one that
lets the next round ask a better question instead of guessing.
"""

from __future__ import annotations

from ris_adapter.lookup.address import Address
from ris_adapter.lookup.address import land_sentence
from ris_adapter.lookup.trace import LookupTrace
from ris_adapter.register import _KONSOLIDIERT_APPLICATIONS


def miss_message(question: str, address: Address, trace: LookupTrace) -> str:
    """The four facts, in order, ending in one retry."""
    lines = [
        f"No RIS passage answered {question.strip()!r}.",
        f"Searched: {trace.searched or repr(question.strip())}"
        + (f" in RIS application {trace.application}." if trace.application else "."),
        land_sentence(address),
    ]
    lines.extend(_candidate_lines(trace))
    lines.extend(_headings_lines(trace))
    lines.append(_retry_line(address, trace))
    return "\n".join(lines)


def _candidate_lines(trace: LookupTrace) -> list[str]:
    """The documents that matched but were not read, with the reason."""
    unread = [candidate for candidate in trace.candidates if candidate.url not in trace.fetched]
    if not unread:
        return []
    return ["Matched but not read:"] + [
        f"  - {candidate.title or candidate.citation_url}: "
        f"{candidate.unavailable or candidate.citation_url or candidate.url}"
        for candidate in unread
    ]


def _headings_lines(trace: LookupTrace) -> list[str]:
    """A fetched document with no answering § returns its INDEX, not evidence."""
    if not trace.headings:
        return []
    return [
        "",
        "The document was read; no § in it answers the question. Its paragraphs (INDEX, not evidence):",
        *trace.headings,
    ]


def _retry_line(address: Address, trace: LookupTrace) -> str:
    """ONE concrete retry, chosen by what is missing."""
    if not address.bundesland:
        return "Retry once: name the Bundesland, e.g. jurisdiction='Wien'."
    if not address.law and not trace.candidates:
        return "Retry once: name the law, e.g. instrument='Bauordnung für Wien'."
    if not trace.application or trace.application in _KONSOLIDIERT_APPLICATIONS:
        return "Retry once with application='Vwgh' (or 'Vfgh'/'Justiz') if the answer is case law, not statute."
    return "Retry once with a different statutory term in the question, or name the § directly."
