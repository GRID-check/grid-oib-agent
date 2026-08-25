#!/usr/bin/env python3
"""Publish repo-authored skills into the generated `.claude/skills/` directory.

`.claude/` is gitignored and rebuilt by `task agents:setup`. apm deploys the
installed (third-party) skills there; this script publishes the ones this repo
authors, which live in `.agents/skills/` (maintainer) and `skills/`
(API-consumer).

Symlinks, so editing the source is immediately live. Where symlinks are not
available (Windows without Developer Mode) it copies instead and says so, since
a stale copy that loads beats a live link that does not exist.

An apm-owned directory is never touched: a real directory that is not one of
ours is left alone and reported, because a name collision between a repo skill
and an installed one is a decision for a person, not for this script.

Idempotent. Safe to run on every setup.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TARGET = REPO / ".claude" / "skills"
SOURCES = (REPO / ".agents" / "skills", REPO / "skills")


def sources() -> list[Path]:
    """Every repo-authored skill directory, i.e. one holding a SKILL.md."""
    found: list[Path] = []
    for root in SOURCES:
        if not root.is_dir():
            continue
        found.extend(sorted(p for p in root.iterdir() if (p / "SKILL.md").is_file()))
    return found


def publish(src: Path, dest: Path) -> str:
    """Link (or copy) one skill. Returns a one-word outcome for the summary."""
    if dest.is_symlink():
        if Path(os.readlink(dest)) == Path(os.path.relpath(src, dest.parent)):
            return "unchanged"
        dest.unlink()
    elif dest.exists():
        # A real directory we did not create: apm owns it, or somebody has
        # hand-authored one. Either way, refuse rather than delete their work.
        return "collision"

    relative = os.path.relpath(src, dest.parent)
    try:
        dest.symlink_to(relative, target_is_directory=True)
        return "linked"
    except OSError:
        shutil.copytree(src, dest)
        return "copied"


def main() -> int:
    TARGET.mkdir(parents=True, exist_ok=True)
    tally: dict[str, list[str]] = {}
    for src in sources():
        outcome = publish(src, TARGET / src.name)
        tally.setdefault(outcome, []).append(src.name)

    for outcome in ("linked", "copied", "unchanged"):
        names = tally.get(outcome)
        if names:
            print(f"{outcome}: {len(names)} skill(s)")

    if tally.get("copied"):
        print("note: symlinks unavailable, copied instead. Re-run after editing a source skill.")

    collisions = tally.get("collision", [])
    for name in collisions:
        print(f"collision: .claude/skills/{name} already exists and is not ours; left alone", file=sys.stderr)
    return 1 if collisions else 0


if __name__ == "__main__":
    raise SystemExit(main())
