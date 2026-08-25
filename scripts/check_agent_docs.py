#!/usr/bin/env python3

"""Check that every ``AGENTS.md`` actually reaches Claude Code.

Why this exists
---------------

Claude Code reads ``CLAUDE.md`` and never ``AGENTS.md``. The bridge between them
is an import, ``@AGENTS.md``, and the ``@`` is the entire mechanism. Written
without it the file is one line of prose that happens to name a filename: the
guide never loads, ``/context`` still lists a memory file, and nothing reports a
problem.

The root ``CLAUDE.md`` of this repository was exactly that for its whole life —
the ten bytes ``AGENTS.md\\n`` — so every Claude session ran with the root guide
silently absent. It is the second time this repo has shipped a committed text
file containing a path that never resolved; the first was ten "symlinks" under
``.claude/skills/`` (see docs/contributing/gotchas.md).

A missing guide has no symptom, which is what makes it worth a gate rather than
a gotcha entry.

What it checks
--------------

1. Every ``AGENTS.md`` has a ``CLAUDE.md`` beside it.
2. Every such ``CLAUDE.md`` imports it with a real ``@AGENTS.md`` line.
3. No ``CLAUDE.md`` mentions ``AGENTS.md`` only as bare text.
4. Every relative link in an ``AGENTS.md`` resolves against **git**, not the
   filesystem — a link into a generated directory (``.claude/``, ``.agents/``,
   ``node_modules/``) is dead for every reader who has not run ``task setup``.

Usage:
    python scripts/check_agent_docs.py [--list]

Exit code is 0 when every guide is wired up, 1 otherwise.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# The import line Claude Code expands. Anchored: an `@AGENTS.md` inside a code
# span or a sentence is not an import, and neither is a bare mention.
IMPORT_RE = re.compile(r"^\s*@(?:\./)?AGENTS\.md\s*$", re.MULTILINE)

# A mention of the file that is NOT an import. Catches the original bug.
BARE_MENTION_RE = re.compile(r"^\s*(?:\./)?AGENTS\.md\s*$", re.MULTILINE)

MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)")

# Directories that exist only after `task setup` and are gitignored. A link into
# one of them resolves on the author's machine and nowhere else.
GENERATED = ("node_modules/", ".claude/", ".agents/", "apm_modules/", ".venv/")


def tracked_files() -> set[str]:
    """Every path git knows about, which is the only tree a reader is guaranteed."""
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout
    return set(out.splitlines())


def agents_files(tracked: set[str]) -> list[Path]:
    """Tracked ``AGENTS.md`` files, newest scopes and root alike."""
    return sorted(Path(p) for p in tracked if Path(p).name == "AGENTS.md")


def check_bridge(agents: Path, errors: list[str]) -> None:
    """Assert ``agents`` has a sibling ``CLAUDE.md`` that really imports it."""
    bridge = agents.with_name("CLAUDE.md")
    if not bridge.exists():
        errors.append(
            f"{agents}: no CLAUDE.md beside it. Claude Code reads CLAUDE.md, "
            f"never AGENTS.md, so this guide never loads. "
            f"Create {bridge} containing the single line '@AGENTS.md'."
        )
        return

    text = bridge.read_text(encoding="utf-8")
    if IMPORT_RE.search(text):
        return

    if BARE_MENTION_RE.search(text):
        errors.append(
            f"{bridge}: names AGENTS.md without the leading '@', so it is prose, "
            f"not an import, and {agents} never loads. Write '@AGENTS.md'."
        )
    else:
        errors.append(f"{bridge}: no '@AGENTS.md' import line, so {agents} never loads.")


def check_links(agents: Path, tracked: set[str], errors: list[str]) -> None:
    """Assert every relative link in ``agents`` resolves in a fresh checkout."""
    for target in MD_LINK_RE.findall(agents.read_text(encoding="utf-8")):
        target = target.strip()
        if target.startswith(("http://", "https://", "mailto:", "<")):
            continue
        if any(seg in target for seg in GENERATED):
            errors.append(
                f"{agents}: links into a generated directory ({target}). "
                f"It resolves only after `task setup` and is dead for every "
                f"other reader."
            )
            continue
        resolved = (agents.parent / target).resolve()
        try:
            rel = resolved.relative_to(Path.cwd().resolve()).as_posix()
        except ValueError:
            errors.append(f"{agents}: link escapes the repository ({target}).")
            continue
        if rel in tracked or any(t.startswith(rel + "/") for t in tracked):
            continue
        errors.append(f"{agents}: dead link, not tracked by git ({target}).")


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: check every tracked AGENTS.md and return an exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="List the guides found and exit 0.")
    args = parser.parse_args(argv)

    tracked = tracked_files()
    guides = agents_files(tracked)

    if args.list:
        for g in guides:
            print(g)
        return 0

    errors: list[str] = []
    for guide in guides:
        check_bridge(guide, errors)
        check_links(guide, tracked, errors)

    if errors:
        print(f"Agent-doc check FAILED ({len(errors)} error(s)):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"Agent-doc check passed: {len(guides)} guide(s) wired up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
