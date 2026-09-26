"""Smoke: what a reader does, through what a reader reaches, and not one ERROR on the way.

The unit suites test pieces with their neighbours faked, and every issue
err2issue filed in September 2026 lived in a seam those fakes stand in for: a
tool schema the model's arguments did not fit (#656), a reply shape a parser
did not expect (#653), a payload a dependency's callback could not read (#635),
a turn cancelled mid-answer whose teardown ran in a foreign Context (#334,
#337, #338, #759), a socket closed during a keepalive ping (#758). Each one,
when it happened, logged a record at ERROR, and ERROR is exactly what the
collector forwards to err2issue.

So this serves the backend the way the container does (``deploy/start_web.py``,
the shipped config, prompt, model and tools) and drives it over the chat socket
the way the UI does (``served.py``), with two things a reader does:

1. ask the question and read the answer to its COMPLETE frame;
2. ask it again and, while that answer is still being written, send a
   follow-up: the first turn is cancelled, and the follow-up must complete.

Then it waits for the post-answer stages to go quiet, and fails on what
production would have filed from the moment the first question was sent:

- any log record at ERROR or CRITICAL,
- a traceback, or a RuntimeWarning (an unawaited coroutine is one),
- no answer, or a follow-up that never completed.

A backend that never starts serving fails too. What it logs while starting is
shown as a note: this runs without the BFF, and the startup check of the
BFF's internal API rightly says so.

With the OIB corpus ingested (`AIQ_CHROMA_DIR`) it also asks the answer to be a
real one: none of the canned non-answers (`canned_replies.NON_ANSWER_PREFIXES`),
and at least one `[KB]` source in its Quellen, the origin token the backend
(never the model) writes for a knowledge-base passage. For the default question
the answer must also be about Brandschutz, which is what OIB-Richtlinie 2 is.
Without the corpus those checks are skipped and say so, unless
`--require-corpus` says one should be there (the CI passes it once a snapshot
is published); the ERROR gate runs either way.

Needs `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`). A run costs about two turns.

    python scripts/turn_census/smoke.py
    python scripts/turn_census/smoke.py "Welche Fluchtweglänge gilt in GK 4?" --out /tmp/smoke
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
import tempfile
import time
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import served  # noqa: E402  (a sibling script, not a package)
from census import ensure_key  # noqa: E402
from suite import _corpus_ready  # noqa: E402

from aiq_agent.common.canned_replies import NON_ANSWER_PREFIXES  # noqa: E402

QUESTION = "Was weißt du über die OIB-Richtlinie 2?"
#: Sent while the answer to the question is still being written, which cancels that turn.
FOLLOW_UP = "Danke, das reicht."
#: The post-answer stages are done once the log has been quiet this long.
_QUIET_SECONDS = 15
_SETTLE_LIMIT_SECONDS = 180

#: A log record at a level err2issue files: `2026-09-25 19:18:33 - ERROR    - module:line - …`.
_FILED_RECORD = re.compile(r"^\S+ \S+ - (ERROR|CRITICAL) +- ", re.MULTILINE)
_TRACEBACK = "Traceback (most recent call last)"
#: A RuntimeWarning, minus Python's own "Enable tracemalloc" hint that follows one.
_RUNTIME_WARNING = re.compile(r"^.*RuntimeWarning: (?!Enable tracemalloc).*$", re.MULTILINE)
_ANSI = re.compile(r"\x1b\[[0-9;]*m")

#: A Quellen line naming a knowledge-base passage: `- [1] [KB] oib-rl_2_….pdf, p.1`.
#: `[KB]` is `citation_verification.source_origin_token`, deterministic backend output.
_KB_SOURCE = re.compile(r"^\s*[-*]\s*\[\d+\]\s*\[KB\]", re.MULTILINE)


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


def judge(
    log_text: str,
    *,
    answer: str,
    corpus: bool,
    question: str = QUESTION,
    require_corpus: bool = False,
    follow_up_completed: bool = True,
) -> Verdict:
    """The smoke's verdict on the server log from the first turn on, and what the turns sent back. Pure."""
    plain = _ANSI.sub("", log_text)
    verdict = Verdict(answer=answer)
    for match in _FILED_RECORD.finditer(plain):
        line = plain[match.start() : plain.find("\n", match.start())]
        verdict.failures.append(f"logged at {match.group(1)}: {line[:300]}")
    if _TRACEBACK in plain:
        at = plain.index(_TRACEBACK)
        verdict.failures.append(f"traceback: {plain[at : at + 600]}")
    verdict.failures.extend(f"warning: {m.group(0)[:300]}" for m in _RUNTIME_WARNING.finditer(plain))
    verdict.failures = _counted(verdict.failures)
    if not follow_up_completed:
        verdict.failures.append("the turn sent after a cancel never completed")
    if not answer:
        verdict.failures.append("no answer")
        return verdict
    if not corpus:
        if require_corpus:
            verdict.failures.append("a corpus snapshot is published but none is ingested here")
        else:
            verdict.notes.append("no OIB corpus ingested: answer content not checked, only the ERROR gate")
        return verdict
    verdict.failures.extend(_content_failures(answer, question))
    return verdict


