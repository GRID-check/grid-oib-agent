"""Drive the harness and print the report. The only module here that decides what to show.

Run offline, without any API key:

    PYTHONPATH=src:frontends/benchmarks/oib_retrieval/src \\
      ./.venv/bin/python -m oib_retrieval_eval.runner --structure-only
    PYTHONPATH=… ./.venv/bin/python -m oib_retrieval_eval.runner --embedder hashed
    PYTHONPATH=… ./.venv/bin/python -m oib_retrieval_eval.runner --embedder e5

WHAT EACH SECTION IS WORTH
--------------------------
1. **Structural retrievability** — fully real. No model of any kind is involved: it counts
   how many of the Punkt index's leaf Punkte survive each chunking strategy as a citable
   unit. This is the number that decides whether a citation can be precise.
2. **Lexical channel** — fully real for German. It is the shipped analyzer
   (``aiq_agent.common.german_text``) over the real corpus, so its recall is the recall
   that channel has. Its English numbers are real too, and are expected to be zero: that
   channel is monolingual by construction, which its own module docstring states.
3. **Dense channel** — depends on ``--embedder``:
   * ``hashed`` measures WIRING ONLY. It is a deterministic projection with no semantics;
     its numbers prove the pipeline runs and prove nothing about retrieval quality.
   * ``e5`` runs a real multilingual model locally. Its numbers are real measurements of
     THAT model — legitimate for the relative comparisons this harness exists for
     (page-cut vs Punkt-cut, German vs English, dense vs hybrid), because both sides of
     each comparison see the same model. Production embeds with
     ``openai/text-embedding-3-large`` via OpenRouter; nothing here is a claim about its
     absolute recall.
4. **Hybrid** — dense fused with lexical through the production
   ``reciprocal_rank_fusion``, then through the production ``_merge_results`` so the
   diversity cap that actually shapes what the agent sees is in the measured path.

Every dense and hybrid line is printed with its embedder name attached, so no number can
be quoted later without the instrument that produced it.
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass
from pathlib import Path

from oib_retrieval_eval import corpus
from oib_retrieval_eval import lexical
from oib_retrieval_eval import metrics
from oib_retrieval_eval import qrels
from oib_retrieval_eval import structure

#: How deep each channel retrieves before scoring. Well above the largest reported K so
#: that removing production's excluded files afterwards still leaves a full ranking to
#: score — see ``_apply_production_filter``.
RETRIEVE_DEPTH = 120

#: The cutoff the language-parity headline is quoted at, because it is production's top_k
#: (``configs/config_oib_openrouter.yml``); the runner asserts that at start-up.
PARITY_K = 16

CHANNELS = ("lexical", "dense", "hybrid")


def fixtures_dir() -> Path:
    return corpus.package_root() / "fixtures"


@dataclass(frozen=True)
class Scores:
    """One channel's aggregate over one set of questions."""

    label: str
    questions: int
    recall: dict[int, float]
    ndcg: dict[int, float]
    mrr: float
    forbidden: dict[int, float]

    @staticmethod
    def compute(
        label: str,
        rankings: list[list[tuple[str, int]]],
        judgements: list[qrels.Judgements],
        forbidden: qrels.ForbiddenUnits,
    ) -> Scores:
        answerable = [(ranked, judged) for ranked, judged in zip(rankings, judgements, strict=True) if judged.graded]
        recall = {}
        ndcg = {}
        for k in metrics.K_VALUES:
            recall[k] = metrics.mean([metrics.recall_at_k(r, j.relevant, k) for r, j in answerable])
            ndcg[k] = metrics.mean([metrics.ndcg_at_k(r, j.graded, k) for r, j in answerable])
        reciprocal = metrics.mean([metrics.mrr(r, j.relevant) for r, j in answerable])
        forbidden_rates = {
            k: metrics.forbidden_rate(rankings, [forbidden] * len(rankings), k) for k in metrics.K_VALUES
        }
        return Scores(
            label=label,
            questions=len(answerable),
            recall=recall,
            ndcg=ndcg,
            mrr=reciprocal,
            forbidden=forbidden_rates,
        )


