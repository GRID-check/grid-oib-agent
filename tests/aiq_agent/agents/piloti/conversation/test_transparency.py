"""Tests for the transparency extras (WP-A) populated by the conversation graph.

Covers the pure derivation helpers (observed routing, capped-confidence
reason, citations-removed normalization, escalation reason) and their
end-to-end propagation through ``ConversationGraph.run()`` — including the
``JobAdmissionError`` queue-rejection path that carries both
``job_admission_rejected`` and ``retry_after_seconds``.

Every extra follows the same rule: present when applicable, absent (never
null-spammed) otherwise.

Since ADR-0052 the routing is an OBSERVATION: nothing decides a path before
the answer, so every end-to-end case here seeds Piloti's result and reads
``routing_decision`` off what the graph did with it.
"""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.conversation import ANSWER_LIFTS
from aiq_agent.agents.piloti.conversation import ConversationGraph
from aiq_agent.agents.piloti.conversation import _finalize_answer
from aiq_agent.agents.piloti.ledger import citations_removed_summary
from aiq_agent.agents.piloti.markers import ESCALATION_MARKER
from aiq_agent.agents.piloti.markers import answer_confidence_capped_reason
from aiq_agent.agents.piloti.markers import surface_answer_confidence
from aiq_agent.agents.piloti.models import ClarifyResult
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common.job_admission import JobAdmissionError
from aiq_agent.turn.response import RESPONSE_LIFTS


def _signals(**fields) -> ResearchAgentState:
    fields.setdefault("escalation_requested", False)
    return ResearchAgentState(messages=[], **fields)


def _routing(*, source_lookup_attempted: bool, self_reported) -> str:
    return _signals(
        source_lookup_attempted=source_lookup_attempted, answer_confidence_marker=self_reported
    ).observed_routing


class TestObservedRouting:
    """Which shape the answering agent gave the turn, read off its own finished
    state — a property of that state, not something a reader re-derives."""

    def test_no_lookup_and_no_self_report_is_a_direct_reply(self):
        assert _routing(source_lookup_attempted=False, self_reported=None) == "meta"

    def test_a_source_lookup_makes_it_research(self):
        assert _routing(source_lookup_attempted=True, self_reported=None) == "shallow"

    def test_a_self_report_alone_makes_it_research(self):
        # The model presented it as a researched answer even without a lookup;
        # the confidence guard, not the routing, is what caps that.
        assert _routing(source_lookup_attempted=False, self_reported="high") == "shallow"
        assert _routing(source_lookup_attempted=False, self_reported="low") == "shallow"

    def test_both_is_research(self):
        assert _routing(source_lookup_attempted=True, self_reported="medium") == "shallow"

    def test_it_never_yields_deep_or_error(self):
        """Deep and error are set by the nodes that take those paths."""
        for attempted in (True, False):
            for level in (None, "low", "medium", "high"):
                assert _routing(source_lookup_attempted=attempted, self_reported=level) in {"meta", "shallow"}


class TestFinalizeAnswerRouting:
    """``_finalize_answer`` lifts the observation on a non-escalated answer."""

    def test_direct_reply_is_meta(self):
        update = _finalize_answer(
            AIMessage(content="Hallo! Womit kann ich helfen?"), _signals(source_lookup_attempted=False)
        )
        assert update["routing_decision"] == "meta"
        assert update["escalate_to_deep"] is False

    def test_researched_answer_is_shallow(self):
        update = _finalize_answer(
            AIMessage(content="OIB 2 [1]."),
            _signals(answer_citation_grounded=True, answer_confidence_marker="high", source_lookup_attempted=True),
        )
        assert update["routing_decision"] == "shallow"

    def test_an_escalation_writes_no_observation(self):
        """The clarifier node sets ``deep`` when it hands over; the answering
        node must not pre-empt it with a shallow/meta label."""
        update = _finalize_answer(AIMessage(content="Teilantwort."), _signals(escalation_requested=True))
        assert "routing_decision" not in update
        assert update["escalate_to_deep"] is True


