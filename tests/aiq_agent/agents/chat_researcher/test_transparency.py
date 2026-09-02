"""Tests for the transparency extras (WP-A) populated by the chat_researcher.

Covers the pure derivation helpers (observed routing, capped-confidence
reason, citations-removed normalization, escalation reason) and their
end-to-end propagation through ``ChatResearcherAgent.run()`` — including the
``JobAdmissionError`` queue-rejection path that carries both
``job_admission_rejected`` and ``retry_after_seconds``.

Every extra follows the same rule: present when applicable, absent (never
null-spammed) otherwise.

Since ADR-0052 the routing is an OBSERVATION: nothing decides a path before
the answer, so every end-to-end case here seeds the shallow result and reads
``routing_decision`` off what the graph did with it.
"""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.agent import ESCALATION_MARKER
from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.agent import _finalize_shallow_answer
from aiq_agent.agents.chat_researcher.agent import _normalize_citations_removed
from aiq_agent.agents.chat_researcher.agent import answer_confidence_capped_reason
from aiq_agent.agents.chat_researcher.agent import observed_routing
from aiq_agent.agents.chat_researcher.agent import surface_answer_confidence
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import ShallowResult
from aiq_agent.common.job_admission import JobAdmissionError


class TestObservedRouting:
    """Which shape the answering agent gave the turn, read off the finished answer."""

    def test_no_lookup_and_no_self_report_is_a_direct_reply(self):
        assert observed_routing(source_lookup_attempted=False, self_reported=None) == "meta"

    def test_a_source_lookup_makes_it_research(self):
        assert observed_routing(source_lookup_attempted=True, self_reported=None) == "shallow"

    def test_a_self_report_alone_makes_it_research(self):
        # The model presented it as a researched answer even without a lookup;
        # the confidence guard, not the routing, is what caps that.
        assert observed_routing(source_lookup_attempted=False, self_reported="high") == "shallow"
        assert observed_routing(source_lookup_attempted=False, self_reported="low") == "shallow"

    def test_both_is_research(self):
        assert observed_routing(source_lookup_attempted=True, self_reported="medium") == "shallow"

    def test_it_never_yields_deep_or_error(self):
        """Deep and error are set by the nodes that take those paths."""
        for attempted in (True, False):
            for level in (None, "low", "medium", "high"):
                assert observed_routing(source_lookup_attempted=attempted, self_reported=level) in {"meta", "shallow"}


class TestFinalizeShallowAnswerRouting:
    """``_finalize_shallow_answer`` writes the observation on a non-escalated answer."""

    def test_direct_reply_is_meta(self):
        update = _finalize_shallow_answer(
            AIMessage(content="Hallo! Womit kann ich helfen?"),
            citation_grounded=False,
            escalation_present=False,
            self_reported=None,
            source_lookup_attempted=False,
        )
        assert update["routing_decision"] == "meta"
        assert update["shallow_result"] is None

    def test_researched_answer_is_shallow(self):
        update = _finalize_shallow_answer(
            AIMessage(content="OIB 2 [1]."),
            citation_grounded=True,
            escalation_present=False,
            self_reported="high",
            source_lookup_attempted=True,
        )
        assert update["routing_decision"] == "shallow"

    def test_source_lookup_defaults_to_attempted(self):
        """Fail toward research: an older caller that does not say must not
        turn a cited answer into a direct reply."""
        update = _finalize_shallow_answer(AIMessage(content="Antwort [1]."), citation_grounded=True)
        assert update["routing_decision"] == "shallow"

    def test_an_escalation_writes_no_observation(self):
        """The clarifier node sets ``deep`` when it hands over; the shallow
        node must not pre-empt it with a shallow/meta label."""
        update = _finalize_shallow_answer(
            AIMessage(content="Teilantwort."),
            citation_grounded=False,
            escalation_present=True,
            self_reported=None,
            source_lookup_attempted=False,
        )
        assert "routing_decision" not in update
        assert update["shallow_result"].escalate_to_deep is True

    def test_the_envelope_reason_reaches_the_shallow_result(self):
        update = _finalize_shallow_answer(
            AIMessage(content="Teilantwort."),
            citation_grounded=False,
            escalation_present=True,
            self_reported=None,
            escalation_reason="Mehrere Bundesländer zu vergleichen",
        )
        assert update["shallow_result"].escalation_reason == "Mehrere Bundesländer zu vergleichen"

    def test_without_an_envelope_reason_the_legacy_string_stands_in(self):
        update = _finalize_shallow_answer(
            AIMessage(content="Teilantwort."),
            citation_grounded=False,
            escalation_present=True,
            self_reported=None,
        )
        assert update["shallow_result"].escalation_reason == "Shallow agent emitted insufficiency marker"


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


