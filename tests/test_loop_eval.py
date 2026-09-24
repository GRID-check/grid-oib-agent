"""The loop eval's bookkeeping — the only part of it a CI machine can run.

`scripts/loop_eval.py` needs a backend with the OIB corpus ingested and a model
key behind it, so the RUN is an operator's job (see the script's header and
`docs/contributing/testing-and-verification.md`). What is testable here is
everything between the turn and the reader: how a turn's events become a row,
how rows survive a round-trip through CSV, and what a comparison of two runs
says. That is not incidental plumbing — it IS the measurement, and a comparison
that quietly drops a question, or reads a column that has since been renamed,
would report a delta that came from the harness rather than from the agent.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_loop_eval():
    """Import ``scripts/loop_eval.py`` without requiring a package."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    spec = importlib.util.spec_from_file_location("scripts.loop_eval", REPO_ROOT / "scripts" / "loop_eval.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


loop_eval = _load_loop_eval()

QUESTIONS = REPO_ROOT / "tests" / "fixtures" / "herleitung" / "loop_eval_questions.yaml"


def _row(question_id: str, **overrides) -> loop_eval.Observation:
    base = {
        "id": question_id,
        "expected_family": "OIB-RL 2",
        "expected_punkt": "5.1",
        "expected_kind": "ruling",
        "kind": "ruling",
        "verdict": "yes",
        "rounds": "2",
        "read_passage": "yes",
        "punkt_match": "yes",
        "truncated": "no",
        "checkpoint_sources": "none>argument",
        "family_coverage": "2 3/4",
        "ris_calls": "1",
        "paragraph_match": "",
        "ris_citation_resolved": "",
        "error": "",
    }
    return loop_eval.Observation(**{**base, **overrides})


@pytest.fixture(scope="module")
def questions():
    return loop_eval.load_questions(QUESTIONS)


class TestTheQuestionSet:
    """The fixture the runner reads. Twenty-seven questions, each answerable."""

    def test_it_is_twenty_nine_questions_with_unique_ids(self, questions):
        assert len(questions) == 29
        assert len({q.id for q in questions}) == 29

    def test_every_question_declares_an_expected_kind(self, questions):
        assert {q.kind for q in questions} <= {"ruling", "walkthrough", "direct"}

    def test_it_carries_a_control_that_must_not_grow_a_verdict(self, questions):
        """A set of only legal questions cannot notice a loop change that turns
        "what is in my Brandschutz folder" into a ruling."""
        assert any(q.kind == "direct" and q.family is None for q in questions)

    def test_it_spans_more_than_one_richtlinie_and_reaches_provincial_law(self, questions):
        families = {q.family for q in questions}
        assert len({f for f in families if f and f.startswith("OIB-RL")}) >= 6
        assert "Bauordnung" in families

    def test_provincial_law_is_measurable_and_spans_more_than_one_land(self, questions):
        """One Bauordnung row out of twenty-three could not measure a retrieval
        path, and the nine state codes differ — a set that only ever asks about
        Wien cannot notice a Viennese answer to a Tyrolean question."""
        bauordnung = [q for q in questions if q.family == "Bauordnung"]
        assert len(bauordnung) >= 5
        asked = " ".join(q.question for q in bauordnung)
        assert "Innsbruck" in asked or "Tirol" in asked
        assert "Niederösterreich" in asked
        assert "Salzburg" in asked

    def test_no_bauordnung_row_claims_a_paragraph_nothing_here_can_verify(self, questions):
        """`paragraph` follows `punkt`'s discipline: a § read off a committed
        fixture, never one somebody remembered. There is no committed RIS
        fixture yet, so every one of them is null — and the day one is filled
        in, this test is the line that says where it must come from."""
        assert [q.id for q in questions if q.paragraph] == []

    def test_every_expected_punkt_exists_in_the_committed_structural_index(self, questions):
        """A remembered Punkt number scores a correct answer as wrong.

        The index is the same one the retrieval harness uses, built from the
        real PDFs by `scripts/build_punkt_index.py`, so a Punkt named here is a
        Punkt the corpus actually has.
        """
        import json

        index_path = REPO_ROOT / "frontends" / "benchmarks" / "oib_retrieval" / "fixtures" / "punkt_index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        unknown = [
            (q.id, q.family, q.punkt)
            for q in questions
            if q.punkt and q.punkt not in index.get(str(q.family or "").removeprefix("OIB-RL ").strip(), {})
        ]
        assert unknown == []


