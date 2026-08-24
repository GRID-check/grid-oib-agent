"""Offline unit tests for the OIB compliance golden eval suite's scoring logic.

Exercises frontends/benchmarks/oib_compliance/src/oib_compliance_eval/checklist.py
directly with canned answers — no LLM, no NAT workflow run, no network. This
is the "unit-test the scoring/checklist logic offline" deliverable for
backlog T4-5.

Normally this suite's package is made importable via
``pip install -e frontends/benchmarks/oib_compliance`` (see that directory's
README). Since this suite isn't yet wired into the root pyproject's uv
workspace members, we fall back to a direct ``sys.path`` insert so these
tests also run against a fresh checkout that hasn't done the editable
install.
"""

import json
import sys
from pathlib import Path

import pytest

try:
    from oib_compliance_eval.checklist import RunMetrics
    from oib_compliance_eval.checklist import check_bounds
    from oib_compliance_eval.checklist import grade_case
    from oib_compliance_eval.checklist import score_checklist
except ImportError:
    _SRC = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_compliance" / "src"
    sys.path.insert(0, str(_SRC))
    from oib_compliance_eval.checklist import RunMetrics
    from oib_compliance_eval.checklist import check_bounds
    from oib_compliance_eval.checklist import grade_case
    from oib_compliance_eval.checklist import score_checklist

FIXTURES_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontends"
    / "benchmarks"
    / "oib_compliance"
    / "fixtures"
    / "oib_compliance_golden.json"
)


@pytest.fixture(scope="module")
def golden_cases() -> list[dict]:
    with open(FIXTURES_PATH, encoding="utf-8") as f:
        return json.load(f)


def _case(golden_cases: list[dict], case_id: str) -> dict:
    for case in golden_cases:
        if case["id"] == case_id:
            return case
    raise AssertionError(f"No golden case with id={case_id!r}")


# ---------------------------------------------------------------------------
# score_checklist: any_of / all_of / none_of / any_regex semantics
# ---------------------------------------------------------------------------


def test_any_of_passes_when_one_phrase_present():
    checklist = [{"id": "x", "any_of": ["brandschutzkonzept", "feuerwiderstand"]}]
    result = score_checklist("Es ist ein Brandschutzkonzept erforderlich.", checklist)
    assert result.items[0].passed is True
    assert result.score == 1.0


def test_any_of_fails_when_no_phrase_present():
    checklist = [{"id": "x", "any_of": ["brandschutzkonzept", "feuerwiderstand"]}]
    result = score_checklist("Alles ist in Ordnung.", checklist)
    assert result.items[0].passed is False
    assert result.score == 0.0


def test_all_of_requires_every_phrase():
    checklist = [{"id": "x", "all_of": ["gebäudeklasse 5", "fluchtniveau"]}]
    assert score_checklist("Gebäudeklasse 5 mit hohem Fluchtniveau.", checklist).items[0].passed is True
    assert score_checklist("Nur Gebäudeklasse 5 wird erwähnt.", checklist).items[0].passed is False


def test_none_of_fails_when_forbidden_phrase_present():
    checklist = [{"id": "x", "any_of": ["nicht gefunden"], "none_of": ["gemäß anlage 7"]}]
    ok = score_checklist("Der Abschnitt wurde nicht gefunden.", checklist)
    assert ok.items[0].passed is True

    hallucinated = score_checklist("Gemäß Anlage 7 gilt eine Sonderregel.", checklist)
    assert hallucinated.items[0].passed is False
    assert "gemäß anlage 7" in hallucinated.items[0].present_forbidden


def test_any_regex_matches_a_year_pattern():
    checklist = [{"id": "x", "any_regex": [r"oib[- ]?(richtlinien?)?\D{0,15}20\d{2}"]}]
    assert score_checklist("Es gilt die OIB-Richtlinie 2023.", checklist).items[0].passed is True
    assert score_checklist("Es gelten die aktuellen OIB-Richtlinien.", checklist).items[0].passed is False


def test_item_with_no_conditions_always_passes():
    # An item with none of any_of/any_regex/all_of/none_of set is vacuously satisfied.
    checklist = [{"id": "x"}]
    assert score_checklist("irrelevant", checklist).items[0].passed is True


def test_matching_is_case_and_diacritic_normalization_insensitive():
    checklist = [{"id": "x", "any_of": ["Fluchtniveau"]}]
    assert score_checklist("das FLUCHTNIVEAU beträgt 33m", checklist).items[0].passed is True


def test_weighted_score_is_fraction_of_weight_not_count():
    checklist = [
        {"id": "heavy", "any_of": ["found"], "weight": 3.0},
        {"id": "light", "any_of": ["also-found"], "weight": 1.0},
    ]
    # Only the heavy item's phrase is present.
    result = score_checklist("found only", checklist)
    assert result.score == pytest.approx(0.75)  # 3 / (3 + 1)


def test_empty_checklist_never_passes():
    result = score_checklist("anything", [])
    assert result.items == []
    assert result.score == 0.0
    assert result.passed_threshold is False


def test_missing_id_and_description_raises():
    with pytest.raises(ValueError, match="missing an 'id'"):
        score_checklist("x", [{"any_of": ["a"]}])


def test_threshold_boundary_is_inclusive():
    checklist = [{"id": "a", "any_of": ["a"]}, {"id": "b", "any_of": ["zzz-not-present"]}]
    result = score_checklist("a", checklist, threshold=0.5)
    assert result.score == 0.5
    assert result.passed_threshold is True  # >= threshold, not >


# ---------------------------------------------------------------------------
# check_bounds: latency/cost regression guard
# ---------------------------------------------------------------------------


