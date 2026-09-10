#!/usr/bin/env python3

"""Keep the concept index pointing at files that exist.

Why this exists
---------------

``docs/architecture/where-is-what.md`` is a concept-to-path index: an agent
arrives with the name of a thing and leaves with the module that owns it. Its
whole value is that the paths resolve. A rename anywhere in the repo silently
turns a row into a dead end, and the symptom is the one the index was written to
remove — somebody greps.

Nothing else catches it. The paths sit in code spans rather than links, so
``markdown-link-check`` never looks at them, and the file type-checks and builds
like any other Markdown.

What it checks
--------------

Every backticked span in the index that looks like a repository path (it
contains a ``/`` or ends in a known source extension, and is not prose, a
command or an identifier) names something **git tracks** — a file or a
directory. Tracked, not merely present: a path that resolves only in the
author's working tree is dead for every other reader.

A claim is read from the repository root first and from the index's own
directory second, which is how a reader reads it: the sibling docs are named
``document-roles.md`` in the prose and live beside the index.

Usage:
    python scripts/check_doc_paths.py [--list]

Exit code is 0 when every path resolves, 1 otherwise.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

INDEX = Path("docs/architecture/where-is-what.md")

CODE_SPAN_RE = re.compile(r"`([^`\n]+)`")

# Extensions that make a bare filename (no slash) a path claim.
SOURCE_SUFFIXES = (
    ".py",
    ".ts",
    ".tsx",
    ".mjs",
    ".md",
    ".json",
    ".sql",
    ".yml",
    ".yaml",
)

# A span is a path claim only if it is shaped like one. Everything else in this
# file is a symbol (`fileGeneratedDocument`), a constant (`SOURCE_KINDS`), a
# command (`task release:note -- <slug>`) or a word in quotes.
PATH_SHAPE_RE = re.compile(r"^[A-Za-z0-9._\-/\[\]]+$")


def tracked_paths() -> set[str]:
    """Every file git knows about, plus every directory that holds one."""
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    files = set(out.splitlines())
    directories = {parent.as_posix() for f in files for parent in Path(f).parents if parent.as_posix() != "."}
    return files | directories


def is_path_claim(span: str) -> bool:
    """Whether this code span promises a repository path."""
    if not PATH_SHAPE_RE.match(span):
        return False
    if span.startswith(("http://", "https://", "/", ".")):
        # A leading dot is a bare suffix (`.down.sql`) or a glob, never a row's path.
        return False
    return "/" in span or span.endswith(SOURCE_SUFFIXES)


def path_claims(text: str) -> list[str]:
    """Every distinct path claim in the index, in the order it appears."""
    seen: dict[str, None] = {}
    for span in CODE_SPAN_RE.findall(text):
        candidate = span.strip()
        if is_path_claim(candidate):
            seen.setdefault(candidate, None)
    return list(seen)


def check(errors: list[str]) -> list[str]:
    """Validate every path claim, appending to ``errors``. Returns the claims."""
    if not INDEX.exists():
        errors.append(f"{INDEX}: the concept index is missing.")
        return []

    tracked = tracked_paths()
    claims = path_claims(INDEX.read_text(encoding="utf-8"))
    for claim in claims:
        beside_index = (INDEX.parent / claim).as_posix()
        if claim in tracked or beside_index in tracked:
            continue
        if Path(claim).exists():
            errors.append(f"{INDEX}: `{claim}` exists but git does not track it, so the row is dead for other readers.")
            continue
        errors.append(f"{INDEX}: `{claim}` does not exist. Update the row, or delete it.")
    return claims


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: validate the concept index and return an exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="List the path claims found and exit 0.")
    args = parser.parse_args(argv)

    if args.list:
        for claim in path_claims(INDEX.read_text(encoding="utf-8")):
            print(claim)
        return 0

    errors: list[str] = []
    claims = check(errors)

    if errors:
        print(f"Doc-path check FAILED ({len(errors)} error(s)):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"Doc-path check passed: {len(claims)} path(s) in {INDEX} resolve.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
