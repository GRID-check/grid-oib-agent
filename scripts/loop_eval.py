#!/usr/bin/env python3
"""Loop eval: what the agentic-loop changes did to the SHAPE of a turn.

WHY THIS EXISTS
---------------
The second landing on `docs/roadmap/architect-workspace-voice-and-agentic-loop.md`
makes three claims about behaviour: a conclusion that names a passage is OPENED
rather than searched for again (`read_passage`), the Herleitung checkpoint is a
slot the model fills rather than prose it usually skips, and the first round is
capped at two searches so the budget survives to the round that knows what it is
looking for. Each of those is measurable, and a claim about behaviour that nobody
measured is a preference. This script measures them: it runs
`tests/fixtures/herleitung/loop_eval_questions.yaml` through a live backend,
writes one CSV row per question, and `--compare before.csv after.csv` prints what
moved.

It is NOT a correctness benchmark. Whether the right passage came back is the
retrieval golden set's question (`frontends/benchmarks/oib_retrieval`,
`task be:eval:retrieval`). This one asks how the turn went looking: how many
rounds, whether the locator was used, whether the cited Punkt is the one the
question is about, and whether the budget ran out before the answer.

IT CANNOT RUN IN CI, AND THAT IS NOT AN OVERSIGHT
-------------------------------------------------
It needs a reachable backend with the OIB corpus ingested and a model key behind
it. The corpus is operator-provided and gitignored (`data/oib/README.md`), so no
CI checkout holds the PDFs, and every run costs real model calls. Same shape as
`task be:eval:retrieval`, for the same reason. Run it yourself on either side of
a loop change and quote the delta in the PR.

The only part of this file that IS under test is the CSV and the comparison
(`tests/test_loop_eval.py`): the columns are the measurement, and a comparison
that silently drops a question or reads a stale column would make the whole
exercise decorative.

USAGE
-----
    GRID_LOOP_EVAL_URL=http://localhost:8000 python scripts/loop_eval.py --out before.csv
    # …change the loop, redeploy…
    GRID_LOOP_EVAL_URL=http://localhost:8000 python scripts/loop_eval.py --out after.csv
    python scripts/loop_eval.py --compare before.csv after.csv

`task be:eval:loop` is the same thing with the paths defaulted.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import asdict
from dataclasses import dataclass
from dataclasses import field
from dataclasses import fields as dataclass_fields
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_QUESTIONS = REPO_ROOT / "tests" / "fixtures" / "herleitung" / "loop_eval_questions.yaml"

#: Environment variable naming the backend to measure. Deliberately its own name
#: rather than reusing a deployment variable: pointing this at production by
#: inheriting a URL from the environment is exactly the accident to avoid.
BASE_URL_ENV = "GRID_LOOP_EVAL_URL"

#: How long one question may take. A research turn with two rounds and a
#: reranker is tens of seconds; the deep-research escalation path is minutes and
#: is not what this set asks for.
DEFAULT_TIMEOUT_SECONDS = 240.0

#: A Punkt as it appears in an answer: "Pkt. 3.5.2", "Punkt 5.1", "Pkt 4".
_PUNKT_NUMBER_RE = re.compile(r"\b(?:Pkt\.?|Punkt)\s*(\d+(?:\.\d+)*)")

#: Step names the loop's own telemetry uses. The eval reads the SAME events the
#: product emits — inventing a second measurement channel is how a harness ends
#: up measuring itself.
_ROUND_STEP_RE = re.compile(r"^status:retrieval:(\d+)$")
_CHECKPOINT_STEP_RE = re.compile(r"^status:checkpoint:(\d+)$")
_BUDGET_STEP = "status:budget"


@dataclass(frozen=True)
class Question:
    """One row of the question set."""

    id: str
    question: str
    family: str | None
    punkt: str | None
    kind: str


@dataclass
class Observation:
    """What one turn did, as one CSV row.

    Every field is a fact about the turn, never a judgement about the answer:
    "the citation names Pkt. 5.1" is checkable, "the answer is right" is not,
    and a harness that pretends otherwise measures its own opinion.
    """

    id: str = ""
    expected_family: str = ""
    expected_punkt: str = ""
    expected_kind: str = ""
    kind: str = ""
    verdict: str = ""
    rounds: str = ""
    read_passage: str = ""
    punkt_match: str = ""
    truncated: str = ""
    checkpoint_sources: str = ""
    error: str = ""


#: The CSV header, in order. Read by :func:`read_csv` as the contract: a file
#: whose columns are not these is a file from another version of this script,
#: and comparing across versions silently is how a delta comes out of nowhere.
FIELDS: tuple[str, ...] = tuple(f.name for f in dataclass_fields(Observation))

#: Columns whose value is a yes/no, counted as a rate by :func:`summarise`.
_BOOLEAN_FIELDS = ("verdict", "read_passage", "truncated")


def _yes_no(value: bool) -> str:
    return "yes" if value else "no"


def load_questions(path: Path) -> list[Question]:
    """Read the question set. Fails loudly on a row missing a field."""
    import yaml

    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    rows = raw.get("questions") or []
    return [
        Question(
            id=str(row["id"]),
            question=str(row["question"]).strip(),
            family=row.get("family"),
            punkt=None if row.get("punkt") is None else str(row["punkt"]),
            kind=str(row["kind"]),
        )
        for row in rows
    ]


# --- Reading one turn --------------------------------------------------------


def _status_payloads(steps: Iterable[dict]) -> list[tuple[str, dict]]:
    """`(step name, payload)` for every status step of a turn, in order."""
    out: list[tuple[str, dict]] = []
    for step in steps:
        name = str(step.get("name") or step.get("functionName") or "")
        body = step.get("payload")
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except json.JSONDecodeError:
                continue
        if name and isinstance(body, dict):
            out.append((name, body))
    return out


def cited_punkte(answer: str) -> list[str]:
    """Every Punkt number the answer names, in order of appearance."""
    return [match.group(1) for match in _PUNKT_NUMBER_RE.finditer(answer or "")]


def punkt_matches(expected: str | None, cited: Sequence[str]) -> str:
    """Did the answer cite the expected Punkt, or one of its children?

    Empty when the question names no expected Punkt — an unmeasured cell, which
    must not be counted as a miss. A child counts: the question decides the
    requirement, the corpus decides how deeply it is numbered.
    """
    if not expected:
        return ""
    for number in cited:
        if number == expected or number.startswith(f"{expected}."):
            return "yes"
    return "no"


def observe(question: Question, steps: Sequence[dict], answer: str, envelope: dict | None) -> Observation:
    """One turn's row, from the events it emitted and the envelope it produced."""
    payloads = _status_payloads(steps)
    rounds = {int(m.group(1)) for name, _ in payloads if (m := _ROUND_STEP_RE.match(name))}
    checkpoints = {
        int(m.group(1)): str(body.get("source") or "none")
        for name, body in payloads
        if (m := _CHECKPOINT_STEP_RE.match(name))
    }
    tools = [tool for _, body in payloads for tool in (body.get("tools") or [])]
    truncated = any(name == _BUDGET_STEP and body.get("truncated") for name, body in payloads)
    envelope = envelope or {}
    return Observation(
        id=question.id,
        expected_family=question.family or "",
        expected_punkt=question.punkt or "",
        expected_kind=question.kind,
        kind=str(envelope.get("kind") or ""),
        verdict=_yes_no(bool(envelope.get("verdict"))),
        rounds=str(len(rounds)),
        read_passage=_yes_no("read_passage" in tools),
        punkt_match=punkt_matches(question.punkt, cited_punkte(answer)),
        truncated=_yes_no(truncated),
        checkpoint_sources=">".join(checkpoints[index] for index in sorted(checkpoints)),
    )


