"""The backlog the spatial surface writes about itself.

The ledger is only useful if it holds ONE kind of row: „a caller asked for a
name this surface does not have". Everything else the engine refuses is either
a finding about the architect's export or a mistake the caller can fix in the
same turn, and either of those in here would bury the real entries under
thousands of rows nobody reads.

So most of this file is about what must NOT be written.
"""

from __future__ import annotations

import json

import pytest

from aiq_agent.agents.bim import capability_gaps as cg
from aiq_agent.agents.bim.measure_register import _build_call


@pytest.fixture(autouse=True)
def _ledger(tmp_path, monkeypatch):
    path = tmp_path / "gaps.jsonl"
    monkeypatch.setenv("AIQ_CAPABILITY_GAP_LOG", str(path))
    yield path


class TestWhatCountsAsAGap:
    """A name in no vocabulary — and nothing else."""

    def test_a_measure_that_does_not_exist_is_recorded(self, _ledger):
        answer = _build_call(operation="measure", global_id="g1", measure="wandstaerke")
        assert isinstance(answer, str) and "does not exist" in answer

        rows = cg.read_gaps(_ledger)
        assert [(r["field"], r["askedFor"]) for r in rows] == [("measure", "wandstaerke")]
        # The closed set travels with the row: „what did we offer instead" is
        # the first question anyone triaging this asks.
        assert "clearHeight" in rows[0]["known"]

    def test_an_operation_the_model_invented_is_recorded(self, _ledger):
        _build_call(operation="schallschutz")
        assert [r["askedFor"] for r in cg.read_gaps(_ledger)] == ["schallschutz"]

    def test_each_grouped_aspect_has_its_own_field(self, _ledger):
        _build_call(operation="envelope", kind="uValue")
        _build_call(operation="fire", kind="rauchabschnitt")
        fields = {r["field"] for r in cg.read_gaps(_ledger)}
        assert fields == {"envelope.kind", "fire.kind"}


class TestWhatMustNeverBeRecorded:
    """The three refusals that are not our gap.

    Getting this wrong does not produce a wrong answer — it produces a ledger
    with ten thousand rows in it, which is the same as having no ledger.
    """

    def test_a_call_that_works_writes_nothing(self, _ledger):
        assert _build_call(operation="measure", global_id="g1", measure="clearHeight")[0] == "measure"
        assert cg.read_gaps(_ledger) == []

    def test_a_missing_argument_is_the_callers_mistake_not_our_gap(self, _ledger):
        """No `global_id` is a mistake the caller corrects in the same turn. The
        surface HAS the operator; nobody needs to build anything."""
        answer = _build_call(operation="measure", measure="clearHeight")
        assert isinstance(answer, str) and "needs a global_id" in answer
        assert cg.read_gaps(_ledger) == []

    def test_an_export_that_cannot_answer_is_a_finding_about_the_file(self, _ledger):
        """`decidable: false` never reaches this module.

        It is the engine's way of saying the question was well formed and THIS
        FILE cannot answer it — a finding about the architect's export, with a
        CAD remedy attached. Recording it as a missing feature would file a bug
        against ourselves for someone else's model.
        """
        cg.record_gap(surface="ifc_measure", field="measure", asked_for="")
        assert cg.read_gaps(_ledger) == []


class TestTheRowKeepsTheVocabularyAndNotTheBuilding:
    """ADR-0045's rule, kept here too even though nothing is sent anywhere.

    `_trace` refuses to echo model-authored text to Langfuse and is right to.
    This ledger keeps that text — it is the whole point — so the discipline has
    to move to the other axis: the VALUE is kept, the BUILDING never is.
    """

    def test_no_global_id_or_measured_value_can_reach_a_row(self, _ledger):
        _build_call(operation="measure", global_id="3cUkl32yn9qRSPvBJVyWcE", measure="wandstaerke")
        text = json.dumps(cg.read_gaps(_ledger), ensure_ascii=False)
        assert "3cUkl32yn9qRSPvBJVyWcE" not in text
        assert set(cg.read_gaps(_ledger)[0]) == {"at", "surface", "field", "askedFor", "known"}

    def test_a_pasted_paragraph_cannot_fill_the_disk(self, _ledger):
        cg.record_gap(surface="ifc_measure", field="measure", asked_for="x" * 5000)
        assert len(cg.read_gaps(_ledger)[0]["askedFor"]) == cg.MAX_VALUE_CHARS

    def test_a_value_with_newlines_stays_one_row(self, _ledger):
        """One JSON object per line is the format; a value carrying a newline
        would still parse and would defeat `grep` for whoever reads this."""
        cg.record_gap(surface="ifc_measure", field="measure", asked_for="wand\nstaerke\r\n")
        assert _ledger.read_text(encoding="utf-8").count("\n") == 1
        assert cg.read_gaps(_ledger)[0]["askedFor"] == "wandstaerke"

    def test_the_ledger_stops_growing_at_the_cap(self, _ledger):
        """An agent retrying a name that does not exist can write the same row
        hundreds of times a minute. The ledger is advisory; the disk is not."""
        _ledger.write_text("x" * (cg.MAX_BYTES + 1), encoding="utf-8")
        cg.record_gap(surface="ifc_measure", field="measure", asked_for="wandstaerke")
        assert cg.read_gaps(_ledger) == []


