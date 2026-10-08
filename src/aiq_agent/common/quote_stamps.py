"""The server's stamp on each quote line of an answer: is its wording the source's, and where.

The answer's proof is a quote line, ``> „…“ [N]`` (ADR-0069): the wording the
answer turns on, verbatim. The model writes it. What it cannot write is the one
fact that makes it checkable: that a passage this turn's registry holds carries
the wording, and which passage. That is stamped here, once the citations are
settled and renumbered, and travels to the reader as ``TurnResult.quote_stamps``
(one entry per quote line, in document order). The excerpt renders „Wortlaut
belegt [N]" and „Stelle öffnen" off this stamp and off nothing the model wrote.

The test is the one the prose's quotes pass (``citation_verification``'s
coverage against ``QUOTE_MATCH_THRESHOLD``, over the same registry
``verify_quoted_spans`` reads), so a line stamped ``not_found`` is one the prose
check flagged too, and the other way round. Candidates are tried in order: the
passages the line's own ``[N]`` names, then the rest the answer cites, then
what was read and not cited; so when two pages hold the same sentence the stamp
names the one the chip opens. A passage read but not cited still proves the
wording; it carries no number.

Fail-safe in one direction only: nothing to check against, or a span too short
to mean anything (``MIN_QUOTE_LEN``), is ``unchecked``, never ``verbatim``.

Ported from ``cards/legal_proof.py`` on ``claude/relaxed-rubin-pvwcsn``, where
it stamped the retired ``legal_basis`` card; the check is the same, its subject
is now the prose's own quote line.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from collections.abc import Sequence
from typing import Any

from aiq_agent.common.citation_verification import MIN_QUOTE_LEN
from aiq_agent.common.citation_verification import QUOTE_MATCH_THRESHOLD
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import quote_coverage
from aiq_agent.common.citation_verification import source_entry_to_wire

#: What the reader needs to open the passage: the fields a citation chip opens
#: its document from (``source_entry_to_wire``), and nothing that restates it.
_LOCATION_KEYS = ("title", "file_name", "page", "punkt", "url")

#: A cited passage and the ``[N]`` it carries in the answer, or ``None``.
Cited = tuple[SourceEntry, int | None]

#: A quote line: ``>`` then a quoted span first on the line, then whatever
#: follows it (the ``[N]``, maybe the unverified-quote marker). German „…“ (and
#: the lenient closers models mix in), guillemets, curly and straight quotes, as
#: ``_QUOTED_SPAN_RE`` reads them.
_QUOTE_LINE = re.compile(
    r"^[ \t]*(?:>[ \t]?)+[ \t]*"
    r"(?:„(?P<low>[^„“”\"]+)[“”\"]|»(?P<guillemet>[^»«]+)«|“(?P<curly>[^“”]+)”|\"(?P<straight>[^\"]+)\")"
    r"(?P<rest>.*)$"
)
_FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
_NUMBER = re.compile(r"\[(\d+)\]")
#: ``==decisive words==`` (answer-richness Phase B) are the model's emphasis, not the source's.
_MARK = re.compile(r"==")


def quote_lines(text: str) -> Iterator[tuple[str, tuple[int, ...]]]:
    """Each quote line outside code: ``(the wording as written, the [N] after it)``."""
    fence: str | None = None
    for line in text.split("\n"):
        fence_match = _FENCE.match(line)
        if fence is not None:
            if fence_match and fence_match.group(1)[0] == fence[0] and len(fence_match.group(1)) >= len(fence):
                fence = None
            continue
        if fence_match:
            fence = fence_match.group(1)
            continue
        match = _QUOTE_LINE.match(line)
        if match is None:
            continue
        wording = next(group for group in match.group("low", "guillemet", "curly", "straight") if group is not None)
        yield wording.strip(), tuple(int(number) for number in _NUMBER.findall(match.group("rest")))


def stamp_quote_lines(text: str, cited: Sequence[Cited], read: Sequence[SourceEntry]) -> list[dict[str, Any]]:
    """One stamp per quote line of ``text``, in document order; empty when it quotes nothing.

    ``cited`` is the answer's cited passages with their final ``[N]``; ``read``
    every passage the check may consult (the registry, as the prose check reads it).
    """
    return [
        {"text": wording, **verification_for(wording, _own_first(cited, numbers), read)}
        for wording, numbers in quote_lines(text)
    ]


def verification_for(quote: Any, cited: Sequence[Cited], read: Sequence[SourceEntry]) -> dict[str, Any]:
    """The stamp for one wording: ``verbatim`` with the passage that holds it, ``not_found``, or ``unchecked``."""
    text = _MARK.sub("", quote).strip() if isinstance(quote, str) else ""
    candidates = _candidates(cited, read)
    # A short span („§ 3", „GK 4") matches half the corpus; the prose check
    # skips it for that reason and so does this one.
    if len(text) < MIN_QUOTE_LEN or not candidates:
        return {"status": "unchecked"}
    for entry, number in candidates:
        if quote_coverage(text, entry.chunk_text or "") >= QUOTE_MATCH_THRESHOLD:
            return _located(entry, number)
    return {"status": "not_found"}


def _own_first(cited: Sequence[Cited], numbers: tuple[int, ...]) -> list[Cited]:
    """The cited passages, the ones the line's own ``[N]`` names first."""
    own = [pair[1] is not None and pair[1] in numbers for pair in cited]
    return [pair for pair, mine in zip(cited, own, strict=True) if mine] + [
        pair for pair, mine in zip(cited, own, strict=True) if not mine
    ]


def _candidates(cited: Sequence[Cited], read: Sequence[SourceEntry]) -> list[Cited]:
    """The passages with text to check against, cited ones first, each once."""
    seen = {id(entry) for entry, _ in cited}
    ordered = [*cited, *((entry, None) for entry in read if id(entry) not in seen)]
    return [(entry, number) for entry, number in ordered if entry.chunk_text]


def _located(entry: SourceEntry, number: int | None) -> dict[str, Any]:
    wire = source_entry_to_wire(entry, number=number)
    location = {key: wire[key] for key in _LOCATION_KEYS if key in wire}
    return {"status": "verbatim", **({"number": number} if number is not None else {}), **location}
