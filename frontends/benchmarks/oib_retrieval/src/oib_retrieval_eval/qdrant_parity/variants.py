"""The ranking sweep: the Qdrant path under each candidate ``search.Ranking``, per question.

``task be:eval:qdrant-parity -- --variants all`` runs it after the gates, over the
collection the gates just built, so every variant reads the same points and the
same index. Each variant swaps ``knowledge_layer.qdrant.search.RANKING`` for the
duration of its run and reads through ``LlamaIndexRetriever._retrieve_sync``, the
production path, so a variant measures exactly what production would serve with
those settings.

Per variant it records the primary measures the adoption rule reads (golden nDCG@10
and MRR, hard-case R-precision through full retrieval), the overview cohorts, recall@1,
the store-call latency, how far each hit's served score is from the true cosine
(numpy over the stored vectors), and the per-question numbers the diff against the
baseline is built from. Adoption is a person's decision on that diff; this module
only measures (``qdrant-gates-2026-10.md``, "Ranking sweep").
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Iterator
from collections.abc import Sequence
from typing import Any

import numpy as np

from oib_retrieval_eval import metrics
from oib_retrieval_eval.qdrant_parity import channels
from oib_retrieval_eval.qdrant_parity import decompound
from oib_retrieval_eval.qdrant_parity import evaluation
from oib_retrieval_eval.qdrant_parity.stores import SCOPE

logger = logging.getLogger(__name__)

#: The baseline every other variant is diffed against: production's ranking before the sweep.
BASELINE = "baseline"
#: The baseline measured again after every other variant, on the same collection:
#: the noise floor. A variant whose moves are no larger than this row's measured
#: nothing (TurboQuant scores tie, and tied candidates come back in varying order).
REPEAT = "baseline_repeat"


def plain(**settings: Any) -> Any:
    """A ``search.Ranking`` without the cosine tie-break: production's ranking before the sweep, plus ``settings``."""
    from knowledge_layer.qdrant.search import Ranking

    return Ranking(cosine_tie_break=False, **settings)


def catalogue() -> dict[str, Any]:
    """Every named variant: a ``search.Ranking``, None for dense alone (the adapter's ``hybrid_search`` off),
    or a ``decompound.Variant``."""
    from knowledge_layer.qdrant.search import Ranking

    return {
        BASELINE: plain(),
        "dense_only": None,
        "rescore": plain(rescore=True),
        "rescore_os1.5": plain(rescore=True, oversampling=1.5),
        "rescore_os2": plain(rescore=True, oversampling=2.0),
        "rescore_os3": plain(rescore=True, oversampling=3.0),
        "rrf_k20": plain(rrf_k=20),
        "rrf_k100": plain(rrf_k=100),
        "dense_w1.5": plain(dense_weight=1.5),
        "dense_w2": plain(dense_weight=2.0),
        "dense_w3": plain(dense_weight=3.0),
        "dbsf": plain(fusion="dbsf"),
        "mmr0.2": plain(mmr_diversity=0.2, mmr_candidates=120),
        "mmr0.4": plain(mmr_diversity=0.4, mmr_candidates=120),
        "rescore_os2+dense_w2": plain(rescore=True, oversampling=2.0, dense_weight=2.0),
        "rescore_os2+dbsf": plain(rescore=True, oversampling=2.0, fusion="dbsf"),
        "rescore_os2+mmr0.2": plain(rescore=True, oversampling=2.0, mmr_diversity=0.2, mmr_candidates=120),
        "cosine_ties": Ranking(cosine_tie_break=True),
        "cosine_ties+rescore": Ranking(cosine_tie_break=True, rescore=True),
        "cosine_ties+rrf_k100": Ranking(cosine_tie_break=True, rrf_k=100),
        "cosine_ties+mmr0.2": Ranking(cosine_tie_break=True, mmr_diversity=0.2, mmr_candidates=120),
        # Harness-only experiment: BM25 over text plus compound parts (``decompound.py``).
        # Measured last: its copy of the corpus joins the collection and moves its index.
        "decompound": decompound.Variant(plain()),
        "decompound+cosine_ties": decompound.Variant(Ranking(cosine_tie_break=True)),
        "decompound_index_only": decompound.Variant(plain(), query_parts=False),
        "decompound_index_only+cosine_ties": decompound.Variant(Ranking(cosine_tie_break=True), query_parts=False),
    }


