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


def summarize(path: Path) -> dict:
    """One run's calls, grouped by kind, with the billed tokens and wall time."""
    rows = sorted((json.loads(line) for line in path.open()), key=lambda r: r["t_start"])
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


def run_once(question: str, out: Path, conversation_id: str, overrides: list[list[str]] | None = None) -> Path:
    """One `nat run` of the question with the recorder loaded; the JSONL it wrote."""
    record = out / f"{conversation_id}.jsonl"
    log = out / f"{conversation_id}.log"
    record.unlink(missing_ok=True)
    env = {**os.environ, "REC_OUT": str(record), "PYTHONPATH": str(HERE)}
    nat = (
        [sys.executable, "-m", "nat.cli.main"]
        if not (ROOT / ".venv/bin/nat").exists()
        else [str(ROOT / ".venv/bin/nat")]
    )
    cmd = [*nat, "run", "--config_file", str(CONFIG), "--input", question, "--conversation_id", conversation_id]
    for key, value in overrides or []:
        cmd += ["--override", key, value]
    with log.open("w") as sink:
        proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=sink, stderr=subprocess.STDOUT)
        deadline = time.time() + _TIMEOUT_SECONDS
        # `nat run` does not exit after answering (background exporters), so
        # the answer line is the end of the turn, plus a tail for the stages.
        while time.time() < deadline and proc.poll() is None:
            time.sleep(2)
            if "Workflow Result" in log.read_text(errors="replace"):
                time.sleep(_TAIL_SECONDS)
                break
        proc.kill()
    return record


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
    if not os.environ.get("OPENROUTER_API_KEY") and os.environ.get("OPENROUTER_KEY"):
        # Some environments carry the key under this name (docs/contributing/gotchas.md).
        os.environ["OPENROUTER_API_KEY"] = os.environ["OPENROUTER_KEY"]
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("OPENROUTER_API_KEY is not set; a census needs the real models.", file=sys.stderr)
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    # Unique per process: the conversation id keys the local checkpointer, and
    # two censuses sharing one would answer the second run with the first's history.
    stamp = f"{time.strftime('%H%M%S')}-{os.getpid()}"
    for index in range(args.runs):
        record = run_once(args.question, args.out, f"census-{stamp}-{index + 1}", args.override)
        _print(record.stem, summarize(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
