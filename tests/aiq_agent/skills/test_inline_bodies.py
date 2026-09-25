"""Short skill bodies ride the prompt; the rest stay behind ``use_skill`` (ADR-0063).

What these pin: the budget is two caps in characters and either at 0 is the
old catalog-only block; the inlined block is delimited so a body's headings
cannot pass for the prompt's; a body in the prompt is NOT activated until the
envelope names it, and a name the model gives for a body that was not there
activates nothing; and the platform's own chat methods actually fit the
default budget, measured, because that is the premise the ADR rests on.
"""

from __future__ import annotations

from aiq_agent.skills.builtin import discover_builtin_skills
from aiq_agent.skills.models import Skill
from aiq_agent.skills.resolver import _skill_applies_to_agent
from aiq_agent.skills.runtime import SkillRuntime

SHORT = Skill(name="kurz", description="Kurze Methode.", body="# Kurz\n\nTu dies.", origin="platform")
SHORT_TWO = Skill(
    name="kurz-zwei",
    description="Zweite kurze Methode.",
    body="# Zwei\n\nTu das.",
    metadata={"grid-cards": "legal_basis,condition_tree"},
    origin="platform",
)
LONG = Skill(name="lang", description="Lange Methode.", body="x" * 5000, origin="org")

#: The opt-in budget ADR-0063 measured (the register's defaults are 0: the
#: turn-start decision reads the one chosen body in instead, ADR-0064).
MAX_BODY = 2400
BUDGET = 16000


def _runtime(*skills: Skill, max_body: int = MAX_BODY, budget: int = BUDGET) -> SkillRuntime:
    return SkillRuntime(skills=tuple(skills), inline_max_body_chars=max_body, inline_budget_chars=budget)


class TestTheBudget:
    def test_no_budget_is_the_catalog_only_block(self):
        runtime = SkillRuntime(skills=(SHORT, LONG))
        assert runtime.inlined == ()
        block = runtime.prompt_block() or ""
        assert block.startswith("## Available skills")
        assert "Tu dies." not in block

    def test_a_body_over_the_per_body_cap_stays_a_line_whatever_room_is_left(self):
        runtime = _runtime(LONG, SHORT)
        assert [s.name for s in runtime.inlined] == ["kurz"]

    def test_the_total_cap_is_filled_in_catalog_order(self):
        runtime = _runtime(SHORT, SHORT_TWO, max_body=100, budget=len(SHORT.body) + 1)
        assert [s.name for s in runtime.inlined] == ["kurz"]

    def test_either_cap_at_zero_inlines_nothing(self):
        assert _runtime(SHORT, max_body=0).inlined == ()
        assert _runtime(SHORT, budget=0).inlined == ()


class TestTheBlock:
    def test_inlined_bodies_are_delimited_and_the_rest_are_lines(self):
        block = _runtime(SHORT, SHORT_TWO, LONG).prompt_block() or ""
        assert block.startswith("## Skills")
        assert "`skills_applied`" in block
        assert '<skill name="kurz" description="Kurze Methode.">\n# Kurz\n\nTu dies.\n</skill>' in block
        assert "### Available by name" in block
        assert "- `lang`: Lange Methode." in block
        assert "x" * 50 not in block
        assert "use_skill" in block

    def test_a_card_preference_rides_as_names_and_never_as_shapes(self):
        block = _runtime(SHORT_TWO).prompt_block() or ""
        assert "Preferred cards: `legal_basis`, `condition_tree` — the author's preference, not a requirement." in block
        # The full shapes are what `use_skill` appends; the envelope contract
        # already teaches the common ones.
        assert "shape:" not in block and "Building blocks" not in block

    def test_the_inline_line_leaves_out_types_chat_writes_as_markdown(self):
        # Only chat inlines, and there `requirement_checklist` is a table with a
        # Status column: the envelope neither indexes nor shapes it.
        skill = Skill(
            name="pruefen",
            description="Prüfmethode.",
            body="# Prüfen",
            metadata={"grid-cards": "requirement_checklist,legal_basis,comparison_table"},
            origin="platform",
        )
        block = _runtime(skill).prompt_block() or ""
        assert "Preferred cards: `legal_basis` — the author's preference, not a requirement." in block
        assert "requirement_checklist" not in block and "comparison_table" not in block

    def test_only_markdown_types_render_no_preferred_line(self):
        skill = Skill(
            name="tabelle",
            description="Tabellenmethode.",
            body="# Tabelle",
            metadata={"grid-cards": "requirement_checklist"},
            origin="platform",
        )
        assert "Preferred cards" not in (_runtime(skill).prompt_block() or "")

    def test_use_skill_still_offers_the_card_deep_research_can_emit(self):
        skill = Skill(
            name="pruefen",
            description="Prüfmethode.",
            body="# Prüfen",
            metadata={"grid-cards": "requirement_checklist"},
            origin="platform",
        )
        tool = SkillRuntime(skills=(skill,)).build_tools()[0]
        assert "`requirement_checklist`" in tool.invoke({"skill_name": "pruefen"})

    def test_everything_inlined_renders_no_by_name_section(self):
        block = _runtime(SHORT).prompt_block() or ""
        assert "### Available by name" not in block


