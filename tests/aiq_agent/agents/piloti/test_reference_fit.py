"""ADR-0064 use 10: rank by fingerprint, verify against the question; reorder, never drop."""

from __future__ import annotations

import pytest

import aiq_agent.agents.piloti.register as register_module
from aiq_agent.agents.piloti.reference_fit import FIT_THRESHOLD
from aiq_agent.agents.piloti.reference_fit import ReferenceFit
from aiq_agent.agents.piloti.reference_fit import fit_references
from aiq_agent.agents.piloti.reference_fit import line_state
from aiq_agent.agents.piloti.reference_fit import parse_catalog
from aiq_agent.agents.piloti.reference_fit import reorder
from aiq_agent.common.decisions import Decision
from aiq_agent.knowledge.restricted_use import CrossProjectTurn
from aiq_agent.knowledge.restricted_use import bind_cross_project_turn
from aiq_agent.knowledge.restricted_use import reset_cross_project_turn

BADEN = "b0000000-0000-4000-8000-000000000002"
MOEDLING = "c0000000-0000-4000-8000-000000000003"
WIEN22 = "d0000000-0000-4000-8000-000000000004"

CATALOG = "\n".join(
    [
        f"- Holzwohnbau Baden (id {BADEN}): 2020–2022, Niederösterreich, GK 4, Holzbau · gemeinsam: Holzbau",
        f"- Wohnhausanlage Mödling (id {MOEDLING}): 2019–2021, Niederösterreich · Fluchttreppe außen",
        f"- Bürogebäude Wien 22 (id {WIEN22}): 2017–2020, Wien, GK 5 · Sicherheitstreppenhaus mit Druckbelüftung",
        "- … und 11 weitere abgeschlossene Projekte, über `project_lookup` auffindbar.",
    ]
)


def _answering(monkeypatch, scores):
    seen: list[dict] = []

    async def decide(states, questions, **kwargs):
        seen.extend(states)
        return [None if p is None else Decision(answers={"fits": {"type": "noul", "noul": p}}) for p in scores]

    monkeypatch.setattr("aiq_agent.common.decisions.decide_many", decide)
    return seen


def test_the_catalog_parses_into_its_project_lines_and_its_tail():
    lines, rest = parse_catalog(CATALOG)

    assert [line.project_id for line in lines] == [BADEN, MOEDLING, WIEN22]
    assert rest == ["- … und 11 weitere abgeschlossene Projekte, über `project_lookup` auffindbar."]


def test_the_fitting_lines_move_ahead_each_group_keeping_the_likeness_order():
    """A partition, not a sort: four Holzbau projects scoring 0.77-0.80 keep the fingerprint's order."""
    lines, _ = parse_catalog(CATALOG)

    ordered = reorder(lines, [0.78, 0.30, 0.95])

    assert [line.project_id for line, _ in ordered] == [BADEN, WIEN22, MOEDLING]


def test_an_unscored_line_is_kept_behind_the_fitting_ones():
    lines, _ = parse_catalog(CATALOG)

    ordered = reorder(lines, [None, 0.9, None])

    assert [line.project_id for line, _ in ordered] == [MOEDLING, BADEN, WIEN22]


async def test_the_question_reorders_the_catalog_and_nothing_is_dropped(monkeypatch):
    _answering(monkeypatch, [0.2, 0.3, 0.86])

    fit = await fit_references("Hatten wir schon ein Sicherheitstreppenhaus?", CATALOG)

    assert fit is not None and fit.order == [WIEN22, BADEN, MOEDLING]
    assert fit.catalog.splitlines()[0].startswith("- Bürogebäude Wien 22")
    assert fit.catalog.splitlines()[-1].startswith("- … und 11 weitere")
    assert sorted(fit.catalog.splitlines()) == sorted(CATALOG.splitlines())


async def test_the_state_is_the_message_and_one_line_without_its_id(monkeypatch):
    seen = _answering(monkeypatch, [0.5, 0.5, 0.5])

    await fit_references("Traufe?", CATALOG)

    assert seen[0] == line_state("Traufe?", parse_catalog(CATALOG)[0][0])
    assert BADEN not in str(seen) and "Holzwohnbau Baden" in seen[0]["earlier_project"]


async def test_a_fit_that_did_not_run_leaves_the_catalog_as_the_bff_wrote_it(monkeypatch):
    _answering(monkeypatch, [None, None, None])

    assert await fit_references("Traufe?", CATALOG) is None


async def test_one_line_is_not_worth_a_reorder(monkeypatch):
    seen = _answering(monkeypatch, [0.9])

    assert await fit_references("Traufe?", CATALOG.splitlines()[0]) is None
    assert seen == []


def test_the_turn_reads_the_fit_order_and_the_trace_says_how_many_fit(monkeypatch):
    recorded: dict = {}
    monkeypatch.setattr(register_module, "record_trace_metadata", lambda **pairs: recorded.update(pairs))
    turn = CrossProjectTurn()
    token = bind_cross_project_turn(turn)
    state = type("State", (), {"reference_projects": CATALOG})()
    try:
        register_module._apply_reference_fit(
            ReferenceFit(ranked=((WIEN22, 0.86), (BADEN, 0.4), (MOEDLING, None)), catalog="reordered"), state
        )
    finally:
        reset_cross_project_turn(token)

    assert state.reference_projects == "reordered"
    assert turn.reference_order == [WIEN22, BADEN, MOEDLING]
    assert recorded == {"reference_fit_scored": 2, "reference_fit_top": 0.86, "reference_fit_fitting": 1}


@pytest.mark.parametrize("words", ["Traufe", "Traufe Holzbau"])
async def test_a_first_message_of_one_or_two_words_asks_nothing(monkeypatch, words):
    from aiq_agent.agents.piloti.decisions import TurnFacts

    seen = _answering(monkeypatch, [0.9, 0.9, 0.9])

    fit = await register_module._fit_references(
        TurnFacts(question=words, reference_projects=3, reference_catalog=CATALOG)
    )

    assert fit is None and seen == []


def test_the_threshold_is_the_measured_one():
    assert FIT_THRESHOLD == 0.6
