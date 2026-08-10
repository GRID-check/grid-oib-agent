"""Ranking metrics for retrieval evaluation. PURE: no NAT, no chroma, no network, no I/O.

Every function here takes a ranked list of opaque, hashable *units* and the judgements
for one query, and returns a number. Nothing in this module knows what a unit is, where
it came from, or which retrieval arm produced it — which is what lets the same code score
the lexical channel, a dense channel, a fused channel and the structural arms without a
per-arm reimplementation that could drift.

THE UNIT IS ``(file_name, page)``, AND IT IS DEDUPLICATED BEFORE IT GETS HERE
----------------------------------------------------------------------------
The product cites a document and a page, so that pair is what a judgement can be made
about, and it is what :mod:`oib_retrieval_eval.qrels` expands a ``(richtlinie, punkt)``
label into. Two chunks of the same page are one unit: the caller must collapse a ranked
CHUNK list into a ranked list of DISTINCT units (first occurrence wins) before calling
anything here. That collapse is not cosmetic — the Punkt-chunked arm emits ~3x as many
chunks as the page-chunked arm, so scoring chunks would hand one arm a longer list for
the same k and make the two arms incomparable.

GRADED, NOT BINARY
------------------
``ndcg_at_k`` takes a grade per unit and uses the standard exponential gain
``2**grade - 1``, so a grade-3 unit (the Punkt that actually answers the question) is
worth 7 and a grade-1 unit (related context) is worth 1. ``recall_at_k`` /
``precision_at_k`` / ``mrr`` binarise: any graded unit counts. Both views are reported
because they fail differently — a channel can have good recall and bad nDCG by burying
the answering Punkt under three context Punkte.

RECALL'S DENOMINATOR IS THE FULL JUDGED SET, NOT ``min(k, |relevant|)``
----------------------------------------------------------------------
A question whose Punkt spans three pages has three relevant units, and recall@1 for it is
capped at 1/3. That is deliberate: normalising the denominator by k would report 1.0 for
a system that found one page of a three-page requirement, which is exactly the partial
answer this corpus punishes. The cap is a property of the question, and the report says
so rather than hiding it in the metric.
"""

from __future__ import annotations

import math
from collections.abc import Container
from collections.abc import Hashable
from collections.abc import Mapping
from collections.abc import Sequence

#: Cutoffs every arm is reported at. 16 is not decoration: it is the ``top_k`` the
#: production retriever is configured with, so recall@16 is the number that decides
#: whether the answer generator could possibly have seen the right Punkt. 1/3/5 show
#: ranking quality above it, 10/20 bracket it.
K_VALUES: tuple[int, ...] = (1, 3, 5, 10, 16, 20)


def _prefix(ranked: Sequence[Hashable], k: int) -> Sequence[Hashable]:
    """The first ``k`` entries, with a hard guard against a nonsensical cutoff."""
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")
    return ranked[:k]


def recall_at_k(ranked: Sequence[Hashable], relevant: Container[Hashable], k: int) -> float:
    """Fraction of the judged-relevant units that appear in the top ``k``.

    ``relevant`` must be sized (a ``set``/``frozenset``); the denominator is its full
    size — see the module docstring for why it is not ``min(k, len(relevant))``.

    An empty ``relevant`` set means "nothing in this corpus answers this question"
    (a should-refuse case). Recall is undefined there, and this returns ``0.0`` rather
    than raising so a should-refuse case can sit in the same table; the report must read
    those rows through :func:`fill_rate`, never through recall.
    """
    total = len(relevant)  # type: ignore[arg-type]
    if total == 0:
        return 0.0
    found = sum(1 for unit in _prefix(ranked, k) if unit in relevant)
    return found / total


def precision_at_k(ranked: Sequence[Hashable], relevant: Container[Hashable], k: int) -> float:
    """Fraction of the top ``k`` RETURNED units that are judged relevant.

    The denominator is ``k``, not ``len(ranked[:k])``: a retriever that returns three
    results for a k of ten has seven empty slots, and charging it for them is the point
    — precision@k is the metric a should-refuse case can legitimately score 0.0 on while
    still returning a full, confident, wrong page of hits.
    """
    hits = sum(1 for unit in _prefix(ranked, k) if unit in relevant)
    return hits / k