class TestAnswerConfidenceCappedReason:
    """ "ungrounded" only on an ACTUAL downgrade, absent otherwise."""

    def test_no_self_report_yields_none(self):
        assert answer_confidence_capped_reason(None, False) is None

    def test_grounded_yields_none(self):
        assert answer_confidence_capped_reason("high", True) is None

    def test_already_low_is_not_a_downgrade(self):
        assert answer_confidence_capped_reason("low", False) is None

    def test_high_ungrounded_is_capped(self):
        assert answer_confidence_capped_reason("high", False) == "ungrounded"

    def test_medium_ungrounded_is_capped(self):
        assert answer_confidence_capped_reason("medium", False) == "ungrounded"

    def test_grounded_but_unverified_quote_is_quote_unverified(self):
        # Grounded answer, but a quoted span failed verification → quote_unverified.
        assert answer_confidence_capped_reason("high", True, False) == "quote_unverified"

    def test_grounded_with_verified_quotes_yields_none(self):
        assert answer_confidence_capped_reason("high", True, True) is None

    def test_ungrounded_wins_over_quote_unverified(self):
        # Both failures present → the more fundamental "ungrounded" reason wins.
        assert answer_confidence_capped_reason("high", False, False) == "ungrounded"

    def test_already_low_not_downgraded_even_with_unverified_quote(self):
        assert answer_confidence_capped_reason("low", True, False) is None

    def test_quotes_verified_defaults_true(self):
        # Two-arg legacy callers keep the pre-quote-verification behavior.
        assert answer_confidence_capped_reason("high", True) is None


class TestSurfaceAnswerConfidenceQuotes:
    """The overconfidence guard also caps on an unverified quoted span."""

    def test_unverified_quote_caps_a_grounded_answer_to_medium(self):
        # The span is marked inline; the citations around it still hold.
        assert surface_answer_confidence("high", True, False) == "medium"

    def test_unverified_quote_without_grounding_is_low(self):
        assert surface_answer_confidence("high", False, False) == "low"

    def test_grounded_and_verified_surfaces_verbatim(self):
        assert surface_answer_confidence("high", True, True) == "high"

    def test_no_self_report_still_none(self):
        assert surface_answer_confidence(None, True, False) is None

    def test_quotes_verified_defaults_true(self):
        assert surface_answer_confidence("medium", True) == "medium"


class TestAnswerLifts:
    """Both halves of every lift are real, on the model they name.

    The table replaced eleven hand-written ``update[x] = result.y`` lines. A
    table can go stale in one direction only — a field renamed on either side —
    so that is what this checks, for both sides, by name.
    """

    def test_every_source_is_readable_on_pilotis_finished_state(self):
        finished = ResearchAgentState(messages=[])
        for source, _ in ANSWER_LIFTS:
            assert hasattr(finished, source), f"{source} is not on ResearchAgentState"

    def test_every_destination_is_a_field_of_the_conversation_state(self):
        for _, field in ANSWER_LIFTS:
            assert field in ConversationState.model_fields, f"{field} is not on ConversationState"

    def test_the_transparency_extras_the_wire_carries_are_all_lifted(self):
        """A field the response lifts but the node never writes reaches nobody."""
        written = {field for _, field in ANSWER_LIFTS} | {
            "research_truncated",
            "escalation_reason",
            "deep_research_job_id",
            "job_admission_rejected",
            "retry_after_seconds",
        }
        assert {field for field, _, _ in RESPONSE_LIFTS} <= written


class TestCitationsRemovedIsProducedInWireShape:
    """The summary crosses to the wire UNCHANGED, so the producer owes the shape.

    The conversation node used to re-normalise this dict on the way past —
    coercing the count, deduplicating the reasons, capping them at five — on
    data that ``citations_removed_summary`` had already normalised. The
    re-derivation is gone; these pin the one place that decides.
    """

    def test_none_when_nothing_was_removed(self):
        assert citations_removed_summary([]) is None

    def test_count_is_the_number_removed(self):
        out = citations_removed_summary([{"reason": "broken link"}, {"reason": "404"}])
        assert out == {"count": 2, "reasons": ["broken link", "404"]}

    def test_reasons_deduplicated_preserving_order(self):
        out = citations_removed_summary([{"reason": "dup"}, {"reason": "dup"}, {"reason": "other"}])
        assert out == {"count": 3, "reasons": ["dup", "other"]}

    def test_reasons_capped_at_five(self):
        out = citations_removed_summary([{"reason": f"r{n}"} for n in range(9)])
        assert out["count"] == 9
        assert out["reasons"] == ["r0", "r1", "r2", "r3", "r4"]

    def test_a_missing_reason_is_named_rather_than_dropped(self):
        assert citations_removed_summary([{}]) == {"count": 1, "reasons": ["unverifiable"]}


