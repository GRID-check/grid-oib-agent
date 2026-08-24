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
    metadata={"grid-cards": "comparison_table,summary"},
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
    assert block.startswith("## Available skills")
    assert "use_skill" in block
    assert "`alpha`: Erster Skill." in block
    # Progressive disclosure: bodies NEVER leak into the prompt.
    assert "alpha body" not in block
    assert "beta body" not in block


def test_prompt_block_omits_skills_with_auto_invoke_off() -> None:
    """Off means the model does not see it. Slash and force still can.

    A skill whose author turned auto-invoke off is still resolved and still
    loadable through ``use_skill``. Listing it in L1 would be the model picking
    it, which is the thing the switch forbids.
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
    assert "einreichcheck" not in block
    # The tool is still wired: a forced turn or a guessed name can load it.
    assert runtime.build_tools()


def test_forced_skill_stays_in_the_catalog_even_when_auto_invoke_is_off() -> None:
    """The turn already named it. The description is what tells the model why."""
    silent = Skill(
        name="einreichcheck",
        description="Was diesem Bauansuchen noch fehlt.",
        body="body",
        metadata={"grid-auto-invoke": "false"},
        origin="platform",
    )
    runtime = SkillRuntime(skills=(silent,), force_names=["einreichcheck"])
    block = runtime.prompt_block() or ""
    assert "`einreichcheck`: Was diesem Bauansuchen noch fehlt." in block
    assert runtime.forced_block() is not None


def test_prompt_block_is_none_when_every_skill_is_slash_only() -> None:
    silent = Skill(
        name="einreichcheck",
        description="Was diesem Bauansuchen noch fehlt.",
        body="body",
        metadata={"grid-auto-invoke": "false"},
        origin="platform",
    )
    runtime = SkillRuntime(skills=(silent,))
    assert runtime.prompt_block() is None
    assert runtime.build_tools()


def test_forcing_a_skill_does_not_activate_it() -> None:
    """A force is an instruction; activation is a delivery.

    `forced_block()` contributes a heading and the skill's NAME — the body
    travels through `use_skill` and nowhere else. So a model that ignores the
    instruction has read nothing, and `activated` (which the disclosure renders
    as "this shaped the answer") must not claim otherwise. This is the whole
    defect: with an LLM that never calls the tool, the reader was told the
    house voice wrote an answer it never saw.
    """
    runtime = _runtime(forced=["beta"])
    assert runtime.forced == ("beta",)
    assert runtime.activated == ()
    assert runtime.forced_not_activated == ("beta",)


def test_what_was_delivered_is_reported_in_the_order_it_was_asked_for() -> None:
    """Membership is delivery; order is the forced block's order.

    Raw delivery order is not reportable: a model opens both house skills in
    one PARALLEL batch and the tool node runs them concurrently, so which body
    lands first is scheduling noise — and a reader's panel that reorders itself
    between two identical turns is a worse answer to "what shaped this?" than a
    stable one. So the reported order stays what the user asked for, then the
    fleet floor, then what the model chose. Only membership changed.
    """
    runtime = _runtime(forced=["beta"])
    tool = _use_skill(runtime)
    assert tool.invoke({"skill_name": "alpha"}) == "alpha body"
    assert runtime.activated == ("alpha",)
    assert tool.invoke({"skill_name": "beta"}) == "beta body"
    # `beta` was delivered second and is reported first: it is the forced one.
    assert runtime.activated == ("beta", "alpha")
    assert runtime.forced_not_activated == ()
    # Re-invoking the same skill does not duplicate it.
    tool.invoke({"skill_name": "alpha"})
    assert runtime.activated == ("beta", "alpha")


def test_forced_block_names_only_forced_skills() -> None:
    block = _runtime(forced=["beta"]).forced_block()
    assert block is not None
    assert block.startswith("## Active skills (required for this turn)")
    assert "`beta`" in block
    assert "`alpha`" not in block


def test_force_unknown_skill_is_ignored() -> None:
    runtime = SkillRuntime(skills=(S1,), force_names=["ghost", "alpha"])
    assert runtime.forced == ("alpha",)
    assert runtime.forced_block().startswith("## Active skills")
    # A name nobody can resolve is not "forced and unread" either — there is no
    # skill to have read.
    assert runtime.forced_not_activated == ("alpha",)


def test_forced_block_none_when_nothing_forced() -> None:
    assert _runtime().forced_block() is None


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
    assert "`comparison_table`, `summary`" in body
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
        runtime = SkillRuntime(skills=(S1, S2, TITLED), force_names=["beta"])
        tool = _use_skill(runtime)
        tool.invoke({"skill_name": "titel"})
        # Re-invoking an already-active skill must not say so a second time.
        tool.invoke({"skill_name": "titel"})

        # The forced skill announces nothing until its body is handed over:
        # "applying the Brandschutznachweis skill" said before the model has
        # read a word of it is the live-line version of the same false claim.
        assert [e["name"] for e in events if e["phase"] == "activated"] == ["titel"]
        tool.invoke({"skill_name": "beta"})

        activations = [e for e in events if e["phase"] == "activated"]
        assert [e["name"] for e in activations] == ["titel", "beta"]
        # One STEP per skill: sharing a name collapses N skills into one step.
        assert [e["step"] for e in activations] == ["skill:titel", "skill:beta"]
        # The EVENTS are in the order things happened; the reported list is in
        # the order the forced block reads (see `activated`).
        assert runtime.activated == ("beta", "titel")
        assert runtime.forced == ("beta",)

    def test_forced_and_model_chosen_differ_only_in_who_decided(self, context_state) -> None:
        events = self._sink(context_state)
        runtime = SkillRuntime(skills=(TITLED, TITLED_TWO), force_names=["titel"])
        tool = _use_skill(runtime)
        tool.invoke({"skill_name": "titel"})
        tool.invoke({"skill_name": "titel-zwei"})

        by_name = {e["name"]: e for e in events if e["phase"] == "activated"}
        assert by_name["titel"]["forced"] is True
        assert by_name["titel-zwei"]["forced"] is False
        # Who decided is a different KEY, not a different verb inside one
        # sentence: that difference is not one word in every language.
        assert by_name["titel"]["key"] == "skill.forced"
        assert by_name["titel-zwei"]["key"] == "skill.activated"
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

        The activation STILL fires and STILL records (name, title, forced) so
        the disclosure names it and the reasoning view surfaces it — only the
        channel changes to technical and the live ``key`` is withheld, which is
        the one thing that would put it back in the running line.
        """
        events = self._sink(context_state)
        _use_skill(SkillRuntime(skills=(HIDDEN,), force_names=["piloti-voice"])).invoke({"skill_name": "piloti-voice"})

        activation = next(e for e in events if e["phase"] == "activated")
        # Recorded, and honest about what it is…
        assert activation["name"] == "piloti-voice"
        assert activation["title"] == "Piloti-Stimme"
        assert activation["forced"] is True
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
        emit_skills_offered(SkillRuntime(skills=(S1, S2), force_names=["beta"]))

        offered = next(e for e in events if e["phase"] == "offered")
        assert offered["step"] == "skill_selection"
        # Availability is not activity: a catalog size must never be shown live.
        assert offered["channel"] == "technical"
        assert offered["offered_count"] == 2
        assert offered["forced_names"] == ["beta"]

    def test_a_turn_with_no_skills_says_nothing(self, context_state) -> None:
        events = self._sink(context_state)
        runtime = SkillRuntime(skills=())
        emit_skills_offered(runtime)
        assert events == []

    def test_the_span_stack_is_left_exactly_as_it_was_found(self, context_state) -> None:
        """Every step is a balanced pair; a leaked frame corrupts the next real close."""
        runtime = SkillRuntime(skills=(TITLED,), force_names=["titel"])
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
        runtime = SkillRuntime(skills=(TITLED, TITLED_TWO), force_names=["titel"])
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
        runtime = SkillRuntime(skills=(TITLED,), force_names=["titel"])
        emit_skills_offered(runtime)
        assert _use_skill(runtime).invoke({"skill_name": "titel"}) == "titel body"
        assert runtime.activated == ("titel",)


