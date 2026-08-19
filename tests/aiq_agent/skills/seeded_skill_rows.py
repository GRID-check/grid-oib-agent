"""Reading the ``platform_skills`` seeds off disk, as the runtime would see them.

The seeds (``frontends/ui/drizzle/00XX_*_standard_skill.sql``) are the only
place ``piloti-voice`` and ``piloti-cards`` exist in this repo: a row of SQL
text on one side of the stack and a :class:`~aiq_agent.skills.models.Skill` on
the other. Two suites need that translation and they must not disagree about
it — ``test_seeded_platform_skills.py`` checks the rows parse and validate, and
``agents/shallow_researcher/test_standard_skills_reach_the_model.py`` runs the
resolved skills through a real turn. A second parser would let one of them keep
passing against text no database has held since the last update migration.

Filesystem only, no database: the couplings these tests catch are bookkeeping
mismatches, visible long before anything connects.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from aiq_agent.skills.models import Skill

REPO_ROOT = Path(__file__).resolve().parents[3]
DRIZZLE_DIR = REPO_ROOT / "frontends" / "ui" / "drizzle"

#: The columns the seeds insert, in the order they insert them. Parsing is
#: anchored on this rather than on each file's formatting so a seed that adds a
#: column fails loudly here instead of being read with everything shifted by one.
SEED_COLUMNS = (
    "name",
    "description",
    "body",
    "metadata",
    "published",
    "delivery",
    "created_by",
    "created_by_email",
)

_INSERT_RE = re.compile(
    r'INSERT INTO "platform_skills"\s*\((?P<columns>[^)]*)\)\s*VALUES\s*\(',
    re.IGNORECASE,
)


def strip_line_comments(sql: str) -> str:
    """Drop ``--`` comments, leaving string literals (which may contain ``--``) intact."""
    out: list[str] = []
    in_string = False
    i = 0
    while i < len(sql):
        char = sql[i]
        if in_string:
            if char == "'":
                # '' is an escaped quote, not the end of the literal.
                if sql[i + 1 : i + 2] == "'":
                    out.append("''")
                    i += 2
                    continue
                in_string = False
            out.append(char)
            i += 1
            continue
        if char == "'":
            in_string = True
            out.append(char)
            i += 1
            continue
        if sql.startswith("--", i):
            i = sql.find("\n", i)
            if i == -1:
                break
            continue
        out.append(char)
        i += 1
    return "".join(out)


def _split_values(sql: str, start: int) -> list[str]:
    """Split the VALUES tuple opening at ``start`` into its top-level items."""
    items: list[str] = []
    current: list[str] = []
    depth = 0
    in_string = False
    i = start
    while i < len(sql):
        char = sql[i]
        if in_string:
            if char == "'":
                if sql[i + 1 : i + 2] == "'":
                    current.append("''")
                    i += 2
                    continue
                in_string = False
            current.append(char)
            i += 1
            continue
        if char == "'":
            in_string = True
            current.append(char)
        elif char == "(":
            depth += 1
            current.append(char)
        elif char == ")":
            if depth == 0:
                items.append("".join(current))
                return [item.strip() for item in items]
            depth -= 1
            current.append(char)
        elif char == "," and depth == 0:
            items.append("".join(current))
            current = []
        else:
            current.append(char)
        i += 1
    raise AssertionError("unterminated VALUES tuple in a platform_skills seed")


def _unquote(literal: str) -> str:
    """The Python value of one SQL literal from a seed's VALUES tuple."""
    value = literal.removesuffix("::jsonb").strip()
    if value.upper() == "NULL":
        return ""
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    return value


def seeded_skills() -> list[tuple[str, dict[str, str]]]:
    """Every ``platform_skills`` seed on disk, as (migration tag, column map)."""
    seeds: list[tuple[str, dict[str, str]]] = []
    for path in sorted(DRIZZLE_DIR.glob("*.sql")):
        if path.name.endswith(".down.sql"):
            continue
        sql = strip_line_comments(path.read_text(encoding="utf-8"))
        match = _INSERT_RE.search(sql)
        if match is None:
            continue
        columns = [name.strip().strip('"') for name in match.group("columns").split(",")]
        assert tuple(columns) == SEED_COLUMNS, f"{path.name} inserts unexpected columns: {columns}"
        values = _split_values(sql, match.end())
        assert len(values) == len(columns), f"{path.name} has {len(values)} values for {len(columns)} columns"
        seeds.append((path.stem, {name: _unquote(value) for name, value in zip(columns, values, strict=True)}))
    return seeds


SEEDS = seeded_skills()


def effective_row(name: str) -> dict[str, str]:
    """The row a database ENDS UP with, not the one it was first given.

    ``SEEDS`` is every ``INSERT`` on disk in migration order, and a skill may be
    seeded once and updated later (``0053`` then ``0055`` for ``piloti-voice``).
    Asserting against the first match would test text no live database has held
    since the update shipped, which is the precise failure the update migration
    exists to avoid.
    """
    rows = [row for _, row in SEEDS if row["name"] == name]
    assert rows, f"no seed inserts {name!r}"
    return rows[-1]


def seeded_skill(name: str) -> Skill:
    """The seeded row as the :class:`Skill` the resolver would hand the runtime.

    ``standard`` is DERIVED from the row's ``delivery`` column rather than being
    passed in, because that derivation is the first link of the chain under
    test: a seed that says ``offer`` must produce a skill the runtime does not
    force, and a test that hardcoded ``standard=True`` here would keep passing
    while the fleet lost its house voice.
    """
    row = effective_row(name)
    return Skill(
        name=row["name"],
        description=row["description"],
        body=row["body"],
        metadata=json.loads(row["metadata"]),
        origin="platform",
        standard=row["delivery"] == "standard",
    )