def _to_schema_chunks(chunks: list[corpus.Chunk]):
    """Adapt harness chunks to the production ``Chunk`` model so ``_merge_results`` applies.

    The score is a rank-derived stand-in, not a cosine: ``_merge_results`` never ranks on
    it (that is the whole point of the rank fusion inside it) and only ``_apply_diversity_cap``
    consumes the order, so a monotone placeholder changes nothing it does. Setting a real
    cosine here would be worse — it would imply the two channels' scores are comparable,
    which is the exact mistake the production merge exists to avoid.
    """
    from aiq_agent.knowledge.schema import Chunk as SchemaChunk

    return [
        SchemaChunk(
            chunk_id=chunk.chunk_id,
            content=chunk.text,
            score=max(0.0, 1.0 - position / max(len(chunks), 1)),
            file_name=chunk.file_name,
            page_number=chunk.page,
            display_citation=f"{chunk.file_name} p{chunk.page}",
            content_type="text",
            retrieval_rank=position,
            metadata={"collection": "oib_knowledge", **chunk.metadata},
        )
        for position, chunk in enumerate(chunks)
    ]


def _hybrid(
    dense_hits: list[corpus.Chunk],
    lexical_hits: list[corpus.Chunk],
    top_k: int,
    max_per_document: int = 5,
) -> list[tuple[str, int]]:
    """Fuse and merge through the PRODUCTION helpers, then collapse to ranked units.

    ``reciprocal_rank_fusion`` from ``knowledge_layer.llamaindex.hybrid`` with the vector
    channel first (the order ``adapter.py`` uses, so it wins ties), then ``_merge_results``
    from ``knowledge_layer.register`` so the per-document diversity cap that decides what
    the agent actually sees is inside the measured path rather than downstream of it.

    ``top_k`` here is the harness's retrieval depth, not production's 16, and that is safe:
    ``_apply_diversity_cap``'s first pass walks the fused order taking any chunk whose
    document is still under the cap and stops at ``top_k`` SELECTIONS, so the first 16
    entries are identical whether it is called with 16 or with 120. Only the fill pass
    beyond production's cutoff differs, and nothing is reported from there.
    """
    from knowledge_layer.llamaindex.hybrid import reciprocal_rank_fusion
    from knowledge_layer.register import _merge_results

    fused = reciprocal_rank_fusion([dense_hits, lexical_hits], top_n=top_k)
    merged = _merge_results(
        [
            type(
                "_Result",
                (),
                {"success": True, "chunks": _to_schema_chunks(fused), "backend": "oib_retrieval_eval"},
            )()
        ],
        query="",
        top_k=top_k,
        backend_name="oib_retrieval_eval",
        max_per_document=max_per_document,
    )
    units: list[tuple[str, int]] = []
    seen: set[tuple[str, int]] = set()
    for chunk in merged.chunks:
        unit = (chunk.file_name, int(chunk.page_number))
        if unit not in seen:
            seen.add(unit)
            units.append(unit)
    return units


@dataclass(frozen=True)
class ArmRun:
    """Everything one chunking arm produced, both before and after production's filter."""

    arm: str
    chunks: int
    scores: dict[str, dict[str, Scores]]
    rankings: dict[str, list[list[tuple[str, int]]]]
    unfiltered_rankings: dict[str, list[list[tuple[str, int]]]]
    truncated_chunks: int
    truncation_limit: int
    short_rankings: int


def _apply_production_filter(
    ranked: list[tuple[str, int]], excluded: frozenset[str], depth: int
) -> tuple[list[tuple[str, int]], bool]:
    """Drop units from files production's ``exclude_file_names`` removes at query time.

    Production filters INSIDE Chroma, before the top-k is chosen; this filters a deeper
    ranking afterwards. The two are identical as long as at least ``depth`` allowed units
    survive, which is why ``RETRIEVE_DEPTH`` is well above the largest reported K. The
    boolean says whether that condition held for this query, and the runner reports how
    often it did not rather than leaving the approximation unstated.
    """
    kept = [unit for unit in ranked if unit[0] not in excluded]
    return kept, len(kept) < depth