STANDARD = Skill(
    name="haus-stil",
    description="Fleet standard equipment.",
    body="standard body",
    origin="org",
    standard=True,
)


def test_standard_skills_are_applied_without_being_asked_for() -> None:
    # `delivery: standard` already means "resolved for every organization, no
    # decision to make". Resolving it only put its description in the catalog,
    # and a description the model may or may not open is not fleet policy.
    runtime = SkillRuntime(skills=(S1, STANDARD))
    assert "haus-stil" in runtime.forced
    assert "haus-stil" in (runtime.forced_block() or "")
    # …but "applied" is the instruction, not yet the fact: it becomes activated
    # when the model fetches the body, like every other skill.
    assert runtime.activated == ()
    _use_skill(runtime).invoke({"skill_name": "haus-stil"})
    assert runtime.activated == ("haus-stil",)


def test_an_ordinary_skill_is_not_forced() -> None:
    # The flag is the whole gate: an offer the org took up, or a builtin, must
    # stay opt-in or every resolved skill becomes mandatory.
    runtime = SkillRuntime(skills=(S1, S2))
    assert runtime.forced == ()
    assert runtime.forced_block() is None


def test_user_forces_are_listed_before_standard_skills() -> None:
    # The forced block reads back to the model in order; what the user asked
    # for should not sit underneath something they never mentioned.
    runtime = SkillRuntime(skills=(S1, STANDARD), force_names=["alpha"])
    assert runtime.forced == ("alpha", "haus-stil")


