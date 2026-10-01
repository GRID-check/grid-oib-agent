"""Plain-text formats with locators: Markdown sections, text paragraphs, CSV row groups.

These went through ``SimpleDirectoryReader``, which made each file ONE ``Document``
with no ``page_label`` -- citable only as the whole file, and unreachable for
``read_passage`` -- and read it as UTF-8 with ``errors="ignore"``, so a cp1252 export
from Excel lost every umlaut without a trace („Geschoßfläche" became „Geschofläche").

Each format is now cut on its own structure, and every chunk carries a locator in
``punkt_id`` -- the key ``read_passage(punkt=…)`` addresses and the grounding block
prints as ``Punkt:``:

* ``.md``: one section per ATX heading (``#`` … ``######``, outside code fences),
  addressed by its heading path (``Geschoße`` or ``Brandschutz › Fluchtwege``) and
  prefixed with that breadcrumb. The IFC digest is Markdown and gains its sections
  here too.
* ``.txt``: paragraph blocks, packed to the chunk budget, addressed ``Zeilen 12-30``.
* ``.csv``/``.tsv``: row groups sized to the budget, each repeating the header row,
  addressed by the file lines they hold (``Zeilen 2-41``).

``page_label`` is left unset: a line range is not a page, and the citation layer reads
a numeric ``page_label`` as a page to open.

Bytes are decoded by :func:`decode_text`: a BOM decides; else strict UTF-8; else cp1252;
else Latin-1, which maps every byte. Nothing is dropped, and the encoding used is
recorded on every chunk (``source_encoding``).
"""

from __future__ import annotations

import codecs
import csv
import io
import re
from pathlib import Path
from typing import TYPE_CHECKING
from typing import Any

from knowledge_layer.llamaindex.section_chunking import ATX_HEADING_RE
from knowledge_layer.llamaindex.section_chunking import BREADCRUMB_SEP
from knowledge_layer.llamaindex.section_chunking import Line
from knowledge_layer.llamaindex.section_chunking import apply_exclusions
from knowledge_layer.llamaindex.section_chunking import pack

if TYPE_CHECKING:  # pragma: no cover - typing only
    from llama_index.core import Document

MARKDOWN_EXTENSIONS = frozenset({".md", ".markdown"})
TEXT_EXTENSIONS = frozenset({".txt"})
DELIMITED_EXTENSIONS = frozenset({".csv", ".tsv"})
SUPPORTED_EXTENSIONS = MARKDOWN_EXTENSIONS | TEXT_EXTENSIONS | DELIMITED_EXTENSIONS

#: Characters of Markdown per CSV row group, header included: the same budget a
#: captioned PDF table's group gets (``captioned_tables.MAX_CHUNK_CHARS``).
_MAX_GROUP_CHARS = 1600
_MAX_CELL_CHARS = 500

_BOMS = (
    (codecs.BOM_UTF8, "utf-8-sig"),
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)
_FENCE_RE = re.compile(r"^\s*(```|~~~)")


def decode_text(data: bytes) -> tuple[str, str]:
    """``(text, encoding)``: BOM, else strict UTF-8, else cp1252, else Latin-1. Never lossy.

    cp1252 before Latin-1 because Windows exports put „ " – € in 0x80-0x9F, which
    Latin-1 reads as control characters. Latin-1 is the floor: it maps every byte, so a
    file in neither encoding is still read whole rather than silently shortened.
    """
    for bom, encoding in _BOMS:
        if data.startswith(bom):
            return data.decode(encoding), encoding
    for encoding in ("utf-8", "cp1252"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1"), "latin-1"


def _document(text: str, metadata: dict[str, Any]) -> Document:
    from llama_index.core import Document

    document = Document(text=text, metadata=metadata)
    apply_exclusions(document)
    return document


# --- Markdown ---------------------------------------------------------------------------


def _markdown_sections(lines: list[str]) -> list[tuple[list[str], int, list[Line]]]:
    """``[(heading path, level, lines)]``; the text before the first heading has an empty path."""
    sections: list[tuple[list[str], int, list[Line]]] = [([], 0, [])]
    stack: list[tuple[int, str]] = []
    fenced = False
    for number, raw in enumerate(lines, start=1):
        if _FENCE_RE.match(raw):
            fenced = not fenced
        match = None if fenced else ATX_HEADING_RE.match(raw)
        if match is None:
            sections[-1][2].append(Line(number, raw.rstrip()))
            continue
        level = len(match.group("hashes"))
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, match.group("title").strip()))
        sections.append(([title for _level, title in stack], level, [Line(number, raw.rstrip())]))
    return [section for section in sections if any(line.text.strip() for line in section[2])]


