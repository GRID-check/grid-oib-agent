"""Parity guard: one set of delegatable kinds on three lists, in two languages.

A task kind is declared in three places that share no schema:
``DELEGATABLE_TASK_KINDS`` on the BFF (`frontends/ui/src/lib/db/schema/tasks.ts`),
which the route validates against; ``TASK_KINDS`` here, which ``create_task``
refuses anything outside of; and ``TaskKind`` in ``cards/models.py``, which the
``task_created`` card validates against. A kind on the BFF's list and missing
from this tool is unreachable from chat; one missing from the card's literal is
a task created with no receipt, because the card fails validation and is
dropped. Each of those failures is silent, so the lists are read here and
compared.

The second half is the join a kind's ENGINE makes: an instruction that names a
playbook (``/einreichcheck``) names a skill the run has to be able to load. A
chat-output run runs on Piloti, so the skill must be a builtin offered to the
``researcher`` agent; a typo or a scope that leaves Piloti out is a run that
reads the name and finds nothing.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

from aiq_agent.cards.models import TaskKind
from aiq_agent.skills.builtin import discover_builtin_skills
from aiq_agent.skills.resolver import _skill_applies_to_agent
from aiq_agent.tools.tasks import register as task_tools

REPO_ROOT = Path(__file__).resolve().parents[4]
TS_SCHEMA = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "db" / "schema" / "tasks.ts"
TS_DELEGATION = REPO_ROOT / "frontends" / "ui" / "src" / "lib" / "tasks" / "delegation.ts"


def _ts_delegatable_kinds() -> tuple[str, ...]:
    source = TS_SCHEMA.read_text(encoding="utf-8")
    match = re.search(r"export const DELEGATABLE_TASK_KINDS = \[(.*?)\] as const", source, re.DOTALL)
    assert match, f"DELEGATABLE_TASK_KINDS not found in {TS_SCHEMA}"
    return tuple(re.findall(r"'([^']+)'", match.group(1)))


def _ts_engines() -> dict[str, str]:
    """Each ``TASK_ENGINES`` row's source text, by kind."""
    source = TS_DELEGATION.read_text(encoding="utf-8")
    match = re.search(
        r"const TASK_ENGINES: Record<DelegatableTaskKind, TaskEngine> = \{\n(.*?)\n\}\n", source, re.DOTALL
    )
    assert match, f"TASK_ENGINES not found in {TS_DELEGATION}"
    parts = re.split(r"^  (\w+): \{$", match.group(1), flags=re.MULTILINE)
    return dict(zip(parts[1::2], parts[2::2], strict=True))


def test_the_tool_the_card_and_the_bff_name_the_same_kinds_in_the_same_order() -> None:
    ts_kinds = _ts_delegatable_kinds()
    assert ts_kinds == task_tools.TASK_KINDS
    assert get_args(TaskKind) == ts_kinds


def test_every_kind_has_an_engine_row() -> None:
    assert tuple(_ts_engines()) == _ts_delegatable_kinds()


def test_the_kinds_that_need_notes_agree_on_both_tiers() -> None:
    """Refused in the tool where the person can still answer, and again at the BFF."""
    needs = {kind for kind, row in _ts_engines().items() if "requiresHandedOver: true" in row}
    assert needs == set(task_tools._NEEDS_HANDED_OVER)
    assert needs == {"protokoll"}


def test_every_playbook_an_engine_names_is_a_skill_piloti_can_load() -> None:
    chat_skills = {skill.name for skill in discover_builtin_skills() if _skill_applies_to_agent(skill, "researcher")}
    named = {name for row in _ts_engines().values() for name in re.findall(r"— /([a-z0-9-]+)\.", row)}
    assert named == {"einreichcheck", "besprechungsprotokoll"}
    assert named <= chat_skills