def test_a_user_forced_standard_skill_is_not_listed_twice() -> None:
    runtime = SkillRuntime(skills=(S1, STANDARD), force_names=["haus-stil"])
    assert runtime.forced == ("haus-stil",)
    tool = _use_skill(runtime)
    tool.invoke({"skill_name": "haus-stil"})
    tool.invoke({"skill_name": "haus-stil"})
    assert runtime.activated.count("haus-stil") == 1


def test_the_forced_doctrine_says_when_a_writing_skill_binds() -> None:
    # Without "before you write", a skill that governs prose is loaded after the
    # prose exists, which is the one moment it cannot affect anything.
    runtime = SkillRuntime(skills=(STANDARD,))
    assert "before you write" in (runtime.forced_block() or "")


HIDDEN_STD = Skill(
    name="haus-stimme",
    description="Die Hausstimme.",
    body="voice body",
    metadata={"grid-hidden": "true"},
    origin="org",
    standard=True,
)


def test_hidden_activated_is_the_grid_hidden_subset() -> None:
    # The disclosure NAMES every activated skill, but a skill that runs on every
    # answer is noise there too — this subset is what the frontend mutes until
    # the reasoning view is open. Resolved here because only the runtime holds a
    # standard skill's metadata; the invocable list the disclosure reads excludes it.
    runtime = SkillRuntime(skills=(S1, HIDDEN_STD))
    _use_skill(runtime).invoke({"skill_name": "haus-stimme"})
    assert "haus-stimme" in runtime.activated
    assert runtime.hidden_activated == ("haus-stimme",)


def test_an_ordinary_activated_skill_is_not_hidden() -> None:
    runtime = SkillRuntime(skills=(S1, STANDARD))  # STANDARD carries no grid-hidden
    _use_skill(runtime).invoke({"skill_name": "haus-stil"})
    assert "haus-stil" in runtime.activated
    assert runtime.hidden_activated == ()
