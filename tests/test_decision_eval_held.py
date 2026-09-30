"""The held-evidence eval's scoring and its fixture are under test; the run itself needs a key."""

from __future__ import annotations

import yaml

from scripts.decision_eval_held import FIXTURE
from scripts.decision_eval_held import Scored
from scripts.decision_eval_held import _passages
from scripts.decision_eval_held import summarise


def test_a_false_yes_fails_the_floor_whatever_the_recall():
    scored = [Scored("a", True, 0.95), Scored("b", True, 0.85), Scored("c", False, 0.81)]
    summary = summarise(scored, 0.8)
    assert (summary.recall, summary.false_yes) == (1.0, 1) and not summary.holds
    assert summarise(scored, 0.9).false_yes == 0


def test_an_undecided_row_counts_as_a_no():
    scored = [Scored("a", True, None), Scored("b", True, 0.9), Scored("c", False, None)]
    summary = summarise(scored, 0.8)
    assert (summary.recall, summary.false_yes, summary.undecided) == (0.5, 0, 2) and not summary.holds


def test_the_fixture_is_labelled_both_ways_and_every_row_reads():
    rows = yaml.safe_load(FIXTURE.read_text(encoding="utf-8"))["rows"]
    assert len({row["id"] for row in rows}) == len(rows)
    assert {row["held"] for row in rows} == {True, False}
    assert all(_passages(row["passages"]) and row["message"].strip() for row in rows)
