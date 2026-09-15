"""Per-run skill runtime: the L1 catalog + the ``use_skill`` tool.

Skills are progressive disclosure: L1 is the description list (never expanded
further than a line each), L2 is the full body, loaded ONLY through the
``use_skill`` tool. The runtime is per run (ADR-0018 — never cached on a
shared agent instance): it owns the ordered activation list that surfaces as
``skills_activated`` on the terminal frame.

A SKILL IS AN OFFER. Nothing in this module can put a skill's instructions in
front of the model: the catalog carries one line per skill and the body travels
through exactly one path, the ``use_skill`` closure below, called because the
model decided the skill applies. There is no way to mark a skill as required,
for a deployment or for one request, and that is the point — a working method
the model was ordered to open is a standing instruction wearing a tool's
clothes. Standing instructions belong in prompt text that says what must be
true of the answer (the platform prompt, and the office's own instruction
block), where they cost no tool call and cannot be half-applied.

So ``activated`` means one thing only: the body was handed over. It is read by
the "Skills used" disclosure as *what shaped this answer*, and in a product
whose proposition is traceability a skill that was merely listed has shaped
nothing.

Activation is also ANNOUNCED as it happens (``skills.events``) rather than only
reported at the end of the turn -- a skill rewrites how the answer is made, so
the reader learns which working method is being applied while it still matters.
That announcement rides on the same fact for the same reason: it fires when the
body is delivered, so the live line cannot say a working method is being
applied before the model has read it.

All scaffolding here is ENGLISH. The agent answers in the user's language —
that is decided per turn from the question, not baked into the machinery — and a
prompt that mixes German block headings into English instructions is neither
localised nor language-agnostic. Country-specific text belongs in
``CountryProfile`` or in an authored skill body, not in string constants here
(see docs/architecture/country-extensibility.md). The event payloads follow the
same rule for the same reason: they carry keys, not sentences.
"""

from __future__ import annotations

import logging

from .models import Skill
from .models import preferred_cards
from .models import skill_auto_invoke

logger = logging.getLogger(__name__)

_L1_HEADING = "## Available skills"
_L1_DOCTRINE = "Call `use_skill` to load a skill's full instructions before following them."

_TOOL_NAME = "use_skill"
_TOOL_DESCRIPTION = (
    "Load the full instructions of a skill by name before following them. "
    "Call this once per skill you intend to use; it returns the complete skill body."
)

_CARDS_HEADING = "## Preferred cards"
_CARDS_DOCTRINE = (
    "Where the content supports it, present the result as one of these cards: {types}. "
    "This is the skill author's preference, not a requirement — if none of them fits the "
    "result, pick the card that does or answer in prose. Never invent content just to fill "
    "one of these cards. Their exact shapes follow, so you can call `emit_card` directly "
    "without looking them up."
)


def _preferred_cards_block(skill: Skill) -> str | None:
    """The ``grid-cards`` block appended to a body on activation, or None.

    Deliberately appended HERE and not in ``prompt_block``: the level-1 catalog
    is paid for on every turn by every skill, and a card preference is worth
    nothing until the skill is actually in play. The phrasing stays a preference
    on purpose — an author naming three cards must not be able to force a
    ``comparison_table`` onto an answer that has nothing to compare.

    That same reasoning is why the full SHAPES ride along here rather than in the
    always-on ``emit_card`` catalog. A skill that names its cards is the moment we
    know which of the 38 shapes this turn could possibly need, so it is the moment
    to spend context on them — and it saves the activated turn a `describe_card`
    round-trip it would otherwise always pay.
    """
    cards = preferred_cards(skill.metadata)
    if not cards:
        return None
    types = ", ".join(f"`{card}`" for card in cards)
    block = f"{_CARDS_HEADING}\n{_CARDS_DOCTRINE.format(types=types)}"
    # Imported lazily: the skills runtime is imported on paths that never touch
    # the card catalog, and this keeps that direction of the dependency optional.
    from aiq_agent.cards.catalog import render_card_details

    details = render_card_details(cards)
    return f"{block}\n\n{details}" if details else block


