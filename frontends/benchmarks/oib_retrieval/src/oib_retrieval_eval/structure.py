"""Structural retrievability: does a Punkt survive chunking as a citable unit?

This is the one measurement in this harness that needs no embedder, no key and no model,
and it is the one that decides citation precision. A Punkt is what an Austrian building-law
answer cites. If the chunk the retriever returns does not correspond to a Punkt, the answer
either cites a chunk containing fifteen unrelated requirements — and the reader cannot tell
which one the number came from — or cites half of one.

THE TWO PROPERTIES, MEASURED SEPARATELY BECAUSE THEY FAIL SEPARATELY
--------------------------------------------------------------------
For each leaf Punkt, against each chunking strategy:

* **contiguous** — the Punkt's full text sits inside a SINGLE chunk. Fails when a chunk
  boundary cuts a requirement in half, so the retriever can only ever return part of it.
* **isolated** — some chunk contains the Punkt whole AND contains no other leaf Punkt
  whole. This is the citable-unit property. A 1024-token window over a page of a numbered
  code passes *contiguous* trivially (it swallows the whole page) while failing *isolated*
  completely, which is exactly the defect Punkt chunking exists to fix, and why reporting
  only contiguity would make the two strategies look nearly identical.

LEAVES ONLY, AND WHY THAT IS NOT A THUMB ON THE SCALE
------------------------------------------------------
189 of the index's 946 Punkte are structural parents: ``3.1 Brandabschnitte`` is a heading
whose requirements live in ``3.1.1``…``3.1.10``. They carry no requirement text of their
own, and the Punkt chunker copies them into every child's breadcrumb — so counting them as
"contained" in a child's chunk would score the breadcrumb as blending. They are excluded
from the numerator and the denominator on both arms equally, and reported as a separate
count. Ancestors are the only Punkte a breadcrumb can name, so no leaf can be inflated by
one.

GROUND TRUTH IS THE COMMITTED INDEX, NOT THE CHUNKER
-----------------------------------------------------
The Punkt spans are located by matching each indexed Punkt id against the raw extracted
line stream, on the page the index says it is on. The Punkt chunker's own segmenter is
never consulted, so a Punkt the chunker fails to recognise — or a content page it
misclassifies as a table of contents and drops — shows up as a MISS for that arm instead
of vanishing from the denominator. Only the running header/footer strip is shared with
production (``_is_furniture``), deliberately: measuring against a different notion of page
furniture would attribute a cleanup difference to chunking.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from oib_retrieval_eval.corpus import ARM_PAGE
from oib_retrieval_eval.corpus import ARM_PUNKT
from oib_retrieval_eval.corpus import CHUNK_OVERLAP
from oib_retrieval_eval.corpus import CHUNK_SIZE
from oib_retrieval_eval.corpus import default_corpus_dir
from oib_retrieval_eval.corpus import extract_pages
from oib_retrieval_eval.corpus import page_documents
from oib_retrieval_eval.corpus import punkt_or_page_documents
from oib_retrieval_eval.qrels import PunktIndex

#: A table-of-contents leader line ("3.1 Brandabschnitte ....... 5") points at a Punkt and
#: is never the Punkt itself, so it must not be mistaken for its heading.
_DOT_LEADER_RE = re.compile(r"\.{4,}")


def _normalise(text: str) -> str:
    """Text as a space-delimited stream of folded lexemes, padded so ``in`` is whole-token.

    Containment is tested on this form rather than on raw text because the two arms hand
    back the same words in different shapes: the Punkt chunker de-hyphenates PDF line
    breaks ("unterstüt-\\nzenden" -> "unterstützenden") and prepends a breadcrumb, while
    the page arm keeps the raw line breaks. Folding both sides through the SAME production
    analyzer (``german_text.fold``/``tokenize``, the lexical channel's own) removes every
    difference that is not a difference in what the chunk contains.
    """
    from knowledge_layer.llamaindex.punkt_chunking import _dehyphenate

    from aiq_agent.common.german_text import fold
    from aiq_agent.common.german_text import tokenize

    return " " + " ".join(tokenize(fold(_dehyphenate(text)))) + " "


def _content_lines(pages: list[dict[str, Any]]) -> list[tuple[int, str]]:
    """``(page_number, line)`` for every non-furniture line, table-of-contents pages KEPT.

    Keeping ToC pages is what lets a content page the chunker wrongly drops as a ToC be
    attributed to that arm — see the module docstring.
    """
    from knowledge_layer.llamaindex.punkt_chunking import _is_furniture

    collected: list[tuple[int, str]] = []
    for page in pages:
        for line in (page.get("text") or "").splitlines():
            stripped = line.strip()
            if stripped and not _is_furniture(stripped):
                collected.append((int(page["page_number"]), stripped))
    return collected


def _body_end(lines: list[tuple[int, str]]) -> int:
    """Index of the ``Impressum`` line that closes the body, or the end of the stream.

    Without this the LAST Punkt of every Richtlinie would absorb the colophon, publisher
    address and back cover, and would then fail containment on every arm for a reason that
    has nothing to do with chunking.
    """
    from knowledge_layer.llamaindex.punkt_chunking import _END_OF_BODY_RE

    for position, (_page, line) in enumerate(lines):
        if _END_OF_BODY_RE.match(line):
            return position
    return len(lines)


def _locate_spans(
    index: PunktIndex, richtlinie: str, lines: list[tuple[int, str]], body_end: int
) -> tuple[dict[str, tuple[int, int]], list[str]]:
    """Line span ``[start, end)`` per indexed Punkt, plus the ids that could not be located.

    A Punkt's heading is searched for on the page the index records it on, which is what
    keeps a cross-reference elsewhere in the document ("gemäß Punkt 5.1.1") from being
    mistaken for the heading. A line already claimed by another Punkt is never reused.
    """
    punkte = index.punkte(richtlinie)
    starts: dict[str, int] = {}
    claimed: set[int] = set()
    for punkt, meta in punkte.items():
        pattern = re.compile(rf"^{re.escape(punkt)}\s+\S")
        first_page = int(meta["pages"][0])
        for position, (page, line) in enumerate(lines[:body_end]):
            if page != first_page or position in claimed:
                continue
            if pattern.match(line) and not _DOT_LEADER_RE.search(line):
                starts[punkt] = position
                claimed.add(position)
                break

    ordered = sorted(starts.items(), key=lambda item: item[1])
    spans: dict[str, tuple[int, int]] = {}
    for position, (punkt, start) in enumerate(ordered):
        end = ordered[position + 1][1] if position + 1 < len(ordered) else body_end
        spans[punkt] = (start, max(end, start + 1))
    return spans, sorted(set(punkte) - set(starts))


@dataclass(frozen=True)
class ArmStructure:
    """One chunking strategy's structural result for one Richtlinie (or summed)."""

    arm: str
    leaf_punkte: int
    contiguous: int
    isolated: int
    chunks: int
    #: Leaf Punkte wholly contained, summed over the chunks containing at least one. A
    #: LOWER BOUND on blending: a leaf split across a chunk boundary is not counted at
    #: all, so the true number of requirements a page chunk touches is higher.
    contained_total: int
    chunks_with_punkte: int

    @property
    def contiguous_pct(self) -> float:
        return 100.0 * self.contiguous / self.leaf_punkte if self.leaf_punkte else 0.0

    @property
    def isolated_pct(self) -> float:
        return 100.0 * self.isolated / self.leaf_punkte if self.leaf_punkte else 0.0

    @property
    def punkte_per_chunk(self) -> float:
        return self.contained_total / self.chunks_with_punkte if self.chunks_with_punkte else 0.0


@dataclass(frozen=True)
class StructureReport:
    """The before/after table, per Richtlinie and summed."""

    per_richtlinie: dict[str, dict[str, ArmStructure]]
    totals: dict[str, ArmStructure]
    indexed_punkte: int
    located_punkte: int
    structural_parents: int
    unlocated: dict[str, list[str]]


def measure_document(
    index: PunktIndex,
    richtlinie: str,
    pages: list[dict[str, Any]],
    file_name: str,
    file_size: int,
) -> tuple[dict[str, ArmStructure], int, int, list[str]]:
    """Measure one already-extracted document on both arms.

    Public so the offline tests can drive it with synthetic pages: it is the whole
    measurement minus the PDF, which is the part that cannot run in CI.

    Returns ``(per-arm results, Punkte located, structural parents, unlocated ids)``.
    """
    lines = _content_lines(pages)
    body_end = _body_end(lines)
    spans, unlocated = _locate_spans(index, richtlinie, lines, body_end)

    leaves = [punkt for punkt in spans if not index.has_children(richtlinie, punkt)]
    leaf_text = {
        punkt: _normalise("\n".join(line for _page, line in lines[spans[punkt][0] : spans[punkt][1]]))
        for punkt in leaves
    }

    results: dict[str, ArmStructure] = {}
    for arm, builder in ((ARM_PAGE, page_documents), (ARM_PUNKT, punkt_or_page_documents)):
        documents = builder(pages, file_name, file_size)
        chunk_texts = _chunk_texts(documents)
        contained_counts = [sum(1 for text in leaf_text.values() if text in chunk) for chunk in chunk_texts]

        contiguous = 0
        isolated = 0
        for punkt_text in leaf_text.values():
            counts = [contained_counts[position] for position, chunk in enumerate(chunk_texts) if punkt_text in chunk]
            if not counts:
                continue
            contiguous += 1
            if min(counts) == 1:
                isolated += 1

        results[arm] = ArmStructure(
            arm=arm,
            leaf_punkte=len(leaves),
            contiguous=contiguous,
            isolated=isolated,
            chunks=len(chunk_texts),
            contained_total=sum(contained_counts),
            chunks_with_punkte=sum(1 for count in contained_counts if count),
        )
    # Parents are counted from the INDEX, not from what was located, so an unlocated
    # Punkt cannot quietly move between the parent and leaf tallies.
    parents = sum(1 for punkt in index.punkte(richtlinie) if index.has_children(richtlinie, punkt))
    return results, len(spans), parents, unlocated


def _chunk_texts(documents: list[Any]) -> list[str]:
    from llama_index.core.node_parser import SentenceSplitter

    splitter = SentenceSplitter(chunk_size=CHUNK_SIZE, chunk_overlap=CHUNK_OVERLAP)
    return [_normalise(node.get_content()) for node in splitter.get_nodes_from_documents(documents)]


def _sum_arms(rows: Iterable[ArmStructure], arm: str) -> ArmStructure:
    rows = list(rows)
    return ArmStructure(
        arm=arm,
        leaf_punkte=sum(row.leaf_punkte for row in rows),
        contiguous=sum(row.contiguous for row in rows),
        isolated=sum(row.isolated for row in rows),
        chunks=sum(row.chunks for row in rows),
        contained_total=sum(row.contained_total for row in rows),
        chunks_with_punkte=sum(row.chunks_with_punkte for row in rows),
    )


def measure_structure(
    index: PunktIndex,
    corpus_dir: Path | None = None,
    cache_dir: Path | None = None,
) -> StructureReport:
    """Run the structural before/after over every Richtlinie in the Punkt index."""
    corpus_dir = default_corpus_dir() if corpus_dir is None else corpus_dir

    per_richtlinie: dict[str, dict[str, ArmStructure]] = {}
    unlocated: dict[str, list[str]] = {}
    located = 0
    parents = 0
    for richtlinie in index.richtlinien:
        file_name = index.file_name(richtlinie)
        pdf_path = corpus_dir / file_name
        pages = extract_pages(pdf_path, cache_dir=cache_dir)
        results, located_here, parents_here, missing = measure_document(
            index, richtlinie, pages, file_name, pdf_path.stat().st_size
        )
        per_richtlinie[richtlinie] = results
        located += located_here
        parents += parents_here
        if missing:
            unlocated[richtlinie] = missing

    totals = {arm: _sum_arms((row[arm] for row in per_richtlinie.values()), arm) for arm in (ARM_PAGE, ARM_PUNKT)}
    return StructureReport(
        per_richtlinie=per_richtlinie,
        totals=totals,
        indexed_punkte=index.total_punkte(),
        located_punkte=located,
        structural_parents=parents,
        unlocated=unlocated,
    )
