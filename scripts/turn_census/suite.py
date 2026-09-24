"""Answer suite: the reference questions through the real agent, timed and checked.

`census.py` measures one question. This runs the loop eval's question set
(`tests/fixtures/herleitung/loop_eval_questions.yaml`) through `nat run`, N
times each and several at once, and writes one report that answers both
questions a change to the prompt, the retrieval or the answer pipeline has to
answer: did the answers get slower or more variable, and are they still right.

Per run it records what the provider billed and what the reader got:

- seconds (wall, final call), research calls, tool calls, reasoning tokens and
  the largest single-call spike: the September 2026 census found that time
  follows reasoning tokens at ~85 tok/s, and that the spike, not the round
  count, is the variance (`docs/architecture/turns-per-answer-audit-2026-09.md`);
- the pipeline's own signals from the log: a repair rewrite, a gated summary, a
  dropped mindmap, prose written outside the envelope;
- checks against the question's expectations: the envelope parsed, the `kind`,
  the cited Richtlinien family, and the optional `expect` block (a value that
  must appear, a claim that must not, a shape such as variant tabs). An
  expectation is a fact read off the corpus, never a value from memory; the
  question set's header says why.

No backend, no BFF: a question about an office's own files needs a project and
is skipped, and says so. Needs OPENROUTER_API_KEY and the corpus ingested into
AIQ_CHROMA_DIR (`--ingest` runs the sync first). Every run costs model calls.

    python scripts/turn_census/suite.py                        # the core set, 2 runs each
    python scripts/turn_census/suite.py --all --runs 3 --out /tmp/suite/after
    python scripts/turn_census/suite.py --baseline /tmp/suite/before/results.json
    python scripts/turn_census/suite.py --report /tmp/suite/after/results.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
QUESTIONS = ROOT / "tests" / "fixtures" / "herleitung" / "loop_eval_questions.yaml"
sys.path.insert(0, str(HERE))

from census import run_once  # noqa: E402  (a sibling script, not a package)

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_ENVELOPE = re.compile(r"```answer_json\s*(\{.*\})\s*```", re.DOTALL)
#: A cited corpus file's Richtlinie number: `oib-rl_2.1_…`, `oib-richtlinie_2.2_…`.
_CITED_FAMILY = re.compile(r"(?:rl|richtlinie)_(\d+(?:\.\d+)?)_", re.IGNORECASE)
_LOG_SIGNALS = {
    "repair": "repair pass",
    "summary_gated": "summary gated out",
    "mindmap_dropped": "that only redraw a table",
    "prose_outside": "answer_prose_outside_envelope",
    "envelope_salvaged": "answer_envelope_headless",
    # The answer handed the question to deep research, whose clarifier then
    # waits for a person `nat run` does not have; the workflow ends with an
    # empty error. Recorded as what it is, not as a crash.
    "escalated": "Clarifier: Starting",
}


@dataclass
class Run:
    """One turn: what it cost and what the checks found."""

    question_id: str
    run: int
    wall_s: float = 0.0
    final_call_s: float = 0.0
    research_calls: int = 0
    tool_calls: list[str] = field(default_factory=list)
    reasoning_tokens: int = 0
    max_reasoning_tokens: int = 0
    output_tokens: int = 0
    input_tokens: int = 0
    signals: list[str] = field(default_factory=list)
    kind: str = ""
    cited_families: list[str] = field(default_factory=list)
    #: The envelope's cards, kept so `--report` can re-check against edited expectations.
    envelope: dict | None = None
    checks: dict[str, bool] = field(default_factory=dict)
    answer: str = ""
    error: str = ""


# --- Questions ---------------------------------------------------------------


def load_questions(path: Path = QUESTIONS, *, core_only: bool = True) -> tuple[list[dict], list[str]]:
    """The runnable questions and the ids skipped because they need a project."""
    import yaml

    rows = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("questions") or []
    runnable, skipped = [], []
    for row in rows:
        if row.get("family") is None:
            skipped.append(str(row["id"]))
        elif not core_only or row.get("suite") == "core":
            runnable.append(row)
    return runnable, skipped


# --- Reading one turn --------------------------------------------------------


def _usage(entry: dict) -> tuple[int, int, int]:
    usage = entry.get("usage") or {}
    details = usage.get("output_tokens_details") or usage.get("completion_tokens_details") or {}
    return (
        usage.get("input_tokens") or usage.get("prompt_tokens") or 0,
        usage.get("output_tokens") or usage.get("completion_tokens") or 0,
        details.get("reasoning_tokens") or 0,
    )


def _is_research(entry: dict) -> bool:
    return entry["url"].endswith("/responses") and (entry.get("req") or {}).get("input") != "ping"


def final_answer(log_text: str) -> str:
    """The answer the pipeline delivered: `nat run`'s Workflow Result, minus the colour codes."""
    plain = _ANSI.sub("", log_text)
    marker = plain.rfind("Workflow Result:")
    if marker < 0:
        return ""
    body = plain[marker + len("Workflow Result:") :]
    return body.split("\n------", 1)[0].strip()


