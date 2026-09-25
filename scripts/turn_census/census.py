"""Turn census: run one chat question through the real agent and count what it cost.

Every model call the turn makes — research rounds, the turn decision, passage
verdicts, the requery judge, reranks, embeddings — as the provider billed it:
input tokens, cached tokens, output, seconds. The number the turns audit
(`docs/architecture/turns-per-answer-audit-2026-09.md`) reconstructed by
hand, measured.

Needs what a local turn needs: OPENROUTER_API_KEY, and the corpus ingested
into AIQ_CHROMA_DIR (`python -c "from aiq_agent import oib_sync; oib_sync.sync()"`
after putting the OIB PDFs in data/oib). Every run costs real model calls.

    python scripts/turn_census/census.py "Was weißt du über die OIB 2?" --runs 3
    python scripts/turn_census/census.py --report /tmp/census/run1.jsonl
    python scripts/turn_census/census.py "…" --override llms.research_llm.reasoning_effort low
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CONFIG = ROOT / "configs" / "config_oib_openrouter.yml"
#: Seconds to wait after the answer for the post-answer stages to be recorded.
_TAIL_SECONDS = 20
_TIMEOUT_SECONDS = 600


def _kind(entry: dict) -> str:
    path = entry["url"].split("openrouter.ai")[-1]
    req = entry.get("req") or {}
    if path.endswith("/decisions"):
        return "decision" if len(req.get("questions") or {}) > 2 else "verdict"
    if path.endswith("/responses"):
        return "research" if req.get("input") != "ping" else "probe"
    if path.endswith("/chat/completions"):
        return "aux-llm"
    return path.rsplit("/", 1)[-1]


def records(path: Path) -> list[dict]:
    """The recorder's lines: none when the run made no model call, and a line the kill cut short is skipped."""
    if not path.exists():
        return []
    rows = []
    with path.open() as lines:
        for line in lines:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def ensure_key() -> bool:
    """OPENROUTER_API_KEY, or the OPENROUTER_KEY some environments carry instead (docs/contributing/gotchas.md)."""
    if not os.environ.get("OPENROUTER_API_KEY") and os.environ.get("OPENROUTER_KEY"):
        os.environ["OPENROUTER_API_KEY"] = os.environ["OPENROUTER_KEY"]
    return bool(os.environ.get("OPENROUTER_API_KEY"))


def summarize(path: Path) -> dict:
    """One run's calls, grouped by kind, with the billed tokens and wall time."""
    rows = sorted(records(path), key=lambda r: r["t_start"])
    kinds: dict[str, dict] = {}
    research: list[dict] = []
    for row in rows:
        kind = _kind(row)
        usage = row.get("usage") or {}
        details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
        tokens_in = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        bucket = kinds.setdefault(kind, {"calls": 0, "input": 0, "seconds": 0.0})
        bucket["calls"] += 1
        bucket["input"] += tokens_in
        bucket["seconds"] += row["t_end"] - row["t_start"]
        if kind == "research":
            research.append({"input": tokens_in, "cached": details.get("cached_tokens") or 0})
    wall = rows[-1]["t_end"] - rows[0]["t_start"] if rows else 0.0
    return {"kinds": kinds, "research": research, "wall_seconds": round(wall, 1)}


def _print(name: str, summary: dict) -> None:
    research = summary["research"]
    per_call = ", ".join(f"{r['input']}({r['cached']} cached)" for r in research)
    print(f"{name}: {len(research)} research call(s) [{per_call}]  wall {summary['wall_seconds']}s")
    for kind, bucket in sorted(summary["kinds"].items()):
        print(f"    {kind:10} {bucket['calls']:3} call(s)  {bucket['input']:7} in  {bucket['seconds']:5.1f}s")


_SHIM_LOCK = threading.Lock()


def run_stamp() -> str:
    """Unique per process: the conversation id keys the local checkpointer, and
    two runs sharing one would answer the second with the first's history."""
    return f"{time.strftime('%H%M%S')}-{os.getpid()}"


def source_packages() -> dict[str, Path]:
    """Each ``sources/`` package's import name and the directory it imports from."""
    import tomllib

    packages: dict[str, Path] = {}
    for pyproject in sorted((ROOT / "sources").glob("*/pyproject.toml")):
        setuptools = tomllib.loads(pyproject.read_text()).get("tool", {}).get("setuptools", {})
        for name, relative in setuptools.get("package-dir", {}).items():
            packages[name] = (pyproject.parent / relative).resolve()
    return packages


