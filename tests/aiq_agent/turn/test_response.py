"""The crossing from finished graph state to the turn's result and the stage facts."""

import uuid

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.common.canned_replies import NO_RESPONSE_TEXT
from aiq_agent.common.wire_v2 import RunHandoff
from aiq_agent.common.wire_v2 import card_key
from aiq_agent.common.wire_v2 import stamp
from aiq_agent.common.wire_v2 import to_frame
from aiq_agent.stages import TurnFacts
from aiq_agent.turn.response import answer_message_id
from aiq_agent.turn.response import answer_text
from aiq_agent.turn.response import build_result
from aiq_agent.turn.response import finished
from aiq_agent.turn.response import post_answer_turn_facts


def _state(**fields) -> ConversationState:
    fields.setdefault("messages", [HumanMessage(content="Frage?"), AIMessage(content="Mindestens 100 cm.")])
    return ConversationState(**fields)


def _result(cards=(), **fields):
    return build_result(_state(**fields), list(cards), "m1")


class TestBuildResult:
    """Every field of the result is lifted off the state; the frame omits what is at its default."""

    def test_the_last_message_is_the_answer_and_cards_are_keyed(self):
        card = {"type": "checklist", "items": []}
        result = _result(cards=[card])
        assert result.message_id == "m1"
        assert result.text == "Mindestens 100 cm."
        assert [(c.key, c.card) for c in result.cards] == [(card_key(card), card)]

    def test_no_messages_is_said_so(self):
        assert build_result(_state(messages=[]), [], "m1").text == NO_RESPONSE_TEXT

    def test_non_string_content_is_stringified(self):
        state = _state(messages=[AIMessage(content=[{"type": "text", "text": "x"}])])
        assert answer_text(state) == str([{"type": "text", "text": "x"}])

    def test_every_state_field_reaches_the_result(self):
        ledger = [{"index": 0, "docs": [], "new_docs": []}]
        read = [{"document_id": "doc:oib_knowledge:oib-rl_2.pdf", "file_name": "oib-rl_2.pdf"}]
        result = _result(
            routing_decision="shallow",
            answer_confidence="low",
            answer_confidence_reason="weil",
            answer_confidence_capped_reason="ungrounded",
            verified_sources=[{"content": "[OIB] a.pdf", "number": 1, "file_name": "a.pdf"}],
            read_sources=read,
            escalation_reason="zu breit",
            citations_removed={"count": 1, "reasons": ["no_passage"]},
            research_truncated=True,
            answer_meta={"kind": "ruling", "verdict": "40 m"},
            retrieval_ledger=ledger,
        )
        assert result.routing_decision == "shallow"
        assert result.answer_confidence == "low"
        assert result.answer_confidence_reason == "weil"
        assert result.answer_confidence_capped_reason == "ungrounded"
        assert result.sources[0].file_name == "a.pdf"
        assert result.read_sources == read
        assert result.escalation_reason == "zu breit"
        assert result.citations_removed.count == 1
        assert result.research_truncated is True
        assert result.answer_meta == {"kind": "ruling", "verdict": "40 m"}
        assert result.retrieval_ledger == ledger

    def test_absent_and_empty_values_are_absent_from_the_frame(self):
        result = _result(skills_activated=[], answer_meta={}, citations_removed={})
        assert result.model_dump(exclude_defaults=True) == {"message_id": "m1", "text": "Mindestens 100 cm."}

    def test_a_retry_hint_only_rides_with_its_rejection(self):
        assert _result(retry_after_seconds=42).retry_after_seconds is None
        result = _result(job_admission_rejected=True, retry_after_seconds=42)
        assert result.job_admission_rejected is True
        assert result.retry_after_seconds == 42

    def test_a_mute_list_only_rides_with_the_list_it_mutes(self):
        assert _result(skills_hidden=["voice"]).skills_hidden == []
        result = _result(skills_activated=["voice", "x"], skills_hidden=["voice"])
        assert result.skills_activated == ["voice", "x"]
        assert result.skills_hidden == ["voice"]

    def test_the_run_hand_off_is_both_ids_or_neither(self):
        assert _result(run_id="run_1").run is None
        assert _result(run_id="run_1", run_message_id="msg_9").run == RunHandoff(run_id="run_1", run_message_id="msg_9")


class TestFinished:
    def test_an_answer_a_hand_off_and_a_queue_refusal(self):
        assert finished(_result()).outcome == "answered"
        assert finished(_result(run_id="r", run_message_id="m")).outcome == "handed_off"
        assert finished(_result(job_admission_rejected=True)).outcome == "refused"

    def test_the_terminal_frame_carries_the_result(self):
        frame = to_frame(stamp(finished(_result()), conversation_id="c", turn_id="t", seq=1, ts=0))
        assert frame["result"] == {"message_id": "m1", "text": "Mindestens 100 cm."}


class TestAnswerMessageId:
    def test_it_is_the_persisted_rows_id(self):
        """The same uuid5 the messages route has always been given (``ON CONFLICT DO NOTHING``)."""
        expected = str(uuid.uuid5(uuid.NAMESPACE_URL, "grid:assistant:conv:turn"))
        assert answer_message_id("conv", "turn") == expected
        assert answer_message_id("conv", None) == str(uuid.uuid5(uuid.NAMESPACE_URL, "grid:assistant:conv:default"))

    def test_the_running_turn_names_its_answer_before_it_exists(self, monkeypatch):
        """ADR-0091: the BFF marks this id at admission; it must be the id the answer is streamed under."""
        from aiq_agent import project_context
        from aiq_agent.turn.response import turn_answer_message_id

        monkeypatch.setattr(project_context, "get_user_message_id_from_context", lambda: "turn")
        assert turn_answer_message_id("conv") == answer_message_id("conv", "turn")