def select(names: str) -> dict[str, Any]:
    """The variants named in a comma list (``all`` for every one); the baseline always comes first."""
    known = catalogue()
    if names.strip() == "all":
        return known
    wanted = [name.strip() for name in names.split(",") if name.strip()]
    unknown = [name for name in wanted if name not in known]
    if unknown:
        raise ValueError(f"unknown variants {unknown}; known: {sorted(known)}")
    return {BASELINE: known[BASELINE], **{name: known[name] for name in wanted}}


@contextlib.contextmanager
def ranking(retriever: Any, setting: Any) -> Iterator[None]:
    """``search.RANKING`` set to ``setting`` for the block; None turns the lexical channels off instead."""
    from knowledge_layer.qdrant import search

    saved, saved_hybrid = search.RANKING, retriever.hybrid_search
    if setting is None:
        retriever.hybrid_search = False
    else:
        search.RANKING = setting
    try:
        yield
    finally:
        search.RANKING, retriever.hybrid_search = saved, saved_hybrid


def _first_rank(ranked: Sequence[Any], relevant: set[Any]) -> int | None:
    return next((rank for rank, unit in enumerate(ranked, 1) if unit in relevant), None)


def measure(
    inputs: Any,
    retriever: Any,
    setting: Any,
    relevant_counts: dict[str, int],
    rounds: int,
    depth: int,
    units: Any,
    files: Any,
    scope: str = SCOPE,
) -> dict[str, Any]:
    """One variant's scores and per-question detail. ``units``/``files`` collapse a chunk list (``runner.Corpus``)."""
    filters = channels.base_filters(sorted(inputs.excluded))
    answerable = [j for j in inputs.judgements if j.graded]
    rows = {chunk.chunk_id: row for row, chunk in enumerate(inputs.chunks)}
    docs = inputs.doc_vectors / np.linalg.norm(inputs.doc_vectors, axis=1, keepdims=True)
    questions = [j.entry.question for j in answerable] + [e.question for e in inputs.overview]
    rankings: dict[str, list[Any]] = {}
    latency: list[float] = []
    cosine_error: list[float] = []
    with ranking(retriever, setting):
        for round_index in range(rounds + 1):  # round 0 is the scored one and warms the caches
            for question in questions:
                hits, elapsed = channels.hybrid(retriever, question, depth, filters, scope)
                if round_index:
                    latency.append(elapsed)
                    continue
                rankings[question] = hits
                query = inputs.query_vectors[question] / np.linalg.norm(inputs.query_vectors[question])
                # ``Chunk.score`` is the cosine floored at 0 (``cosine_similarity_from_store_score``).
                cosine_error.extend(
                    abs(float(chunk.score) - max(0.0, float(docs[rows[chunk.chunk_id]] @ query)))
                    for chunk in hits
                    if chunk.chunk_id in rows
                )
        hard = [
            evaluation.score_hard_case(
                case,
                [chunk.content for chunk in channels.hybrid(retriever, case.query, depth, filters, scope)[0]],
                relevant_counts[case.id],
            )
            for case in inputs.hard_cases
        ]
    unit_rankings = [units(rankings[j.entry.question]) for j in answerable]
    graded = [dict(j.graded) for j in answerable]
    golden = evaluation.score_graded(unit_rankings, graded, evaluation.HYBRID_K)
    per_golden = {
        j.entry.id: {
            "first": _first_rank(ranked, set(grades)),
            "ndcg10": round(metrics.ndcg_at_k(ranked, grades, 10), 4),
        }
        for j, ranked, grades in zip(answerable, unit_rankings, graded, strict=True)
    }
    per_overview: dict[str, dict[str, Any]] = {}
    cohorts: dict[str, list[dict[str, Any]]] = {}
    for entry in inputs.overview:
        ranked_files = files(rankings[entry.question])
        expected = set(entry.expected)
        row = {
            "cohort": entry.cohort,
            "recall16": round(metrics.recall_at_k(ranked_files, expected, 16), 4),
            "pool": round(len(expected & set(ranked_files)) / len(expected), 4),
            "first": _first_rank(ranked_files, expected),
            "rr": metrics.mrr(ranked_files, expected),
        }
        per_overview[entry.id] = row
        cohorts.setdefault(entry.cohort, []).append(row)
    return {
        "label": "dense alone (hybrid_search off)" if setting is None else setting.label(),
        "golden": {
            "ndcg10": round(golden.ndcg[10], 4),
            "mrr": round(golden.mrr, 4),
            "recall1": round(golden.recall[1], 4),
            "recall16": round(golden.recall[16], 4),
        },
        "overview": {
            cohort: {
                "queries": len(rows_),
                "recall16": round(metrics.mean([r["recall16"] for r in rows_]), 4),
                "pool": round(metrics.mean([r["pool"] for r in rows_]), 4),
                "mrr": round(metrics.mean([r["rr"] for r in rows_]), 4),
            }
            for cohort, rows_ in sorted(cohorts.items())
        },
        "hard_r_precision": round(evaluation.mean_hard(hard, gating_only=True)["r_precision"], 4),
        "hard_by_kind": {
            "all": round(evaluation.mean_hard(hard)["r_precision"], 4),
            **{
                kind: round(evaluation.mean_hard([h for h in hard if h.kind == kind])["r_precision"], 4)
                for kind in evaluation.HARD_CASE_KINDS
            },
        },
        "latency_ms": evaluation.latency_summary(latency),
        "cosine_error": {
            "max": round(max(cosine_error, default=0.0), 5),
            "mean": round(float(np.mean(cosine_error)) if cosine_error else 0.0, 5),
        },
        "per_golden": per_golden,
        "per_overview": per_overview,
        "per_hard": {score.case_id: round(score.r_precision, 4) for score in hard},
    }


