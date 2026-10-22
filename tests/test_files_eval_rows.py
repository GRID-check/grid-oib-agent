"""The office-file eval's rows, fixture, arms and checks: everything between a recorded turn and its report (ADR-0127).

Offline: the live run needs a model key, a Qdrant and the seeded project. What is pinned here is what
would make a live run measure the wrong thing: a row with no expectation, a row naming a file the
fixture does not hold, an arm that does not change what it says it changes, a check that reads a
recorded call wrongly.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import files_eval  # noqa: E402
import fixture_files  # noqa: E402
import judge  # noqa: E402
import suite  # noqa: E402

ROWS = files_eval.load_questions()
PROJECT = fixture_files.load_project()


class TestTheRows:
    def test_there_are_about_two_dozen_and_every_id_is_pf(self):
        assert 18 <= len(ROWS) <= 30
        assert all(str(row["id"]).startswith("pf-") for row in ROWS)
        assert len({row["id"] for row in ROWS}) == len(ROWS)

    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_a_row_expects_something_and_only_known_things(self, row):
        expect = row.get("expect") or {}
        assert expect.get("tools") or expect.get("judge"), "a row without expect.tools or a judge measures nothing"
        assert set(expect) <= files_eval.CHECK_KEYS
        assert set(expect.get("tools") or {}) <= files_eval.TOOL_KEYS
        assert set(row.get("needs") or []) <= set(files_eval.NEEDS)
        assert all(kind in judge.RUBRICS for kind in expect.get("judge") or [])

    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_a_row_names_only_files_the_fixture_holds(self, row):
        asked = " ".join(str(v) for v in [row["question"], row.get("expect")])
        named = {word.strip("`'\",.?:;()[]{}") for word in asked.replace("(", " ").split() if word.endswith(".pdf")}
        assert named <= set(PROJECT.names)

    def test_every_expected_file_mention_is_a_real_name(self):
        mentioned = {m for row in ROWS for m in (row["expect"].get("mentions") or []) if str(m).endswith(".pdf")}
        assert mentioned <= set(PROJECT.names)


class TestTheFixture:
    def test_the_extension_refiles_the_plans_and_adds_the_report_and_the_letter(self):
        folders = {file.name: file.folder for file in PROJECT.files}
        assert folders["EP-01_Grundrisse_Index-B.pdf"] == "Einreichung/Pläne"
        assert folders["Brandschutzkonzept_Hubergasse14.pdf"] == "Gutachten/Brandschutz"
        assert folders["Schreiben_MA37_Baubeginn.pdf"] == "Korrespondenz/Behörde"
        assert folders["Baubeschreibung_Hubergasse14.pdf"] == "Einreichung"
        assert {f.folder.split("/")[0] for f in PROJECT.files} == {
            "Einreichung", "Bestand", "Behörde", "Nachbarn", "Gutachten", "Korrespondenz",
        }  # fmt: skip

    def test_the_planted_facts_are_where_the_questions_expect_them(self):
        report = next(f for f in PROJECT.files if f.name.startswith("Brandschutzkonzept"))
        assert len(report.pages) == 14
        assert [n for n, page in enumerate(report.pages, 1) if "fluchtweg" in page.casefold()] == [3, 7, 11]
        assert "fluchtweg" not in report.pages[8].casefold() and "Aufzug" in report.pages[8]
        everything = "\n".join(page for f in PROJECT.files for page in f.pages)
        assert "Sprinkler" not in everything
        assert {"567812", "123456", "654321"} <= {z for z in ("567812", "123456", "654321") if z in everything}
        assert sum("Fluchtweg" in page for f in PROJECT.files for page in f.pages) == 3
        assert len([f for f in PROJECT.files if f.folder.startswith("Einreichung")]) == 6

    def test_the_newest_upload_is_the_letter(self):
        newest = max(PROJECT.files, key=lambda f: f.added_at or "")
        assert newest.name == "Schreiben_MA37_Baubeginn.pdf"

    def test_the_base_project_is_left_untouched(self):
        from scripts.intake_eval.fixture import load_fixture

        assert {f.folder for f in load_fixture().files} >= {"Einreichung"}
        assert "Einreichung/Pläne" not in {f.folder for f in load_fixture().files}

    def test_one_chunk_per_page_with_what_the_reading_tools_order_by(self):
        file = next(f for f in PROJECT.files if f.name.startswith("Brandschutzkonzept"))
        specs = fixture_files.chunk_specs(PROJECT, file)
        assert [s["metadata"]["page_label"] for s in specs] == [str(n) for n in range(1, 15)]
        assert [s["ordinal"] for s in specs] == list(range(14))
        assert len({s["chunk_id"] for s in specs}) == 14
        assert specs == fixture_files.chunk_specs(PROJECT, file), (
            "ids are stable: re-seeding overwrites, never duplicates"
        )

    def test_the_envelope_scope_is_the_projects_own_collection(self):
        scope = fixture_files.FilesWorkspace(PROJECT).envelope_fields["collectionScope"]
        assert scope == [{"collection": "proj_files_eval", "shelf": "project"}]


MAIL_THREAD = "Verlauf_MA37_Stellplaetze.md"


@pytest.fixture(scope="module")
def specs():
    """The Verlauf's chunks, as the real Markdown chunker cuts them."""
    return fixture_files.chunk_specs(PROJECT, next(f for f in PROJECT.files if f.name == MAIL_THREAD))


