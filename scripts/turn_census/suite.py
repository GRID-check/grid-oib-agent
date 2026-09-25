"""Answer suite: the reference questions through the real agent, timed and checked.

`census.py` measures one question. This runs the loop eval's question set
(`tests/fixtures/herleitung/loop_eval_questions.yaml`) through `nat run`, N
times each and several at once, and writes one report that answers both
questions a change to the prompt, the retrieval or the answer pipeline has to
answer: did the answers get slower or more variable, and are they still right.

Per run it records what the provider billed and what the reader got:

- seconds (wall, answering call), research calls, tool calls, reasoning tokens and
  the largest single-call spike: the September 2026 census found that time
  follows reasoning tokens at ~85 tok/s, and that the spike, not the round
  count, is the variance (`docs/architecture/turns-per-answer-audit-2026-09.md`);
- seconds until the reader saw prose (`first_text_s`);
- the pipeline's own signals from the log (`_LOG_SIGNALS`): a flagged quote, a
  quote patch, the terminal frame replacing the settled text, a gated summary,
  a dropped mindmap, prose outside the envelope, a salvaged envelope, an
  escalation to deep research;
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
from collections.abc import Sequence
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

from census import ensure_key  # noqa: E402  (a sibling script, not a package)
from census import records  # noqa: E402
from census import run_once  # noqa: E402
from census import run_python  # noqa: E402
from census import run_stamp  # noqa: E402
from census import source_packages  # noqa: E402
from census import tree_pythonpath  # noqa: E402

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
#: A cited corpus file's Richtlinie number: `oib-rl_2.1_…`, `oib-richtlinie_2.2_…`.
_CITED_FAMILY = re.compile(r"(?:rl|richtlinie)_(\d+(?:\.\d+)?)_", re.IGNORECASE)
_LOG_SIGNALS = {
    # The one repair (ADR-0067): a flagged quote, and a patch attempt on one
    # close enough to its passage. Each flagged quote's closeness is in the
    # log beside it, which is what PATCH_FLOOR is read off.
    "unverified_quote": "unverified quote (",
    "quote_patch": "quote patch corrected",
    # What the reader sees: the text they had read changed at the terminal.
    "settled_replaced": "terminal frame replaced the settled answer",
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
    #: Turn start to the first visible text of the answering call: what the reader
    #: waits for once the prose streams (ADR-0066). 0 when the call was buffered.
    first_text_s: float = 0.0
    #: Research calls up to and including the one that wrote the answer.
    research_calls: int = 0
    #: Research calls after the answer: a repair rewriting the prose.
    post_answer_calls: int = 0
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


def last_envelope(research: list[dict]) -> tuple[dict | None, int | None]:
    """The last answer envelope the model wrote, and which research call wrote it; ``(None, None)`` for none.

    The last ENVELOPE, not the last reply: a repair pass rewrites the prose in
    a call of its own after the answer, and reading that call as the answer
    reported every repaired turn as having no envelope.

    Read by the pipeline's own extractor, never a second parser: a regex that
    wanted the fence reported a bare-JSON answer, which the pipeline accepts
    and the reader got whole, as a turn without an envelope.
    """
    from aiq_agent.common.answer_envelope import extract_answer_envelope

    found, at = None, None
    for position, entry in enumerate(research):
        for item in (entry.get("resp") or {}).get("output", []):
            if item.get("type") != "message":
                continue
            _, meta = extract_answer_envelope("".join(part.get("text", "") for part in item.get("content", [])))
            if meta is not None:
                found, at = meta.model_dump(mode="json"), position
    return found, at


def _no_answer(log_text: str) -> str:
    """Why a turn delivered nothing: the census's own timeout marker first, since it says why."""
    return "timed out" if "census: timed out" in log_text else "no Workflow Result in the log"