def _moved(base: dict[str, Any], other: dict[str, Any], key: str, *, lower_is_better: bool = False) -> list[str]:
    """Ids whose ``key`` got worse from ``base`` to ``other`` (a missing rank is worst)."""
    worse: list[str] = []
    for qid, row in base.items():
        before, after = row[key] if isinstance(row, dict) else row, other[qid]
        after = after[key] if isinstance(after, dict) else after
        if lower_is_better:
            before = before if before is not None else 10**6
            after = after if after is not None else 10**6
            if after > before:
                worse.append(qid)
        elif after < before - 1e-9:
            worse.append(qid)
    return worse


def diff(base: dict[str, Any], other: dict[str, Any]) -> dict[str, dict[str, list[str]]]:
    """Per question set, which questions got worse and which better against the baseline."""
    out: dict[str, dict[str, list[str]]] = {}
    out["golden_first_rank"] = {
        "worse": _moved(base["per_golden"], other["per_golden"], "first", lower_is_better=True),
        "better": _moved(other["per_golden"], base["per_golden"], "first", lower_is_better=True),
    }
    out["golden_ndcg10"] = {
        "worse": _moved(base["per_golden"], other["per_golden"], "ndcg10"),
        "better": _moved(other["per_golden"], base["per_golden"], "ndcg10"),
    }
    cohorts = sorted({row["cohort"] for row in base["per_overview"].values()})
    for cohort in cohorts:
        before = {q: r for q, r in base["per_overview"].items() if r["cohort"] == cohort}
        after = {q: other["per_overview"][q] for q in before}
        out[f"{cohort}_recall16"] = {
            "worse": _moved(before, after, "recall16"),
            "better": _moved(after, before, "recall16"),
        }
    out["hard_r_precision"] = {
        "worse": _moved(base["per_hard"], other["per_hard"], "r"),
        "better": _moved(other["per_hard"], base["per_hard"], "r"),
    }
    return out


