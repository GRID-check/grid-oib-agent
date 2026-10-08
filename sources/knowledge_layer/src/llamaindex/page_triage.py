"""Page triage: what each PDF page needs before it can be indexed.

A PDF page reaches the index by one of four roads, and choosing the wrong one
loses the page:

``text``
    A usable text layer. Indexed from pdfplumber's text, as always.
``scan``
    No usable text layer and a raster covering most of the page: a scanned
    letter, a Bescheid, a photographed page. Rendered and TRANSCRIBED by the
    vision model (``transcription``), and the transcription becomes the page's
    text. A drawing schema describes such a page ("Dokument mit Auflagen …")
    instead of saying what is written on it, so these are not drawings.
``garbled``
    A text layer that decodes to glyph ids or mojibake: ``(cid:37)(cid:68)…``
    runs from a CAD or scanner export whose fonts carry no ToUnicode map, or
    UTF-8 read as cp1252 (``GebÃ¤ude``). Left alone, it passes the binary guard
    and is embedded as garbage. Transcribed like a scan, and the transcription
    replaces it. Untranscribed (no key, a failure, the cap), the page keeps
    what of its text is not glyph ids (:func:`salvage_text`).
``drawing``
    Vector-heavy with little text: a plan, a section, an elevation. Rendered
    and analysed with the drawing schema (``visual_analysis``).

The decision is pure (:func:`classify_page`) over signals measured once per
page (:func:`read_page_signals`), so the thresholds are testable without a PDF
and the renderer, the transcriber and the image extractor all agree on which
page is which.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

logger = logging.getLogger(__name__)


class PageKind(StrEnum):
    TEXT = "text"
    SCAN = "scan"
    GARBLED = "garbled"
    DRAWING = "drawing"


#: Page kinds whose text the vision model transcribes.
TRANSCRIBED_KINDS = frozenset({PageKind.SCAN, PageKind.GARBLED})

# pdfium page-object types (FPDF_PAGEOBJ_*).
_PAGEOBJ_PATH = 2
_PAGEOBJ_IMAGE = 3

# ---------------------------------------------------------------------------
# Text quality
# ---------------------------------------------------------------------------

_CID_TOKEN = re.compile(r"\(cid:\d+\)")
# UTF-8 bytes decoded as cp1252/latin-1: the lead byte of every German umlaut,
# ß and most typographic punctuation becomes one of these pairs.
_MOJIBAKE = re.compile(r"Ã[\x80-\xbf¡-ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]|â€|Â[\xa0-\xbf]")

#: Below this many glyphs (non-space characters, a ``(cid:n)`` token as one) a
#: page's text says too little to judge; such a page is classified by its
#: raster/path signals alone.
MIN_JUDGEABLE_CHARS = 40

#: Thresholds, measured on 42 clean pages (the German samples built in
#: ``tests/knowledge_layer_tests/test_page_triage.py`` and the three PDFs in
#: ``tests/knowledge_layer_tests/data``) against garbled ones built from the
#: same text. Clean pages: cid share at most 0.03 (a ligature or a symbol
#: glyph), no replacement characters, no mojibake, vowel ratio at least 0.36.
#: Shares are of glyphs, not characters: that only lowers a clean page's cid
#: share and leaves a garbled page's at 1.00.
#: Garbled: cid share 1.00 (pdfplumber on a font without ToUnicode), mojibake
#: 0.043 (UTF-8 read as cp1252), vowel ratio 0.16 and replacement share 0.065
#: (pdfium on the same font: glyph ids shifted into letters, ``%DXEHVFKHLG`` for
#: "Baubescheid"). Each limit sits well inside
#: the gap. There is deliberately no letter-ratio limit: a page of bare
#: numbers (a cost table) is real text with almost no letters, and a garbled
#: verdict costs a transcription call and replaces the page's own text.
MAX_CID_SHARE = 0.10
MAX_REPLACEMENT_SHARE = 0.02
MAX_MOJIBAKE_SHARE = 0.01
MIN_VOWEL_RATIO = 0.22
#: The vowel ratio is only read off a page with at least this many letters:
#: a short label list ("REI 90", "EI2 30-C") has too few to judge.
MIN_LETTERS_FOR_VOWELS = 100
_VOWELS = frozenset("aeiouyäöüAEIOUYÄÖÜ")


@dataclass(frozen=True)
class TextQuality:
    """How much of a page's extracted text is real text.

    ``chars`` counts glyphs: non-space characters, with each ``(cid:n)`` token
    counted as the ONE glyph it stands for. The shares are of those glyphs.
    Counting a token's nine characters made a clean list with a dozen unmapped
    bullets (``(cid:120)``) score 0.17 and lose its text.
    """

    chars: int
    cid_share: float
    replacement_share: float
    mojibake_share: float
    vowel_ratio: float = 0.4
    letters: int = 0

    @property
    def garbled(self) -> bool:
        if self.chars < MIN_JUDGEABLE_CHARS:
            return False
        return (
            self.cid_share > MAX_CID_SHARE
            or self.replacement_share > MAX_REPLACEMENT_SHARE
            or self.mojibake_share > MAX_MOJIBAKE_SHARE
            or (self.letters >= MIN_LETTERS_FOR_VOWELS and self.vowel_ratio < MIN_VOWEL_RATIO)
        )


#: Symbol- and Wingdings-font glyphs Word exports into the private use area
#: (the font's code point + U+F000): list bullets, check marks, arrows. They are
#: mapped glyphs a reader sees as a bullet, not bytes no font mapped, and a
#: bulleted list carries one per item.
_SYMBOL_FONT_BULLETS = frozenset(
    "\uf020\uf02d\uf06c\uf06e\uf071\uf076\uf0a7\uf0a8\uf0b7\uf0d8\uf0e0\uf0e8\uf0f0\uf0fc\uf0fe"
)


def _is_private_use(ch: str) -> bool:
    return unicodedata.category(ch) == "Co"


def _is_replacement(ch: str) -> bool:
    """U+FFFD, private-use glyphs and stray control characters: bytes no font mapped."""
    if ch == "\ufffd":
        return True
    category = unicodedata.category(ch)
    return category in ("Co", "Cs") or (category == "Cc" and ch not in "\n\r\t")


def _without_bullets(text: str) -> str:
    """``text`` minus symbol-font bullets: the known ones anywhere, any private-use glyph opening a line."""
    lines = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped and _is_private_use(stripped[0]):
            stripped = stripped[1:]
        lines.append("".join(ch for ch in stripped if ch not in _SYMBOL_FONT_BULLETS))
    return "\n".join(lines)


def text_quality(text: str | None) -> TextQuality:
    """Measure one page's extracted text. Pure; empty text scores as clean and empty."""
    body = "".join(_without_bullets(text or "").split())
    if not body:
        return TextQuality(0, 0.0, 0.0, 0.0)
    cid_tokens = len(_CID_TOKEN.findall(body))
    residue = _CID_TOKEN.sub("", body)
    glyphs = len(residue) + cid_tokens
    replacement = sum(1 for ch in residue if _is_replacement(ch))
    mojibake = len(_MOJIBAKE.findall(residue))
    letters = [ch for ch in residue if ch.isalpha()]
    vowels = sum(1 for ch in letters if ch in _VOWELS)
    return TextQuality(
        chars=glyphs,
        cid_share=cid_tokens / glyphs,
        replacement_share=replacement / glyphs,
        mojibake_share=mojibake / glyphs,
        vowel_ratio=vowels / len(letters) if letters else 0.4,
        letters=len(letters),
    )