class TestOneRow:
    """A turn's own status events become one row. No second measuring channel."""

    def _steps(self, *payloads: dict) -> list[dict]:
        import json

        return [{"name": name, "payload": json.dumps(body)} for name, body in payloads]

    def test_rounds_checkpoints_and_the_locator_come_off_the_status_events(self):
        question = loop_eval.Question(id="q", question="?", family="OIB-RL 2", punkt="5.1", kind="ruling")
        steps = self._steps(
            ("status:retrieval:0", {"tools": ["knowledge_search"]}),
            ("status:checkpoint:0", {"round": 0, "hasConclusion": False, "source": "none"}),
            ("status:retrieval:1", {"tools": ["read_passage"]}),
            ("status:checkpoint:1", {"round": 1, "hasConclusion": True, "source": "argument"}),
        )

        row = loop_eval.observe(question, steps, "… OIB-RL 2, Pkt. 5.1.2 …", {"kind": "ruling", "verdict": {"v": "x"}})

        assert (row.rounds, row.read_passage, row.checkpoint_sources) == ("2", "yes", "none>argument")
        assert (row.kind, row.verdict, row.punkt_match, row.truncated) == ("ruling", "yes", "yes", "no")

    def test_truncation_is_read_off_the_budget_event(self):
        question = loop_eval.Question(id="q", question="?", family=None, punkt=None, kind="direct")
        steps = self._steps(("status:budget", {"truncated": True, "spent": 7}))

        assert loop_eval.observe(question, steps, "", {}).truncated == "yes"

    def test_a_child_punkt_counts_and_a_sibling_does_not(self):
        assert loop_eval.punkt_matches("5.1", ["5.1.2"]) == "yes"
        assert loop_eval.punkt_matches("5.1", ["5.2"]) == "no"
        # `5.11` is not a child of `5.1`; a bare prefix test would say it is.
        assert loop_eval.punkt_matches("5.1", ["5.11"]) == "no"

    def test_an_unmeasured_punkt_is_blank_and_not_a_miss(self):
        """A question with no expected Punkt must not drag the match rate down."""
        assert loop_eval.punkt_matches(None, ["3.1"]) == ""
        assert loop_eval.summarise([_row("a", expected_punkt="", punkt_match="")]).punkt_measured == 0

    def test_the_punkt_scan_reads_the_forms_an_answer_actually_writes(self):
        assert loop_eval.cited_punkte("Pkt. 3.5.2 und Punkt 5.1, siehe Pkt 4") == ["3.5.2", "5.1", "4"]

    def test_the_coverage_event_becomes_the_family_column(self):
        """The runner reads the product's own `status:coverage` records, one
        per family, and folds them into one cell."""
        question = loop_eval.Question(id="q", question="?", family="OIB-RL 2", punkt=None, kind="walkthrough")
        steps = [
            {"name": "status:coverage:2", "payload": '{"family":"2","listed":4,"opened":3}'},
            {"name": "status:coverage:4", "payload": '{"family":"4","listed":1,"opened":1}'},
        ]

        assert loop_eval.observe(question, steps, "", {}).family_coverage == "2 3/4 4 1/1"

    def test_a_turn_that_touched_no_family_leaves_the_cell_empty(self):
        question = loop_eval.Question(id="q", question="?", family=None, punkt=None, kind="direct")
        assert loop_eval.observe(question, [], "", {}).family_coverage == ""


