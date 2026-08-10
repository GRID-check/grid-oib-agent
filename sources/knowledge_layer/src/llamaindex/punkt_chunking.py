"""Punkt-aware chunking for the OIB Richtlinien corpus.

Ingestion builds one llama-index ``Document`` per pdfplumber page and lets
``SentenceSplitter(chunk_size=1024, chunk_overlap=128)`` cut it up. On this corpus that
is the wrong unit of meaning twice over:

* A *Punkt* -- the numbered requirement (``3.1.3``) an Austrian building-law answer must
  cite -- has a median length of 62 tokens across the 1360 Punkte in the 15 base
  Richtlinien, and only 10 of those 1360 exceed the splitter's ~977-token effective
  budget. A 1024-token window therefore blends roughly 15 unrelated requirements into
  one vector, so the embedding describes none of them.
* 150 of 262 body pages (57%) *begin* mid-Punkt, and the splitter's 128-token overlap
  cannot repair that because each page is its own ``Document`` -- overlap never crosses
  the boundary. 92% of today's chunks do not start on a Punkt-numbered line.

This module rebuilds the unit: join the page stream first, cut on the Punkt numbering,
and emit one ``Document`` per Punkt carrying a breadcrumb the embedder can use. Over-long
Punkte need no special handling -- the ``Document`` is left whole and ``SentenceSplitter``
splits it downstream, where llama-index copies parent metadata onto every child node, so
sub-chunks inherit ``punkt_id`` for free.

The module is deliberately pure and dependency-light: ``punkt_documents`` takes the
already-extracted, watermark-stripped page dicts, so it is fully testable without a PDF.
llama-index and the adapter are imported lazily inside the entry point -- the adapter
imports *this* module, and a module-level import back would close the cycle.

Not every file in ``data/oib/`` is Punkt-structured (``Begriffsbestimmungen`` is an
alphabetical glossary, ``Zitierte Normen`` is a four-column table). For those
``punkt_documents`` returns ``None`` and the caller keeps today's per-page behaviour.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:  # pragma: no cover - typing only
    from llama_index.core import Document

# Running furniture, derived from all 40 PDFs in ``data/oib/``. The header is identical
# on 646 of 686 extracted pages; the footer varies only in the document label, the
# optional revision and the optional page counter. Together they account for the ~11,179
# tokens of boilerplate that are currently indexed corpus-wide -- every page contributing
# the same two lines is pure noise in a vector, and worse, it is noise that *matches*
# every query mentioning "OIB-Richtlinie".
_HEADER_RE = re.compile(r"^Österreichisches Institut für Bautechnik\b")
_FOOTER_RE = re.compile(r"^.{0,90}?\bAusgabe\s+Mai\s+\d{4}\b(?:\s+Rev\.\s*[\d.]+)?(?:\s+Seite\s+\d+\s+von\s+\d+)?\s*$")
#: Same shape as ``_FOOTER_RE`` but capturing the document label in front of the date,
#: which is the most reliable name for the Richtlinie: it recurs on nearly every page,
#: whereas the cover page is rotated/garbled by pdfplumber ("neinilthcir").
_FOOTER_LABEL_RE = re.compile(
    r"^(?P<label>\S.{0,88}?)\s+Ausgabe\s+Mai\s+\d{4}\b(?:\s+Rev\.\s*[\d.]+)?(?:\s+Seite\s+\d+\s+von\s+\d+)?\s*$"
)

#: A run of dots is the table-of-contents leader ("3.1 Brandabschnitte ......... 3").
_DOT_LEADER_RE = re.compile(r"\.{4,}")
#: Three leader lines on one page is well clear of prose (which never produces one) and
#: still catches the shortest ToC in the corpus (OIB-Richtlinie 1, three entries).
_TOC_MIN_DOT_LEADER_LINES = 3

#: The Punkt heading itself. Bounded at four levels because the corpus never nests
#: deeper, and an unbounded run of dot-separated numbers matches version strings.
_PUNKT_RE = re.compile(r"^(\d+(?:\.\d+){0,3})\s+(\S.*)$")

#: PDF line-break hyphenation ("unterstüt-\nzenden"). Restricted to a lowercase German
#: continuation so genuine compound hyphens ("Brand-\nAbschnitt", "EI2 30-C") survive:
#: a real hyphen before a line break is followed by an uppercase letter or a digit.
_HYPHEN_BREAK_RE = re.compile(r"(\w)-\n([a-zäöüß])")

#: The colophon that closes every Richtlinie. Everything after it (publisher address,
#: disclaimer, back cover) is furniture; without this marker it is silently glued onto
#: the *last* Punkt of every file, which is the one requirement no one would suspect.
_END_OF_BODY_RE = re.compile(r"^Impressum\s*$")

#: Fallback gates. Five accepted Punkte is below anything the corpus produces for a real
#: Richtlinie (the smallest, OIB-Richtlinie 1, has 8) and above what an accidental match
#: run can reach. 60% coverage catches the shape where a handful of headings are found in
#: a document that is mostly something else -- there the per-page chunks are still better.
_MIN_PUNKTE = 5
_MIN_PUNKT_COVERAGE = 0.60

#: A Punkt id segment is one or two digits. German thousands separators are the reason:
#: "1.200 m² nicht überschreiten" parses as a perfectly monotonic id ``(1, 200)`` and
#: would open a bogus Punkt in the middle of a requirement. Three-digit groups are always
#: a number, never a Punkt.
_MAX_ID_SEGMENT_DIGITS = 2

#: Largest forward jump accepted between siblings. One skipped number absorbs a heading
#: that extraction mangled; more than that is a different numbering scheme (a table).
_MAX_ID_GAP = 2

#: The first Punkt of a Richtlinie is "0 Vorbemerkungen" or "1 ...", never anything else.
_MAX_FIRST_ID = 1

#: Metadata that exists for citation ranges, diagnostics or filtering and carries no
#: retrieval signal, so it must not be prepended to the text the embedder sees. Extends
#: the adapter's ``EMBED_EXCLUDED_METADATA_KEYS`` rather than replacing it.
PUNKT_EMBED_EXCLUDED_METADATA_KEYS = ("page_end", "punkt_depth", "chunking")

#: Separator for the ancestor breadcrumb. A guillemet reads as hierarchy to the embedder
#: without colliding with the ">" that appears in the corpus' own comparison operators.
_BREADCRUMB_SEP = " › "


def _is_furniture(line: str) -> bool:
    """True for a running header/footer line that repeats on every page."""
    return bool(_HEADER_RE.match(line) or _FOOTER_RE.match(line))


def _is_toc_page(text: str) -> bool:
    """True for a table-of-contents page.

    ToC entries are Punkt-numbered and would otherwise be accepted as Punkt starts,
    producing a full set of empty duplicates that outranks the real requirements (a ToC
    line is short and dense with the heading words a query uses).
    """
    return sum(1 for line in text.splitlines() if _DOT_LEADER_RE.search(line)) >= _TOC_MIN_DOT_LEADER_LINES


def _parse_punkt_id(raw: str) -> tuple[int, ...] | None:
    """Parse ``"3.1.3"`` into ``(3, 1, 3)``, or ``None`` when it cannot be a Punkt id."""
    segments = raw.split(".")
    for segment in segments:
        # Leading zeros never occur in the numbering but do occur in dates and codes.
        if len(segment) > _MAX_ID_SEGMENT_DIGITS or (len(segment) > 1 and segment.startswith("0")):
            return None
    return tuple(int(segment) for segment in segments)


def _is_monotonic(candidate: tuple[int, ...], previous: tuple[int, ...] | None) -> bool:
    """True when ``candidate`` may follow ``previous`` in outline order.

    This is the load-bearing guard. The corpus' tables are laid out with a numbered row
    label in the first column -- Tabelle 1b opens with ``1.1 im obersten Geschoß`` on a
    page that comes *after* Punkt 12 -- which is textually indistinguishable from a Punkt
    heading. Comparing ids rejects every one of them without needing table geometry, word
    positions or a page-layout model, because a document's numbering only moves forward
    while a table restarts at 1.

    Plain ``candidate > previous`` is not enough, and the corpus says so loudly. A
    requirement that wraps onto a line beginning with a bare measurement -- OIB-Richtlinie
    2 has ``30 cm und einer Höhe von 20 cm`` inside Punkt 3.5.2 -- parses as the top-level
    id ``(30,)``, which sorts after ``(3, 5, 2)`` and so passes the naive test. It then
    parks the cursor at 30 and every genuine Punkt from 3.5.3 to the end of the file is
    rejected behind it: measured, 37 Punkte survived instead of 227. So monotonicity is
    checked as *outline succession* -- the candidate must be the next sibling (allowing at
    most one skipped number, in case a heading was mangled during extraction) or a
    descent into a fresh sub-level -- which is strictly stronger than ``>`` and rejects
    the runaway jump while still accepting every real heading in the corpus.
    """
    if previous is None:
        # Every Richtlinie opens at "0 Vorbemerkungen" or "1 ...". Anchoring the start
        # stops a stray number on the cover page from claiming the first Punkt.
        return len(candidate) == 1 and candidate[0] <= _MAX_FIRST_ID
    # Descent: 3 -> 3.1, or the rarer 4 -> 4.1.1 where an intermediate level is unnumbered.
    if len(candidate) > len(previous):
        return candidate[: len(previous)] == previous and set(candidate[len(previous) :]) == {1}
    # Sibling at this or any enclosing level: 3.1.9 -> 3.1.10, 3.1.10 -> 3.2, 3.13.3 -> 4.
    level = len(candidate) - 1
    if candidate[:level] != previous[:level]:
        return False
    return 1 <= candidate[level] - previous[level] <= _MAX_ID_GAP


def _is_plausible_heading(title: str) -> bool:
    """True unless the text after the number reads as a sentence continuation.

    Second line of defence against numeric wrap-around lines such as ``10 cm aus
    expandiertem Polystyrol``: German capitalises nouns and sentence openings, so a real
    Punkt body never starts with a lowercase letter, while a continuation almost always
    does. Cheap, and independent of the numbering, so the two guards fail differently.
    """
    return not title[:1].islower()


def _dehyphenate(text: str) -> str:
    """Repair PDF line-break hyphenation across the joined stream.

    ``unterstüt-\\nzenden`` is a word form no query contains and no tokenizer relates to
    ``unterstützenden``, so it is dead weight in both the vector and the BM25 channel.
    Applied after the page stream is joined, so it heals breaks that span a page too.
    """
    return _HYPHEN_BREAK_RE.sub(r"\1\2", text)


def _document_label(lines: list[str]) -> str:
    """Best name for the Richtlinie, taken from the recurring footer.

    The cover page carries the title in rotated type that pdfplumber returns reversed
    ("neinilthcir"), so the footer -- present on nearly every page and always in reading
    order -- is the trustworthy source. Ties are broken by frequency.
    """
    labels: Counter[str] = Counter()
    for line in lines:
        match = _FOOTER_LABEL_RE.match(line)
        if match:
            labels[match.group("label").strip()] += 1
    return labels.most_common(1)[0][0] if labels else ""


def _document_subject(lines: list[str]) -> str:
    """The Richtlinie's subject ("Brandschutz"), read off the title page.

    Every title page in the corpus ends its masthead with ``Ausgabe: Mai <year>`` and puts
    the subject on the one to three lines directly above it, below a marker line that is
    either the ``Oia``/``O ia`` logo fragment, the ``-Richtlinie n`` continuation or the
    ``Erläuternde Bemerkungen zu`` lead-in. Walking backwards from the date to that marker
    is the only stable way in: the lines themselves have no distinguishing shape. Returns
    ``""`` when the masthead does not match, and the breadcrumb then carries the label
    alone rather than a guess.
    """
    marker = re.compile(r"^(?:-|O\s?ia\b|Erläuternde\b|Bemerkungen\b)")
    for index, line in enumerate(lines):
        if not re.match(r"^Ausgabe:\s*Mai\s*\d{4}\s*$", line):
            continue
        collected: list[str] = []
        for candidate in reversed(lines[max(0, index - 4) : index]):
            if marker.match(candidate):
                return " ".join(reversed(collected)).strip()
            collected.append(candidate.strip())
        return ""
    return ""


def _collect_lines(text_pages: list[dict[str, Any]]) -> list[tuple[int, str]]:
    """Flatten the page stream into ``(page_number, line)`` pairs, minus the furniture.

    Joining *before* splitting is the whole point: it is what heals the 150 body pages
    that begin mid-Punkt. Keeping the page number on every line is what lets the emitted
    Document still report the page it started on, which is the citation contract the UI
    and the eval harness already depend on.
    """
    collected: list[tuple[int, str]] = []
    for page in text_pages:
        text = page.get("text") or ""
        if _is_toc_page(text):
            continue
        page_number = page.get("page_number")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped and not _is_furniture(stripped):
                collected.append((page_number, stripped))
    return collected


class _Segment:
    """One contiguous run of lines: a Punkt, or the preamble/postamble around them."""

    __slots__ = ("depth", "lines", "parent_id", "punkt_id", "title")

    def __init__(self, punkt_id: str, title: str, depth: int, parent_id: str) -> None:
        self.punkt_id = punkt_id
        self.title = title
        self.depth = depth
        self.parent_id = parent_id
        self.lines: list[tuple[int, str]] = []

    @property
    def text(self) -> str:
        return _dehyphenate("\n".join(line for _page, line in self.lines))

    @property
    def page_start(self) -> int:
        return self.lines[0][0]

    @property
    def page_end(self) -> int:
        return self.lines[-1][0]


def _split_into_segments(
    lines: list[tuple[int, str]],
) -> tuple[list[tuple[int, str]], list[_Segment], list[tuple[int, str]]]:
    """Cut the line stream into preamble, Punkt segments and postamble."""
    preamble: list[tuple[int, str]] = []
    postamble: list[tuple[int, str]] = []
    segments: list[_Segment] = []
    previous_id: tuple[int, ...] | None = None
    ended = False

    for page_number, line in lines:
        if ended:
            postamble.append((page_number, line))
            continue
        if _END_OF_BODY_RE.match(line):
            ended = True
            postamble.append((page_number, line))
            continue

        match = _PUNKT_RE.match(line)
        # A dot-leader line that survived the page-level ToC check (a stray entry on a
        # content page) is a pointer to a Punkt, never the Punkt itself.
        parsed = None
        if match is not None and not _DOT_LEADER_RE.search(line) and _is_plausible_heading(match.group(2)):
            parsed = _parse_punkt_id(match.group(1))
        if parsed is not None and _is_monotonic(parsed, previous_id):
            previous_id = parsed
            raw_id = match.group(1)
            parent_id = raw_id.rsplit(".", 1)[0] if "." in raw_id else ""
            segments.append(_Segment(raw_id, match.group(2).strip(), len(parsed), parent_id))
            segments[-1].lines.append((page_number, line))
        elif segments:
            segments[-1].lines.append((page_number, line))
        else:
            preamble.append((page_number, line))

    return preamble, segments, postamble


def _breadcrumb_path(segments: list[_Segment], index: int) -> list[str]:
    """Ancestor headings of ``segments[index]``, outermost first.

    Walks backwards for the nearest shallower segment rather than looking ids up in a
    map, so a Richtlinie that skips a level (``4`` straight to ``4.1.1``) still gets the
    ancestors it actually has instead of a hole.
    """
    path: list[str] = []
    depth = segments[index].depth
    for candidate in reversed(segments[:index]):
        if candidate.depth < depth:
            path.append(f"{candidate.punkt_id} {candidate.title}")
            depth = candidate.depth
            if depth == 1:
                break
    path.reverse()
    return path


def _apply_exclusions(document: Any) -> None:
    """Apply the adapter's embed/LLM metadata exclusions plus this module's own.

    Imported here rather than at module scope because the adapter imports this module;
    a top-level import would close the cycle. Reused rather than duplicated so the
    non-semantic key list cannot drift between the two chunking paths.
    """
    from sources.knowledge_layer.src.llamaindex.adapter import _apply_metadata_exclusions

    _apply_metadata_exclusions(document)
    for attribute in ("excluded_embed_metadata_keys", "excluded_llm_metadata_keys"):
        existing = list(getattr(document, attribute, None) or [])
        merged = existing + [key for key in PUNKT_EMBED_EXCLUDED_METADATA_KEYS if key not in existing]
        setattr(document, attribute, merged)


def _richtlinie_key(file_name: str) -> str:
    """``oib-rl_2.1_ausgabe_mai_2023.pdf`` -> ``"2.1"``; ``oib-rl_2_leitfaden_…`` -> ``"2-leitfaden"``.

    The metadata key a filter matches on, which is NOT the human heading the breadcrumb
    carries -- one is ``"2.1"``, the other ``"OIB-Richtlinie 2.1 — Brandschutz"``.

    The edition suffix is dropped, and matched generically rather than against ``mai``:
    ``guess_display_title`` hardcodes ``ausgabe_mai_2023`` and therefore silently loses
    the edition of every other Ausgabe, which is the bug this deliberately does not
    repeat. A document whose stem carries no Richtlinie number keeps its stem.
    """
    stem = file_name
    for suffix in (".pdf", ".PDF"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
    stem = re.sub(r"^(oib-rl|oib_rl)[_-]", "", stem)
    stem = re.sub(r"[_-]ausgabe[_-][^_-]+[_-]\d{4}.*$", "", stem, flags=re.IGNORECASE)
    return stem.replace("_", "-") or file_name


def punkt_documents(text_pages: list[dict[str, Any]], file_name: str, file_size: int) -> list[Document] | None:
    """Chunk an OIB Richtlinie into one Document per numbered Punkt.

    ``text_pages`` is ``_extract_text_from_pdf``'s output: watermark-stripped
    ``{"page_number": int, "text": str}`` dicts in page order.

    Returns ``None`` when the document is not Punkt-structured -- fewer than five accepted
    Punkte, or Punkte covering under 60% of the body text -- so the caller keeps today's
    per-page Documents. ``Begriffsbestimmungen`` (an alphabetical glossary) and both
    ``Zitierte Normen`` files take that path.

    Text outside the Punkt run is preserved, not dropped: the cover page and
    ``0 Vorbemerkungen``' preceding matter, and the Impressum after it, are emitted as
    per-page Documents tagged ``chunking: "page"``. ``page_label`` is the Punkt's *first*
    page, which keeps the existing citation contract intact for a Punkt that spans pages;
    ``page_end`` records the other end.
    """
    from llama_index.core import Document

    if not text_pages:
        return None

    lines = _collect_lines(text_pages)
    if not lines:
        return None

    preamble, segments, postamble = _split_into_segments(lines)
    if len(segments) < _MIN_PUNKTE:
        return None

    body_characters = sum(len(line) for _page, line in lines)
    punkt_characters = sum(len(line) for segment in segments for _page, line in segment.lines)
    if not body_characters or punkt_characters / body_characters < _MIN_PUNKT_COVERAGE:
        return None

    # Both names are read from the *raw* stream: the label lives in the footer and the
    # subject on the title page, and `_collect_lines` has already dropped the first and
    # skipped the second as a ToC page.
    raw_lines = [line.strip() for page in text_pages for line in (page.get("text") or "").splitlines() if line.strip()]
    label = _document_label(raw_lines)
    subject = _document_subject(raw_lines)
    heading = f"{label} — {subject}" if label and subject else (label or subject or file_name)
    richtlinie = _richtlinie_key(file_name)

    documents: list[Document] = []
    base_metadata = {"file_name": file_name, "file_size": file_size}

    for page_number, page_lines in _group_by_page(preamble + postamble):
        documents.append(
            Document(
                text=_dehyphenate("\n".join(page_lines)),
                metadata={
                    **base_metadata,
                    "page_label": str(page_number),
                    "content_type": "text",
                    "chunking": "page",
                    "richtlinie": richtlinie,
                },
            )
        )

    for index, segment in enumerate(segments):
        path = _breadcrumb_path(segments, index)
        header = heading
        if path:
            header = f"{heading}\n{_BREADCRUMB_SEP.join(path)}"
        documents.append(
            Document(
                text=f"{header}\n\n{segment.text}",
                metadata={
                    **base_metadata,
                    "page_label": str(segment.page_start),
                    "page_end": str(segment.page_end),
                    "content_type": "text",
                    "chunking": "punkt",
                    "punkt_id": segment.punkt_id,
                    "punkt_path": _BREADCRUMB_SEP.join([*path, f"{segment.punkt_id} {segment.title}"]),
                    "punkt_parent_id": segment.parent_id,
                    "punkt_title": segment.title,
                    "punkt_depth": segment.depth,
                    "richtlinie": richtlinie,
                },
            )
        )

    for document in documents:
        _apply_exclusions(document)

    return documents


def _group_by_page(lines: list[tuple[int, str]]) -> list[tuple[int, list[str]]]:
    """Regroup ``(page, line)`` pairs into per-page blocks, preserving order."""
    grouped: list[tuple[int, list[str]]] = []
    for page_number, line in lines:
        if grouped and grouped[-1][0] == page_number:
            grouped[-1][1].append(line)
        else:
            grouped.append((page_number, [line]))
    return grouped
