"""Smoke: one real question through the real agent, and not one ERROR on the way.

The unit suites test pieces with their neighbours faked, and every issue
err2issue filed in September 2026 lived in a seam those fakes stand in for: a
tool schema the model's arguments did not fit (#656), a reply shape a parser
did not expect (#653), a payload a dependency's callback could not read (#635),
a workflow that did not build (#742-#752). Each one, when it happened, logged a
record at ERROR, and ERROR is exactly what the collector forwards to err2issue.

So this runs the shipped workflow (`configs/config_oib_openrouter.yml`, the
real prompt, the real model through OpenRouter, the real tools) on one
question with `nat run`, including the post-answer stages that finish after the
reply, and fails on what production would have filed:

- any log record at ERROR or CRITICAL,
- a traceback, or a RuntimeWarning (an unawaited coroutine is one),
- no answer inside the census timeout.

With the OIB corpus ingested (`AIQ_CHROMA_DIR`) it also asks the answer to be a
real one: not the "nothing found" reply, and about Brandschutz, which is what
OIB-Richtlinie 2 is. Without the corpus that check is skipped and says so; the
ERROR gate runs either way.

Needs `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`). One question costs one turn.

    python scripts/turn_census/smoke.py
    python scripts/turn_census/smoke.py "Welche Fluchtweglänge gilt in GK 4?" --out /tmp/smoke
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from census import TIMED_OUT  # noqa: E402  (a sibling script, not a package)
from census import ensure_key  # noqa: E402
from census import run_once  # noqa: E402
from census import run_stamp  # noqa: E402
from suite import _corpus_ready  # noqa: E402
from suite import final_answer  # noqa: E402

QUESTION = "Was weißt du über die OIB-Richtlinie 2?"

#: A log record at a level err2issue files: `2026-09-25 19:18:33 - ERROR    - module:line - …`.
_FILED_RECORD = re.compile(r"^\S+ \S+ - (ERROR|CRITICAL) +- ", re.MULTILINE)
_TRACEBACK = "Traceback (most recent call last)"
#: A RuntimeWarning, minus Python's own "Enable tracemalloc" hint that follows one.
_RUNTIME_WARNING = re.compile(r"^.*RuntimeWarning: (?!Enable tracemalloc).*$", re.MULTILINE)
_ANSI = re.compile(r"\x1b\[[0-9;]*m")

#: The replies that mean the turn found nothing to answer from.
_NOTHING_FOUND = "nichts gefunden, worauf sich"


@dataclass
class Verdict:
    """What one run showed. ``failures`` empty is a pass."""

    answer: str
    failures: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _counted(failures: list[str]) -> list[str]:
    """Each distinct failure once, in order, with how often it happened when more than once."""
    counts: dict[str, int] = {}
    for failure in failures:
        counts[failure] = counts.get(failure, 0) + 1
    return [failure if n == 1 else f"{failure} (x{n})" for failure, n in counts.items()]


def judge(log_text: str, *, corpus: bool) -> Verdict:
    """The smoke's verdict on one run's `nat run` output. Pure, so it is tested offline."""
    plain = _ANSI.sub("", log_text)
    verdict = Verdict(answer=final_answer(log_text))
    for match in _FILED_RECORD.finditer(plain):
        line = plain[match.start() : plain.find("\n", match.start())]
        verdict.failures.append(f"logged at {match.group(1)}: {line[:300]}")
    if _TRACEBACK in plain:
        at = plain.index(_TRACEBACK)
        verdict.failures.append(f"traceback: {plain[at : at + 600]}")
    verdict.failures.extend(f"warning: {m.group(0)[:300]}" for m in _RUNTIME_WARNING.finditer(plain))
    verdict.failures = _counted(verdict.failures)
    if TIMED_OUT in plain or not verdict.answer:
        verdict.failures.append("no answer before the census timeout")
        return verdict
    if not corpus:
        verdict.notes.append("no OIB corpus ingested: answer content not checked, only the ERROR gate")
        return verdict
    if _NOTHING_FOUND in verdict.answer:
        verdict.failures.append("the corpus is ingested and the answer says nothing was found")
    elif "brandschutz" not in verdict.answer.lower():
        verdict.failures.append("an answer about OIB-Richtlinie 2 that never says Brandschutz")
    return verdict


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("question", nargs="?", default=QUESTION)
    parser.add_argument("--out", type=Path, default=None, help="where the run's log is kept (default: a temp dir)")
    args = parser.parse_args(argv)
    if not ensure_key():
        print("smoke: OPENROUTER_API_KEY (or OPENROUTER_KEY) is not set; nothing ran", file=sys.stderr)
        return 2

    out = args.out or Path(tempfile.mkdtemp(prefix="smoke-"))
    out.mkdir(parents=True, exist_ok=True)
    conversation_id = f"smoke-{run_stamp()}"
    run_once(args.question, out, conversation_id)
    log = out / f"{conversation_id}.log"
    verdict = judge(log.read_text(errors="replace"), corpus=_corpus_ready())

    print(f"smoke: {args.question}")
    print(f"log: {log}")
    print(f"answer: {verdict.answer[:500]}")
    for note in verdict.notes:
        print(f"note: {note}")
    for failure in verdict.failures:
        print(f"FAIL {failure}")
    print("smoke: passed" if not verdict.failures else f"smoke: {len(verdict.failures)} failure(s)")
    return 1 if verdict.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