def last_envelope(rows: list[dict]) -> dict | None:
    """The last answer envelope the model wrote, or None when it wrote none.

    The last ENVELOPE, not the last reply: a repair pass rewrites the prose in
    a call of its own after the answer, and reading that call as the answer
    reported every repaired turn as having no envelope.
    """
    found = None
    for entry in rows:
        if not _is_research(entry):
            continue
        for item in (entry.get("resp") or {}).get("output", []):
            if item.get("type") != "message":
                continue
            match = _ENVELOPE.search("".join(part.get("text", "") for part in item.get("content", [])))
            if match:
                try:
                    found = json.loads(match.group(1))
                except json.JSONDecodeError:
                    continue
    return found


def observe(question: dict, index: int, record: Path, log: Path) -> Run:
    """Everything one turn left behind, read into a Run."""
    run = Run(question_id=str(question["id"]), run=index)
    rows = sorted((json.loads(line) for line in record.open()), key=lambda r: r["t_start"]) if record.exists() else []
    log_text = log.read_text(errors="replace") if log.exists() else ""
    if not rows:
        run.error = "no model calls recorded"
        return run
    research = [entry for entry in rows if _is_research(entry)]
    run.wall_s = round(rows[-1]["t_end"] - rows[0]["t_start"], 1)
    run.research_calls = len(research)
    for entry in research:
        tokens_in, tokens_out, reasoning = _usage(entry)
        run.input_tokens += tokens_in
        run.output_tokens += tokens_out
        run.reasoning_tokens += reasoning
        run.max_reasoning_tokens = max(run.max_reasoning_tokens, reasoning)
        for item in (entry.get("resp") or {}).get("output", []):
            if item.get("type") == "function_call":
                run.tool_calls.append(str(item.get("name")))
    if research:
        run.final_call_s = round(research[-1]["t_end"] - research[-1]["t_start"], 1)
    run.signals = [name for name, needle in _LOG_SIGNALS.items() if needle in log_text]
    run.answer = final_answer(log_text)
    envelope = last_envelope(rows)
    run.envelope = {"kind": envelope.get("kind"), "cards": envelope.get("cards") or []} if envelope else None
    run.kind = str((envelope or {}).get("kind") or "")
    run.cited_families = sorted(set(_CITED_FAMILY.findall(run.answer)))
    run.checks = check(question, run, envelope)
    if "escalated" in run.signals:
        run.kind = run.kind or "handoff"
        run.checks = check(question, run, envelope)
    elif not run.answer:
        run.error = "no Workflow Result in the log"
    return run


# --- Checks ------------------------------------------------------------------


def _normal(text: str) -> str:
    """Case-folded, with subscripts and non-breaking spaces as the reader types them."""
    return text.translate(str.maketrans("₀₁₂₃₄₅₆₇₈₉  ", "0123456789  ")).casefold()


def _family_number(family: str | None) -> str | None:
    match = re.search(r"OIB-RL\s*(\d+(?:\.\d+)?)", str(family or ""), re.IGNORECASE)
    return match.group(1) if match else None


def _card_strings(value: Any) -> list[str]:
    """Every string a card carries, depth first: titles, table cells, a `Text` leaf's Markdown."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _card_strings(item)]
    if isinstance(value, list):
        return [text for item in value for text in _card_strings(item)]
    return []


def _has_shape(shape: str, answer: str, envelope: dict | None) -> bool:
    """Whether the delivered answer has this shape: variant tabs, a table, a drawing."""
    if shape == "tabs":
        return any(
            card.get("type") == "surface" and any(c.get("component") == "Tabs" for c in card.get("components", []))
            for card in (envelope or {}).get("cards") or []
            if isinstance(card, dict)
        )
    if shape == "table":
        return bool(re.search(r"^\s*\|.*\|\s*$", answer, re.MULTILINE))
    if shape == "diagram":
        return "```mermaid" in answer
    return False


def check(question: dict, run: Run, envelope: dict | None) -> dict[str, bool]:
    """The question's expectations against what the turn delivered. Each key is one fact."""
    checks: dict[str, bool] = {"envelope": envelope is not None}
    if question.get("kind"):
        accepted = [question["kind"], *((question.get("expect") or {}).get("kind_also") or [])]
        checks["kind"] = run.kind in accepted
    family = _family_number(question.get("family"))
    if family:
        checks["family_cited"] = family in run.cited_families
    expect = question.get("expect") or {}
    # The reader sees the prose AND the cards (a variant's table sits in a tab),
    # so a value counts wherever it was delivered.
    answer = _normal("\n".join([run.answer, *_card_strings((envelope or {}).get("cards") or [])]))
    for item in expect.get("mentions") or []:
        options = item if isinstance(item, list) else [item]
        checks[f"mentions:{options[0]}"] = any(_normal(str(option)) in answer for option in options)
    for item in expect.get("not_mentions") or []:
        checks[f"not:{item}"] = _normal(str(item)) not in answer
    shapes = expect.get("shape")
    if shapes:
        options = shapes if isinstance(shapes, list) else [shapes]
        checks[f"shape:{'|'.join(options)}"] = any(_has_shape(option, run.answer, envelope) for option in options)
    return checks