class TestNormalizeCitationsRemoved:
    """Sanitize the removed-citation summary to the wire shape."""

    def test_none_when_not_a_dict(self):
        assert _normalize_citations_removed(None) is None
        assert _normalize_citations_removed("nope") is None

    def test_none_when_count_zero(self):
        assert _normalize_citations_removed({"count": 0, "reasons": []}) is None

    def test_none_when_count_unparseable(self):
        assert _normalize_citations_removed({"count": "many", "reasons": []}) is None

    def test_present_when_count_positive(self):
        out = _normalize_citations_removed({"count": 2, "reasons": ["broken link", "404"]})
        assert out == {"count": 2, "reasons": ["broken link", "404"]}

    def test_reasons_deduplicated_preserving_order(self):
        out = _normalize_citations_removed({"count": 3, "reasons": ["dup", "dup", "other"]})
        assert out == {"count": 3, "reasons": ["dup", "other"]}

    def test_reasons_capped_at_five(self):
        out = _normalize_citations_removed({"count": 9, "reasons": ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]})
        assert out["count"] == 9
        assert out["reasons"] == ["r1", "r2", "r3", "r4", "r5"]

    def test_missing_reasons_yields_empty_list(self):
        out = _normalize_citations_removed({"count": 1})
        assert out == {"count": 1, "reasons": []}


def _shallow_result(
    messages,
    answer: str,
    *,
    escalating: bool = False,
    source_lookup_attempted: bool = True,
    confidence_marker=None,
    escalation_reason: str | None = None,
):
    """A shallow-agent result with every control field set explicitly.

    A bare ``MagicMock`` auto-vivifies every attribute truthy, and the chat
    node reads several of them; setting them all keeps each case on the branch
    it means to exercise.
    """
    result = MagicMock()
    result.messages = list(messages) + [AIMessage(content=answer)]
    result.escalation_requested = escalating
    result.answer_confidence_marker = confidence_marker
    result.answer_confidence_marker_reason = None
    result.answer_escalation_reason = escalation_reason
    result.source_lookup_attempted = source_lookup_attempted
    result.verified_sources = None
    result.citations_removed = None
    result.research_truncated = None
    return result


def _shallow_fn(answer: str, **fields):
    async def shallow(state):
        return _shallow_result(state.messages, answer, **fields)

    return shallow


async def _deep(state):
    result = MagicMock()
    result.messages = list(state.messages) + [AIMessage(content="Deep report.")]
    result.citations_removed = None
    return result


async def _clarifier(state):
    result = MagicMock()
    result.messages = list(getattr(state, "messages", []))
    result.clarifier_log = "log"
    result.plan_rejected = False
    result.plan_cancelled = False
    result.get_approved_plan_context = lambda: ""
    return result


def _agent(shallow_fn=None, *, deep_fn=None, deep_submitter=None):
    """Build a ChatResearcherAgent with trivial async node functions."""
    return ChatResearcherAgent(
        shallow_research_fn=shallow_fn or _shallow_fn("answer"),
        deep_research_fn=deep_fn or _deep,
        clarifier_fn=_clarifier,
        enable_clarifier=False,
        deep_research_job_submitter=deep_submitter,
    )


