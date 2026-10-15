"""The Qdrant parity harness's own instrument, offline (``task be:eval:qdrant-parity``).

What can rot without a server is pinned here: the hard-case fixture and its
oracles, the scores, the gate thresholds and their boundaries, the reference
numbers of the Chroma path (``baseline.py``), the regex scan exact mode is held
to, the dimension truncation and the report renderer. The store half runs
against a real Qdrant in
``sources/knowledge_layer/tests/test_qdrant_parity_harness.py``, where CI starts
one.

Import fallback as in the sibling benchmark tests.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

try:
    from oib_retrieval_eval.qdrant_parity import evaluation
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "src"))
    from oib_retrieval_eval.qdrant_parity import evaluation

from oib_retrieval_eval.qdrant_parity import baseline
from oib_retrieval_eval.qdrant_parity import channels
from oib_retrieval_eval.qdrant_parity import runner
from oib_retrieval_eval.qdrant_parity import sample
from oib_retrieval_eval.qdrant_parity.vectors import truncate_renormalise

FIXTURES = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "fixtures"
HARD_CASES = FIXTURES / "qdrant_lexical_hard_cases.json"


# ---------------------------------------------------------------- the fixture


def test_the_hard_case_fixture_loads_and_covers_every_kind_the_gate_names():
    cases = evaluation.load_hard_cases(HARD_CASES)
    assert {case.kind for case in cases} == set(evaluation.HARD_CASE_KINDS)
    queries = {case.query for case in cases}
    for named in ("§ 8", "5.1.1", "REI 90", "Verfahren", "Geschoss", "Gebaeudeklasse"):
        assert named in queries, f"the design's hard case {named!r} left the fixture"


def test_every_oracle_matches_its_own_sample_spelling_and_not_a_neighbour():
    by_id = {case.id: case for case in evaluation.load_hard_cases(HARD_CASES)}
    assert by_id["para-8"].relevant("gemäß § 8 der Statuten")
    assert not by_id["para-8"].relevant("gemäß § 80 der Statuten")
    assert by_id["punkt-5-1-1"].relevant("Punkt 5.1.1 regelt")
    assert not by_id["punkt-5-1-1"].relevant("Punkt 15.1.1 regelt")
    assert by_id["sz-geschoss"].relevant("Obergeschoß") and by_id["sz-geschoss"].relevant("Geschoss")
    assert by_id["uml-gebaeudeklasse-digraph"].relevant("Gebäudeklasse 5")


def test_a_compound_only_case_admits_the_compound_and_not_the_free_word():
    case = next(c for c in evaluation.load_hard_cases(HARD_CASES) if c.id == "comp-only-verfahren")
    assert case.relevant("Das Nachweisverfahren ist anzuwenden.")
    assert not case.relevant("Das Verfahren und das Nachweisverfahren.")


@pytest.mark.parametrize(
    "mutation, message",
    [
        (lambda cases: cases.append(dict(cases[0])), "duplicate"),
        (lambda cases: cases[0].update(kind="nonsense"), "unknown kind"),
        (lambda cases: cases[0].update(query="  "), "empty query"),
    ],
)
def test_the_loader_refuses_a_malformed_fixture(tmp_path, mutation, message):
    payload = json.loads(HARD_CASES.read_text(encoding="utf-8"))
    mutation(payload["cases"])
    path = tmp_path / "cases.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        evaluation.load_hard_cases(path)


# ---------------------------------------------------------------- scores


def test_hard_case_scores_count_precision_r_precision_and_first_hit():
    case = evaluation.HardCase("x", "allcaps_code", "REI 90", r"\bREI\s*90\b")
    ranked = ["nothing", "REI 90 here", "REI 60", "REI 90 again"]
    score = evaluation.score_hard_case(case, ranked, relevant_total=2)
    assert score.precision == pytest.approx(2 / 10)
    assert score.r_precision == pytest.approx(1 / 2)
    assert score.mrr == pytest.approx(1 / 2)


def test_mean_hard_leaves_out_unanswerable_and_non_gating_cases():
    scores = [
        evaluation.HardCaseScore("a", "allcaps_code", 3, 1.0, 1.0, 1.0, 10),
        evaluation.HardCaseScore("b", "compound_only", 3, 0.0, 0.0, 0.0, 10),
        evaluation.HardCaseScore("c", "allcaps_code", 0, 0.0, 0.0, 0.0, 10),
    ]
    assert evaluation.mean_hard(scores, gating_only=True)["r_precision"] == 1.0
    assert evaluation.mean_hard(scores)["r_precision"] == 0.5


def test_graded_scores_skip_queries_without_labels():
    scores = evaluation.score_graded([["a", "b"], ["c"]], [{"b": 3}, {}], ks=(1, 2))
    assert scores.queries == 1
    assert scores.recall == {1: 0.0, 2: 1.0}
    assert scores.mrr == 0.5


def test_percentiles_interpolate_and_an_empty_sample_is_nan():
    assert evaluation.percentile([1, 2, 3, 4], 50) == 2.5
    assert evaluation.percentile([10], 95) == 10
    assert math.isnan(evaluation.percentile([], 95))
    assert evaluation.latency_summary([1.0, 3.0])["p50"] == 2.0


# ---------------------------------------------------------------- gates


def _scores(recall16: float) -> evaluation.RankScores:
    return evaluation.RankScores(queries=1, recall={16: recall16}, ndcg={}, mrr=0.0)


def test_g1b_fails_on_any_exact_mode_difference_even_with_better_recall():
    hard = {"r_precision": 0.5}
    verdict = evaluation.g1b_lexical_verdict(_scores(0.9), _scores(0.5), hard, hard, exact_mismatches=1)
    assert verdict.status == "fail" and "exact mode" in verdict.detail


def test_g1b_fails_when_qdrant_recall_is_below_the_reference():
    hard = {"r_precision": 0.5}
    verdict = evaluation.g1b_lexical_verdict(_scores(0.4), _scores(0.5), hard, hard, exact_mismatches=0)
    assert verdict.status == "fail"
    assert evaluation.g1b_lexical_verdict(_scores(0.5), _scores(0.5), hard, hard, 0).status == "pass"


def test_g2_and_g6_bounds_are_the_design_docs_and_inclusive():
    assert evaluation.g2_latency_verdict({"p95": 230.0}).status == "pass"
    assert evaluation.g2_latency_verdict({"p95": 230.1}).status == "fail"

    def recall(value_at_1: float) -> evaluation.RankScores:
        return evaluation.RankScores(queries=46, recall={1: value_at_1, 5: 1.0, 16: 1.0}, ndcg={}, mrr=0.0)

    assert evaluation.g6_dimension_verdict(recall(0.90), recall(0.89), label="x").status == "pass"
    failed = evaluation.g6_dimension_verdict(recall(0.90), recall(0.888), label="x")
    assert failed.status == "fail", "a drop at the top must fail even when recall@16 is saturated"


# ---------------------------------------------------------------- dimension


def test_truncation_renormalises_and_keeps_the_prefix_direction():
    rng = np.random.default_rng(0)
    matrix = rng.normal(size=(5, 12)).astype(np.float32)
    cut = truncate_renormalise(matrix, 4)
    assert cut.shape == (5, 4)
    assert np.allclose(np.linalg.norm(cut, axis=1), 1.0)
    assert np.allclose(cut[0] * np.linalg.norm(matrix[0, :4]), matrix[0, :4], atol=1e-5)
    with pytest.raises(ValueError):
        truncate_renormalise(matrix, 13)


def test_the_base_filter_is_the_one_register_builds():
    from knowledge_layer.register import KnowledgeRetrievalConfig
    from knowledge_layer.register import _base_collection_filters

    excluded = ["b.pdf", "a.pdf"]
    config = KnowledgeRetrievalConfig.model_construct(exclude_file_names=excluded)
    assert channels.base_filters(excluded) == _base_collection_filters(config, None)


# ---------------------------------------------------------------- the reference and the exact-mode oracle


def test_the_reference_is_the_gate_reports_chroma_path_and_names_its_source():
    """The numbers G1b and the report compare against, as ``qdrant-gates-2026-10.md`` records them."""
    report = (Path(__file__).resolve().parents[2] / "docs" / "architecture" / "qdrant-gates-2026-10.md").read_text()
    assert "qdrant-gates-2026-10.md" in baseline.SOURCE
    lexical = baseline.LEXICAL_GOLDEN
    assert f"| {lexical.recall[5]:.3f} | {lexical.recall[10]:.3f} | {lexical.recall[16]:.3f} |" in report
    assert f"| {baseline.LEXICAL_HARD['precision']:.3f} | {baseline.LEXICAL_HARD['r_precision']:.3f} |" in report
    assert f"{baseline.HYBRID['golden_all'].ndcg[10]:.3f} | {baseline.HYBRID['golden_all'].mrr:.3f} |" in report
    assert f"| {baseline.LATENCY_MS['p50']} ms | {baseline.LATENCY_MS['p95']} ms |" in report
    assert f"Chroma {baseline.HYBRID_HARD_R_PRECISION:.3f}" in report


def test_the_regex_scan_finds_the_phrase_with_either_spelling_and_honours_the_base_filter():
    """What Chroma's ``$regex`` returned, and what ``find_text`` is now held to."""
    inputs = sample.inputs(HARD_CASES)
    view = runner.Corpus(inputs.chunks, inputs.excluded)
    allowed = [chunk for chunk in inputs.chunks if view.allowed(chunk)]
    by_text = {chunk.chunk_id: chunk.text for chunk in allowed}

    geschoss = channels.regex_oracle(allowed, "Geschoss")
    section = channels.regex_oracle(allowed, "§ 8")

    assert geschoss and {by_text[i] for i in geschoss} == {t for t in by_text.values() if "Geschoß" in t}
    assert len(section) == 1
    assert all(chunk.file_name != sample.CHANGES for chunk in allowed), "the base filter must drop excluded files"


