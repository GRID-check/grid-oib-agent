#!/usr/bin/env python3
"""Decision eval: does the decision model answer the turn-start questions right, in German?

WHY THIS EXISTS
---------------
ADR-0064 lets a decision model (TypeSafe's Jev, through OpenRouter's alpha
Decisions endpoint) decide four things before a chat turn's first LLM call:
whether the message needs evidence, which corpus it lives in, which
OIB-Richtlinien it needs, and which card types it is likely to earn. Every one
of those can only ADD to the turn, so a wrong answer costs a wasted fetch and
never a capability — but a decider that is wrong most of the time wastes a
fetch most of the time, and the vendor says German is "accepted but currently
[of] lower accuracy". So the adoption rule is written down here, and this
script measures against it on the loop-eval questions
(`tests/fixtures/herleitung/loop_eval_questions.yaml`), which already carry the
family the answer must be grounded in.

THE ADOPTION RULE (audit §4.4, ADR-0064)
----------------------------------------
- `needs_evidence` never below 0.5 on a `ruling` row (a false "no" costs the
  reader the prefetch on exactly the question it helps most).
- family top-1 ≥ 85 % on the OIB rows (the family the row names is the
  highest family noul).
- corpus `baurecht` on ≥ 90 % of the regulation rows.
Anything under that: keep `turn_decisions: false` and say so in the PR.

IT NEEDS A KEY, NOT A BACKEND
-----------------------------
Unlike `loop_eval.py`, nothing here needs the corpus or a running backend: the
decision reads the question and a fixed description of the six families. It
needs `OPENROUTER_API_KEY` (or `GRID_DECISIONS_API_KEY`) and costs about a
cent for the whole set. It cannot run in CI for that reason alone.

USAGE
-----
    python scripts/decision_eval.py                 # the 27 loop-eval questions
    python scripts/decision_eval.py --out /tmp/decisions.csv
    python scripts/decision_eval.py --questions my_questions.yaml

`task be:eval:decisions` is the same thing with the paths defaulted.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import os
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

DEFAULT_QUESTIONS = REPO_ROOT / "tests" / "fixtures" / "herleitung" / "loop_eval_questions.yaml"

#: The six families as the platform corpus holds them, so the eval asks the
#: same questions a turn asks. Synthetic filenames in the corpus's own shape.
CORPUS_FILES = [
    "oib-rl_1_ausgabe_mai_2023.pdf",
    "oib-rl_2_ausgabe_mai_2023.pdf",
    "oib-rl_2.1_ausgabe_mai_2023.pdf",
    "oib-rl_2.2_ausgabe_mai_2023.pdf",
    "oib-rl_2.3_ausgabe_mai_2023.pdf",
    "oib-rl_3_ausgabe_mai_2023.pdf",
    "oib-rl_4_ausgabe_mai_2023.pdf",
    "oib-rl_5_ausgabe_mai_2023.pdf",
    "oib-rl_6_ausgabe_mai_2023.pdf",
]

FAMILY_TOP1_FLOOR = 0.85
CORPUS_FLOOR = 0.90


@dataclass
class Row:
    id: str
    kind: str
    expected_family: str | None
    expected_corpus: str | None
    needs_evidence: float | None = None
    corpus: str | None = None
    corpus_p: float = 0.0
    top_family: str | None = None
    top_family_p: float = 0.0
    expected_family_p: float | None = None
    top_card: str | None = None
    top_card_p: float = 0.0
    model_p: float | None = None
    latency_ms: int = 0
    decided: bool = False

    @property
    def family_hit(self) -> bool | None:
        if self.expected_family is None:
            return None
        return self.top_family == self.expected_family

    @property
    def corpus_hit(self) -> bool | None:
        if self.expected_corpus is None:
            return None
        return self.corpus == self.expected_corpus


def expected_family(family: str | None) -> str | None:
    """``"OIB-RL 2.2"`` → ``"2"``; a Bauordnung or office row expects no family."""
    if not family or not family.startswith("OIB-RL"):
        return None
    return family.split()[-1].split(".")[0]


def expected_corpus(family: str | None) -> str | None:
    if family is None:
        return None
    return "baurecht"


async def _evaluate(questions_path: Path) -> list[Row]:
    from aiq_agent.agents.piloti.decisions import TurnFacts
    from aiq_agent.agents.piloti.decisions import decide_turn
    from aiq_agent.cards.catalog import card_index_entries
    from aiq_agent.cards.envelope import ENVELOPE_SHAPE_TYPES
    from aiq_agent.common.norm_registry import oib_families
    from scripts.loop_eval import load_questions

    families = oib_families(CORPUS_FILES)
    cards = [entry for entry in card_index_entries() if entry[0] not in ENVELOPE_SHAPE_TYPES]
    rows: list[Row] = []
    for question in load_questions(questions_path):
        row = Row(
            id=question.id,
            kind=question.kind,
            expected_family=expected_family(question.family),
            expected_corpus=expected_corpus(question.family),
        )
        facts = TurnFacts(question=question.question, families=families, card_types=cards, offers_model_skill=True)
        decided = await decide_turn(facts)
        row.decided = decided.decided
        if decided.decided:
            row.needs_evidence = decided.needs_evidence
            row.corpus, row.corpus_p = decided.corpus, decided.corpus_p
            if decided.families:
                row.top_family, row.top_family_p = max(decided.families, key=lambda f: f[1])
                by_key = dict(decided.families)
                row.expected_family_p = by_key.get(row.expected_family or "")
            if decided.cards:
                row.top_card, row.top_card_p = max(decided.cards, key=lambda c: c[1])
            row.model_p = decided.model
            row.latency_ms = decided.latency_ms
        rows.append(row)
        print(
            f"{row.id:36s} evidence={row.needs_evidence or 0:.2f} corpus={row.corpus}({row.corpus_p:.2f}) "
            f"family={row.top_family}({row.top_family_p:.2f}) expected={row.expected_family} "
            f"card={row.top_card}({row.top_card_p:.2f}) {row.latency_ms}ms"
        )
    return rows


def summarise(rows: list[Row]) -> dict[str, float | int | bool]:
    decided = [r for r in rows if r.decided]
    family_rows = [r for r in decided if r.expected_family is not None]
    corpus_rows = [r for r in decided if r.expected_corpus is not None]
    ruling_rows = [r for r in decided if r.kind == "ruling"]
    family_top1 = sum(1 for r in family_rows if r.family_hit) / len(family_rows) if family_rows else 0.0
    corpus_rate = sum(1 for r in corpus_rows if r.corpus_hit) / len(corpus_rows) if corpus_rows else 0.0
    evidence_floor_held = all((r.needs_evidence or 0.0) >= 0.5 for r in ruling_rows)
    return {
        "questions": len(rows),
        "decided": len(decided),
        "family_top1": round(family_top1, 3),
        "corpus_baurecht_rate": round(corpus_rate, 3),
        "ruling_evidence_floor_held": evidence_floor_held,
        "mean_latency_ms": int(sum(r.latency_ms for r in decided) / len(decided)) if decided else 0,
        "adopt": bool(decided)
        and family_top1 >= FAMILY_TOP1_FLOOR
        and corpus_rate >= CORPUS_FLOOR
        and evidence_floor_held,
    }


def threshold_sweep(rows: list[Row]) -> list[tuple[float, float, float]]:
    """(threshold, recall, precision) of "expected family chosen" as the family threshold moves."""
    out = []
    family_rows = [r for r in rows if r.decided and r.expected_family is not None]
    for tenths in range(3, 10):
        threshold = tenths / 10
        chosen_expected = sum(1 for r in family_rows if (r.expected_family_p or 0.0) >= threshold)
        chosen_any = sum(1 for r in family_rows if r.top_family_p >= threshold)
        correct = sum(1 for r in family_rows if r.top_family_p >= threshold and r.family_hit)
        recall = chosen_expected / len(family_rows) if family_rows else 0.0
        precision = correct / chosen_any if chosen_any else 0.0
        out.append((threshold, round(recall, 3), round(precision, 3)))
    return out


def write_csv(rows: list[Row], path: Path) -> None:
    fields = [
        "id",
        "kind",
        "expected_family",
        "top_family",
        "top_family_p",
        "expected_family_p",
        "corpus",
        "corpus_p",
        "needs_evidence",
        "top_card",
        "top_card_p",
        "model_p",
        "latency_ms",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: getattr(row, field) for field in fields})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--questions", type=Path, default=DEFAULT_QUESTIONS)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)
    if not (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("GRID_DECISIONS_API_KEY")):
        print("decision_eval: set OPENROUTER_API_KEY (or GRID_DECISIONS_API_KEY); nothing to measure without one.")
        return 2
    rows = asyncio.run(_evaluate(args.questions))
    summary = summarise(rows)
    print()
    for key, value in summary.items():
        print(f"{key:28s} {value}")
    print("\nfamily threshold sweep (threshold, recall, precision):")
    for threshold, recall, precision in threshold_sweep(rows):
        print(f"  {threshold:.1f}  {recall:.3f}  {precision:.3f}")
    if args.out:
        write_csv(rows, args.out)
        print(f"\nwrote {args.out}")
    return 0 if summary["adopt"] else 1


if __name__ == "__main__":
    sys.exit(main())
