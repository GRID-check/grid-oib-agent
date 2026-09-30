#!/usr/bin/env python3
"""Decision eval for the held-evidence decision (ADR-0064, use 10).

WHY THIS EXISTS
---------------
Use 10 asks the decision model whether the passages a conversation already
read, still in the transcript, hold what the new message asks. A confident yes
skips round 0 and tells the model to answer from them. Its threshold
(``held_evidence.HELD_THRESHOLD``) was set by analogy with the turn
decision's other prefetch gates, not measured; this script is the
measurement, over the hand-labelled rows in
``tests/fixtures/decisions/held_coverage.yaml``: repeats, rephrasings, and new
questions the held passages settle, against new subjects, Länder, classes and
values the passages do not state.

THE FLOORS
----------
- No row labelled ``held: false`` at or above the threshold. A false yes
  tells the model it holds an answer it does not; that is the error to pay
  for with recall.
- At least 60 % of the ``held: true`` rows at or above it. Below that the
  decision costs a call on every later turn for too little.
- Every row decided. An undecided row measured nothing: a "no" row that did
  not run may be the false yes the first floor is there to catch.
Anything under them: set ``held_evidence: false`` and say so in the PR.

A TUNING SET
------------
The criteria were written with these rows in view, so a pass says the wording
does what it was written to do, not that it generalises. A held-out set
written blind to the wording is the next step before the threshold moves.

IT NEEDS A KEY, NOT A BACKEND
-----------------------------
``OPENROUTER_API_KEY`` (or ``GRID_DECISIONS_API_KEY``); well under a cent.
Exit 0 when the floors hold, 1 when they do not.

USAGE
-----
    python scripts/decision_eval_held.py

THE LAST RUN
------------
None yet: the branch that introduced use 10 had no key.
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from aiq_agent.agents.piloti import held_evidence  # noqa: E402
from aiq_agent.common import decisions  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "decisions" / "held_coverage.yaml"
RECALL_FLOOR = 0.6
SWEEP = (0.5, 0.6, 0.7, 0.8, 0.9)


@dataclass(frozen=True)
class Scored:
    id: str
    held: bool
    p: float | None


@dataclass(frozen=True)
class Summary:
    threshold: float
    recall: float
    false_yes: int
    undecided: int

    @property
    def holds(self) -> bool:
        return self.false_yes == 0 and self.recall >= RECALL_FLOOR and self.undecided == 0


def summarise(scored: Sequence[Scored], threshold: float) -> Summary:
    """Recall on the held rows and false yeses on the rest, at one threshold. An undecided row is a no."""
    held = [s for s in scored if s.held]
    yes = [s for s in scored if s.p is not None and s.p >= threshold]
    recall = sum(1 for s in yes if s.held) / len(held) if held else 0.0
    return Summary(
        threshold=threshold,
        recall=recall,
        false_yes=sum(1 for s in yes if not s.held),
        undecided=sum(1 for s in scored if s.p is None),
    )


def _passages(rows: Sequence[dict]) -> tuple[held_evidence.HeldPassage, ...]:
    return tuple(
        held_evidence.HeldPassage(
            citation_key=row["citation"], source=row["source"], punkt=row.get("punkt"), text=row["text"]
        )
        for row in rows
    )


async def _score(rows: Sequence[dict]) -> list[Scored]:
    async def one(row: dict) -> Scored:
        coverage = await held_evidence.decide_held(row["message"], _passages(row["passages"]))
        return Scored(id=row["id"], held=bool(row["held"]), p=coverage.p if coverage else None)

    return list(await asyncio.gather(*(one(row) for row in rows)))


def main() -> int:
    os.environ.setdefault("OPENROUTER_API_KEY", os.environ.get("OPENROUTER_KEY", ""))
    rows = yaml.safe_load(FIXTURE.read_text(encoding="utf-8"))["rows"]
    # Not a request: no organization, so no ZDR policy to look up over HTTP.
    with patch.object(decisions, "_zdr_only_blocking", return_value=False):
        scored = asyncio.run(_score(rows))
    for row, s in zip(rows, scored):
        p = "  -  " if s.p is None else f"{s.p:.2f}"
        print(f"  {s.id} want={'yes' if s.held else 'no ':3s} p={p}  {row['message']}")
    for threshold in SWEEP:
        summary = summarise(scored, threshold)
        print(f"  at {threshold:.1f}: recall {summary.recall:.2f}, false yes {summary.false_yes}")
    result = summarise(scored, held_evidence.HELD_THRESHOLD)
    print(
        f"held evidence at {result.threshold}: recall {result.recall:.2f} (floor {RECALL_FLOOR}), "
        f"false yes {result.false_yes} (floor 0), undecided {result.undecided} (floor 0)"
    )
    return 0 if result.holds else 1


if __name__ == "__main__":
    sys.exit(main())
