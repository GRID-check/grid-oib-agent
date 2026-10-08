#!/usr/bin/env python3
"""Comments and docstrings say what is true now; how the code got here lives in commits and ADRs.

A comment that narrates the past ("used to", "since 2026-10-06", "found by a
review", "the old code did") is stale the day it lands: the reader acts on the
code in front of them, and the history competes with what is true for their
attention. The commit message and the ADR are where history belongs, and
`git log -L` finds it for anyone who needs it.

Reads only comments and docstrings, never strings or code, so a date in a
fixture or a German prompt is not its business. Exits 1 and prints
`path:line: text` for every hit. `--files-only` prints each offending file once;
`--broad` adds the phrases that read as history only sometimes, to find files to clean.

    python3 scripts/check_history_comments.py [paths...]   # default: every tracked file it reads
"""

from __future__ import annotations

import ast
import io
import re
import subprocess
import sys
import tokenize
from pathlib import Path

SCRIPT_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs"}
HASH_SUFFIXES = {".yml", ".yaml", ".sh", ".toml"}
#: History is the point of these: migrations, ADRs, release notes, the changelog, and the
#: dated ledger of accepted security findings (each entry needs its date and expiry).
EXCLUDED = re.compile(
    r"(^|/)(drizzle/|docs/|releasenotes/|node_modules/|\.venv/|CHANGELOG)|(^|/)\.trivyignore\.yaml$|\.lock$|-lock\.yaml$"
)

_MONTHS = r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jän|Mär|Mai|Okt|Dez)[a-zä]*\.?"
#: Unmistakable history: what the gate refuses. A date in a test may be a fixture, so a test's
#: bare day counts only after since/until/as of; everywhere else any calendar day does.
_ANCHORED_DAY = rf"\b(since|until|before|after|as of|seit|bis|from) (20\d\d-\d\d-\d\d|\d{{1,2}}\.? {_MONTHS})"
_SIGNALS = [
    _ANCHORED_DAY,
    r"\b(it|this|that|which|they|we|he|she|there) used to\b",
    r"\bused to be\b",
    r"\b(originally|formerly|historically)\b",
    r"\bfound by (an? )?(independent )?(re-?review|review|reviewer|audit)\b",
    r"\b(was|were) (renamed|removed|deleted|replaced|moved|introduced|rewritten|reverted) (in|by|on|when|with)\b",
    r"\bthe old (code|version|rule|behaviou?r|path|implementation|name|route|approach|matcher)\b",
    r"\bbefore (ticket|this change|this fix|this commit|the fix)\b",
    r"\bcommit [0-9a-f]{7,40}\b",
    r"\bPR #\d+\b",
]
_ANY_DAY = [r"\b20\d\d-\d\d-\d\d\b", rf"\b\d{{1,2}}\.? {_MONTHS} 20\d\d\b"]
HISTORY = re.compile("|".join(_SIGNALS + _ANY_DAY), re.IGNORECASE)
HISTORY_IN_TESTS = re.compile("|".join(_SIGNALS), re.IGNORECASE)
#: `--broad`: for finding the files to clean, never for the gate. These read as history as often
#: as not ("the secret used to sign", "a token no longer valid"); a reader decides, not a regex.
BROAD = re.compile("|".join(_SIGNALS + _ANY_DAY + [r"\bused to\b", r"\bno longer\b", r"\bpreviously\b"]), re.IGNORECASE)
_TEST = re.compile(r"(^|/)(tests?/|__tests__/)|\.(spec|test)\.[jt]sx?$|(^|/)test_[^/]*\.py$")


def _python_comments(text: str) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    try:
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type == tokenize.COMMENT:
                found.append((token.start[0], token.string))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return found
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return found
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant):
                value = body[0].value.value
                if isinstance(value, str):
                    start = body[0].lineno
                    found.extend((start + offset, line) for offset, line in enumerate(value.splitlines()))
    return found


_LINE_COMMENT = re.compile(r"(?:^|[\s;{}(),])//(.*)$")


def _script_comments(text: str) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    in_block = False
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if in_block:
            found.append((number, stripped))
            in_block = "*/" not in stripped
            continue
        if stripped.startswith("/*"):
            found.append((number, stripped))
            in_block = "*/" not in stripped[2:]
            continue
        match = _LINE_COMMENT.search(line)
        if match and "://" not in line[max(0, match.start() - 6) : match.start() + 3]:
            found.append((number, match.group(1)))
    return found


def _hash_comments(text: str) -> list[tuple[int, str]]:
    return [(n, line.strip()) for n, line in enumerate(text.splitlines(), start=1) if line.lstrip().startswith("#")]


def comments_of(path: Path) -> list[tuple[int, str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    if path.suffix == ".py":
        return _python_comments(text)
    if path.suffix in SCRIPT_SUFFIXES:
        return _script_comments(text)
    if path.suffix in HASH_SUFFIXES:
        return _hash_comments(text)
    return []


_QUOTED = re.compile(r"`[^`]*`|\"[^\"]*\"|„[^“\"]*[“\"]")


def history_in(path: Path, *, broad: bool = False) -> list[tuple[int, str]]:
    """The comment lines that narrate history; a quoted span (an example, a cited string) is not read."""
    pattern = BROAD if broad else HISTORY_IN_TESTS if _TEST.search(str(path)) else HISTORY
    return [(n, c.strip()) for n, c in comments_of(path) if pattern.search(_QUOTED.sub("", c))]


def _tracked() -> list[str]:
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return out.splitlines()


def main(argv: list[str]) -> int:
    files_only = "--files-only" in argv
    broad = "--broad" in argv
    paths = [a for a in argv if not a.startswith("--")] or _tracked()
    hits = 0
    for name in paths:
        if EXCLUDED.search(name):
            continue
        found = history_in(Path(name), broad=broad)
        if not found:
            continue
        hits += len(found)
        if files_only:
            print(name)
            continue
        for number, text in found:
            print(f"{name}:{number}: {text[:160]}")
    if hits and not files_only:
        print(
            f"\n{hits} comment line(s) narrate history. Say what is true now; "
            "how it got here goes in the commit message and, for a decision, the ADR.",
            file=sys.stderr,
        )
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
