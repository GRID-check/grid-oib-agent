"""Per-run skill runtime: prompt blocks + the ``use_skill`` tool.

Skills are progressive disclosure: L1 is the description list (never expanded
further than a line each), L2 is the full body, loaded ONLY through the
``use_skill`` tool. The runtime is per run (ADR-0018 — never cached on a
shared agent instance): it owns the ordered activation list that surfaces as
``skills_activated`` on the terminal frame, and records which skills were
FORCED for a turn vs. invoked by the model.

FORCED IS NOT ACTIVATED. Forcing a skill puts its NAME in the prompt's
"Active skills" block and nothing else — the body travels through exactly one
path, the ``use_skill`` closure below, and a model that never calls the tool
never reads a word of it. So forcing is recorded as a force, and activation is
recorded when the body is handed over. ``skills_activated`` is read by the
"Skills used" disclosure as *what shaped this answer*; a skill that was only
offered has not shaped anything, and saying it did is a false statement about
the answer's provenance in a product whose proposition is traceability. The
two facts are both kept — :attr:`SkillRuntime.forced` and
:attr:`SkillRuntime.activated` — and their difference,
:attr:`SkillRuntime.forced_not_activated`, is the honest name for "we told it
to, and it did not".

Activation is also ANNOUNCED as it happens (``skills.events``) rather than only
reported at the end of the turn -- a skill rewrites how the answer is made, so
the reader learns which working method is being applied while it still matters.
That announcement rides on the same fact for the same reason: it fires when the
body is delivered, not when the skill is forced, so the live line cannot say a
working method is being applied before the model has read it.

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

logger = logging.getLogger(__name__)

_L1_HEADING = "## Available skills"
_L1_DOCTRINE = "Call `use_skill` to load a skill's full instructions before following them."
_FORCED_HEADING = "## Active skills (required for this turn)"
_FORCED_DOCTRINE = (
    "The following skills are ACTIVE for this request and must be applied. Call "
    "`use_skill` for each of them as soon as its instructions become relevant — "
    "for a skill that governs how you WRITE, that is before you write the answer."
)

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
    know which of the 27 shapes this turn could possibly need, so it is the moment
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
        force_names: Skill names the user's request forced for this run.
        activated: Ordered skill names whose BODY was delivered this run, in
            delivery order. Never a name that was merely forced — see the
            module docstring.
    """

    def __init__(self, skills: tuple[Skill, ...] = (), force_names: list[str] | None = None) -> None:
        self._skills: tuple[Skill, ...] = skills
        self._by_name: dict[str, Skill] = {s.name: s for s in skills}
        self._forced: list[str] = []
        self._forced_seen: set[str] = set()
        self._standard: list[str] = []
        self._activated: list[str] = []
        self._activated_seen: set[str] = set()
        # A STANDARD skill is applied, not offered. `delivery: standard` already
        # means "resolved for every organization, no decision to make" — but
        # resolving it only put its one-line description in the catalog, and a
        # description the model may or may not open is not fleet policy. Forcing
        # it is what makes the tier mean what it says.
        #
        # This is a property of the skill, deliberately not a list of names in
        # this file: the platform owner publishes a standard skill in the
        # dashboard and it takes effect, with no deploy and nothing here to keep
        # in sync with a row somebody can rename.
        #
        # The user's own `/name` forces come first, so the forced block reads in
        # the order they asked for; standard skills follow, because they are the
        # floor rather than the request.
        #
        # What is recorded here is the FORCE, not an activation. Both kinds of
        # force still converge on one list so the forced block and the
        # `offered` event read from a single source — but neither says the
        # skill ran. A forced skill joins `activated` at the same site a
        # model-invoked one does: when `use_skill` hands over its body.
        standard = [s.name for s in skills if s.standard and s.name not in (force_names or ())]
        for name in list(force_names or ()) + standard:
            if name in self._by_name and name not in self._forced_seen:
                self._forced.append(name)
                self._forced_seen.add(name)
        self._standard = [name for name in self._forced if self._by_name[name].standard]

    @property
    def skills(self) -> tuple[Skill, ...]:
        return self._skills

    @property
    def forced(self) -> tuple[str, ...]:
        return tuple(self._forced)

    @property
    def activated(self) -> tuple[str, ...]:
        """Skills whose BODY reached the model, in delivery order.

        This is what ``skills_activated`` reports and what the disclosure
        renders as "what shaped this answer". A forced skill the model never
        opened is NOT here — see :attr:`forced_not_activated`.
        """
        return tuple(self._activated)

    @property
    def forced_not_activated(self) -> tuple[str, ...]:
        """Forced skills the model never opened, in force order.

        The turn told the model to apply these and it did not call
        ``use_skill`` for them, so not one word of their instructions was in
        front of it. Kept as its own fact rather than folded into either list:
        it is neither "this shaped the answer" (it did not) nor nothing at all
        (the platform owner or the user asked for it, and the ask was ignored),
        and it is the number worth counting per deployment.
        """
        return tuple(name for name in self._forced if name not in self._activated_seen)

    @property
    def standard_count(self) -> int:
        """How many skills this run is forced to carry as fleet policy.

        A ``delivery: standard`` skill is the deployment's floor, not the
        question's: nobody asked for it on this turn and the model has to spend
        a ``use_skill`` call to satisfy it. The research budget reserves that
        many iterations so a deployment publishing a second standard skill does
        not silently shorten every research chain by one (see
        ``ShallowResearcherAgent.reserved_tool_iterations``).
        """
        return len(self._standard)

    @property
    def hidden_activated(self) -> tuple[str, ...]:
        """Activated skills whose `grid-hidden` metadata is set.

        The disclosure names every activated skill (the transparency doctrine),
        but a skill that runs on EVERY answer — the house voice — is noise there
        as much as on the live line. This is the subset the frontend de-emphasises
        until the reader opens the reasoning view, so the panel is not dominated
        by an instruction the reader cannot act on. Resolved HERE rather than
        client-side because only the runtime holds each skill's metadata; a
        standard skill is excluded from the invocable list the disclosure reads.
        """
        from .models import skill_hidden

        return tuple(
            name
            for name in self._activated
            if (skill := self._by_name.get(name)) is not None and skill_hidden(skill.metadata)
        )

    def _record_activation(self, name: str) -> None:
        """Record ONE activation, first-wins, and announce it.

        The single place a skill becomes active this run — and it is reached
        from exactly one caller, the ``use_skill`` closure, because that is the
        only path a body travels. Whether the skill was forced or chosen is
        looked UP here rather than passed in: it is a fact about who decided,
        and the decider does not change what delivery means.

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

            emit_skill_activated(skill, forced=name in self._forced_seen)

    def prompt_block(self) -> str | None:
        """L1: the progressive-disclosure catalog section, or None when empty.

        One line per skill (name + description); the model must opt IN via
        ``use_skill`` to see a body. ``None`` when no skills apply — callers
        then render no skills section at all.
        """
        if not self._skills:
            return None
        lines = [_L1_HEADING, _L1_DOCTRINE, ""]
        lines.extend(f"- `{s.name}`: {s.description}" for s in self._skills)
        return "\n".join(lines)

    def forced_block(self) -> str | None:
        """L1 block naming the skills FORCED for this turn, or None."""
        if not self._forced:
            return None
        lines = [_FORCED_HEADING, _FORCED_DOCTRINE, ""]
        lines.extend(f"- `{name}`" for name in self._forced)
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
