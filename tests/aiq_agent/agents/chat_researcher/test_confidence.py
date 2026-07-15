"""Tests for self-assessed answer-confidence surfacing in the shallow node.

Covers the node-level assembly (`_finalize_shallow_answer`) and end-to-end
propagation through ``ChatResearcherAgent.run()``: the guard caps ungrounded
self-reports, escalation/error branches surface nothing, and the marker is
always stripped from the user-visible text.
"""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.agent import _finalize_shallow_answer
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import DepthDecision
from aiq_agent.agents.chat_researcher.models import IntentResult
from aiq_agent.common.citation_verification import EmptySourceRegistryError


class TestFinalizeShallowAnswer:
    """Node-level assembly of the shallow answer update dict."""

    def test_grounded_high_surfaces_high_and_strips_marker(self):
        msg = AIMessage(content="OIB-Richtlinie 2 [1].\n\n[CONFIDENCE:high]")
        update = _finalize_shallow_answer(msg, citation_grounded=True)
        assert update["answer_confidence"] == "high"
        assert update["shallow_result"] is None
        assert "[CONFIDENCE" not in update["messages"][0].content
        assert update["messages"][0].content == "OIB-Richtlinie 2 [1]."

    def test_ungrounded_high_capped_to_low(self):
        msg = AIMessage(content="Some claim.\n[CONFIDENCE:high]")
        update = _finalize_shallow_answer(msg, citation_grounded=False)
        assert update["answer_confidence"] == "low"
        assert "[CONFIDENCE" not in update["messages"][0].content

    def test_no_marker_surfaces_nothing(self):
        msg = AIMessage(content="A plain answer with no marker.")
        update = _finalize_shallow_answer(msg, citation_grounded=True)
        assert update["answer_confidence"] is None
        assert update["shallow_result"] is None
        assert update["messages"][0].content == "A plain answer with no marker."

    def test_escalation_marker_surfaces_nothing_and_escalates(self):
        msg = AIMessage(content="Partial answer.\n[CONFIDENCE:low]\n[ESCALATE_TO_DEEP]")
        update = _finalize_shallow_answer(msg, citation_grounded=True)
        # Escalation supersedes the shallow answer → no chip.
        assert update["answer_confidence"] is None
        assert update["shallow_result"] is not None
        assert update["shallow_result"].escalate_to_deep is True
        # Both markers stripped from the user-visible text.
        assert "[CONFIDENCE" not in update["messages"][0].content
        assert "[ESCALATE_TO_DEEP]" not in update["messages"][0].content
        assert update["messages"][0].content == "Partial answer."

    def test_non_string_content_passthrough(self):
        msg = AIMessage(content=[{"type": "text", "text": "structured"}])
        update = _finalize_shallow_answer(msg, citation_grounded=True)
        # Non-string content omits the key entirely → no signal downstream.
        assert update.get("answer_confidence") is None
        assert update["shallow_result"] is None