class TestTheCsv:
    def test_a_run_survives_the_round_trip(self, tmp_path: Path):
        rows = [_row("a"), _row("b", rounds="1", read_passage="no", punkt_match="no")]
        path = tmp_path / "run.csv"

        loop_eval.write_csv(path, rows)

        assert loop_eval.read_csv(path) == rows

    def test_the_header_is_the_contract(self, tmp_path: Path):
        """A CSV from another version of this script has different columns, and
        comparing the two without noticing produces a delta that came from the
        schema rather than from the agent."""
        path = tmp_path / "old.csv"
        path.write_text("id,rounds\na,2\n", encoding="utf-8")

        with pytest.raises(ValueError, match="does not carry this script's columns"):
            loop_eval.read_csv(path)

    def test_an_error_row_is_written_rather_than_dropped(self, tmp_path: Path):
        """A dead turn is a fact about the run. Dropping it would improve every
        rate it touched."""
        path = tmp_path / "run.csv"
        loop_eval.write_csv(path, [_row("a"), _row("b", kind="", rounds="", error="ReadTimeout: …")])

        back = loop_eval.read_csv(path)
        assert [row.id for row in back] == ["a", "b"]
        assert loop_eval.summarise(back).errors == 1


class TestComparing:
    def test_it_reports_what_moved_per_question(self):
        before = [_row("a", rounds="1", read_passage="no")]
        after = [_row("a", rounds="2", read_passage="yes")]

        assert loop_eval.changed_rows(before, after) == [
            ("a", "rounds", "1", "2"),
            ("a", "read_passage", "no", "yes"),
        ]

    def test_an_unchanged_run_moves_nothing(self):
        assert loop_eval.changed_rows([_row("a")], [_row("a")]) == []

    def test_a_question_present_in_only_one_run_is_reported_not_joined_away(self):
        """A set that grew or shrank between runs is exactly what a silent inner
        join would hide, and every aggregate below it would then be comparing
        different populations."""
        moved = loop_eval.changed_rows([_row("a")], [_row("a"), _row("b", rounds="3")])

        assert ("b", "rounds", "—", "3") in moved
        assert all(question_id == "b" for question_id, *_ in moved)

    def test_the_expectations_are_not_compared(self):
        """`expected_*` is the question set, not the agent. A change there is a
        change to the eval and belongs in its own diff."""
        moved = loop_eval.changed_rows([_row("a")], [_row("a", expected_family="OIB-RL 4")])
        assert moved == []

    def test_the_aggregate_counts_each_measure_separately(self):
        before = [_row("a", read_passage="no", rounds="1"), _row("b", read_passage="no", rounds="1")]
        after = [_row("a", read_passage="yes", rounds="2"), _row("b", read_passage="no", rounds="1")]

        report = loop_eval.format_comparison(before, after)

        assert "read_passage: 0 → 1 (+1)" in report
        assert "retrieval rounds, total: 2 → 3 (+1)" in report

    def test_family_coverage_is_read_as_opened_of_listed(self):
        """The column this set exists to move: "OIB-RL 2, three of four parts"."""
        assert loop_eval.family_coverage("2 3/4 4 1/1") == [("2", 3, 4), ("4", 1, 1)]

    def test_an_empty_or_unreadable_coverage_cell_scores_nothing(self):
        """A cell the harness could not write is a harness fault. Scoring it as
        a complete miss would blame the agent for it."""
        assert loop_eval.family_coverage("") == []
        assert loop_eval.family_coverage("2 drei/vier") == []

    def test_the_aggregate_counts_complete_families_against_touched_ones(self):
        before = [_row("a", family_coverage="2 3/4")]
        after = [_row("a", family_coverage="2 4/4")]

        report = loop_eval.format_comparison(before, after)

        assert "families read completely: 0 → 1 (+1) of 1 → 1 (+0) touched" in report

    def test_a_family_that_became_incomplete_shows_up_per_question(self):
        moved = loop_eval.changed_rows([_row("a", family_coverage="2 4/4")], [_row("a", family_coverage="2 3/4")])
        assert moved == [("a", "family_coverage", "2 4/4", "2 3/4")]

    def test_the_checkpoint_source_histogram_is_per_round_not_per_turn(self):
        """A two-round turn contributes two checkpoints. Counting turns would
        make `argument` and `none` add up to the wrong denominator."""
        summary = loop_eval.summarise([_row("a", checkpoint_sources="none>argument>argument")])
        assert summary.checkpoint_sources == {"none": 1, "argument": 2}

    def test_a_first_run_compares_against_nothing_without_dividing_by_zero(self):
        """`--out` prints the same report against an empty baseline."""
        report = loop_eval.format_comparison([], [_row("a")])
        assert "questions: 0 → 1 (+1)" in report