class TestRoutingDecisionOnTheWire:
    """``routing_decision`` on the terminal state, one case per path."""

    @pytest.mark.asyncio
    async def test_a_direct_reply_is_meta(self):
        agent = _agent(_shallow_fn("Hallo!", source_lookup_attempted=False))
        result = await agent.run(ChatResearcherState(messages=[HumanMessage(content="hallo")]), thread_id="t")
        assert result["routing_decision"] == "meta"

    @pytest.mark.asyncio
    async def test_a_researched_answer_is_shallow(self):
        agent = _agent(_shallow_fn("Antwort [1].", source_lookup_attempted=True))
        result = await agent.run(ChatResearcherState(messages=[HumanMessage(content="Was gilt?")]), thread_id="t")
        assert result["routing_decision"] == "shallow"

    @pytest.mark.asyncio
    async def test_a_graded_answer_without_a_lookup_is_still_shallow(self):
        agent = _agent(_shallow_fn("Antwort.", source_lookup_attempted=False, confidence_marker="low"))
        result = await agent.run(ChatResearcherState(messages=[HumanMessage(content="Was gilt?")]), thread_id="t")
        assert result["routing_decision"] == "shallow"

    @pytest.mark.asyncio
    async def test_an_escalated_turn_is_deep(self):
        agent = _agent(_shallow_fn("Teilantwort.", escalating=True))
        result = await agent.run(ChatResearcherState(messages=[HumanMessage(content="Vergleich?")]), thread_id="t")
        assert result["routing_decision"] == "deep"
        assert result["messages"][-1].content == "Deep report."

    @pytest.mark.asyncio
    async def test_a_failed_shallow_turn_is_error(self):
        async def shallow_raises(state):
            raise RuntimeError("boom")

        agent = _agent(shallow_raises)
        result = await agent.run(ChatResearcherState(messages=[HumanMessage(content="Was gilt?")]), thread_id="t")
        assert result["routing_decision"] == "error"

    @pytest.mark.asyncio
    async def test_a_stale_decision_never_outlives_its_turn(self):
        """Reset at the turn boundary: turn 2's direct reply is not labelled
        with turn 1's research."""
        from langgraph.checkpoint.memory import MemorySaver

        first = _shallow_fn("Antwort [1].", source_lookup_attempted=True)
        second = _shallow_fn("Gern geschehen!", source_lookup_attempted=False)
        agent = ChatResearcherAgent(
            shallow_research_fn=first,
            deep_research_fn=_deep,
            clarifier_fn=None,
            enable_clarifier=False,
            checkpointer=MemorySaver(),
        )
        result = await agent.run(ChatResearcherState(messages=[HumanMessage(content="Was gilt?")]), thread_id="c")
        assert result["routing_decision"] == "shallow"

        agent.shallow_research_fn = second
        result = await agent.run(ChatResearcherState(messages=[HumanMessage(content="danke")]), thread_id="c")
        assert result["routing_decision"] == "meta"


class TestEscalationReasonFor:
    """The clarifier-node reason a shallow answer escalated to deep, or None."""

    def test_structured_shallow_result_reason(self):
        agent = _agent()
        state = ChatResearcherState(
            messages=[HumanMessage(content="q")],
            shallow_result=ShallowResult(
                answer="a",
                confidence="low",
                escalate_to_deep=True,
                escalation_reason="not enough sources",
            ),
        )
        assert agent._escalation_reason_for(state) == "not enough sources"

    def test_keyword_prose_without_marker_yields_none(self):
        # Insufficiency-sounding prose alone never escalates: without the
        # explicit marker there is no escalation and therefore no reason.
        agent = _agent()
        state = ChatResearcherState(
            messages=[
                HumanMessage(content="q"),
                AIMessage(content="Ich konnte keine Informationen dazu finden."),
            ],
        )
        assert agent._escalation_reason_for(state) is None

    def test_no_shallow_result_yields_none(self):
        agent = _agent()
        state = ChatResearcherState(
            messages=[HumanMessage(content="Compare X and Y in detail")],
        )
        assert agent._escalation_reason_for(state) is None

    def test_shallow_result_not_escalating_yields_none(self):
        agent = _agent()
        state = ChatResearcherState(
            messages=[HumanMessage(content="q")],
            shallow_result=ShallowResult(answer="a", confidence="high", escalate_to_deep=False),
        )
        assert agent._escalation_reason_for(state) is None


