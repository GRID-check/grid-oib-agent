"""Per-run SkillRuntime: activation order, prompt blocks, use_skill closure.

Also the transparency events activation emits (``aiq_agent.skills.events``)
— what a reader is told while a skill is shaping the answer, and what is only
recorded for the details panel.
"""

from __future__ import annotations

import pytest

from aiq_agent.common.wire_v2 import SkillStep
from aiq_agent.skills.events import emit_skills_offered
from aiq_agent.skills.models import Skill
from aiq_agent.skills.runtime import SkillRuntime

S1 = Skill(name="alpha", description="Erster Skill.", body="alpha body", origin="platform")
S2 = Skill(name="beta", description="Zweiter Skill.", body="beta body", origin="platform")
CARDS = Skill(
    name="gamma",
    description="Dritter Skill.",
    body="gamma body",
    metadata={"grid-cards": "stair_diagram,calculation"},
    origin="platform",
)
TITLED = Skill(
    name="titel",
    description="Skill mit Anzeigenamen.",
    body="titel body",
    metadata={"grid-title": "Brandschutznachweis"},
    origin="org",
)
TITLED_TWO = Skill(
    name="titel-zwei",
    description="Zweiter Skill mit Anzeigenamen.",
    body="titel-zwei body",
    metadata={"grid-title": "Fluchtwegprüfung"},
    origin="org",
)
# A hidden skill WITH a title: proves hidden demotes the live line even when a
# perfectly good title exists — the voice-skill case.
HIDDEN = Skill(
    name="piloti-voice",
    description="Hausstimme, auf jeder Antwort.",
    body="voice body",
    metadata={"grid-title": "Piloti-Stimme", "grid-hidden": "true"},
    origin="platform",
)


def _use_skill(runtime: SkillRuntime) -> object:
    return next(t for t in runtime.build_tools() if t.name == "use_skill")


def _runtime() -> SkillRuntime:
    return SkillRuntime(skills=(S1, S2))


def test_no_skills_yields_no_prompt_and_no_tools() -> None:
    runtime = SkillRuntime(skills=())
    assert runtime.prompt_block() is None
    assert runtime.build_tools() == []
    assert runtime.activated == ()


def test_the_runtime_offers_and_cannot_require() -> None:
    """There is no way to put a skill in front of the model.

    The whole surface is the catalog plus ``use_skill``: no constructor
    argument names a skill, no second prompt block says one is active, and no
    property reports what was "asked for and ignored". A standing instruction
    the answer must obey is prompt text, not a tool call the model may skip.
    """
    runtime = SkillRuntime(skills=(S1, S2))
    for gone in ("forced", "forced_block", "forced_not_activated", "standard_count", "force_names"):
        assert not hasattr(runtime, gone), gone
    with pytest.raises(TypeError):
        SkillRuntime(skills=(S1,), force_names=["alpha"])  # type: ignore[call-arg]


def test_prompt_block_lists_descriptions_only() -> None:
    block = _runtime().prompt_block()
    assert block is not None
    assert block.startswith("## Available skills")
    assert "use_skill" in block
    assert "`alpha`: Erster Skill." in block
    # Progressive disclosure: bodies NEVER leak into the prompt.
    assert "alpha body" not in block
    assert "beta body" not in block


def test_a_stored_auto_invoke_off_does_not_hide_a_skill() -> None:
    """The catalog is the model's inventory, not a list a person edits.

    ``grid-auto-invoke: false`` must not cut a row out of L1. The catalog has no
    author-facing switch (ADR-0060: nothing but the model decides which skill runs),
    and honouring the stored token would hide a skill from every turn with
    nobody able to bring it back. The key still parses; it decides nothing.
    """
    silent = Skill(
        name="einreichcheck",
        description="Was diesem Bauansuchen noch fehlt.",
        body="body",
        metadata={"grid-auto-invoke": "false"},
        origin="platform",
    )
    runtime = SkillRuntime(skills=(S1, silent))
    block = runtime.prompt_block() or ""
    assert "`alpha`: Erster Skill." in block
    assert "`einreichcheck`: Was diesem Bauansuchen noch fehlt." in block
    assert runtime.build_tools()


def test_prompt_block_is_none_only_when_there_are_no_skills_at_all() -> None:
    assert SkillRuntime(skills=()).prompt_block() is None


