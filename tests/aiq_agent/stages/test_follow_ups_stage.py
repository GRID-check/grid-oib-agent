"""The `follow_ups` post-answer stage: gate, payload, sanitiser, handler.

Slice 1 ships this stage `silent` — it runs and is measured and delivers
nothing — so what these tests guard is not a rendering but a *measurement*: that
every way the stage can end up producing no questions lands in a bucket you can
tell apart from every other such bucket, and that the gate's decisions each name
themselves.

No LLM and no socket: the handler is exercised against a stub model.
"""

import dataclasses
import json

import pytest
from pydantic import ValidationError

from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.stages import get_stage
from aiq_agent.stages.follow_ups import FOLLOW_UPS
from aiq_agent.stages.follow_ups import FollowUpQuestion
from aiq_agent.stages.follow_ups import FollowUpsPayload
from aiq_agent.stages.follow_ups import build_user_prompt
from aiq_agent.stages.follow_ups import sanitize_items
from aiq_agent.stages.spec import StageContext
from aiq_agent.stages.spec import StageEmpty
from aiq_agent.stages.spec import TurnFacts

# A real-shaped Austrian building-code answer: long enough to pass the gate's
# length floor, and carrying the terms an anchored question can name.
ANSWER = (
    "Für die Gebäudeklasse ist das Fluchtniveau maßgeblich: gemessen wird es vom Fußboden des "
    "höchstgelegenen Aufenthaltsraums bis zum angrenzenden Gelände. Liegt dieses Niveau nicht "
    "über 11 m, fällt das Gebäude nach OIB-Richtlinie 2 in die Gebäudeklasse 4, sofern es "
    "höchstens drei oberirdische Geschoße aufweist und die Nutzungseinheiten je nicht mehr als "
    "400 m² betragen. Wird das Dachgeschoß zu Aufenthaltsräumen ausgebaut, verschiebt sich das "
    "Fluchtniveau nach oben und die Einstufung kann auf Gebäudeklasse 5 wechseln. Für die "
    "Einreichung ist die Gebäudeklasse im Bauansuchen anzugeben und durch einen Nachweis der "
    "Fluchtniveaus zu belegen."
)

GOOD_ITEMS = [
    {"question": "Wie wird das Fluchtniveau genau gemessen?", "hint": "Messpunkt und Bezugsebene"},
    {"question": "Ändert sich die Einstufung, wenn das Dachgeschoß ausgebaut wird?", "hint": ""},
    {"question": "Was hätte für die Gebäudeklasse 5 gegolten?", "hint": ""},
    {"question": "Welche Nachweise verlangt die Einreichung dafür?", "hint": ""},
]

# The set the doctrine names as the failure mode: four times "go on", anchored
# to nothing in the answer.
FILLER_ITEMS = [
    {"question": "Kannst du mehr dazu sagen?", "hint": ""},
    {"question": "Was gilt sonst noch?", "hint": ""},
    {"question": "Gibt es weitere Anforderungen?", "hint": ""},
    {"question": "Erzähl mir mehr dazu.", "hint": ""},
]


def _body(items) -> str:
    """The JSON body a model would return for `items`."""
    return json.dumps({"items": [{"question": item["question"], "hint": ""} for item in items]})


def _facts(**overrides) -> TurnFacts:
    base = TurnFacts(
        conversation_id="conv_1",
        ws_parent_id="msg_1",
        organization_id="org_1",
        query="In welche Gebäudeklasse fällt mein Haus?",
        answer=ANSWER,
        intent="research",
        routing_decision="shallow",
        enabled_stages=frozenset({"follow_ups"}),
    )
    return dataclasses.replace(base, **overrides)


def _gate(**overrides):
    return FOLLOW_UPS.gate(_facts(**overrides))


class _StubLLM:
    """A chat model that returns a fixed body. `bind` returns itself, so the
    structured-output path and the fallback path both land here."""

    def __init__(self, body: str, *, fail_bind: bool = False):
        self.body = body
        self.fail_bind = fail_bind
        self.calls = 0

    def bind(self, **kwargs):
        if self.fail_bind:
            raise RuntimeError("this model rejects response_format")
        return self

    async def ainvoke(self, messages):
        self.calls += 1
        self.messages = messages
        return type("_Response", (), {"content": self.body})()