def startup_notes(log_text: str) -> list[str]:
    """ERROR records from before the first turn: shown, not failed on (the backend runs without its BFF)."""
    plain = _ANSI.sub("", log_text)
    return [
        f"while starting, logged at {m.group(1)}: {plain[m.start() : plain.find(chr(10), m.start())][:240]}"
        for m in _FILED_RECORD.finditer(plain)
    ]


def _content_failures(answer: str, question: str) -> list[str]:
    """What is wrong with an answer given with the corpus ingested: a non-answer, no KB source, off topic."""
    if answer.startswith(NON_ANSWER_PREFIXES):
        return [f"the corpus is ingested and the answer is a canned non-answer: {answer[:120]}"]
    failures = []
    if not _KB_SOURCE.search(answer):
        failures.append("the corpus is ingested and the answer cites no [KB] source")
    if question == QUESTION and "brandschutz" not in answer.lower():
        failures.append("an answer about OIB-Richtlinie 2 that never says Brandschutz")
    return failures


async def _run(server: served.Server, question: str) -> tuple[served.Turn, served.Turn]:
    answered = await served.ask(server.socket_url, question)
    after_cancel = await served.ask_and_interrupt(server, question, FOLLOW_UP)
    return answered, after_cancel


def _wait_until_quiet(server: served.Server) -> None:
    """Let the post-answer stages finish: until the log has not grown for a while, or the limit."""
    deadline = time.monotonic() + _SETTLE_LIMIT_SECONDS
    size, quiet_since = server.log_offset(), time.monotonic()
    while time.monotonic() < deadline and time.monotonic() - quiet_since < _QUIET_SECONDS:
        time.sleep(1)
        if (now := server.log_offset()) != size:
            size, quiet_since = now, time.monotonic()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("question", nargs="?", default=QUESTION)
    parser.add_argument("--out", type=Path, default=None, help="where the server log is kept (default: a temp dir)")
    parser.add_argument(
        "--require-corpus",
        action="store_true",
        help="fail when no corpus is ingested instead of skipping the content checks",
    )
    args = parser.parse_args(argv)
    if not ensure_key():
        print("smoke: OPENROUTER_API_KEY (or OPENROUTER_KEY) is not set; nothing ran", file=sys.stderr)
        return 2

    out = args.out or Path(tempfile.mkdtemp(prefix="smoke-"))
    log = out / "server.log"
    try:
        with served.serve(log) as server:
            first_turn = server.log_offset()
            answered, after_cancel = asyncio.run(_run(server, args.question))
            _wait_until_quiet(server)
            turns_log = server.log_since(first_turn)
            boot_log = log.read_text(errors="replace")[:first_turn]
    except (RuntimeError, TimeoutError) as exc:
        print(f"smoke: {args.question}\nlog: {log}\nFAIL {exc}")
        return 1
    verdict = judge(
        turns_log,
        answer=answered.answer,
        corpus=_corpus_ready(),
        question=args.question,
        require_corpus=args.require_corpus,
        follow_up_completed=after_cancel.completed,
    )
    verdict.notes[:0] = startup_notes(boot_log)

    print(f"smoke: {args.question}")
    print(f"log: {log}")
    print(f"answer: {verdict.answer[:500]}")
    if answered.clarifications:
        print(f"answered {answered.clarifications} clarifying question(s) as a reader would")
    print(f"cancelled mid-answer, then the follow-up answered in {after_cancel.frames} frame(s)")
    for note in verdict.notes:
        print(f"note: {note}")
    for failure in verdict.failures:
        print(f"FAIL {failure}")
    print("smoke: passed" if not verdict.failures else f"smoke: {len(verdict.failures)} failure(s)")
    return 1 if verdict.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