def run_arm(
    arm: str,
    embedder_name: str,
    judgements: list[qrels.Judgements],
    forbidden: qrels.ForbiddenUnits,
    settings: corpus.ProductionRetrievalSettings,
    cache_dir: Path | None = None,
) -> ArmRun:
    """Retrieve every golden question through every channel of one chunking arm.

    The index holds the WHOLE corpus, change logs included, because ingestion does not
    filter — production removes them per query. So each ranking is kept twice: unfiltered
    (which is what the forbidden-hit rate has to be measured on, otherwise it is
    structurally zero and measures nothing) and filtered (which is what the agent sees, so
    it is what recall/nDCG/MRR are reported on).
    """
    from oib_retrieval_eval import dense as dense_module

    chunks = corpus.build_arm(arm, cache_dir=cache_dir)
    lexical_index = lexical.build_index(chunks)
    embedder = dense_module.make_embedder(embedder_name)
    truncated, limit = (
        embedder.truncation([chunk.text for chunk in chunks]) if hasattr(embedder, "truncation") else (0, 0)
    )
    dense_index = dense_module.build_dense_index(embedder, chunks)

    unfiltered: dict[str, list[list[tuple[str, int]]]] = {channel: [] for channel in CHANNELS}
    rankings: dict[str, list[list[tuple[str, int]]]] = {channel: [] for channel in CHANNELS}
    short = 0
    for judged in judgements:
        question = judged.entry.question
        lexical_hits = lexical.search(lexical_index, question, RETRIEVE_DEPTH)
        dense_hits = dense_index.search(embedder, question, RETRIEVE_DEPTH)
        raw = {
            "lexical": corpus.dedupe_to_units(lexical_hits),
            "dense": corpus.dedupe_to_units(dense_hits),
            "hybrid": _hybrid(dense_hits, lexical_hits, RETRIEVE_DEPTH, settings.max_chunks_per_document),
        }
        for channel, ranked in raw.items():
            unfiltered[channel].append(ranked)
            kept, was_short = _apply_production_filter(ranked, settings.exclude_file_names, max(metrics.K_VALUES))
            # The lexical channel legitimately returns fewer than K results (an empty
            # result is its correct answer for an English question), so a short ranking
            # there is not an artefact of the post-filter and must not be counted as one.
            if was_short and len(ranked) >= max(metrics.K_VALUES):
                short += 1
            rankings[channel].append(kept)

    subsets = {
        "all": list(range(len(judgements))),
        "de": [i for i, j in enumerate(judgements) if j.entry.language == "de"],
        "en": [i for i, j in enumerate(judgements) if j.entry.language == "en"],
    }
    scores = {
        channel: {
            subset: Scores.compute(
                f"{arm}/{channel}/{subset}",
                [rankings[channel][i] for i in indices],
                [judgements[i] for i in indices],
                forbidden,
            )
            for subset, indices in subsets.items()
        }
        for channel in CHANNELS
    }
    return ArmRun(
        arm=arm,
        chunks=len(chunks),
        scores=scores,
        rankings=rankings,
        unfiltered_rankings=unfiltered,
        truncated_chunks=truncated,
        truncation_limit=limit,
        short_rankings=short,
    )


def _parity(
    golden: qrels.GoldenSet, judgements: list[qrels.Judgements], rankings: list[list[tuple[str, int]]], k: int
) -> tuple[float, float, float, int]:
    """Recall@k over the sibling pairs only, German and English, and the delta.

    Restricted to primary sibling pairs so the German-only morphology variants cannot
    inflate the German side — a wording effect reported as a language effect would be the
    most misleading number this harness could produce.
    """
    by_id = {judged.entry.id: (judged, ranked) for judged, ranked in zip(judgements, rankings, strict=True)}
    german: list[float] = []
    english: list[float] = []
    pairs = golden.sibling_pairs()
    for de_entry, en_entry in pairs:
        de_judged, de_ranked = by_id[de_entry.id]
        en_judged, en_ranked = by_id[en_entry.id]
        if not de_judged.graded:
            continue
        german.append(metrics.recall_at_k(de_ranked, de_judged.relevant, k))
        english.append(metrics.recall_at_k(en_ranked, en_judged.relevant, k))
    de_mean = metrics.mean(german)
    en_mean = metrics.mean(english)
    return de_mean, en_mean, en_mean - de_mean, len(german)


def _refusal_fill(judgements: list[qrels.Judgements], rankings: list[list[tuple[str, int]]], k: int) -> float:
    """Mean fill rate over the should-refuse questions. 1.0 means the system never abstains."""
    values = [
        metrics.fill_rate(ranked, k)
        for judged, ranked in zip(judgements, rankings, strict=True)
        if judged.entry.should_refuse
    ]
    return metrics.mean(values)


