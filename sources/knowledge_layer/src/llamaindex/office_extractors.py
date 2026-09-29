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

Plain-text formats (``.csv``, ``.txt``, ``.md``) ingest correctly through the
generic reader and deliberately have no handler.

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

# Bounds: a schedule/BoQ spreadsheet can carry tens of thousands of rows; the
# text form exists for retrieval, not for round-tripping, so cap per unit and
# say so in the emitted text rather than silently truncating.
MAX_TABLE_ROWS = 1000
MAX_TABLE_COLS = 60
MAX_CELL_CHARS = 500


def _markdown_table(rows: list[list[str]], truncated: bool) -> str:
    """Render rows as the same markdown shape the PDF table extractor emits."""
    if not rows:
        return ""
    header, *body = rows
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(["---"] * len(header)) + " |",
    ]
    for row in body:
        padded = row + [""] * (len(header) - len(row))
        lines.append("| " + " | ".join(padded[: len(header)]) + " |")
    if truncated:
        lines.append("")
        lines.append(f"[Tabelle gekürzt: nur die ersten {MAX_TABLE_ROWS} Zeilen indexiert]")
    return "\n".join(lines)


def _clean_cell(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("|", "\\|").replace("\n", " ").strip()[:MAX_CELL_CHARS]


def _extract_xlsx(file_path: str) -> list[tuple[str, str]]:
    """One unit per worksheet, rendered as a markdown table, labeled by sheet name."""
    from openpyxl import load_workbook

    units: list[tuple[str, str]] = []
    workbook = load_workbook(file_path, read_only=True, data_only=True)
    try:
        for sheet in workbook.worksheets:
            rows: list[list[str]] = []
            truncated = False
            for row_index, row in enumerate(sheet.iter_rows(values_only=True)):
                if row_index >= MAX_TABLE_ROWS:
                    truncated = True
                    break
                cells = [_clean_cell(cell) for cell in row[:MAX_TABLE_COLS]]
                if any(cells):
                    rows.append(cells)
            if rows:
                units.append((sheet.title, f"Tabellenblatt „{sheet.title}“\n\n{_markdown_table(rows, truncated)}"))
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
_HANDLERS: dict[str, Callable[[str], list[tuple[str, str]]]] = {
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


def _documents(units: list[tuple[str, str]], file_name: str, file_size: int, content_type: str) -> list[Any]:
    from llama_index.core import Document

    return [
        Document(
            text=text,
            metadata={
                "file_name": file_name,
                "file_size": file_size,
                "page_label": label,
                "content_type": content_type,
            },
        )
        for label, text in units
    ]


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