class TestJobAdmissionRejectedPropagation:
    """The queue-rejection path carries BOTH extras end-to-end through run()."""

    @pytest.mark.asyncio
    async def test_both_fields_propagate(self):
        async def rejecting_submitter(state):
            raise JobAdmissionError("Queue is full, try later", retry_after_seconds=42)

        agent = _agent(_shallow_fn("Teilantwort.", escalating=True), deep_submitter=rejecting_submitter)

        state = ChatResearcherState(messages=[HumanMessage(content="Deep question")])
        result = await agent.run(state, thread_id="t")

        assert result["job_admission_rejected"] is True
        assert result["retry_after_seconds"] == 42
        # The answer text is the rejection notice, not a research answer.
        contents = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert any("Queue is full" in c for c in contents)

    @pytest.mark.asyncio
    async def test_successful_submission_has_no_rejection_fields(self):
        async def ok_submitter(state):
            return "job-123"

        agent = _agent(_shallow_fn("Teilantwort.", escalating=True), deep_submitter=ok_submitter)

        state = ChatResearcherState(messages=[HumanMessage(content="Deep question")])
        result = await agent.run(state, thread_id="t")

        # Absent-when-not-applicable: reset at the turn boundary, never set here.
        assert result.get("job_admission_rejected") is None
        assert result.get("retry_after_seconds") is None
        assert result["deep_research_job_id"] == "job-123"
        assert result["routing_decision"] == "deep"


class TestEscalationReasonEndToEnd:
    """A shallow→deep escalation surfaces escalation_reason on the final state."""

    @pytest.mark.asyncio
    async def test_marker_escalation_surfaces_the_legacy_reason(self):
        async def insufficient_shallow(state):
            return _shallow_result(state.messages, f"Teilantwort [1].\n{ESCALATION_MARKER}", escalating=True)

        agent = _agent(insufficient_shallow)

        state = ChatResearcherState(messages=[HumanMessage(content="Obscure question")])
        result = await agent.run(state, thread_id="t")

        assert result["escalation_reason"] == "Shallow agent emitted insufficiency marker"

    @pytest.mark.asyncio
    async def test_the_envelopes_reason_reaches_the_terminal_state(self):
        """The model's own clause (``answer_escalation_reason`` on the shallow
        state) is what the reader is told, via ``ShallowResult`` and the
        clarifier node — never the fixed string when a real one exists."""
        reason = "Die Frage braucht einen Vergleich über drei Bundesländer."

        async def insufficient_shallow(state):
            return _shallow_result(state.messages, "Teilantwort.", escalating=True, escalation_reason=reason)

        agent = _agent(insufficient_shallow)
        result = await agent.run(ChatResearcherState(messages=[HumanMessage(content="Vergleich?")]), thread_id="t")

        # The structured carrier the clarifier node reads it from...
        assert result["shallow_result"].escalation_reason == reason
        # ...and the terminal extra the frontend narrates.
        assert result["escalation_reason"] == reason

    @pytest.mark.asyncio
    async def test_insufficiency_prose_without_marker_does_not_escalate(self):
        """Regression: German legal hedging in a shallow answer must NOT trigger
        a deep-research escalation — only the explicit marker may."""

        async def hedged_shallow(state):
            # No escalation marker — just prose that the removed keyword
            # fallback would have false-positived on.
            return _shallow_result(
                state.messages,
                "Teilantwort [1]. Weitere Recherche erforderlich, lässt sich nicht finden.",
                escalating=False,
            )

        async def deep(state):
            raise AssertionError("deep research must not run on prose alone")

        agent = _agent(hedged_shallow, deep_fn=deep)

        state = ChatResearcherState(messages=[HumanMessage(content="Obscure question")])
        result = await agent.run(state, thread_id="t")

        assert result.get("escalation_reason") is None
        assert result["routing_decision"] == "shallow"
        contents = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert any("Weitere Recherche erforderlich" in c for c in contents)

    @pytest.mark.asyncio
    async def test_empty_shallow_answer_is_error_not_escalation(self):
        """An empty assistant message is a generation failure: the turn ends
        with a retry-able error message, never a deep-research escalation."""

        async def empty_shallow(state):
            return _shallow_result(state.messages, "", escalating=False)

        async def deep(state):
            raise AssertionError("deep research must not run on an empty answer")

        agent = _agent(empty_shallow, deep_fn=deep)

        state = ChatResearcherState(messages=[HumanMessage(content="Any question")])
        result = await agent.run(state, thread_id="t")

        assert result.get("escalation_reason") is None
        contents = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert any("An error occurred" in c for c in contents)