def salvage_text(text: str | None) -> str:
    """What of a garbled page's text layer is worth keeping when nothing replaces it.

    The ``(cid:n)`` tokens go (they are glyph ids, never words); the rest stays.
    Empty when nothing real is left, as on a page that was all glyph ids.
    """
    kept = _CID_TOKEN.sub("", text or "")
    return kept if len("".join(kept.split())) >= MIN_JUDGEABLE_CHARS else ""


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

#: Share of the page area a raster must cover for the page to be a scan.
MIN_SCAN_RASTER_COVERAGE = 0.5

#: Vector paths that make a page with little text a sketch worth describing.
#: Deliberately far below ``min_paths``: that threshold is for telling a CAD
#: sheet from text, and a hand sketch, a detail or a Schema with a few dozen
#: lines is exactly what an architecture office uploads. Below this a page is
#: a separator, a cover or a blank back side, and costs no VLM call.
MIN_SKETCH_PATHS = 20


@dataclass(frozen=True)
class PageSignals:
    """What one page carries, measured once."""

    page_number: int
    text: str
    path_count: int = 0
    raster_coverage: float = 0.0


def classify_page(signals: PageSignals, *, min_text_chars: int, min_paths: int) -> PageKind:
    """The road one page takes into the index. Pure.

    Order matters: a garbled text layer is judged first, because its length
    says nothing (4 800 characters of ``(cid:n)`` are 120 real ones). A
    drawing needs little text, and path count alone is not enough: a
    table-ruled text page with 300 cell borders stays text. A page with little
    text is a drawing as soon as it carries any real
    linework or a picture (``MIN_SKETCH_PATHS``), because a simple sketch
    matters as much as a CAD sheet; only a practically empty page stays text. A
    garbled page that is also path-heavy is a CAD sheet with unmapped fonts:
    the drawing analysis reads its labels off the render, a transcription would
    lose the drawing.
    """
    quality = text_quality(signals.text)
    if quality.garbled:
        return PageKind.DRAWING if signals.path_count >= min_paths else PageKind.GARBLED
    if len(signals.text.strip()) >= min_text_chars:
        return PageKind.TEXT
    if signals.raster_coverage >= MIN_SCAN_RASTER_COVERAGE:
        return PageKind.SCAN
    if signals.path_count >= MIN_SKETCH_PATHS or signals.raster_coverage > 0:
        return PageKind.DRAWING
    return PageKind.TEXT


