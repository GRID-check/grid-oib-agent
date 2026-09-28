"""Blocks of an answer that say again what another block already says.

The prompt asks for a table AND, "where the parts hang together", a mindmap.
Live answers (September 2026 census) drew the mindmap anyway, as the table's
rows in boxes: first a root and four leaves, then, once the prompt asked for a
level beneath the parts, a level that only repeated each part's number. The
shape passed; the drawing still said nothing the table had not.

So the test is what the drawing SAYS, not its shape: a mindmap whose words are
nearly all words of a table in the same answer is that table drawn again, and
is removed. Measured on the census: the two redundant mindmaps scored 0.8 and
0.9, the prompt's own example (a level saying what each part covers) 0.3.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

#: Share of a mindmap's words a table beside it may already hold before the
#: drawing counts as the table again. Between the census's 0.8 and 0.3.
MINDMAP_TABLE_COVERAGE = 0.7

_MERMAID_FENCE = re.compile(r"\n?```mermaid[ \t]*\n(?P<body>.*?)\n```[ \t]*\n?", re.DOTALL)
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)
_WORD = re.compile(r"[a-zäöüß0-9]{4,}")
#: A node's text: quoted, or inside the shape brackets mindmap syntax allows.
_NODE_TEXT = re.compile(r'"([^"]+)"|[\[(]{1,2}([^\])"]+)[\])]{1,2}')


def _words(text: str) -> set[str]:
    """Meaning-carrying words, clipped to a crude stem so „Garage"/„Garagen" match."""
    return {word[:5] for word in _WORD.findall(re.sub(r"\[\d+\]|\*\*", " ", text.lower()))}


def _mindmap_words(body: str) -> set[str]:
    lines = body.splitlines()
    if not lines or lines[0].strip() != "mindmap":
        return set()
    labels: list[str] = []
    for line in lines[1:]:
        found = _NODE_TEXT.findall(line)
        labels.extend(quoted or bracketed for quoted, bracketed in found)
        if not found and line.strip():
            labels.append(line.strip())
    return _words(" ".join(labels))


def _redraws(body: str, table_words: set[str]) -> bool:
    words = _mindmap_words(body)
    return bool(words) and len(words & table_words) / len(words) >= MINDMAP_TABLE_COVERAGE


def restates_table(fence: str, prose: str) -> bool:
    """Whether the closed ```mermaid ``fence`` is a mindmap that only redraws a table in ``prose``.

    The live relay's question (``LiveAnswer.restates``): it holds a mindmap
    fence until it closes and asks this against the prose already sent, so a
    drawing the settle would remove never reaches the screen. The same test
    ``drop_restated_mindmaps`` runs, so the two cannot disagree about a table
    that came first.
    """
    table_words = _words("\n".join(_TABLE_ROW.findall(prose)))
    match = _MERMAID_FENCE.search(fence)
    return bool(table_words) and match is not None and _redraws(match.group("body"), table_words)


def drop_restated_mindmaps(content: str) -> tuple[str, int]:
    """``content`` without the mindmaps that only redraw a table in it; how many went."""
    table_words = _words("\n".join(_TABLE_ROW.findall(content)))
    if not table_words:
        return content, 0
    dropped = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal dropped
        if not _redraws(match.group("body"), table_words):
            return match.group(0)
        dropped += 1
        return "\n\n"

    cleaned = _MERMAID_FENCE.sub(replace, content)
    if dropped:
        logger.info("answer shape: dropped %d mindmap(s) that only redraw a table", dropped)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned, dropped
