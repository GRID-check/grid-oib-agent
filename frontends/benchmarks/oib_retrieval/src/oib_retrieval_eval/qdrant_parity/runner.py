"""``task be:eval:qdrant-parity``: run the Qdrant retrieval gates on the OIB corpus.

    PYTHONPATH=src:frontends/benchmarks/oib_retrieval/src:sources/knowledge_layer/src \\
      .venv/bin/python -m oib_retrieval_eval.qdrant_parity.runner --out /tmp/qdrant-parity

Needs: the corpus in ``data/oib`` (operator-provided), a Qdrant 1.19 server
(``--qdrant-url``, default ``$AIQ_QDRANT_TEST_URL`` or ``http://localhost:6333``), and
for ``--embedder production`` (the default) an OpenRouter key.

Chroma left the stack in one change (ADR-0113). Where a gate once compared against
the Chroma path (its Postgres German mirror, its full retrieval, its latency), it
now compares against that path's numbers from the final gate run, ``baseline.py``,
printed beside every Qdrant row; the exact mode compares ``find_text`` with a full
regex scan of the corpus, which is what Chroma's ``$regex`` was.

What it measures, how, and what it does not: ``docs/architecture/qdrant-gates-2026-10.md``
and the package docstring. Results are printed as markdown and written as
``results.json`` + ``report.md`` under ``--out``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
import sys
import uuid
from collections.abc import Sequence
from dataclasses import asdict
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any

import numpy as np

from oib_retrieval_eval import corpus
from oib_retrieval_eval import metrics
from oib_retrieval_eval import qrels
from oib_retrieval_eval.qdrant_parity import baseline
from oib_retrieval_eval.qdrant_parity import channels
from oib_retrieval_eval.qdrant_parity import dimension
from oib_retrieval_eval.qdrant_parity import evaluation
from oib_retrieval_eval.qdrant_parity import stores
from oib_retrieval_eval.qdrant_parity import variants
from oib_retrieval_eval.qdrant_parity.stores import IndexedChunk
from oib_retrieval_eval.qdrant_parity.vectors import Embedder
from oib_retrieval_eval.qdrant_parity.vectors import embed_text

logger = logging.getLogger(__name__)

_CHUNK_NAMESPACE = uuid.UUID("0f4e8a52-3c1d-4b8e-9f60-7a2d1c5e9b31")

#: Retrieval depth of the hybrid comparison: production's ``rerank_candidates``,
#: the pool ``knowledge_search`` asks each collection for.
HYBRID_DEPTH = 60
#: Depth the lexical channels are read to; well above every reported cutoff.
LEXICAL_DEPTH = 120
LEXICAL_K = (1, 5, 10, 16, 20)

#: Phrases the exact-mode check runs: the hard cases plus multi-word, separator
#: and transliteration cases ``browse.phrase_pattern`` exists for.
EXTRA_EXACT_PHRASES = (
    "Fluchtweg",
    "Geschoß",
    "Gebäudeklasse 5",
    "Rauchabzugseinrichtung",
    "barrierefrei",
    "OIB Richtlinie 2",
    "mindestens 2,00 m",
    "Brandwand",
    "Stiegenhaus",
    "nicht brennbar",
)


@dataclass
class Inputs:
    """Everything one run reads: the corpus, the labels, the vectors."""

    chunks: list[IndexedChunk]
    doc_vectors: np.ndarray
    judgements: list[qrels.Judgements]
    overview: list[Any]
    hard_cases: list[evaluation.HardCase]
    excluded: frozenset[str]
    query_vectors: dict[str, np.ndarray] = field(default_factory=dict)
    embedder: str = "production"
    model: str = ""
    base_url: str = ""
    embedded_now: int = 0


# ---------------------------------------------------------------- inputs


def indexed_chunks(raw: Sequence[corpus.Chunk]) -> list[IndexedChunk]:
    """The harness chunks with UUID ids (a chunk id that is a UUID is its own Qdrant point id)."""
    return [
        IndexedChunk(
            chunk_id=str(uuid.uuid5(_CHUNK_NAMESPACE, chunk.chunk_id)),
            text=chunk.text,
            file_name=chunk.file_name,
            page=chunk.page,
            metadata={key: value for key, value in chunk.metadata.items() if value is not None},
        )
        for chunk in raw
    ]


def all_queries(inputs: Inputs) -> list[str]:
    seen: dict[str, None] = {}
    for judged in inputs.judgements:
        seen[judged.entry.question] = None
    for entry in inputs.overview:
        seen[entry.question] = None
    for case in inputs.hard_cases:
        seen[case.query] = None
    return list(seen)


def embed_inputs(inputs: Inputs, embedder: Embedder) -> None:
    texts = [embed_text(chunk.text, chunk.metadata) for chunk in inputs.chunks]
    inputs.doc_vectors = embedder.embed("document", texts)
    queries = all_queries(inputs)
    vectors = embedder.embed("query", queries)
    inputs.query_vectors = {query: vectors[i] for i, query in enumerate(queries)}
    inputs.embedder = embedder.name
    inputs.model = embedder.model
    inputs.base_url = embedder.base_url
    inputs.embedded_now = embedder.embedded_now


# ---------------------------------------------------------------- helpers


class Corpus:
    """Lookups over the indexed chunks under production's base filter."""

    def __init__(self, chunks: Sequence[IndexedChunk], excluded: frozenset[str]):
        self.chunks = list(chunks)
        self.by_id = {chunk.chunk_id: chunk for chunk in chunks}
        self.excluded = excluded

    def allowed(self, chunk: IndexedChunk) -> bool:
        return chunk.file_name not in self.excluded and chunk.metadata.get("chunking") != channels.NON_EVIDENCE_CHUNKING

    def allowed_ids(self, ids: Sequence[str]) -> list[IndexedChunk]:
        return [self.by_id[i] for i in ids if i in self.by_id and self.allowed(self.by_id[i])]

    @staticmethod
    def units(chunks: Sequence[Any]) -> list[qrels.Unit]:
        seen: dict[qrels.Unit, None] = {}
        for chunk in chunks:
            page = getattr(chunk, "page", None)
            if page is None:
                page = getattr(chunk, "page_number", None)
            if page is None:
                continue
            seen.setdefault(qrels.Unit(chunk.file_name, int(page)), None)
        return list(seen)

    @staticmethod
    def files(chunks: Sequence[Any]) -> list[str]:
        return list(dict.fromkeys(chunk.file_name for chunk in chunks))


