#!/usr/bin/env python3
"""Fail a PR that changes what the product does but ships no release note.

The rule (AGENTS.md, "Release notes are mandatory"): a change a customer can
notice carries its note in the same pull request. The note is published to
https://piloti.at/changelog on merge, so the PR is the last moment at which the
person who knows what changed is still the one writing it down.

Two questions decide it:

1. Which files are product? The agent backend, the API, the app UI. Tests,
   specs, fixtures, docs and the marketing site are excluded: they change
   nothing a user of the app can observe.
2. Does a product file's diff change what the program DOES? A hunk that differs
   only in comments, in indentation outside Python, or in the spelling of an
   escape (`\\uFEFF` against the character itself) does not. Anything the check
   cannot read (a binary, a mode or rename change, bytes that are not UTF-8, a
   new or deleted file with code in it) counts as a change, because the failure
   it guards against is a silent one.

A note counts only when this PR adds it. Editing or deleting an old note does
not satisfy the rule.

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

# A backslash pair is kept as it is, so `\\uFEFF` (escaped backslash, then text)
# is never read as the escape `\uFEFF`.
_ESCAPE = re.compile(r"\\\\|\\u([0-9A-Fa-f]{4})|\\U([0-9A-Fa-f]{8})")
_HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")
_MODE_HEADERS = ("old mode ", "new mode ", "new file mode ", "deleted file mode ", "rename from ", "copy from ")


def _is_python(path: str) -> bool:
    return path.endswith(".py")


def _is_script(path: str) -> bool:
    return path.endswith((".ts", ".tsx", ".js", ".jsx"))


def _git(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", *args], capture_output=True, check=False)


def _revs(base: str, head: str) -> str:
    """The revision spec git can diff: the merge-base form, or the two commits when there is none."""
    for spec in (f"{base}...{head}", f"{base} {head}"):
        if _git("diff", "--quiet", *spec.split()).returncode in (0, 1):
            return spec
    return f"{base} {head}"


def _text(data: bytes) -> str | None:
    """The bytes as UTF-8 text, or None when they are not UTF-8."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def changed_files(base: str, head: str) -> list[str]:
    """Files the PR touches, via the merge base so unrelated base commits do not count."""
    result = _git("diff", "--name-only", *_revs(base, head).split())
    if result.returncode != 0:
        print("Could not diff the pull request against its base — skipping the check.", file=sys.stderr)
        return []
    return [line.strip() for line in result.stdout.decode().splitlines() if line.strip()]


def added_files(base: str, head: str) -> list[str]:
    """Files the PR adds. A note the PR deletes or edits does not count."""
    result = _git("diff", "--name-only", "--diff-filter=A", *_revs(base, head).split())
    return [line.strip() for line in result.stdout.decode().splitlines() if line.strip()]


def needs_note(files: list[str]) -> list[str]:
    """The touched files that are product, before any look at what changed in them."""
    return [
        path
        for path in files
        if any(p.search(path) for p in PRODUCT_PATTERNS) and not any(e.search(path) for e in EXEMPT_PATTERNS)
    ]


def has_note(files: list[str]) -> bool:
    return any(path.startswith(NOTES_PREFIX) and path.endswith(".yaml") for path in files)


def _hunks(diff: str) -> list[tuple[list[tuple[int, str]], list[tuple[int, str]]]]:
    """The removed and added lines of each hunk, each with its line number in its file."""
    hunks: list[tuple[list[tuple[int, str]], list[tuple[int, str]]]] = []
    removed: list[tuple[int, str]] = []
    added: list[tuple[int, str]] = []
    old_no = new_no = 0
    in_hunk = False
    for line in diff.splitlines():
        match = _HUNK.match(line)
        if match:
            if in_hunk:
                hunks.append((removed, added))
            removed, added = [], []
            old_no, new_no = int(match.group(1)), int(match.group(2))
            in_hunk = True
        elif in_hunk and line.startswith("-"):
            removed.append((old_no, line[1:]))
            old_no += 1
        elif in_hunk and line.startswith("+"):
            added.append((new_no, line[1:]))
            new_no += 1
    if in_hunk:
        hunks.append((removed, added))
    return hunks