def test_only_a_delivered_body_counts_as_activated() -> None:
    """Listing a skill shapes nothing; handing its body over does.

    ``activated`` is what the disclosure renders as "this shaped the answer",
    and the catalog is on every turn. A model that read past `beta`'s line has
    not been shaped by `beta`.
    """
    runtime = _runtime()
    assert runtime.activated == ()
    _use_skill(runtime).invoke({"skill_name": "beta"})
    assert runtime.activated == ("beta",)


def test_what_was_delivered_is_reported_in_call_order() -> None:
    """One order, and it is the model's own: the order it asked.

    There is no second order to reconcile with it — no forced list in front, no
    fleet floor behind — so the list reads as the run happened.
    """
    runtime = _runtime()
    tool = _use_skill(runtime)
    assert tool.invoke({"skill_name": "alpha"}) == "alpha body"
    assert tool.invoke({"skill_name": "beta"}) == "beta body"
    assert runtime.activated == ("alpha", "beta")
    # Re-invoking the same skill does not duplicate it.
    tool.invoke({"skill_name": "alpha"})
    assert runtime.activated == ("alpha", "beta")


def test_unknown_skill_message_lists_available_names() -> None:
    tools = _runtime().build_tools()
    tool = next(t for t in tools if t.name == "use_skill")
    result = tool.invoke({"skill_name": "nope"})
    assert "Unknown skill 'nope'" in result
    assert "alpha" in result and "beta" in result
    # A failed load never activates the skill.
    assert _runtime().activated == ()


def test_preferred_cards_are_appended_on_activation_only() -> None:
    runtime = SkillRuntime(skills=(S1, CARDS))
    body = _use_skill(runtime).invoke({"skill_name": "gamma"})
    assert body.startswith("gamma body")
    assert "## Preferred cards" in body
    # Author order is preserved, and the types are named verbatim so the model
    # can copy them into `type` without translating a prose paraphrase.
    assert "`stair_diagram`, `calculation`" in body
    # A preference, not a command — the wording must leave an out.
    assert "not a requirement" in body
    # The whole point of the feature: it costs nothing until activation.
    assert "Preferred cards" not in (runtime.prompt_block() or "")


def test_skill_without_preferred_cards_returns_the_bare_body() -> None:
    runtime = SkillRuntime(skills=(S1, CARDS))
    assert _use_skill(runtime).invoke({"skill_name": "alpha"}) == "alpha body"


def test_unknown_and_system_card_types_never_reach_the_model() -> None:
    # Persisted snapshots may name a retired card type, and a row may slip past
    # write-time validation; neither may name a card the renderer lacks. A
    # SYSTEM card must never be requested by name on any path.
    skill = Skill(
        name="delta",
        description="Vierter Skill.",
        body="delta body",
        metadata={"grid-cards": "calculation,memory_proposal,ganz_erfunden,legal_basis"},
    )
    body = _use_skill(SkillRuntime(skills=(skill,))).invoke({"skill_name": "delta"})
    assert "`calculation`" in body
    assert "legal_basis" not in body
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


