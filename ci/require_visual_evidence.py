#!/usr/bin/env python3
"""Fail a PR that changes a user-visible surface but attaches no before/after.

The rule (AGENTS.md, and `docs/ux/visual-screenshots.md`): a change someone can
SEE ships with a capture of it, attached to the pull request. The PR is where a
reviewer decides whether the surface is right, and the only moment the person
who knows what moved is still the one pointing at it.

This replaced the `visual-coverage` workflow, which asked a weaker question —
"did a .png file appear in the diff?" — and could be satisfied by committing an
image nobody looked at. Nothing is committed now, so the check reads the PR BODY
for the block `before-and-after` writes:

    <!-- before-and-after:start -->
    ...
    <!-- before-and-after:end -->

Producing that block is two commands, in `docs/ux/visual-screenshots.md`.

What counts as "visible" is the pattern list below: UI components, features,
routes and styles. Specs, mocks, fixtures, stories and type-only files are
excluded — they change nothing on screen. A `/dev/*` preview route is excluded
too: it is the capture TARGET, and a PR that only adds a preview has nothing to
show a reviewer yet, and so are `app/api/**` and `route.ts` handlers, which sit
under `app/` but return JSON rather than pixels.

Escape hatch, for a change under these paths that genuinely alters no pixels (a
comment, a rename, a type). Either works:

  * the `no-visual-evidence` LABEL — the workflow skips this script entirely;
  * `<!-- no-visual-evidence: why -->` in the PR BODY, which needs no repository
    setup and records the reason where the reviewer reads it. The reason is
    mandatory; a bare marker does not silence the check.

Usage: require_visual_evidence.py <base-sha> <head-sha> <pr-body-file>
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

MARKER_START = "<!-- before-and-after:start -->"
MARKER_END = "<!-- before-and-after:end -->"

# The opt-out marker, carried over from the `// no-visual: <reason>` comment the
# deleted `visual-coverage` workflow used. A REASON is required: a bare marker
# does not silence the check, which was that workflow's rule too, and is the
# whole difference between an opt-out and a mute.
OPT_OUT = re.compile(r"<!--\s*no-visual-evidence:\s*(?P<reason>[^>]*?)\s*-->", re.IGNORECASE)

# Surfaces a reader can see.
VISIBLE_PATTERNS = [
    re.compile(r"^frontends/ui/src/components/"),
    re.compile(r"^frontends/ui/src/features/"),
    re.compile(r"^frontends/ui/src/app/"),
    re.compile(r"^frontends/ui/src/styles/"),
    re.compile(r"^frontends/ui/src/.*\.css$"),
]

# ...except the parts of them that render nothing, and the previews themselves.
EXEMPT_PATTERNS = [
    re.compile(r"^frontends/ui/src/app/dev/"),
    # Server route handlers under `app/` render no pixels — they return JSON.
    re.compile(r"^frontends/ui/src/app/api/"),
    re.compile(r"(^|/)route\.(ts|tsx)$"),
    re.compile(r"\.spec\.(ts|tsx|js|jsx)$"),
    re.compile(r"\.test\.(ts|tsx|js|jsx)$"),
    re.compile(r"(^|/)__(mocks|fixtures|snapshots)__/"),
    re.compile(r"(^|/)tests?/"),
    re.compile(r"\.(md|snap|json)$"),
    re.compile(r"\.d\.ts$"),
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


def needs_evidence(files: list[str]) -> list[str]:
    """The touched files that make a capture mandatory."""
    return [
        path
        for path in files
        if any(p.search(path) for p in VISIBLE_PATTERNS) and not any(e.search(path) for e in EXEMPT_PATTERNS)
    ]


def has_evidence(body: str) -> bool:
    """A complete, non-empty before-and-after block in the PR description."""
    start = body.find(MARKER_START)
    if start == -1:
        return False
    end = body.find(MARKER_END, start)
    if end == -1:
        return False
    return bool(body[start + len(MARKER_START) : end].strip())


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2

    files = changed_files(argv[1], argv[2])
    if not files:
        return 0

    triggers = needs_evidence(files)
    if not triggers:
        print("No user-visible surface changed in this PR — no capture required.")
        return 0

    body = Path(argv[3]).read_text(encoding="utf-8") if Path(argv[3]).exists() else ""

    opt_out = OPT_OUT.search(body)
    if opt_out and opt_out.group("reason"):
        print(f"Opted out of visual evidence: {opt_out.group('reason')}")
        return 0

    if has_evidence(body):
        print(f"Visual evidence attached for {len(triggers)} changed surface file(s).")
        return 0

    shown = "\n".join(f"    {path}" for path in triggers[:10])
    more = f"\n    …and {len(triggers) - 10} more" if len(triggers) > 10 else ""
    print(
        "This pull request changes a user-visible surface but attaches no capture:\n\n"
        f"{shown}{more}\n\n"
        "Capture it and attach it — nothing is committed, it goes in the PR body:\n\n"
        "    cd frontends/ui && bun run dev\n"
        "    agent-browser open http://localhost:3001/dev/<preview>\n"
        "    agent-browser screenshot --full after.png\n"
        "    # then the `before-and-after` skill, which runs `gh --attach`\n\n"
        "The full recipe — dark mode needs BOTH the media query and the .dark\n"
        "class — is in docs/ux/visual-screenshots.md.\n\n"
        "If this change genuinely alters no pixels (a comment, a rename, a type),\n"
        "add the `no-visual-evidence` label, or put this in the PR body — the\n"
        "reason is required, a bare marker will not silence it:\n\n"
        "    <!-- no-visual-evidence: comment-only edits, no rendered output changes -->",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