class TestTheReportIsRankedByWhatToBuildNext:
    def test_the_most_wanted_thing_comes_first(self, _ledger):
        for _ in range(3):
            _build_call(operation="measure", global_id="g1", measure="wandstaerke")
        _build_call(operation="measure", global_id="g1", measure="uWert")

        ranked = cg.summarise(_ledger)
        assert [(r["askedFor"], r["count"]) for r in ranked] == [("wandstaerke", 3), ("uWert", 1)]

        report = cg.render_report(_ledger)
        assert report.index("wandstaerke") < report.index("uWert")
        # And it reads as a wish list, not a specification: the values came out
        # of a language model.
        assert "Wunschliste" in report

    def test_an_empty_ledger_says_so_rather_than_printing_a_bare_table(self, _ledger):
        assert "Keine Lücken erfasst" in cg.render_report(_ledger)


class TestWritingIsNeverAllowedToBreakAnAnswer:
    def test_an_unwritable_ledger_does_not_fail_the_call(self, monkeypatch, tmp_path):
        """A full disk or a read-only mount must not turn a working measurement
        into an error. The architect's answer is the product; this file is a
        convenience for us."""
        monkeypatch.setenv("AIQ_CAPABILITY_GAP_LOG", str(tmp_path / "nope" / "gaps.jsonl"))

        def _explode(*_args, **_kwargs):
            raise OSError("read-only file system")

        monkeypatch.setattr(cg.Path, "mkdir", _explode)
        answer = _build_call(operation="measure", global_id="g1", measure="wandstaerke")
        assert isinstance(answer, str) and "does not exist" in answer

    def test_a_corrupt_line_is_skipped_rather_than_raised(self, _ledger):
        _ledger.write_text('{"askedFor": "gut"}\nnot json at all\n', encoding="utf-8")
        assert [r["askedFor"] for r in cg.read_gaps(_ledger)] == ["gut"]


class TestTheLedgerIsNotSomewhereAnyoneElseCanReachIt:
    """It started as a predictable name in world-writable `/tmp`.

    Two things follow from that, and neither needs a clever attacker: any local
    user can pre-create the exact path as a FILE and read the model-authored
    requests that land in it, or as a SYMLINK and have this process append JSON
    to something else the service account can write.
    """

    def test_the_default_is_not_a_shared_directory(self, monkeypatch, tmp_path):
        monkeypatch.delenv("AIQ_CAPABILITY_GAP_LOG", raising=False)
        monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
        assert cg.default_path() == tmp_path / "state" / "aiq" / "capability-gaps.jsonl"

    def test_the_env_override_still_wins_because_an_operator_chose_it(self, monkeypatch, tmp_path):
        """The variable is a deployment decision, not something a request can
        influence — no value in a row ever reaches it."""
        monkeypatch.setenv("AIQ_CAPABILITY_GAP_LOG", str(tmp_path / "chosen.jsonl"))
        assert cg.ledger_path() == tmp_path / "chosen.jsonl"

    def test_a_symlink_on_the_path_is_refused_rather_than_followed(self, monkeypatch, tmp_path):
        victim = tmp_path / "someone-elses-file"
        victim.write_text("important\n", encoding="utf-8")
        link = tmp_path / "gaps.jsonl"
        link.symlink_to(victim)
        monkeypatch.setenv("AIQ_CAPABILITY_GAP_LOG", str(link))

        cg.record_gap(surface="ifc_measure", field="measure", asked_for="wandstaerke")

        # The write went nowhere, and it did not raise either: a ledger that
        # cannot be written must never turn a working measurement into an error.
        assert victim.read_text(encoding="utf-8") == "important\n"

    def test_the_file_is_not_readable_by_other_users(self, monkeypatch, tmp_path):
        target = tmp_path / "nested" / "gaps.jsonl"
        monkeypatch.setenv("AIQ_CAPABILITY_GAP_LOG", str(target))

        cg.record_gap(surface="ifc_measure", field="measure", asked_for="wandstaerke")

        assert target.exists()
        assert target.stat().st_mode & 0o077 == 0, "group/other can read the model-authored values"
        assert target.parent.stat().st_mode & 0o077 == 0, "the directory is browsable by others"