def _read_calls(run: Run, research: list[dict], answered_at: int | None, t0: float) -> None:
    """Tokens, tools and timing off the research calls.

    ``research_calls`` counts the calls up to and including the one that wrote
    the answer; the calls after it (a repair rewriting the prose) are
    ``post_answer_calls``. Their tokens still count, since they were billed and
    waited for, but a repair is not a research round. ``final_call_s`` and
    ``first_text_s`` time the answering call, not a repair after it. With no
    envelope, the last call stands in for the answer.
    """
    answering = len(research) - 1 if answered_at is None else answered_at
    run.research_calls = answering + 1
    run.post_answer_calls = len(research) - run.research_calls
    for entry in research:
        tokens_in, tokens_out, reasoning = _usage(entry)
        run.input_tokens += tokens_in
        run.output_tokens += tokens_out
        run.reasoning_tokens += reasoning
        run.max_reasoning_tokens = max(run.max_reasoning_tokens, reasoning)
        for item in (entry.get("resp") or {}).get("output", []):
            if item.get("type") == "function_call":
                run.tool_calls.append(str(item.get("name")))
    if not research:
        return
    call = research[answering]
    run.final_call_s = round(call["t_end"] - call["t_start"], 1)
    if first_text := call.get("t_first_text"):
        run.first_text_s = round(first_text - t0, 1)


def observe(question: dict, index: int, record: Path, log: Path) -> Run:
    """Everything one turn left behind, read into a Run."""
    run = Run(question_id=str(question["id"]), run=index)
    rows = sorted(records(record), key=lambda r: r["t_start"])
    log_text = log.read_text(errors="replace") if log.exists() else ""
    if not rows:
        run.error = "timed out" if "census: timed out" in log_text else "no model calls recorded"
        return run
    research = [entry for entry in rows if _is_research(entry)]
    envelope, answered_at = last_envelope(research)
    run.wall_s = round(rows[-1]["t_end"] - rows[0]["t_start"], 1)
    _read_calls(run, research, answered_at, rows[0]["t_start"])
    run.signals = [name for name, needle in _LOG_SIGNALS.items() if needle in log_text]
    run.answer = final_answer(log_text)
    run.envelope = {"kind": envelope.get("kind"), "cards": envelope.get("cards") or []} if envelope else None
    run.kind = str((envelope or {}).get("kind") or "")
    run.cited_families = sorted(set(_CITED_FAMILY.findall(run.answer)))
    if "escalated" in run.signals:
        run.kind = run.kind or "handoff"
    run.checks = check(question, run, envelope)
    if "escalated" not in run.signals and not run.answer:
        run.error = _no_answer(log_text)
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


#: Card types that are a table to the reader, whatever their cells hold.
_TABLE_CARDS = frozenset({"typed_table", "comparison_table"})


def _has_shape(shape: str, prose: str, cards: list[Any]) -> bool:
    """Whether the delivered answer has this shape: variant tabs, a table, a drawing.

    Read off the prose AND the cards, as the reader sees them: a Markdown table
    inside a surface's `Text`, a typed table, a `diagram` card all count.
    """
    cards = [card for card in cards if isinstance(card, dict)]
    types = {card.get("type") for card in cards}
    text = "\n".join([prose, *_card_strings(cards)])
    if shape == "tabs":
        return any(
            card.get("type") == "surface" and any(c.get("component") == "Tabs" for c in card.get("components", []))
            for card in cards
        )
    if shape == "table":
        return bool(types & _TABLE_CARDS) or bool(re.search(r"^\s*\|.*\|\s*$", text, re.MULTILINE))
    if shape == "diagram":
        return "diagram" in types or "```mermaid" in text
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
        cards = (envelope or {}).get("cards") or []
        checks[f"shape:{'|'.join(options)}"] = any(_has_shape(option, run.answer, cards) for option in options)
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
            "first_text_s": [run.first_text_s for run in ok if run.first_text_s],
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