class TestCapRetryIsPositional:
    """A cap is only a retry when the turn KEPT FETCHING after it."""

    def test_a_fetch_after_the_cap_is_a_retry(self):
        payloads = [
            ("status:retrieval:0", {}),
            ("retrieve.knowledge", {"input": {"query": "a"}}),
            ("status:width:0", {"kept": 12, "withheld": 3}),
            ("status:retrieval:1", {}),
            ("retrieve.knowledge", {"input": {"query": "b"}}),
        ]
        assert loop_eval.flag_cap_retry(payloads) == "yes"

    def test_a_cap_on_the_last_fetch_is_not_a_retry(self):
        payloads = [
            ("status:retrieval:0", {}),
            ("retrieve.knowledge", {"input": {"query": "a"}}),
            ("status:width:0", {"kept": 12, "withheld": 3}),
        ]
        assert loop_eval.flag_cap_retry(payloads) == "no"

    def test_the_input_token_stop_is_a_cap(self):
        """The slot that replaced the deleted fan-out one. It was missing from
        the set, so every token-bound stop read as no cap at all."""
        payloads = [
            ("status:budget:input", {"limit": 600000, "spent": 600001}),
            ("retrieve.knowledge", {"input": {"query": "b"}}),
        ]
        assert loop_eval.flag_cap_retry(payloads) == "yes"

    def test_a_diversity_cap_on_a_retrieved_pool_counts_too(self):
        payloads = [
            ("retrieve.knowledge", {"input": {"dropped_by_cap": 3}}),
            ("retrieve.knowledge", {"input": {"query": "b"}}),
        ]
        assert loop_eval.flag_cap_retry(payloads) == "yes"

    def test_no_cap_at_all_is_never_a_retry(self):
        payloads = [
            ("status:retrieval:0", {}),
            ("retrieve.knowledge", {"input": {"query": "a"}}),
            ("status:retrieval:1", {}),
            ("retrieve.knowledge", {"input": {"query": "b"}}),
        ]
        assert loop_eval.flag_cap_retry(payloads) == "no"