def _research_result(
    messages,
    answer: str,
    *,
    escalating: bool = False,
    source_lookup_attempted: bool = True,
    confidence_marker=None,
    escalation_reason: str | None = None,
    **fields,
) -> ResearchAgentState:
    """A Piloti result: the real state with the control fields a case names."""
    return ResearchAgentState(
        messages=list(messages) + [AIMessage(content=answer)],
        escalation_requested=escalating,
        answer_confidence_marker=confidence_marker,
        answer_escalation_reason=escalation_reason,
        source_lookup_attempted=source_lookup_attempted,
        **fields,
    )


def _research_fn(answer: str, **fields):
    async def research(state):
        return _research_result(state.messages, answer, **fields)

    return research


async def _deep(state):
    result = MagicMock()
    result.messages = list(state.messages) + [AIMessage(content="Deep report.")]
    result.citations_removed = None
    return result


async def _clarifier(request):
    return ClarifyResult(research_context="log", outcome="approved")


def _agent(research_fn=None, *, deep_fn=None, deep_submitter=None):
    """Build a ConversationGraph with trivial async node functions."""
    return ConversationGraph(
        research_fn=research_fn or _research_fn("answer"),
        deep_research_fn=deep_fn or _deep,
        clarifier_fn=_clarifier,
        deep_research_job_submitter=deep_submitter,
    )


class TestRoutingDecisionOnTheWire:
    """``routing_decision`` on the terminal state, one case per path."""

    @pytest.mark.asyncio
    async def test_a_direct_reply_is_meta(self):
        agent = _agent(_research_fn("Hallo!", source_lookup_attempted=False))
        result = await agent.run(ConversationState(messages=[HumanMessage(content="hallo")]), thread_id="t")
        assert result.routing_decision == "meta"

    @pytest.mark.asyncio
    async def test_a_researched_answer_is_shallow(self):
        agent = _agent(_research_fn("Antwort [1].", source_lookup_attempted=True))
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Was gilt?")]), thread_id="t")
        assert result.routing_decision == "shallow"

    @pytest.mark.asyncio
    async def test_a_graded_answer_without_a_lookup_is_still_shallow(self):
        agent = _agent(_research_fn("Antwort.", source_lookup_attempted=False, confidence_marker="low"))
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Was gilt?")]), thread_id="t")
        assert result.routing_decision == "shallow"

    @pytest.mark.asyncio
    async def test_an_escalated_turn_is_deep(self):
        agent = _agent(_research_fn("Teilantwort.", escalating=True))
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Vergleich?")]), thread_id="t")
        assert result.routing_decision == "deep"
        assert result.messages[-1].content == "Deep report."

    @pytest.mark.asyncio
    async def test_a_failed_shallow_turn_is_error(self):
        async def research_raises(state):
            raise RuntimeError("boom")

        agent = _agent(research_raises)
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Was gilt?")]), thread_id="t")
        assert result.routing_decision == "error"

    @pytest.mark.asyncio
    async def test_a_stale_decision_never_outlives_its_turn(self):
        """Reset at the turn boundary: turn 2's direct reply is not labelled
        with turn 1's research."""
        from langgraph.checkpoint.memory import MemorySaver

        first = _research_fn("Antwort [1].", source_lookup_attempted=True)
        second = _research_fn("Gern geschehen!", source_lookup_attempted=False)
        agent = ConversationGraph(
            research_fn=first,
            deep_research_fn=_deep,
            clarifier_fn=None,
            checkpointer=MemorySaver(),
        )
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Was gilt?")]), thread_id="c")
        assert result.routing_decision == "shallow"

        agent.research_fn = second
        result = await agent.run(ConversationState(messages=[HumanMessage(content="danke")]), thread_id="c")
        assert result.routing_decision == "meta"