def print_structure(report: structure.StructureReport, stream) -> None:
    print("\n=== 1. STRUCTURAL RETRIEVABILITY (real; no embedder, no key, no model) ===", file=stream)
    print(
        f"Punkt index: {report.indexed_punkte} Punkte, {report.located_punkte} located in the extracted text, "
        f"{report.structural_parents} structural parents excluded "
        f"-> {report.totals[corpus.ARM_PAGE].leaf_punkte} leaf Punkte measured.",
        file=stream,
    )
    if report.unlocated:
        print(f"Unlocated (not scored on either arm): {report.unlocated}", file=stream)
    header = f"{'arm':<8}{'chunks':>8}{'contiguous':>14}{'citable unit':>16}{'leaf Punkte/chunk':>20}"
    print(header, file=stream)
    print("-" * len(header), file=stream)
    for arm in corpus.ARMS:
        row = report.totals[arm]
        print(
            f"{arm:<8}{row.chunks:>8}"
            f"{row.contiguous:>7} ({row.contiguous_pct:5.1f}%)"
            f"{row.isolated:>9} ({row.isolated_pct:5.1f}%)"
            f"{row.punkte_per_chunk:>20.2f}",
            file=stream,
        )
    print(
        "contiguous = the Punkt's full text sits in ONE chunk. citable unit = that chunk holds no other leaf\n"
        "Punkt whole. leaf Punkte/chunk is a LOWER BOUND (a Punkt split across a boundary is not counted).",
        file=stream,
    )