class TestPostAnswerTurnFacts:
    """The crossing from finished graph state to a stage's inputs.

    Every fact here is one a deterministic gate is allowed to decide on, so a
    fact that silently fails to cross is a gate that silently cannot enforce its
    own rule — which is exactly what happened to `research_truncated`.
    """

    def _facts(self, state, **overrides):
        kwargs = {
            "state": state,
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

    def test_routing_decision_crosses(self):
        assert self._facts(_state(routing_decision="deep")).routing_decision == "deep"

    def test_emitted_card_types_cross(self):
        facts = self._facts(_state(), cards=[{"type": "follow_ups"}, {"type": "checklist"}, {}, "junk"])
        assert facts.emitted_card_types == frozenset({"follow_ups", "checklist"})

    def test_the_commissioned_run_and_confidence_cross(self):
        facts = self._facts(_state(run_id="run_1", answer_confidence="high"))
        assert facts.run_id == "run_1"
        assert facts.answer_confidence == "high"

    def test_memory_writes_cross(self):
        assert self._facts(_state(), remembered_this_turn=("Firma: Grid",)).remembered_this_turn == ("Firma: Grid",)

    def test_an_open_scope_crosses_as_no_restriction(self):
        assert self._facts(_state(collection_scope=["oib_knowledge", "proj_1"])).restriction.restricted is False
        assert self._facts(_state()).restriction.restricted is False

    def test_the_restriction_evidence_crosses(self):
        """ADR-0086: the reflection stage restricts what it writes from this.

        Read is what the turn cited, what it read uncited, and what the
        conversation's registry holds; listed is the uncapped inventory, else
        the prompt's rows. A default would let the stage write open memory.
        """
        restricted_a = "proj_1_r0123456789ab"
        restricted_b = "proj_1_rba9876543210"
        restricted_c = "proj_1_rcccccccccccc"
        state = _state(
            collection_scope=["oib_knowledge", "proj_1", restricted_a, restricted_b, restricted_c],
            verified_sources=[{"collection": restricted_a}, {"collection": "oib_knowledge"}],
            read_sources=[{"collection": "proj_1"}],
            available_documents=[
                {"collection": restricted_c, "file_name": "prompt.pdf", "summary": "in the prompt"},
            ],
        )
        facts = self._facts(
            state,
            registry_collections=(restricted_b,),
            listed_documents=(
                {"collection": restricted_c, "file_name": "Vertrag.pdf", "summary": "Honorar"},
                {"collection": "proj_1", "file_name": "Plan.pdf", "summary": "open"},
            ),
        )
        evidence = facts.restriction
        assert evidence.scope == (restricted_a, restricted_b, restricted_c)
        assert evidence.read == (restricted_a, restricted_b)
        assert [doc.name for doc in evidence.documents] == ["Vertrag.pdf"]

    def test_restricted_memory_in_the_prompt_crosses_as_notes(self):
        """The digest's restricted lines and the tool's restricted writes this turn."""
        restricted = "proj_1_r0123456789ab"
        digest = '- [restricted | decision | high | unverified] "Honorar pauschal."'
        facts = post_answer_turn_facts(
            TurnFacts(project_id="proj_1", memory_digest=digest),
            state=_state(collection_scope=["proj_1", restricted]),
            query_text="q",
            cards=[],
            restricted_memory_writes=("Vertragsstrafe 0,1 %",),
        )
        assert [(note.content, note.collections) for note in facts.restriction.notes] == [
            ("Honorar pauschal.", (restricted,)),
            ("Vertragsstrafe 0,1 %", (restricted,)),
        ]

    def test_notes_earlier_turns_were_shown_cross_with_their_own_collections(self):
        """ADR-0086: a restricted note gone from this turn's digest is still evidence."""
        from aiq_agent.memory.restriction import RestrictedNote
        from aiq_agent.memory.shown_notes import ShownNotes

        earlier_folder = "proj_1_rba9876543210"
        overflowed = "proj_1_r00000000000f"
        facts = post_answer_turn_facts(
            TurnFacts(project_id="proj_1", memory_digest=None),
            state=_state(collection_scope=["proj_1"]),
            query_text="q",
            cards=[],
            earlier_restricted_notes=ShownNotes(
                notes=(RestrictedNote("Gehalt Bauleiter 5.200 brutto.", (earlier_folder,)),),
                overflowed=(overflowed,),
            ),
        )
        evidence = facts.restriction
        assert evidence.restricted
        assert evidence.scope == (earlier_folder, overflowed)
        assert evidence.read == (overflowed,)
        assert [(note.content, note.collections) for note in evidence.notes] == [
            ("Gehalt Bauleiter 5.200 brutto.", (earlier_folder,))
        ]

    def test_the_prompt_rows_stand_in_when_no_listing_was_bound(self):
        restricted = "proj_1_r0123456789ab"
        state = _state(
            collection_scope=["proj_1", restricted],
            available_documents=[{"collection": restricted, "file_name": "prompt.pdf", "summary": "s"}],
        )
        assert [doc.name for doc in self._facts(state).restriction.documents] == ["prompt.pdf"]