# --- The CSV -----------------------------------------------------------------


def write_csv(path: Path, rows: Sequence[Observation]) -> None:
    """Write the run. One row per question, in the set's own order."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(FIELDS))
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))


def read_csv(path: Path) -> list[Observation]:
    """Read a run back, refusing a file this script did not write.

    The header is the contract. A CSV from another version of this script has
    different columns, and comparing the two without noticing produces a delta
    that came from the schema rather than from the agent.
    """
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        header = tuple(reader.fieldnames or ())
        if header != FIELDS:
            missing = [name for name in FIELDS if name not in header]
            extra = [name for name in header if name not in FIELDS]
            raise ValueError(
                f"{path} does not carry this script's columns "
                f"(missing={missing or '-'}, unexpected={extra or '-'}). Re-run the eval to produce it."
            )
        return [Observation(**{name: str(row.get(name) or "") for name in FIELDS}) for row in reader]


# --- Comparing two runs ------------------------------------------------------


@dataclass(frozen=True)
class Summary:
    """The aggregate of one run. Counts and rates, never an average of a rate."""

    answered: int = 0
    rounds_total: int = 0
    kind_as_expected: int = 0
    punkt_measured: int = 0
    punkt_matched: int = 0
    booleans: dict[str, int] = field(default_factory=dict)
    checkpoint_sources: dict[str, int] = field(default_factory=dict)
    errors: int = 0


def summarise(rows: Sequence[Observation]) -> Summary:
    """Fold a run into the numbers a reader compares."""
    booleans = {name: sum(1 for row in rows if getattr(row, name) == "yes") for name in _BOOLEAN_FIELDS}
    sources: dict[str, int] = {}
    for row in rows:
        for token in filter(None, row.checkpoint_sources.split(">")):
            sources[token] = sources.get(token, 0) + 1
    return Summary(
        answered=sum(1 for row in rows if not row.error),
        rounds_total=sum(int(row.rounds or 0) for row in rows),
        kind_as_expected=sum(1 for row in rows if row.kind and row.kind == row.expected_kind),
        punkt_measured=sum(1 for row in rows if row.punkt_match),
        punkt_matched=sum(1 for row in rows if row.punkt_match == "yes"),
        booleans=booleans,
        checkpoint_sources=sources,
        errors=sum(1 for row in rows if row.error),
    )


#: Columns a per-question diff reports. `question` and the expectations do not
#: change between runs — only what the agent did does.
_COMPARED_FIELDS = ("kind", "verdict", "rounds", "read_passage", "punkt_match", "truncated", "checkpoint_sources")


def changed_rows(before: Sequence[Observation], after: Sequence[Observation]) -> list[tuple[str, str, str, str]]:
    """`(id, column, before, after)` for every cell that moved.

    Questions present in only one of the runs are reported too, as a move from
    or to ``—``: a set that grew or shrank between runs is exactly the thing a
    silent join would hide.
    """
    left = {row.id: row for row in before}
    right = {row.id: row for row in after}
    out: list[tuple[str, str, str, str]] = []
    for question_id in sorted(left.keys() | right.keys()):
        old, new = left.get(question_id), right.get(question_id)
        for name in _COMPARED_FIELDS:
            was = getattr(old, name) if old else "—"
            now = getattr(new, name) if new else "—"
            if was != now:
                out.append((question_id, name, was, now))
    return out


def _delta(was: int, now: int) -> str:
    return f"{was} → {now} ({now - was:+d})"


def format_comparison(before: Sequence[Observation], after: Sequence[Observation]) -> str:
    """The report `--compare` prints: the aggregate, then what moved."""
    old, new = summarise(before), summarise(after)
    lines = [
        f"questions: {_delta(len(before), len(after))}",
        f"answered without error: {_delta(old.answered, new.answered)}",
        f"kind as expected: {_delta(old.kind_as_expected, new.kind_as_expected)}",
        f"retrieval rounds, total: {_delta(old.rounds_total, new.rounds_total)}",
        f"cited Punkt matched: {_delta(old.punkt_matched, new.punkt_matched)}"
        f" of {_delta(old.punkt_measured, new.punkt_measured)} measured",
    ]
    lines += [f"{name}: {_delta(old.booleans.get(name, 0), new.booleans.get(name, 0))}" for name in _BOOLEAN_FIELDS]
    for token in sorted(old.checkpoint_sources.keys() | new.checkpoint_sources.keys()):
        lines.append(
            f"checkpoint source {token}: "
            f"{_delta(old.checkpoint_sources.get(token, 0), new.checkpoint_sources.get(token, 0))}"
        )
    changes = changed_rows(before, after)
    lines.append("")
    lines.append(f"per question ({len(changes)} cell(s) moved):" if changes else "per question: nothing moved")
    lines += [f"  {question_id:34} {name:20} {was} → {now}" for question_id, name, was, now in changes]
    return "\n".join(lines)


# --- Running against a backend ----------------------------------------------


def _post_turn(base_url: str, question: str, timeout: float) -> tuple[list[dict], str, dict | None]:
    """One turn against `/generate/stream`, as `(steps, answer, envelope)`.

    Deliberately the SSE route rather than the WebSocket: this needs the
    intermediate steps (which carry the loop's own status events) and one final
    answer, and nothing about HITL or reconnection.
    """
    import httpx

    steps: list[dict] = []
    answer = ""
    with httpx.Client(timeout=timeout) as client:
        with client.stream("POST", f"{base_url.rstrip('/')}/generate/stream", json={"query": question}) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    frame = json.loads(line[len("data:") :].strip())
                except json.JSONDecodeError:
                    continue
                steps.extend(_frame_steps(frame))
                answer = _frame_answer(frame) or answer
    return steps, answer, _envelope(answer)


def _frame_steps(frame: dict) -> list[dict]:
    """The intermediate steps one SSE frame carries, if any."""
    payload = frame.get("intermediate_step") or frame.get("intermediate") or frame.get("payload")
    if isinstance(payload, dict) and (payload.get("name") or payload.get("functionName")):
        return [payload]
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    return []


def _frame_answer(frame: dict) -> str:
    """The answer text a terminal SSE frame carries, if any."""
    for key in ("value", "content", "answer", "output"):
        value = frame.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _envelope(answer: str) -> dict | None:
    """The ``answer_json`` envelope inside the reply, when it parses."""
    fenced = re.search(r"```answer_json\s*(\{.*?\})\s*```", answer or "", re.DOTALL)
    if not fenced:
        return None
    try:
        return json.loads(fenced.group(1))
    except json.JSONDecodeError:
        return None


def run(questions: Sequence[Question], base_url: str, timeout: float) -> list[Observation]:
    """Run the whole set, one question at a time.

    Sequential on purpose: the point is what ONE turn does with its budget, and
    a backend answering four turns at once shares a reranker and a rate limit
    with itself.
    """
    rows: list[Observation] = []
    for index, question in enumerate(questions, 1):
        print(f"[{index}/{len(questions)}] {question.id}", file=sys.stderr, flush=True)
        try:
            steps, answer, envelope = _post_turn(base_url, question.question, timeout)
        except Exception as exc:  # noqa: BLE001 — one dead turn must not lose the other nineteen
            rows.append(
                Observation(
                    id=question.id,
                    expected_family=question.family or "",
                    expected_punkt=question.punkt or "",
                    expected_kind=question.kind,
                    error=f"{type(exc).__name__}: {exc}"[:200],
                )
            )
            continue
        rows.append(observe(question, steps, answer, envelope))
    return rows


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--questions", type=Path, default=DEFAULT_QUESTIONS)
    parser.add_argument("--out", type=Path, help="Where to write this run's CSV.")
    parser.add_argument("--compare", nargs=2, type=Path, metavar=("BEFORE", "AFTER"))
    parser.add_argument("--base-url", default=os.environ.get(BASE_URL_ENV, ""))
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args(argv)

    if args.compare:
        print(format_comparison(read_csv(args.compare[0]), read_csv(args.compare[1])))
        return 0
    if not args.out:
        parser.error("--out is required unless --compare is given")
    if not args.base_url:
        parser.error(
            f"no backend to measure: pass --base-url or set {BASE_URL_ENV}. "
            "This eval needs a running backend with the OIB corpus ingested; it cannot run in CI."
        )
    rows = run(load_questions(args.questions), args.base_url, args.timeout)
    write_csv(args.out, rows)
    print(format_comparison([], rows))
    failed = sum(1 for row in rows if row.error)
    print(f"\nwrote {args.out} ({len(rows)} row(s), {failed} error(s))", file=sys.stderr)
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI
    raise SystemExit(main())
