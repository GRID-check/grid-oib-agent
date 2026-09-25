#!/usr/bin/env python3
"""Decision eval for the uses off the reader's path: ingestion tags and the reflection pre-check.

WHY THIS EXISTS
---------------
ADR-0064's uses 4 and 5 moved two generative calls onto the decision model:
the tags stored with every upload, and whether memory reflection runs after a
project turn. Their thresholds (``DISCIPLINE_THRESHOLD``,
``REFLECTION_SKIP_THRESHOLD``) were set from one run over hand-labelled German
sets, committed as ``tests/fixtures/decisions/*.yaml``. This script is that
run, so a threshold or a criterion is changed against a number and not a guess.

THE FLOORS
----------
- tags: the decided type is a labelled type on every row, and no discipline
  is tagged that the row does not carry.
- reflection: no row labelled ``durable`` falls below the skip threshold
  (a wrong skip loses a memory row).

IT NEEDS A KEY, NOT A BACKEND
-----------------------------
``OPENROUTER_API_KEY`` (or ``GRID_DECISIONS_API_KEY``); well under a cent for
both sets. Exit 0 when the floors hold, 1 when they do not.

USAGE
-----
    python scripts/decision_eval_offpath.py

THE LAST RUN
------------
2026-09-25: tags 12/12 types, disciplines 5 of 8 labelled with none false at
0.5; reflection: durable rows 0.45-0.94, seven of nine others 0.03-0.16.
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
from aiq_agent.memory import reflection  # noqa: E402

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


def eval_reflection() -> bool:
    import asyncio

    rows = yaml.safe_load((FIXTURES / "reflection_exchanges.yaml").read_text(encoding="utf-8"))

    async def run() -> list[float | None]:
        return [await reflection.durable_probability(r["question"], r["answer"], organization_id=None) for r in rows]

    probabilities = asyncio.run(run())
    threshold = reflection.REFLECTION_SKIP_THRESHOLD
    lost = skipped = 0
    for row, p in zip(rows, probabilities):
        mark = "skip" if p is not None and p < threshold else "run"
        lost += row["durable"] and mark == "skip"
        skipped += (not row["durable"]) and mark == "skip"
        print(f"  durable={row['durable']!s:5s} p={p} {mark:4s} {row['question'][:60]}")
    others = sum(not r["durable"] for r in rows)
    print(f"reflection: skipped {skipped}/{others} non-durable, lost {lost} durable (threshold {threshold})")
    return lost == 0 and None not in probabilities


def main() -> int:
    os.environ.setdefault("OPENROUTER_API_KEY", os.environ.get("OPENROUTER_KEY", ""))
    # Not a request: no organization, so no ZDR policy to look up over HTTP.
    with patch.object(decisions, "_zdr_only_blocking", return_value=False):
        ok = eval_tags()
        ok = eval_reflection() and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