def _graded(judgements: Sequence[qrels.Judgements]) -> list[dict]:
    return [dict(judged.graded) for judged in judgements]


# ---------------------------------------------------------------- measurements


def measure_lexical(inputs: Inputs, corpus_view: Corpus, retriever: Any) -> dict[str, Any]:
    """G1b ranking half: Qdrant BM25 alone, golden and hard cases (the reference is ``baseline``)."""
    filters = channels.base_filters(sorted(inputs.excluded))
    german = [j for j in inputs.judgements if j.entry.language == "de"]

    def rank(query: str) -> list[IndexedChunk]:
        return corpus_view.allowed_ids(channels.qdrant_bm25(retriever, query, LEXICAL_DEPTH, filters))

    allowed_chunks = [chunk for chunk in corpus_view.chunks if corpus_view.allowed(chunk)]
    relevant_counts = {
        case.id: sum(1 for chunk in allowed_chunks if case.relevant(chunk.text)) for case in inputs.hard_cases
    }
    de_rankings = [Corpus.units(rank(j.entry.question)) for j in german]
    golden = {
        "qdrant_bm25": evaluation.score_graded(de_rankings, _graded(german), LEXICAL_K),
        "qdrant_bm25:empty": sum(1 for r in de_rankings if not r) / max(len(de_rankings), 1),
    }
    hard = {
        "qdrant_bm25": [
            evaluation.score_hard_case(case, [c.text for c in rank(case.query)], relevant_counts[case.id])
            for case in inputs.hard_cases
        ]
    }
    return {"golden": golden, "hard": hard, "relevant_counts": relevant_counts}


