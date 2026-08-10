#!/usr/bin/env python3
"""Build the Punkt -> (file_name, pages) index for the OIB retrieval eval harness.

WHY THIS EXISTS
---------------
The retrieval golden set (``frontends/benchmarks/oib_retrieval/fixtures/oib_retrieval_golden.json``)
labels each question with the *Punkte* that answer it — ``("OIB-RL 2", "3.1.1")`` —
because that is the unit an Austrian architect and the product's own citation
contract both speak in (``NormReference.section`` is ``"Pkt. 5.1.1"``). Retrieval,
however, returns ``(file_name, page_number)`` chunks. Something has to translate,
and that translation must be *mechanical* rather than remembered, or the golden
set becomes an unreviewable pile of page numbers somebody typed once.

This script is that translation. It reads the real PDFs in ``data/oib/`` with the
SAME extractor the ingestion path uses (``knowledge_layer.llamaindex.adapter
._extract_text_from_pdf``, pdfplumber + watermark stripping), so a Punkt's page
span in this index is the page span of the text that was actually embedded. Using
a second, differently-behaved PDF reader here would produce an index that is
subtly right about the paper document and wrong about the corpus.

HOW A PUNKT IS RECOGNISED
-------------------------
A candidate heading is a line matching ``^(\\d+(?:\\.\\d+){0,3})\\s+(\\S.*)$``.
That pattern alone is far too generous on this corpus: OIB-RL 5's Außenlärmpegel
tables are ~80 rows of ``"61 51 34 43,5 33,5 28,5 47 60 48"``, every one of which
matches. Two guards separate real headings from table rows and wrapped prose:

1. **Dot-leader rejection** (``\\.{6,}\\s*\\d+\\s*$``). Every Richtlinie opens with
   a table of contents whose entries match the heading pattern exactly and whose
   numbering restarts at ``0`` on the body's first page. Without this guard the
   ToC wins the sequence and the entire body is discarded.
2. **Monotonic Punkt ids**, applied as a *longest valid chain* over the surviving
   candidates in document order rather than a greedy running maximum. A candidate
   is a valid successor of the previous accepted Punkt when it either descends one
   level (``3.1`` -> ``3.1.1``) or increments exactly one existing level by at most
   :data:`MAX_SUCCESSOR_DELTA` (``3.1.8`` -> ``3.1.9``, ``3.1.10`` -> ``3.2``).

   Greedy monotonicity is not enough and the reason is worth stating, because it
   is the whole difficulty of this file. A greedy pass locks onto the first
   candidate it sees; in ``oib-rl_5`` that is the cover page's ``"5 Schutz vor
   Schallimmissionen…"``, after which every real Punkt from ``0`` to ``4.2`` is
   below the running maximum and is thrown away — 49 real Punkte collapse to 10.
   The longest-chain formulation has no such failure mode: a stray candidate can
   only win if the chain through it is longer than the chain through the real
   numbering, which for a 200-Punkt Richtlinie it never is. It is also what
   rejects the table-row labels the brief calls out (a ``1.1 Außenwand…`` row
   appearing after ``4.3`` can extend no long chain) and wrapped prose lines such
   as ``"135 Grad bilden, mindestens 3,00 m betragen."``.
3. **Table-of-contents anchoring.** The ToC lines rejected by guard 1 are not
   discarded — they are read back as ground truth for the ids they list and their
   titles. Two things follow. A candidate whose id the ToC knows but whose title
   contradicts the ToC's cannot be that heading and is dropped outright. A
   candidate whose title *agrees* becomes an **anchor** worth
   :data:`ANCHOR_WEIGHT` in the chain search, which then maximises total weight
   rather than raw length.

   Without this, ``oib-rl_2`` fails in a way that length alone cannot see. Its
   body ends on page 23 and pages 24-36 are annex tables (Tabelle 1a…6) whose row
   labels are themselves a long, clean, monotonic numbering run. The unweighted
   chain leaves the body at Punkt 9 and spends the rest of the document walking
   Tabelle 4's rows, so ``9.1`` resolves to "Lage nicht zutreffend an der
   obersten…" (a table cell) and Punkte 10-12 are lost — a golden entry written
   against ``OIB-RL 2 / 10`` would then have been labelled with a page of Tabelle
   6. Anchoring makes the body path strictly heavier than any table path, because
   only the body carries the ToC's titles.

The chain is computed per file, so one unnumbered document cannot poison another.

WHAT COMES OUT
--------------
``{richtlinie: {punkt: {"file_name": str, "pages": [int, ...], "heading": str}}}``

``pages`` is the inclusive page span from the Punkt's heading page to the page
before the next Punkt's heading — that is, every page a chunk of this Punkt can
land on. The last Punkt in a file runs to the last page carrying text.

``richtlinie`` is derived from the file name (``oib-rl_2.1_ausgabe_mai_2023.pdf``
-> ``"2.1"``; ``oib-rl_2_leitfaden_…`` -> ``"2-leitfaden"``), so the golden set
never has to spell a file name out and a corpus re-sync under a new edition
suffix is a one-line change here.

UNRESOLVED REPORT
-----------------
Two things are reported rather than silently dropped, both printed at the end and
written into the index under ``"_unresolved"``:

* **Files with no usable numbering.** ``oib-rl_begriffsbestimmungen_*`` and both
  ``oib-rl_zitierte_normen_*`` are alphabetical/tabular documents with no Punkt
  hierarchy at all. They are expected members of this list; their presence is not
  a failure, and the golden set must not label anything in them by Punkt.
* **Sequence gaps.** Any place the accepted chain skips (``3.1`` straight to
  ``3.3``) means a heading was missed — usually a heading pdfplumber merged into
  the preceding line. A gap is the honest signal that this index under-covers a
  document, and a golden entry must not be written against a Punkt inside one.

USAGE
-----
    python scripts/build_punkt_index.py --dry-run     # preview, writes nothing
    python scripts/build_punkt_index.py               # build and write the index
    python scripts/build_punkt_index.py --corpus-dir data/oib --out <path>

EXIT CODES
----------
* ``0`` — success. The index was written (or previewed under ``--dry-run``).
  Files with no usable numbering do NOT make this non-zero: they are a known,
  reported property of this corpus, not a run failure.
* ``1`` — the run completed but at least one file could not be read or yielded no
  text at all, so the index is partial. Fail-soft is per file: one unreadable PDF
  never aborts the other 38.
* ``2`` — nothing could be done: the corpus directory does not exist, matched no
  PDFs, or the production text extractor could not be imported.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_CORPUS_DIR = "data/oib"
DEFAULT_PATTERN = "oib-rl_"
DEFAULT_OUT = "frontends/benchmarks/oib_retrieval/fixtures/punkt_index.json"

#: A numbered heading: up to four dot-separated levels, then a non-space title.
HEADING_RE = re.compile(r"^(\d+(?:\.\d+){0,3})\s+(\S.*)$")

#: A table-of-contents line: dot leaders followed by a page number.
DOT_LEADER_RE = re.compile(r"\.{6,}\s*\d+\s*$")

#: Largest jump tolerated at a single numbering level. 1 is the norm; a little
#: slack absorbs the occasional heading pdfplumber glues to the previous line
#: without letting ``3`` -> ``135`` through.
MAX_SUCCESSOR_DELTA = 3

#: A file is only worth reporting as "no usable numbering" if it has real text.
MIN_CHAIN_LENGTH = 2

#: Weight of a ToC-confirmed heading in the chain search. Any value large enough
#: that one anchor outweighs a whole table's worth of rows works; 100 is well
#: clear of the ~80-row Außenlärmpegel tables, the longest run in this corpus.
ANCHOR_WEIGHT = 100

#: Characters of normalised title that must agree for a candidate to be judged
#: the ToC's heading. Long enough to be decisive, short enough to survive the
#: hyphenated line wrap PDFs put in headings ("…für die Konditionie-").
TITLE_MATCH_CHARS = 12

# A page of extracted text: ``{"page_number": int, "text": str}`` — the shape
# ``_extract_text_from_pdf`` returns. Injected so the core is testable without
# a PDF on disk.
PageReader = Callable[[str], list[dict[str, Any]]]


# =============================================================================
# Pure core (no pdfplumber, no filesystem, no NAT)
# =============================================================================


@dataclass(frozen=True)
class Candidate:
    """A line that looks like a numbered heading, before the guards run."""

    key: tuple[int, ...]
    punkt: str
    page: int
    heading: str


@dataclass
class FileExtraction:
    """Everything one PDF contributed, including what was thrown away and why."""

    entries: dict[str, dict[str, Any]] = field(default_factory=dict)
    candidates: int = 0
    anchors: int = 0
    rejected: int = 0
    gaps: list[tuple[str, str]] = field(default_factory=list)
    last_page: int = 0


def parse_punkt_key(punkt: str) -> tuple[int, ...]:
    """``"3.1.10"`` -> ``(3, 1, 10)``. Numeric, so ``3.1.10`` sorts after ``3.1.9``."""
    return tuple(int(part) for part in punkt.split("."))


def is_valid_successor(last: tuple[int, ...], candidate: tuple[int, ...]) -> bool:
    """Could ``candidate`` immediately follow ``last`` in a document's numbering?

    True for exactly two shapes:

    * one level deeper, opening it: ``(3, 1)`` -> ``(3, 1, 1)``
    * an increment of at most :data:`MAX_SUCCESSOR_DELTA` at one existing level,
      with everything above it unchanged: ``(3, 1, 8)`` -> ``(3, 1, 9)``,
      ``(3, 1, 10)`` -> ``(3, 2)``, ``(3, 2)`` -> ``(4,)``.

    The delta bound is what stops a numeric table row (``(135,)`` after
    ``(3, 1, 8)``) from qualifying as a top-level increment.
    """
    if len(candidate) == len(last) + 1 and candidate[:-1] == last and candidate[-1] == 1:
        return True
    for level in range(len(last)):
        if len(candidate) != level + 1 or candidate[:level] != last[:level]:
            continue
        step = candidate[level] - last[level]
        if 0 < step <= MAX_SUCCESSOR_DELTA:
            return True
    return False


def is_immediate_successor(last: tuple[int, ...], candidate: tuple[int, ...]) -> bool:
    """Stricter :func:`is_valid_successor`: no skipped numbers. Used for gap reporting."""
    if len(candidate) == len(last) + 1 and candidate[:-1] == last and candidate[-1] == 1:
        return True
    for level in range(len(last)):
        if len(candidate) == level + 1 and candidate[:level] == last[:level] and candidate[level] == last[level] + 1:
            return True
    return False


def normalize_title(title: str) -> str:
    """Casefold, drop dot leaders/hyphenation, collapse whitespace — for title comparison."""
    text = DOT_LEADER_RE.sub("", title)
    text = re.sub(r"\.{2,}.*$", "", text)
    text = text.replace("­", "").replace("-\n", "")
    text = re.sub(r"[\s\-]+", " ", text)
    return text.strip().casefold()


def titles_agree(left: str, right: str) -> bool:
    """Do two headings name the same thing, allowing for a wrapped/truncated line?"""
    a = normalize_title(left)
    b = normalize_title(right)
    if not a or not b:
        return False
    width = min(len(a), len(b), TITLE_MATCH_CHARS)
    if width < TITLE_MATCH_CHARS and a != b:
        return False
    return a[:width] == b[:width]


def find_toc_titles(pages: list[dict[str, Any]]) -> dict[str, str]:
    """Punkt id -> title, harvested from the dot-leader table-of-contents lines.

    The ToC is the one place in these PDFs that states the document's real
    structure in machine-readable form. Guard 1 throws its lines out of the
    candidate stream; this reads them back as the ground truth they are.
    """
    titles: dict[str, str] = {}
    for page in pages:
        for raw_line in (page.get("text") or "").splitlines():
            line = raw_line.strip()
            match = HEADING_RE.match(line)
            if match is None or not DOT_LEADER_RE.search(line):
                continue
            # First occurrence wins: a two-page ToC never contradicts itself, but
            # a body heading that happens to end in dots must not overwrite it.
            titles.setdefault(match.group(1), normalize_title(match.group(2)))
    return titles


def find_candidates(pages: list[dict[str, Any]], toc_titles: dict[str, str]) -> list[Candidate]:
    """Every numbered-heading-shaped line, in document order, minus ToC lines.

    Candidates the ToC actively contradicts (it lists the id under a different
    title) are dropped here: whatever that line is, it is not that heading.
    """
    candidates: list[Candidate] = []
    for page in pages:
        page_number = int(page.get("page_number") or 0)
        for raw_line in (page.get("text") or "").splitlines():
            line = raw_line.strip()
            match = HEADING_RE.match(line)
            if match is None or DOT_LEADER_RE.search(line):
                continue
            punkt = match.group(1)
            heading = match.group(2).strip()
            expected = toc_titles.get(punkt)
            if expected is not None and not titles_agree(expected, heading):
                continue
            candidates.append(
                Candidate(
                    key=parse_punkt_key(punkt),
                    punkt=punkt,
                    page=page_number,
                    heading=heading,
                )
            )
    return candidates


def candidate_weight(candidate: Candidate, toc_titles: dict[str, str]) -> int:
    """:data:`ANCHOR_WEIGHT` for a ToC-confirmed heading, 1 for anything else."""
    expected = toc_titles.get(candidate.punkt)
    if expected is not None and titles_agree(expected, candidate.heading):
        return ANCHOR_WEIGHT
    return 1


def heaviest_valid_chain(candidates: list[Candidate], toc_titles: dict[str, str] | None = None) -> list[Candidate]:
    """The heaviest subsequence (in document order) that is a valid numbering run.

    Plain O(n^2) dynamic programming — n is a few hundred per file, and the
    alternatives (a greedy running maximum; an unweighted longest chain) are both
    wrong for the reasons spelled out in the module docstring. Ties resolve to the
    earliest chain, so a document whose body genuinely repeats a numbering block
    keeps the first occurrence.
    """
    count = len(candidates)
    if count == 0:
        return []
    weights = [candidate_weight(candidate, toc_titles or {}) for candidate in candidates]

    best = list(weights)
    previous = [-1] * count
    for j in range(count):
        for i in range(j):
            if best[i] + weights[j] > best[j] and is_valid_successor(candidates[i].key, candidates[j].key):
                best[j] = best[i] + weights[j]
                previous[j] = i

    end = max(range(count), key=lambda index: best[index])
    chain: list[Candidate] = []
    while end != -1:
        chain.append(candidates[end])
        end = previous[end]
    return chain[::-1]


def extract_file(pages: list[dict[str, Any]], file_name: str) -> FileExtraction:
    """Turn one document's extracted pages into its Punkt entries plus diagnostics.

    Pure: give it a list of ``{"page_number", "text"}`` dicts and it needs nothing
    else. This is the function the unit tests drive.
    """
    result = FileExtraction()
    if not pages:
        return result

    result.last_page = max(int(page.get("page_number") or 0) for page in pages)
    toc_titles = find_toc_titles(pages)
    candidates = find_candidates(pages, toc_titles)
    result.candidates = len(candidates)
    result.anchors = sum(1 for c in candidates if candidate_weight(c, toc_titles) == ANCHOR_WEIGHT)
    chain = heaviest_valid_chain(candidates, toc_titles)
    result.rejected = len(candidates) - len(chain)

    for index, candidate in enumerate(chain):
        # A Punkt owns every page from its heading up to (but excluding) the page
        # the next Punkt starts on — that is the page range its chunks land on.
        if index + 1 < len(chain):
            end_page = max(candidate.page, chain[index + 1].page - 1)
            if chain[index + 1].page == candidate.page:
                end_page = candidate.page
        else:
            end_page = max(candidate.page, result.last_page)
        result.entries[candidate.punkt] = {
            "file_name": file_name,
            "pages": list(range(candidate.page, end_page + 1)),
            "heading": candidate.heading,
        }
        if index and not is_immediate_successor(chain[index - 1].key, candidate.key):
            result.gaps.append((chain[index - 1].punkt, candidate.punkt))

    return result


def richtlinie_key(file_name: str) -> str:
    """``oib-rl_2.1_ausgabe_mai_2023.pdf`` -> ``"2.1"``; ``oib-rl_2_leitfaden_…`` -> ``"2-leitfaden"``.

    The edition suffix is dropped on purpose: the golden set names a Richtlinie,
    not an edition, and a corpus re-sync to a later Ausgabe should not invalidate
    every label. Documents whose stem carries no Richtlinie number (Begriffs-
    bestimmungen, zitierte Normen) keep their descriptive stem as the key.
    """
    stem = file_name
    for suffix in (".pdf", ".PDF"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
    stem = re.sub(r"^(oib-rl|oib_rl)[_-]", "", stem)
    stem = re.sub(r"[_-]ausgabe[_-]mai[_-]\d{4}.*$", "", stem)
    return stem.replace("_", "-") or file_name


# =============================================================================
# I/O shell
# =============================================================================


def make_page_reader() -> PageReader | None:
    """The production per-page PDF text extractor, or None when unavailable.

    Deliberately the ingestion path's own function rather than a fresh pdfplumber
    loop: the index must describe the text that was embedded, watermark stripping
    and all.
    """
    try:
        from knowledge_layer.llamaindex.adapter import _extract_text_from_pdf
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        logger.error("Could not import the production PDF extractor: %s", exc)
        return None
    return _extract_text_from_pdf


@dataclass
class BuildStats:
    files_read: int = 0
    files_failed: int = 0
    punkte: int = 0


def build_index(
    file_paths: list[str],
    *,
    page_reader: PageReader,
) -> tuple[dict[str, Any], list[str], list[str], BuildStats]:
    """Read every file and assemble the index. Fail-soft per file.

    Returns ``(index, no_numbering, gap_reports, stats)``.
    """
    index: dict[str, Any] = {}
    no_numbering: list[str] = []
    gap_reports: list[str] = []
    stats = BuildStats()

    for path in file_paths:
        file_name = os.path.basename(path)
        try:
            pages = page_reader(path)
        except Exception as exc:  # noqa: BLE001 - one bad PDF must not abort the run
            logger.warning("Could not read %s (%s: %s); skipping.", file_name, type(exc).__name__, exc)
            stats.files_failed += 1
            continue

        if not pages:
            logger.warning("No extractable text in %s; skipping.", file_name)
            stats.files_failed += 1
            continue

        stats.files_read += 1
        extraction = extract_file(pages, file_name)
        key = richtlinie_key(file_name)

        if len(extraction.entries) < MIN_CHAIN_LENGTH:
            no_numbering.append(file_name)
            logger.info("No usable Punkt numbering in %s (%d candidate line(s))", file_name, extraction.candidates)
            continue

        index[key] = extraction.entries
        stats.punkte += len(extraction.entries)
        for previous, following in extraction.gaps:
            gap_reports.append(f"{key}: {previous} -> {following}")
        logger.info(
            "%-52s %-14s punkte=%4d rejected=%4d gaps=%d",
            file_name,
            key,
            len(extraction.entries),
            extraction.rejected,
            len(extraction.gaps),
        )

    return index, no_numbering, gap_reports, stats


def collect_pdfs(corpus_dir: str, prefix: str) -> list[str]:
    """Every ``prefix*.pdf`` in ``corpus_dir``, sorted for a reproducible index."""
    if not os.path.isdir(corpus_dir):
        return []
    return sorted(
        os.path.join(corpus_dir, name)
        for name in os.listdir(corpus_dir)
        if name.startswith(prefix) and name.lower().endswith(".pdf")
    )


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--corpus-dir", default=DEFAULT_CORPUS_DIR, help=f"PDF directory (default: {DEFAULT_CORPUS_DIR})"
    )
    parser.add_argument(
        "--prefix", default=DEFAULT_PATTERN, help=f"File-name prefix to index (default: {DEFAULT_PATTERN})"
    )
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"Output JSON path (default: {DEFAULT_OUT})")
    parser.add_argument("--dry-run", action="store_true", help="Report what would be indexed; write nothing.")
    parser.add_argument("--verbose", action="store_true", help="Debug logging.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    file_paths = collect_pdfs(args.corpus_dir, args.prefix)
    if not file_paths:
        logger.error("No %s*.pdf found under %s", args.prefix, args.corpus_dir)
        return 2

    page_reader = make_page_reader()
    if page_reader is None:
        logger.error("The production PDF extractor is unavailable; cannot build an index that matches the corpus.")
        return 2

    index, no_numbering, gap_reports, stats = build_index(file_paths, page_reader=page_reader)

    payload: dict[str, Any] = dict(sorted(index.items()))
    payload["_unresolved"] = {
        "no_usable_numbering": no_numbering,
        "sequence_gaps": gap_reports,
        "unreadable_files": stats.files_failed,
    }

    print("")
    print(f"Richtlinien indexed : {len(index)}")
    print(f"Punkte indexed      : {stats.punkte}")
    print(f"Files read          : {stats.files_read} (failed: {stats.files_failed})")
    print("")
    print("UNRESOLVED — no usable Punkt numbering:")
    for name in no_numbering or ["  (none)"]:
        print(f"  {name}")
    print("")
    print("UNRESOLVED — sequence gaps (a heading was missed; do not label inside these):")
    for gap in gap_reports or ["  (none)"]:
        print(f"  {gap}")
    print("")

    if args.dry_run:
        print(f"[dry-run] would write {args.out}")
        return 0

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=False)
        handle.write("\n")
    print(f"Wrote {args.out}")

    # A partial index is reported to CI, but the index that was built is still
    # written — a missing PDF should not also cost us the 38 that read fine.
    return 1 if stats.files_failed else 0


if __name__ == "__main__":
    sys.exit(main())
