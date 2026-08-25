#!/usr/bin/env python3

"""Keep the ADR directory and its index telling the same story.

Why this exists
---------------

An audit of the 53 records here found four kinds of silent drift:

* **Number collisions.** 0027, 0039, 0044 and 0047 were each used twice, every
  time because two people took the next number from ``README.md`` on the same
  day. The index lags the directory; the directory cannot.
* **Index drift.** ADR-0021 and ADR-0045 read *Accepted* in the file and
  *Proposed* in the index. The index is what people scan, so the wrong one won.
* **An unindexed record.** ``0044-retrieval-correctness-and-the-measurement-gate``
  existed on disk and appeared nowhere in the index.
* **Four metadata formats.** ``- **Status:** x``, ``- **Status**: x``, a
  ``## Status`` section, and a bare ``**Status:** x`` with no Deciders at all —
  so nothing could read the directory programmatically.

None of these have a symptom until somebody acts on a decision that was
superseded a month ago.

What it checks
--------------

Numbers are unique (bar the four recorded collisions), every ADR is indexed,
the index status matches the file, statuses come from the legend, and new ADRs
(0050 and up) carry MADR frontmatter. Records 0001-0049 predate the template
and are read with a legacy parser rather than being asked to convert.

Usage:
    python scripts/check_adrs.py            # validate; exit 1 on drift
    python scripts/check_adrs.py --next     # print the next free number

Exit code is 0 when the directory and the index agree, 1 otherwise.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ADR_DIR = Path("docs/adr")
TEMPLATE = "0000-template.md"

# The first ADR expected to use the MADR template. Everything below it predates
# the template; converting them would rewrite accepted decisions, which the
# process here forbids.
MADR_FROM = 50

# Collisions already in the history. Each is recorded rather than renumbered so
# existing links keep resolving. Do not add to this set: take the next number
# from `--next`.
KNOWN_COLLISIONS = frozenset({27, 39, 44, 47})

STATUSES = ("proposed", "rejected", "accepted", "deprecated", "superseded")

FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---", re.DOTALL)
# The three legacy shapes, in one pattern: optional bullet, colon inside or
# outside the bold.
LEGACY_STATUS_RE = re.compile(r"^[-*]?\s*\*\*Status:?\*\*:?\s*(.+)$", re.MULTILINE)
SECTION_STATUS_RE = re.compile(r"^##\s*Status\s*\n+(.+)$", re.MULTILINE)
INDEX_ROW_RE = re.compile(r"^\|\s*\[(\d{4})\]\(([^)]+)\)\s*\|([^|]*)\|([^|]*)\|", re.MULTILINE)


def adr_files() -> list[Path]:
    """Every ADR on disk, excluding the template."""
    return sorted(p for p in ADR_DIR.glob("[0-9][0-9][0-9][0-9]-*.md") if p.name != TEMPLATE)


def number_of(path: Path) -> int:
    """The NNNN prefix of an ADR filename."""
    return int(path.name[:4])


def raw_status(path: Path) -> str | None:
    """The status as written, in whichever of the four formats this file uses."""
    text = path.read_text(encoding="utf-8")
    fm = FRONTMATTER_RE.match(text)
    if fm:
        m = re.search(r"^status:\s*(.+)$", fm.group(1), re.MULTILINE)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    for pattern in (LEGACY_STATUS_RE, SECTION_STATUS_RE):
        m = pattern.search(text)
        if m:
            return m.group(1).strip()
    return None


def normalise(status: str) -> str:
    """Reduce a status to the legend word it starts with, for comparison."""
    first = re.split(r"[\s—(-]", status.strip().lower(), maxsplit=1)[0]
    return first.strip(":.*")


def index_rows(readme: Path) -> dict[str, str]:
    """Map each indexed ADR filename to the status its index row claims."""
    return {m.group(2).strip(): m.group(4).strip() for m in INDEX_ROW_RE.finditer(readme.read_text(encoding="utf-8"))}


def check(errors: list[str]) -> int:
    """Run every check, appending to ``errors``. Returns the ADR count."""
    files = adr_files()
    readme = ADR_DIR / "README.md"
    indexed = index_rows(readme)

    seen: dict[int, Path] = {}
    for path in files:
        num = number_of(path)
        if num in seen and num not in KNOWN_COLLISIONS:
            errors.append(
                f"{path.name}: number {num:04d} is already used by {seen[num].name}. Take the next one from `--next`."
            )
        seen.setdefault(num, path)

        status = raw_status(path)
        if status is None:
            errors.append(f"{path.name}: no status field this script can read.")
            continue
        if normalise(status) not in STATUSES:
            errors.append(
                f"{path.name}: status {status!r} is not one of {', '.join(STATUSES)}. "
                f"Qualifications belong in Consequences."
            )

        if num >= MADR_FROM and not FRONTMATTER_RE.match(path.read_text(encoding="utf-8")):
            errors.append(
                f"{path.name}: ADRs from {MADR_FROM:04d} use the MADR template "
                f"(YAML frontmatter). Copy docs/adr/0000-template.md."
            )

        if path.name not in indexed:
            errors.append(f"{path.name}: missing from the index in docs/adr/README.md.")
        elif normalise(indexed[path.name]) != normalise(status):
            errors.append(
                f"{path.name}: status is {normalise(status)!r} in the file but "
                f"{normalise(indexed[path.name])!r} in the index."
            )

    on_disk = {p.name for p in files}
    for name in indexed:
        if name not in on_disk:
            errors.append(f"docs/adr/README.md: indexes {name}, which does not exist.")

    return len(files)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: validate the ADR directory, or print the next number."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--next", action="store_true", help="Print the next free ADR number and exit.")
    args = parser.parse_args(argv)

    if args.next:
        print(f"{max((number_of(p) for p in adr_files()), default=0) + 1:04d}")
        return 0

    errors: list[str] = []
    count = check(errors)

    if errors:
        print(f"ADR check FAILED ({len(errors)} error(s)):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"ADR check passed: {count} record(s), index in sync.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