def measure_exact(inputs: Inputs, corpus_view: Corpus, retriever: Any) -> list[dict[str, Any]]:
    """Exact mode: Qdrant ``find_text`` vs a full regex scan vs the phrase index alone, per phrase."""
    filters = channels.base_filters(sorted(inputs.excluded))
    phrases = list(dict.fromkeys([case.query for case in inputs.hard_cases] + list(EXTRA_EXACT_PHRASES)))
    allowed = [chunk for chunk in corpus_view.chunks if corpus_view.allowed(chunk)]
    rows: list[dict[str, Any]] = []
    for phrase in phrases:
        scan = channels.regex_oracle(allowed, phrase)
        found = channels.exact_matches(retriever, phrase, filters)
        index_only = channels.phrase_index_matches(phrase, filters)
        rows.append(
            {
                "phrase": phrase,
                "regex_scan": len(scan),
                "qdrant_find_text": len(found),
                "identical": scan == found,
                "only_scan": len(scan - found),
                "only_qdrant": len(found - scan),
                "phrase_index": len(index_only),
                "phrase_index_misses": len(scan - index_only),
                "phrase_index_extra": len(index_only - scan),
            }
        )
    return rows


def measure_hybrid(inputs: Inputs, retriever: Any, rounds: int) -> dict[str, Any]:
    """Hybrid recall through the production retriever, and its store-call latency over ``rounds`` passes."""
    filters = channels.base_filters(sorted(inputs.excluded))
    answerable = [j for j in inputs.judgements if j.graded]
    questions = [j.entry.question for j in answerable] + [e.question for e in inputs.overview]
    rankings: dict[str, list[Any]] = {}
    latency: list[float] = []
    for round_index in range(rounds + 1):  # round 0 warms caches and is not timed
        for question in questions:
            hits, elapsed = channels.hybrid(retriever, question, HYBRID_DEPTH, filters)
            if round_index == 0:
                rankings[question] = hits
            else:
                latency.append(elapsed)
    unit_rankings = [Corpus.units(rankings[j.entry.question]) for j in answerable]

    def golden(language: str | None) -> evaluation.RankScores:
        pairs = [(r, j) for r, j in zip(unit_rankings, answerable, strict=True) if language in (None, j.entry.language)]
        return evaluation.score_graded([r for r, _ in pairs], _graded([j for _, j in pairs]), evaluation.HYBRID_K)

    files = {question: Corpus.files(hits) for question, hits in rankings.items()}
    return {
        "latency_ms": evaluation.latency_summary(latency),
        "golden_all": golden(None),
        "golden_de": golden("de"),
        "golden_en": golden("en"),
        "overview": _overview_scores(inputs.overview, rankings),
        # Per overview question: where the first expected file lands, and the top
        # files. The per-expectation detail a reviewer reads before trusting a cohort mean.
        "overview_per_query": {
            entry.id: {
                "first_expected_rank": next(
                    (rank for rank, f in enumerate(files[entry.question], 1) if f in entry.expected), None
                ),
                "recall@16": metrics.recall_at_k(files[entry.question], set(entry.expected), 16),
                "top_files": files[entry.question][:3],
            }
            for entry in inputs.overview
        },
    }


