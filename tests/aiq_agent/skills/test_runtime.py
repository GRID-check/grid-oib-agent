"""Per-run SkillRuntime: activation order, prompt blocks, use_skill closure.

Also the transparency events activation now emits (``aiq_agent.skills.events``)
— what a reader is told while a skill is shaping the answer, and what is only
recorded for the details panel.
"""

from __future__ import annotations

import json

import pytest

from aiq_agent.skills.events import ALL_SKILL_KEYS
from aiq_agent.skills.events import emit_skills_offered
from aiq_agent.skills.models import Skill
from aiq_agent.skills.runtime import SkillRuntime
from nat.builder.context import ContextState

S1 = Skill(name="alpha", description="Erster Skill.", body="alpha body", origin="platform")
S2 = Skill(name="beta", description="Zweiter Skill.", body="beta body", origin="platform")
CARDS = Skill(
    name="gamma",
    description="Dritter Skill.",
    body="gamma body",
    metadata={"grid-cards": "comparison_table,legal_basis"},
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


def _boom(*_args, **_kwargs):
    raise RuntimeError("the step stream is unhappy")


@pytest.fixture
def context_state():
    """The (singleton) NAT ContextState with a clean span stack and event stream.

    ContextState is process-wide, so a test resets the ContextVars itself. The
    event stream is replaced per test so one test's subscriber never sees
    another's steps.
    """
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    yield state
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())


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