def test_the_markdown_report_renders_every_section_from_plain_results():
    hard_row = {"case_id": "x", "kind": "allcaps_code", "relevant": 1, "precision": 1.0}
    hard_row |= {"r_precision": 1.0, "mrr": 1.0, "returned": 1}
    ranks = evaluation.RankScores(1, {k: 1.0 for k in (5, 10, 16, 60)}, {10: 1.0}, 1.0)
    lat = evaluation.latency_summary([1.0, 2.0])
    report = runner._plain(
        {
            "corpus": {"chunks": 1, "allowed_chunks": 1, "files": 1, "dimension": 64},
            "embedder": {"name": "hashed", "model": "hashed-64", "embedded_this_run": 0},
            "lexical": {
                "golden": {"qdrant_bm25": ranks, "qdrant_bm25:empty": 0.0},
                "hard": {"qdrant_bm25": [hard_row]},
                "relevant_counts": {"x": 1},
            },
            "hybrid_hard": [hard_row],
            "exact": [
                {
                    "phrase": "REI 90",
                    "regex_scan": 1,
                    "qdrant_find_text": 1,
                    "identical": True,
                    "phrase_index": 1,
                    "phrase_index_misses": 0,
                    "phrase_index_extra": 0,
                }
            ],
            "hybrid": {
                "golden_all": ranks,
                "golden_de": ranks,
                "golden_en": ranks,
                "overview": {},
                "latency_ms": lat,
            },
            "verdicts": [{"gate": "G2 latency", "status": "pass", "detail": "ok"}],
        }
    )
    markdown = runner.render_markdown(report)
    for heading in ("G1b lexical", "Exact mode", "Hybrid", "G2 latency", "Verdicts", "full retrieval"):
        assert heading in markdown
    assert "reference (Postgres `german` FTS)" in markdown and "reference (Chroma)" in markdown
    assert "describe another corpus" in markdown, "a hashed run must not read as comparable to the reference"