class TestConfidenceEndToEnd:
    """Propagation of answer_confidence through ChatResearcherAgent.run()."""

    @pytest.fixture
    def research_orchestration(self):
        async def classifier(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="shallow", raw_reasoning="simple"),
            }

        return classifier

    @pytest.fixture
    def deep_fn(self):
        async def deep(state):
            result = MagicMock()
            result.messages = list(state.messages) + [AIMessage(content="Deep report.")]
            return result

        return deep

    def _shallow_returning(self, answer: str, *, grounded: bool):
        """Simulate a shallow result WITHOUT structured marker extraction.

        Exercises the back-compat FALLBACK path: the answer text still carries the
        raw markers and ``escalation_requested`` is None (the "not extracted"
        sentinel), so the chat node detects/strips the markers from the string.
        """

        async def shallow(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages) + [AIMessage(content=answer)]
            result.answer_citation_grounded = grounded
            result.escalation_requested = None
            return result

        return shallow

    def _shallow_returning_structured(
        self,
        answer: str,
        *,
        grounded: bool,
        escalation_requested: bool,
        confidence_marker,
    ):
        """Simulate a shallow result WITH structured marker extraction.

        Mirrors the real ShallowResearcherAgent.run(): the answer text is already
        marker-free and the signals arrive on structured state fields.
        """

        async def shallow(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages) + [AIMessage(content=answer)]
            result.answer_citation_grounded = grounded
            result.escalation_requested = escalation_requested
            result.answer_confidence_marker = confidence_marker
            return result

        return shallow

    def _agent(self, research_orchestration, shallow_fn, deep_fn, **kw):
        return ChatResearcherAgent(
            intent_classifier_fn=research_orchestration,
            shallow_research_fn=shallow_fn,
            deep_research_fn=deep_fn,
            clarifier_fn=None,
            enable_clarifier=False,
            **kw,
        )

    @pytest.mark.asyncio
    async def test_grounded_high_surfaces_high(self, research_orchestration, deep_fn):
        shallow = self._shallow_returning("OIB 2 [1].\n[CONFIDENCE:high]", grounded=True)
        agent = self._agent(research_orchestration, shallow, deep_fn, enable_escalation=False)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="t1")
        assert result["answer_confidence"] == "high"
        assert "[CONFIDENCE" not in result["messages"][-1].content

    @pytest.mark.asyncio
    async def test_ungrounded_high_capped_to_low(self, research_orchestration, deep_fn):
        shallow = self._shallow_returning("Claim without grounding.\n[CONFIDENCE:high]", grounded=False)
        agent = self._agent(research_orchestration, shallow, deep_fn, enable_escalation=False)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="t2")
        assert result["answer_confidence"] == "low"

    @pytest.mark.asyncio
    async def test_no_marker_surfaces_nothing(self, research_orchestration, deep_fn):
        shallow = self._shallow_returning("A grounded answer [1].", grounded=True)
        agent = self._agent(research_orchestration, shallow, deep_fn, enable_escalation=False)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="t3")
        assert result.get("answer_confidence") is None

    @pytest.mark.asyncio
    async def test_escalation_branch_surfaces_nothing(self, research_orchestration, deep_fn):
        # Shallow emits the escalation marker → escalates to deep; no chip.
        shallow = self._shallow_returning("Partial.\n[CONFIDENCE:high]\n[ESCALATE_TO_DEEP]", grounded=True)
        agent = self._agent(research_orchestration, shallow, deep_fn, enable_escalation=True)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="t4")
        assert result.get("answer_confidence") is None
        assert result["messages"][-1].content == "Deep report."

    @pytest.mark.asyncio
    async def test_generic_error_branch_surfaces_nothing(self, research_orchestration, deep_fn):
        async def shallow_raises(state_input):
            raise RuntimeError("boom")

        agent = self._agent(research_orchestration, shallow_raises, deep_fn, enable_escalation=False)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="t5")
        assert result.get("answer_confidence") is None

    @pytest.mark.asyncio
    async def test_empty_source_registry_error_surfaces_nothing(self, research_orchestration, deep_fn):
        async def shallow_raises(state_input):
            raise EmptySourceRegistryError("shallow research")

        agent = self._agent(research_orchestration, shallow_raises, deep_fn, enable_escalation=False)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="t6")
        assert result.get("answer_confidence") is None

    @pytest.mark.asyncio
    async def test_structured_signals_grounded_high_surfaces_high(self, research_orchestration, deep_fn):
        # Answer text already clean; confidence arrives as a structured field.
        shallow = self._shallow_returning_structured(
            "OIB 2 [1].", grounded=True, escalation_requested=False, confidence_marker="high"
        )
        agent = self._agent(research_orchestration, shallow, deep_fn, enable_escalation=False)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="s1")
        assert result["answer_confidence"] == "high"
        assert "[CONFIDENCE" not in result["messages"][-1].content

    @pytest.mark.asyncio
    async def test_structured_signals_ungrounded_high_capped_to_low(self, research_orchestration, deep_fn):
        shallow = self._shallow_returning_structured(
            "Claim.", grounded=False, escalation_requested=False, confidence_marker="high"
        )
        agent = self._agent(research_orchestration, shallow, deep_fn, enable_escalation=False)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="s2")
        assert result["answer_confidence"] == "low"

    @pytest.mark.asyncio
    async def test_structured_signals_escalation_surfaces_nothing(self, research_orchestration, deep_fn):
        shallow = self._shallow_returning_structured(
            "Partial.", grounded=True, escalation_requested=True, confidence_marker="high"
        )
        agent = self._agent(research_orchestration, shallow, deep_fn, enable_escalation=True)
        state = ChatResearcherState(messages=[HumanMessage(content="Frage?")])
        result = await agent.run(state, thread_id="s3")
        assert result.get("answer_confidence") is None
        assert result["messages"][-1].content == "Deep report."