def _title_level(sections: list[tuple[list[str], int, list[Line]]]) -> int:
    """1 when the document opens with its only ``#`` heading -- a title, not a section."""
    top = [section for section in sections if section[1] == 1]
    headed = [section for section in sections if section[0]]
    return 1 if len(top) == 1 and headed and headed[0] is top[0] else 0


def _markdown_locator(path: list[str], skip_title: int, taken: set[str]) -> str:
    """The section's address: its path under the document title, last two headings at most."""
    parts = path[skip_title:] or path
    base = BREADCRUMB_SEP.join(parts[-2:])
    candidate, counter = base, 1
    while candidate in taken:
        counter += 1
        candidate = f"{base} ({counter})"
    taken.add(candidate)
    return candidate


def _markdown_locator_fields(path: list[str], level: int, skip_title: int, taken: set[str]) -> dict[str, Any]:
    """``punkt_*`` fields of one section. The document title has no depth: it is not a chapter."""
    fields: dict[str, Any] = {
        "punkt_id": _markdown_locator(path, skip_title, taken),
        "punkt_title": path[-1],
        "punkt_path": BREADCRUMB_SEP.join(path),
    }
    if level - skip_title >= 1:
        fields["punkt_depth"] = level - skip_title
    return fields


def markdown_documents(text: str, base: dict[str, Any]) -> list[Document]:
    """One section per heading, packed to the budget, each chunk under its breadcrumb."""
    sections = _markdown_sections(text.splitlines())
    skip_title = _title_level(sections)
    taken: set[str] = set()
    documents = []
    for order, (path, level, lines) in enumerate(sections):
        locator = _markdown_locator_fields(path, level, skip_title, taken) if path else {}
        body_lines = lines[1:] if path else lines
        documents.extend(_packed_documents(body_lines, path, order, {**base, **locator}))
        if "punkt_depth" in locator and not any(line.text.strip() for line in body_lines):
            # A chapter whose content is all in subsections: its own chunk is the
            # breadcrumb, which is what puts it in the Gliederung.
            line = lines[0].position
            metadata = {**base, **locator, "content_type": "text", "chunking": "section"}
            metadata.update({"section_order": order, "line_start": line, "line_end": line})
            documents.append(_document(BREADCRUMB_SEP.join(path), metadata))
    return documents


def _packed_documents(lines: list[Line], path: list[str], order: int, base: dict[str, Any]) -> list[Document]:
    """A section's lines packed to the budget, each chunk with the breadcrumb and line range."""
    header = f"{BREADCRUMB_SEP.join(path)}\n\n" if path else ""
    documents = []
    for part, (chunk, carried) in enumerate(pack(lines), start=1):
        own = chunk[carried:] or chunk
        body = "\n".join(line.text for line in chunk).strip()
        if not body:
            continue
        metadata = {
            **base,
            "content_type": "text",
            "chunking": "section",
            "section_order": order,
            "section_part": part,
            "line_start": own[0].position,
            "line_end": chunk[-1].position,
        }
        documents.append(_document(f"{header}{body}".strip(), metadata))
    return documents


# --- Plain text ---------------------------------------------------------------------------


def _paragraph_lines(text: str) -> list[Line]:
    """Non-blank lines with their 1-based line numbers; a blank line ends a paragraph."""
    return [Line(number, raw.rstrip()) for number, raw in enumerate(text.splitlines(), start=1) if raw.strip()]


def _paragraphs(lines: list[Line]) -> list[list[Line]]:
    groups: list[list[Line]] = []
    for line in lines:
        if groups and line.position == groups[-1][-1].position + 1:
            groups[-1].append(line)
        else:
            groups.append([line])
    return groups


def _paragraph_units(lines: list[Line]) -> list[Line]:
    """Each paragraph as ONE unit, so a chunk boundary falls between paragraphs, never inside."""
    return [
        Line(paragraph[0].position, "\n".join(line.text for line in paragraph), end=paragraph[-1].position)
        for paragraph in _paragraphs(lines)
    ]


