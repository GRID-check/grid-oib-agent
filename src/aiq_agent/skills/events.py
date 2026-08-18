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

  What is EMITTED is never that sentence. It is a stable key
  (``skill.activated`` / ``skill.forced``) plus one value — the skill's
  :func:`~.models.skill_title` — and the frontend owns the words in both
  locales. This module used to ship a finished German sentence in a ``text``
  field, which an English-locale reader then saw verbatim; nothing in emitted
  data may be language-specific.

  The title is the one thing that does travel as itself: it is the office's own
  name for their own working method, the same word in every locale, and the
  hyphenated id is a routing key and not a name.

Two are telemetry, and are marked :data:`~aiq_agent.common.turn_status.CHANNEL_TECHNICAL`
so they can only reach the opt-in details panel:

- ``offered`` — how large the catalog was and what the user forced. Catalog
  SIZE is availability, not activity; rendering it live would repeat the
  mistake that once put a phantom "web search" in front of users.
- ``loaded`` — the body arrived through ``use_skill``. That is plumbing: the
  reader was already told the skill is being applied, and a character count of
  its instructions is not something anyone can act on.

There is deliberately NO per-skill "finished" event. A skill's instructions
stay in context for the remainder of the turn, so "finished" would be a claim
the system cannot make.

Wire contract
-------------

A :class:`SkillEvent` is serialised as JSON into a custom intermediate step
(see :mod:`aiq_agent.common.turn_status` for why that is a FUNCTION step and
why it is pushed as a balanced pair). The step NAME is load-bearing: the
frontend dedupes thinking steps on the parsed function name, so every skill
gets its own ``skill:<name>`` step — sharing one name would collapse five
activated skills into a single step showing one of them.

Every emit is fail-open. A turn must never die because it tried to be honest
about itself.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING
from typing import Literal

from pydantic import BaseModel

from aiq_agent.common.turn_status import CHANNEL_LIVE
from aiq_agent.common.turn_status import CHANNEL_TECHNICAL
from aiq_agent.common.turn_status import clip
from aiq_agent.common.turn_status import push_custom_step

from .models import Skill
from .models import skill_title

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .runtime import SkillRuntime

logger = logging.getLogger(__name__)

#: Step name for the catalog-level ``offered`` event. One per turn, and
#: technical-only — see the module docstring.
SELECTION_STEP_NAME = "skill_selection"

#: Prefix for the per-skill steps. ``skill:oib-brandschutznachweis`` — one step
#: per skill so N skills produce N steps.
SKILL_STEP_PREFIX = "skill:"

#: A description is written for the MODEL and runs to a paragraph. What travels
#: here is an excerpt, for an operator reading the details panel.
MAX_EVENT_DESCRIPTION_CHARS = 160

#: Stable dotted ids for the one skill event a reader actually sees. Two keys
#: rather than one plus a flag, because the difference between a skill the
#: MODEL chose and one the USER named is a different sentence in every
#: language, not a word swapped inside one. Both resolve under
#: ``chat.thinking.skill.*`` in the frontend dictionary; a key with no entry
#: there renders nothing at all.
KEY_SKILL_ACTIVATED = "skill.activated"
KEY_SKILL_FORCED = "skill.forced"

#: EVERY key this module can emit — the counterpart of
#: :data:`~aiq_agent.common.turn_status.ALL_STATUS_KEYS`, and read by the same
#: two tests.
ALL_SKILL_KEYS: tuple[str, ...] = (
    "skill.activated",
    "skill.forced",
)


class SkillEvent(BaseModel):
    """One thing that happened to a skill during a turn.

    Attributes:
        phase: ``offered`` (the catalog was assembled), ``activated`` (this
            skill is now shaping the answer) or ``loaded`` (its body was pulled
            into context through ``use_skill``).
        channel: ``live`` if this may be shown as the running one-liner,
            ``technical`` if it belongs in the opt-in details panel only.
        key: The stable dotted id the frontend resolves to a sentence. Present
            on ``live`` events; ``None`` on telemetry, so nothing can
            accidentally render one.
        values: Interpolation data for ``key``, and nothing else — for
            ``activated`` that is ``{"skill": <the authored title>}``. The
            other fields below are telemetry for the details panel, not slots
            in a sentence.
        name: The skill id — a routing key, never a label.
        title: The skill's ``grid-title``. ``None`` when the author gave none;
            the surface decides how to degrade, and no title is invented here.
        description: Truncated excerpt of the model-facing description.
        origin: ``platform`` (ships with Grid) or ``org`` (the tenant's own).
        forced: ``activated`` only — whether the USER named this skill
            (``/name`` in the composer) rather than the model choosing it.
            ``None`` on the phases where the question does not arise, so a
            reader never has to interpret a default.
        offered_count: ``offered`` only — how many skills were in the catalog.
        forced_names: ``offered`` only — the ids the user forced.
        body_chars: ``loaded`` only — characters of instruction pulled in.
    """

    phase: Literal["offered", "activated", "loaded"]
    channel: str = CHANNEL_TECHNICAL
    key: str | None = None
    values: dict[str, str] | None = None
    name: str | None = None
    title: str | None = None
    description: str | None = None
    origin: str | None = None
    forced: bool | None = None
    offered_count: int | None = None
    forced_names: list[str] | None = None
    body_chars: int | None = None