class TestActivationEvents:
    """What leaves the process while the skills are in play: typed ``skill`` steps."""

    def test_each_activation_emits_exactly_one_step_for_its_skill(self, emitted) -> None:
        runtime = SkillRuntime(skills=(S1, S2, TITLED))
        tool = _use_skill(runtime)
        tool.invoke({"skill_name": "titel"})
        # Re-invoking an already-active skill must not say so a second time.
        tool.invoke({"skill_name": "titel"})
        tool.invoke({"skill_name": "beta"})

        # One STEP per skill: sharing an id collapses N skills into one row.
        assert emitted.steps == [
            SkillStep(id="skill:titel", phase="activated", skill="titel", title="Brandschutznachweis"),
            SkillStep(id="skill:beta", phase="activated", skill="beta", channel="technical"),
        ]
        # The reported list is the same order the steps came in: call order.
        assert runtime.activated == ("titel", "beta")

    def test_a_titled_skill_is_live_and_carries_only_its_title(self, emitted) -> None:
        """The office's own name for its method, never the id and never a sentence."""
        runtime = SkillRuntime(skills=(TITLED, TITLED_TWO))
        _use_skill(runtime).invoke({"skill_name": "titel"})
        _use_skill(runtime).invoke({"skill_name": "titel-zwei"})
        assert [(step.channel, step.title) for step in emitted.steps] == [
            ("live", "Brandschutznachweis"),
            ("live", "Fluchtwegprüfung"),
        ]

    def test_a_skill_without_a_title_gets_no_live_line(self, emitted) -> None:
        """An id in a status line is worse than silence; the step still records it."""
        _use_skill(SkillRuntime(skills=(S1,))).invoke({"skill_name": "alpha"})
        assert emitted.steps == [SkillStep(id="skill:alpha", phase="activated", skill="alpha", channel="technical")]

    def test_a_hidden_skill_is_recorded_but_kept_off_the_live_line(self, emitted) -> None:
        """Hidden = out of the noisy live line, never concealed: it still names itself."""
        _use_skill(SkillRuntime(skills=(HIDDEN,))).invoke({"skill_name": "piloti-voice"})
        assert emitted.steps == [
            SkillStep(
                id="skill:piloti-voice",
                phase="activated",
                skill="piloti-voice",
                title="Piloti-Stimme",
                hidden=True,
                channel="technical",
            )
        ]

    def test_offered_reports_the_catalog_but_never_as_activity(self, emitted) -> None:
        emit_skills_offered(SkillRuntime(skills=(S1, S2)))
        # Availability is not activity: a catalog size must never be shown live.
        assert emitted.steps == [SkillStep(id="skill_selection", phase="offered", count=2, channel="technical")]

    def test_a_turn_with_no_skills_says_nothing(self, emitted) -> None:
        emit_skills_offered(SkillRuntime(skills=()))
        assert emitted == []


#: A row the BFF marked ``standard``. The backend does not read that marker —
#: there is no ``Skill.standard`` field — so it is an ordinary skill here,
#: which is exactly what these two tests pin.
STANDARD = Skill(
    name="haus-stil",
    description="Fleet standard equipment.",
    body="standard body",
    origin="org",
)


def test_a_standard_row_is_an_ordinary_catalog_entry() -> None:
    """A tier has no "applied" property: ``delivery: standard`` means "resolved
    for every organization", and that is all it means to the model: one line in
    L1 like every other skill. Fleet policy that must hold on every answer is
    prompt text.
    """
    assert not hasattr(Skill, "standard") or "standard" not in Skill.model_fields
    runtime = SkillRuntime(skills=(S1, STANDARD))
    assert "`haus-stil`: Fleet standard equipment." in (runtime.prompt_block() or "")
    assert runtime.activated == ()
    _use_skill(runtime).invoke({"skill_name": "haus-stil"})
    assert runtime.activated == ("haus-stil",)


def test_a_standard_marker_on_the_payload_is_ignored() -> None:
    """The wire may still carry it; nothing in the backend may act on it."""
    from aiq_agent.skills.resolver import _build_org_skills

    (skill,) = _build_org_skills(
        [{"name": "haus-stil", "description": "Fleet standard equipment.", "body": "b", "standard": True}]
    )
    assert not hasattr(skill, "standard")


HIDDEN_STD = Skill(
    name="haus-stimme",
    description="Die Hausstimme.",
    body="voice body",
    metadata={"grid-hidden": "true"},
    origin="org",
)


def test_hidden_activated_is_the_grid_hidden_subset() -> None:
    # The disclosure NAMES every activated skill, but a skill that runs on every
    # answer is noise there too — this subset is what the frontend mutes until
    # the reasoning view is open. Resolved here because only the runtime holds
    # each skill's metadata.
    runtime = SkillRuntime(skills=(S1, HIDDEN_STD))
    _use_skill(runtime).invoke({"skill_name": "haus-stimme"})
    assert "haus-stimme" in runtime.activated
    assert runtime.hidden_activated == ("haus-stimme",)


def test_an_ordinary_activated_skill_is_not_hidden() -> None:
    runtime = SkillRuntime(skills=(S1, STANDARD))  # STANDARD carries no grid-hidden
    _use_skill(runtime).invoke({"skill_name": "haus-stil"})
    assert "haus-stil" in runtime.activated
    assert runtime.hidden_activated == ()
