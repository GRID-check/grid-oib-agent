"""PURE: the hard-case fixture, the scores, and the gate verdicts. No store, no network.

THREE KINDS OF LABEL, THREE KINDS OF SCORE
------------------------------------------
* **Punkt golden** (``oib_retrieval_golden.json``): graded ``(file, page)`` units.
  Scored as recall@k, nDCG@k and MRR through :mod:`oib_retrieval_eval.metrics`,
  the functions every other arm of this harness uses.
* **Overview golden** (``oib_golden_overview.json``): expected FILES. Scored as
  file recall@k and MRR, the numbers ``be:eval:overview`` reports.
* **Hard cases** (``qdrant_lexical_hard_cases.json``): a regex oracle over the chunk
  text. Scored per chunk as precision@10 (is what came back about the term),
  R-precision (recall at k = number of relevant chunks, so a term on 250 chunks and
  one on 4 are both judged at their own depth) and MRR.

THE GATES
---------
Thresholds are the design doc's (§10), written here once so the report and the
tests read the same numbers. A gate this harness cannot measure says so; it never
passes by default.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Hashable
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from oib_retrieval_eval import metrics

HARD_CASE_KINDS = ("paragraph", "punkt_number", "allcaps_code", "compound", "compound_only", "umlaut_sz")

#: Kinds whose recall the design expects neither German config to have (closed
#: compounds). They are measured and printed, and excluded from the G1b verdict.
NON_GATING_KINDS = frozenset({"compound_only"})

#: G2: p95 store time per ``knowledge_search`` collection call, milliseconds.
G2_P95_MS = 230.0
#: G6: recall at 1024-d within this many points (absolute, 0-1 scale) of 3072-d.
G6_MAX_DROP = 0.01

#: Cutoffs the hybrid comparison reports. 16 is production's ``top_k``; 60 is the
#: candidate pool ``knowledge_search`` hands the reranker (``rerank_candidates``).
HYBRID_K = (1, 3, 5, 10, 16, 60)
HARD_CASE_PRECISION_K = 10


@dataclass(frozen=True)
class HardCase:
    """One lexical hard case: the query and the oracle that decides relevance."""

    id: str
    kind: str
    query: str
    oracle: str
    exclude: str | None = None
    notes: str = ""

    def relevant(self, text: str) -> bool:
        if not re.search(self.oracle, text, re.IGNORECASE):
            return False
        return not (self.exclude and re.search(self.exclude, text, re.IGNORECASE))


def load_hard_cases(path: str | Path) -> list[HardCase]:
    """Load and strictly validate the hard-case fixture; a malformed case raises."""
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    cases: list[HardCase] = []
    seen: set[str] = set()
    for raw in payload["cases"]:
        case = HardCase(
            id=raw["id"],
            kind=raw["kind"],
            query=raw["query"],
            oracle=raw["oracle"],
            exclude=raw.get("exclude"),
            notes=raw.get("notes", ""),
        )
        if case.id in seen:
            raise ValueError(f"duplicate hard case id {case.id!r}")
        seen.add(case.id)
        if case.kind not in HARD_CASE_KINDS:
            raise ValueError(f"{case.id!r}: unknown kind {case.kind!r}")
        if not case.query.strip():
            raise ValueError(f"{case.id!r}: empty query")
        re.compile(case.oracle)
        if case.exclude:
            re.compile(case.exclude)
        cases.append(case)
    missing = set(HARD_CASE_KINDS) - {case.kind for case in cases}
    if missing:
        raise ValueError(f"hard-case fixture lacks kinds {sorted(missing)}")
    return cases


# ---------------------------------------------------------------- scores


@dataclass(frozen=True)
class RankScores:
    """One channel over one query set."""

    queries: int
    recall: dict[int, float]
    ndcg: dict[int, float]
    mrr: float

    def as_dict(self) -> dict:
        return {
            "queries": self.queries,
            "recall": {str(k): round(v, 4) for k, v in self.recall.items()},
            "ndcg": {str(k): round(v, 4) for k, v in self.ndcg.items()},
            "mrr": round(self.mrr, 4),
        }


def score_graded(
    rankings: Sequence[Sequence[Hashable]], graded: Sequence[dict[Hashable, int]], ks: Sequence[int]
) -> RankScores:
    """recall@k, nDCG@k and MRR over queries that have at least one relevant unit."""
    pairs = [(ranked, grades) for ranked, grades in zip(rankings, graded, strict=True) if grades]
    recall = {k: metrics.mean([metrics.recall_at_k(r, set(g), k) for r, g in pairs]) for k in ks}
    ndcg = {k: metrics.mean([metrics.ndcg_at_k(r, g, k) for r, g in pairs]) for k in ks}
    reciprocal = metrics.mean([metrics.mrr(r, set(g)) for r, g in pairs])
    return RankScores(queries=len(pairs), recall=recall, ndcg=ndcg, mrr=reciprocal)


@dataclass(frozen=True)
class HardCaseScore:
    """One channel on one hard case."""

    case_id: str
    kind: str
    relevant: int
    precision: float
    r_precision: float
    mrr: float
    returned: int


def score_hard_case(case: HardCase, ranked_texts: Sequence[str], relevant_total: int) -> HardCaseScore:
    """Precision@10, R-precision and MRR of one ranking against the case's oracle."""
    hits = [case.relevant(text) for text in ranked_texts]
    top = hits[:HARD_CASE_PRECISION_K]
    precision = sum(top) / HARD_CASE_PRECISION_K
    depth = max(relevant_total, 1)
    r_precision = sum(hits[:depth]) / depth if relevant_total else 0.0
    first = next((rank for rank, hit in enumerate(hits, start=1) if hit), None)
    return HardCaseScore(
        case_id=case.id,
        kind=case.kind,
        relevant=relevant_total,
        precision=precision,
        r_precision=r_precision,
        mrr=1.0 / first if first else 0.0,
        returned=len(ranked_texts),
    )