def tree_pythonpath(out: Path) -> str:
    """A PYTHONPATH that imports THIS checkout's code, whatever the venv installed.

    The venv installs ``aiq_agent`` and the ``sources/`` packages editable from
    ONE checkout. From a ``git worktree`` without its own venv, a run used to
    import the main checkout's code while the report named the worktree's
    commit. So ``src/`` goes first, and each ``sources/<pkg>`` is linked under
    its import name (their package dirs are called ``src``), ahead of the
    inherited path. The recorder's directory stays first.
    """
    import hashlib

    # One per checkout: two suites or censuses from different worktrees
    # sharing an --out would otherwise re-point each other's links.
    shim = out / f".tree-{hashlib.sha1(str(ROOT.resolve()).encode()).hexdigest()[:10]}"
    # The suite's workers call this at once: linking is serialised, and a link
    # that already points at the right package is left alone.
    with _SHIM_LOCK:
        shim.mkdir(parents=True, exist_ok=True)
        for name, target in source_packages().items():
            link = shim / name
            if link.is_symlink() and link.resolve() == target:
                continue
            # Built beside and renamed over: another process never sees
            # the link missing, and never trips on a half-made one.
            staged = shim / f".{name}.{os.getpid()}"
            staged.unlink(missing_ok=True)
            staged.symlink_to(target, target_is_directory=True)
            os.replace(staged, link)
    parts = [str(HERE), str(shim), str(ROOT / "src"), os.environ.get("PYTHONPATH", "")]
    return os.pathsep.join(part for part in parts if part)


def run_once(question: str, out: Path, conversation_id: str, overrides: list[list[str]] | None = None) -> Path:
    """One `nat run` of the question with the recorder loaded; the JSONL it wrote."""
    record = out / f"{conversation_id}.jsonl"
    log = out / f"{conversation_id}.log"
    record.unlink(missing_ok=True)
    env = {**os.environ, "REC_OUT": str(record), "PYTHONPATH": tree_pythonpath(out)}
    nat = (
        [sys.executable, "-m", "nat.cli.main"]
        if not (ROOT / ".venv/bin/nat").exists()
        else [str(ROOT / ".venv/bin/nat")]
    )
    cmd = [*nat, "run", "--config_file", str(CONFIG), "--input", question, "--conversation_id", conversation_id]
    for key, value in overrides or []:
        cmd += ["--override", key, value]
    with log.open("w") as sink:
        # Its own process group, so the kill reaches whatever `nat run` started.
        proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=sink, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.time() + _TIMEOUT_SECONDS
        answered = False
        # `nat run` does not exit after answering (background exporters), so
        # the answer line is the end of the turn, plus a tail for the stages.
        while time.time() < deadline and proc.poll() is None:
            time.sleep(2)
            if "Workflow Result" in log.read_text(errors="replace"):
                answered = True
                time.sleep(_TAIL_SECONDS)
                break
        _stop(proc)
    if not answered and time.time() >= deadline:
        with log.open("a") as sink:
            sink.write(f"\ncensus: timed out after {_TIMEOUT_SECONDS}s\n")
    return record


def _stop(proc: subprocess.Popen) -> None:
    """Kill the run's process group and reap it, so no zombie outlives the run."""
    import signal

    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("question", nargs="?")
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--out", type=Path, default=Path("/tmp/turn_census"))
    parser.add_argument("--report", type=Path, nargs="*", help="summarize recorded runs; no model calls")
    parser.add_argument(
        "--override",
        nargs=2,
        action="append",
        metavar=("KEY", "VALUE"),
        help="a config value for this census only, in `nat run` dot notation; repeatable",
    )
    args = parser.parse_args(argv)
    if args.report:
        for path in args.report:
            _print(path.stem, summarize(path))
        return 0
    if not args.question:
        parser.error("a question, or --report")
    if not ensure_key():
        print("OPENROUTER_API_KEY is not set; a census needs the real models.", file=sys.stderr)
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    stamp = run_stamp()
    for index in range(args.runs):
        record = run_once(args.question, args.out, f"census-{stamp}-{index + 1}", args.override)
        _print(record.stem, summarize(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