def measure_hybrid_hard(inputs: Inputs, retriever: Any, relevant: dict[str, int]) -> list[evaluation.HardCaseScore]:
    """The hard cases through the FULL retrieval: what an architect typing „§ 3“ gets back.

    G1b scores the lexical channel alone; this asks the question the gate exists
    for, with every channel the retrieval fuses (dense, BM25, the exact term).
    """
    filters = channels.base_filters(sorted(inputs.excluded))
    return [
        evaluation.score_hard_case(
            case,
            [chunk.content for chunk in channels.hybrid(retriever, case.query, HYBRID_DEPTH, filters)[0]],
            relevant[case.id],
        )
        for case in inputs.hard_cases
    ]


def _overview_scores(entries: Sequence[Any], rankings: dict[str, list[Any]]) -> dict[str, dict[str, float]]:
    by_cohort: dict[str, list[tuple[list[str], set[str]]]] = {}
    for entry in entries:
        by_cohort.setdefault(entry.cohort, []).append((Corpus.files(rankings[entry.question]), set(entry.expected)))
    return {
        cohort: {
            "queries": len(pairs),
            "recall@16": round(metrics.mean([metrics.recall_at_k(r, rel, 16) for r, rel in pairs]), 4),
            # Every file the 60-chunk pool reaches: what the reranker can still choose from.
            "recall_pool": round(metrics.mean([len(rel & set(r)) / len(rel) for r, rel in pairs]), 4),
            "mrr": round(metrics.mean([metrics.mrr(r, rel) for r, rel in pairs]), 4),
        }
        for cohort, pairs in sorted(by_cohort.items())
    }


def measure_dimension(inputs: Inputs, corpus_view: Corpus, client: Any | None) -> dict[str, Any]:
    """G6: recall at 3072 vs 1024 (exact and through Qdrant's index, float and TurboQuant)."""
    answerable = [j for j in inputs.judgements if j.graded]
    queries = np.stack([inputs.query_vectors[j.entry.question] for j in answerable])
    docs = inputs.doc_vectors / np.linalg.norm(inputs.doc_vectors, axis=1, keepdims=True)
    queries = queries / np.linalg.norm(queries, axis=1, keepdims=True)
    depth = 400  # deep enough that dropping excluded files leaves the 60 scored

    def unit_of(row: int) -> qrels.Unit:
        chunk = corpus_view.chunks[row]
        return qrels.Unit(chunk.file_name, chunk.page)

    def allowed(row: int) -> bool:
        return corpus_view.allowed(corpus_view.chunks[row])

    def scores(rows_per_query: list[list[int]]) -> evaluation.RankScores:
        units = [dimension.to_units(rows, unit_of, allowed, HYBRID_DEPTH) for rows in rows_per_query]
        return evaluation.score_graded(units, _graded(answerable), evaluation.HYBRID_K)

    full = docs.shape[1]
    reduced = dimension.REDUCED if full > dimension.REDUCED else full // 2
    result: dict[str, Any] = {
        "dimension": int(full),
        "reduced": int(reduced),
        "exact_full": scores(dimension.exact_rankings(docs, queries, depth)),
        "exact_reduced": scores(
            dimension.exact_rankings(
                dimension.truncate_renormalise(docs, reduced), dimension.truncate_renormalise(queries, reduced), depth
            )
        ),
    }
    if client is not None and full == dimension.FULL:
        ann, info = dimension.qdrant_rankings(client, docs, queries, depth)
        result["qdrant_index"] = info
        for variant, rows in ann.items():
            result[f"qdrant_{variant}"] = scores(rows)
    return result


# ---------------------------------------------------------------- the run


def environment(qdrant_url: str) -> dict[str, str]:
    info = {
        "python": platform.python_version(),
        "machine": platform.machine(),
        "cpus": str(os.cpu_count()),
        "qdrant_url": qdrant_url,
    }
    try:
        import httpx

        info["qdrant"] = httpx.get(qdrant_url, timeout=5).json().get("version", "?")
    except Exception:  # noqa: BLE001 - informational only
        info["qdrant"] = "?"
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("model name"):
                info["cpu"] = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    return info