def print_scores(scores: Scores, stream) -> None:
    recall = "  ".join(f"@{k}:{scores.recall[k]:.3f}" for k in metrics.K_VALUES)
    ndcg = "  ".join(f"@{k}:{scores.ndcg[k]:.3f}" for k in metrics.K_VALUES)
    print(f"  {scores.label:<28} n={scores.questions:<3}", file=stream)
    print(f"    recall {recall}", file=stream)
    print(f"    nDCG   {ndcg}", file=stream)
    print(f"    MRR    {scores.mrr:.3f}", file=stream)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--embedder",
        default="hashed",
        choices=("hashed", "e5"),
        help="hashed = deterministic, offline, measures WIRING ONLY. e5 = a real local multilingual model "
        "(downloads once); still not production's embedder.",
    )
    parser.add_argument("--structure-only", action="store_true", help="Skip retrieval; print the chunking A/B only.")
    parser.add_argument(
        "--fail-below",
        type=float,
        default=None,
        metavar="PCT",
        help=(
            "Exit 1 when the Punkt arm's citable-unit share (percent of leaf Punkte whose chunk holds no other "
            "leaf Punkt whole) is below PCT. The regression gate: model-free, key-free, offline."
        ),
    )
    parser.add_argument("--arms", nargs="*", default=list(corpus.ARMS), choices=list(corpus.ARMS))
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING)
    stream = sys.stdout

    index = qrels.load_punkt_index(fixtures_dir() / "punkt_index.json")
    golden = qrels.load_golden(fixtures_dir() / "oib_retrieval_golden.json")
    qrels.assert_siblings_share_qrels(golden, index)
    judgements = list(qrels.build_judgements(golden, index))

    print("OIB RETRIEVAL EVALUATION HARNESS", file=stream)
    print(
        f"{len(golden.entries)} golden entries "
        f"({len(golden.by_language('de'))} de / {len(golden.by_language('en'))} en, "
        f"{len(golden.sibling_pairs())} sibling pairs, "
        f"{sum(1 for e in golden.entries if e.should_refuse)} should-refuse, "
        f"{len(golden.entries) - len(golden.primary())} morphology variants). "
        "All entries are calibration_pending.",
        file=stream,
    )

    report = structure.measure_structure(index)
    print_structure(report, stream)
    if args.fail_below is not None:
        citable_pct = report.totals[corpus.ARM_PUNKT].isolated_pct
        if citable_pct < args.fail_below:
            print(
                f"\nFAIL: the Punkt arm's citable-unit share is {citable_pct:.1f}%, "
                f"below the {args.fail_below:.1f}% gate. A chunker or German-analyzer change made "
                "fewer Punkte survive as a citable unit (rag-system-audit-2026-08 Part IV; ADR-0044 rule 7).",
                file=stream,
            )
            return 1
        print(f"\nGATE: citable-unit share {citable_pct:.1f}% >= {args.fail_below:.1f}%.", file=stream)
    if args.structure_only:
        return 0

    forbidden = qrels.ForbiddenUnits(golden.forbidden_file_prefixes)
    print(f"\n=== 2-4. RETRIEVAL (embedder: {args.embedder}) ===", file=stream)
    if args.embedder == "hashed":
        print(
            "WIRING ONLY. The hashed embedder has no semantics; its dense and hybrid numbers prove the\n"
            "pipeline runs end to end and say NOTHING about retrieval quality. Re-run with --embedder e5\n"
            "for a real relative measurement, and against production's embedder for an absolute one.",
            file=stream,
        )
    else:
        print(
            "The dense arm is intfloat/multilingual-e5-small run locally. This is NOT production's embedder\n"
            "(openai/text-embedding-3-large via OpenRouter). Valid for the RELATIVE comparisons below, because\n"
            "both sides of each see the same model; not a claim about production's absolute recall.",
            file=stream,
        )

    settings = corpus.production_retrieval_settings()
    # The assertion PARITY_K's comment promises, and did not make. Without it a top_k
    # change in configs/config_oib_openrouter.yml leaves the language-parity headline
    # quoted at a depth production no longer uses -- silently, and in the one number the
    # report leads with.
    if settings.top_k != PARITY_K:
        print(
            f"\nWARNING: PARITY_K={PARITY_K} but production top_k={settings.top_k}. "
            f"The language-parity headline is quoted at a depth production does not use. "
            f"Update PARITY_K in {__name__} to match, or state the discrepancy when citing it.",
            file=stream,
        )
    print(
        f"\nProduction settings read from configs/config_oib_openrouter.yml: top_k={settings.top_k}, "
        f"max_chunks_per_document={settings.max_chunks_per_document}, "
        f"{len(settings.exclude_file_names)} excluded file names. "
        f"Retrieval scores are reported AFTER that query-time exclusion; forbidden@{PARITY_K} is reported on "
        "the UNFILTERED ranking, because that is the only place it can be measured — with the filter on it is "
        "structurally zero and tells nobody whether the list is still complete.",
        file=stream,
    )

    for arm in args.arms:
        run = run_arm(arm, args.embedder, judgements, forbidden, settings)
        print(f"\n--- arm: {arm} ({run.chunks} chunks) ---", file=stream)
        if run.truncation_limit:
            print(
                f"    embedder input limit {run.truncation_limit} tokens; "
                f"{run.truncated_chunks} of {run.chunks} chunks "
                f"({100.0 * run.truncated_chunks / run.chunks if run.chunks else 0.0:.1f}%) "
                "are truncated before embedding — a handicap this arm carries under THIS model only.",
                file=stream,
            )
        if run.short_rankings:
            print(
                f"    WARNING: {run.short_rankings} ranking(s) fell below {max(metrics.K_VALUES)} results after the "
                "production filter, so post-filtering was not exactly equivalent to pre-filtering there.",
                file=stream,
            )
        for channel in CHANNELS:
            for subset in ("all", "de", "en"):
                print_scores(run.scores[channel][subset], stream)
            de_mean, en_mean, delta, pairs = _parity(golden, judgements, run.rankings[channel], PARITY_K)
            print(
                f"    language parity recall@{PARITY_K} over {pairs} sibling pairs: "
                f"de {de_mean:.3f} / en {en_mean:.3f} / delta {delta:+.3f}",
                file=stream,
            )
            print(
                f"    should-refuse fill@{PARITY_K}: {_refusal_fill(judgements, run.rankings[channel], PARITY_K):.3f} "
                "(1.000 = top_k always filled, i.e. no abstention path)",
                file=stream,
            )
            unfiltered_forbidden = metrics.forbidden_rate(
                run.unfiltered_rankings[channel],
                [forbidden] * len(judgements),
                PARITY_K,
            )
            print(
                f"    forbidden@{PARITY_K} WITHOUT the production filter: {unfiltered_forbidden:.3f} "
                "(share of questions whose top-16 would cite a change-log page)",
                file=stream,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