class TestDeclaration:
    def test_it_is_registered_under_its_wire_id(self):
        assert get_stage("follow_ups") is FOLLOW_UPS

    def test_slice_one_delivers_nothing(self):
        """The whole point of the plan: it runs and is measured before any
        reader sees a chip and before the old card is retired."""
        assert FOLLOW_UPS.delivery == "silent"

    def test_it_runs_on_its_own_agent_group_and_flag(self):
        assert FOLLOW_UPS.agent_group is AgentGroup.FOLLOW_UPS
        assert FOLLOW_UPS.flag_slug == "post-answer-follow-ups"
        assert FOLLOW_UPS.env_default == "GRID_STAGE_FOLLOW_UPS_ENABLED"

    def test_no_two_stages_share_an_agent_group(self):
        """The map a stage's model is resolved from is keyed by AgentGroup, and
        a group with no model is the capability bit. Two stages under one key
        could not be pointed at different models, and unsetting one stage's LLM
        would silently switch the other off too. follow_ups is the first stage
        that makes this invariant non-trivial."""
        from aiq_agent.stages import iter_stages

        groups = [spec.agent_group for spec in iter_stages()]
        assert len(set(groups)) == len(groups)

    def test_it_is_bounded_tighter_than_reflection(self):
        """A set that lands after the reader has typed their own question is
        worse than none, because it moves the page."""
        assert FOLLOW_UPS.timeout_s == 20.0
        assert FOLLOW_UPS.max_output_tokens == 512


class TestGate:
    """Every condition of §7.6, each producing its own machine reason — the gate
    is measurable rather than assumed only if two different skips never share a
    bucket."""

    def test_a_substantive_research_turn_runs(self):
        assert _gate().run is True

    @pytest.mark.parametrize(
        ("overrides", "reason"),
        [
            ({"deep_research_job_id": "job_1"}, "deep_research_job"),
            ({"intent": "out_of_scope", "routing_decision": "meta"}, "intent_out_of_scope"),
            ({"intent": "meta", "routing_decision": "meta"}, "routing_meta"),
            ({"intent": "error", "routing_decision": "error"}, "routing_error"),
            ({"research_truncated": True}, "research_truncated"),
            ({"query": ""}, "empty_turn"),
            ({"answer": "An error occurred while researching your question. " * 12}, "canned_non_answer"),
            ({"answer": "Ja, 100 cm."}, "answer_too_short"),
            ({"answer": ANSWER + "\n\nIn welchem Bundesland liegt das Projekt?"}, "answer_ends_in_question"),
        ],
    )
    def test_each_declined_turn_names_its_own_condition(self, overrides, reason):
        decision = _gate(**overrides)
        assert decision.run is False
        assert decision.reason == reason

    def test_an_off_topic_redirect_is_not_filed_as_small_talk(self):
        """`derive_routing_decision` folds out_of_scope into "meta" for the
        transparency surface. Reading routing first would hide every off-topic
        turn inside the small-talk bucket — and "how many redirects did the gate
        catch" is one of the numbers this slice is for."""
        assert _gate(intent="out_of_scope", routing_decision="meta").reason == "intent_out_of_scope"

    def test_a_turn_that_already_emitted_the_card_still_runs(self):
        """Deliberate: those are exactly the turns the stage is being measured
        against. Skipping them would leave the empty rate measured only on turns
        the model had already declined once."""
        assert _gate(emitted_card_types=frozenset({"follow_ups"})).run is True

    def test_no_condition_consults_a_model(self):
        """The gate is deterministic Python. Called twice on the same facts it
        must give the same answer, and it may not touch the context."""
        facts = _facts()
        assert FOLLOW_UPS.gate(facts) == FOLLOW_UPS.gate(facts)


class TestPayloadShape:
    def test_a_topic_label_is_not_a_sendable_question(self):
        with pytest.raises(ValidationError, match="end with"):
            FollowUpQuestion(question="Fluchtniveau und Gebäudeklasse")

    def test_two_questions_in_one_chip_are_refused(self):
        with pytest.raises(ValidationError, match="compete for the same reply"):
            FollowUpQuestion(question="Wie wird gemessen? Und was gilt dann?")

    def test_a_hint_that_restates_the_question_is_dropped(self):
        item = FollowUpQuestion(question="Wie wird das Fluchtniveau gemessen?", hint="Wie wird das Fluchtniveau")
        assert item.hint is None

    def test_one_chip_is_not_a_set_of_options(self):
        with pytest.raises(ValidationError):
            FollowUpsPayload(items=GOOD_ITEMS[:1])

    def test_five_is_a_menu(self):
        with pytest.raises(ValidationError):
            FollowUpsPayload(items=GOOD_ITEMS + [{"question": "Und wie hoch ist die Brüstung dann?"}])

    def test_the_same_question_twice_is_not_two_questions(self):
        with pytest.raises(ValidationError, match="the same question"):
            FollowUpsPayload(items=[GOOD_ITEMS[0], dict(GOOD_ITEMS[0])])

    def test_the_payload_has_no_heading_to_write_chrome_into(self):
        """The card carries an optional `title`; the payload deliberately does
        not. The heading belongs to the rail."""
        assert "title" not in FollowUpsPayload.model_fields
        with pytest.raises(ValidationError):
            FollowUpsPayload(items=GOOD_ITEMS[:2], title="Weiterführende Fragen")


