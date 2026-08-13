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
