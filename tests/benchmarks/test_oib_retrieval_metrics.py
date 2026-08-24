"""Offline unit tests for the OIB retrieval harness's pure scoring modules.

Exercises frontends/benchmarks/oib_retrieval/src/oib_retrieval_eval/{metrics,qrels,citations}.py
directly with hand-built rankings and the committed fixtures — no embedder, no model
download, no PDF, no network, no key. Everything here runs in CI.

Normally this suite's package is made importable via
``pip install -e frontends/benchmarks/oib_retrieval`` (see that directory's README). Since
it is not yet wired into the root pyproject's uv workspace members, we fall back to a
direct ``sys.path`` insert, the same way ``test_oib_compliance_checklist.py`` does, so
these tests also run against a fresh checkout that has not done the editable install.
"""

import math
import sys
from pathlib import Path

import pytest

try:
    from oib_retrieval_eval import metrics
    from oib_retrieval_eval import qrels
    from oib_retrieval_eval.citations import extract_units
except ImportError:
    _SRC = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "src"
    sys.path.insert(0, str(_SRC))
    from oib_retrieval_eval import metrics
    from oib_retrieval_eval import qrels
    from oib_retrieval_eval.citations import extract_units

FIXTURES = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "fixtures"


@pytest.fixture(scope="module")
def punkt_index() -> qrels.PunktIndex:
    return qrels.load_punkt_index(FIXTURES / "punkt_index.json")


@pytest.fixture(scope="module")
def golden() -> qrels.GoldenSet:
    return qrels.load_golden(FIXTURES / "oib_retrieval_golden.json")


# ---------------------------------------------------------------------------
# metrics: recall / precision
# ---------------------------------------------------------------------------


def test_recall_at_k_divides_by_the_full_judged_set_not_by_k():
    ranked = ["a", "x", "y"]
    relevant = {"a", "b", "c"}
    assert metrics.recall_at_k(ranked, relevant, 1) == pytest.approx(1 / 3)
    assert metrics.recall_at_k(ranked, relevant, 3) == pytest.approx(1 / 3)


def test_recall_at_k_is_one_only_when_every_judged_unit_is_inside_the_cutoff():
    ranked = ["a", "b", "c"]
    relevant = {"a", "b", "c"}
    assert metrics.recall_at_k(ranked, relevant, 2) == pytest.approx(2 / 3)
    assert metrics.recall_at_k(ranked, relevant, 3) == pytest.approx(1.0)


def test_recall_at_k_returns_zero_for_a_should_refuse_question_rather_than_raising():
    assert metrics.recall_at_k(["a"], set(), 5) == 0.0


def test_precision_at_k_charges_the_retriever_for_unfilled_slots():
    # Two results, both relevant, but k is ten: precision is 0.2, not 1.0.
    assert metrics.precision_at_k(["a", "b"], {"a", "b"}, 10) == pytest.approx(0.2)


def test_a_cutoff_of_zero_or_less_is_a_programming_error_not_an_empty_result():
    with pytest.raises(ValueError):
        metrics.recall_at_k(["a"], {"a"}, 0)
    with pytest.raises(ValueError):
        metrics.fill_rate(["a"], -1)


# ---------------------------------------------------------------------------
# metrics: nDCG, verified by hand
# ---------------------------------------------------------------------------


def test_ndcg_at_k_matches_a_gain_and_discount_computed_by_hand():
    # Ranking:  [b, x, a]   grades: a=3 (gain 7), b=1 (gain 1), x is unjudged (gain 0).
    # DCG  = 1/log2(2) + 0/log2(3) + 7/log2(4) = 1.0 + 0 + 3.5            = 4.5
    # IDCG = 7/log2(2) + 1/log2(3)             = 7.0 + 0.6309297535714575 = 7.630929753571457
    # nDCG = 4.5 / 7.630929753571457           = 0.5897053367440438
    grades = {"a": 3, "b": 1}
    dcg = 1.0 / math.log2(2) + 7.0 / math.log2(4)
    idcg = 7.0 / math.log2(2) + 1.0 / math.log2(3)
    assert dcg == pytest.approx(4.5)
    assert idcg == pytest.approx(7.6309297535714575)
    assert dcg / idcg == pytest.approx(0.5897053367440438)
    assert metrics.ndcg_at_k(["b", "x", "a"], grades, 3) == pytest.approx(0.5897053367440438)


def test_ndcg_at_k_is_one_for_the_ideal_ranking():
    grades = {"a": 3, "b": 2, "c": 1}
    assert metrics.ndcg_at_k(["a", "b", "c"], grades, 3) == pytest.approx(1.0)


