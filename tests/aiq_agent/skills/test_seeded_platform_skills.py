"""Parity guard: the SEEDED platform skills must parse the way the runtime reads them.

A seeded standard skill (``frontends/ui/drizzle/00XX_*_standard_skill.sql``) is
a row of SQL text on one side of the stack and a :class:`Skill` on the other,
and nothing in between type-checks it. Its ``metadata`` is a jsonb blob whose
reserved keys only this package understands: ``grid-cards`` names card types
from :mod:`aiq_agent.cards`, ``grid-agents`` names agents from the resolver,
``grid-hidden`` is a boolean-ish token.

Every one of those couplings fails SILENTLY in production. A renamed card type
leaves the seed naming a card that no longer exists, and the BFF-served path is
deliberately LENIENT — it logs and drops the bad entry so one stale name cannot
delete a tenant's whole skill (see ``_validate_grid_cards``). Which is right at
runtime and useless as a warning: the skill keeps working, minus the shapes it
was seeded to inline, and nobody hears about it. Same for a mistyped
``grid-hidden``, which drops to "visible" and puts a house skill back on the
live line.

So the seeds are re-validated here in STRICT mode, the way an in-repo SKILL.md
is, and the parsed metadata is compared against what the runtime would actually
read back. This is a filesystem test with no database, for the same reason
``frontends/ui/tests/db/migrations-journal.test.ts`` is: the failure it catches
is a bookkeeping mismatch, visible long before anything connects.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.skills.models import MAX_DESCRIPTION_CHARS
from aiq_agent.skills.models import Skill
from aiq_agent.skills.models import _validate_metadata
from aiq_agent.skills.models import preferred_cards
from aiq_agent.skills.models import skill_hidden
from aiq_agent.skills.models import split_metadata_list
from aiq_agent.skills.resolver import KNOWN_AGENTS

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


def _strip_line_comments(sql: str) -> str:
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


def _seeded_skills() -> list[tuple[str, dict[str, str]]]:
    """Every ``platform_skills`` seed on disk, as (migration tag, column map)."""
    seeds: list[tuple[str, dict[str, str]]] = []
    for path in sorted(DRIZZLE_DIR.glob("*.sql")):
        if path.name.endswith(".down.sql"):
            continue
        sql = _strip_line_comments(path.read_text(encoding="utf-8"))
        match = _INSERT_RE.search(sql)
        if match is None:
            continue
        columns = [name.strip().strip('"') for name in match.group("columns").split(",")]
        assert tuple(columns) == SEED_COLUMNS, f"{path.name} inserts unexpected columns: {columns}"
        values = _split_values(sql, match.end())
        assert len(values) == len(columns), f"{path.name} has {len(values)} values for {len(columns)} columns"
        seeds.append((path.stem, {name: _unquote(value) for name, value in zip(columns, values, strict=True)}))
    return seeds


SEEDS = _seeded_skills()
SEED_IDS = [tag for tag, _ in SEEDS]


def test_the_seeds_are_found_at_all():
    """A parser that silently matches nothing would make every test below vacuous."""
    assert {row["name"] for _, row in SEEDS} >= {"piloti-voice", "piloti-cards"}


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_metadata_passes_strict_validation(tag: str, row: dict[str, str]):
    """The lenient BFF path would drop a bad key and say nothing; this says it.

    ``strict=True`` is what an in-repo SKILL.md gets. A seed is authored in this
    repo and reviewed here too, so it earns the same treatment — an unknown card
    type or a ``grid-hidden: maybe`` is an authoring error, not tenant data.
    """
    metadata = json.loads(row["metadata"])
    assert _validate_metadata(metadata, strict=True) == metadata


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_row_loads_as_a_skill(tag: str, row: dict[str, str]):
    """Name, description and body must satisfy the same model the runtime builds."""
    skill = Skill(
        name=row["name"],
        description=row["description"],
        body=row["body"],
        metadata=json.loads(row["metadata"]),
        origin="platform",
        standard=row["delivery"] == "standard",
    )
    assert skill.body.strip(), f"{tag} seeds an empty body"
    assert 0 < len(skill.description) <= MAX_DESCRIPTION_CHARS


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_grid_cards_survive_the_read_path(tag: str, row: dict[str, str]):
    """Every named card type still exists, so nothing is dropped on read.

    ``preferred_cards`` filters against the live catalog, so a card renamed in
    ``src/aiq_agent/cards`` would quietly shorten this list — and the skill would
    go on running, minus the shapes it was seeded to inline. Comparing against
    the raw metadata is what turns that into a failing test.
    """
    metadata = json.loads(row["metadata"])
    declared = split_metadata_list(metadata.get("grid-cards", ""))
    assert preferred_cards(metadata) == tuple(declared)
    assert set(declared) <= model_facing_card_types()


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_seeded_grid_agents_are_agents_the_resolver_knows(tag: str, row: dict[str, str]):
    """An unknown agent name is logged and ignored at resolve time — never here."""
    metadata = json.loads(row["metadata"])
    assert set(split_metadata_list(metadata.get("grid-agents", ""))) <= KNOWN_AGENTS


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_a_standard_seed_is_published_and_hidden(tag: str, row: dict[str, str]):
    """``delivery: 'standard'`` is only fleet policy once ``published`` is true.

    And a standard skill applies to EVERY answer, which is precisely the case
    ``grid-hidden`` exists for: without it the live line announces the same
    activation under every turn. Both are properties of the tier rather than of
    these two rows, so they are asserted for whatever standard seed comes next.
    """
    if row["delivery"] != "standard":
        pytest.skip(f"{tag} is not a standard-delivery seed")
    assert row["published"].lower() == "true"
    assert skill_hidden(json.loads(row["metadata"]))


@pytest.mark.parametrize(("tag", "row"), SEEDS, ids=SEED_IDS)
def test_every_seed_has_a_matching_down_migration(tag: str, row: dict[str, str]):
    """The rollback must name the same skill, and only touch the system seed.

    ``created_by = 'system'`` is the guard that keeps a down-migration from
    discarding a row the platform owner has since edited — the same reason the
    forward seed is ``ON CONFLICT DO NOTHING``.
    """
    down = DRIZZLE_DIR / f"{tag}.down.sql"
    assert down.exists(), f"{tag} seeds a row with no .down.sql to remove it"
    text = down.read_text(encoding="utf-8")
    assert f"'{row['name']}'" in text
    assert "'system'" in text


def test_the_generic_card_seed_inlines_only_generic_cards():
    """``piloti-cards`` pays for its shapes on EVERY turn, so the list stays short.

    The five are the ones that fire on an ordinary answer. ``norm_chain`` and
    ``typed_table`` are taught in the body but deliberately NOT inlined — they
    are the two most expensive and the two narrowest, so they are left to a
    ``describe_card`` round-trip on the turns they actually fire. Pinned here
    because widening the list is invisible in review and permanent in cost.
    """
    row = next(row for _, row in SEEDS if row["name"] == "piloti-cards")
    assert preferred_cards(json.loads(row["metadata"])) == (
        "verdict_header",
        "condition_tree",
        "key_takeaways",
        "callout",
        "follow_ups",
    )
