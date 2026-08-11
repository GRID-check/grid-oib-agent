"""Per-run SkillRuntime: activation order, prompt blocks, use_skill closure."""

from __future__ import annotations

from aiq_agent.skills.models import Skill
from aiq_agent.skills.runtime import SkillRuntime

S1 = Skill(name="alpha", description="Erster Skill.", body="alpha body", origin="platform")
S2 = Skill(name="beta", description="Zweiter Skill.", body="beta body", origin="platform")
CARDS = Skill(
    name="gamma",
    description="Dritter Skill.",
    body="gamma body",
    metadata={"grid-cards": "comparison_table,summary"},
    origin="platform",
)


def _use_skill(runtime: SkillRuntime) -> object:
    return next(t for t in runtime.build_tools() if t.name == "use_skill")


def _runtime(*, forced: list[str] | None = None) -> SkillRuntime:
    return SkillRuntime(skills=(S1, S2), force_names=forced)


def test_no_skills_yields_no_prompt_and_no_tools() -> None:
    runtime = SkillRuntime(skills=())
    assert runtime.prompt_block() is None
    assert runtime.forced_block() is None
    assert runtime.build_tools() == []
    assert runtime.activated == ()


def test_prompt_block_lists_descriptions_only() -> None:
    block = _runtime().prompt_block()
    assert block is not None
    assert block.startswith("## Verfügbare Skills")
    assert "use_skill" in block
    assert "`alpha`: Erster Skill." in block
    # Progressive disclosure: bodies NEVER leak into the prompt.
    assert "alpha body" not in block
    assert "beta body" not in block


def test_forced_names_come_first_in_activation_order() -> None:
    runtime = _runtime(forced=["beta"])
    assert runtime.forced == ("beta",)
    assert runtime.activated == ("beta",)
    tools = runtime.build_tools()
    tool = next(t for t in tools if t.name == "use_skill")
    assert tool.invoke({"skill_name": "alpha"}) == "alpha body"
    # Model invocation appends after the forced entry.
    assert runtime.activated == ("beta", "alpha")
    # Re-invoking the same skill does not duplicate it.
    tool.invoke({"skill_name": "alpha"})
    assert runtime.activated == ("beta", "alpha")


def test_forced_block_names_only_forced_skills() -> None:
    block = _runtime(forced=["beta"]).forced_block()
    assert block is not None
    assert block.startswith("## Aktive Skills (vom Nutzer erzwungen)")
    assert "`beta`" in block
    assert "`alpha`" not in block


def test_force_unknown_skill_is_ignored() -> None:
    runtime = SkillRuntime(skills=(S1,), force_names=["ghost", "alpha"])
    assert runtime.forced == ("alpha",)
    assert runtime.activated == ("alpha",)
    assert runtime.forced_block().startswith("## Aktive Skills")


def test_forced_block_none_when_nothing_forced() -> None:
    assert _runtime().forced_block() is None


def test_unknown_skill_message_lists_available_names() -> None:
    tools = _runtime().build_tools()
    tool = next(t for t in tools if t.name == "use_skill")
    result = tool.invoke({"skill_name": "nope"})
    assert "Unbekannter Skill 'nope'" in result
    assert "alpha" in result and "beta" in result
    # A failed load never activates the skill.
    assert _runtime().activated == ()


def test_preferred_cards_are_appended_on_activation_only() -> None:
    runtime = SkillRuntime(skills=(S1, CARDS))
    body = _use_skill(runtime).invoke({"skill_name": "gamma"})
    assert body.startswith("gamma body")
    assert "## Bevorzugte Cards" in body
    # Author order is preserved, and the types are named verbatim so the model
    # can copy them into `type` without translating a prose paraphrase.
    assert "`comparison_table`, `summary`" in body
    # A preference, not a command — the wording must leave an out.
    assert "keine Vorgabe" in body
    # The whole point of the feature: it costs nothing until activation.
    assert "Bevorzugte Cards" not in (runtime.prompt_block() or "")


def test_skill_without_preferred_cards_returns_the_bare_body() -> None:
    runtime = SkillRuntime(skills=(S1, CARDS))
    assert _use_skill(runtime).invoke({"skill_name": "alpha"}) == "alpha body"


def test_unknown_and_system_card_types_never_reach_the_model() -> None:
    # Snapshots persisted before a card type was retired (or a row that slipped
    # past write-time validation) must not name a card the renderer lacks — and
    # a SYSTEM card must never be requested by name on any path.
    skill = Skill(
        name="delta",
        description="Vierter Skill.",
        body="delta body",
        metadata={"grid-cards": "summary,memory_proposal,ganz_erfunden"},
    )
    body = _use_skill(SkillRuntime(skills=(skill,))).invoke({"skill_name": "delta"})
    assert "`summary`" in body
    assert "memory_proposal" not in body
    assert "ganz_erfunden" not in body


def test_empty_preferred_cards_value_adds_no_block() -> None:
    skill = Skill(name="eps", description="Fünfter.", body="eps body", metadata={"grid-cards": " , "})
    assert _use_skill(SkillRuntime(skills=(skill,))).invoke({"skill_name": "eps"}) == "eps body"


def test_two_runtimes_share_no_activation_state() -> None:
    first = _runtime()
    second = _runtime()
    first_tool = next(t for t in first.build_tools() if t.name == "use_skill")
    first_tool.invoke({"skill_name": "alpha"})
    assert first.activated == ("alpha",)
    assert second.activated == ()