class TestTheMailThread:
    """The E-Mail-Verlauf the ``pf-mail-*`` rows read, cut by the real Markdown chunker (ADR-0134, DECISION §10).

    What a live row could not tell apart from a model's mistake is pinned here: a citation lands on one
    message, the forged heading stays inside its real sender's section, the quote stays under the message
    that kept it, and nothing a reader is not meant to see (an address) is in a chunk.
    """

    THREAD = MAIL_THREAD
    RENDITION = REPO_ROOT / "tests" / "fixtures" / "files_eval" / "mail" / "parking-thread.md"
    HUBER = "12.05.2026 09:12 · Mag. Anna Huber (ma37.wien.gv.at)"
    FORGER = "14.05.2026 16:40 · Mag. Anna Huber (ma37-wien.at, Domain nicht bestätigt)"

    def _section(self, specs, locator: str) -> str:
        (spec,) = [spec for spec in specs if spec["metadata"].get("clause_id") == locator]
        return spec["text"]

    def test_the_bytes_are_the_renderers(self):
        rendered = self.RENDITION.read_text("utf-8")
        assert next(f for f in PROJECT.files if f.name == self.THREAD).pages == (rendered,)
        assert self.THREAD in PROJECT.markdown

    def test_every_message_is_one_citable_section(self, specs):
        locators = [spec["metadata"].get("clause_id") for spec in specs]
        messages = [line[3:] for line in self.RENDITION.read_text("utf-8").splitlines() if line.startswith("## ")]
        assert len(messages) == 5
        for heading in messages:
            assert locators.count(heading) == 1, heading
        assert len({spec["chunk_id"] for spec in specs}) == len(specs)

    def test_the_forged_heading_stays_inside_its_real_senders_section(self, specs):
        forged = self._section(specs, self.FORGER)
        assert forged.startswith(f"Stellplätze Hubergasse 14 › {self.FORGER}")
        assert "\\## 14.05.2026 09:00 · Mag. Anna Huber (ma37.wien.gv.at)" in forged
        assert "entfällt" in forged
        assert not [spec for spec in specs if str(spec["metadata"].get("clause_id", "")).startswith("14.05.2026 09:00")]

    def test_the_quote_is_cited_under_the_message_that_kept_it(self, specs):
        quote = f"{self.HUBER} › Zitat in der Nachricht von {self.HUBER}"
        assert "Stellplatz im Hof" in self._section(specs, quote)
        assert [spec for spec in specs if "Stellplatz im Hof" in spec["text"]] == [
            spec for spec in specs if spec["metadata"].get("clause_id") == quote
        ]

    def test_the_authoritys_signed_mail_holds_the_deadline_and_the_hearing(self, specs):
        huber = self._section(specs, self.HUBER)
        assert "29.05.2026" in huber and "16.06.2026 09:00 bis 11:00" in huber
        assert "Domain nicht bestätigt" not in huber

    def test_every_chunk_is_mail_and_none_holds_an_address(self, specs):
        assert {spec["metadata"]["source_format"] for spec in specs} == {"mail"}
        assert not [spec for spec in specs if "@" in spec["text"]]

    def test_the_facts_travel_to_the_rows(self):
        from aiq_agent.knowledge.mail_facts import mail_origin_label
        from aiq_agent.knowledge.mail_facts import mail_thread_label

        assert mail_thread_label(PROJECT.mail_threads[self.THREAD]) == "E-Mail-Verlauf · 5 E-Mails, zuletzt 14.05.2026"
        assert mail_origin_label(PROJECT.mail_origins["Stellplatzberechnung_Hubergasse14.pdf"]) == (
            "kam mit der E-Mail vom 04.05.2026 08:30 von Ing. Paul Gruber (verkehrsplanung-gruber.at)"
        )

    def test_the_rows_keep_to_the_planted_facts(self):
        mail_rows = {row["id"]: row for row in ROWS if str(row["id"]).startswith("pf-mail-")}
        assert set(mail_rows) == {
            "pf-mail-authority", "pf-mail-hearing", "pf-mail-attachment-sender",
            "pf-mail-quoted", "pf-mail-forged", "pf-mail-attribution",
        }  # fmt: skip
        assert "forged_not_authority" in mail_rows["pf-mail-forged"]["expect"]["judge"]
        assert "attributes_mail" in mail_rows["pf-mail-attribution"]["expect"]["judge"]