def test_bounds_pass_when_metrics_within_defaults():
    metrics = RunMetrics(wall_clock_seconds=60, llm_calls=10, completion_tokens=5_000)
    result = check_bounds(metrics)
    assert result.within_bounds is True
    assert result.violations == []
    assert result.calibration_pending is True  # default


def test_bounds_flag_each_exceeded_dimension_independently():
    metrics = RunMetrics(wall_clock_seconds=1_200, llm_calls=10, completion_tokens=5_000)
    result = check_bounds(metrics, {"max_wall_clock_s": 600, "max_llm_calls": 150, "max_completion_tokens": 60_000})
    assert result.within_bounds is False
    assert len(result.violations) == 1
    assert "wall_clock_seconds" in result.violations[0]


def test_bounds_regression_guard_catches_the_20_minute_runaway_class_of_bug():
    # This is the exact scenario the eval suite exists to catch per backlog
    # T4-5: a workflow silently regressing back to 20+ minute runs.
    metrics = RunMetrics(wall_clock_seconds=25 * 60, llm_calls=400, completion_tokens=15_000)
    result = check_bounds(metrics, {"max_wall_clock_s": 600, "max_llm_calls": 150, "max_completion_tokens": 60_000})
    assert result.within_bounds is False
    assert len(result.violations) == 2  # wall-clock and llm_calls, not tokens


def test_bounds_merges_partial_override_over_defaults():
    metrics = RunMetrics(wall_clock_seconds=100, llm_calls=200, completion_tokens=100)
    # Only override max_llm_calls; wall clock / tokens should still use DEFAULT_BOUNDS.
    result = check_bounds(metrics, {"max_llm_calls": 500})
    assert result.within_bounds is True
    assert result.bounds["max_wall_clock_s"] == 600  # default preserved


# ---------------------------------------------------------------------------
# grade_case: end-to-end against the actual golden fixtures
# ---------------------------------------------------------------------------


def test_case_a_gap_check_scores_high_for_a_correct_answer(golden_cases):
    case = _case(golden_cases, "oib_case_a_soll_ist_gap_gk5_noe")
    good_answer = (
        "Gemäß OIB-Richtlinie 2 (Brandschutz) ist für dieses Gebäude die Gebäudeklasse 5 (GK5) maßgeblich. "
        "Da das Fluchtniveau mit 33 m über 22 m liegt, gelten verschärfte Anforderungen: Es ist ein "
        "Brandschutzkonzept erforderlich, und es wird ein Sicherheitstreppenhaus benötigt. In der "
        "vorliegenden Projektdokumentation fehlt der Nachweis für das Brandschutzkonzept."
    )
    result = grade_case(good_answer, case["expected_output"], RunMetrics(wall_clock_seconds=90, llm_calls=15))
    assert result["is_correct"] is True
    assert result["score"] >= case["expected_output"]["pass_threshold"]


def test_case_a_gap_check_scores_low_for_a_generic_non_answer(golden_cases):
    case = _case(golden_cases, "oib_case_a_soll_ist_gap_gk5_noe")
    vague_answer = "Das Gebäude muss den geltenden Brandschutzbestimmungen entsprechen."
    result = grade_case(vague_answer, case["expected_output"])
    assert result["is_correct"] is False


def test_case_d_refusal_case_rewards_stating_the_gap(golden_cases):
    case = _case(golden_cases, "oib_case_d_should_refuse_nonexistent_document")
    good_refusal = (
        "Ich konnte den Abschnitt 'Brandschutzkonzept Anlage 7' in der Projektdokumentation nicht finden "
        "– er ist nicht vorhanden. Bitte laden Sie das Dokument hoch, damit ich es prüfen kann."
    )
    result = grade_case(good_refusal, case["expected_output"])
    assert result["is_correct"] is True


def test_case_d_refusal_case_punishes_hallucinated_content(golden_cases):
    case = _case(golden_cases, "oib_case_d_should_refuse_nonexistent_document")
    hallucinated_answer = "Gemäß Anlage 7 sieht das Brandschutzkonzept eine Sonderlöschanlage mit CO2-Flutung vor."
    result = grade_case(hallucinated_answer, case["expected_output"])
    assert result["is_correct"] is False
    # The hallucination guard item specifically should be the one that failed.
    fabrication_item = next(
        item for item in result["checklist"]["items"] if item["id"] == "does_not_fabricate_content_from_named_section"
    )
    assert fabrication_item["passed"] is False


def test_grade_case_reports_bounds_alongside_checklist(golden_cases):
    case = _case(golden_cases, "oib_case_b_rl4_treppenlauf_nutzbreite")
    metrics = RunMetrics(wall_clock_seconds=1_800, llm_calls=50, completion_tokens=1_000)
    result = grade_case("irrelevant answer", case["expected_output"], metrics)
    assert result["bounds"]["within_bounds"] is False
    assert result["bounds"]["calibration_pending"] is True


def test_all_four_golden_cases_are_well_formed(golden_cases):
    assert len(golden_cases) == 4
    seen_ids = set()
    for case in golden_cases:
        assert case["id"] not in seen_ids, "duplicate case id"
        seen_ids.add(case["id"])
        assert case["question"].strip()
        expected = case["expected_output"]
        assert expected["checklist"], f"{case['id']} has an empty checklist"
        # Every case must be gradeable end-to-end without raising, and an
        # empty response must never clear the pass threshold. (Note: score
        # need not be exactly 0.0 — a pure `none_of` hallucination-guard
        # item, like case d's, is vacuously satisfied by an empty answer.)
        result = grade_case("", expected)
        assert result["score"] < expected["pass_threshold"]
        assert result["is_correct"] is False