class SkillRuntime:
    """Holds the resolved skills of ONE run and builds its prompt/tool wiring.

    Attributes:
        skills: The resolved skill set for this run (builtin + org, allowlisted).
        activated: Skill names whose BODY was delivered this run, in call order.
    """

    def __init__(self, skills: tuple[Skill, ...] = ()) -> None:
        self._skills: tuple[Skill, ...] = skills
        self._by_name: dict[str, Skill] = {s.name: s for s in skills}
        self._activated: list[str] = []
        self._activated_seen: set[str] = set()

    @property
    def skills(self) -> tuple[Skill, ...]:
        return self._skills

    @property
    def activated(self) -> tuple[str, ...]:
        """Skills whose BODY reached the model, in the order it asked for them.

        This is what ``skills_activated`` reports and what the disclosure
        renders as "what shaped this answer". A skill the model never opened is
        not here, whoever listed it in the catalog.
        """
        return tuple(self._activated)

    @property
    def hidden_activated(self) -> tuple[str, ...]:
        """Activated skills whose `grid-hidden` metadata is set.

        The disclosure names every activated skill (the transparency doctrine),
        but a skill that runs on EVERY answer — the house voice — is noise there
        as much as on the live line. This is the subset the frontend de-emphasises
        until the reader opens the reasoning view, so the panel is not dominated
        by an instruction the reader cannot act on. Resolved HERE rather than
        client-side because only the runtime holds each skill's metadata.
        """
        from .models import skill_hidden

        return tuple(
            name
            for name in self.activated
            if (skill := self._by_name.get(name)) is not None and skill_hidden(skill.metadata)
        )

    def _record_activation(self, name: str) -> None:
        """Record ONE activation, first-wins, and announce it.

        The single place a skill becomes active this run — and it is reached
        from exactly one caller, the ``use_skill`` closure, because that is the
        only path a body travels.

        Re-activation is a no-op -- including the announcement, so a model that
        calls ``use_skill`` three times for the same skill does not say so
        three times.
        """
        if name in self._activated_seen:
            return
        self._activated.append(name)
        self._activated_seen.add(name)
        skill = self._by_name.get(name)
        if skill is not None:
            from .events import emit_skill_activated

            emit_skill_activated(skill)

    def prompt_block(self) -> str | None:
        """L1: the progressive-disclosure catalog section, or None when empty.

        One line per skill the model may pick (name + description); the model
        must opt IN via ``use_skill`` to see a body. Skills whose
        ``grid-auto-invoke`` is off are omitted here — they remain resolved and
        remain in the ``/`` picker, which inserts a mention into the message
        text rather than reaching into this catalog.

        ``None`` when nothing belongs in the catalog — callers then render no
        skills section at all.
        """
        listed = [s for s in self._skills if skill_auto_invoke(s.metadata)]
        if not listed:
            return None
        lines = [_L1_HEADING, _L1_DOCTRINE, ""]
        lines.extend(f"- `{s.name}`: {s.description}" for s in listed)
        return "\n".join(lines)

    def build_tools(self) -> list[object]:
        """The ``use_skill`` tool closure for this run; [] when no skills apply.

        The closure captures THIS runtime instance, so multiple agents built
        from the same skill set never share activation state.
        """
        if not self._skills:
            return []
        from langchain_core.tools import tool as langchain_tool

        runtime = self

        @langchain_tool(_TOOL_NAME)
        def use_skill(skill_name: str) -> str:
            """Return the full instructions of ``skill_name``, or an error listing the available skills."""
            skill = runtime._by_name.get(skill_name)
            if skill is None:
                available = ", ".join(sorted(runtime._by_name))
                return (
                    f"Unknown skill '{skill_name}'. Available skills: {available}. "
                    f"Call `{_TOOL_NAME}` with one of those names."
                )
            runtime._record_activation(skill_name)
            cards_block = _preferred_cards_block(skill)
            body = f"{skill.body}\n\n{cards_block}" if cards_block else skill.body
            from .events import emit_skill_loaded

            emit_skill_loaded(skill, body_chars=len(body))
            return body

        use_skill.description = _TOOL_DESCRIPTION
        return [use_skill]