def text_documents(text: str, base: dict[str, Any]) -> list[Document]:
    """Paragraph blocks packed to the budget, addressed ``Zeilen a-b``."""
    documents = []
    for part, (units, carried) in enumerate(pack(_paragraph_units(_paragraph_lines(text))), start=1):
        own = units[carried:] or units
        first, last = own[0].position, units[-1].last
        locator = f"Zeilen {first}-{last}" if last != first else f"Zeile {first}"
        metadata = {
            **base,
            "content_type": "text",
            "chunking": "lines",
            "punkt_id": locator,
            "section_part": part,
            "line_start": first,
            "line_end": last,
        }
        documents.append(_document("\n\n".join(unit.text for unit in units), metadata))
    return documents


# --- CSV ----------------------------------------------------------------------------------


def _dialect(sample: str, extension: str) -> Any:
    if extension == ".tsv":
        return csv.excel_tab
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        return csv.excel


def _clean_cell(value: str) -> str:
    return re.sub(r"\s+", " ", value).replace("|", "\\|").strip()[:_MAX_CELL_CHARS]


def read_delimited(text: str, extension: str) -> list[tuple[int, list[str]]]:
    """``[(last file line of the record, cells)]``; blank records dropped, line numbers kept."""
    reader = csv.reader(io.StringIO(text, newline=""), _dialect(text[:8192], extension))
    rows: list[tuple[int, list[str]]] = []
    for record in reader:
        cells = [_clean_cell(cell) for cell in record]
        if any(cells):
            rows.append((reader.line_num, cells))
    return rows


def delimited_documents(text: str, extension: str, base: dict[str, Any], label: str) -> list[Document]:
    """Row groups under the header, addressed by the file lines they hold."""
    from knowledge_layer.llamaindex.captioned_tables import Table
    from knowledge_layer.llamaindex.captioned_tables import markdown_row_groups

    rows = read_delimited(text, extension)
    if not rows:
        return []
    # Cells the length bound shortens are read by nothing, the upload screen
    # included; counted so the file can only claim a partial check (ADR-0077).
    cut = sum(
        1
        for record in csv.reader(io.StringIO(text, newline=""), _dialect(text[:8192], extension))
        for cell in record
        if len(re.sub(r"\s+", " ", cell).strip()) > _MAX_CELL_CHARS
    )
    # A lone row is data under no header, not a header over no data.
    header_rows = 1 if len(rows) > 1 else 0
    table = Table("", "", [cells for _line, cells in rows], page_start=0, page_end=0, header_rows=header_rows)
    lines = [line for line, _cells in rows[header_rows:]]
    ends = [rows[0][0]] if header_rows else [0]
    starts = [end + 1 for end in [*ends, *lines[:-1]]]
    groups = markdown_row_groups(table)
    documents = []
    for part, (first, last, markdown) in enumerate(groups, start=1):
        locator = f"Zeilen {starts[first]}-{lines[last]}"
        suffix = f" (Teil {part} von {len(groups)})" if len(groups) > 1 else ""
        metadata = {
            **base,
            "content_type": "table",
            "chunking": "table",
            "punkt_id": locator,
            "table_part": part,
            "line_start": starts[first],
            "line_end": lines[last],
        }
        if part == len(groups) and cut:
            metadata["content_cut"] = cut
        documents.append(_document(f"{label}, {locator}{suffix}\n\n{markdown}", metadata))
    return documents


def extract_text_format_documents(file_path: str, file_name: str, file_size: int) -> list[Document] | None:
    """Documents for a Markdown, text or CSV file, or ``None`` for any other extension.

    The ORIGINAL ``file_name``'s extension decides, the temp ``file_path``'s second,
    exactly as ``office_extractors`` does.
    """
    extension = (Path(file_name).suffix or Path(file_path).suffix).lower()
    if extension not in SUPPORTED_EXTENSIONS:
        return None
    text, encoding = decode_text(Path(file_path).read_bytes())
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    base = {"file_name": file_name, "file_size": file_size, "source_encoding": encoding}
    if extension in MARKDOWN_EXTENSIONS:
        return markdown_documents(text, base)
    if extension in DELIMITED_EXTENSIONS:
        return delimited_documents(text, extension, base, Path(file_name).name)
    return text_documents(text, base)