# --- Report ------------------------------------------------------------------


def _spread(values: list[float]) -> str:
    if not values:
        return "–"
    median = statistics.median(values)
    if len(values) == 1:
        return f"{median:g}"
    return f"{median:g} ({min(values):g}–{max(values):g})"


def summarize(runs: list[Run]) -> dict[str, dict[str, Any]]:
    """Per question: medians, spread and the share of each check that held."""
    by_question: dict[str, list[Run]] = {}
    for run in runs:
        by_question.setdefault(run.question_id, []).append(run)
    summary: dict[str, dict[str, Any]] = {}
    for question_id, group in by_question.items():
        ok = [run for run in group if not run.error]
        keys = sorted({key for run in ok for key in run.checks})
        summary[question_id] = {
            "runs": len(group),
            "errors": [run.error for run in group if run.error],
            "wall_s": [run.wall_s for run in ok],
            "final_call_s": [run.final_call_s for run in ok],
            "research_calls": [run.research_calls for run in ok],
            "reasoning_tokens": [run.reasoning_tokens for run in ok],
            "max_reasoning_tokens": [run.max_reasoning_tokens for run in ok],
            "signals": sorted({signal for run in ok for signal in run.signals}),
            "checks": {key: sum(run.checks.get(key, False) for run in ok) / max(1, len(ok)) for key in keys},
        }
    return summary


def _delta(now: list[float], then: list[float] | None) -> str:
    if not now or not then:
        return ""
    change = statistics.median(now) - statistics.median(then)
    return f" ({change:+.0f})" if abs(change) >= 1 else ""


def render(runs: list[Run], skipped: list[str], meta: dict, baseline: dict | None = None) -> str:
    """The Markdown report: one row per question, failing checks named, then the totals."""
    summary = summarize(runs)
    before = summarize([Run(**row) for row in baseline["runs"]]) if baseline else {}
    lines = [
        "# Answer suite",
        "",
        f"{meta.get('started', '')} · model config `{meta.get('config', '')}` · "
        f"{meta.get('runs_per_question', '')} run(s) per question"
        + (f" · overrides {meta['overrides']}" if meta.get("overrides") else ""),
        "",
        "Median (min–max). Seconds follow reasoning tokens at ~85 tok/s; the spike column is the "
        "largest single call, which is where run-to-run variance comes from."
        + (" Deltas in brackets are against the baseline's medians." if baseline else ""),
        "",
        "| Question | Wall s | Research calls | Reasoning tokens | Spike | Final call s | Checks | Signals |",
        "|---|---|---|---|---|---|---|---|",
    ]
    failing: list[str] = []
    for question_id, row in summary.items():
        prior = before.get(question_id, {})
        held = [value for value in row["checks"].values()]
        score = f"{sum(v == 1 for v in held)}/{len(held)}" if held else "–"
        lines.append(
            f"| {question_id} | {_spread(row['wall_s'])}{_delta(row['wall_s'], prior.get('wall_s'))} "
            f"| {_spread(row['research_calls'])} "
            f"| {_spread(row['reasoning_tokens'])}{_delta(row['reasoning_tokens'], prior.get('reasoning_tokens'))} "
            f"| {_spread(row['max_reasoning_tokens'])} | {_spread(row['final_call_s'])} | {score} "
            f"| {', '.join(row['signals']) or '–'} |"
        )
        for key, share in row["checks"].items():
            if share < 1:
                failing.append(f"- **{question_id}** `{key}` held in {share:.0%} of runs")
        for error in row["errors"]:
            failing.append(f"- **{question_id}** run error: {error}")
    ok = [run for run in runs if not run.error]
    lines += [
        "",
        f"**All runs:** wall {_spread([r.wall_s for r in ok])} s · research calls "
        f"{_spread([r.research_calls for r in ok])} · reasoning tokens {_spread([r.reasoning_tokens for r in ok])}",
        "",
        "## Checks that did not always hold",
        "",
        *(failing or ["None."]),
    ]
    if skipped:
        lines += ["", f"Skipped, need a project: {', '.join(skipped)}."]
    return "\n".join(lines) + "\n"


