"""Captioned tables in a Richtlinie: read as tables, indexed as tables.

The requirements the OIB states per Gebäudeklasse live in tables (Tabelle 1a,
1b, 2a, 3 …), and page text extraction reads a table row by row ACROSS its
columns. Tabelle 3 of OIB-Richtlinie 2 reached the model as "an der obersten an
der obersten an der obersten Stelle des Treppen- Stelle des Treppen- …": the
four Gebäudeklassen interleaved, no value attributable to a column. In the
September 2026 census the agent then searched „Tabelle 3 GK 4 REI 60" round
after round for a legible copy (three extra research calls, ~15 s), or gave up
and answered "Anforderungen der Tabelle 3" without a single value.

pdfplumber's table finder reads the same page correctly, one row per
requirement and one column per GK. So a table that carries a caption („Tabelle
3: …"), or continues one from the previous page, is taken OUT of the page text
and indexed on its own: a Markdown table under its caption, split into row
groups that each repeat the header so no chunk loses its columns, addressable
as ``punkt_id = "Tabelle 3"`` exactly as a Punkt is.

Only captioned tables: a ruled box without a caption may be a note or a form,
and removing it from the text would lose prose. Everything here is pure except
:func:`extract_page_tables`, which reads a pdfplumber page.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from dataclasses import field
from typing import Any

#: „Tabelle 3: Anforderungen an …", „Tabelle 1a: …". The caption's own line.
CAPTION_RE = re.compile(r"^Tabelle\s+(?P<id>\d+[a-z]?)\s*:\s*(?P<title>.*)$")
#: How far above a table its caption may sit, in PDF points (the corpus: 12-40).
_CAPTION_REACH = 72
#: A caption-less table this close to the top of a page continues the last
#: captioned table of the previous page.
_CONTINUATION_TOP = 140
#: One chunk's Markdown, header included; ~500 tokens, far inside the
#: splitter's budget, so a group is never cut into a headerless tail.
MAX_CHUNK_CHARS = 1600


@dataclass
class PageTable:
    """One captioned table (or a continuation of one) found on one page."""

    table_id: str
    title: str
    rows: list[list[str]]
    page_number: int
    continuation: bool = False


@dataclass
class Table:
    """A whole table, its fragments joined across pages."""

    table_id: str
    title: str
    rows: list[list[str]]
    page_start: int
    page_end: int
    header_rows: int = 1
    pages: list[int] = field(default_factory=list)


def _clean(cell: Any) -> str:
    return re.sub(r"\s+", " ", str(cell or "")).strip().replace("|", "/")


def _caption_above(page: Any, top: float) -> tuple[str, str] | None:
    """The „Tabelle N: title" standing just above ``top``, title joined across its lines."""
    region = page.within_bbox((0, max(0.0, top - _CAPTION_REACH), page.width, max(1.0, top)))
    lines = [line.strip() for line in (region.extract_text() or "").splitlines() if line.strip()]
    for index in range(len(lines) - 1, -1, -1):
        match = CAPTION_RE.match(lines[index])
        if match:
            title = " ".join([match.group("title"), *lines[index + 1 :]]).strip()
            return match.group("id"), title
    return None


def _continues(previous: PageTable | None, page_number: int) -> bool:
    """Whether a caption-less table on ``page_number`` may continue ``previous``: the very next page only."""
    return previous is not None and page_number == previous.page_number + 1


def extract_page_tables(page: Any, page_number: int, previous: PageTable | None) -> list[tuple[PageTable, tuple]]:
    """The captioned tables on ``page`` (and a continuation of ``previous``), with their bboxes."""
    found: list[tuple[PageTable, tuple]] = []
    for table in page.find_tables():
        rows = [[_clean(cell) for cell in row] for row in (table.extract() or [])]
        rows = [row for row in rows if any(row)]
        if len(rows) < 2 or len(rows[0]) < 2:
            continue
        caption = _caption_above(page, table.bbox[1])
        if caption:
            found.append((PageTable(caption[0], caption[1], rows, page_number), table.bbox))
        elif _continues(previous, page_number) and not found and table.bbox[1] < _CONTINUATION_TOP:
            found.append(
                (PageTable(previous.table_id, previous.title, rows, page_number, continuation=True), table.bbox)
            )
    return found