def test_ndcg_at_k_uses_exponential_gain_so_one_grade_three_outranks_three_grade_ones():
    # Gains are 2**grade - 1, so the single grade-3 unit is worth 7 and each grade-1 unit
    # is worth 1: finding the answering Punkt alone must beat finding three context Punkte.
    grades = {"a": 3, "p": 1, "q": 1, "r": 1}
    answer_first = metrics.ndcg_at_k(["a", "z", "z2"], grades, 3)
    context_first = metrics.ndcg_at_k(["p", "q", "r"], grades, 3)
    assert answer_first == pytest.approx(7.0 / (7.0 + 1 / math.log2(3) + 1 / math.log2(4)))
    assert context_first == pytest.approx(
        (1.0 + 1 / math.log2(3) + 1 / math.log2(4)) / (7.0 + 1 / math.log2(3) + 1 / math.log2(4))
    )
    assert answer_first > context_first


def test_ndcg_at_k_caps_the_ideal_at_the_cutoff_so_a_two_page_punkt_can_score_one_at_k_one():
    grades = {"a": 3, "b": 3}
    assert metrics.ndcg_at_k(["a"], grades, 1) == pytest.approx(1.0)
    assert metrics.ndcg_at_k(["a"], grades, 2) == pytest.approx(7.0 / (7.0 + 7.0 / math.log2(3)))


def test_ndcg_at_k_is_zero_when_nothing_is_judged_relevant():
    assert metrics.ndcg_at_k(["a", "b"], {}, 5) == 0.0


# ---------------------------------------------------------------------------
# metrics: MRR, forbidden rate, fill rate
# ---------------------------------------------------------------------------


def test_mrr_is_the_reciprocal_of_the_first_relevant_rank():
    assert metrics.mrr(["x", "y", "a"], {"a"}) == pytest.approx(1 / 3)
    assert metrics.mrr(["a", "y"], {"a"}) == pytest.approx(1.0)


def test_mrr_is_zero_when_no_relevant_unit_appears_within_the_cutoff():
    assert metrics.mrr(["x", "y", "a"], {"a"}, k=2) == 0.0


def test_forbidden_rate_counts_queries_not_hits_so_three_bad_pages_are_one_failure():
    forbidden = qrels.ForbiddenUnits(("aenderungen_",))
    bad = [("aenderungen_a.pdf", 1), ("aenderungen_a.pdf", 2), ("aenderungen_b.pdf", 3)]
    good = [("oib-rl_2.pdf", 5)]
    rate = metrics.forbidden_rate([bad, good], [forbidden, forbidden], 3)
    assert rate == pytest.approx(0.5)


def test_forbidden_rate_requires_parallel_inputs():
    with pytest.raises(ValueError):
        metrics.forbidden_rate([[("a.pdf", 1)]], [], 3)


def test_fill_rate_is_one_when_the_retriever_fills_every_slot_of_an_unanswerable_question():
    assert metrics.fill_rate(list(range(16)), 16) == pytest.approx(1.0)
    assert metrics.fill_rate([], 16) == 0.0
    assert metrics.fill_rate(list(range(4)), 16) == pytest.approx(0.25)


# ---------------------------------------------------------------------------
# qrels: the Punkt index and the expansion
# ---------------------------------------------------------------------------


def test_the_committed_punkt_index_holds_946_punkte_across_12_richtlinien(punkt_index):
    assert len(punkt_index.richtlinien) == 12
    assert punkt_index.total_punkte() == 946


def test_expanding_a_punkt_yields_one_unit_per_page_it_occupies(punkt_index):
    units = punkt_index.units("2", "12")
    assert units[0] == qrels.Unit("oib-rl_2_ausgabe_mai_2023.pdf", 23)
    assert len(units) == 10
    assert all(unit.file_name == "oib-rl_2_ausgabe_mai_2023.pdf" for unit in units)


def test_an_unknown_richtlinie_or_punkt_raises_rather_than_being_silently_dropped(punkt_index):
    with pytest.raises(KeyError):
        punkt_index.units("99", "1")
    with pytest.raises(KeyError):
        punkt_index.units("2", "99.99.99")


def test_a_punkt_with_numbered_children_is_a_structural_parent(punkt_index):
    assert punkt_index.has_children("2", "3.1") is True
    assert punkt_index.has_children("2", "3.1.1") is False


def test_expansion_keeps_the_higher_grade_when_two_labels_share_a_page(punkt_index):
    entry = qrels.GoldenEntry(
        id="t",
        need_id="t",
        language="de",
        question="q",
        question_class="c",
        relevant=(qrels.PunktLabel("2", "5.1.1", 3), qrels.PunktLabel("2", "5.1.4", 1)),
        provenance="test",
        label_method="test",
        notes="both Punkte are on page 13",
        calibration_pending=True,
    )
    graded = qrels.expand(entry, punkt_index)
    assert graded == {qrels.Unit("oib-rl_2_ausgabe_mai_2023.pdf", 13): 3}


