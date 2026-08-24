#!/usr/bin/env python3
"""Fail a PR that changes the product but ships no release note.

The rule (AGENTS.md, "Release notes are mandatory"): a change a customer can
notice carries its note in the same pull request. The note is published to
https://piloti.at/changelog on merge, so the PR is the last moment at which the
person who knows what changed is still the one writing it down.

What counts as "the product" is the file list below: the agent backend, the API,
the app UI. Tests, specs, fixtures, docs and the marketing site itself are
excluded — they change nothing a user of the app can observe.

Escape hatch: the `no-release-note` label on the PR, for the genuinely invisible
change. The workflow skips this script entirely when it is set.

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
    """The touched files that make a note mandatory."""
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
    files = changed_files(argv[1], argv[2])
    if not files:
        return 0

    triggers = needs_note(files)
    if not triggers:
        print("No product change in this PR — no release note required.")
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