class TestAMissIsAnErrorSoItBecomesAnIssue:
    """Runtime logs ship to the OTLP collector and an ERROR there becomes an
    issue. A missing tool should be one — nobody reads a JSONL file on a
    schedule.

    Everything here is about the three things that stop it being a spam
    generator. The error IS the issue, so „logged once more" means „one more
    issue".
    """

    @pytest.fixture(autouse=True)
    def _fresh(self):
        cg.reset_escalations_for_tests()
        yield
        cg.reset_escalations_for_tests()

    def test_a_miss_is_logged_at_error_with_the_fields_an_issue_needs(self, caplog, _ledger):
        with caplog.at_level("ERROR", logger=cg.logger.name):
            _build_call(operation="measure", global_id="g1", measure="wandstaerke")

        record = next(r for r in caplog.records if getattr(r, "ifc_capability_gap", False))
        assert record.levelname == "ERROR"
        assert record.ifc_gap_field == "measure"
        assert record.ifc_gap_asked_for == "wandstaerke"
        assert record.ifc_gap_surface == "ifc_measure"
        # The closed set travels, so whoever picks the issue up can see what was
        # offered instead without opening the repository.
        assert "clearHeight" in record.ifc_gap_known

    def test_the_same_miss_is_escalated_once_however_often_it_repeats(self, caplog, _ledger):
        """The retry loop. An agent that keeps calling a name that does not
        exist must produce ONE issue, not one per attempt."""
        with caplog.at_level("ERROR", logger=cg.logger.name):
            for _ in range(25):
                _build_call(operation="measure", global_id="g1", measure="wandstaerke")

        escalated = [r for r in caplog.records if getattr(r, "ifc_capability_gap", False)]
        assert len(escalated) == 1
        # …while the ledger still counts every one of them, because that count
        # is what ranks the backlog.
        assert cg.summarise(_ledger)[0]["count"] == 25

    def test_a_different_miss_is_still_escalated(self, caplog, _ledger):
        with caplog.at_level("ERROR", logger=cg.logger.name):
            _build_call(operation="measure", global_id="g1", measure="wandstaerke")
            _build_call(operation="measure", global_id="g1", measure="uWert")
        assert len([r for r in caplog.records if getattr(r, "ifc_capability_gap", False)]) == 2

    def test_a_model_inventing_a_new_word_every_turn_cannot_page_all_night(self, caplog, _ledger):
        """The dedup above keys on the value, so a model that never repeats
        itself slips straight past it. Past the ceiling the ledger keeps
        recording and the alerting goes quiet — that way round on purpose."""
        with caplog.at_level("ERROR", logger=cg.logger.name):
            for index in range(cg.MAX_ESCALATIONS + 20):
                _build_call(operation="measure", global_id="g1", measure=f"erfundenes_mass_{index}")

        escalated = [r for r in caplog.records if getattr(r, "ifc_capability_gap", False)]
        assert len(escalated) == cg.MAX_ESCALATIONS
        assert len(cg.read_gaps(_ledger)) == cg.MAX_ESCALATIONS + 20

    def test_only_a_name_shaped_value_leaves_the_process(self, caplog, _ledger):
        """ADR-0045 keeps model-authored text out of external observability, and
        `_trace` honours it by recording an invented operation as `unknown`.
        This is the narrower compromise: an identifier is what makes the issue
        actionable and is not building data; anything else is a paste, and the
        real text stays in the local ledger."""
        pasted = "hier ist der ganze Raum: 3cUkl32yn9qRSPvBJVyWcE, 15.42 m², Bedroom @ 2.47 m"
        with caplog.at_level("ERROR", logger=cg.logger.name):
            cg.record_gap(surface="ifc_measure", field="measure", asked_for=pasted)

        record = next(r for r in caplog.records if getattr(r, "ifc_capability_gap", False))
        assert record.ifc_gap_asked_for == cg.UNEXPORTABLE
        assert "3cUkl32yn9qRSPvBJVyWcE" not in json.dumps(record.__dict__, default=str)
        # …and the full text is still on disk, where triage can read it.
        assert cg.read_gaps(_ledger)[0]["askedFor"].startswith("hier ist der ganze Raum")

    def test_a_german_measure_name_is_exported_as_written(self, caplog, _ledger):
        with caplog.at_level("ERROR", logger=cg.logger.name):
            cg.record_gap(surface="ifc_measure", field="measure", asked_for="lichte Raumhöhe-2")
        record = next(r for r in caplog.records if getattr(r, "ifc_capability_gap", False))
        assert record.ifc_gap_asked_for == "lichte Raumhöhe-2"

    def test_a_broken_logger_does_not_break_the_answer(self, monkeypatch, _ledger):
        """Same rule as the ledger's: escalation is for us, the architect's
        answer is the product."""

        def _explode(*_args, **_kwargs):
            raise RuntimeError("the collector is on fire")

        monkeypatch.setattr(cg.logger, "error", _explode)
        answer = _build_call(operation="measure", global_id="g1", measure="wandstaerke")
        assert isinstance(answer, str) and "does not exist" in answer
        assert cg.read_gaps(_ledger)[0]["askedFor"] == "wandstaerke"