class TestEscalationAsk:
    """What the answering node writes for the escalation edge and the clarifier."""

    def test_the_ask_carries_the_models_own_reason(self):
        update = _finalize_answer(
            AIMessage(content="Teilantwort."),
            _signals(escalation_requested=True, answer_escalation_reason="not enough sources"),
        )

        assert update["escalate_to_deep"] is True
        assert update["escalation_ask_reason"] == "not enough sources"
        # The WIRE field is not set here: no escalation has happened yet, and a
        # suppressed ask must not narrate one.
        assert "escalation_reason" not in update

    def test_an_answered_turn_does_not_ask(self):
        update = _finalize_answer(AIMessage(content="Die Antwort."), _signals())

        assert update["escalate_to_deep"] is False
        assert "escalation_ask_reason" not in update

    def test_a_reasonless_ask_falls_back_to_the_fixed_clause(self):
        update = _finalize_answer(AIMessage(content="Teilantwort."), _signals(escalation_requested=True))

        assert update["escalation_ask_reason"] == "Shallow agent emitted insufficiency marker"


class TestJobAdmissionRejectedPropagation:
    """The queue-rejection path carries BOTH extras end-to-end through run()."""

    @pytest.mark.asyncio
    async def test_both_fields_propagate(self):
        async def rejecting_submitter(state):
            raise JobAdmissionError("Queue is full, try later", retry_after_seconds=42)

        agent = _agent(_research_fn("Teilantwort.", escalating=True), deep_submitter=rejecting_submitter)

        state = ConversationState(messages=[HumanMessage(content="Deep question")])
        result = await agent.run(state, thread_id="t")

        assert result.job_admission_rejected is True
        assert result.retry_after_seconds == 42
        # The answer text is the rejection notice, not a research answer.
        contents = [m.content for m in result.messages if isinstance(m, AIMessage)]
        assert any("Queue is full" in c for c in contents)

    @pytest.mark.asyncio
    async def test_successful_submission_has_no_rejection_fields(self):
        async def ok_submitter(state):
            return "job-123"

        agent = _agent(_research_fn("Teilantwort.", escalating=True), deep_submitter=ok_submitter)

        state = ConversationState(messages=[HumanMessage(content="Deep question")])
        result = await agent.run(state, thread_id="t")

        # Absent-when-not-applicable: reset at the turn boundary, never set here.
        assert result.job_admission_rejected is None
        assert result.retry_after_seconds is None
        assert result.deep_research_job_id == "job-123"
        assert result.routing_decision == "deep"


class TestEscalationReasonEndToEnd:
    """A shallow→deep escalation surfaces escalation_reason on the final state."""

    @pytest.mark.asyncio
    async def test_marker_escalation_surfaces_the_legacy_reason(self):
        async def insufficient_research(state):
            return _research_result(state.messages, f"Teilantwort [1].\n{ESCALATION_MARKER}", escalating=True)

        agent = _agent(insufficient_research)

        state = ConversationState(messages=[HumanMessage(content="Obscure question")])
        result = await agent.run(state, thread_id="t")

        assert result.escalation_reason == "Shallow agent emitted insufficiency marker"

    @pytest.mark.asyncio
    async def test_the_envelopes_reason_reaches_the_terminal_state(self):
        """The model's own clause (``answer_escalation_reason`` on the shallow
        state) is what the reader is told, via ``escalation_ask_reason`` and
        the clarifier node — never the fixed string when a real one exists."""
        reason = "Die Frage braucht einen Vergleich über drei Bundesländer."

        async def insufficient_research(state):
            return _research_result(state.messages, "Teilantwort.", escalating=True, escalation_reason=reason)

        agent = _agent(insufficient_research)
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Vergleich?")]), thread_id="t")

        # The carrier the clarifier node reads it from...
        assert result.escalation_ask_reason == reason
        # ...and the terminal extra the frontend narrates.
        assert result.escalation_reason == reason

    @pytest.mark.asyncio
    async def test_insufficiency_prose_without_marker_does_not_escalate(self):
        """Regression: German legal hedging in a shallow answer must NOT trigger
        a deep-research escalation — only the explicit marker may."""

        async def hedged_research(state):
            # No escalation marker — just prose that the removed keyword
            # fallback would have false-positived on.
            return _research_result(
                state.messages,
                "Teilantwort [1]. Weitere Recherche erforderlich, lässt sich nicht finden.",
                escalating=False,
            )

        async def deep(state):
            raise AssertionError("deep research must not run on prose alone")

        agent = _agent(hedged_research, deep_fn=deep)

        state = ConversationState(messages=[HumanMessage(content="Obscure question")])
        result = await agent.run(state, thread_id="t")

        assert result.escalation_reason is None
        assert result.routing_decision == "shallow"
        contents = [m.content for m in result.messages if isinstance(m, AIMessage)]
        assert any("Weitere Recherche erforderlich" in c for c in contents)

    @pytest.mark.asyncio
    async def test_empty_shallow_answer_is_error_not_escalation(self):
        """An empty assistant message is a generation failure: the turn ends
        with a retry-able error message, never a deep-research escalation."""

        async def empty_research(state):
            return _research_result(state.messages, "", escalating=False)

        async def deep(state):
            raise AssertionError("deep research must not run on an empty answer")

        agent = _agent(empty_research, deep_fn=deep)

        state = ConversationState(messages=[HumanMessage(content="Any question")])
        result = await agent.run(state, thread_id="t")

        assert result.escalation_reason is None
        contents = [m.content for m in result.messages if isinstance(m, AIMessage)]
        assert any("An error occurred" in c for c in contents)


