#!/usr/bin/env python3
"""Fail a PR that changes what the product does but ships no release note.

The rule (AGENTS.md, "Release notes are mandatory"): a change a customer can
notice carries its note in the same pull request. The note is published to
https://piloti.at/changelog on merge, so the PR is the last moment at which the
person who knows what changed is still the one writing it down.

Two questions decide it, and the second is the one that used to be missing:

1. Which files are product? The agent backend, the API, the app UI. Tests,
   specs, fixtures, docs and the marketing site are excluded: they change
   nothing a user of the app can observe.
2. Does a product file's diff change what the program DOES? A hunk that differs
   only in comments, indentation or the spelling of an escape (`\\uFEFF` against
   the character itself) does not, so it needs no note. Anything the check
   cannot read as text (a binary, a mode change, a new file with code in it)
   counts as a change, because the failure it guards against is a silent one.

Escape hatch: the `no-release-note` label on the PR, for the genuinely invisible
change that this check still cannot see. The workflow skips this script entirely
when it is set.

Usage: require_release_note.py <base-sha> <head-sha>
"""

from __future__ import annotations

import re
import subprocess
import sys

NOTES_PREFIX = "releasenotes/notes/"

# Product surfaces: touching one of these is what makes a note mandatory.
PRODUCT_PATTERNS = [
    re.compile(r"^src/aiq_agent/"),
    re.compile(r"^sources/[^/]+/src/"),
    re.compile(r"^frontends/aiq_api/src/"),
    re.compile(r"^frontends/ui/src/"),
    re.compile(r"^frontends/cli/src/"),
]

# ...except for the parts of them that only a developer ever sees.
EXEMPT_PATTERNS = [
    re.compile(r"(^|/)tests?/"),
    re.compile(r"\.spec\.(ts|tsx|js|jsx)$"),
    re.compile(r"(^|/)(test_[^/]+|[^/]+_test)\.py$"),
    re.compile(r"\.(md|snap)$"),
    re.compile(r"(^|/)__(mocks|fixtures)__/"),
]

# A whole-line comment, by language. `*` is a JSDoc continuation only in
# TypeScript and JavaScript: in Python a leading `*` is the multiplication that
# continues an expression across lines, and it is code.
_COMMENT_ONLY = {
    ".py": re.compile(r"#"),
    ".ts": re.compile(r"//|/\*|\*/|\*(\s|$)"),
}
_COMMENT_ONLY[".tsx"] = _COMMENT_ONLY[".ts"]
_COMMENT_ONLY[".js"] = _COMMENT_ONLY[".ts"]
_COMMENT_ONLY[".jsx"] = _COMMENT_ONLY[".ts"]

_ESCAPE = re.compile(r"\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})")


def changed_files(base: str, head: str) -> list[str]:
    """Files the PR touches, via the merge base so unrelated base commits do not count."""
    for revs in (f"{base}...{head}", f"{base} {head}"):
        result = subprocess.run(
            ["git", "diff", "--name-only", *revs.split()],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return [line.strip() for line in result.stdout.splitlines() if line.strip()]
    print("Could not diff the pull request against its base — skipping the check.", file=sys.stderr)
    return []


def needs_note(files: list[str]) -> list[str]:
    """The touched files that are product, before any look at what changed in them."""
    return [
        path
        for path in files
        if any(p.search(path) for p in PRODUCT_PATTERNS) and not any(e.search(path) for e in EXEMPT_PATTERNS)
    ]


def has_note(files: list[str]) -> bool:
    return any(path.startswith(NOTES_PREFIX) and path.endswith(".yaml") for path in files)


def _hunks(diff: str) -> list[tuple[list[str], list[str]]]:
    """The removed and added lines of each hunk. Headers come before the first `@@`."""
    hunks: list[tuple[list[str], list[str]]] = []
    removed: list[str] = []
    added: list[str] = []
    in_hunk = False
    for line in diff.splitlines():
        if line.startswith("@@"):
            if in_hunk:
                hunks.append((removed, added))
            removed, added, in_hunk = [], [], True
        elif in_hunk and line.startswith("-"):
            removed.append(line[1:])
        elif in_hunk and line.startswith("+"):
            added.append(line[1:])
    if in_hunk:
        hunks.append((removed, added))
    return hunks


def _as_program_sees_it(lines: list[str], path: str) -> list[str]:
    """Each line with comments, indentation and escape spelling taken out."""
    comment = next((pattern for suffix, pattern in _COMMENT_ONLY.items() if path.endswith(suffix)), None)
    out = []
    for line in lines:
        text = line.strip()
        if not text or (comment is not None and comment.match(text)):
            continue
        out.append(_ESCAPE.sub(lambda m: chr(int(m.group(1) or m.group(2), 16)), text))
    return out


def visible_change(path: str, diff: str) -> bool:
    """Whether a file's diff changes what the program does, not only how it is written.

    `diff` is `git diff -U0` output for the one file. A hunk counts as no change
    when what its removed lines do equals what its added lines do, in order.
    """
    hunks = _hunks(diff)
    if not hunks:
        # A binary, a mode change, or a rename without edits: nothing to read, so
        # it is a change. An empty diff is not a change at all.
        return bool(diff.strip())
    return any(_as_program_sees_it(removed, path) != _as_program_sees_it(added, path) for removed, added in hunks)


def file_diff(base: str, head: str, path: str) -> str:
    result = subprocess.run(
        ["git", "diff", "-U0", "--no-color", f"{base}...{head}", "--", path],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    files = changed_files(argv[1], argv[2])
    if not files:
        return 0

    candidates = needs_note(files)
    triggers = [path for path in candidates if visible_change(path, file_diff(argv[1], argv[2], path))]
    if not triggers:
        print("No change in this PR alters what the product does — no release note required.")
        return 0
    if has_note(files):
        print(f"Release note present for {len(triggers)} changed product file(s).")
        return 0

    shown = "\n".join(f"    {path}" for path in triggers[:10])
    more = f"\n    …and {len(triggers) - 10} more" if len(triggers) > 10 else ""
    print(
        "This pull request changes the product but adds no release note:\n\n"
        f"{shown}{more}\n\n"
        "Write one — it is published to https://piloti.at/changelog when this merges:\n\n"
        "    task release:note -- short-slug\n"
        "    # edit releasenotes/notes/short-slug-<hash>.yaml, keep one section\n"
        "    task release:lint\n\n"
        "Plain sentences, written for the architect using Piloti. The rules are in\n"
        "docs/contributing/release-notes.md.\n\n"
        "If this change genuinely cannot be noticed by a user (refactor, internal\n"
        "tooling, infrastructure), add the `no-release-note` label to the PR.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