def test_a_grade_outside_one_to_three_is_rejected_at_construction():
    with pytest.raises(ValueError):
        qrels.PunktLabel("2", "5.1.1", 0)


def test_the_forbidden_container_matches_by_file_name_prefix_only():
    forbidden = qrels.ForbiddenUnits(("aenderungen_",))
    assert qrels.Unit("aenderungen_oib-rl_2_ausgabe_mai_2023.pdf", 7) in forbidden
    assert qrels.Unit("oib-rl_2_ausgabe_mai_2023.pdf", 7) not in forbidden
    assert ("aenderungen_x.pdf", 1) in forbidden


# ---------------------------------------------------------------------------
# qrels: the golden set's own invariants
# ---------------------------------------------------------------------------


def test_the_golden_set_has_between_40_and_60_entries_all_calibration_pending(golden):
    assert 40 <= len(golden.entries) <= 60
    assert all(entry.calibration_pending for entry in golden.entries)


def test_every_golden_entry_carries_provenance_a_label_method_and_notes(golden):
    for entry in golden.entries:
        assert entry.provenance.strip(), entry.id
        assert entry.label_method.strip(), entry.id
        assert entry.notes.strip(), entry.id
        assert entry.language in ("de", "en"), entry.id


def test_every_german_question_has_an_english_sibling_with_identical_qrels(golden, punkt_index):
    # The load-bearing invariant of the language-parity number: if the two sides' expected
    # output differed at all, a measured gap could be blamed on the labels instead of on
    # retrieval. This raises rather than asserts, so the failure names the offending need.
    qrels.assert_siblings_share_qrels(golden, punkt_index)
    assert len(golden.sibling_pairs()) == len({entry.need_id for entry in golden.entries})


def test_the_golden_set_contains_should_refuse_cases_with_empty_qrels(golden):
    refusals = [entry for entry in golden.entries if entry.should_refuse]
    assert len(refusals) >= 4
    assert {entry.language for entry in refusals} == {"de", "en"}
    assert all(not entry.relevant for entry in refusals)


def test_the_golden_set_contains_german_morphology_variants_sharing_one_needs_qrels(golden, punkt_index):
    variants = [entry for entry in golden.entries if entry.variant_of is not None]
    assert len(variants) >= 2
    by_id = {entry.id: entry for entry in golden.entries}
    for variant in variants:
        parent = by_id[variant.variant_of]
        assert variant.language == parent.language == "de"
        assert variant.question != parent.question
        assert qrels.expand(variant, punkt_index) == qrels.expand(parent, punkt_index)


def test_the_forbidden_rule_names_the_aenderungen_change_logs(golden):
    assert "aenderungen_" in golden.forbidden_file_prefixes


def test_every_golden_label_resolves_against_the_committed_punkt_index(golden, punkt_index):
    for judged in qrels.build_judgements(golden, punkt_index):
        if judged.entry.should_refuse:
            assert judged.graded == {}
        else:
            assert judged.graded, judged.entry.id
            assert all(unit.page > 0 for unit in judged.graded), judged.entry.id


def test_a_duplicate_entry_id_is_rejected_by_the_loader(tmp_path):
    import json

    payload = json.loads((FIXTURES / "oib_retrieval_golden.json").read_text(encoding="utf-8"))
    payload["entries"].append(dict(payload["entries"][0]))
    path = tmp_path / "dupe.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate"):
        qrels.load_golden(path)


# ---------------------------------------------------------------------------
# citations
# ---------------------------------------------------------------------------


def test_citation_parsing_reads_the_units_the_knowledge_tool_formats():
    answer = "Der Fluchtweg darf 40 m nicht überschreiten (oib-rl_2_ausgabe_mai_2023.pdf, p.13)."
    assert extract_units(answer) == [("oib-rl_2_ausgabe_mai_2023.pdf", 13)]


def test_citation_parsing_ignores_the_collection_qualifier_and_deduplicates_in_order():
    answer = "A.pdf (Projektwissen), p.3 then B.pdf, p.9 then A.pdf, p.3 again"
    assert extract_units(answer) == [("A.pdf", 3), ("B.pdf", 9)]


def test_citation_parsing_returns_nothing_for_an_answer_that_cited_nothing():
    assert extract_units("Dazu enthält der Korpus keine Bestimmung.") == []
    assert extract_units(None) == []
