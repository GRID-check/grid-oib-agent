"""`scripts/feedback_to_cases.py`: a down-vote becomes a draft case, and nothing private rides along."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("scripts.feedback_to_cases", REPO_ROOT / "scripts/feedback_to_cases.py")
convert = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = convert
_spec.loader.exec_module(convert)

HEADER = "created_at,organization_id,conversation_id,message_id,verdict,reason,topics,question,answer,expected_answer\n"
CSV = (
    HEADER + "2026-10-06T08:00:00Z,org-SECRET,conv-SECRET,msg-1,down,inaccurate,oib4,Wie hoch muss das Geländer sein?,"
    'Die Antwort,"Ab 12 m Absturzhöhe 1,10 m"\n'
    + "2026-10-06T09:00:00Z,org-SECRET,conv-SECRET,msg-2,down,other,,,Antwort ohne Frage,Erwartet\n"
    + "2026-10-06T10:00:00Z,org-SECRET,conv-SECRET,msg-3,up,,,Gute Frage?,Antwort,Erwartet\n"
)


def _run(tmp_path, text):
    source, out = tmp_path / "feedback.csv", tmp_path / "draft.yaml"
    source.write_text(text, encoding="utf-8")
    assert convert.main([str(source), "--out", str(out)]) == 0
    return out.read_text(encoding="utf-8")


def test_only_a_down_vote_with_a_question_and_an_expectation_is_a_case(tmp_path):
    cases = yaml.safe_load(_run(tmp_path, CSV))["questions"]
    assert [c["question"] for c in cases] == ["Wie hoch muss das Geländer sein?"]
    case = cases[0]
    assert (case["family"], case["punkt"], case["kind"]) == (None, None, "walkthrough")
    assert case["draft"] == {
        "expected_answer": "Ab 12 m Absturzhöhe 1,10 m",
        "reason": "inaccurate",
        "reported": "2026-10-06",
    }
    assert case["id"].startswith("wie-hoch-muss-das-gelander-sein-")


def test_no_tenant_identifier_or_answer_text_reaches_the_draft(tmp_path):
    text = _run(tmp_path, CSV)
    for private in ("org-SECRET", "conv-SECRET", "msg-1", "Die Antwort"):
        assert private not in text


def test_a_csv_without_the_expected_answer_column_gives_no_cases(tmp_path):
    old = "created_at,organization_id,conversation_id,message_id,verdict,reason,topics,question,answer\n"
    assert yaml.safe_load(_run(tmp_path, old + "t,o,c,m,down,r,,Frage?,A\n"))["questions"] == []


def test_the_exports_bom_does_not_hide_the_first_column(tmp_path):
    """The export starts with a BOM for Excel; read as plain utf-8 it glued itself to `created_at`."""
    cases = yaml.safe_load(_run(tmp_path, "﻿" + CSV))["questions"]
    assert cases[0]["draft"]["reported"] == "2026-10-06"


def test_the_exports_formula_apostrophe_is_taken_back_off(tmp_path):
    """A cell the export neutralised (`'-...`) reads back as what the user wrote."""
    row = "2026-10-06T08:00:00Z,o,c,m,down,other,,'=Frage?,A,\"'- 1,10 m\"\n"
    case = yaml.safe_load(_run(tmp_path, HEADER + row))["questions"][0]
    assert (case["question"], case["draft"]["expected_answer"]) == ("=Frage?", "- 1,10 m")
