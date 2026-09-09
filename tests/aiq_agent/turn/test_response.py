"""The crossing from finished graph state to the wire response and the stage facts."""

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.shallow_researcher.models import ConversationState
from aiq_agent.common import _create_chat_response
from aiq_agent.stages import TurnFacts
from aiq_agent.turn.response import RESPONSE_LIFTS
from aiq_agent.turn.response import answer_text
from aiq_agent.turn.response import apply_state_extras
from aiq_agent.turn.response import build_response
from aiq_agent.turn.response import post_answer_turn_facts
from aiq_agent.turn.streaming import STREAM_EXTRA_FIELDS


def _state(**fields) -> ConversationState:
    fields.setdefault("messages", [HumanMessage(content="Frage?"), AIMessage(content="Mindestens 100 cm.")])
    return ConversationState(**fields)


def _response():
    return _create_chat_response("answer", response_id="r", model="m")


class TestResponseLifts:
    """One table drives every lift; the frontend renders on presence."""

    def test_every_lifted_attribute_rides_the_terminal_chunk(self):
        """A lift onto an attribute the streamer does not carry reaches nobody."""
        assert {attribute for _field, attribute, _requires in RESPONSE_LIFTS} <= set(STREAM_EXTRA_FIELDS)

    def test_every_lift_reads_a_state_field(self):
        for field, _attribute, requires in RESPONSE_LIFTS:
            assert field in ConversationState.model_fields
            assert requires is None or requires in ConversationState.model_fields

    def test_present_values_are_lifted_and_absent_ones_are_not_set(self):
        response = _response()
        apply_state_extras(
            response,
            _state(routing_decision="shallow", answer_confidence="high", verified_sources=[{"file_name": "a.pdf"}]),
        )
        assert response.routing_decision == "shallow"
        assert response.answer_confidence == "high"
        assert response.sources == [{"file_name": "a.pdf"}]
        assert getattr(response, "escalation_reason", None) is None
        assert getattr(response, "citations_removed", None) is None

    def test_a_retry_hint_only_rides_with_its_rejection(self):
        response = _response()
        apply_state_extras(response, _state(retry_after_seconds=42))
        assert getattr(response, "retry_after_seconds", None) is None

        response = _response()
        apply_state_extras(response, _state(job_admission_rejected=True, retry_after_seconds=42))
        assert response.job_admission_rejected is True
        assert response.retry_after_seconds == 42

    def test_a_mute_list_only_rides_with_the_list_it_mutes(self):
        response = _response()
        apply_state_extras(response, _state(skills_hidden=["voice"]))
        assert getattr(response, "skills_hidden", None) is None

        response = _response()
        apply_state_extras(response, _state(skills_activated=["voice", "x"], skills_hidden=["voice"]))
        assert response.skills_activated == ["voice", "x"]
        assert response.skills_hidden == ["voice"]

    def test_empty_containers_are_absent(self):
        response = _response()
        apply_state_extras(response, _state(skills_activated=[], answer_meta={}, citations_removed={}))
        for name in ("skills_activated", "answer_meta", "citations_removed"):
            assert getattr(response, name, None) is None


class TestBuildResponse:
    def test_the_last_message_is_the_answer_and_cards_attach(self):
        response = build_response(_state(), cards=[{"type": "checklist"}], workflow_id="wf")
        assert response.choices[0].message.content == "Mindestens 100 cm."
        assert response.model == "wf"
        assert response.cards == [{"type": "checklist"}]

    def test_no_messages_is_said_so(self):
        response = build_response(_state(messages=[]), cards=None, workflow_id="wf")
        assert response.choices[0].message.content == "No response generated."
        assert getattr(response, "cards", None) is None

    def test_non_string_content_is_stringified(self):
        state = _state(messages=[AIMessage(content=[{"type": "text", "text": "x"}])])
        assert answer_text(state) == str([{"type": "text", "text": "x"}])


class TestPostAnswerTurnFacts:
    """The crossing from finished graph state to a stage's inputs.

    Every fact here is one a deterministic gate is allowed to decide on, so a
    fact that silently fails to cross is a gate that silently cannot enforce its
    own rule — which is exactly what happened to `research_truncated`.
    """

    def _facts(self, state, response=None, **overrides):
        kwargs = {
            "state": state,
            "response": response or _response(),
            "query_text": "Wie hoch darf die Brüstung sein?",
            "cards": None,
        }
        kwargs.update(overrides)
        return post_answer_turn_facts(TurnFacts(project_id="proj_1"), **kwargs)

    def test_the_request_scoped_half_survives(self):
        facts = self._facts(_state())
        assert facts.project_id == "proj_1"
        assert facts.query == "Wie hoch darf die Brüstung sein?"
        assert facts.answer == "Mindestens 100 cm."

    def test_truncation_crosses(self):
        assert self._facts(_state(research_truncated=True)).research_truncated is True
        assert self._facts(_state()).research_truncated is False

    def test_routing_decision_crosses_off_the_answer(self):
        response = _response()
        response.routing_decision = "deep"
        assert self._facts(_state(), response=response).routing_decision == "deep"

    def test_emitted_card_types_cross(self):
        facts = self._facts(_state(), cards=[{"type": "follow_ups"}, {"type": "checklist"}, {}, "junk"])
        assert facts.emitted_card_types == frozenset({"follow_ups", "checklist"})

    def test_deep_research_stub_and_confidence_cross(self):
        facts = self._facts(_state(deep_research_job_id="job_1", answer_confidence="high"))
        assert facts.deep_research_job_id == "job_1"
        assert facts.answer_confidence == "high"

    def test_memory_writes_cross(self):
        assert self._facts(_state(), remembered_this_turn=("Firma: Grid",)).remembered_this_turn == ("Firma: Grid",)