class TestTheRisColumns:
    """The three numbers the RIS consolidation is judged on.

    Each is read off the same telemetry the product emits — the round
    announcements' `tools` list and the `retrieve.ris_lookup` span — so a
    before/after run measures the agent and not a second measuring channel.
    """

    def _question(self, **overrides) -> loop_eval.Question:
        base = {
            "id": "einreichung-wien-unterlagen",
            "question": "Welche Unterlagen verlangt die Baubehörde in Wien?",
            "family": "Bauordnung",
            "punkt": None,
            "kind": "walkthrough",
        }
        return loop_eval.Question(**{**base, **overrides})

    def _steps(self, *payloads: dict) -> list[dict]:
        import json

        return [{"name": name, "payload": json.dumps(body)} for name, body in payloads]

    def _span(self, *, keys: list[str] | None = None, punkte: list[str] | None = None) -> tuple[str, dict]:
        output: dict = {"picked": []}
        if keys:
            output["citation_keys"] = keys
        if punkte:
            output["punkt_ids"] = punkte
        return ("retrieve.ris_lookup", {"input": {"round": 0, "tool": "ris_lookup"}, "output": output})

    def test_the_old_three_tool_shape_counts_three_calls(self):
        """What a before-run looks like: catalog, search, fetch."""
        tools = ["ris_catalog_lookup_tool", "ris_search_tool", "ris_fetch_tool", "knowledge_search"]

        assert loop_eval.count_ris_calls(tools) == 3

    def test_the_consolidated_shape_counts_one(self):
        assert loop_eval.count_ris_calls(["ris_lookup_tool", "knowledge_search"]) == 1

    def test_a_turn_that_never_touched_ris_counts_zero(self):
        assert loop_eval.count_ris_calls(["knowledge_search", "read_passage"]) == 0

    def test_ris_calls_is_read_off_the_round_announcements(self):
        steps = self._steps(("status:retrieval:0", {"tools": ["ris_lookup_tool"]}))

        row = loop_eval.observe(self._question(), steps, "Antwort", {})

        assert row.ris_calls == "1"

    def test_a_cited_paragraph_the_turn_retrieved_matches(self):
        payloads = [self._span(punkte=["§63Abs1"])]

        assert loop_eval.paragraph_matches(self._question(), "… § 63 Abs 1 BO Wien …", payloads) == "yes"

    def test_a_cited_paragraph_the_turn_never_retrieved_does_not(self):
        payloads = [self._span(punkte=["§63Abs1"])]

        assert loop_eval.paragraph_matches(self._question(), "… § 99 BO Wien …", payloads) == "no"

    def test_a_committed_expectation_outranks_what_the_turn_retrieved(self):
        """The same precedence `punkt` has: a fact somebody checked beats the
        turn's own account of itself."""
        payloads = [self._span(punkte=["§63"])]
        question = self._question(paragraph="§ 70")

        assert loop_eval.paragraph_matches(question, "… § 63 …", payloads) == "no"
        assert loop_eval.paragraph_matches(question, "… § 70 Abs 2 …", payloads) == "yes"

    def test_a_turn_with_no_paragraph_to_check_is_unmeasured_not_a_miss(self):
        assert loop_eval.paragraph_matches(self._question(), "Antwort ohne Paragraf", []) == ""

    def test_a_ris_citation_still_in_the_answer_resolved(self):
        """The answer this harness reads is the post-verification one, so a key
        still in it is a key `verify_citations` kept."""
        payloads = [self._span(keys=["Bauordnung für Wien, § 63 Abs 1"])]
        answer = "Laut Bauordnung für Wien, § 63 Abs 1 sind die Pläne anzuschließen."

        assert loop_eval.flag_ris_citation_resolved(answer, payloads) == "yes"

    def test_a_ris_citation_stripped_from_the_answer_did_not(self):
        payloads = [self._span(keys=["Bauordnung für Wien, § 63 Abs 1"])]

        assert loop_eval.flag_ris_citation_resolved("Dazu kann ich nichts sagen.", payloads) == "no"

    def test_a_turn_with_no_ris_span_leaves_the_cell_empty(self):
        """Before the consolidation there was no span at all — an unmeasured
        cell, not a failure to attribute to the agent."""
        assert loop_eval.flag_ris_citation_resolved("Antwort", []) == ""


class TestTheCli:
    def test_it_refuses_to_run_without_a_backend(self, tmp_path: Path, monkeypatch):
        """Not a silent no-op: a run with no backend that exits 0 leaves an
        empty CSV somebody will later compare against."""
        monkeypatch.delenv(loop_eval.BASE_URL_ENV, raising=False)

        with pytest.raises(SystemExit) as exit_info:
            loop_eval.main(["--out", str(tmp_path / "x.csv")])

        assert exit_info.value.code == 2

    def test_compare_needs_no_backend_at_all(self, tmp_path: Path, capsys):
        before, after = tmp_path / "before.csv", tmp_path / "after.csv"
        loop_eval.write_csv(before, [_row("a", rounds="1")])
        loop_eval.write_csv(after, [_row("a", rounds="2")])

        assert loop_eval.main(["--compare", str(before), str(after)]) == 0
        assert "rounds" in capsys.readouterr().out
