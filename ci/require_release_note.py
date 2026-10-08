#!/usr/bin/env python3
"""Fail a PR that touches a product file but adds no release note.

The rule (AGENTS.md, "Release notes are mandatory"): a change a customer can
notice carries its note in the same pull request. A note in a public section
(features, improvements, fixes, deprecations, upgrade, other) is published to
https://piloti.at/changelog on merge; one in `security`, `incident` or
`operators` is kept in the repository and never published. Either way the PR
is the last moment at which the person who knows what changed is still the one
writing it down.

Any section satisfies this check, an internal one included: a security or
severe fix needs its note as much as a feature does, it just does not reach the
page. Which sections are internal is `INTERNAL_SECTIONS` in
scripts/release_notes.py.

The check goes by file, not by reading the diff. A product file is one under the
agent backend, the API, the app UI or the CLI, minus tests, specs, fixtures,
mocks, snapshots and Markdown, which change nothing a user of the app can
observe. Touching a product file requires a note; whether the change inside it
could be noticed is the author's call, made with the label below.

A note counts only when this PR adds it. Editing or deleting an old note does
not satisfy the rule.

Escape hatch: the `no-release-note` label on the PR, for a change a user cannot
notice (a refactor, a comment, internal tooling). The workflow skips this script
entirely when it is set.

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


def _git(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", *args], capture_output=True, check=False)


def _revs(base: str, head: str) -> str:
    """The revision spec git can diff: the merge-base form, or the two commits when there is none."""
    for spec in (f"{base}...{head}", f"{base} {head}"):
        if _git("diff", "--quiet", *spec.split()).returncode in (0, 1):
            return spec
    return f"{base} {head}"


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
    """The touched files that are product."""
    return [
        path
        for path in files
        if any(p.search(path) for p in PRODUCT_PATTERNS) and not any(e.search(path) for e in EXEMPT_PATTERNS)
    ]


def has_note(files: list[str]) -> bool:
    return any(path.startswith(NOTES_PREFIX) and path.endswith(".yaml") for path in files)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    base, head = argv[1], argv[2]
    files = changed_files(base, head)
    if not files:
        return 0

    triggers = needs_note(files)
    if not triggers:
        print("This pull request touches no product file — no release note required.")
        return 0
    if has_note(added_files(base, head)):
        print(f"Release note present for {len(triggers)} changed product file(s).")
        return 0

    shown = "\n".join(f"    {path}" for path in triggers[:10])
    more = f"\n    …and {len(triggers) - 10} more" if len(triggers) > 10 else ""
    print(
        "This pull request touches product files but adds no release note:\n\n"
        f"{shown}{more}\n\n"
        "Write one:\n\n"
        "    task release:note -- short-slug\n"
        "    # edit releasenotes/notes/short-slug-<hash>.yaml, keep one section\n"
        "    task release:lint\n\n"
        "Notes under features, improvements, fixes, deprecations, upgrade or other are\n"
        "published to https://piloti.at/changelog when this merges: plain sentences,\n"
        "written for the architect using Piloti. A security fix goes under `security`,\n"
        "a severe fix (data lost, a permission that did not hold) under `incident`, and\n"
        "a note only platform operators can act on under `operators`. Those three are\n"
        "kept and never published, and they satisfy this check too. The rules are in\n"
        "docs/contributing/release-notes.md.\n\n"
        "If this change genuinely cannot be noticed by a user (a refactor, a comment,\n"
        "internal tooling, infrastructure), add the `no-release-note` label to the PR.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
