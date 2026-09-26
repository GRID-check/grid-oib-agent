#!/usr/bin/env python3
"""Decision eval for the uses off the reader's path (ADR-0064, uses 4, 5, 7, 8 and 9).

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
- Dokumentart: every suggestion offered is the labelled class (a wrong one
  is offered to a person, who may accept it).
- feedback causes: at least 14 of the 16 labelled down-votes filed under
  their cause (an operator's count, so a miss skews a number, not an answer).
- memory supersede: no finding retires an entry it does not correct (a wrong
  retirement loses a fact); a missed correction is reported, not failed.

IT NEEDS A KEY, NOT A BACKEND
-----------------------------
``OPENROUTER_API_KEY`` (or ``GRID_DECISIONS_API_KEY``); well under a cent for
both sets. Exit 0 when the floors hold, 1 when they do not.

USAGE
-----
    python scripts/decision_eval_offpath.py

THE LAST RUN
------------
2026-09-25: tags 12/12 types, disciplines 4 of 8 labelled with none false at
0.7 (clear disciplines 0.96-0.98, the highest false one 0.47); reflection:
durable rows 0.45-0.94, seven of nine others 0.03-0.16; memory supersede 8/8
corrections, no wrong retirement; Dokumentart 10/10 offered, none wrong;
feedback causes 16/16.
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


def eval_supersede() -> bool:
    import asyncio

    from aiq_agent.memory import supersede

    data = yaml.safe_load((FIXTURES / "memory_supersede.yaml").read_text(encoding="utf-8"))
    digest = "\n".join(f'- [constraint | high | agent] "{entry}"' for entry in data["memory"])

    async def run() -> list[str | None]:
        return [
            await supersede.decided_supersedes(row["finding"], digest, organization_id=None) for row in data["findings"]
        ]

    wrong = found = 0
    for row, quote in zip(data["findings"], asyncio.run(run())):
        expected = row["supersedes"]
        wrong += quote is not None and quote != expected
        found += quote is not None and quote == expected
        print(f"  {'T' if expected else 'N'} -> {quote!s:45.45s} | {row['finding'][:50]}")
    corrections = sum(1 for row in data["findings"] if row["supersedes"])
    print(f"supersede: {found}/{corrections} corrections found, {wrong} wrong retirements")
    return wrong == 0


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
        ok = eval_reflection() and ok
        ok = eval_supersede() and ok
        ok = eval_doc_class() and ok
        ok = eval_feedback_causes() and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