def _header_rows(rows: list[list[str]]) -> int:
    """Row 0 is the header; row 1 too when it only subdivides a column (its first cell empty)."""
    return 2 if len(rows) > 2 and not rows[1][0] and any(rows[1][1:]) else 1


def join_fragments(fragments: list[PageTable]) -> list[Table]:
    """Fragments in page order joined into tables; a repeated header on a continuation is dropped."""
    tables: list[Table] = []
    for fragment in fragments:
        if fragment.continuation and tables and tables[-1].table_id == fragment.table_id:
            table = tables[-1]
            rows = fragment.rows
            header = table.rows[: table.header_rows]
            if rows[: len(header)] == header:
                rows = rows[len(header) :]
            table.rows.extend(rows)
            table.page_end = fragment.page_number
            table.pages.append(fragment.page_number)
            continue
        tables.append(
            Table(
                table_id=fragment.table_id,
                title=fragment.title,
                rows=list(fragment.rows),
                page_start=fragment.page_number,
                page_end=fragment.page_number,
                header_rows=_header_rows(fragment.rows),
                pages=[fragment.page_number],
            )
        )
    return tables


def _markdown_row(row: list[str], width: int) -> str:
    cells = [*row, *[""] * (width - len(row))][:width]
    return "| " + " | ".join(cells) + " |"


def _header_markdown(table: Table, width: int) -> list[str]:
    header = table.rows[: table.header_rows]
    if not header:
        # A fragment read without its table's header: an empty header row, so
        # no data row is promoted to column labels.
        return [_markdown_row([], width), "|" + "---|" * width]
    if len(header) == 2:
        # A two-row header („GK 5" over „≤ 6 / > 6 Geschoße") becomes one row of
        # joined labels, so every column still names what it holds.
        merged, last = [], ""
        for top, sub in zip(header[0] + [""] * width, header[1] + [""] * width, strict=False):
            last = top or last
            merged.append(f"{last} {sub}".strip() if sub else top)
        header = [merged[:width]]
    return [_markdown_row(header[0], width), "|" + "---|" * width]


def markdown_chunks(table: Table, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    """The table as Markdown, cut into row groups under ``max_chars``, each with the header."""
    width = max(len(row) for row in table.rows)
    head = _header_markdown(table, width)
    head_chars = sum(len(line) + 1 for line in head)
    chunks: list[list[str]] = [[]]
    size = head_chars
    for row in table.rows[table.header_rows :]:
        line = _markdown_row(row, width)
        if chunks[-1] and size + len(line) + 1 > max_chars:
            chunks.append([])
            size = head_chars
        chunks[-1].append(line)
        size += len(line) + 1
    return ["\n".join([*head, *body]) for body in chunks if body]


def page_text_with_tables(text: str, tables: list[PageTable]) -> str:
    """A page's text with its tables appended as Markdown, for the per-page path.

    A document without a Punkt outline is indexed per page; its tables were cut
    out of the page text, so they are put back here, legible, rather than lost.
    A continuation is rendered on its own page without its table's header, so
    its rows are all body under an empty header row: its first row is data
    unless the PDF repeated the header, and either way it is not a label.
    """
    parts = [text] if text else []
    for fragment in tables:
        table = join_fragments([fragment])[0]
        if fragment.continuation:
            table.header_rows = 0
        caption = f"Tabelle {table.table_id}: {table.title}" if not fragment.continuation else ""
        body = "\n".join(markdown_chunks(table, max_chars=10**9))
        parts.append("\n\n".join(part for part in (caption, body) if part))
    return "\n\n".join(parts)