def _payload(event: SkillEvent) -> dict:
    """The wire dict: ``kind`` alongside the event's own set fields.

    ``exclude_none`` because an absent title must arrive as absent — a null
    that a renderer has to special-case is the same bug in a different place.
    """
    data = event.model_dump(exclude_none=True)
    data["kind"] = "skill"
    return data


def _describe(skill: Skill) -> str | None:
    description = (skill.description or "").strip()
    return clip(description, MAX_EVENT_DESCRIPTION_CHARS) if description else None


def emit_skills_offered(runtime: SkillRuntime) -> None:
    """Record the catalog this turn was given. Technical channel, one step.

    Emits NOTHING when no skills apply: silence is the correct report for a
    turn with no skills in it, and a "0 skills offered" event would be a line
    about the absence of a feature.
    """
    try:
        skills = tuple(runtime.skills)
        if not skills:
            return
        event = SkillEvent(
            phase="offered",
            channel=CHANNEL_TECHNICAL,
            offered_count=len(skills),
            forced_names=list(runtime.forced) or None,
        )
        push_custom_step(SELECTION_STEP_NAME, _payload(event))
    except Exception:  # noqa: BLE001 — transparency must never take a turn down
        logger.debug("Skill 'offered' event not emitted", exc_info=True)


def emit_skill_activated(skill: Skill, *, forced: bool) -> None:
    """Say that this skill is now shaping the answer. The one LIVE skill event.

    Fires from the single activation site in ``SkillRuntime``, so a skill the
    user forced and a skill the model chose are announced by the same code in
    the same words — the only difference is which KEY it is (``skill.forced`` vs
    ``skill.activated``), which is a fact about who decided, not about what
    runs.

    A skill with no ``grid-title`` gets no live key: an id like
    ``oib-brandschutznachweis-2024`` in a status line is worse than silence,
    and inventing a title from it would make a missing name indistinguishable
    from a real one. The event is still recorded on the technical channel.
    """
    try:
        title = skill_title(skill)
        key = (KEY_SKILL_FORCED if forced else KEY_SKILL_ACTIVATED) if title else None
        event = SkillEvent(
            phase="activated",
            channel=CHANNEL_LIVE if title else CHANNEL_TECHNICAL,
            key=key,
            values={"skill": title} if title else None,
            name=skill.name,
            title=title,
            description=_describe(skill),
            origin=skill.origin,
            forced=forced,
        )
        push_custom_step(f"{SKILL_STEP_PREFIX}{skill.name}", _payload(event))
    except Exception:  # noqa: BLE001 — transparency must never take a turn down
        logger.debug("Skill 'activated' event not emitted for %r", getattr(skill, "name", None), exc_info=True)


def emit_skill_loaded(skill: Skill, *, body_chars: int) -> None:
    """Record that the skill's body reached the model. Technical channel.

    Kept because an operator debugging "why did the answer ignore the skill"
    needs to know the instructions actually arrived, and because it is the only
    place the delivered size is knowable. Not a live line — and so carrying no
    ``key`` at all: the reader was told the skill is being applied at
    activation, and nothing here is new to them.
    """
    try:
        event = SkillEvent(
            phase="loaded",
            channel=CHANNEL_TECHNICAL,
            name=skill.name,
            title=skill_title(skill),
            origin=skill.origin,
            body_chars=body_chars,
        )
        push_custom_step(f"{SKILL_STEP_PREFIX}{skill.name}", _payload(event))
    except Exception:  # noqa: BLE001 — transparency must never take a turn down
        logger.debug("Skill 'loaded' event not emitted for %r", getattr(skill, "name", None), exc_info=True)