class TestCitationsRemovedEndToEnd:
    """A populated upstream citations_removed reaches the terminal state."""

    @pytest.mark.asyncio
    async def test_shallow_citations_removed_reaches_state(self):
        async def shallow_with_removed(state):
            # A grounded, non-escalating answer that dropped two unverifiable
            # citations during verification.
            result = _shallow_result(state.messages, "Antwort [1].")
            result.citations_removed = {"count": 2, "reasons": ["url_not_in_registry", "unverifiable"]}
            return result

        agent = _agent(shallow_with_removed)

        state = ChatResearcherState(messages=[HumanMessage(content="Was gilt?")])
        result = await agent.run(state, thread_id="t")

        assert result["citations_removed"] == {"count": 2, "reasons": ["url_not_in_registry", "unverifiable"]}

    @pytest.mark.asyncio
    async def test_absent_citations_removed_stays_none(self):
        agent = _agent(_shallow_fn("Antwort [1]."))

        state = ChatResearcherState(messages=[HumanMessage(content="Was gilt?")])
        result = await agent.run(state, thread_id="t")

        # Reset at the turn boundary, never set → absent (None).
        assert result.get("citations_removed") is None


class TestResearchTruncatedEndToEnd:
    """Truncation is a fact about the ANSWER, so it rides the answer's frame.

    The shallow agent already logs it and emits it as telemetry; neither of
    those can put a line under the answer a person is reading, which is the one
    place "the search stopped before it finished" changes what they do next.
    """

    @pytest.mark.asyncio
    async def test_a_truncated_shallow_turn_reaches_the_terminal_state(self):
        async def shallow_truncated(state):
            result = _shallow_result(state.messages, "Antwort [1].")
            result.research_truncated = True
            return result

        state = ChatResearcherState(messages=[HumanMessage(content="Wie tief ist der Lichteinfall?")])
        result = await _agent(shallow_truncated).run(state, thread_id="t")

        assert result["research_truncated"] is True

    @pytest.mark.asyncio
    async def test_a_complete_turn_carries_no_flag_at_all(self):
        state = ChatResearcherState(messages=[HumanMessage(content="Was gilt?")])
        result = await _agent(_shallow_fn("Antwort [1].")).run(state, thread_id="t")

        # Absent, never False: the note renders on presence, so a False here
        # would be one more default for a reader to interpret.
        assert result.get("research_truncated") is None

    @pytest.mark.asyncio
    async def test_a_shallow_turn_that_escalates_drops_the_flag(self):
        """The deep report replaces this answer, so its budget is not the reader's news."""

        async def shallow_escalating(state):
            result = _shallow_result(state.messages, f"Reicht nicht. {ESCALATION_MARKER}", escalating=True)
            result.research_truncated = True
            return result

        state = ChatResearcherState(messages=[HumanMessage(content="Was gilt?")])
        result = await _agent(shallow_escalating).run(state, thread_id="t")

        assert result.get("research_truncated") is None
