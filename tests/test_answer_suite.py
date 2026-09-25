"""The answer suite's bookkeeping: the part of it a CI machine can run.

`scripts/turn_census/suite.py` needs a model key and an ingested corpus to RUN.
What is testable offline is everything between a recorded turn and the report:
how a recording becomes a Run, how the checks read an answer, and what the
report says. A suite whose reading of a turn is wrong reports its own bugs as
the agent's, so this is the part that has to be right.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

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


def _streamed(tmp_path: Path, events: list[dict]) -> dict:
    """What the recorder writes for one streamed call of these events."""
    import subprocess
    import textwrap

    out = tmp_path / "rec.jsonl"
    out.unlink(missing_ok=True)
    body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
    script = textwrap.dedent(
        f"""
        import asyncio, sys
        sys.path.insert(0, {str(REPO_ROOT / "scripts" / "turn_census")!r})
        import sitecustomize as rec

        class Inner:
            async def __aiter__(self):
                for part in {body!r}.encode().split(b"\\n\\n"):
                    yield part + b"\\n\\n"
            async def aclose(self):
                pass

        async def main():
            tee = rec._Tee(Inner(), {{"t_start": 0.0}})
            async for _ in tee:
                pass
            await tee.aclose()

        asyncio.run(main())
        """
    )
    subprocess.run([sys.executable, "-c", script], check=True, env={"REC_OUT": str(out), "PATH": ""})
    return json.loads(out.read_text().splitlines()[0])


def test_a_streamed_call_records_its_response_and_when_text_began(tmp_path):
    # A streamed answer (ADR-0066) has no JSON body: the first core run after
    # prose streamed recorded every envelope as missing.
    completed = {
        "type": "response.completed",
        "response": {"output": [{"type": "message"}], "usage": {"output_tokens": 3}},
    }
    entry = _streamed(
        tmp_path, [{"type": "response.created"}, {"type": "response.output_text.delta", "delta": "Hallo"}, completed]
    )
    assert entry["resp"]["output"] == [{"type": "message"}]
    assert entry["usage"] == {"output_tokens": 3}
    assert entry["t_first_text"] > 0
    # A stream that never showed text (tool calls only) has no first-text time.
    assert "t_first_text" not in _streamed(tmp_path, [{"type": "response.created"}, completed])


def test_a_model_call_that_raises_is_recorded_with_its_seconds(tmp_path):
    # A timed-out attempt the SDK retries raised out of send, so it was never
    # written and its seconds vanished from the turn.
    import subprocess
    import textwrap

    out = tmp_path / "rec.jsonl"
    script = textwrap.dedent(
        f"""
        import asyncio, sys
        import httpx
        sys.path.insert(0, {str(REPO_ROOT / "scripts" / "turn_census")!r})
        import sitecustomize as rec

        def timeout(request):
            raise httpx.ReadTimeout("slow", request=request)

        url = "https://openrouter.ai/api/v1/responses"
        client = httpx.Client(transport=httpx.MockTransport(timeout))
        try:
            rec._send_sync(client, client.build_request("POST", url, json={{"input": "x"}}))
        except httpx.ReadTimeout:
            pass
        else:
            raise SystemExit("the timeout was swallowed")

        async def main():
            async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
                try:
                    await rec._send(client, client.build_request("POST", url, json={{"input": "x"}}))
                except httpx.ReadTimeout:
                    return
                raise SystemExit("the timeout was swallowed")

        asyncio.run(main())
        """
    )
    subprocess.run([sys.executable, "-c", script], check=True, env={"REC_OUT": str(out), "PATH": ""})
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    assert [("ReadTimeout" in row["err"], row.get("sync", False)) for row in rows] == [(True, True), (True, False)]
    assert all(row["t_end"] >= row["t_start"] for row in rows)


def test_the_first_text_column_reads_the_final_call(tmp_path):
    record, log = _recorded_turn(tmp_path)
    rows = [json.loads(line) for line in record.read_text().splitlines()]
    rows[-1]["t_first_text"] = 21.5  # the final call starts at 8.0, the turn at 0.0
    record.write_text("\n".join(json.dumps(row) for row in rows))
    run = suite.observe(QUESTION, 1, record, log)
    assert run.first_text_s == 21.5
    report = suite.render([run], [], {"started": "t", "runs_per_question": 1})
    assert "| First text s |" in report and "| 21.5 |" in report


def test_an_empty_inventory_refuses_to_measure(tmp_path):
    # A suite started outside the ingest's directory read ./summaries.db as an
    # empty file and measured an agent with no inventory, no family overviews
    # and no quote checks, 7 s per turn slower, without an error.
    import sqlite3

    empty = tmp_path / "empty.db"
    assert suite.inventory_ready(empty) is False

    filled = tmp_path / "filled.db"
    with sqlite3.connect(filled) as db:
        db.execute("CREATE TABLE document_metadata (collection TEXT, filename TEXT)")
        db.execute("INSERT INTO document_metadata VALUES ('oib_knowledge', 'oib-rl_2_ausgabe_mai_2023.pdf')")
    assert suite.inventory_ready(filled) is True


def test_the_inventory_checked_is_the_one_the_runs_read(monkeypatch, tmp_path):
    # Every run's `nat run` starts in the repo root, so a relative path means
    # the root's file, wherever the suite itself was started from.
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
    assert suite.inventory_database() == (suite.ROOT / "summaries.db").resolve()

    monkeypatch.setenv("AIQ_SUMMARY_DB", f"sqlite+aiosqlite:///{tmp_path}/elsewhere.db")
    assert suite.inventory_database() == tmp_path / "elsewhere.db"


def test_the_runs_import_this_checkout(tmp_path):
    # From a worktree whose interpreter installed another checkout's packages,
    # the runs measured that checkout while the report named this commit.
    import census

    path = census.tree_pythonpath(tmp_path).split(os.pathsep)
    shim = Path(path[1])
    assert path[0] == str(census.HERE) and path[2] == str(census.ROOT / "src")
    assert shim.parent == tmp_path and shim.name.startswith(".tree-")
    assert (shim / "knowledge_layer").resolve() == (census.ROOT / "sources/knowledge_layer/src").resolve()
    assert suite.foreign_imports(tmp_path) == []


def test_the_workers_can_ask_for_the_path_at_once(tmp_path):
    # Four workers built the links at once and one died on FileExistsError.
    from concurrent.futures import ThreadPoolExecutor

    import census

    with ThreadPoolExecutor(8) as pool:
        paths = list(pool.map(lambda _: census.tree_pythonpath(tmp_path), range(16)))

    assert len(set(paths)) == 1


def test_a_record_line_the_kill_cut_short_is_skipped(tmp_path):
    record = tmp_path / "r.jsonl"
    record.write_text('{"t_start": 1, "t_end": 2, "url": "x"}\n{"t_start": 3, "t_en')

    import census

    assert len(census.records(record)) == 1
    assert census.summarize(record)["kinds"]


def test_a_run_that_recorded_nothing_summarizes_as_empty(tmp_path):
    # A `nat run` that died before its first model call wrote no record, and
    # the census crashed on the missing file instead of reporting.
    import census

    assert census.summarize(tmp_path / "never-written.jsonl") == {"kinds": {}, "research": [], "wall_seconds": 0.0}


def test_every_linked_package_is_checked_for_a_foreign_import():
    import census

    assert "tavily_web_search" in census.source_packages()


def test_one_failing_run_does_not_sink_the_suite(tmp_path, monkeypatch):
    # A raise in one worker used to discard every result after the paid runs.
    def boom(*args, **kwargs):
        raise RuntimeError("nat died")

    monkeypatch.setattr(suite, "run_once", boom)
    [run] = suite.run_suite([{"id": "q1", "question": "Frage?"}], 1, tmp_path, 1, None)

    assert run.error == "RuntimeError: nat died"


def test_a_table_or_a_drawing_in_a_card_counts(tmp_path):
    # A table the reader saw in a card was reported as missing, because the
    # shape check read only the prose.
    run = suite.Run(question_id="q", run=1, answer="Siehe Tabelle: [[card:1]]")
    table = {"expect": {"shape": "table"}}
    in_text = {"cards": [{"type": "surface", "components": [{"component": "Text", "text": "| Wand | REI 60 |"}]}]}
    assert suite.check(table, run, in_text)["shape:table"] is True
    for card_type in ("typed_table", "comparison_table"):
        assert suite.check(table, run, {"cards": [{"type": card_type, "rows": []}]})["shape:table"] is True
    assert suite.check(table, run, {"cards": [{"type": "callout", "text": "keine"}]})["shape:table"] is False
    drawing = {"expect": {"shape": "diagram"}}
    assert suite.check(drawing, run, {"cards": [{"type": "diagram", "mermaid": "flowchart LR"}]})["shape:diagram"]
    assert suite.check(drawing, run, {"cards": []})["shape:diagram"] is False


def test_a_repair_after_the_answer_is_neither_the_final_call_nor_a_research_round(tmp_path):
    record, log = _recorded_turn(tmp_path)
    rows = [json.loads(line) for line in record.read_text().splitlines()]
    rows[-1]["t_first_text"] = 21.5
    repair = _call(30.0, 4.0, reasoning=100, output=[{"type": "message", "content": [{"text": "Überarbeitet [1]."}]}])
    repair["t_first_text"] = 31.0
    record.write_text("\n".join(json.dumps(row) for row in [*rows, repair]))
    run = suite.observe(QUESTION, 1, record, log)
    assert (run.final_call_s, run.first_text_s) == (20.0, 21.5)
    assert (run.research_calls, run.post_answer_calls) == (2, 1)
    assert run.reasoning_tokens == 2000  # the repair was billed all the same


def test_the_import_check_asks_the_interpreter_the_runs_use(tmp_path, monkeypatch):
    # The runs used .venv/bin/nat while the check asked sys.executable, so it
    # answered for an interpreter no run used.
    import subprocess

    import census

    asked: list[str] = []

    class Stop(Exception):
        pass

    def fake_run(cmd, **kwargs):
        asked.append(cmd[0])
        return subprocess.CompletedProcess(cmd, 1, "", "stop")

    def fake_popen(cmd, **kwargs):
        asked.append(cmd[0])
        raise Stop

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(census.subprocess, "Popen", fake_popen)
    suite.foreign_imports(tmp_path)
    try:
        census.run_once("Frage?", tmp_path, "c1")
    except Stop:
        pass
    assert asked == [census.run_python(), census.run_python()]


def test_an_inventory_under_a_path_with_uri_syntax_is_read(tmp_path):
    import sqlite3

    folder = tmp_path / "run #2?x=1 %20"
    folder.mkdir()
    filled = folder / "filled.db"
    with sqlite3.connect(filled) as db:
        db.execute("CREATE TABLE document_metadata (collection TEXT, filename TEXT)")
        db.execute("INSERT INTO document_metadata VALUES ('oib_knowledge', 'oib-rl_2_ausgabe_mai_2023.pdf')")
    db.close()
    assert suite.inventory_ready(filled) is True
    assert not (tmp_path / "run ").exists()  # nothing opened beside it


def _results(folder: Path, runs: list[suite.Run], meta: dict) -> Path:
    from dataclasses import asdict

    path = folder / "results.json"
    path.write_text(json.dumps({"meta": meta, "skipped": [], "runs": [asdict(run) for run in runs]}))
    return path


def test_report_rereads_the_recording_beside_the_results(tmp_path, monkeypatch, capsys):
    record, log = _recorded_turn(tmp_path)
    record.rename(tmp_path / f"suite-101010-7-{QUESTION['id']}-1.jsonl")
    log.rename(tmp_path / f"suite-101010-7-{QUESTION['id']}-1.log")
    # What results.json holds is stale: the report must come from the recording.
    stale = suite.Run(question_id=QUESTION["id"], run=1, wall_s=99.0, error="old harness bug")
    report = _results(tmp_path, [stale], {"started": "t", "runs_per_question": 1, "stamp": "101010-7"})
    monkeypatch.setattr(suite, "load_questions", lambda **_: ([QUESTION], []))

    assert suite.main(["--report", str(report)]) == 0
    out = capsys.readouterr().out
    assert f"| {QUESTION['id']} | 28 |" in out and "old harness bug" not in out


def test_a_recording_belongs_to_its_own_question_and_stamp(tmp_path):
    run = suite.Run(question_id="gk4", run=1)
    mine = tmp_path / "suite-101010-7-gk4-1.jsonl"
    other_question = tmp_path / "suite-101010-7-treppenhaus-gk4-1.jsonl"
    other_suite = tmp_path / "suite-235959-8-gk4-1.jsonl"
    for path in (mine, other_question, other_suite):
        path.write_text("")
    os.utime(other_suite, (1, 1))
    assert suite.recording(tmp_path, "101010-7", run) == mine
    assert suite.recording(tmp_path, "000000-1", run) is None
    # An older results.json has no stamp: the exact question, newest file.
    assert suite.recording(tmp_path, None, run) == mine
    other_question.unlink()
    mine.unlink()
    assert suite.recording(tmp_path, None, run) == other_suite


def test_a_run_the_census_timed_out_says_so(tmp_path):
    record, log = _recorded_turn(tmp_path)
    log.write_text("INFO searching\n\ncensus: timed out after 600s\n")
    assert suite.observe(QUESTION, 1, record, log).error == "timed out"


def test_only_a_question_that_needs_a_project_says_why(capsys):
    assert suite.select_questions(["ordner-brandschutz-listing"], False) is None
    err = capsys.readouterr().err
    assert "Needs a project" in err and "nothing was run" in err and "No such question" not in err
    assert suite.select_questions(["no-such-id"], False) is None
    assert "No such question: no-such-id" in capsys.readouterr().err


def test_the_startup_probe_reexecutes_into_this_checkout(monkeypatch, tmp_path):
    # From a worktree the in-process probe timed the main checkout's
    # knowledge layer, and the fix was a symlink built by hand.
    import census
    import startup_probe

    class Exec(Exception):
        pass

    seen = {}

    def fake_execve(path, argv, env):
        seen.update(path=path, argv=argv, env=env)
        raise Exec

    monkeypatch.setattr(startup_probe.os, "execve", fake_execve)
    monkeypatch.setattr(startup_probe.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.delenv(startup_probe._IN_TREE, raising=False)
    monkeypatch.setenv("REC_OUT", "/tmp/should-not-record.jsonl")
    try:
        startup_probe.main(["Frage?"])
    except Exec:
        pass
    assert seen["path"] == census.run_python() and seen["argv"][-1] == "Frage?"
    assert seen["env"][startup_probe._IN_TREE] == "1" and "REC_OUT" not in seen["env"]
    shim = Path(seen["env"]["PYTHONPATH"].split(os.pathsep)[1])
    assert shim.is_relative_to(tmp_path)
    assert (shim / "knowledge_layer").resolve() == (census.ROOT / "sources/knowledge_layer/src").resolve()

    # The re-executed process does not re-execute.
    monkeypatch.setenv(startup_probe._IN_TREE, "1")
    startup_probe._in_tree(["Frage?"])


def test_a_landed_quote_patch_explains_the_settled_replacement():
    # A landed patch removes the quote's unverified marker, so the terminal
    # differs from the settled frame by design (ADR-0067); N = 0 is logged too.
    replaced = "Piloti: the terminal frame replaced the settled answer (10 -> 9 chars)\n"
    landed = suite.log_signals("Piloti: quote patch corrected 1 of 2 quote(s)\n" + replaced)
    missed = suite.log_signals("Piloti: quote patch corrected 0 of 1 quote(s)\n" + replaced)

    assert "quote_patch" in landed and "settled_patched" in landed and "settled_replaced" not in landed
    assert "quote_patch" not in missed and "settled_replaced" in missed


def test_the_startup_probe_takes_the_key_some_environments_carry(monkeypatch, capsys):
    # With only OPENROUTER_KEY set the probe failed at its first model call.
    import startup_probe

    monkeypatch.setenv(startup_probe._IN_TREE, "1")
    # Set, then emptied: monkeypatch restores what ensure_key writes.
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    monkeypatch.setenv("OPENROUTER_KEY", "")
    assert startup_probe.main(["Frage?"]) == 2
    assert "OPENROUTER_API_KEY is not set" in capsys.readouterr().err

    ran: list[list[str]] = []

    async def fake_run(config, questions):
        ran.append(questions)

    monkeypatch.setenv("OPENROUTER_KEY", "test-key")
    monkeypatch.setattr(startup_probe, "_patch_http", lambda: None)
    monkeypatch.setattr(startup_probe, "_patch_retriever", lambda: None)
    monkeypatch.setattr(startup_probe, "_run", fake_run)
    assert startup_probe.main(["Frage?"]) == 0
    assert ran == [["Frage?"]] and os.environ["OPENROUTER_API_KEY"] == "test-key"


def test_a_bad_only_id_is_refused_before_anything_is_ingested(monkeypatch):
    # The ids were checked after the preflight, which with --ingest had
    # already run a full sync.
    monkeypatch.setattr(suite, "_preflight", lambda out, ingest: pytest.fail("preflight ran for a bad id"))
    assert suite.main(["--only", "no-such-id", "--ingest"]) == 2


def test_a_foreign_checkout_is_refused_before_the_ingest(monkeypatch, tmp_path):
    # From a worktree the ingest ran another checkout's knowledge layer in
    # this process, and only then did the import check refuse.
    import types

    import aiq_agent

    monkeypatch.setattr(suite, "ensure_key", lambda: True)
    monkeypatch.setattr(suite, "foreign_imports", lambda out: ["aiq_agent: /elsewhere/aiq_agent/__init__.py"])
    sync = types.SimpleNamespace(sync=lambda: pytest.fail("ingested before the import check"))
    monkeypatch.setitem(sys.modules, "aiq_agent.oib_sync", sync)
    monkeypatch.setattr(aiq_agent, "oib_sync", sync, raising=False)
    assert suite._preflight(tmp_path, ingest=True) == 2


def test_census_report_without_recordings_names_the_mistake(capsys):
    import census

    with pytest.raises(SystemExit):
        census.main(["--report"])
    assert "--report needs the recordings" in capsys.readouterr().err


def test_wall_time_ends_with_the_call_that_ends_last(tmp_path):
    # A long answer call overlapped by a short check that started later.
    import census

    record = tmp_path / "r.jsonl"
    rows = [
        {"t_start": 0.0, "t_end": 30.0, "url": "https://openrouter.ai/api/v1/responses", "req": {"input": "q"}},
        {"t_start": 5.0, "t_end": 6.0, "url": "https://openrouter.ai/api/v1/chat/completions", "req": {}},
    ]
    record.write_text("".join(json.dumps(row) + "\n" for row in rows))

    assert census.summarize(record)["wall_seconds"] == 30.0