def run(
    inputs: Inputs,
    *,
    qdrant_url: str,
    rounds: int,
    with_dimension: bool = True,
    variant_names: str | None = None,
) -> dict[str, Any]:
    """Index the corpus into Qdrant from ``inputs``, measure every gate, return the results dict.

    ``variant_names`` (a comma list, or ``all``) also runs the ranking sweep
    (``variants.py``) over the same collection.
    """
    corpus_view = Corpus(inputs.chunks, inputs.excluded)
    fingerprint = stores.identity(inputs.model, inputs.base_url)
    report: dict[str, Any] = {
        "corpus": {
            "chunks": len(inputs.chunks),
            "allowed_chunks": sum(1 for c in inputs.chunks if corpus_view.allowed(c)),
            "files": len({c.file_name for c in inputs.chunks}),
            "dimension": int(inputs.doc_vectors.shape[1]),
        },
        "embedder": {"name": inputs.embedder, "model": inputs.model, "embedded_this_run": inputs.embedded_now},
        "queries": {
            "golden": len(inputs.judgements),
            "golden_answerable": sum(1 for j in inputs.judgements if j.graded),
            "overview": len(inputs.overview),
            "hard_cases": len(inputs.hard_cases),
        },
        "reference": baseline.SOURCE,
    }
    with stores.isolated_qdrant(qdrant_url):
        report["environment"] = environment(qdrant_url)
        report["corpus"]["qdrant_count"] = stores.fill_qdrant(inputs.chunks, inputs.doc_vectors, fingerprint)
        report["qdrant_index"] = stores.wait_until_indexed()

        queries = list(inputs.query_vectors)
        matrix = np.stack([inputs.query_vectors[q] for q in queries])
        reader = stores.retriever(inputs.model, inputs.base_url, queries, matrix)

        report["lexical"] = measure_lexical(inputs, corpus_view, reader)
        report["exact"] = measure_exact(inputs, corpus_view, reader)
        report["hybrid"] = measure_hybrid(inputs, reader, rounds)
        report["hybrid_hard"] = measure_hybrid_hard(inputs, reader, report["lexical"]["relevant_counts"])
        if variant_names:
            report["variants"] = variants.run(
                inputs, reader, report["lexical"]["relevant_counts"], variant_names, rounds, HYBRID_DEPTH
            )
        if with_dimension:
            from knowledge_layer.qdrant.store import get_store

            report["dimension"] = measure_dimension(inputs, corpus_view, get_store().client)
    report["verdicts"] = [asdict(v) for v in verdicts(report)]
    return _plain(report)


def verdicts(report: dict[str, Any]) -> list[evaluation.Verdict]:
    lexical = report["lexical"]
    exact_mismatches = sum(1 for row in report["exact"] if not row["identical"])
    out = [
        evaluation.g1b_lexical_verdict(
            lexical["golden"]["qdrant_bm25"],
            baseline.LEXICAL_GOLDEN,
            evaluation.mean_hard(lexical["hard"]["qdrant_bm25"], gating_only=True),
            baseline.LEXICAL_HARD,
            exact_mismatches,
        ),
        evaluation.g2_latency_verdict(report["hybrid"]["latency_ms"]),
    ]
    dim = report.get("dimension")
    if dim and dim["dimension"] == dimension.FULL:
        out.append(evaluation.g6_dimension_verdict(dim["exact_full"], dim["exact_reduced"], label="exact cosine"))
        if "qdrant_q3072" in dim:
            out.append(
                evaluation.g6_dimension_verdict(
                    dim["qdrant_q3072"], dim["qdrant_q1024"], label="HNSW + TurboQuant 4-bit"
                )
            )
    else:
        out.append(evaluation.Verdict("G6 dimension", "not measured", "needs the production 3072-d vectors"))
    out.append(
        evaluation.Verdict("G1 answer quality", "not measured", "needs a running stack: task be:eval:answer-suite")
    )
    out.append(evaluation.Verdict("G3 isolation", "not measured here", "the knowledge-layer isolation property test"))
    out.append(evaluation.Verdict("G4 operations / G5 memory", "not measured here", "ops drills on the cluster"))
    return out


