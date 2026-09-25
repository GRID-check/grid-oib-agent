"""The decision eval's scoring is under test; the run itself needs a key."""

from __future__ import annotations

from scripts.decision_eval import Row
from scripts.decision_eval import expected_family
from scripts.decision_eval import summarise
from scripts.decision_eval import threshold_sweep


def test_expected_family_reads_the_loop_eval_vocabulary():
    assert expected_family("OIB-RL 2") == "2"
    assert expected_family("OIB-RL 2.2") == "2"
    assert expected_family("Bauordnung") is None
    assert expected_family(None) is None


def _row(id, expected, top, p, corpus="baurecht", evidence=0.9, kind="ruling", expected_p=None, landesrecht=None):
    return Row(
        id=id,
        kind=kind,
        expected_family=expected,
        expected_corpus="baurecht" if expected or id.startswith("bo") else None,
        needs_evidence=evidence,
        corpus=corpus,
        corpus_p=0.8,
        top_family=top,
        top_family_p=p,
        expected_family_p=expected_p if expected_p is not None else (p if top == expected else 0.1),
        decided=True,
        latency_ms=200,
        landesrecht=landesrecht if landesrecht is not None else (0.9 if id.startswith("bo") else 0.2),
    )


def test_the_adoption_rule_is_the_three_floors():
    good = [_row("a", "2", "2", 0.9), _row("b", "4", "4", 0.8), _row("bo-1", None, "2", 0.3)]
    summary = summarise(good)
    assert summary["family_top1"] == 1.0 and summary["corpus_baurecht_rate"] == 1.0 and summary["adopt"]

    missed = [*good, _row("c", "6", "2", 0.7), _row("d", "3", "2", 0.7), _row("e", "5", "2", 0.7)]
    assert not summarise(missed)["adopt"]

    unsure = [*good, _row("f", "2", "2", 0.9, evidence=0.2)]
    assert not summarise(unsure)["ruling_evidence_floor_held"] and not summarise(unsure)["adopt"]


def test_the_ris_prefetch_floor_is_every_bauordnung_row_and_no_oib_row():
    good = [_row("a", "2", "2", 0.9), _row("bo-1", None, "2", 0.3)]
    assert summarise(good)["adopt"]
    assert not summarise([*good, _row("bo-2", None, "2", 0.3, landesrecht=0.5)])["adopt"]
    assert not summarise([*good, _row("b", "4", "4", 0.8, landesrecht=0.7)])["adopt"]


def test_the_sweep_reports_recall_and_precision_per_threshold():
    rows = [_row("a", "2", "2", 0.9), _row("b", "4", "3", 0.7, expected_p=0.5)]
    sweep = dict((t, (r, p)) for t, r, p in threshold_sweep(rows))
    assert sweep[0.4] == (1.0, 0.5)
    assert sweep[0.6] == (0.5, 0.5)
    assert sweep[0.8] == (0.5, 1.0)