def _block_comment_lines(text: str) -> set[int]:
    """Line numbers inside a /* ... */ comment, including its opening and closing lines.

    Approximate: a `/*` inside a string literal is read as a comment opener.
    """
    inside: set[int] = set()
    in_block = False
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if in_block:
            inside.add(number)
            if "*/" in stripped:
                in_block = False
        elif stripped.startswith("/*"):
            inside.add(number)
            in_block = "*/" not in stripped
    return inside


def _as_program_sees_it(lines: list[tuple[int, str]], path: str, block_lines: set[int]) -> list[str]:
    """Each line with comments and escape spelling taken out.

    Python keeps its indentation: moving a statement into a block changes when it
    runs. In script files a `*`-led line is a comment only inside a block comment,
    since elsewhere it continues a multiplication.
    """
    out = []
    for number, line in lines:
        if _is_python(path):
            text = line.rstrip()
            if not text.strip() or text.lstrip().startswith("#"):
                continue
            out.append(_unescape(text))
            continue
        text = line.strip()
        if not text or _is_script_comment(text, number in block_lines):
            continue
        out.append(_unescape(text))
    return out


_COMPLETE_BLOCK = re.compile(r"/\*.*?\*/")


def _is_script_comment(text: str, in_block: bool) -> bool:
    """A line is a comment only when nothing of it is code once comments are removed.

    `/* note */ export const X = 1` is code: dropping the line would hide a change
    to `X` from the release-note check.
    """
    if text.startswith("//"):
        return True
    if in_block and text.startswith("*") and not text.startswith("*/"):
        return True
    if text.startswith("*/"):
        text = text[2:]
    rest = _COMPLETE_BLOCK.sub("", text).strip()
    return not rest or rest.startswith("/*")


def _unescape(text: str) -> str:
    def spell_out(match: re.Match[str]) -> str:
        if match.group(0) == "\\\\":
            return match.group(0)
        return chr(int(match.group(1) or match.group(2), 16))

    return _ESCAPE.sub(spell_out, text)


def visible_change(path: str, diff: str | None, old: str | None = None, new: str | None = None) -> bool:
    """Whether a file's diff changes what the program does, not only how it is written.

    `diff` is `git diff -U0` output for the one file, or None when git's output is
    not UTF-8. `old` and `new` are the file before and after, when they could be
    read; they give the block-comment context a `*`-led line needs.
    A hunk counts as no change when its removed lines and its added lines do the
    same things, in order.
    """
    if diff is None:
        return True
    if any(line.startswith(_MODE_HEADERS) for line in diff.splitlines()):
        return True
    hunks = _hunks(diff)
    if not hunks:
        # Nothing to read, and not a mode change: an empty diff is not a change.
        return bool(diff.strip())
    script = _is_script(path)
    old_block = _block_comment_lines(old) if script and old is not None else set()
    new_block = _block_comment_lines(new) if script and new is not None else set()
    return any(
        _as_program_sees_it(removed, path, old_block) != _as_program_sees_it(added, path, new_block)
        for removed, added in hunks
    )


def _file_at(rev: str, path: str) -> str | None:
    result = _git("show", f"{rev}:{path}")
    return _text(result.stdout) if result.returncode == 0 else None


def file_diff(base: str, head: str, path: str) -> str | None:
    result = _git("diff", "-U0", "--no-color", *_revs(base, head).split(), "--", path)
    return _text(result.stdout)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    base, head = argv[1], argv[2]
    files = changed_files(base, head)
    if not files:
        return 0

    triggers = [
        path
        for path in needs_note(files)
        if visible_change(path, file_diff(base, head, path), old=_file_at(base, path), new=_file_at(head, path))
    ]
    if not triggers:
        print("No change in this PR alters what the product does — no release note required.")
        return 0
    if has_note(added_files(base, head)):
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
