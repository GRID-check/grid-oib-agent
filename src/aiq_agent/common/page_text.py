"""Page furniture: running headers and footers, found by repetition. Pure.

A document's pages repeat their edges: a title line, „Seite 2 von 14“, a firm's
address. Those lines are not the text; they stand between the end of one page
and the start of the next. Chunking leaves them out so a section reads on
across a page break (``knowledge_layer.llamaindex.section_chunking``), and the
upload screen leaves them out so a number or a word split across a page break
is read whole (``knowledge_layer.llamaindex.screening.screen_pages``).

An edge line (one of a page's first or last two) is furniture when, with its
digits read as ``#``, it repeats on at least half the pages and on at least
three: a page number changes, the line does not.

It lives in ``aiq_agent.common`` so both can import it without loading
LlamaIndex.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from collections.abc import Sequence

#: An edge line repeating on this share of the pages is furniture…
FURNITURE_PAGE_SHARE = 0.5
#: …and on at least this many pages: fewer pages give no repetition to go by.
FURNITURE_MIN_PAGES = 3

_DIGITS = re.compile(r"\d+")


def furniture_key(line: str) -> str:
    """The form furniture is compared in: lowercase, every run of digits read as ``#``."""
    return _DIGITS.sub("#", line.strip().lower())


def running_furniture(pages: Sequence[Sequence[str]]) -> set[str]:
    """The keys of the edge lines that repeat on most pages; empty for fewer than three pages."""
    if len(pages) < FURNITURE_MIN_PAGES:
        return set()
    counts: Counter[str] = Counter()
    for lines in pages:
        counts.update({furniture_key(line) for line in [*lines[:2], *lines[-2:]]})
    threshold = max(FURNITURE_MIN_PAGES, FURNITURE_PAGE_SHARE * len(pages))
    return {key for key, count in counts.items() if count >= threshold and key}


def without_furniture(lines: Iterable[str], furniture: set[str]) -> list[str]:
    """``lines`` without those that are furniture."""
    return [line for line in lines if furniture_key(line) not in furniture]
