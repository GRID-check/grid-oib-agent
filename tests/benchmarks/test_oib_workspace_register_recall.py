"""The Büro golden set: loaded and checked, NOT yet scored.

ADR-0054's phase-2 gate is "the right project in the top three register hits on
≥ 90% of the golden set". The twenty questions and their labels exist
(``fixtures/oib_workspace_golden.json``); the instrument does not. The register
is a ``grid_app`` table the BFF owns, and recall over it is Postgres hybrid
search filtered to the caller's readable projects — nothing in
``oib_retrieval_eval`` can run that, because every arm it has reads the OIB
DOCUMENT corpus and none of them has a notion of a project row.

So this file does the half that is real: it holds the fixture to its own shape,
so a malformed or drifting golden set fails here rather than in the run that
first tries to score it — and it SKIPS the scoring with the reason attached,
loudly, instead of computing a number from a channel that is not the one the
product uses. A fabricated 0.9 would close the phase gate on nothing.

The fixture's ``scorer`` block names the two ways to build the missing arm.
When one exists, replace ``test_the_register_recall_gate_has_no_scorer_yet``
with the real measurement and put its baseline in this docstring, the way
``test_oib_overview_recall.py`` carries its cohort table.
"""

import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parents[2] / "frontends" / "benchmarks" / "oib_retrieval" / "fixtures"
GOLDEN_PATH = FIXTURES / "oib_workspace_golden.json"

#: The gate ADR-0054 states, kept here as data so the day a scorer lands the
#: threshold does not have to be rediscovered from the ADR.
TOP_K = 3
THRESHOLD = 0.9


@pytest.fixture(scope="module")
def golden() -> dict:
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def test_the_set_has_twenty_questions_across_the_three_kinds(golden):
    entries = golden["entries"]
    assert len(entries) == 20
    kinds = {kind: [e for e in entries if e["kind"] == kind] for kind in ("A", "B", "C")}
    # A set that lost a whole kind would still average well and would measure
    # nothing: kind A is the precision half (no project may surface), B and C
    # are the recall half.
    assert all(kinds[kind] for kind in kinds), kinds
    assert len(kinds["B"]) + len(kinds["C"]) >= 10, "too few labelled recall questions to quote a 90% gate"


def test_every_question_is_unique_and_non_empty(golden):
    questions = [entry["question"].strip() for entry in golden["entries"]]
    assert all(questions)
    assert len(set(questions)) == len(questions)


def test_every_expected_project_exists_in_the_fixture_office(golden):
    """A label naming a project the register does not hold is unscorable, and
    would read as a recall failure forever."""
    known = {project["id"] for project in golden["register"]}
    for entry in golden["entries"]:
        unknown = [pid for pid in entry["expected_projects"] if pid not in known]
        assert not unknown, f"{entry['id']}: labels name projects the fixture office does not have: {unknown}"


def test_a_baurecht_question_expects_no_project_and_a_project_question_expects_one(golden):
    """The three kinds are the point of the set (spec Outcomes A/B/C), so the
    labels must actually differ by kind — a kind-A entry with a project label is
    a mislabelled entry, not a hard case."""
    for entry in golden["entries"]:
        if entry["kind"] == "A":
            assert entry["expected_projects"] == [], f"{entry['id']}: a pure Baurecht question must surface no project"
        else:
            assert entry["expected_projects"], f"{entry['id']}: a project question needs at least one label"
        if entry["kind"] == "C":
            assert len(entry["expected_projects"]) >= 2, f"{entry['id']}: kind C spans projects by definition"


def test_no_label_set_is_larger_than_the_window_it_is_scored_in(golden):
    """ "Right project in the top three" is unmeasurable for a question whose
    labels cannot all fit in three."""
    for entry in golden["entries"]:
        assert len(entry["expected_projects"]) <= TOP_K, entry["id"]


def test_the_gate_the_fixture_documents_is_the_one_the_adr_states(golden):
    gate = golden["gate"]
    assert gate["threshold"] == THRESHOLD
    assert "top 3" in gate["metric"]


@pytest.mark.skip(
    reason=(
        "No scorer for Projektregister recall yet. The register is a grid_app table read by the BFF "
        "(ADR-0054); oib_retrieval_eval has no arm that ranks project rows, only the OIB document corpus. "
        "See the fixture's `scorer` block for the two ways to build one (an offline recorded-embedding arm, "
        "or a BFF integration test over recallSteckbriefe). Until then the phase-2 gate is UNMEASURED — do "
        "not report a number for it."
    )
)
def test_the_register_recall_gate_has_no_scorer_yet(golden):  # pragma: no cover — skipped by design
    """Placeholder for the phase-2 gate: right project in the top three, ≥ 90%.

    Left in the tree, named for what it measures and skipped with the reason, so
    that "we have a Büro golden set" and "we can score it" cannot be confused by
    anyone reading the suite — including the person who later goes looking for
    where the number comes from.
    """
    raise AssertionError("unreachable: no register scorer exists yet")