def ndcg_at_k(ranked: Sequence[Hashable], grades: Mapping[Hashable, int], k: int) -> float:
    """Normalised discounted cumulative gain at ``k`` with gain ``2**grade - 1``.

    ``grades`` maps a unit to its relevance grade (0 = not relevant, and any unit absent
    from the mapping is treated as grade 0). The ideal ranking is the judged grades
    sorted descending, truncated to ``k`` — so a question with two grade-3 units cannot
    reach 1.0 at k=1, mirroring the recall denominator decision above.

    Returns ``0.0`` when no unit carries a positive grade (a should-refuse case), because
    the ideal DCG is then 0 and the ratio is undefined.
    """
    prefix = _prefix(ranked, k)
    dcg = 0.0
    for rank, unit in enumerate(prefix, start=1):
        grade = grades.get(unit, 0)
        if grade > 0:
            dcg += (2**grade - 1) / math.log2(rank + 1)

    ideal_grades = sorted((grade for grade in grades.values() if grade > 0), reverse=True)[:k]
    idcg = sum((2**grade - 1) / math.log2(rank + 1) for rank, grade in enumerate(ideal_grades, start=1))
    if idcg == 0.0:
        return 0.0
    return dcg / idcg


def mrr(ranked: Sequence[Hashable], relevant: Container[Hashable], k: int | None = None) -> float:
    """Reciprocal rank of the FIRST judged-relevant unit, or ``0.0`` if there is none.

    ``k`` truncates the list first; ``None`` searches the whole ranking. This is the
    per-query reciprocal rank — the mean over queries (the first M in MRR) is the
    caller's job, because the aggregate is taken over different query subsets (all, de,
    en) and averaging here would force a second pass anyway.
    """
    prefix = ranked if k is None else _prefix(ranked, k)
    for rank, unit in enumerate(prefix, start=1):
        if unit in relevant:
            return 1.0 / rank
    return 0.0


def forbidden_rate(
    rankings: Sequence[Sequence[Hashable]],
    forbidden_sets: Sequence[Container[Hashable]],
    k: int,
) -> float:
    """Fraction of queries whose top ``k`` contains at least one FORBIDDEN unit.

    Not an average count: one forbidden hit is the failure, and a query that surfaces
    three of them is not three times as broken — it is the same broken. In this corpus
    the forbidden set is the ``aenderungen_*`` change-log PDFs, which describe what
    changed between editions and are never the answer to "what is required"; citing one
    to an architect is a wrong answer that looks perfectly well-sourced.

    Returns ``0.0`` for an empty query set (no queries, no failures).
    """
    if len(rankings) != len(forbidden_sets):
        raise ValueError(f"rankings ({len(rankings)}) and forbidden_sets ({len(forbidden_sets)}) must be parallel")
    if not rankings:
        return 0.0
    hits = sum(
        1
        for ranked, forbidden in zip(rankings, forbidden_sets, strict=True)
        if any(unit in forbidden for unit in _prefix(ranked, k))
    )
    return hits / len(rankings)


def fill_rate(ranked: Sequence[Hashable], k: int) -> float:
    """Fraction of the ``k`` result slots the retriever actually filled.

    The only metric a should-refuse question can be scored on. A vector store answers
    every query with its ``top_k`` nearest neighbours whether or not any of them is
    related, so a fill rate of 1.0 on a question the corpus cannot answer means the
    system has no abstention path at all and the answer generator is being handed
    confident-looking irrelevant context. That is the highest-consequence failure mode in
    a legal product, and it is invisible to recall/nDCG, which are both 0.0 either way.
    """
    if k <= 0:
        raise ValueError(f"k must be positive, got {k}")
    return min(len(ranked), k) / k


def mean(values: Sequence[float]) -> float:
    """Arithmetic mean, or ``0.0`` for an empty sequence (an empty arm is not an error)."""
    if not values:
        return 0.0
    return sum(values) / len(values)
