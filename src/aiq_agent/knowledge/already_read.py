"""Conversation-scoped "already read" digest: what THIS conversation opened.

Cross-turn amnesia looked like this: turn 1 opened ``oib-rl_2_ausgabe_mai_2023.pdf``
at Pkt. 3.5.2, turn 2 asked a follow-up naming the same document, and the model
paid a full ``knowledge_search`` — competing by similarity with every
neighbouring requirement — for a passage it could already address with the
``read_passage`` locator. The inventory cannot fix that: it proves a file
EXISTS, not that it was read.

This module is the missing half: one line per document this conversation
already opened — ``"<file> | <collection> | Seiten <p> | Punkte <n> | Turn <k>"``
— merged at turn end from :func:`get_turn_captures`, persisted on
``ConversationState`` for the life of the conversation, and rendered right
after the document inventory as ``## Bereits gelesen (diese Unterhaltung)``.

Deliberate non-goals, each a sentence so the next reader does not re-litigate:

- NOT project memory: the digest rides the conversation checkpoint (same
  lifetime as ``messages``), never the memory store, so no other conversation
  ever sees it. Single conversation scope only.
- NOT lessons: nothing is anonymized or distilled across conversations here.
- No key versioning: a stale entry (a newer edition filed since) is not
  detected up front — ``read_passage`` answers it with no-passage/unknown and
  the turn falls back to ``knowledge_search`` (miss-then-search).
- Index, not evidence: a line proves the document was OPENED, not that its
  wording is in front of the model now. Quoting or citing re-opens the passage
  with ``read_passage`` under the exact digest name; the digest line itself is
  never cited.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)

#: Heading of the rendered block, the anchor the prompt rule names.
DIGEST_HEADING = "## Bereits gelesen (diese Unterhaltung)"

#: How many documents the digest keeps. Past this the oldest entries drop out,
#: most-recent-first retention, so the digest is the recent working set.
MAX_DIGEST_DOCS = 20

#: Approximate token budget for the whole digest (the entry lines only, not the
#: explanation around them). Tokens are estimated as characters // 4; past this the oldest
#: entries drop out exactly like past the document cap.
MAX_DIGEST_TOKENS = 800


@dataclass
class DigestEntry:
    """One digested document: identity plus the loci this conversation opened."""

    file_name: str
    collection: str
    pages: set[int] = field(default_factory=set)
    punkts: set[str] = field(default_factory=set)
    turn: int = 1


def estimate_tokens(text: str) -> int:
    """Rough token count for budget enforcement: characters // 4, at least 1."""
    return max(1, len(text) // 4)


def _punkt_sort_key(raw: str) -> tuple:
    """Numeric Punkt ordering (``3.5.2`` before ``3.12``), then lexicographic."""
    try:
        numbered = tuple(int(part) for part in raw.split(".")) if raw else ()
    except ValueError:
        numbered = ()
    return (numbered, raw)


def format_digest_line(
    file_name: str, collection: str, pages: set[int] | Sequence[int], punkts: set[str] | Sequence[str], turn: int
) -> str:
    """One digest line: ``"<file> | <collection> | Seiten <p> | Punkte <n> | Turn <k>"``."""
    ordered_pages = sorted({int(page) for page in pages})
    ordered_punkts = sorted({str(punkt) for punkt in punkts if str(punkt).strip()}, key=_punkt_sort_key)
    pages_bit = ", ".join(str(page) for page in ordered_pages) if ordered_pages else "-"
    punkts_bit = ", ".join(ordered_punkts) if ordered_punkts else "-"
    return f"{file_name} | {collection} | Seiten {pages_bit} | Punkte {punkts_bit} | Turn {max(1, int(turn))}"


def parse_digest_line(line: str) -> DigestEntry | None:
    """Parse a digest line back into an entry; ``None`` when malformed.

    Fail-open on purpose: the digest is re-parsed every turn to merge the new
    captures, and one hand-edited or version-skewed line must not lose the rest.
    """
    parts = [part.strip() for part in str(line or "").split(" | ")]
    if len(parts) != 5:
        return None
    file_name, collection, seiten, punkte, turn_bit = parts
    if not file_name or not collection or not seiten.startswith("Seiten ") or not punkte.startswith("Punkte "):
        return None
    if not turn_bit.startswith("Turn "):
        return None
    try:
        turn = max(1, int(turn_bit[len("Turn ") :].strip()))
    except ValueError:
        return None
    pages: set[int] = set()
    raw_pages = seiten[len("Seiten ") :].strip()
    if raw_pages and raw_pages != "-":
        for token in raw_pages.split(","):
            try:
                pages.add(int(token.strip()))
            except ValueError:
                return None
    punkts: set[str] = set()
    raw_punkts = punkte[len("Punkte ") :].strip()
    if raw_punkts and raw_punkts != "-":
        punkts = {token.strip() for token in raw_punkts.split(",") if token.strip()}
        if not punkts:
            return None
    return DigestEntry(file_name=file_name, collection=collection, pages=pages, punkts=punkts, turn=turn)


def _capture_identity(entry: Any) -> tuple[str, str, str, str] | None:
    """The ``(key, file, collection, display)`` of a capture, or ``None`` to skip it.

    Only knowledge documents digest: an entry needs a citation key whose
    filename looks like a file (an extension in the basename, the same test the
    citation wire uses), so bare tool-result sources and URL-only hits never
    become digest lines. The key is ``(collection, filename)`` case-folded — the
    registry's own document identity — while the display keeps first-seen
    spelling, which is what ``read_passage`` resolves verbatim.
    """
    from aiq_agent.common.citation_verification import _parse_citation_key

    citation_key = getattr(entry, "citation_key", None) or ""
    if not citation_key:
        return None
    file_name, _page = _parse_citation_key(citation_key)
    file_name = (file_name or "").strip()
    if not file_name or "." not in file_name.rsplit("/", 1)[-1]:
        return None
    collection = str(getattr(entry, "collection", None) or "").strip() or "-"
    return (f"{collection.casefold()}\x1f{file_name.casefold()}", file_name, collection, citation_key)


def _capture_page(entry: Any) -> int | None:
    from aiq_agent.common.citation_verification import _parse_citation_key

    _file_name, page = _parse_citation_key(getattr(entry, "citation_key", None) or "")
    return page


def _capture_punkt(entry: Any) -> str | None:
    punkt = str(getattr(entry, "punkt", None) or "").strip()
    return punkt or None


def merge_digest(previous: Sequence[str] | None, captures: Sequence[Any], turn: int) -> list[str] | None:
    """Merge this turn's captures into the previous digest lines.

    Dedupe is per ``(collection, filename)`` with page/Punkt sets unioned and
    ``Turn`` set to the current turn; an updated document moves to the end
    (most-recent-first retention is by POSITION, never by the Turn number,
    which is display only and may run low again after history trimming).
    Over either cap — 20 documents or ~800 tokens — the oldest entries drop
    out. ``None`` when nothing digestible remains, so the field stays absent
    rather than empty.
    """
    current = max(1, int(turn))
    merged: OrderedDict[str, DigestEntry] = OrderedDict()
    for line in previous or ():
        parsed = parse_digest_line(line)
        if parsed is None:
            continue
        key = f"{parsed.collection.casefold()}\x1f{parsed.file_name.casefold()}"
        known = merged.get(key)
        if known is None:
            merged[key] = parsed
        else:
            known.pages |= parsed.pages
            known.punkts |= parsed.punkts
            known.turn = max(known.turn, parsed.turn)
    for entry in captures or ():
        identity = _capture_identity(entry)
        if identity is None:
            continue
        key, file_name, collection, _citation_key = identity
        page = _capture_page(entry)
        punkt = _capture_punkt(entry)
        known = merged.get(key)
        if known is None:
            merged[key] = DigestEntry(
                file_name=file_name,
                collection=collection,
                pages={page} if page is not None else set(),
                punkts={punkt} if punkt else set(),
                turn=current,
            )
        else:
            if page is not None:
                known.pages.add(page)
            if punkt:
                known.punkts.add(punkt)
            known.turn = current
            merged.move_to_end(key)
    lines = [
        format_digest_line(item.file_name, item.collection, item.pages, item.punkts, item.turn)
        for item in merged.values()
    ]
    while len(lines) > MAX_DIGEST_DOCS:
        lines.pop(0)
    while len(lines) > 1 and sum(estimate_tokens(line) for line in lines) > MAX_DIGEST_TOKENS:
        lines.pop(0)
    return lines or None


def render_already_read_block(digest: Sequence[str] | None) -> str:
    """The prompt block for a digest, or ``""`` when there is nothing digested.

    Carries the index-not-evidence rule and the bound in the text the model
    reads, the same obligation the inventory block holds: bounded, and saying
    so where the cost is paid.
    """
    lines = [line.strip() for line in (digest or []) if line and line.strip()]
    if not lines:
        return ""
    return "\n".join(
        [
            DIGEST_HEADING,
            "Dokumente, die in DIESER Unterhaltung bereits geöffnet wurden — ein Index, KEIN Beleg: "
            "Eine Zeile beweist, dass das Dokument geöffnet wurde, nicht dass sein Wortlaut jetzt vorliegt. "
            "Zitieren oder wörtlich anführen erst nach erneutem Öffnen mit `read_passage` und dem exakten "
            "Namen aus der Zeile; die Digest-Zeile selbst wird nie zitiert.",
            f"Begrenzt auf höchstens {MAX_DIGEST_DOCS} Dokumente / ca. {MAX_DIGEST_TOKENS} Tokens — "
            "ältere Einträge fallen heraus; was hier fehlt, ist damit nicht widerlegt, sondern per "
            "`knowledge_search` zu suchen. Einträge können veraltet sein (neuere Fassung abgelegt): "
            "Meldet `read_passage` „no passage“/„unknown document“, per `knowledge_search` neu auflösen.",
            *[f"- {line}" for line in lines],
        ]
    )