def render(
    runs: list[Run], skipped: list[str], meta: dict, baseline: dict | None = None, not_in_corpus: Sequence[str] = ()
) -> str:
    """The Markdown report: one row per question, failing checks named, then the totals."""
    summary = summarize(runs)
    before = summarize([Run(**row) for row in baseline["runs"]]) if baseline else {}
    lines = [
        "# Answer suite",
        "",
        f"{meta.get('started', '')} · commit `{meta.get('commit', '?')}` · model config `{meta.get('config', '')}` · "
        f"{meta.get('runs_per_question', '')} run(s) per question"
        + (f" · overrides {meta['overrides']}" if meta.get("overrides") else ""),
        "",
        "Median (min–max). Seconds follow reasoning tokens at ~85 tok/s; the spike column is the "
        "largest single call, which is where run-to-run variance comes from."
        + (" Deltas in brackets are against the baseline's medians." if baseline else ""),
        "",
        "| Question | Wall s | First text s | Research calls | Reasoning tokens | Spike | Final call s "
        "| Checks | Signals |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    failing: list[str] = []
    for question_id, row in summary.items():
        prior = before.get(question_id, {})
        held = list(row["checks"].values())
        score = f"{sum(v == 1 for v in held)}/{len(held)}" if held else "–"
        lines.append(
            f"| {question_id} | {_spread(row['wall_s'])}{_delta(row['wall_s'], prior.get('wall_s'))} "
            f"| {_spread(row['first_text_s']) if row['first_text_s'] else '–'} "
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
    if not_in_corpus:
        lines += ["", f"Skipped, the ingested corpus lacks the Richtlinie: {', '.join(not_in_corpus)}."]
    return "\n".join(lines) + "\n"


# --- Running -----------------------------------------------------------------


def corpus_families(registry_path: Path | None = None) -> set[str] | None:
    """The Richtlinien the ingested corpus holds (``{"2", "2.1", …}``), or None.

    The corpus is the operator's (`data/oib/README.md`), and a question about a
    Richtlinie it lacks cannot be answered from it whatever the agent does: the
    first full sweep ran Schallschutz against a corpus without OIB-RL 5 and
    reported the agent as wrong. None when the sync registry cannot be read,
    which skips nothing.
    """
    from aiq_agent.common.norm_registry import oib_family_member

    if registry_path is None:
        from aiq_agent.oib_sync import REGISTRY_PATH as registry_path
    try:
        names = json.loads(Path(registry_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return {member for name in names if (member := oib_family_member(Path(name).name))}


def lacking_family(question: dict, families: set[str] | None) -> str | None:
    """The Richtlinie a question asks about that the corpus does not hold."""
    family = _family_number(question.get("family"))
    if family is None or families is None or family in families:
        return None
    return f"OIB-RL {family}"


def source_commit() -> str:
    """The commit the runs measure, ``-dirty`` when the tree has changes on top of it."""
    import subprocess

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=False)

    sha = git("rev-parse", "--short", "HEAD").stdout.strip() or "unknown"
    return f"{sha}-dirty" if git("status", "--porcelain", "--untracked-files=no").stdout.strip() else sha


def _corpus_ready() -> bool:
    try:
        import chromadb

        from aiq_agent.oib_sync import CHROMA_DIR

        return chromadb.PersistentClient(str(CHROMA_DIR)).get_collection("oib_knowledge").count() > 0
    except Exception:
        return False


def inventory_database() -> Path | None:
    """The SQLite file the runs will read the document inventory from, or None when it is not SQLite.

    ``AIQ_SUMMARY_DB`` or the config's default, ``./summaries.db``. A relative
    path is resolved against the REPO ROOT, because that is the working
    directory every run's ``nat run`` gets (``census.run_once``), whatever
    directory the suite itself was started from. A worktree has its own root,
    and its own empty ``summaries.db``.
    """
    url = os.environ.get("AIQ_SUMMARY_DB") or "sqlite+aiosqlite:///./summaries.db"
    prefix = "sqlite+aiosqlite:///"
    if not url.startswith(prefix):
        return None
    path = Path(url[len(prefix) :])
    return (path if path.is_absolute() else ROOT / path).resolve()


def foreign_imports(out: Path) -> list[str]:
    """The packages a run would import from outside this checkout: ``name: path``, empty when none.

    Asked of the interpreter the runs use (``census.run_python``), with the
    path they get (``census.tree_pythonpath``): a report names this checkout's commit, so
    every package it measured must come from this checkout.
    """
    import subprocess

    names = ("aiq_agent", *source_packages())
    probe = f"import {', '.join(names)}; print({', '.join(f'{name}.__file__' for name in names)}, sep=chr(10))"
    env = {**os.environ, "PYTHONPATH": tree_pythonpath(out)}
    shown = subprocess.run([run_python(), "-c", probe], cwd=ROOT, env=env, capture_output=True, text=True, check=False)
    if shown.returncode != 0:
        return [f"import failed: {shown.stderr.strip().splitlines()[-1] if shown.stderr.strip() else shown.returncode}"]
    root = ROOT.resolve()
    return [
        f"{name}: {path}"
        for name, path in zip(names, shown.stdout.splitlines(), strict=False)
        if not Path(path).resolve().is_relative_to(root)
    ]


def inventory_ready(path: Path | None) -> bool:
    """Whether the runs will see the corpus's documents: an inventory, family overviews, quote checks.

    Not optional. Without it every run answers blind to what the corpus holds
    and verifies no quote, and does it without an error: a worktree run once
    measured 38.5 s per turn against 31.3 s for the same code with the
    inventory, and every search-round number with it.
    """
    if path is None:
        return True  # not SQLite: the deployment's own store, not ours to check
    import sqlite3
    from contextlib import closing

    # as_uri() escapes what a URI would read as syntax: a `#` or `?` in the
    # path once opened an empty database beside the real one and said "empty".
    # closing(), because a connection's own `with` commits and stays open.
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            (count,) = db.execute(
                "SELECT count(*) FROM document_metadata WHERE collection = 'oib_knowledge'"
            ).fetchone()
    except sqlite3.Error:
        return False
    return count > 0


def run_suite(
    questions: list[dict],
    runs: int,
    out: Path,
    workers: int,
    overrides: list[list[str]] | None,
    stamp: str | None = None,
) -> list[Run]:
    """Every question ``runs`` times, ``workers`` at once; each recorded as ``suite-{stamp}-{id}-{run}``."""
    out.mkdir(parents=True, exist_ok=True)
    stamp = stamp or run_stamp()
    jobs = [(question, index) for question in questions for index in range(1, runs + 1)]

    def one(job: tuple[dict, int]) -> Run:
        question, index = job
        conversation = f"suite-{stamp}-{question['id']}-{index}"
        try:
            record = run_once(str(question["question"]).strip(), out, conversation, overrides)
            result = observe(question, index, record, record.with_suffix(".log"))
        except Exception as exc:  # noqa: BLE001 - one run's failure is that run's, not the suite's
            result = Run(question_id=str(question["id"]), run=index, error=f"{type(exc).__name__}: {exc}")
        print(f"  {question['id']} #{index}: {result.wall_s}s, {result.research_calls} call(s)", flush=True)
        return result

    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        return list(pool.map(one, jobs))
    finally:
        # On Ctrl-C the queued paid runs are cancelled, not started one by one.
        pool.shutdown(wait=True, cancel_futures=True)


def recording(folder: Path, stamp: str | None, run: Run) -> Path | None:
    """The recording one run left in ``folder``, or None.

    By the stamp results.json keeps. An older results.json has none: then the
    name must be ``suite-HHMMSS-pid-{id}-{run}``, so question ``gk4`` never
    picks up ``treppenhaus-gk4``'s recording, and the newest file wins.
    """
    if stamp:
        found = folder / f"suite-{stamp}-{run.question_id}-{run.run}.jsonl"
        return found if found.exists() else None
    exact = re.compile(rf"suite-\d{{6}}-\d+-{re.escape(run.question_id)}-{run.run}\.jsonl")
    candidates = [path for path in folder.glob("suite-*.jsonl") if exact.fullmatch(path.name)]
    return max(candidates, key=lambda path: path.stat().st_mtime, default=None)


def _rerender(report: Path, baseline: dict | None) -> int:
    """``--report``: re-read and re-check a results.json, and print it. No model calls.

    Re-read from the recordings beside results.json when they are there, and
    re-checked against the question set as it is NOW: a harness fix or a
    corrected expectation applies without paying for the runs again.
    """
    data = json.loads(report.read_text())
    runs = [Run(**row) for row in data["runs"]]
    by_id = {str(q["id"]): q for q in load_questions(core_only=False)[0]}
    for index, run in enumerate(runs):
        question = by_id.get(run.question_id)
        if question is None:
            continue
        found = recording(report.parent, data["meta"].get("stamp"), run)
        if found is not None:
            runs[index] = observe(question, run.run, found, found.with_suffix(".log"))
        elif not run.error:
            run.checks = check(question, run, run.envelope)
    print(render(runs, data.get("skipped", []), data["meta"], baseline, data.get("not_in_corpus", [])))
    return 0


def _preflight(out: Path, ingest: bool) -> int:
    """0 when the runs would measure what the report will say they measured, else 2 and why."""
    if not ensure_key():
        print("OPENROUTER_API_KEY is not set; the suite needs the real models.", file=sys.stderr)
        return 2
    if ingest:
        from aiq_agent import oib_sync

        print("ingesting the corpus:", oib_sync.sync())
    if not _corpus_ready():
        print(
            "The OIB corpus is not ingested into AIQ_CHROMA_DIR. Put the PDFs in data/oib and run with --ingest.",
            file=sys.stderr,
        )
        return 2
    foreign = foreign_imports(out)
    if foreign:
        print(
            "The runs would not measure this checkout: " + "; ".join(foreign) + ". Run the suite with this "
            "checkout's interpreter (task setup inside it), or measure from the checkout that holds the code.",
            file=sys.stderr,
        )
        return 2
    database = inventory_database()
    if not inventory_ready(database):
        print(
            f"The document inventory at {database} lists no corpus documents: runs would have no inventory, "
            "no family overviews and no quote checks. Point AIQ_SUMMARY_DB at the database the ingest wrote "
            "(sqlite+aiosqlite:////absolute/path/summaries.db).",
            file=sys.stderr,
        )
        return 2
    return 0


def select_questions(only: list[str] | None, every: bool) -> tuple[list[dict], list[str]] | None:
    """The questions to run and the ids skipped for a project; None (and why, on stderr) for a bad ``--only``."""
    if not only:
        return load_questions(core_only=not every)
    runnable, needs_project = load_questions(core_only=False)
    wanted = set(only)
    questions = [q for q in runnable if str(q["id"]) in wanted]
    missing = wanted - {str(q["id"]) for q in questions}
    if skipped := sorted(missing & set(needs_project)):
        print(f"Skipped, need a project (no backend in the suite): {', '.join(skipped)}", file=sys.stderr)
    if unknown := sorted(missing - set(needs_project)):
        print(f"No such question: {', '.join(unknown)}", file=sys.stderr)
    return None if missing else (questions, [])


def _warn_if_dirty(commit: str) -> None:
    # Every run starts its own process from the working tree, so an edit made
    # while the suite runs reaches the runs that start after it: one baseline
    # measured two codebases, and four answers crashed on a half-applied
    # signature change. Measure a clean tree, or a worktree.
    if commit.endswith("-dirty"):
        print(
            "suite: the working tree has uncommitted changes; runs measure whatever it holds when they start.",
            file=sys.stderr,
        )


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
        return _rerender(args.report, baseline)
    if failed := _preflight(args.out, args.ingest):
        return failed
    selected = select_questions(args.only, args.all)
    if selected is None:
        return 2
    questions, skipped = selected
    families = corpus_families()
    not_in_corpus = [f"{q['id']} ({lacking})" for q in questions if (lacking := lacking_family(q, families))]
    questions = [q for q in questions if lacking_family(q, families) is None]
    commit = source_commit()
    _warn_if_dirty(commit)
    stamp = run_stamp()
    meta = {
        "started": time.strftime("%Y-%m-%d %H:%M"),
        "commit": commit,
        "config": "configs/config_oib_openrouter.yml",
        "runs_per_question": args.runs,
        "overrides": args.override or [],
        "stamp": stamp,
    }
    print(f"{len(questions)} question(s) × {args.runs} run(s), {args.workers} at a time → {args.out}")
    runs = run_suite(questions, args.runs, args.out, args.workers, args.override, stamp)
    results = {"meta": meta, "skipped": skipped, "not_in_corpus": not_in_corpus, "runs": [asdict(r) for r in runs]}
    (args.out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1))
    report = render(runs, skipped, meta, baseline, not_in_corpus)
    (args.out / "report.md").write_text(report)
    print(report)
    print(f"Written: {args.out / 'report.md'}, {args.out / 'results.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