class TestActivation:
    def test_an_inlined_body_is_not_activated_by_being_there(self):
        runtime = _runtime(SHORT)
        assert runtime.activated == ()

    def test_the_envelope_naming_it_activates_it_once_in_order(self):
        runtime = _runtime(SHORT, SHORT_TWO)
        assert runtime.record_applied(["kurz-zwei", "`kurz`", "kurz-zwei"]) == ("kurz-zwei", "kurz")
        assert runtime.activated == ("kurz-zwei", "kurz")

    def test_a_name_whose_body_was_not_in_the_prompt_activates_nothing(self):
        """``lang`` was a catalog line; ``nope`` was nothing. Neither reached the model."""
        runtime = _runtime(SHORT, LONG)
        assert runtime.record_applied(["lang", "nope"]) == ()
        assert runtime.activated == ()

    def test_use_skill_still_delivers_an_inlined_body_and_activates_it(self):
        """A model on an older prompt, or one that loads what it already has: same body, one activation."""
        runtime = _runtime(SHORT)
        tool = next(t for t in runtime.build_tools() if t.name == "use_skill")
        assert tool.invoke({"skill_name": "kurz"}).startswith("# Kurz")
        assert runtime.activated == ("kurz",)
        runtime.record_applied(["kurz"])
        assert runtime.activated == ("kurz",)


class TestTheOfferedEvent:
    def test_it_counts_the_inlined(self, monkeypatch):
        from aiq_agent.skills import events

        pushed: list = []
        monkeypatch.setattr(events, "push_custom_step", lambda name, payload: pushed.append((name, payload)))
        events.emit_skills_offered(_runtime(SHORT, LONG))
        assert pushed and pushed[0][1]["offered_count"] == 2 and pushed[0][1]["inlined_count"] == 1


class TestThePremiseIsMeasured:
    def test_the_chat_platform_methods_fit_the_default_budget_together(self):
        """ADR-0060 assumed a body is 'thousands of tokens'. The chat office's
        methods are ~1 600 characters each; the one long one is the IFC method.
        If this fails, a method grew past the cap — decide whether it should
        ride, and say so in the ADR, rather than raising the cap in passing."""
        chat = tuple(s for s in discover_builtin_skills() if _skill_applies_to_agent(s, "researcher"))
        runtime = SkillRuntime(skills=chat, inline_max_body_chars=MAX_BODY, inline_budget_chars=BUDGET)
        inlined = {s.name for s in runtime.inlined}
        assert "ifc-spatial-reasoning" not in inlined
        assert {"gebaeudeklasse", "brandschutz", "einreichcheck", "bestand"} <= inlined
        assert len(inlined) == len(chat) - 1, sorted(set(s.name for s in chat) - inlined)
        assert sum(len(s.body) for s in runtime.inlined) <= BUDGET