def _plain(value: Any) -> Any:
    """The results as JSON-ready plain data."""
    if isinstance(value, evaluation.RankScores):
        return value.as_dict()
    if isinstance(value, evaluation.HardCaseScore):
        return asdict(value)
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, float):
        return round(value, 4)
    return value


# ---------------------------------------------------------------- the report


def _fmt(value: Any) -> str:
    return f"{value:.3f}" if isinstance(value, float) else str(value)


def _hard_tables(
    lines: list[str], hard: dict[str, list[dict]], relevant_counts: dict[str, int], reference: dict[str, Any]
) -> None:
    """Per-case P@10 / R-precision per channel, then the means over the gating cases and the reference's."""
    names = list(hard)
    lines.append("| case | kind | relevant | " + " | ".join(f"{n} P@10 / R-prec" for n in names) + " |")
    lines.append("|---|---|---|" + "---|" * len(names))
    by_channel = {name: {row["case_id"]: row for row in rows} for name, rows in hard.items()}
    for case_id, relevant in relevant_counts.items():
        kind = by_channel[names[0]][case_id]["kind"]
        cells = [
            f"{by_channel[n][case_id]['precision']:.2f} / {by_channel[n][case_id]['r_precision']:.2f}" for n in names
        ]
        lines.append(f"| {case_id} | {kind} | {relevant} | " + " | ".join(cells) + " |")
    lines.append("\n| channel | gating cases | mean P@10 | mean R-prec | mean MRR |")
    lines.append("|---|---|---|---|---|")
    for name in names:
        summary = evaluation.mean_hard([evaluation.HardCaseScore(**row) for row in hard[name]], gating_only=True)
        lines.append(
            f"| {name} | {summary['cases']} | {summary['precision']:.3f} | {summary['r_precision']:.3f} | "
            f"{summary['mrr']:.3f} |"
        )
    lines.append(
        f"| reference ({reference['label']}) | {reference.get('cases', '–')} | "
        f"{_fmt(reference.get('precision', '–'))} | {_fmt(reference['r_precision'])} | "
        f"{_fmt(reference.get('mrr', '–'))} |"
    )


def _reference_note(report: dict[str, Any]) -> str:
    """Whether the reference rows describe this run's corpus at all."""
    note = f"Reference rows: the Chroma path, {report.get('reference', baseline.SOURCE)}."
    if report["embedder"]["name"] != "production" or report["corpus"]["dimension"] != dimension.FULL:
        note += " This run is not on the production embedder, so they describe another corpus: read them as labels."
    return note


def _scores_row(label: str, s: dict[str, Any], subset: str) -> str:
    recall = s["recall"]
    return (
        f"| {label} | {subset} ({s['queries']}) | {_fmt(recall['10'])} | {_fmt(recall['16'])} | "
        f"{_fmt(recall['60'])} | {_fmt(s['ndcg']['10'])} | {_fmt(s['mrr'])} |"
    )