def test_a_stored_auto_invoke_off_no_longer_hides_a_skill() -> None:
    """The catalog is the model's inventory, not a list a person edits.

    ``grid-auto-invoke: false`` used to cut a row out of L1. Its author-facing
    switch is gone (ADR-0060: nothing but the model decides which skill runs),
    so honouring the stored token would now hide a skill from every turn with
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

    There is no second order to reconcile with it any more — no forced list in
    front, no fleet floor behind — so the list reads as the run happened.
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
    assert "`comparison_table`, `legal_basis`" in body
    # A preference, not a command — the wording must leave an out.
    assert "not a requirement" in body
    # The whole point of the feature: it costs nothing until activation.
    assert "Preferred cards" not in (runtime.prompt_block() or "")


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
        metadata={"grid-cards": "legal_basis,memory_proposal,ganz_erfunden"},
    )
    body = _use_skill(SkillRuntime(skills=(skill,))).invoke({"skill_name": "delta"})
    assert "`legal_basis`" in body
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
    """What leaves the process while the skills are in play.

    Exercised against the REAL NAT ``IntermediateStepManager``/``ContextState``
    (a process-wide singleton), following ``tests/aiq_agent/common/
    test_nat_step_repair.py``: the span-stack behaviour is half the contract
    here, and a faked manager would assert nothing about it.
    """

    @staticmethod
    def _sink(context_state) -> list[dict]:
        """Collect the JSON payload of every START step pushed during a test."""
        seen: list[dict] = []

        def _on_next(step) -> None:
            payload = step.payload
            if not str(payload.event_type).endswith("START"):
                return
            body = getattr(payload.data, "input", None)
            if isinstance(body, str):
                seen.append({"step": payload.name, **json.loads(body)})

        context_state.event_stream.get().subscribe(_on_next)
        return seen

    def test_each_activation_emits_exactly_one_event_named_for_its_skill(self, context_state) -> None:
        events = self._sink(context_state)
        runtime = SkillRuntime(skills=(S1, S2, TITLED))
        tool = _use_skill(runtime)
        tool.invoke({"skill_name": "titel"})
        # Re-invoking an already-active skill must not say so a second time.
        tool.invoke({"skill_name": "titel"})

        assert [e["name"] for e in events if e["phase"] == "activated"] == ["titel"]
        tool.invoke({"skill_name": "beta"})

        activations = [e for e in events if e["phase"] == "activated"]
        assert [e["name"] for e in activations] == ["titel", "beta"]
        # One STEP per skill: sharing a name collapses N skills into one step.
        assert [e["step"] for e in activations] == ["skill:titel", "skill:beta"]
        # The reported list is the same order the events came in: call order.
        assert runtime.activated == ("titel", "beta")

    def test_every_activation_is_the_same_event_because_there_is_one_way_to_run(self, context_state) -> None:
        """No ``forced`` flag and no second key: delivery is the only story.

        ``skill.forced`` existed while a request or a deployment could require
        a skill. Nothing can, so an event that said "the user named this one"
        would be describing a state the system no longer has.
        """
        events = self._sink(context_state)
        runtime = SkillRuntime(skills=(TITLED, TITLED_TWO))
        tool = _use_skill(runtime)
        tool.invoke({"skill_name": "titel"})
        tool.invoke({"skill_name": "titel-zwei"})

        by_name = {e["name"]: e for e in events if e["phase"] == "activated"}
        for event in by_name.values():
            assert "forced" not in event
            assert event["key"] == "skill.activated"
        # Both are LIVE, and the only value either carries is the human title —
        # never the id, and never a finished sentence.
        for event in by_name.values():
            assert event["channel"] == "live"
            assert "text" not in event
            assert event["values"] == {"skill": event["title"]}
            assert event["name"] not in event["values"]["skill"]

    def test_a_skill_without_a_title_gets_no_live_sentence(self, context_state) -> None:
        """An id in a status line is worse than silence; the event still records it."""
        events = self._sink(context_state)
        _use_skill(SkillRuntime(skills=(S1,))).invoke({"skill_name": "alpha"})

        activation = next(e for e in events if e["phase"] == "activated")
        assert activation["channel"] == "technical"
        assert "key" not in activation
        assert "values" not in activation
        assert "text" not in activation
        assert "title" not in activation

    def test_a_hidden_skill_is_recorded_but_kept_off_the_live_line(self, context_state) -> None:
        """Hidden = out of the noisy live line, never concealed.

        The activation STILL fires and STILL records (name, title) so
        the disclosure names it and the reasoning view surfaces it — only the
        channel changes to technical and the live ``key`` is withheld, which is
        the one thing that would put it back in the running line.
        """
        events = self._sink(context_state)
        _use_skill(SkillRuntime(skills=(HIDDEN,))).invoke({"skill_name": "piloti-voice"})

        activation = next(e for e in events if e["phase"] == "activated")
        # Recorded, and honest about what it is…
        assert activation["name"] == "piloti-voice"
        assert activation["title"] == "Piloti-Stimme"
        # …but never in the live line: technical channel, no live sentence.
        assert activation["channel"] == "technical"
        assert "key" not in activation
        assert "values" not in activation
        assert "text" not in activation

    def test_loading_a_body_is_technical_only(self, context_state) -> None:
        events = self._sink(context_state)
        body = _use_skill(SkillRuntime(skills=(TITLED,))).invoke({"skill_name": "titel"})

        loaded = next(e for e in events if e["phase"] == "loaded")
        assert loaded["channel"] == "technical"
        assert loaded["body_chars"] == len(body)
        assert "key" not in loaded
        assert "text" not in loaded

    def test_offered_reports_the_catalog_but_never_as_activity(self, context_state) -> None:
        events = self._sink(context_state)
        emit_skills_offered(SkillRuntime(skills=(S1, S2)))

        offered = next(e for e in events if e["phase"] == "offered")
        assert offered["step"] == "skill_selection"
        # Availability is not activity: a catalog size must never be shown live.
        assert offered["channel"] == "technical"
        assert offered["offered_count"] == 2
        # Nothing about what was REQUIRED, because nothing can be: the catalog
        # size is the whole fact this event has.
        assert "forced_names" not in offered

    def test_a_turn_with_no_skills_says_nothing(self, context_state) -> None:
        events = self._sink(context_state)
        runtime = SkillRuntime(skills=())
        emit_skills_offered(runtime)
        assert events == []

    def test_the_span_stack_is_left_exactly_as_it_was_found(self, context_state) -> None:
        """Every step is a balanced pair; a leaked frame corrupts the next real close."""
        runtime = SkillRuntime(skills=(TITLED,))
        emit_skills_offered(runtime)
        _use_skill(runtime).invoke({"skill_name": "titel"})
        assert context_state.active_span_id_stack.get() == ["root"]

    def test_no_skill_event_carries_a_sentence_in_any_language(self, context_state) -> None:
        """Emitted data has no language — the frontend owns every word.

        This module used to ship *Skill „Brandschutznachweis“ wird angewendet*
        in a ``text`` field and the live line rendered it verbatim, so an
        English-locale reader read German. What may travel now is a stable key
        from ``ALL_SKILL_KEYS`` and the tenant's own authored title, which is
        the same word in every locale.
        """
        events = self._sink(context_state)
        runtime = SkillRuntime(skills=(TITLED, TITLED_TWO))
        emit_skills_offered(runtime)
        _use_skill(runtime).invoke({"skill_name": "titel"})
        _use_skill(runtime).invoke({"skill_name": "titel-zwei"})

        assert events
        for event in events:
            assert "text" not in event, event
            key = event.get("key")
            if key is None:
                continue
            assert key in ALL_SKILL_KEYS, key
            # One value, and it is the office's own name for its own method.
            assert set(event["values"]) == {"skill"}

    def test_a_broken_event_never_takes_the_turn_down(self, context_state, monkeypatch) -> None:
        """Transparency is worth less than the answer it describes."""
        monkeypatch.setattr("aiq_agent.skills.events.push_custom_step", _boom)
        runtime = SkillRuntime(skills=(TITLED,))
        emit_skills_offered(runtime)
        assert _use_skill(runtime).invoke({"skill_name": "titel"}) == "titel body"
        assert runtime.activated == ("titel",)


#: A row the BFF marked ``standard``. The backend does not read that marker any
#: more — there is no ``Skill.standard`` field — so it is an ordinary skill here,
#: which is exactly what these two tests pin.
STANDARD = Skill(
    name="haus-stil",
    description="Fleet standard equipment.",
    body="standard body",
    origin="org",
)


def test_a_standard_row_is_an_ordinary_catalog_entry() -> None:
    """The tier's "applied" property is gone, and with it the field behind it.

    ``delivery: standard`` still means "resolved for every organization", and
    that is all it means to the model: one line in L1 like every other skill.
    Fleet policy that must hold on every answer is prompt text now.
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
