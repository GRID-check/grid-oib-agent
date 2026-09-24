"""The answer suite's bookkeeping: the part of it a CI machine can run.

`scripts/turn_census/suite.py` needs a model key and an ingested corpus to RUN.
What is testable offline is everything between a recorded turn and the report:
how a recording becomes a Run, how the checks read an answer, and what the
report says. A suite whose reading of a turn is wrong reports its own bugs as
the agent's, so this is the part that has to be right.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import suite  # noqa: E402

ENVELOPE = {
    "answer": "…",
    "kind": "ruling",
    "cards": [{"type": "surface", "components": [{"id": "root", "component": "Tabs", "tabs": []}]}],
}
ANSWER = (
    "Treppenhauswände in GK 4: **REI 60**, Türen zu Wohnungen **EI₂ 30** [1].\n\n"
    "| Bauteil | Klasse |\n|---|---|\n| Wand | REI 60 |\n\n## Quellen\n- [1] [KB] oib-rl_2_ausgabe_mai_2023.pdf, p.30"
)


def _call(t0: float, seconds: float, *, reasoning: int, output: list[dict]) -> dict:
    return {
        "url": "https://openrouter.ai/api/v1/responses",
        "t_start": t0,
        "t_end": t0 + seconds,
        "req": {"input": [{"role": "user"}]},
        "usage": {
            "input_tokens": 40000,
            "output_tokens": reasoning + 300,
            "output_tokens_details": {"reasoning_tokens": reasoning},
        },
        "resp": {"output": output},
    }


def _recorded_turn(tmp_path: Path) -> tuple[Path, Path]:
    message = {"type": "message", "content": [{"text": "```answer_json\n" + json.dumps(ENVELOPE) + "\n```"}]}
    rows = [
        {"url": "https://openrouter.ai/api/v1/responses", "t_start": 0.0, "t_end": 1.0, "req": {"input": "ping"}},
        _call(2.0, 6.0, reasoning=400, output=[{"type": "function_call", "name": "read_passage"}]),
        _call(8.0, 20.0, reasoning=1500, output=[message]),
    ]
    record = tmp_path / "turn.jsonl"
    record.write_text("\n".join(json.dumps(row) for row in rows))
    log = tmp_path / "turn.log"
    log.write_text(
        "INFO answer_meta summary gated out: restates_lede\n"
        f"\x1b[32mWorkflow Result:\n{ANSWER}\n\x1b[39m\n--------------------------------------------------\n"
    )
    return record, log


QUESTION = {
    "id": "treppenhaus-gk4-tabelle",
    "family": "OIB-RL 2",
    "kind": "ruling",
    "expect": {
        "mentions": ["REI 60", ["EI2 30", "EI₂ 30"]],
        "not_mentions": ["nicht enthalten"],
        "shape": ["tabs", "table"],
    },
}


def test_a_recorded_turn_reads_as_one_run(tmp_path):
    run = suite.observe(QUESTION, 1, *_recorded_turn(tmp_path))
    assert (run.wall_s, run.research_calls, run.final_call_s) == (28.0, 2, 20.0)
    assert (run.reasoning_tokens, run.max_reasoning_tokens) == (1900, 1500)
    assert run.tool_calls == ["read_passage"]
    assert run.signals == ["summary_gated"]
    assert run.answer.startswith("Treppenhauswände in GK 4") and "\x1b" not in run.answer
    assert run.cited_families == ["2"]


def test_every_expectation_is_its_own_check(tmp_path):
    run = suite.observe(QUESTION, 1, *_recorded_turn(tmp_path))
    assert run.checks == {
        "envelope": True,
        "kind": True,
        "family_cited": True,
        "mentions:REI 60": True,
        "mentions:EI2 30": True,
        "not:nicht enthalten": True,
        "shape:tabs|table": True,
    }


def test_a_false_claim_and_a_wrong_family_fail(tmp_path):
    run = suite.observe(QUESTION, 1, *_recorded_turn(tmp_path))
    run.answer = "OIB-RL 2.1 ist im Korpus nicht enthalten. [1] oib-rl_4_ausgabe_mai_2023.pdf"
    run.cited_families = ["4"]
    checks = suite.check(QUESTION, run, run.envelope)
    assert checks["not:nicht enthalten"] is False
    assert checks["family_cited"] is False
    assert checks["mentions:REI 60"] is False


def test_the_report_names_what_did_not_hold_and_compares_medians(tmp_path):
    good = suite.observe(QUESTION, 1, *_recorded_turn(tmp_path))
    bad = suite.Run(**{**good.__dict__, "run": 2, "wall_s": 60.0, "checks": {**good.checks, "kind": False}})
    baseline = {"runs": [{**good.__dict__, "wall_s": 20.0}]}
    report = suite.render([good, bad], ["ordner-listing"], {"started": "t", "runs_per_question": 2}, baseline)
    assert "| treppenhaus-gk4-tabelle | 44 (28–60) (+24)" in report
    assert "`kind` held in 50% of runs" in report
    assert "Skipped, need a project: ordner-listing." in report


def test_the_core_set_needs_no_project():
    questions, skipped = suite.load_questions()
    assert questions and all(q.get("family") for q in questions)
    assert "ordner-brandschutz-listing" in skipped


def test_a_value_inside_a_tab_counts(tmp_path):
    # Seen in the first baseline: REI 60 stood in the variant tab's table, and a
    # check that read only the prose called the answer wrong.
    run = suite.observe(QUESTION, 1, *_recorded_turn(tmp_path))
    run.answer = "Die Nachweise unterscheiden sich je Variante: [[card:1]]"
    envelope = {
        "cards": [{"type": "surface", "components": [{"id": "a", "component": "Text", "text": "| Wand | REI 60 |"}]}]
    }
    assert suite.check(QUESTION, run, envelope)["mentions:REI 60"] is True


def test_the_answer_is_the_last_envelope_not_the_repair_after_it(tmp_path):
    # Seen in the full sweep: every repaired turn read as "no envelope",
    # because the repair's plain rewrite was the last reply.
    record, log = _recorded_turn(tmp_path)
    repair = _call(30.0, 4.0, reasoning=100, output=[{"type": "message", "content": [{"text": "Überarbeitet [1]."}]}])
    record.write_text(record.read_text() + "\n" + json.dumps(repair))
    run = suite.observe(QUESTION, 1, record, log)
    assert run.kind == "ruling" and run.checks["envelope"] is True


def test_a_handoff_to_deep_research_is_not_a_crash(tmp_path):
    record, log = _recorded_turn(tmp_path)
    log.write_text("INFO Clarifier: Starting clarification\nERROR Workflow failed: \n")
    run = suite.observe(QUESTION, 1, record, log)
    assert "escalated" in run.signals and run.error == "" and run.kind == "ruling"


def test_a_second_kind_the_question_accepts_holds(tmp_path):
    run = suite.observe(QUESTION, 1, *_recorded_turn(tmp_path))
    run.kind = "walkthrough"
    assert suite.check(QUESTION, run, run.envelope)["kind"] is False
    both = {**QUESTION, "expect": {**QUESTION["expect"], "kind_also": ["walkthrough"]}}
    assert suite.check(both, run, run.envelope)["kind"] is True


def test_a_question_about_a_richtlinie_the_corpus_lacks_is_skipped_by_name(tmp_path):
    registry = tmp_path / "oib_registry.json"
    registry.write_text(json.dumps({"__chunk_format_version__": 4, "data/oib/oib-rl_2_ausgabe_mai_2023.pdf": {}}))
    families = suite.corpus_families(registry)
    assert families == {"2"}
    assert suite.lacking_family({"family": "OIB-RL 5"}, families) == "OIB-RL 5"
    assert suite.lacking_family(QUESTION, families) is None
    assert suite.lacking_family({"family": "Bauordnung"}, families) is None
    assert suite.lacking_family({"family": "OIB-RL 5"}, suite.corpus_families(tmp_path / "missing.json")) is None
    report = suite.render([], [], {"started": "t", "runs_per_question": 1}, None, ["schallschutz (OIB-RL 5)"])
    assert "the ingested corpus lacks the Richtlinie: schallschutz (OIB-RL 5)." in report


def test_an_answer_without_its_fence_still_has_its_envelope(tmp_path):
    # Seen live: the pipeline accepted a bare-JSON answer and the reader got it
    # whole, while a fence-only reading called the turn envelope-less.
    record, log = _recorded_turn(tmp_path)
    bare = {"type": "message", "content": [{"text": json.dumps({**ENVELOPE, "answer": "Antwort [1]."})}]}
    rows = [json.loads(line) for line in record.read_text().splitlines()]
    rows[-1]["resp"]["output"] = [bare]
    record.write_text("\n".join(json.dumps(row) for row in rows))
    run = suite.observe(QUESTION, 1, record, log)
    assert run.checks["envelope"] is True and run.kind == "ruling"
