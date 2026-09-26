#!/usr/bin/env python3
"""Decision eval for the annotations off the reader's path (ADR-0064, uses 4, 8 and 9).

WHY THIS EXISTS
---------------
ADR-0064's uses 4, 8 and 9 put the decision model on three annotations: the
tags stored with every upload, the Dokumentart offered for a base-corpus file,
and the cause a down-vote is filed under. Their thresholds were set from runs
over hand-labelled German sets, committed as ``tests/fixtures/decisions/*.yaml``.
This script is that run, so a threshold or a criterion is changed against a
number and not a guess.

THESE ARE TUNING SETS
---------------------
The criteria were written against these rows, so a pass here says the
wording still does what it was tuned to do, not that it generalises. That is
``decision_eval_holdout.py`` (``task be:eval:decisions:holdout``), on sets
written blind to the wording.

THE FLOORS
----------
- tags: the decided type is a labelled type on every row, and no discipline
  is tagged that the row does not carry.
- Dokumentart: every suggestion offered is the labelled class (a wrong one
  is offered to a person, who may accept it).
- feedback causes: at least 14 of the 16 labelled down-votes filed under
  their cause (an operator's count, so a miss skews a number, not an answer).

IT NEEDS A KEY, NOT A BACKEND
-----------------------------
``OPENROUTER_API_KEY`` (or ``GRID_DECISIONS_API_KEY``); well under a cent for
both sets. Exit 0 when the floors hold, 1 when they do not.

USAGE
-----
    python scripts/decision_eval_offpath.py

THE LAST RUN
------------
2026-09-26: tags 12/12 types, disciplines 4 of 8 labelled with none false at
0.8 (clear disciplines 0.96-0.98, the highest false one 0.47); Dokumentart
10/10 offered, none wrong; feedback causes 16/16.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aiq_agent.common import decisions  # noqa: E402
from aiq_agent.knowledge import document_classification as dc  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "decisions"


def eval_tags() -> bool:
    rows = yaml.safe_load((FIXTURES / "document_tags.yaml").read_text(encoding="utf-8"))
    types_right = discipline_hits = discipline_false = labelled = 0
    for row in rows:
        tags = dc.decide_document_tags(row["text"], row["file_name"]) or []
        got = set(tags) & set(dc.DISCIPLINE_TAGS)
        want = set(row["disciplines"])
        types_right += bool(set(tags) & set(row["types"]))
        discipline_hits += len(got & want)
        discipline_false += len(got - want)
        labelled += len(want)
        print(f"  {row['file_name']:34s} {tags}")
    print(f"tags: types {types_right}/{len(rows)}, disciplines {discipline_hits}/{labelled}, false {discipline_false}")
    return types_right == len(rows) and discipline_false == 0


def eval_doc_class() -> bool:
    rows = yaml.safe_load((FIXTURES / "doc_class.yaml").read_text(encoding="utf-8"))
    offered = wrong = 0
    for row in rows:
        suggestion = dc.suggest_doc_class(row["text"], row["file_name"])
        offered += suggestion is not None
        wrong += suggestion is not None and suggestion != row["doc_class"]
        print(f"  {row['file_name']:30s} want={row['doc_class']:16s} offered={suggestion}")
    expected = sum(1 for row in rows if row["doc_class"] != dc.DEFAULT_DOC_CLASS)
    print(f"doc_class: offered {offered}/{expected} non-default rows, {wrong} wrong")
    return wrong == 0


def eval_feedback_causes() -> bool:
    import asyncio
    from types import SimpleNamespace

    from aiq_agent.common import feedback_causes

    rows = yaml.safe_load((FIXTURES / "feedback_causes.yaml").read_text(encoding="utf-8"))
    samples = [SimpleNamespace(question=r["question"], reason=r["reason"], comment=r["comment"]) for r in rows]
    labels = asyncio.run(feedback_causes.label_causes(samples))
    right = sum(1 for row, label in zip(rows, labels) if label == row["cause"])
    for row, label in zip(rows, labels):
        print(f"  want={row['cause']:14s} got={label}")
    print(f"feedback causes: {right}/{len(rows)}")
    return right >= len(rows) - 2


def main() -> int:
    os.environ.setdefault("OPENROUTER_API_KEY", os.environ.get("OPENROUTER_KEY", ""))
    # Not a request: no organization, so no ZDR policy to look up over HTTP.
    with patch.object(decisions, "_zdr_only_blocking", return_value=False):
        ok = eval_tags()
        ok = eval_doc_class() and ok
        ok = eval_feedback_causes() and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