def mean_hard(scores: Sequence[HardCaseScore], *, gating_only: bool = False) -> dict[str, float]:
    """Mean precision@10, R-precision and MRR over cases with at least one relevant chunk."""
    kept = [s for s in scores if s.relevant and (not gating_only or s.kind not in NON_GATING_KINDS)]
    return {
        "cases": len(kept),
        "precision": metrics.mean([s.precision for s in kept]),
        "r_precision": metrics.mean([s.r_precision for s in kept]),
        "mrr": metrics.mean([s.mrr for s in kept]),
    }


def percentile(samples: Sequence[float], q: float) -> float:
    """The ``q``-th percentile (0-100) by linear interpolation; NaN for no samples."""
    if not samples:
        return math.nan
    ordered = sorted(samples)
    position = (len(ordered) - 1) * q / 100.0
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def latency_summary(samples_ms: Sequence[float]) -> dict[str, float]:
    return {
        "n": len(samples_ms),
        "p50": round(percentile(samples_ms, 50), 2),
        "p95": round(percentile(samples_ms, 95), 2),
        "p99": round(percentile(samples_ms, 99), 2),
        "mean": round(sum(samples_ms) / len(samples_ms), 2) if samples_ms else math.nan,
    }


# ---------------------------------------------------------------- gates


@dataclass(frozen=True)
class Verdict:
    gate: str
    status: str  # "pass" | "fail" | "not measured"
    detail: str


def g1b_lexical_verdict(
    qdrant_golden: RankScores,
    reference_golden: RankScores,
    qdrant_hard: dict[str, float],
    reference_hard: dict[str, float],
    exact_mismatches: int,
    *,
    k: int = 16,
    tolerance: float = 0.0,
) -> Verdict:
    """G1b: Qdrant BM25 recall >= the German channel it replaced, and exact mode unchanged.

    Recall on the Punkt golden set at production's ``top_k`` and R-precision on the
    gating hard cases must both be at least the reference's (the Postgres mirror's
    numbers, ``baseline.py``), and ``find_text`` must return exactly what a full
    regex scan of the corpus returns, as Chroma's ``$regex`` did.
    """
    reasons: list[str] = []
    if qdrant_golden.recall[k] + tolerance < reference_golden.recall[k]:
        reasons.append(f"golden recall@{k} {qdrant_golden.recall[k]:.3f} < reference {reference_golden.recall[k]:.3f}")
    if qdrant_hard["r_precision"] + tolerance < reference_hard["r_precision"]:
        reasons.append(
            f"hard-case R-precision {qdrant_hard['r_precision']:.3f} < reference {reference_hard['r_precision']:.3f}"
        )
    if exact_mismatches:
        reasons.append(f"exact mode differs from a full regex scan on {exact_mismatches} phrase(s)")
    if reasons:
        return Verdict("G1b lexical", "fail", "; ".join(reasons))
    return Verdict(
        "G1b lexical",
        "pass",
        f"golden recall@{k} {qdrant_golden.recall[k]:.3f} >= {reference_golden.recall[k]:.3f}; "
        f"hard-case R-precision {qdrant_hard['r_precision']:.3f} >= {reference_hard['r_precision']:.3f}; "
        "exact mode identical to a full scan",
    )


def g2_latency_verdict(qdrant_ms: dict[str, float]) -> Verdict:
    """G2: p95 store time per collection call at or under 230 ms (this machine only)."""
    p95 = qdrant_ms["p95"]
    status = "pass" if p95 <= G2_P95_MS else "fail"
    return Verdict("G2 latency", status, f"Qdrant p95 {p95:.1f} ms vs {G2_P95_MS:.0f} ms bound (local single node)")


#: Cutoffs G6 is judged at. recall@16 alone saturates on the golden set (every
#: relevant unit is in the top 16 at either dimension), so it cannot see a drop;
#: the top of the ranking can.
G6_K = (1, 5, 16)


def g6_dimension_verdict(full: RankScores, reduced: RankScores, *, label: str) -> Verdict:
    """G6: recall at the reduced dimension within one point of the full one, at every ``G6_K``."""
    drops = {k: full.recall[k] - reduced.recall[k] for k in G6_K}
    status = "pass" if all(drop <= G6_MAX_DROP + 1e-9 for drop in drops.values()) else "fail"
    detail = ", ".join(
        f"recall@{k} {reduced.recall[k]:.3f} vs {full.recall[k]:.3f} ({-drops[k] * 100:+.1f})" for k in G6_K
    )
    return Verdict(f"G6 dimension ({label})", status, f"{detail}; bound -1.0 point; {full.queries} queries")
