"""Per-run skill runtime: the skills block + the ``use_skill`` tool.

Skills are progressive disclosure with a measured shortcut (ADR-0063, as
amended). Every resolved skill is in the catalog; the ONE body the turn-start
decision picks (ADR-0064, ``inline_also``) rides the prompt in full and the
model follows it without a call — or, for a caller that sets the opt-in
budget, every body short enough to fit. Everything else is one catalog line,
and its body travels through the ``use_skill`` tool. The runtime is per run (ADR-0018 — never cached on a shared agent
instance): it owns the ordered activation list that surfaces as
``skills_activated`` on the terminal frame.

Why the shortcut: a ``use_skill`` call ends a message, so the body arrives one
full-context call later — the whole prefix and every message re-sent, 3-8 s
of latency, and a second round when the body says to load another (the
Brandschutz method opens with "load ``gebaeudeklasse`` first"). The chat
office's own methods are ~400 tokens each and ~3 800 tokens together
(``tests/aiq_agent/skills/test_runtime.py`` measures it), which is the cost
of one such round about ten times over. ADR-0060 rejected inlining on the
premise that a body is "thousands of tokens"; it is, for the writers deep
research uses (7-9k chars), and those stay on the catalog line. The budget
is what keeps the premise measured rather than assumed: it is in characters,
per body and in total, and a body over either is offered exactly as before.

A SKILL IS AN OFFER. Nothing in this module can REQUIRE a skill: whether its
body sits in the prompt or behind ``use_skill``, the model decides whether the
question is the skill's subject, and a skill it did not choose shaped nothing.
There is no way to mark a skill as required, for a deployment or for one
request, and that is the point — a working method the model was ordered to
follow is a standing instruction wearing a tool's clothes. Standing
instructions belong in prompt text that says what must be true of the answer
(the platform prompt, and the office's own instruction block), where they
cannot be half-applied. Inlining moves WHERE an offer is read, not whether it
is one.

So ``activated`` means the body reached the model AND was followed: handed
over by ``use_skill``, or ridden in the prompt and NAMED by the model in the
envelope's ``skills_applied`` (``record_applied``). It is read by the "Skills
used" disclosure as *what shaped this answer*, and in a product whose
proposition is traceability a skill that was merely listed has shaped
nothing. A body in the prompt is listed until the model says it followed
it; a name the model gives that was neither in the prompt nor delivered is
dropped, because no body reached it.

Activation is also ANNOUNCED (``skills.events``) rather than only reported at
the end of the turn -- a skill rewrites how the answer is made, so the reader
learns which working method is being applied. The announcement rides on the
same fact: a ``use_skill`` delivery announces as it happens, and an inlined
skill announces when the envelope names it, so the live line never says a
working method is being applied before the model has read and chosen it.

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
from collections.abc import Sequence

from .models import Skill
from .models import preferred_cards

logger = logging.getLogger(__name__)

_L1_HEADING = "## Available skills"
_L1_DOCTRINE = "Call `use_skill` to load a skill's full instructions before following them."

_INLINE_HEADING = "## Skills"
_INLINE_DOCTRINE = (
    "The office's working methods; you decide which one a question is the subject of. The ones "
    "below are here in full: follow one without loading it, and name every one you followed in "
    "the `skills_applied` field of your answer envelope — that is how the reader learns which "
    "method shaped the answer. A skill below that says to load another that is also below is "
    "asking you to read it here."
)
_INLINE_REST_HEADING = "### Available by name"
_INLINE_REST_DOCTRINE = "Longer methods, one line each. Call `use_skill` to load one before following it."
_INLINE_CARDS_LINE = "Preferred cards: {types} — the author's preference, not a requirement."

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
    "one of these cards. Their exact shapes follow, so you can emit them without looking them up."
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


def _within_budget(skills: tuple[Skill, ...], max_body_chars: int, budget_chars: int) -> tuple[Skill, ...]:
    """The skills whose body rides the prompt: catalog order, greedy, two caps.

    A body longer than ``max_body_chars`` never rides, whatever room is left —
    the per-body cap is what keeps one long method from taking the whole
    budget. The total cap is filled in catalog order (platform, then the org's
    own), so what an org sees is stable across turns and changes only when the
    org changes its skills. Either cap at 0 means nothing rides.
    """
    if max_body_chars <= 0 or budget_chars <= 0:
        return ()
    chosen: list[Skill] = []
    spent = 0
    for skill in skills:
        size = len(skill.body)
        if size > max_body_chars or spent + size > budget_chars:
            continue
        chosen.append(skill)
        spent += size
    return tuple(chosen)


def _inline_skill(skill: Skill) -> str:
    """One inlined skill: its element, and its card preference as one line.

    The preference rides as names only. The eight shapes answers earn most are
    in the envelope contract already, and any other miss is repaired by the
    small model (``cards/envelope.py``), so the full shapes ``use_skill``
    appends would be paid on every call for nothing.
    """
    cards = preferred_cards(skill.metadata)
    body = skill.body.strip()
    if cards:
        types = ", ".join(f"`{card}`" for card in cards)
        body = f"{body}\n\n{_INLINE_CARDS_LINE.format(types=types)}"
    description = " ".join(skill.description.split())
    return f'<skill name="{skill.name}" description="{description}">\n{body}\n</skill>'


class SkillRuntime:
    """Holds the resolved skills of ONE run and builds its prompt/tool wiring.

    Attributes:
        skills: The resolved skill set for this run (builtin + org, allowlisted).
        inlined: The subset whose body rides the prompt, within the caller's budget.
        activated: Skill names whose body was delivered and followed this run, in order.
    """

    def __init__(
        self,
        skills: tuple[Skill, ...] = (),
        *,
        inline_max_body_chars: int = 0,
        inline_budget_chars: int = 0,
    ) -> None:
        self._skills: tuple[Skill, ...] = skills
        self._by_name: dict[str, Skill] = {s.name: s for s in skills}
        self._activated: list[str] = []
        self._activated_seen: set[str] = set()
        self._inlined: tuple[Skill, ...] = _within_budget(skills, inline_max_body_chars, inline_budget_chars)

    @property
    def skills(self) -> tuple[Skill, ...]:
        return self._skills

    @property
    def inlined(self) -> tuple[Skill, ...]:
        """The skills whose body rides the prompt this run, in catalog order.

        Empty unless the caller set a budget: deep research builds a runtime
        with the defaults and keeps every body behind ``use_skill``, because
        its writer has no envelope to name a followed skill in.
        """
        return self._inlined

    def inline_also(self, names: Sequence[str]) -> tuple[str, ...]:
        """Ride the named skills in this run's prompt whatever their size; return what was added.

        For a body the caps keep out (``ifc-spatial-reasoning`` at 17k chars)
        on a turn something already knows is its subject — the turn-start
        decision's ``skill`` choice (ADR-0064). Still an offer: it moves where
        the body is read, not whether the model follows it. Unknown names and
        skills already inlined are ignored.
        """
        added: list[str] = []
        inlined = {skill.name for skill in self._inlined}
        for name in names:
            skill = self._by_name.get(name)
            if skill is None or name in inlined:
                continue
            self._inlined = (*self._inlined, skill)
            inlined.add(name)
            added.append(name)
        return tuple(added)

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

    def record_applied(self, names: Sequence[str]) -> tuple[str, ...]:
        """Activate the INLINED skills the model says it followed; return what newly activated.

        The envelope's ``skills_applied`` is the model's own account of which
        of the bodies in its prompt shaped the answer. Only a name whose body
        was in the prompt can be accepted: a skill delivered by ``use_skill``
        is already active, and a name that matches nothing had no body reach
        the model, so it shaped nothing whatever the model wrote. The
        announcement fires here, with the answer, which is later than a
        ``use_skill`` delivery announces — the price of the round it saves.
        """
        accepted: list[str] = []
        inlined = {skill.name for skill in self._inlined}
        for raw in names:
            name = str(raw).strip().strip("`")
            if name not in inlined:
                logger.debug("skills_applied names %r, which was not inlined this run; ignored", name)
                continue
            if name in self._activated_seen:
                continue
            self._record_activation(name)
            accepted.append(name)
        return tuple(accepted)

    def prompt_block(self) -> str | None:
        """The skills section of the system prompt, or None when there are no skills.

        With a budget: the inlined bodies in full under ``## Skills``, each in
        a ``<skill name="…">`` element so its own headings cannot pass for the
        prompt's, followed by one line per remaining skill. Without one: the
        L1 catalog only, one line per resolved skill (name + description), and
        the model must opt IN via ``use_skill`` to see a body.

        EVERY resolved skill is listed. ``grid-auto-invoke`` used to cut rows
        out of here, which made the catalog a thing a person edited rather than
        the model's own inventory — the same shape ADR-0060 removed everywhere
        else. Its author-facing switch is gone, so honouring a stored ``false``
        would now hide a skill from every turn with nobody able to bring it
        back. The key is still accepted on a document (an old row must not
        start erroring); nothing reads it.

        ``None`` when nothing belongs in the catalog — callers then render no
        skills section at all.
        """
        if not self._skills:
            return None
        if not self._inlined:
            lines = [_L1_HEADING, _L1_DOCTRINE, ""]
            lines.extend(f"- `{s.name}`: {s.description}" for s in self._skills)
            return "\n".join(lines)
        parts = [f"{_INLINE_HEADING}\n{_INLINE_DOCTRINE}"]
        parts.extend(_inline_skill(skill) for skill in self._inlined)
        rest = [skill for skill in self._skills if skill not in self._inlined]
        if rest:
            lines = [_INLINE_REST_HEADING, _INLINE_REST_DOCTRINE, ""]
            lines.extend(f"- `{s.name}`: {s.description}" for s in rest)
            parts.append("\n".join(lines))
        return "\n\n".join(parts)

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