def run(inputs: Any, retriever: Any, relevant_counts: dict[str, int], names: str, rounds: int, depth: int) -> dict:
    """Every selected variant, measured, and each diffed against the baseline."""
    from oib_retrieval_eval.qdrant_parity.runner import Corpus

    chosen = select(names)
    ordinary = {name: setting for name, setting in chosen.items() if not isinstance(setting, decompound.Variant)}
    # The repeat is measured before any decompounded variant, whose copy of the corpus moves the index.
    selected = {**ordinary, REPEAT: chosen[BASELINE], **{n: s for n, s in chosen.items() if n not in ordinary}}
    results: dict[str, Any] = {}
    splitter: decompound.Decompounder | None = None
    for name, setting in selected.items():
        if not isinstance(setting, decompound.Variant):
            results[name] = measure(
                inputs, retriever, setting, relevant_counts, rounds, depth, Corpus.units, Corpus.files
            )
            continue
        if not decompound.available():
            logger.warning("variant %s skipped: split-words is not installed (decompound.py)", name)
            continue
        texts = [chunk.text for chunk in inputs.chunks]
        if splitter is None:
            splitter = decompound.Decompounder(texts)
            logger.warning("decompounded scope: %s", decompound.build_split_scope(splitter, SCOPE))
        with decompound.query_side(splitter, texts, query_parts=setting.query_parts):
            results[name] = measure(
                inputs,
                retriever,
                setting.ranking,
                relevant_counts,
                rounds,
                depth,
                Corpus.units,
                Corpus.files,
                scope=decompound.SPLIT_SCOPE,
            )
        side = "index and query" if setting.query_parts else "index only"
        results[name]["label"] = f"BM25 decompounded ({side}) + " + results[name]["label"]
    base = results[BASELINE]
    for name, result in results.items():
        if name != BASELINE:
            result["diff"] = diff(base, result)
    return results


def render(results: dict[str, Any]) -> list[str]:
    """The sweep as the markdown table the gate report quotes, then each variant's per-question moves."""
    cohorts = sorted(results[BASELINE]["overview"])
    lines = ["## Ranking sweep (Qdrant path, full retrieval)\n"]
    head = ["variant", "settings", "nDCG@10", "MRR", "recall@1", "hard R-prec"]
    head += [f"{c} r@16" for c in cohorts] + ["p95 ms", "cosine err max"]
    lines.append("| " + " | ".join(head) + " |")
    lines.append("|" + "---|" * len(head))
    for name, r in results.items():
        cells = [name, f"`{r['label']}`", r["golden"]["ndcg10"], r["golden"]["mrr"], r["golden"]["recall1"]]
        cells += [r["hard_r_precision"]] + [r["overview"][c]["recall16"] for c in cohorts]
        cells += [r["latency_ms"]["p95"], r["cosine_error"]["max"]]
        lines.append("| " + " | ".join(f"{c:.3f}" if isinstance(c, float) else str(c) for c in cells) + " |")
    kinds = list(results[BASELINE]["hard_by_kind"])
    lines.append("\nHard cases through full retrieval, mean R-precision by kind:\n")
    lines.append("| variant | " + " | ".join(kinds) + " |")
    lines.append("|" + "---|" * (len(kinds) + 1))
    for name, r in results.items():
        lines.append(f"| {name} | " + " | ".join(f"{r['hard_by_kind'][k]:.3f}" for k in kinds) + " |")
    lines.append("\nPer-question moves against the baseline (worse / better):\n")
    for name, r in results.items():
        if name == BASELINE:
            continue
        moves = "; ".join(
            f"{key}: -{len(v['worse'])}/+{len(v['better'])}"
            + (f" (worse: {', '.join(v['worse'])})" if v["worse"] else "")
            for key, v in r["diff"].items()
            if v["worse"] or v["better"]
        )
        lines.append(f"- **{name}**: {moves or 'no question moved'}")
    return lines
