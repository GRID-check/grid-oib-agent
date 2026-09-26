"""A selected section, as the thing a reader cites.

Everything a citation needs and nothing it does not: the Kurztitel, the §, the
key the answer copies, the text, and an honest score. The four naming decisions
that had to be made here each carry their reason in the function that makes
them — they are what the rest of the system reads RIS by.
"""

from __future__ import annotations

from dataclasses import dataclass

from ris_adapter.lookup.address import Address
from ris_adapter.lookup.candidates import Candidate
from ris_adapter.lookup.extract import Selection
from ris_adapter.lookup.grammar import PASSAGE_MAX_CHARS
from ris_adapter.lookup.grammar import SECTION_MAX_CHARS
from ris_adapter.lookup.grammar import absatz_body
from ris_adapter.lookup.grammar import cut_on_absatz
from ris_adapter.register import _RIS_TITLE_FASSUNG_RE
from ris_adapter.register import _RIS_TITLE_PREFIX_RE
from ris_adapter.register import _legal_status_note

#: The doc_class every RIS passage carries. Human-set classes beat filename
#: guesses everywhere else in this repo; here the producer KNOWS the class, and
#: stating it is what puts the hit in the Rechtsquelle lane instead of "unknown"
#: (``norm_registry.lane_for_hit`` reads doc_class first).
DOC_CLASS = "gesetz"

#: What the ``Relevance Score:`` line means for RIS. It is NOT a similarity:
#: this tool resolves an ADDRESS, it does not embed anything. A passage the
#: caller named by § scores :data:`SCORE_ADDRESSED`; a passage the picker
#: ranked scores :data:`SCORE_RANKED_TOP` minus its rank. The line is emitted
#: because it is also the header/body delimiter of the grounding grammar
#: (``citation_verification._kl_block_header``).
SCORE_ADDRESSED = 1.0
SCORE_RANKED_TOP = 0.9
SCORE_RANK_STEP = 0.05


@dataclass(frozen=True)
class Passage:
    """One citable passage: what the reader gets and what the parser reads."""

    title: str
    url: str
    collection: str
    punkt_label: str
    citation: str
    body: str
    score: float
    status_note: str = ""


def build_passages(selections: list[Selection], address: Address) -> list[Passage]:
    """Render every selected section into a citable passage."""
    # The list budget is per call, so it divides by the picks of EVERY document.
    limit = _passage_limit(address, sum(len(selection.picks) for selection in selections))
    return [passage for selection in selections for passage in _passages_for(selection, address, limit)]


def _passages_for(selection: Selection, address: Address, limit: int) -> list[Passage]:
    """The passages of ONE document, each cut to ``limit`` characters."""
    candidate = selection.fetched.candidate
    document = selection.fetched.document
    title = document_title(candidate, document)
    status_note = _legal_status_note(document.url) or ""
    collection = collection_for(candidate)
    out: list[Passage] = []
    for rank, (section, absatz) in enumerate(selection.picks):
        body, resolved = absatz_body(section, absatz)
        label = f"{section.label} Abs {resolved}" if resolved else section.label
        out.append(
            Passage(
                title=title,
                url=document.url,
                collection=collection,
                punkt_label=label,
                citation=citation_for(title, label, candidate.version_date),
                body=cut_on_absatz(body, limit),
                score=score_for(rank, address.has_section),
                status_note=status_note,
            )
        )
    return out


#: What a LIST of named §§ may return in one call, all passages together. One
#: named § gets SECTION_MAX_CHARS; six of them at that size were ~48k
#: characters in one tool result, re-sent with every later call of the turn.
LIST_MAX_CHARS = 2 * SECTION_MAX_CHARS


def _passage_limit(address: Address, picks: int) -> int:
    """Characters per passage: a named § whole, a list sharing one budget, a ranked hit a chunk."""
    if not address.has_section:
        return PASSAGE_MAX_CHARS
    if len(address.sections) <= 1:
        return SECTION_MAX_CHARS
    # Never more than a single named § gets: a list whose other §§ the law lacks is one §.
    return min(SECTION_MAX_CHARS, max(PASSAGE_MAX_CHARS, LIST_MAX_CHARS // max(picks, 1)))


def collection_for(candidate: Candidate) -> str:
    """Where in RIS this text came from, as a collection id.

    Not a knowledge-base collection: RIS is not one. It carries the same FACT
    the ``Collection:`` line carries for a corpus hit — which body of law this
    is — and the lanes read the doc_class, never this string.
    """
    parts = ["ris", candidate.application or "kons"]
    if candidate.bundesland:
        parts.append(candidate.bundesland)
    return "/".join(parts)


def citation_for(title: str, punkt_label: str, version_date: str) -> str:
    """``<Kurztitel>, § 63 Abs 1 (Fassung 2026-03-14)`` — the key the answer copies.

    The Fassung parenthetical is emitted ONLY when RIS stated an in-force date
    for this document. The date in a RIS page title is the RETRIEVAL stamp, not
    a version (``register._RIS_TITLE_FASSUNG_RE`` exists because that stamp made
    the same law ingest anew every day); putting it in a citation key would make
    the key change daily, which is the same defect one layer up.
    """
    key = ", ".join(part for part in (title.strip(), punkt_label.strip()) if part) or "RIS-Dokument"
    return f"{key} (Fassung {version_date})" if version_date else key


def document_title(candidate: Candidate, document) -> str:
    """The Kurztitel a citation names, without the retrieval stamp."""
    raw = candidate.title or document.title or ""
    return _RIS_TITLE_FASSUNG_RE.sub("", _RIS_TITLE_PREFIX_RE.sub("", raw)).strip(" ,-–—") or "RIS-Dokument"


def score_for(rank: int, addressed: bool) -> float:
    """See :data:`SCORE_ADDRESSED` — a rank, stated honestly, not a similarity."""
    if addressed:
        return SCORE_ADDRESSED
    return max(0.5, SCORE_RANKED_TOP - rank * SCORE_RANK_STEP)
