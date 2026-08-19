"""Cross-language contract: the BFF resolve payload, read by the real resolver.

``GET /api/internal/skills/resolve`` is where a word in a migration becomes
fleet policy. ``delivery: 'standard'`` on a ``platform_skills`` row makes the
BFF mark the served row ``standard: true``; :func:`_build_org_skills` reads that
key to set :attr:`Skill.standard`, and that flag is the whole difference between
a skill that is APPLIED on every run and one whose one-line description sits in
a catalog the model may never open. The same payload carries the row's
``metadata`` verbatim, and three reserved keys ride it: ``grid-hidden`` routes
the activation off the live line, ``grid-cards`` inlines the card shapes with
the body, and ``grid-agents`` decides which agent may run the skill at all.

``ce47667b`` pinned this side of the seam against a HAND-WRITTEN payload, which
is what left the crossing open: nothing said the hand-written keys were the keys
the BFF actually sends. Renaming ``standard`` in ``lib/skills/service.ts`` — with
``service.spec.ts`` renamed along with it, as a refactor would — left the whole
frontend suite and all 3,909 tests here green while ``piloti-voice`` and
``piloti-cards`` silently stopped being forced. Erasing the served ``metadata``
was caught by nothing at all.

A process boundary cannot be crossed inside one test, so both sides assert
against the SAME checked-in fixture — the device
``tests/fixtures/citation_pipeline`` already uses for the citation formats. The
TypeScript counterpart,
``frontends/ui/src/lib/skills/resolve-payload-contract.spec.ts``, proves the
fixture is still a faithful sample of what the real ``resolveSkillsForAgent``
emits; this file proves the real :class:`SkillResolver` still reads it as fleet
policy. Rename or drop a field and exactly one of the two fails.

Nothing here is faked except the HTTP call: the rows go through the real
``_build_org_skills``, the real ``build_skill_from_payload`` and the real merge.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import pytest

from aiq_agent.common import cache as shared_cache
from aiq_agent.skills.models import Skill
from aiq_agent.skills.models import preferred_cards
from aiq_agent.skills.models import skill_hidden
from aiq_agent.skills.models import skill_title
from aiq_agent.skills.resolver import SkillResolver

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "skills_resolve" / "resolve_payload.json"

AGENT = "shallow_researcher"
ORGANIZATION = "org_1"

#: The house voice in the sample — the row the whole crossing exists for.
STANDARD = "piloti-voice"


def served_rows() -> list[dict]:
    """The sample payload, exactly as the BFF's route body carries it."""
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _reset_cache():
    shared_cache.reset_local_store()
    yield
    shared_cache.reset_local_store()


@pytest.fixture
def resolved() -> dict[str, Skill]:
    """The sample payload through the REAL resolver, keyed by name.

    The builtin map is emptied so the assertions below are about the SERVED
    rows and not about whatever files happen to sit in ``skills/builtin``.
    """
    resolver = SkillResolver(agent=AGENT)
    resolver._builtin_by_name = {}
    with mock.patch.object(resolver, "_fetch_org_skills", return_value=served_rows()):
        return {skill.name: skill for skill in resolver.resolve(ORGANIZATION)}


def test_the_guard_is_actually_reading_the_fixture() -> None:
    """A fixture that emptied out would make every assertion below vacuous."""
    rows = served_rows()
    assert len(rows) >= 4
    assert STANDARD in {row["name"] for row in rows}


def test_every_served_row_survives_validation(resolved: dict[str, Skill]) -> None:
    """A row the BFF serves and the resolver drops is a skill that never runs."""
    assert set(resolved) == {row["name"] for row in served_rows()}


def test_the_standard_row_arrives_as_fleet_policy(resolved: dict[str, Skill]) -> None:
    """``standard: true`` on the wire must become ``Skill.standard``.

    This is the assertion the mutation that started all of this would break:
    drop the flag on either side and the house voice resolves into the catalog
    as an ordinary offer, which the model is free to never open.
    """
    assert resolved[STANDARD].standard is True


def test_nothing_else_in_the_payload_is_fleet_policy(resolved: dict[str, Skill]) -> None:
    """``standard`` is not derivable from ``origin``, and must not be derived.

    The machinery and a taken-up offer both arrive with ``origin='platform'``;
    reading policy off that would force every builtin on the fleet.
    """
    imposed = {name for name, skill in resolved.items() if skill.standard}
    assert imposed == {STANDARD}


def test_the_reserved_metadata_survives_the_crossing(resolved: dict[str, Skill]) -> None:
    """The three keys that change how an answer is made, read as the reader sees them.

    Asserted through the accessors the product actually calls rather than on the
    raw dict, because a key that arrives and is then read under a different
    spelling is the same failure with a longer path.
    """
    voice = resolved[STANDARD]
    assert skill_hidden(voice.metadata) is True
    assert skill_title(voice) == "Piloti-Stimme"
    assert preferred_cards(voice.metadata) == ("summary", "calculation")


def test_a_row_the_platform_did_not_hide_stays_on_the_live_line(resolved: dict[str, Skill]) -> None:
    """The other direction: absent ``grid-hidden`` must not read as hidden."""
    assert [name for name, skill in resolved.items() if skill_hidden(skill.metadata)] == [STANDARD]


def test_the_body_crosses_too_and_not_just_the_description(resolved: dict[str, Skill]) -> None:
    """A description cannot shape an answer; the instructions have to arrive."""
    sampled = {row["name"]: row for row in served_rows()}
    assert resolved[STANDARD].body == sampled[STANDARD]["body"]
    assert resolved[STANDARD].description == sampled[STANDARD]["description"]


def test_the_served_rows_are_org_origin_whatever_the_payload_calls_them(
    resolved: dict[str, Skill],
) -> None:
    """Everything down this channel is a SERVED row, which is what deep research reads.

    ``resolve_served_skills`` selects on ``origin == "org"``; a served row that
    kept the payload's own ``origin: 'platform'`` would be dropped there, and the
    longest answers in the product would lose the house voice in silence.
    """
    assert {skill.origin for skill in resolved.values()} == {"org"}
