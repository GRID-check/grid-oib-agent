#!/usr/bin/env python3

"""Turn down-voted answers from the feedback CSV export into DRAFT answer-suite cases.

Why this exists
---------------

A user's down-vote is evidence that an answer failed. The answer suite
(`task be:eval:answer-suite`, cases in `tests/fixtures/herleitung/loop_eval_questions.yaml`)
is where a failure stays caught. This script is the first step between the two.

It reads the platform's feedback export as CSV (Plattform → Antwortqualität →
Bewertungen → Exportieren → "Als CSV", or `GET
/api/platform/answer-feedback/export?format=csv`; the columns are listed in
`docs/technical-reference/answer-feedback-export.md`). Of those it reads
`verdict`, `question`, `expected_answer`, `reason` and `voted_at`, falling back
to `created_at`, the name an export from before the column rework used. It
writes a draft file of cases for a human to review. It never touches the
golden set: what a user says the answer should have been is a claim, and the
suite's rule is that an expectation is read off the corpus, never taken on
trust. A draft therefore carries the claim as
`draft.expected_answer` and leaves `family`, `punkt` and `expect` for the
reviewer to fill from the corpus.

The export already leaves out every vote on a conversation that drew on a
folder with restricted access (ADR-0087), so no such question or expectation
reaches a draft.

Only a down-vote with a question and an `expected_answer` becomes a case. The
organisation and conversation ids, the message id and the answer text are never
written: a case lives in a public fixture and the answer was shown to one
tenant.

Usage
-----

::

    .venv/bin/python scripts/feedback_to_cases.py feedback.csv --out /tmp/draft_cases.yaml
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import yaml

DOWN_VERDICTS = {"down", "downvote", "down_vote", "negative", "thumbs_down", "-1"}


def slug(question: str) -> str:
    """A stable id: the first words of the question plus a short hash, so two questions never collide."""
    folded = question.casefold().translate(str.maketrans("äöüß", "aous"))
    words = re.sub(r"[^a-z0-9]+", "-", folded).strip("-").split("-")[:6]
    digest = hashlib.sha256(question.strip().encode("utf-8")).hexdigest()[:6]
    return "-".join([*words, digest]).strip("-")


#: The export prefixes a cell starting with one of these with an apostrophe, so a
#: spreadsheet opens it as text (``frontends/ui/src/lib/text/csv-cell.ts``).
_FORMULA_LEAD = ("=", "+", "-", "@", "\t", "\r")


def cell(row: dict[str, str], column: str) -> str:
    """A column's text, stripped, with the export's formula-neutralising apostrophe removed."""
    value = (row.get(column) or "").strip()
    if value.startswith("'") and value[1:].startswith(_FORMULA_LEAD):
        return value[1:]
    return value


def reported_on(row: dict[str, str]) -> str | None:
    """The day the vote was cast: `voted_at` in the current export, `created_at` in an older one."""
    stamp = (row.get("voted_at") or row.get("created_at") or "").strip()
    return stamp[:10] or None


def draft_cases(rows: Iterable[dict[str, str]]) -> list[dict[str, Any]]:
    """One draft per down-vote that has a question and an expected answer; duplicates by question dropped."""
    cases: dict[str, dict[str, Any]] = {}
    for row in rows:
        question = cell(row, "question")
        expected = cell(row, "expected_answer")
        if (row.get("verdict") or "").strip().casefold() not in DOWN_VERDICTS or not question or not expected:
            continue
        case_id = slug(question)
        cases.setdefault(
            case_id,
            {
                "id": case_id,
                "question": question,
                "family": None,
                "punkt": None,
                "kind": "walkthrough",
                "draft": {
                    "expected_answer": expected,
                    "reason": (row.get("reason") or "").strip() or None,
                    "reported": reported_on(row),
                },
            },
        )
    return list(cases.values())


def render(cases: list[dict[str, Any]]) -> str:
    header = (
        "# DRAFT answer-suite cases from down-voted answers. Not part of the golden set.\n"
        "# `draft.expected_answer` is what the user said the answer should be: a claim.\n"
        "# Verify it against the corpus, then fill `family`, `punkt` and `expect` (values read\n"
        "# off the PDF), drop `draft`, add the comment `Source: answer feedback <date>`, and move\n"
        "# the case into tests/fixtures/herleitung/loop_eval_questions.yaml.\n"
    )
    return header + yaml.safe_dump({"questions": cases}, allow_unicode=True, sort_keys=False, width=100)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("csv", type=Path, help="the feedback export")
    parser.add_argument("--out", type=Path, required=True, help="where to write the draft cases")
    args = parser.parse_args(argv)
    # utf-8-sig: the export starts with a BOM (for Excel), which plain utf-8 would
    # leave glued to the first header, so the first column never matched.
    with args.csv.open(encoding="utf-8-sig", newline="") as handle:
        cases = draft_cases(csv.DictReader(handle))
    args.out.write_text(render(cases), encoding="utf-8")
    print(f"{len(cases)} draft case(s) written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
