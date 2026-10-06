"""Extractors for the office content the PDF pipeline does not read.

Two jobs, both keyed by extension:

- **Spreadsheets with a structure of their own** (``.xlsx``/``.xlsm``): one unit
  per worksheet, a markdown table labelled by sheet name, via openpyxl. A PDF
  rendition of a workbook is a print layout that cuts columns across pages, so
  these keep this reader. Why not SimpleDirectoryReader: its per-format readers
  live in the optional ``llama-index-readers-file`` distribution, which this
  deployment does not install, and its fallback reads a zip's raw bytes as
  text (``PK\\x03…``), which the binary-content guard rejects.
- **Rendition companions**: a Word or presentation file is indexed from its PDF
  rendition and nothing else (ADR-0071; ``knowledge_layer.renditions``), so
  there is no Word or slide-text reader here any more. What the PDF export
  drops is read from the original beside it: pptx speaker notes.

Plain-text formats (``.csv``, ``.txt``, ``.md``) have their own module,
``text_formats``, which decodes them without dropping bytes and cuts them on
their own structure (sections, paragraphs, row groups).

Modularity contract (see ``docs/architecture/visual-ingestion.md``): one
handler per format, keyed by extension, returning plain ``Document`` objects —
adding a format is one function plus one dict entry, and the adapter knows
nothing about any of them.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Bounds. A schedule or BoQ can carry tens of thousands of rows, and each sheet is
# indexed as row groups that repeat its header, so a long sheet costs chunks, not
# legibility. The row cap only bounds embedding cost on a pathological workbook; what
# it cuts is stated in the last group's text AND counted (``rows_over_cap``) so the
# ingest can put it on the file's result instead of dropping it silently. It used to
# be 1000 rows, cut without a count.
MAX_TABLE_ROWS = 10_000
MAX_TABLE_COLS = 60
MAX_CELL_CHARS = 500


def _clean_cell(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("|", "\\|").replace("\n", " ").strip()[:MAX_CELL_CHARS]


def _cells_cut(row: tuple[Any, ...]) -> int:
    """Cells of a row the bounds drop or shorten: past the column cap, or longer than a cell may be.

    Counted because what is cut is read by nothing, the upload screen included, so a
    file that lost some can only claim a partial check (ADR-0079).
    """
    beyond = sum(1 for value in row[MAX_TABLE_COLS:] if value not in (None, ""))
    shortened = sum(
        1 for value in row[:MAX_TABLE_COLS] if value is not None and len(str(value).strip()) > MAX_CELL_CHARS
    )
    return beyond + shortened


def _sheet_rows(sheet: Any) -> tuple[list[tuple[int, list[str]]], int, int]:
    """``([(spreadsheet row number, cells)], rows over the cap, cells cut)``; empty rows skipped."""
    rows: list[tuple[int, list[str]]] = []
    over_cap = 0
    cut = 0
    for number, row in enumerate(sheet.iter_rows(values_only=True), start=1):
        cells = [_clean_cell(cell) for cell in row[:MAX_TABLE_COLS]]
        if not any(cells) and not any(value not in (None, "") for value in row[MAX_TABLE_COLS:]):
            continue
        if len(rows) >= MAX_TABLE_ROWS:
            over_cap += 1
            continue
        cut += _cells_cut(row)
        if any(cells):
            rows.append((number, cells))
    return rows, over_cap, cut


def _sheet_units(
    title: str, rows: list[tuple[int, list[str]]], over_cap: int, cut: int = 0
) -> list[tuple[str, str, dict]]:
    """A sheet as row groups under its header row, each named by sheet and row range.

    The header (the first non-empty row) is repeated in every group, so no chunk is a
    run of numbers without the columns that say what they are.
    """
    from knowledge_layer.llamaindex.captioned_tables import Table
    from knowledge_layer.llamaindex.captioned_tables import markdown_row_groups

    header_rows = 1 if len(rows) > 1 else 0
    table = Table("", "", [cells for _number, cells in rows], page_start=0, page_end=0, header_rows=header_rows)
    numbers = [number for number, _cells in rows[header_rows:]]
    groups = markdown_row_groups(table)
    units = []
    for part, (first, last, markdown) in enumerate(groups, start=1):
        rows_label = f"Zeilen {numbers[first]}-{numbers[last]}" if last != first else f"Zeile {numbers[first]}"
        suffix = f" (Teil {part} von {len(groups)})" if len(groups) > 1 else ""
        text = f"Tabellenblatt „{title}“, {rows_label}{suffix}\n\n{markdown}"
        extra: dict[str, Any] = {"punkt_id": f"{title}: {rows_label}", "table_part": part, "chunking": "table"}
        if part == len(groups) and over_cap:
            text += f"\n\n[Tabelle gekürzt: {over_cap} weitere Zeilen nach den ersten {MAX_TABLE_ROWS} nicht indexiert]"
            extra["rows_over_cap"] = over_cap
        if part == len(groups) and cut:
            extra["content_cut"] = cut
        units.append((title, text, extra))
    return units


def _extract_xlsx(file_path: str) -> list[tuple[str, str, dict]]:
    """Every worksheet as header-repeating row groups, labelled by sheet name."""
    from openpyxl import load_workbook

    units: list[tuple[str, str, dict]] = []
    workbook = load_workbook(file_path, read_only=True, data_only=True)
    try:
        for sheet in workbook.worksheets:
            rows, over_cap, cut = _sheet_rows(sheet)
            if rows:
                units.extend(_sheet_units(sheet.title, rows, over_cap, cut))
    finally:
        workbook.close()
    return units


def _slide_notes(slide: Any) -> str:
    """A slide's speaker notes, stripped; empty when it has none.

    ``has_notes_slide`` first: reading ``notes_slide`` on a slide without one
    CREATES the part, which is a write this read-only path has no business making.
    """
    if not getattr(slide, "has_notes_slide", False):
        return ""
    frame = slide.notes_slide.notes_text_frame
    return frame.text.strip() if frame is not None else ""


def _is_hidden(slide: Any) -> bool:
    """Whether PowerPoint hides the slide in a show (``<p:sld show="0">``)."""
    return slide._element.get("show") in ("0", "false")


def _extract_pptx_notes(file_path: str) -> list[tuple[str, str]]:
    """Speaker notes only, one unit per slide that has them, labelled by PDF page.

    The companion of a presentation indexed from its PDF rendition (ADR-0071):
    the rendition carries every slide's visible text and pictures, but a PDF
    export drops the notes, which are often where the argument of a deck lives.
    So these units carry the notes and nothing else; the slide text would be
    indexed twice otherwise.

    The label is the slide's page in the RENDITION, not its position in the
    deck: LibreOffice leaves hidden slides out of the PDF, so after one hidden
    slide the deck's slide 3 is the PDF's page 2, and a citation opens the
    rendition at the label. A hidden slide's own notes are skipped for the
    same reason its text is: there is no page for them to land on.
    """
    from pptx import Presentation

    units: list[tuple[str, str]] = []
    visible = [slide for slide in Presentation(file_path).slides if not _is_hidden(slide)]
    for page, slide in enumerate(visible, start=1):
        note_text = _slide_notes(slide)
        if note_text:
            units.append((str(page), f"Folie {page}, Notizen des Vortragenden\n\n{note_text}"))
    return units


#: Extension → handler. Adding a format is one function plus one entry here;
#: macro-enabled variants share their sibling's handler (same XML inside).
_HANDLERS: dict[str, Callable[[str], list[tuple[str, str, dict]]]] = {
    ".xlsx": _extract_xlsx,
    ".xlsm": _extract_xlsx,
}

#: Formats this module handles (advertisable to capability probes/tests).
SUPPORTED_EXTENSIONS = frozenset(_HANDLERS)


#: Extension → the part of the ORIGINAL a PDF rendition loses. Consulted only
#: when the text and pictures come from the rendition (ADR-0071); a format
#: without an entry loses nothing worth indexing in the conversion.
_RENDITION_COMPANIONS: dict[str, Callable[[str], list[tuple[str, str]]]] = {
    ".pptx": _extract_pptx_notes,
    ".pptm": _extract_pptx_notes,
}


def _documents(units: list[tuple], file_name: str, file_size: int, content_type: str) -> list[Any]:
    """``(label, text)`` or ``(label, text, extra metadata)`` units as Documents.

    The ordering and counting fields a row group carries (``table_part``,
    ``rows_over_cap``) are kept out of the embedded text (``section_chunking``).
    """
    from knowledge_layer.llamaindex.section_chunking import apply_exclusions
    from llama_index.core import Document

    documents = []
    for label, text, *extra in units:
        metadata = {"file_name": file_name, "file_size": file_size, "page_label": label, "content_type": content_type}
        documents.append(Document(text=text, metadata={**metadata, **(extra[0] if extra else {})}))
        apply_exclusions(documents[-1])
    return documents


def rows_over_cap(documents: list[Any]) -> int:
    """How many spreadsheet rows the cap left out, summed over a file's Documents."""
    return sum(int((getattr(doc, "metadata", None) or {}).get("rows_over_cap") or 0) for doc in documents)