# ---------------------------------------------------------------------------
# Signals from the PDF
# ---------------------------------------------------------------------------


def _raster_coverage(page: Any, page_area: float) -> float:
    """Share of the page covered by its largest image object (0..1)."""
    largest = 0.0
    for obj in page.get_objects():
        if obj.type != _PAGEOBJ_IMAGE:
            continue
        left, bottom, right, top = obj.get_bounds()
        largest = max(largest, max(0.0, right - left) * max(0.0, top - bottom))
    return min(1.0, largest / page_area) if page_area > 0 else 0.0


def _path_count(page: Any, ceiling: int) -> int:
    count = 0
    for obj in page.get_objects():
        if obj.type == _PAGEOBJ_PATH:
            count += 1
            if count >= ceiling:
                break
    return count


def _page_signals(page: Any, page_number: int, text: str, min_paths: int) -> PageSignals:
    width, height = page.get_size()
    return PageSignals(
        page_number=page_number,
        text=text,
        path_count=_path_count(page, max(1, min_paths)),
        raster_coverage=_raster_coverage(page, width * height),
    )


def _measure_page(doc: Any, index: int, text: str, min_paths: int) -> PageSignals:
    """One page's signals, under the PDFium lock; a page pdfium cannot read is measured from its text."""
    from knowledge_layer.llamaindex.pdfium_lock import pdfium_lock

    number = index + 1
    with pdfium_lock():
        try:
            page = doc[index]
        except Exception:  # noqa: BLE001 - one damaged page costs that page's signals
            return PageSignals(number, text)
        try:
            return _page_signals(page, number, text, min_paths)
        except Exception:  # noqa: BLE001
            return PageSignals(number, text)
        finally:
            page.close()


def _open_pdf(pdf_path: str) -> tuple[Any, int]:
    """``(document, page count)``, opened under the PDFium lock; closed again if it cannot be counted."""
    import pypdfium2 as pdfium
    from knowledge_layer.llamaindex.pdfium_lock import pdfium_lock

    with pdfium_lock():
        doc = pdfium.PdfDocument(pdf_path)
        try:
            return doc, len(doc)
        except Exception:
            doc.close()
            raise


def read_page_signals(pdf_path: str, page_texts: dict[int, str], *, min_paths: int) -> list[PageSignals] | None:
    """Measure every page of ``pdf_path``; ``None`` when pdfium cannot open it.

    ``page_texts`` is the caller's extracted text (1-based page → text), so the
    text layer is read once. A page pdfium cannot read is measured from its text
    alone, which classifies it as text or garbled but never as a scan. PDFium is
    held (``pdfium_lock``) for the open, each page and the close, not for the
    whole document, so a long PDF does not stall the other ingest workers.
    """
    from knowledge_layer.llamaindex.pdfium_lock import pdfium_lock

    try:
        doc, pages = _open_pdf(pdf_path)
    except Exception as exc:  # noqa: BLE001 - triage is advisory; text ingestion goes on
        logger.warning("Page triage unavailable for %s (%s: %s)", pdf_path, type(exc).__name__, exc)
        return None
    try:
        return [_measure_page(doc, index, page_texts.get(index + 1) or "", min_paths) for index in range(pages)]
    finally:
        with pdfium_lock():
            doc.close()


@dataclass(frozen=True)
class PdfTriage:
    """Every page's kind, in page order."""

    kinds: dict[int, PageKind]

    def pages(self, *kinds: PageKind) -> list[int]:
        return [number for number, kind in self.kinds.items() if kind in kinds]

    @property
    def transcribed(self) -> list[int]:
        return self.pages(*TRANSCRIBED_KINDS)

    @property
    def drawings(self) -> list[int]:
        return self.pages(PageKind.DRAWING)


def triage_pdf(
    pdf_path: str,
    page_texts: dict[int, str],
    *,
    min_text_chars: int,
    min_paths: int,
) -> PdfTriage | None:
    """Classify every page of ``pdf_path``; ``None`` when the PDF cannot be measured."""
    signals = read_page_signals(pdf_path, page_texts, min_paths=min_paths)
    if signals is None:
        return None
    kinds = {s.page_number: classify_page(s, min_text_chars=min_text_chars, min_paths=min_paths) for s in signals}
    counts = {kind.value: sum(1 for k in kinds.values() if k is kind) for kind in PageKind}
    logger.info("Page triage for %s: %s", pdf_path, counts)
    return PdfTriage(kinds)