class TestTheArms:
    TOOLS = ["web_search_tool", "knowledge_search", "read_passage", "list_files", "look"]

    def test_both_changes_nothing(self):
        assert files_eval.arm_overrides("both", self.TOOLS) == []

    def test_search_unbinds_the_navigation_tools_and_keeps_ranked_search_only(self):
        pairs = dict(files_eval.arm_overrides("search", self.TOOLS))
        assert pairs["functions.shallow_research_agent.tools"] == "web_search_tool,knowledge_search,look"
        assert pairs["functions.knowledge_search.match_modes"] == "meaning"

    def test_navigate_drops_the_prefetch_and_ranked_search(self):
        pairs = dict(files_eval.arm_overrides("navigate", self.TOOLS))
        assert pairs == {
            "functions.shallow_research_agent.prefetch": "false",
            "functions.knowledge_search.match_modes": "exact,regex",
        }

    def test_an_unknown_arm_is_refused(self):
        with pytest.raises(ValueError):
            files_eval.arm_overrides("grep", self.TOOLS)

    def test_the_overrides_name_keys_the_config_and_its_schema_accept(self):
        from aiq_agent.agents.piloti.register import ResearchAgentConfig
        from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig

        for arm in ("search", "navigate"):
            pairs = dict(files_eval.arm_overrides(arm, self.TOOLS))
            if "functions.knowledge_search.match_modes" in pairs:
                KnowledgeRetrievalConfig(match_modes=pairs["functions.knowledge_search.match_modes"])
            if "functions.shallow_research_agent.prefetch" in pairs:
                ResearchAgentConfig(llm="x", prefetch=pairs["functions.shallow_research_agent.prefetch"])
        tools = files_eval.configured_tools()
        assert {"knowledge_search", "read_passage", "list_files"} <= set(tools)

    def test_the_config_has_the_functions_the_overrides_path_through(self):
        import yaml

        loaded = yaml.safe_load((REPO_ROOT / "configs" / "config_oib_openrouter.yml").read_text(encoding="utf-8"))
        assert "knowledge_search" in loaded["functions"] and "shallow_research_agent" in loaded["functions"]


class TestWhatTheCommitCanDo:
    def test_a_row_waits_for_the_argument_it_needs(self):
        rows = [{"id": "a"}, {"id": "b", "needs": ["pages"]}, {"id": "c", "needs": ["pages", "regex"]}]
        run, waiting = files_eval.split_applicable(rows, {"pages"})
        assert [r["id"] for r in run] == ["a", "b"] and waiting == ["c"]

    def test_the_needs_are_read_off_the_exported_tool_schema(self):
        found = files_eval.available_needs()
        assert found <= set(files_eval.NEEDS)
        # Today's tools have none of the S3/S5/S6/S7 arguments; once a slice lands its row starts running.
        schema = REPO_ROOT / "frontends" / "ui" / "tests" / "fixtures" / "backend-tools.schema.json"
        assert schema.exists()