def content_cut(documents: list[Any]) -> int:
    """How many cells the column and cell-length bounds dropped or shortened, over a file's Documents."""
    return sum(int((getattr(doc, "metadata", None) or {}).get("content_cut") or 0) for doc in documents)


def extract_rendition_companions(file_path: str, file_name: str, file_size: int) -> list[Any]:
    """What the original adds to its PDF rendition's extraction: today, pptx speaker notes.

    ``file_path`` is the ORIGINAL (the rendition is read by the PDF pipeline),
    ``file_name`` its identity, which every unit carries. Empty for a format
    with no companion. An unreadable original raises, like every extractor
    here; the caller decides whether the notes are worth the file.
    """
    extension = (Path(file_name).suffix or Path(file_path).suffix).lower()
    handler = _RENDITION_COMPANIONS.get(extension)
    if handler is None:
        return []
    units = handler(file_path)
    logger.info("Rendition companion (%s): %d unit(s) from %s", extension, len(units), file_name)
    return _documents(units, file_name, file_size, "text")


def extract_office_documents(file_path: str, file_name: str, file_size: int) -> list[Any] | None:
    """Extract a known office format into LlamaIndex ``Document`` objects.

    Returns ``None`` when the extension (of the ORIGINAL ``file_name`` first,
    the temp ``file_path`` second) is not one this module handles — the caller
    then falls through to its generic reader. A handled-but-empty file returns
    ``[]`` so the pipeline fails that file with its normal "no content" path
    rather than indexing nothing silently. Extraction errors propagate: the
    per-file error handling in ``_run_ingestion`` reports them per file.
    """
    extension = (Path(file_name).suffix or Path(file_path).suffix).lower()
    handler = _HANDLERS.get(extension)
    if handler is None:
        return None

    units = handler(file_path)
    logger.info("Office extraction (%s): %d unit(s) from %s", extension, len(units), file_name)
    return _documents(units, file_name, file_size, "table")