def render_markdown(report: dict[str, Any]) -> str:
    """The results as the markdown tables the gate report quotes, the Chroma path's numbers beside them."""
    lines: list[str] = []
    env = report.get("environment", {})
    lines.append("## Environment\n")
    lines.append(
        f"Corpus: {report['corpus']['chunks']} chunks ({report['corpus']['allowed_chunks']} after the base filter), "
        f"{report['corpus']['files']} files, {report['corpus']['dimension']}-d vectors from "
        f"`{report['embedder']['model']}` ({report['embedder']['embedded_this_run']} texts embedded this run). "
        f"Qdrant {report['corpus'].get('qdrant_count')} points."
    )
    lines.append(
        f"Machine: {env.get('cpu', '?')}, {env.get('cpus')} CPUs, Python {env.get('python')}; "
        f"Qdrant {env.get('qdrant')} at {env.get('qdrant_url')}. Qdrant index: {report.get('qdrant_index')}.\n"
    )
    lines.append(_reference_note(report) + "\n")
    lexical = report["lexical"]
    lines.append("## G1b lexical: German golden questions (units, base filter)\n")
    lines.append("| channel | recall@5 | recall@10 | recall@16 | nDCG@10 | MRR | no result |")
    lines.append("|---|---|---|---|---|---|---|")
    rows = [
        (name, scores, _fmt(lexical["golden"][name + ":empty"]))
        for name, scores in lexical["golden"].items()
        if not name.endswith(":empty")
    ]
    rows.append(("reference (Postgres `german` FTS)", baseline.LEXICAL_GOLDEN.as_dict(), "–"))
    for name, scores, empty in rows:
        lines.append(
            f"| {name} | {_fmt(scores['recall']['5'])} | {_fmt(scores['recall']['10'])} | "
            f"{_fmt(scores['recall']['16'])} | {_fmt(scores['ndcg']['10'])} | {_fmt(scores['mrr'])} | {empty} |"
        )
    lines.append("\n## G1b lexical: hard cases (chunk oracle), the lexical channel alone\n")
    _hard_tables(lines, lexical["hard"], lexical["relevant_counts"], {"label": "Postgres FTS", **baseline.LEXICAL_HARD})
    if "hybrid_hard" in report:
        lines.append(f"\n## Hard cases through the full retrieval (depth {HYBRID_DEPTH})\n")
        _hard_tables(
            lines,
            {"qdrant": report["hybrid_hard"]},
            lexical["relevant_counts"],
            {"label": "Chroma path", "r_precision": baseline.HYBRID_HARD_R_PRECISION},
        )
    lines.append("\n## Exact mode: Qdrant `find_text` vs a full regex scan vs the phrase index alone\n")
    lines.append("| phrase | full scan | find_text | identical | phrase index | index misses | index extra |")
    lines.append("|---|---|---|---|---|---|---|")
    for row in report["exact"]:
        lines.append(
            f"| `{row['phrase']}` | {row['regex_scan']} | {row['qdrant_find_text']} | "
            f"{'yes' if row['identical'] else 'NO'} | {row['phrase_index']} | {row['phrase_index_misses']} | "
            f"{row['phrase_index_extra']} |"
        )
    hybrid = report["hybrid"]
    lines.append(f"\n## Hybrid: per-collection retrieval at depth {HYBRID_DEPTH} (Punkt golden, units)\n")
    lines.append("| path | set | recall@10 | recall@16 | recall@60 | nDCG@10 | MRR |")
    lines.append("|---|---|---|---|---|---|---|")
    for subset in ("golden_all", "golden_de", "golden_en"):
        label = subset.removeprefix("golden_")
        lines.append(_scores_row("qdrant", hybrid[subset], label))
        lines.append(_scores_row("reference (Chroma)", baseline.HYBRID[subset].as_dict(), label))
    lines.append("\n| path | cohort | recall@16 (files) | recall, whole pool (files) | MRR |")
    lines.append("|---|---|---|---|---|")
    for cohort, s in hybrid["overview"].items():
        lines.append(
            f"| qdrant | {cohort} ({s['queries']}) | {_fmt(s['recall@16'])} | {_fmt(s['recall_pool'])} | "
            f"{_fmt(s['mrr'])} |"
        )
    for cohort, s in baseline.OVERVIEW.items():
        lines.append(
            f"| reference (Chroma) | {cohort} | {_fmt(s['recall@16'])} | {_fmt(s['recall_pool'])} | {_fmt(s['mrr'])} |"
        )
    lines.append("\n## G2 latency: store call per collection, embedding excluded (ms)\n")
    lines.append("| path | n | p50 | p95 | p99 | mean |")
    lines.append("|---|---|---|---|---|---|")
    for name, s in (("qdrant", hybrid["latency_ms"]), ("reference (Chroma + Postgres)", baseline.LATENCY_MS)):
        lines.append(f"| {name} | {s['n']} | {s['p50']} | {s['p95']} | {s['p99']} | {s['mean']} |")
    dim = report.get("dimension")
    if dim:
        lines.append(f"\n## G6 dimension: dense channel, Punkt golden ({dim['dimension']} vs {dim['reduced']})\n")
        lines.append("| variant | recall@1 | recall@3 | recall@5 | recall@10 | recall@16 | nDCG@10 | MRR |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for key, value in dim.items():
            if isinstance(value, dict) and "recall" in value:
                cells = [_fmt(value["recall"][k]) for k in ("1", "3", "5", "10", "16")]
                cells += [_fmt(value["ndcg"]["10"]), _fmt(value["mrr"])]
                lines.append(f"| {key} | " + " | ".join(cells) + " |")
        if "qdrant_index" in dim:
            lines.append(f"\nG6 collection index state: {dim['qdrant_index']}")
    if report.get("variants"):
        lines.append("")
        lines.extend(variants.render(report["variants"]))
    lines.append("\n## Verdicts\n")
    lines.append("| gate | status | detail |")
    lines.append("|---|---|---|")
    for verdict in report["verdicts"]:
        lines.append(f"| {verdict['gate']} | {verdict['status']} | {verdict['detail']} |")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- CLI


def load_inputs(embedder_name: str, cache_dir: Path) -> Inputs:
    from oib_retrieval_eval import overview

    fixtures = corpus.package_root() / "fixtures"
    golden = qrels.load_golden(fixtures / "oib_retrieval_golden.json")
    punkt_index = qrels.load_punkt_index(fixtures / "punkt_index.json")
    excluded = corpus.production_retrieval_settings().exclude_file_names
    inputs = Inputs(
        chunks=indexed_chunks(corpus.build_arm(corpus.ARM_PUNKT)),
        doc_vectors=np.zeros((0, 0), dtype=np.float32),
        judgements=list(qrels.build_judgements(golden, punkt_index)),
        overview=overview.load_golden(overview.default_golden_path()),
        hard_cases=evaluation.load_hard_cases(fixtures / "qdrant_lexical_hard_cases.json"),
        excluded=frozenset(excluded),
    )
    embed_inputs(inputs, Embedder(embedder_name, cache_dir / embedder_name))
    return inputs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--embedder", choices=("production", "hashed"), default="production")
    parser.add_argument("--qdrant-url", default=os.environ.get("AIQ_QDRANT_TEST_URL") or "http://localhost:6333")
    parser.add_argument("--rounds", type=int, default=5, help="timed passes over every question (G2)")
    parser.add_argument("--out", type=Path, default=corpus.package_root() / "results" / "qdrant_parity")
    parser.add_argument("--no-dimension", action="store_true", help="skip G6")
    parser.add_argument(
        "--variants",
        default=None,
        help="also run the ranking sweep: a comma list of variants.catalogue() names, or 'all'",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

    try:
        inputs = load_inputs(args.embedder, corpus.package_root() / ".cache" / "qdrant_parity")
    except corpus.CorpusMissingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if not inputs.chunks:
        print("error: no corpus chunks; put the OIB PDFs in data/oib (see data/oib/README.md)", file=sys.stderr)
        return 1
    report = run(
        inputs,
        qdrant_url=args.qdrant_url,
        rounds=args.rounds,
        with_dimension=not args.no_dimension,
        variant_names=args.variants,
    )
    markdown = render_markdown(report)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (args.out / "report.md").write_text(markdown, encoding="utf-8")
    print(markdown)
    print(f"written: {args.out / 'results.json'}, {args.out / 'report.md'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
