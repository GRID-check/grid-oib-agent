"""Heading-aware chunking for tenant documents: cut on the document's own sections.

Only the OIB Richtlinien had a structure-aware path (``punkt_chunking``). Every other
PDF -- a Brandschutzkonzept, a Baubeschreibung, a Gutachten -- was one ``Document`` per
page, cut by ``SentenceSplitter(1024/128)``: the overlap never crossed a page, a section
that began at the foot of page 4 was split from its body on page 5, and one 1024-token
window blended several requirements into a vector that described none of them.

This module reads the headings the document already has and chunks within them:

* A heading is a short line set in a larger font than the body, set bold, or opened by a
  German numbering (``3.2``, ``§ 3``, ``Artikel 4``, ``Anhang A``). Font size and weight
  come from pdfplumber's characters (``line_styles``, collected at extraction); a page
  without them (an OCR text layer) still has its numbering. A numbered line in body type
  must also read as a title (:func:`_title_like`) and must not run on into a lowercase
  next line: a wrapped sentence that happens to start ``§ 60 Abs. 1 … wird nach`` or
  ``3.2 Die Brandabschnitte sind`` is body text, not a section.
* A transcribed page (``transcription``) is Markdown without styles: its ATX lines
  (``## 1 Befund``) are headings at their hash level, and the markers are stripped.
* A section runs from its heading to the next heading of any level, across pages. It is
  cut into chunks of :data:`CHUNK_TOKENS`, each prefixed by the heading breadcrumb the
  way a Punkt chunk is, overlapping by :data:`OVERLAP_TOKENS` -- across a page break too,
  because the section, not the page, is the unit.
* ``page_label`` stays numeric: the page the chunk's own text starts on. ``page_end``
  records where it ends. The heading's number (or, unnumbered, its title path) is the
  chunk's ``punkt_id``, so ``read_passage(punkt=…)`` opens a section the way it opens a
  Punkt, and ``punkt_depth`` gives the document a Gliederung.

When the document has no usable heading structure (:func:`structure_is_usable`) the
caller keeps the per-page chunks. Pure over page dicts and line lists; llama-index is
imported inside the builders only.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from dataclasses import field
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    from llama_index.core import Document

#: Body tokens per chunk, breadcrumb excluded. Well inside the 1024-token splitter
#: budget after the metadata header (file name, Punkt path, page, Dokumentart: ~80-120
#: tokens), so the splitter downstream never re-cuts a chunk and strands its breadcrumb
#: on the first piece. Measured on German prose with the splitter's own tokenizer:
#: ~2.7 characters per token, so this is ~1700 characters -- two to four paragraphs.
CHUNK_TOKENS = 640
#: Tokens of the previous chunk repeated at the head of the next, inside a section only.
OVERLAP_TOKENS = 96

#: Metadata that orders, ranges or diagnoses a chunk and carries no retrieval signal.
SECTION_EMBED_EXCLUDED_METADATA_KEYS = (
    "page_end",
    "punkt_depth",
    "chunking",
    "table_part",
    "section_order",
    "section_part",
    "line_start",
    "line_end",
    "source_encoding",
    "rows_over_cap",
    "content_cut",
)

BREADCRUMB_SEP = " › "

logger = logging.getLogger(__name__)

# --- Heading recognition ---------------------------------------------------------------

#: ``3``, ``3.2``, ``3.2.1.`` then a title. Segments of at most two digits: ``1.200 m²``
#: is a number, never a heading (the same guard ``punkt_chunking`` measured).
_NUMBERED_RE = re.compile(r"^(?P<num>\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+(?P<title>\S.*)$")
#: Legal and annex numbering. The title may sit on the next line (``§ 3`` / ``Begriffe``).
_WORD_NUMBERED_RE = re.compile(
    r"^(?P<num>§\s*\d+[a-z]?|(?:Artikel\s+|Art\.\s*)\d+[a-z]?|(?:Anhang|Anlage|Beilage)\s+[A-Z0-9]{1,3}"
    r"|(?:Kapitel|Abschnitt|Teil)\s+[0-9IVX]{1,4})\.?(?:\s*[:\-–]\s*|\s+|$)(?P<title>.*)$"
)
#: Wrappers that make a word-numbered heading the TOP level when a document uses them.
_CHAPTER_WORDS = ("Kapitel", "Abschnitt", "Teil", "Anhang", "Anlage", "Beilage")
_DOT_LEADER_RE = re.compile(r"\.{4,}")
_MAX_HEADING_CHARS = 120
_MAX_HEADING_WORDS = 14
#: Bold-only (body size, no number) headings are shorter still: a bold lead-in sentence
#: is emphasis, not structure.
_MAX_BOLD_HEADING_CHARS = 90
#: A line set this much larger than the body is display type.
_LARGER_RATIO = 1.15
#: Below this it is a footnote or a caption, never a heading.
_SMALLER_RATIO = 0.95
_BOLD_FRACTION = 0.8
_BOLD_FONT_RE = re.compile(r"bold|black|heavy|semibold|demi", re.IGNORECASE)
#: A Markdown ATX heading (``## 1 Befund``), as the transcription prompt asks for them.
ATX_HEADING_RE = re.compile(r"^(?P<hashes>#{1,6})\s+(?P<title>.+?)\s*#*\s*$")
#: A numbered line in body type is a heading only when its title reads as one: at most
#: this many words, no finite verb, not ending mid-sentence.
_MAX_PLAIN_TITLE_WORDS = 8
_FINITE_VERBS = frozenset(
    "ist sind war waren wird werden wurde wurden hat haben hatte muss müssen darf dürfen "
    "kann können soll sollen gilt gelten bleibt bleiben erfolgt erfolgen".split()
)

# --- Fallback gates ---------------------------------------------------------------------

#: At least this many headings. Two headings make a letter with a subject line and a
#: signature block look structured; three is the smallest real outline.
MIN_HEADINGS = 3
#: Share of the body text that must sit under a heading. Below it the headings are a
#: cover page or a few bold labels on a document that is mostly something else.
MIN_SECTION_COVERAGE = 0.5
#: Above this share of lines being headings the "structure" is a form, a slide list or
#: a table of short rows, and cutting on it yields one-line chunks.
MAX_HEADING_LINE_SHARE = 0.3

#: Running header/footer: a first-or-last-two line repeating on this share of pages.
_FURNITURE_PAGE_SHARE = 0.5
_FURNITURE_MIN_PAGES = 3

_HYPHEN_BREAK_RE = re.compile(r"(\w)-\n([a-zäöüß])")
_SENTENCE_END_RE = re.compile(r"[.!?:;]\s*$")


@dataclass
class Line:
    """One text line and where it is: a page number (PDF) or a line number (text files)."""

    position: int
    text: str
    size: float | None = None
    bold: bool = False
    #: The last position a multi-line unit (a paragraph) covers; ``None`` for one line.
    end: int | None = None
    #: The hash count of a Markdown ATX heading line (its markers stripped from ``text``).
    atx: int = 0

    @property
    def last(self) -> int:
        return self.end if self.end is not None else self.position


@dataclass
class Heading:
    """A recognised heading: its locator number (``""`` when unnumbered), title, level."""

    number: str
    title: str
    level: int
    size: float | None = None
    #: Lines the heading occupies: 2 when a bare "§ 3" took its title from the next line.
    span: int = 1

    @property
    def label(self) -> str:
        return f"{self.number} {self.title}".strip() if self.number else self.title


@dataclass
class Section:
    """A heading and the lines under it, up to the next heading. ``heading`` None: the preamble."""

    heading: Heading | None
    path: list[str]
    lines: list[Line] = field(default_factory=list)
    locator: str = ""

    @property
    def heading_lines(self) -> list[Line]:
        """The lines the heading itself occupies (the breadcrumb restates them)."""
        return self.lines[: self.heading.span] if self.heading else []


def style_of_line(chars: list[dict[str, Any]]) -> tuple[float | None, float]:
    """``(median font size, bold fraction)`` of one pdfplumber text line's characters."""
    glyphs = [char for char in chars if str(char.get("text", "")).strip()]
    if not glyphs:
        return None, 0.0
    sizes = sorted(float(char.get("size") or 0.0) for char in glyphs)
    bold = sum(1 for char in glyphs if _BOLD_FONT_RE.search(str(char.get("fontname") or "")))
    return round(sizes[len(sizes) // 2], 1), bold / len(glyphs)


def _read_line_styles(page: Any) -> list[list[Any]]:
    styles: list[list[Any]] = []
    for line in page.extract_text_lines(return_chars=True):
        size, bold = style_of_line(line.get("chars") or [])
        styles.append([str(line.get("text") or "").strip(), size, round(bold, 2)])
    return styles


def extract_line_styles(page: Any) -> list[list[Any]]:
    """``[[text, size, bold_fraction], ...]`` for a pdfplumber page, in reading order.

    Stored on the extracted page dict so heading detection needs no second pass over
    the PDF. Fail-open, and wholly: it runs inside the per-page reader, where anything
    it raised would count the page as unreadable and drop its TEXT. A page whose styles
    cannot be read has none, and its headings are recognised by their numbering alone.
    """
    try:
        return _read_line_styles(page)
    except Exception as exc:  # noqa: BLE001 - styles are an optional signal, never a reason to lose a page
        logger.warning("Line styles unavailable on a page (%s); headings by numbering only", exc)
        return []


def _markdown_line(number: int, text: str) -> Line:
    """A line of an unstyled page; an ATX heading loses its markers and keeps its level."""
    match = ATX_HEADING_RE.match(text)
    if match is None:
        return Line(number, text)
    return Line(number, match.group("title"), atx=len(match.group("hashes")))


def _page_lines(page: dict[str, Any]) -> list[Line]:
    """A page's text lines with the style its ``line_styles`` recorded for the same text.

    A page without styles (a transcription) is read as Markdown: its ATX headings are
    recognised. A styled page is a PDF text layer, where a leading ``#`` is just text.
    """
    recorded = page.get("line_styles") or []
    styles = {str(text): (size, bold) for text, size, bold in recorded}
    try:
        number = int(page.get("page_number"))
    except (TypeError, ValueError):
        number = 0
    lines = []
    for raw in (page.get("text") or "").splitlines():
        text = raw.strip()
        if not text:
            continue
        if not recorded:
            lines.append(_markdown_line(number, text))
            continue
        size, bold = styles.get(text, (None, 0.0))
        lines.append(Line(number, text, size, bold >= _BOLD_FRACTION))
    return lines


def _furniture_key(text: str) -> str:
    return re.sub(r"\d+", "#", text.lower())


def _furniture(pages: list[list[Line]]) -> set[str]:
    """Normalised running headers/footers: an edge line repeating on most pages."""
    if len(pages) < _FURNITURE_MIN_PAGES:
        return set()
    counts: Counter[str] = Counter()
    for lines in pages:
        edges = {_furniture_key(line.text) for line in [*lines[:2], *lines[-2:]]}
        counts.update(edges)
    threshold = max(_FURNITURE_MIN_PAGES, _FURNITURE_PAGE_SHARE * len(pages))
    return {key for key, count in counts.items() if count >= threshold}


def document_lines(text_pages: list[dict[str, Any]]) -> list[Line]:
    """The whole document as one line stream, running headers and footers removed."""
    pages = [_page_lines(page) for page in text_pages]
    furniture = _furniture(pages)
    return [line for lines in pages for line in lines if _furniture_key(line.text) not in furniture]


def body_size(lines: list[Line]) -> float | None:
    """The font size most of the text is set in, weighted by characters."""
    sizes: Counter[float] = Counter()
    for line in lines:
        if line.size:
            sizes[line.size] += len(line.text)
    return sizes.most_common(1)[0][0] if sizes else None


def _shape_ok(text: str) -> bool:
    """Short, not a sentence, not a contents-page entry."""
    if len(text) > _MAX_HEADING_CHARS or len(text.split()) > _MAX_HEADING_WORDS:
        return False
    if _DOT_LEADER_RE.search(text):
        return False
    # A bare "§ 3" has no letter and is still a heading; a bare number is not.
    if not re.search(r"[A-Za-zÄÖÜäöüß]", text) and not _WORD_NUMBERED_RE.match(text):
        return False
    # A contents-page entry without leader dots: "1.1 Gebäudebeschreibung 4". Numbered
    # lines only -- "Brandschutz nach OIB-Richtlinie 2" is a heading.
    if _NUMBERED_RE.match(text) and re.search(r"[A-Za-zÄÖÜäöüß]\S*\s+\d{1,3}$", text):
        return False
    return not re.search(r"[.,;]$", text)


def normalise_locator(number: str) -> str:
    """One spelling per legal locator: ``§3``, ``§  3`` -> ``§ 3``; ``Art.3`` -> ``Art. 3``."""
    spaced = re.sub(r"^(§|Art\.)\s*(?=\d)", r"\1 ", number.strip())
    return re.sub(r"\s+", " ", spaced)


def _numbered(text: str) -> tuple[str, str, bool] | None:
    """``(number, title, strong)`` for a numbered heading line, else ``None``.

    Strong numbering (``3.2``, ``§ 3``, ``Artikel 4``) marks a heading on its own; a bare
    ``1`` is also how a list item starts, so it counts only when the type says heading.
    """
    word = _WORD_NUMBERED_RE.match(text)
    if word:
        return normalise_locator(word.group("num")), word.group("title").strip(), True
    match = _NUMBERED_RE.match(text)
    if match is None or not match.group("title")[0].isupper():
        return None
    return match.group("num"), match.group("title").strip(), "." in match.group("num")


def _ends_mid_sentence(text: str) -> bool:
    """Whether a line breaks off inside a sentence: a trailing comma or hyphen, or a lowercase last word.

    German titles end on a noun (``Brandabschnitte``, ``Allgemeines``); a wrapped
    sentence ends wherever the line did (``… mit dem amtlichen``, ``… erklärt und ist``).
    """
    words = text.split()
    if not words or text.endswith((",", "-")):
        return bool(words)
    return words[-1][:1].islower()


def _title_like(title: str) -> bool:
    """Whether the text after a number reads as a title rather than a sentence. Empty is a bare ``§ 3``."""
    words = title.split()
    if not words:
        return True
    if len(words) > _MAX_PLAIN_TITLE_WORDS:
        return False
    if any(word.lower().strip(",.;:") in _FINITE_VERBS for word in words):
        return False
    return not _ends_mid_sentence(title)


def _runs_on(line: Line, following: Line | None, styled: bool) -> bool:
    """Whether the next line continues ``line``'s sentence: it opens lowercase, in body type.

    A styled heading wrapped over two lines keeps its style on the second, so that
    one is not a run-on.
    """
    if following is None or not following.text[:1].islower():
        return False
    return not styled or (following.size, following.bold) != (line.size, line.bold)


def _numbered_heading(
    numbered: tuple[str, str, bool], line: Line, following: Line | None, styled: bool, unstyled: bool
) -> tuple[str, str] | None:
    """A numbered line's verdict. ``unstyled``: no font information for this line at all."""
    number, title, strong = numbered
    if _runs_on(line, following, styled):
        return None
    if styled:
        return number, title
    if not (strong or unstyled):
        return None  # a bare "1" in body type where the fonts are known: a list item
    return (number, title) if _title_like(title) else None


def _atx_heading(line: Line) -> tuple[str, str] | None:
    """A Markdown heading's ``(number, title)``; the author (or the transcriber) marked it."""
    if len(line.text) > _MAX_HEADING_CHARS:
        return None
    numbered = _numbered(line.text)
    return (numbered[0], numbered[1]) if numbered else ("", line.text)


def classify(line: Line, body: float | None, following: Line | None = None) -> tuple[str, str] | None:
    """``(number, title)`` when ``line`` is a heading, else ``None``. ``following``: the next line."""
    if line.atx:
        return _atx_heading(line)
    if not _shape_ok(line.text):
        return None
    if body and line.size and line.size < body * _SMALLER_RATIO:
        return None
    larger = bool(body and line.size and line.size >= body * _LARGER_RATIO)
    numbered = _numbered(line.text)
    if numbered is not None:
        unstyled = body is None or line.size is None
        return _numbered_heading(numbered, line, following, larger or line.bold, unstyled)
    if larger or (line.bold and len(line.text) <= _MAX_BOLD_HEADING_CHARS):
        return "", line.text
    return None


def _is_title(found: list[tuple[int, str, str]], lines: list[Line]) -> bool:
    """Whether the first heading is the document's title: unnumbered, in a size no other heading has."""
    if not found or found[0][1]:
        return False
    size = lines[found[0][0]].size or 0.0
    return all((lines[index].size or 0.0) < size for index, _number, _title in found[1:])


def _levels(found: list[tuple[int, str, str]], lines: list[Line]) -> list[Heading]:
    """Assign outline levels: numbering depth where numbered, font rank where not.

    The document title (:func:`_is_title`) is level 0: every section sits under it and
    no chapter closes it. The other headings' sizes are ranked, numbered ones included
    (largest = 1), so an unnumbered bold line at body size ranks below a 14 pt chapter.
    ``§``/``Artikel`` sit under ``Kapitel``/``Abschnitt`` when the document uses those,
    and are top-level when it does not.
    """
    title = _is_title(found, lines)
    rest = found[1:] if title else found
    sizes = sorted({lines[index].size or 0.0 for index, _number, _title in rest}, reverse=True)
    rank = {size: position + 1 for position, size in enumerate(sizes)}
    has_chapters = any(number.startswith(_CHAPTER_WORDS) for _index, number, _title in found)
    headings = [Heading("", found[0][2], 0, lines[found[0][0]].size)] if title else []
    for index, number, heading_title in rest:
        size = lines[index].size
        level = lines[index].atx or _level(number, rank.get(size or 0.0, len(sizes) + 1), has_chapters)
        headings.append(Heading(number, heading_title, level, size))
    return headings


def _level(number: str, size_rank: int, has_chapters: bool) -> int:
    """One heading's level: ``3.2`` is 2; ``§ 4`` is 1, or 2 under chapters; unnumbered, its size rank."""
    if number[:1].isdigit():
        return number.count(".") + 1
    if number:
        return 2 if has_chapters and not number.startswith(_CHAPTER_WORDS) else 1
    return size_rank


def _continues_heading(previous: Line, line: Line, number: str) -> bool:
    """Whether ``line`` is the wrapped second line of the unnumbered heading on ``previous``.

    Markdown headings never wrap: each ATX line is its own heading.
    """
    if previous.atx or line.atx:
        return False
    return not number and previous.size == line.size and previous.bold == line.bold


def _numeric(number: str) -> tuple[int, ...]:
    """``"3.2"`` -> ``(3, 2)``; empty for a word number (``§ 3``) or none."""
    return tuple(int(part) for part in number.split(".")) if number[:1].isdigit() else ()


def _goes_backwards(number: str, numbering: tuple[int, ...]) -> bool:
    """Whether a numbered line falls behind the outline so far: a table's row label.

    A document's numbering only moves forward, and a table laid out with a numbered
    first column restarts at 1 (the guard ``punkt_chunking`` measured on the OIB corpus,
    in its weakest form: no chain search, no contents page).
    """
    candidate = _numeric(number)
    return bool(candidate and numbering and candidate <= numbering)


def find_headings(lines: list[Line]) -> dict[int, Heading]:
    """Line index -> heading, for every heading line in the stream.

    A heading wrapped over two lines in the same type is one heading, not two. A
    word-numbered heading with no title on its line (``§ 3`` above ``Begriffe``) takes
    the next line as its title when that line is heading-shaped. Either way the extra
    line is part of the heading (``span``), not of the body.
    """
    body = body_size(lines)
    found: list[list[Any]] = []  # [index, number, title, span]
    numbering: tuple[int, ...] = ()
    for index, line in enumerate(lines):
        last = found[-1] if found else None
        if last is not None and index < last[0] + last[3]:
            continue
        result = classify(line, body, lines[index + 1] if index + 1 < len(lines) else None)
        if result is None or _goes_backwards(result[0], numbering):
            continue
        number, title = result
        numbering = _numeric(number) or numbering
        if last and index == last[0] + last[3] and not last[1] and _continues_heading(lines[index - 1], line, number):
            last[2], last[3] = f"{last[2]} {title}", last[3] + 1
            continue
        following = lines[index + 1].text if index + 1 < len(lines) else ""
        span = 2 if number and not title and following and _shape_ok(following) else 1
        found.append([index, number, following if span == 2 else title, span])
    triples = [(index, number, title) for index, number, title, _span in found]
    headings = {}
    for (index, *_rest, span), heading in zip(found, _levels(triples, lines), strict=True):
        heading.span = span
        headings[index] = heading
    return headings


# --- Sections ---------------------------------------------------------------------------


def _breadcrumb(stack: list[Heading], heading: Heading) -> list[Heading]:
    """The ancestors still open at ``heading``'s level, then ``heading`` itself."""
    while stack and stack[-1].level >= heading.level:
        stack.pop()
    stack.append(heading)
    return list(stack)


def _locator(path: list[Heading], taken: set[str]) -> str:
    """The Punkt-style address of a section: its number, else its last two titles.

    Unique within the document: a repeated address (two „Allgemeines", an annex that
    restarts at 1) gets `` (2)``, `` (3)`` … so ``read_passage`` never mixes two sections.
    """
    heading = path[-1]
    base = heading.number or BREADCRUMB_SEP.join(item.title for item in path[-2:])
    candidate, counter = base, 1
    while candidate in taken:
        counter += 1
        candidate = f"{base} ({counter})"
    taken.add(candidate)
    return candidate


def build_sections(lines: list[Line], headings: dict[int, Heading]) -> list[Section]:
    """Cut the stream at every heading; lines before the first heading are the preamble."""
    sections: list[Section] = [Section(None, [])]
    stack: list[Heading] = []
    taken: set[str] = set()
    for index, line in enumerate(lines):
        heading = headings.get(index)
        if heading is None:
            sections[-1].lines.append(line)
            continue
        path = _breadcrumb(stack, heading)
        sections.append(Section(heading, [item.label for item in path], [line], _locator(path, taken)))
    return [section for section in sections if section.lines]


def structure_is_usable(lines: list[Line], sections: list[Section]) -> bool:
    """Whether cutting on these headings beats cutting on pages.

    Three gates, each tested: at least :data:`MIN_HEADINGS` headings; at least
    :data:`MIN_SECTION_COVERAGE` of the text under one; and no more than
    :data:`MAX_HEADING_LINE_SHARE` of the lines being headings.
    """
    headed = [section for section in sections if section.heading is not None]
    if len(headed) < MIN_HEADINGS or not lines:
        return False
    total = sum(len(line.text) for line in lines)
    covered = sum(len(line.text) for section in headed for line in section.lines)
    if not total or covered / total < MIN_SECTION_COVERAGE:
        return False
    return len(headed) / len(lines) <= MAX_HEADING_LINE_SHARE


# --- Packing ------------------------------------------------------------------------------


def _token_counter() -> Callable[[str], int]:
    """The splitter's own tokenizer when available, else a German characters-per-token estimate."""
    try:
        from llama_index.core.utils import get_tokenizer

        tokenizer = get_tokenizer()
        return lambda text: len(tokenizer(text))
    except Exception:  # pragma: no cover - llama-index always present in practice
        return lambda text: max(1, round(len(text) / 2.7))


def _cut_index(lines: list[Line], start: int) -> int:
    """Where to end a full chunk: after the last sentence end in its back half, else at its end."""
    for index in range(len(lines) - 1, max(start, len(lines) // 2) - 1, -1):
        if _SENTENCE_END_RE.search(lines[index].text):
            return index + 1
    return len(lines)


def _overlap_tail(lines: list[Line], count: Callable[[str], int], budget: int) -> list[Line]:
    """The last whole lines of a chunk that fit in ``budget`` tokens."""
    tail: list[Line] = []
    used = 0
    for line in reversed(lines):
        used += count(line.text) + 1
        if used > budget or len(tail) + 1 >= len(lines):
            break
        tail.insert(0, line)
    return tail


def pack(
    lines: list[Line],
    count: Callable[[str], int] | None = None,
    budget: int = CHUNK_TOKENS,
    overlap: int = OVERLAP_TOKENS,
) -> list[tuple[list[Line], int]]:
    """Group lines into chunks of at most ``budget`` tokens: ``[(lines, overlap_count), ...]``.

    A chunk ends at a sentence end where one is near, and the next opens with the tail of
    the previous (``overlap_count`` lines of it). A single line longer than the budget is
    its own chunk, and the splitter downstream cuts it.
    """
    count = count or _token_counter()
    chunks: list[tuple[list[Line], int]] = []
    current: list[Line] = []
    carried = 0
    used = 0
    for line in lines:
        cost = count(line.text) + 1
        if current and len(current) > carried and used + cost > budget:
            cut = _cut_index(current, carried)
            chunks.append((current[:cut], carried))
            tail = _overlap_tail(current[:cut], count, overlap)
            current, carried = [*tail, *current[cut:]], len(tail)
            used = sum(count(item.text) + 1 for item in current)
        current.append(line)
        used += cost
    if len(current) > carried:
        chunks.append((current, carried))
    return chunks


def join_lines(lines: list[Line]) -> str:
    """Lines as text, PDF line-break hyphenation healed (``unterstüt-\\nzenden``)."""
    return _HYPHEN_BREAK_RE.sub(r"\1\2", "\n".join(line.text for line in lines))


def apply_exclusions(document: Any) -> None:
    """The adapter's embed/LLM exclusions plus this module's own (see ``punkt_chunking``)."""
    try:
        from knowledge_layer.llamaindex.adapter import _apply_metadata_exclusions

        _apply_metadata_exclusions(document)
    except ImportError:  # pragma: no cover - the adapter is always present in practice
        pass
    for attribute in ("excluded_embed_metadata_keys", "excluded_llm_metadata_keys"):
        existing = list(getattr(document, attribute, None) or [])
        merged = existing + [key for key in SECTION_EMBED_EXCLUDED_METADATA_KEYS if key not in existing]
        setattr(document, attribute, merged)


def section_metadata(section: Section, order: int) -> dict[str, Any]:
    """The locator fields a section's chunks carry; none for the preamble."""
    metadata: dict[str, Any] = {"section_order": order}
    if section.heading is None:
        return metadata
    metadata.update(
        {
            "punkt_id": section.locator,
            "punkt_title": section.heading.title,
            "punkt_path": BREADCRUMB_SEP.join(section.path),
            "punkt_depth": section.heading.level,
        }
    )
    return metadata


def chunk_text(section: Section, lines: list[Line]) -> str:
    """A chunk's text: the breadcrumb, a blank line, the body. The preamble has no breadcrumb."""
    if not section.path:
        return join_lines(lines)
    heading = section.heading_lines
    body = join_lines([line for line in lines if not any(line is own for own in heading)])
    return f"{BREADCRUMB_SEP.join(section.path)}\n\n{body}".rstrip()


# --- PDF entry point -------------------------------------------------------------------


def _pdf_section_documents(
    section: Section, order: int, base: dict[str, Any], count: Callable[[str], int]
) -> list[Document]:
    from llama_index.core import Document

    documents = []
    for part, (lines, carried) in enumerate(pack(section.lines, count), start=1):
        own = lines[carried:] or lines
        metadata = {
            **base,
            **section_metadata(section, order),
            "page_label": str(own[0].position),
            "page_end": str(lines[-1].position),
            "content_type": "text",
            "chunking": "section",
            "section_part": part,
        }
        documents.append(Document(text=chunk_text(section, lines), metadata=metadata))
    return documents


def _table_documents(text_pages: list[dict[str, Any]], base: dict[str, Any]) -> list[Document]:
    """Captioned tables, cut out of the page text at extraction, as header-repeating row groups."""
    from knowledge_layer.llamaindex.captioned_tables import join_fragments
    from knowledge_layer.llamaindex.captioned_tables import markdown_row_groups
    from llama_index.core import Document

    fragments = [table for page in text_pages for table in page.get("tables") or []]
    documents = []
    for table in join_fragments(fragments):
        label = f"Tabelle {table.table_id}"
        caption = f"{label}: {table.title}" if table.title else label
        groups = markdown_row_groups(table)
        for part, (_first, _last, markdown) in enumerate(groups, start=1):
            suffix = f" (Teil {part} von {len(groups)})" if len(groups) > 1 else ""
            metadata = {
                **base,
                "page_label": str(table.page_start),
                "page_end": str(table.page_end),
                "content_type": "table",
                "chunking": "table",
                "punkt_id": label,
                "punkt_title": table.title,
                "punkt_path": caption,
                "table_part": part,
            }
            documents.append(Document(text=f"{caption}{suffix}\n\n{markdown}", metadata=metadata))
    return documents


def _clean_cell(cell: Any) -> str:
    return re.sub(r"\s+", " ", str(cell or "")).strip().replace("|", "\\|")


def uncaptioned_table_documents(table: dict[str, Any], file_name: str, file_size: int) -> list[Document]:
    """A table without a caption (``_extract_tables_from_pdf``) as header-repeating row groups.

    It was one Document holding the whole Markdown table, which the splitter cut wherever
    its budget ran out: every piece after the first was a run of cells under no header.
    Each group now repeats the header row, so the splitter never has to cut a table.
    A table dict without its raw ``cells`` keeps the single Document.
    """
    from knowledge_layer.llamaindex.captioned_tables import Table
    from knowledge_layer.llamaindex.captioned_tables import markdown_row_groups
    from llama_index.core import Document

    page = table["page_number"]
    base = {
        "file_name": file_name,
        "file_size": file_size,
        "page_label": str(page),
        "content_type": "table",
        "table_index": table["table_index"],
        "rows": table["rows"],
        "cols": table["cols"],
    }
    rows = [[_clean_cell(cell) for cell in row] for row in table.get("cells") or []]
    rows = [row for row in rows if any(row)]
    if len(rows) < 2:
        return [Document(text=f"[TABLE from page {page}]\n\n{table['table_text']}", metadata=base)]
    groups = markdown_row_groups(Table("", "", rows, page_start=page, page_end=page))
    documents = []
    for part, (_first, _last, markdown) in enumerate(groups, start=1):
        suffix = f" (Teil {part} von {len(groups)})" if len(groups) > 1 else ""
        document = Document(
            text=f"[TABLE from page {page}]{suffix}\n\n{markdown}", metadata={**base, "table_part": part}
        )
        apply_exclusions(document)
        documents.append(document)
    return documents


def section_documents(text_pages: list[dict[str, Any]], file_name: str, file_size: int) -> list[Document] | None:
    """Chunk a PDF on its own headings, or ``None`` when it has no usable heading structure.

    ``text_pages`` is ``_extract_text_from_pdf``'s output. ``None`` sends the caller back
    to the per-page Documents it has always built.
    """
    lines = document_lines(text_pages)
    if not lines:
        return None
    sections = build_sections(lines, find_headings(lines))
    if not structure_is_usable(lines, sections):
        return None
    base = {"file_name": file_name, "file_size": file_size}
    count = _token_counter()
    documents: list[Any] = []
    for order, section in enumerate(sections):
        documents.extend(_pdf_section_documents(section, order, base, count))
    documents.extend(_table_documents(text_pages, base))
    for document in documents:
        apply_exclusions(document)
    return documents