# --- Running -----------------------------------------------------------------


def _ensure_key() -> bool:
    """OPENROUTER_API_KEY, or the OPENROUTER_KEY some environments carry instead."""
    if not os.environ.get("OPENROUTER_API_KEY") and os.environ.get("OPENROUTER_KEY"):
        os.environ["OPENROUTER_API_KEY"] = os.environ["OPENROUTER_KEY"]
    return bool(os.environ.get("OPENROUTER_API_KEY"))


def _corpus_ready() -> bool:
    try:
        import chromadb

        from aiq_agent.oib_sync import CHROMA_DIR

        return chromadb.PersistentClient(str(CHROMA_DIR)).get_collection("oib_knowledge").count() > 0
    except Exception:
        return False


def run_suite(
    questions: list[dict], runs: int, out: Path, workers: int, overrides: list[list[str]] | None
) -> list[Run]:
    out.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%H%M%S")
    jobs = [(question, index) for question in questions for index in range(1, runs + 1)]

    def one(job: tuple[dict, int]) -> Run:
        question, index = job
        conversation = f"suite-{stamp}-{question['id']}-{index}"
        record = run_once(str(question["question"]).strip(), out, conversation, overrides)
        result = observe(question, index, record, record.with_suffix(".log"))
        print(f"  {question['id']} #{index}: {result.wall_s}s, {result.research_calls} call(s)", flush=True)
        return result

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, jobs))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--all", action="store_true", help="every question with a family, not only `suite: core`")
    parser.add_argument("--only", nargs="*", help="question ids to run")
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--out", type=Path, default=Path("/tmp/answer_suite") / time.strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--baseline", type=Path, help="an earlier results.json to compare medians against")
    parser.add_argument("--report", type=Path, help="re-render a results.json; no model calls")
    parser.add_argument("--ingest", action="store_true", help="sync the OIB corpus into AIQ_CHROMA_DIR first")
    parser.add_argument("--override", nargs=2, action="append", metavar=("KEY", "VALUE"))
    args = parser.parse_args(argv)
    baseline = json.loads(args.baseline.read_text()) if args.baseline else None

    if args.report:
        data = json.loads(args.report.read_text())
        runs = [Run(**row) for row in data["runs"]]
        # Re-read from the recordings beside results.json when they are there,
        # and re-checked against the question set as it is NOW: a harness fix
        # or a corrected expectation applies without paying for the runs again.
        by_id = {str(q["id"]): q for q in load_questions(core_only=False)[0]}
        for index, run in enumerate(runs):
            question = by_id.get(run.question_id)
            if question is None:
                continue
            recorded = sorted(args.report.parent.glob(f"suite-*-{run.question_id}-{run.run}.jsonl"))
            if recorded:
                runs[index] = observe(question, run.run, recorded[-1], recorded[-1].with_suffix(".log"))
            elif not run.error:
                run.checks = check(question, run, run.envelope)
        print(render(runs, data.get("skipped", []), data["meta"], baseline))
        return 0
    if not _ensure_key():
        print("OPENROUTER_API_KEY is not set; the suite needs the real models.", file=sys.stderr)
        return 2
    if args.ingest:
        from aiq_agent import oib_sync

        print("ingesting the corpus:", oib_sync.sync())
    if not _corpus_ready():
        print(
            "The OIB corpus is not ingested into AIQ_CHROMA_DIR. Put the PDFs in data/oib and run with --ingest.",
            file=sys.stderr,
        )
        return 2

    questions, skipped = load_questions(core_only=not (args.all or args.only))
    if args.only:
        questions = [q for q in load_questions(core_only=False)[0] if q["id"] in set(args.only)]
    meta = {
        "started": time.strftime("%Y-%m-%d %H:%M"),
        "config": "configs/config_oib_openrouter.yml",
        "runs_per_question": args.runs,
        "overrides": args.override or [],
    }
    print(f"{len(questions)} question(s) × {args.runs} run(s), {args.workers} at a time → {args.out}")
    runs = run_suite(questions, args.runs, args.out, args.workers, args.override)
    (args.out / "results.json").write_text(
        json.dumps({"meta": meta, "skipped": skipped, "runs": [asdict(r) for r in runs]}, ensure_ascii=False, indent=1)
    )
    report = render(runs, skipped, meta, baseline)
    (args.out / "report.md").write_text(report)
    print(report)
    print(f"Written: {args.out / 'report.md'}, {args.out / 'results.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