class TestAnchoring:
    def test_the_documented_good_set_survives(self):
        items = sanitize_items(GOOD_ITEMS, answer=ANSWER)
        assert [item["question"] for item in items] == [entry["question"] for entry in GOOD_ITEMS]
        assert FollowUpsPayload(items=items)

    def test_the_documented_bad_set_is_inexpressible(self):
        """ "Erzähl mir mehr dazu" names nothing this answer introduced, and a
        reader who gets one such set stops reading the chips — after which the
        good sets are lost too. So the doctrine's test is the code's test."""
        assert sanitize_items(FILLER_ITEMS, answer=ANSWER) == []

    def test_one_filler_question_costs_only_itself(self):
        items = sanitize_items(GOOD_ITEMS[:2] + FILLER_ITEMS[:1], answer=ANSWER)
        assert len(items) == 2

    def test_german_inflection_does_not_break_an_anchor(self):
        """The answer says "Fluchtniveau"; the question may say "Fluchtniveaus"
        and still be naming the same thing."""
        items = sanitize_items([{"question": "Wie belegt man die Fluchtniveaus?"}], answer=ANSWER)
        assert len(items) == 1

    def test_a_hint_is_never_promoted_into_the_anchor(self):
        """Anchoring is a property of the QUESTION: a filler question with a
        well-anchored hint is still filler, because the hint is a tooltip the
        reader may never see."""
        assert sanitize_items([{"question": "Kannst du mehr dazu sagen?", "hint": "Fluchtniveau"}], answer=ANSWER) == []


class TestHandler:
    @pytest.mark.asyncio
    async def test_a_good_set_becomes_a_ready_payload(self):
        llm = _StubLLM(_body(GOOD_ITEMS))
        result = await FOLLOW_UPS.handler(StageContext(facts=_facts(), llm=llm))
        assert FollowUpsPayload.model_validate(result)
        assert len(result["items"]) == 4

    @pytest.mark.asyncio
    async def test_the_model_declining_is_its_own_bucket(self):
        """The number that decides whether this feature was worth building. It
        must not share a bucket with "the model answered and wrote filler"."""
        llm = _StubLLM('{"items": []}')
        result = await FOLLOW_UPS.handler(StageContext(facts=_facts(), llm=llm))
        assert result == StageEmpty("model_declined")

    @pytest.mark.asyncio
    async def test_filler_that_survives_the_prompt_is_a_different_bucket(self):
        llm = _StubLLM(_body(FILLER_ITEMS))
        result = await FOLLOW_UPS.handler(StageContext(facts=_facts(), llm=llm))
        assert result == StageEmpty("no_usable_items")

    @pytest.mark.asyncio
    async def test_a_model_that_rejects_response_format_still_answers(self):
        """Same fallback as reflection: a binding quirk must not drop the stage."""
        body = _body(GOOD_ITEMS[:2])
        llm = _StubLLM(body, fail_bind=True)
        result = await FOLLOW_UPS.handler(StageContext(facts=_facts(), llm=llm))
        assert len(result["items"]) == 2

    @pytest.mark.asyncio
    async def test_exactly_one_llm_call_per_turn(self):
        """§7.5: no stage may make two."""
        llm = _StubLLM('{"items": []}')
        await FOLLOW_UPS.handler(StageContext(facts=_facts(), llm=llm))
        assert llm.calls == 1


class TestPromptInputs:
    def test_the_prompt_sees_the_finished_answer(self):
        """The whole reason this is a post-answer stage rather than a card."""
        assert ANSWER in build_user_prompt(_facts())

    def test_a_long_answer_is_sliced_and_the_slice_is_marked(self):
        """An unmarked slice invites a question anchored on a sentence that was
        cut in half."""
        prompt = build_user_prompt(_facts(answer="x" * 9000))
        assert "(Antwort gekürzt)" in prompt
        assert len(prompt) < 7000

    def test_the_bundesland_rides_along(self):
        assert "Tirol" in build_user_prompt(_facts(bundesland="Tirol"))

    def test_the_project_memory_digest_does_not(self):
        """§5.2 named "project profile" as an input; it is deliberately not
        carried. The digest is capped at 6,000 characters and would roughly
        double a per-turn cost accepted for a navigation aid."""
        digest = '- [decision | high] "Bauherr wählt Flachdach"'
        assert digest not in build_user_prompt(_facts(memory_digest=digest))