class TestCitationsRemovedEndToEnd:
    """A populated upstream citations_removed reaches the terminal state."""

    @pytest.mark.asyncio
    async def test_citations_removed_reaches_state(self):
        async def research_with_removed(state):
            # A grounded, non-escalating answer that dropped two unverifiable
            # citations during verification.
            return _research_result(
                state.messages,
                "Antwort [1].",
                citations_removed={"count": 2, "reasons": ["url_not_in_registry", "unverifiable"]},
            )

        agent = _agent(research_with_removed)

        state = ConversationState(messages=[HumanMessage(content="Was gilt?")])
        result = await agent.run(state, thread_id="t")

        assert result.citations_removed == {"count": 2, "reasons": ["url_not_in_registry", "unverifiable"]}

    @pytest.mark.asyncio
    async def test_absent_citations_removed_stays_none(self):
        agent = _agent(_research_fn("Antwort [1]."))

        state = ConversationState(messages=[HumanMessage(content="Was gilt?")])
        result = await agent.run(state, thread_id="t")

        # Reset at the turn boundary, never set → absent (None).
        assert result.citations_removed is None


class TestResearchTruncatedEndToEnd:
    """Truncation is a fact about the ANSWER, so it rides the answer's frame.

    Piloti already logs it and emits it as telemetry; neither of
    those can put a line under the answer a person is reading, which is the one
    place "the search stopped before it finished" changes what they do next.
    """

    @pytest.mark.asyncio
    async def test_a_truncated_shallow_turn_reaches_the_terminal_state(self):
        async def research_truncated_answer(state):
            return _research_result(state.messages, "Antwort [1].", research_truncated=True)

        state = ConversationState(messages=[HumanMessage(content="Wie tief ist der Lichteinfall?")])
        result = await _agent(research_truncated_answer).run(state, thread_id="t")

        assert result.research_truncated is True

    @pytest.mark.asyncio
    async def test_a_complete_turn_carries_no_flag_at_all(self):
        state = ConversationState(messages=[HumanMessage(content="Was gilt?")])
        result = await _agent(_research_fn("Antwort [1].")).run(state, thread_id="t")

        # Absent, never False: the note renders on presence, so a False here
        # would be one more default for a reader to interpret.
        assert result.research_truncated is None

    @pytest.mark.asyncio
    async def test_a_shallow_turn_that_escalates_drops_the_flag(self):
        """The deep report replaces this answer, so its budget is not the reader's news."""

        async def research_escalating(state):
            return _research_result(
                state.messages, f"Reicht nicht. {ESCALATION_MARKER}", escalating=True, research_truncated=True
            )

        state = ConversationState(messages=[HumanMessage(content="Was gilt?")])
        result = await _agent(research_escalating).run(state, thread_id="t")

        assert result.research_truncated is None
