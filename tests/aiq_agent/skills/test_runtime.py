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

        activations = [e for e in events if e["phase"] == "activated"]
        assert [e["name"] for e in activations] == ["beta", "titel"]
        # One STEP per skill: sharing a name collapses N skills into one step.
        assert [e["step"] for e in activations] == ["skill:beta", "skill:titel"]
        # Forced-first ordering is unchanged by the announcement.
        assert runtime.activated == ("beta", "titel")
        assert runtime.forced == ("beta",)

    def test_forced_and_model_chosen_differ_only_in_who_decided(self, context_state) -> None:
        events = self._sink(context_state)
        runtime = SkillRuntime(skills=(TITLED, TITLED_TWO), force_names=["titel"])
        _use_skill(runtime).invoke({"skill_name": "titel-zwei"})

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
