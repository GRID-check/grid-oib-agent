"""Tests for self-assessed answer-confidence surfacing in the researcher.

Covers the node-level assembly (`_finalize_answer`) and end-to-end
propagation through ``ConversationGraph.run()``: the guard caps ungrounded
self-reports, escalation/error branches surface nothing, and a control marker
left in the text is always stripped from the user-visible answer.

The signals are the researcher's structured state fields
(``escalation_requested``, ``answer_confidence_marker``, ...) — the model is
the contract; nothing here is re-parsed from the answer text.
"""

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.researcher.conversation import ConversationGraph
from aiq_agent.agents.researcher.conversation import _finalize_answer
from aiq_agent.agents.researcher.models import ConversationState
from aiq_agent.agents.researcher.models import ResearchAgentState
from aiq_agent.common.citation_verification import EmptySourceRegistryError


def _signals(**fields) -> ResearchAgentState:
    """A researcher state carrying just the signals a test names."""
    fields.setdefault("escalation_requested", False)
    return ResearchAgentState(messages=[], **fields)


class TestFinalizeAnswer:
    """Node-level assembly of the answer update dict."""

    def test_grounded_high_surfaces_high_and_strips_a_leaked_marker(self):
        msg = AIMessage(content="OIB-Richtlinie 2 [1].\n\n[CONFIDENCE:high]")
        update = _finalize_answer(msg, _signals(answer_citation_grounded=True, answer_confidence_marker="high"))
        assert update["answer_confidence"] == "high"
        assert update["escalate_to_deep"] is False
        assert update["messages"][0].content == "OIB-Richtlinie 2 [1]."

    def test_ungrounded_high_capped_to_low(self):
        update = _finalize_answer(AIMessage(content="Some claim."), _signals(answer_confidence_marker="high"))
        assert update["answer_confidence"] == "low"
        assert update["answer_confidence_capped_reason"] == "ungrounded"

    def test_no_marker_surfaces_nothing(self):
        msg = AIMessage(content="A plain answer with no marker.")
        update = _finalize_answer(msg, _signals(answer_citation_grounded=True))
        assert update["answer_confidence"] is None
        assert update["escalate_to_deep"] is False
        assert update["messages"][0].content == "A plain answer with no marker."

    def test_escalation_surfaces_nothing_and_escalates(self):
        msg = AIMessage(content="Partial answer.\n[CONFIDENCE:low]\n[ESCALATE_TO_DEEP]")
        update = _finalize_answer(
            msg, _signals(escalation_requested=True, answer_citation_grounded=True, answer_confidence_marker="low")
        )
        # Escalation supersedes the shallow answer → no chip. The key is
        # ABSENT rather than None: every turn-scoped field is already at its
        # default when the node runs, so the hand-off writes only the ask.
        assert "answer_confidence" not in update
        assert update["escalate_to_deep"] is True
        # Both markers stripped from the user-visible text.
        assert update["messages"][0].content == "Partial answer."

    def test_non_string_content_passthrough(self):
        msg = AIMessage(content=[{"type": "text", "text": "structured"}])
        update = _finalize_answer(msg, _signals(answer_citation_grounded=True))
        # Non-string content omits every key → no signal downstream.
        assert update.get("answer_confidence") is None
        assert "escalate_to_deep" not in update

    def test_the_reason_rides_with_the_level(self):
        update = _finalize_answer(
            AIMessage(content="OIB 2 [1]."),
            _signals(
                answer_citation_grounded=True,
                answer_confidence_marker="medium",
                answer_confidence_marker_reason="Keine Quelle zur Sonderregel",
            ),
        )
        assert update["answer_confidence"] == "medium"
        assert update["answer_confidence_reason"] == "Keine Quelle zur Sonderregel"

    def test_escalation_drops_reason(self):
        update = _finalize_answer(
            AIMessage(content="Partial."),
            _signals(
                escalation_requested=True, answer_confidence_marker="high", answer_confidence_marker_reason="Grund"
            ),
        )
        assert "answer_confidence" not in update
        assert "answer_confidence_reason" not in update

    def test_an_empty_answer_is_an_error_turn(self):
        update = _finalize_answer(AIMessage(content="  \n[CONFIDENCE:high]"), _signals())
        assert update["routing_decision"] == "error"
        assert update["escalate_to_deep"] is False
        assert "An error occurred" in update["messages"][0].content


