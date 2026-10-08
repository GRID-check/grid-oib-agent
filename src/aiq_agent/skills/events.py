"""Saying which skill is being applied, while it is being applied.

A skill is the most consequential thing a tenant can put into a turn: it is
their own working method — a Brandschutznachweis procedure, a house style for
a Bescheid — rewriting how the answer gets made. Until now none of that left
the process. ``SkillRuntime`` knew the name at activation, the register knew
the whole resolved catalog before the LLM was called, and the only thing that
ever surfaced was ``skills_activated[]`` on the terminal frame: a list of
hyphenated ids, delivered after the answer they shaped.

What is said, and what is only recorded
---------------------------------------

One event is for the reader:

- ``activated`` — *Skill „Brandschutznachweis" wird angewendet*, or *Applying
  the "Brandschutznachweis" skill*, depending on who is reading. It completes
  "…so the reader knows that **this answer is being written the office's way,
  and which way that is**".

  What is EMITTED is never that sentence. It is an ``activated`` step with the
  skill's :func:`~.models.skill_title`, and the frontend owns the words in
  both locales. The title travels as itself: it is the office's own name for
  their own working method, the same word in every locale, and the hyphenated
  id is a routing key and not a name.

One is telemetry, on :data:`~aiq_agent.common.turn_status.CHANNEL_TECHNICAL`,
so it can only reach the opt-in details panel: ``offered``, how large the
catalog was. Catalog SIZE is availability, not activity; rendering it live
would repeat the mistake that once put a phantom "web search" in front of
users.

There is deliberately NO per-skill "finished" event. A skill's instructions
stay in context for the remainder of the turn, so "finished" would be a claim
the system cannot make.

Wire contract
-------------

Each event is a :class:`~aiq_agent.common.wire_v2.SkillStep`, emitted through
:func:`~aiq_agent.common.turn_status.emit_step`. The step id is load-bearing:
the same id replaces the row, so every skill gets its own ``skill:<name>`` id.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from aiq_agent.common.turn_status import CHANNEL_LIVE
from aiq_agent.common.turn_status import CHANNEL_TECHNICAL
from aiq_agent.common.turn_status import emit_step
from aiq_agent.common.wire_v2 import SkillStep

from .models import Skill
from .models import skill_hidden
from .models import skill_title

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .runtime import SkillRuntime

#: Step id for the catalog-level ``offered`` event. One per turn, and
#: technical-only (see the module docstring).
SELECTION_STEP_ID = "skill_selection"

#: Prefix for the per-skill steps. ``skill:oib-brandschutznachweis``: one step
#: per skill, so N skills produce N rows.
SKILL_STEP_PREFIX = "skill:"

#: The stable dotted id of the one skill event a reader actually sees. ONE key,
#: because there is now one way a skill runs: the model read its description in
#: the catalog and chose to open it. The frontend derives it from an
#: ``activated``, live, titled step and resolves it under ``chat.thinking.skill.*``.
KEY_SKILL_ACTIVATED = "skill.activated"

#: EVERY key a skill step can put on the live line: the counterpart of
#: :data:`~aiq_agent.common.turn_status.ALL_STATUS_KEYS`, and read by the same
#: two tests.
ALL_SKILL_KEYS: tuple[str, ...] = ("skill.activated",)


def emit_skills_offered(runtime: SkillRuntime) -> None:
    """Record the catalog this turn was given. Technical channel, one step.

    Emits NOTHING when no skills apply: silence is the correct report for a
    turn with no skills in it, and a "0 skills offered" event would be a line
    about the absence of a feature.
    """
    count = len(tuple(runtime.skills))
    if count:
        emit_step(SkillStep(id=SELECTION_STEP_ID, phase="offered", count=count, channel=CHANNEL_TECHNICAL))


def emit_skill_activated(skill: Skill) -> None:
    """Say that this skill is now shaping the answer. The one LIVE skill event.

    Fires from the single activation site in ``SkillRuntime``, which is reached
    only when ``use_skill`` hands a body over, so the line is a report of
    delivery, never of an intention.

    A skill with no ``grid-title`` is technical: an id like
    ``oib-brandschutznachweis-2024`` in a status line is worse than silence,
    and inventing a title from it would make a missing name indistinguishable
    from a real one.

    A ``grid-hidden`` skill is technical too, even with a title. Some skills
    apply on every answer (a house voice is the type case), so their live line
    is noise on every turn. The step still fires and carries its title, so the
    disclosure names it and the reasoning view can surface it. Hidden is never
    concealed (see ``GRID_HIDDEN_KEY`` and agent-skills.md, activation
    transparency).
    """
    title = skill_title(skill)
    hidden = skill_hidden(skill.metadata)
    live = bool(title) and not hidden
    emit_step(
        SkillStep(
            id=f"{SKILL_STEP_PREFIX}{skill.name}",
            phase="activated",
            skill=skill.name,
            title=title,
            hidden=hidden,
            channel=CHANNEL_LIVE if live else CHANNEL_TECHNICAL,
        )
    )