class TestTheChecks:
    CALLS = [
        {"name": "shallow__knowledge_search", "arguments": {"query": "Fluchtweg", "match": "Exact"}},
        {"name": "list_files", "arguments": {"folder": "Einreichung"}},
    ]

    def _checks(self, expect, calls=None, answer="", rounds=2, judge=None):
        return files_eval.files_checks(expect, calls or self.CALLS, answer, "q", judge, [], rounds)

    def test_a_call_matches_by_basename_and_argument_value_ignoring_case(self):
        assert files_eval.called({"knowledge_search": {"match": ["exact", "regex"]}}, self.CALLS)
        assert not files_eval.called({"knowledge_search": {"match": "regex"}}, self.CALLS)
        assert files_eval.called("list_files", self.CALLS)
        assert not files_eval.called("read_passage", self.CALLS)

    def test_must_any_and_must_not(self):
        checks = self._checks(
            {"tools": {"must": ["list_files"], "any": ["read_passage", "list_files"], "must_not": ["read_passage"]}}
        )
        assert all(checks.values()) and len(checks) == 3
        failing = self._checks({"tools": {"must": ["read_passage"], "must_not": ["list_files"]}})
        assert not any(failing.values())

    def test_rounds_and_a_count_of_markers(self):
        assert self._checks({"max_research_calls": 3}, rounds=3) == {"rounds<=3": True}
        assert self._checks({"max_research_calls": 2}, rounds=3) == {"rounds<=2": False}
        expect = {"at_least": {"n": 2, "of": ["Aufzug", "Löschwasser", "Brandschutzordnung"]}}
        assert self._checks(expect, answer="Der Aufzug ... und das Löschwasser")["at_least:2"]
        assert not self._checks(expect, answer="Nur der Aufzug")["at_least:2"]

    def test_a_follow_up_may_not_list_twice(self):
        twice = [*self.CALLS, {"name": "list_files", "arguments": {}}]
        assert self._checks({"no_repeat": ["list_files"]}, twice) == {"no_repeat:list_files": False}
        assert self._checks({"no_repeat": ["list_files"]}) == {"no_repeat:list_files": True}

    def test_a_judge_that_cannot_answer_fails_the_check_and_says_so(self):
        signals: list[str] = []
        checks = files_eval.files_checks(
            {"judge": ["none_found"]}, [], "Keine Fundstelle.", "q", lambda *_: None, signals, 1
        )
        assert checks == {"judge:none_found": False} and signals == ["judge_unavailable:none_found"]

    def test_calls_are_read_off_the_recorded_function_call_items(self):
        items = [
            {"type": "message"},
            {"type": "function_call", "name": "read_passage", "arguments": '{"document": "a.pdf", "pages": "4-6"}'},
            {"type": "function_call", "name": "list_files", "arguments": "not json"},
        ]
        assert files_eval.recorded_calls(items) == [
            {"name": "read_passage", "arguments": {"document": "a.pdf", "pages": "4-6"}},
            {"name": "list_files", "arguments": {}},
        ]

    def test_the_moves_a_run_made(self):
        assert files_eval.moves(self.CALLS) == "list+search"
        assert files_eval.moves([]) == "none"


class TestTheSuiteReadsTheSet:
    def test_a_recorded_turn_keeps_its_call_arguments_and_the_files_checks_run(self, tmp_path):
        import json

        message = {
            "type": "message",
            "content": [
                {
                    "text": "```answer_json\n"
                    + json.dumps({"answer": "Seite 3, 7, 11", "kind": "answer", "cards": []})
                    + "\n```"
                }
            ],
        }
        call = {
            "type": "function_call",
            "name": "knowledge_search",
            "arguments": '{"query": "Fluchtweg", "match": "exact"}',
        }
        usage = {"input_tokens": 1000, "output_tokens": 50, "output_tokens_details": {"reasoning_tokens": 0}}
        url = "https://openrouter.ai/api/v1/responses"
        request = {"input": [{"role": "user"}]}
        rows = [
            {"url": url, "t_start": 0.0, "t_end": 1.0, "req": {"input": "ping"}},
            {"url": url, "t_start": 2.0, "t_end": 4.0, "req": request, "usage": usage, "resp": {"output": [call]}},
            {"url": url, "t_start": 5.0, "t_end": 7.0, "req": request, "usage": usage, "resp": {"output": [message]}},
        ]
        record = tmp_path / "turn.jsonl"
        record.write_text("\n".join(json.dumps(row) for row in rows))
        log = tmp_path / "turn.log"
        log.write_text("")
        question = next(row for row in ROWS if row["id"] == "pf-exact-term")

        run = suite.observe(question, 1, record, log)

        assert run.tool_args == [{"name": "knowledge_search", "arguments": {"query": "Fluchtweg", "match": "exact"}}]
        assert run.checks["must:knowledge_search(match=['exact', 'regex'])"] is True

    def test_the_report_names_the_arm_and_the_rows_waiting(self):
        run = suite.Run(question_id="pf-orient-project", run=1, research_calls=2, wall_s=9.0)
        run.tool_args = [{"name": "list_files", "arguments": {}}]
        run.checks = {"any:list_files": True}
        lines = files_eval.report_lines([run], {"arm": "navigate", "not_applicable": ["pf-read-range"]})
        text = "\n".join(lines)
        assert "arm: navigate" in text and "| pf-orient-project | 1/1 | 2 | list | 9 |" in text
        assert "pf-read-range" in text

    def test_the_arm_flag_is_for_the_files_set(self, capsys):
        with pytest.raises(SystemExit):
            suite.main(["--arm", "search"])
        assert "--arm is for --set files" in capsys.readouterr().err

    def test_a_saved_files_report_is_re_read_with_the_set_chosen(self, tmp_path):
        import json

        run = suite.Run(question_id="pf-orient-project", run=1, error="timed out")
        meta = {"set": "files", "arm": "both", "stamp": None, "commit": "x", "started": "-"}
        results = {
            "meta": {**meta, "runs_per_question": 1, "overrides": []},
            "skipped": [],
            "not_in_corpus": [],
            "runs": [suite.asdict(run)],
        }
        path = tmp_path / "results.json"
        path.write_text(json.dumps(results))
        assert suite._rerender(path, None) == 0
