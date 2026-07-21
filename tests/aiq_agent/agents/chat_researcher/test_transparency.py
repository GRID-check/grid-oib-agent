"""Tests for the transparency extras (WP-A) populated by the chat_researcher.

Covers the pure derivation helpers (routing decision, capped-confidence reason,
citations-removed normalization, escalation reason) and their end-to-end
propagation through ``ChatResearcherAgent.run()`` — including the
``JobAdmissionError`` queue-rejection path that carries both
``job_admission_rejected`` and ``retry_after_seconds``.

Every extra follows the same rule: present when applicable, absent (never
null-spammed) otherwise.
"""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.agent import ESCALATION_KEYWORD_REASON
from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.agent import _normalize_citations_removed
from aiq_agent.agents.chat_researcher.agent import answer_confidence_capped_reason
from aiq_agent.agents.chat_researcher.agent import derive_routing_decision
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import DepthDecision
from aiq_agent.agents.chat_researcher.models import IntentResult
from aiq_agent.agents.chat_researcher.models import ShallowResult
from aiq_agent.common.job_admission import JobAdmissionError


class _Intent:
    def __init__(self, intent):
        self.intent = intent


class _Depth:
    def __init__(self, decision):
        self.decision = decision


class TestDeriveRoutingDecision:
    """Which path the turn took after intent classification."""

    def test_error_intent_wins(self):
        assert derive_routing_decision(_Intent("error"), _Depth("deep")) == "error"

    def test_meta_intent_wins_over_deep_depth(self):
        assert derive_routing_decision(_Intent("meta"), _Depth("deep")) == "meta"

    def test_research_deep(self):
        assert derive_routing_decision(_Intent("research"), _Depth("deep")) == "deep"

    def test_research_shallow(self):
        assert derive_routing_decision(_Intent("research"), _Depth("shallow")) == "shallow"

    def test_research_without_depth_defaults_shallow(self):
        assert derive_routing_decision(_Intent("research"), None) == "shallow"

    def test_no_intent_yields_none(self):
        # No classification ran → nothing to surface.
        assert derive_routing_decision(None, None) is None
        assert derive_routing_decision(_Intent(None), _Depth("deep")) is None


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


def _agent(*, enable_escalation=True, deep_submitter=None):
    """Build a ChatResearcherAgent with trivial async node functions."""

    async def classifier(state):
        return {"user_intent": IntentResult(intent="research", raw=None)}

    async def shallow(state):
        result = MagicMock()
        result.messages = [AIMessage(content="answer")]
        return result

    async def deep(state):
        result = MagicMock()
        result.messages = [AIMessage(content="report")]
        return result

    async def clarifier(state):
        result = MagicMock()
        result.messages = list(getattr(state, "messages", []))
        result.clarifier_log = "log"
        result.plan_rejected = False
        result.get_approved_plan_context = lambda: ""
        return result

    return ChatResearcherAgent(
        intent_classifier_fn=classifier,
        shallow_research_fn=shallow,
        deep_research_fn=deep,
        clarifier_fn=clarifier,
        enable_escalation=enable_escalation,
        enable_clarifier=False,
        deep_research_job_submitter=deep_submitter,
    )


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

    def test_keyword_fallback_fixed_german_string(self):
        agent = _agent()
        state = ChatResearcherState(
            messages=[
                HumanMessage(content="q"),
                AIMessage(content="Ich konnte keine Informationen dazu finden."),
            ],
        )
        assert agent._escalation_reason_for(state) == ESCALATION_KEYWORD_REASON

    def test_direct_deep_no_shallow_no_keyword_yields_none(self):
        agent = _agent()
        state = ChatResearcherState(
            messages=[HumanMessage(content="Compare X and Y in detail")],
        )
        assert agent._escalation_reason_for(state) is None

    def test_disabled_escalation_yields_none(self):
        agent = _agent(enable_escalation=False)
        state = ChatResearcherState(
            messages=[
                HumanMessage(content="q"),
                AIMessage(content="Ich konnte keine Informationen dazu finden."),
            ],
        )
        assert agent._escalation_reason_for(state) is None

    def test_meta_turn_yields_none(self):
        agent = _agent()
        state = ChatResearcherState(
            messages=[
                HumanMessage(content="q"),
                AIMessage(content="Ich konnte keine Informationen dazu finden."),
            ],
            user_intent=IntentResult(intent="meta", raw=None),
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
        async def deep_orchestration(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="deep", raw_reasoning="Complex"),
            }

        async def rejecting_submitter(state):
            raise JobAdmissionError("Queue is full, try later", retry_after_seconds=42)

        agent = _agent(deep_submitter=rejecting_submitter)
        agent.intent_classifier_fn = deep_orchestration

        state = ChatResearcherState(messages=[HumanMessage(content="Deep question")])
        result = await agent.run(state, thread_id="t")

        assert result["job_admission_rejected"] is True
        assert result["retry_after_seconds"] == 42
        # The answer text is the rejection notice, not a research answer.
        contents = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert any("Queue is full" in c for c in contents)

    @pytest.mark.asyncio
    async def test_successful_submission_has_no_rejection_fields(self):
        async def deep_orchestration(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="deep", raw_reasoning="Complex"),
            }

        async def ok_submitter(state):
            return "job-123"

        agent = _agent(deep_submitter=ok_submitter)
        agent.intent_classifier_fn = deep_orchestration

        state = ChatResearcherState(messages=[HumanMessage(content="Deep question")])
        result = await agent.run(state, thread_id="t")

        # Absent-when-not-applicable: reset at the turn boundary, never set here.
        assert result.get("job_admission_rejected") is None
        assert result.get("retry_after_seconds") is None
        assert result["deep_research_job_id"] == "job-123"


class TestEscalationReasonEndToEnd:
    """A shallow→deep escalation surfaces escalation_reason on the final state."""

    @pytest.mark.asyncio
    async def test_keyword_escalation_surfaces_reason(self):
        async def shallow_orchestration(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="shallow", raw_reasoning="Simple"),
            }

        async def insufficient_shallow(state):
            result = MagicMock()
            # No structured escalation signal → keyword tail-match drives escalation.
            result.messages = list(state.messages) + [
                AIMessage(content="Ich konnte keine Informationen gefunden."),
            ]
            result.escalation_requested = None
            result.answer_confidence_marker = None
            result.verified_sources = None
            result.citations_removed = None
            return result

        async def deep(state):
            result = MagicMock()
            result.messages = list(state.messages) + [AIMessage(content="Deep report.")]
            result.citations_removed = None
            return result

        async def clarifier(state):
            result = MagicMock()
            result.messages = list(getattr(state, "messages", []))
            result.clarifier_log = "log"
            result.plan_rejected = False
            result.get_approved_plan_context = lambda: ""
            return result

        agent = ChatResearcherAgent(
            intent_classifier_fn=shallow_orchestration,
            shallow_research_fn=insufficient_shallow,
            deep_research_fn=deep,
            clarifier_fn=clarifier,
            enable_escalation=True,
            enable_clarifier=False,
        )

        state = ChatResearcherState(messages=[HumanMessage(content="Obscure question")])
        result = await agent.run(state, thread_id="t")

        assert result["escalation_reason"] == ESCALATION_KEYWORD_REASON