class TestConfidenceEndToEnd:
    """Propagation of answer_confidence through ConversationGraph.run()."""

    @pytest.fixture
    def deep_fn(self):
        async def deep(state):
            return DeepResearchAgentState(messages=list(state.messages) + [AIMessage(content="Deep report.")])

        return deep

    def _research_returning(
        self,
        answer: str,
        *,
        grounded: bool,
        escalation_requested: bool = False,
        confidence_marker=None,
        confidence_reason: str | None = None,
    ):
        """The real researcher state: the answer text is already marker-free and
        the signals arrive on structured fields, as ``ResearcherAgent.run()`` sets them."""

        async def research(state_input):
            return ResearchAgentState(
                messages=list(state_input.messages) + [AIMessage(content=answer)],
                answer_citation_grounded=grounded,
                escalation_requested=escalation_requested,
                answer_confidence_marker=confidence_marker,
                answer_confidence_marker_reason=confidence_reason,
            )

        return research

    def _agent(self, research_fn, deep_fn, **kw):
        return ConversationGraph(
            research_fn=research_fn,
            deep_research_fn=deep_fn,
            clarifier_fn=None,
            **kw,
        )

    async def _run(self, research, deep_fn, thread_id: str) -> ConversationState:
        agent = self._agent(research, deep_fn)
        return await agent.run(ConversationState(messages=[HumanMessage(content="Frage?")]), thread_id=thread_id)

    @pytest.mark.asyncio
    async def test_grounded_high_surfaces_high(self, deep_fn):
        result = await self._run(
            self._research_returning("OIB 2 [1].", grounded=True, confidence_marker="high"), deep_fn, "t1"
        )
        assert result.answer_confidence == "high"

    @pytest.mark.asyncio
    async def test_ungrounded_high_capped_to_low(self, deep_fn):
        result = await self._run(
            self._research_returning("Claim.", grounded=False, confidence_marker="high"), deep_fn, "t2"
        )
        assert result.answer_confidence == "low"

    @pytest.mark.asyncio
    async def test_no_marker_surfaces_nothing(self, deep_fn):
        result = await self._run(self._research_returning("A grounded answer [1].", grounded=True), deep_fn, "t3")
        assert result.answer_confidence is None

    @pytest.mark.asyncio
    async def test_escalation_branch_surfaces_nothing(self, deep_fn):
        research = self._research_returning(
            "Partial.", grounded=True, escalation_requested=True, confidence_marker="high"
        )
        result = await self._run(research, deep_fn, "t4")
        assert result.answer_confidence is None
        assert result.messages[-1].content == "Deep report."

    @pytest.mark.asyncio
    async def test_generic_error_branch_surfaces_nothing(self, deep_fn):
        async def research_raises(state_input):
            raise RuntimeError("boom")

        result = await self._run(research_raises, deep_fn, "t5")
        assert result.answer_confidence is None
        assert result.routing_decision == "error"

    @pytest.mark.asyncio
    async def test_empty_source_registry_error_surfaces_nothing(self, deep_fn):
        async def research_raises(state_input):
            raise EmptySourceRegistryError("research")

        result = await self._run(research_raises, deep_fn, "t6")
        assert result.answer_confidence is None

    @pytest.mark.asyncio
    async def test_a_leaked_text_marker_is_stripped_but_not_read(self, deep_fn):
        """The text is not a signal channel: a marker the researcher failed
        to strip is removed from the answer, and the level comes from the
        structured field only."""
        research = self._research_returning("Teilantwort.\n[CONFIDENCE:medium | aus dem Text]", grounded=True)
        result = await self._run(research, deep_fn, "s5")
        assert result.answer_confidence is None
        assert "[CONFIDENCE" not in result.messages[-1].content

    @pytest.mark.asyncio
    async def test_structured_reason_reaches_state(self, deep_fn):
        research = self._research_returning(
            "OIB 2 [1].", grounded=True, confidence_marker="high", confidence_reason="Direkt durch OIB-RL 2 belegt"
        )
        result = await self._run(research, deep_fn, "s4")
        assert result.answer_confidence == "high"
        assert result.answer_confidence_reason == "Direkt durch OIB-RL 2 belegt"

    @pytest.mark.asyncio
    async def test_escalation_drops_reason(self, deep_fn):
        research = self._research_returning(
            "Partial.",
            grounded=True,
            escalation_requested=True,
            confidence_marker="high",
            confidence_reason="irrelevant",
        )
        result = await self._run(research, deep_fn, "s6")
        assert result.answer_confidence is None
        assert result.answer_confidence_reason is None

    @pytest.mark.asyncio
    async def test_capped_confidence_keeps_model_reason(self, deep_fn):
        # The guard caps the level but the model's reason still surfaces (it
        # describes the raw self-assessment; the cap note explains the level).
        research = self._research_returning(
            "Claim.", grounded=False, confidence_marker="high", confidence_reason="Modell hält es für belegt"
        )
        result = await self._run(research, deep_fn, "s7")
        assert result.answer_confidence == "low"
        assert result.answer_confidence_capped_reason == "ungrounded"
        assert result.answer_confidence_reason == "Modell hält es für belegt"