# ---------------------------------------------------------------- the ranking sweep


def test_the_sweep_diff_names_the_questions_that_moved():
    from oib_retrieval_eval.qdrant_parity import variants

    def result(first: dict, recall: dict, hard: dict) -> dict:
        return {
            "per_golden": {q: {"first": rank, "ndcg10": 1.0 / (rank or 100)} for q, rank in first.items()},
            "per_overview": {q: {"cohort": "overview", "recall16": r} for q, r in recall.items()},
            "per_hard": hard,
        }

    base = result({"a": 1, "b": 3, "c": None}, {"o1": 1.0, "o2": 0.5}, {"h1": 0.5, "h2": 0.2})
    other = result({"a": 2, "b": 1, "c": 4}, {"o1": 0.5, "o2": 0.5}, {"h1": 0.5, "h2": 0.4})

    moves = variants.diff(base, other)

    assert moves["golden_first_rank"] == {"worse": ["a"], "better": ["b", "c"]}
    assert moves["overview_recall16"] == {"worse": ["o1"], "better": []}
    assert moves["hard_r_precision"] == {"worse": [], "better": ["h2"]}


def test_a_sweep_selection_always_starts_from_the_baseline_and_refuses_unknown_names():
    from oib_retrieval_eval.qdrant_parity import variants

    assert list(variants.select("rrf_k100")) == [variants.BASELINE, "rrf_k100"]
    with pytest.raises(ValueError, match="unknown variants"):
        variants.select("rrf_k7")
