"""Withdrawing deep research from a tenant that does not have the flag.

The defect these guard: `FEATURE_FLAGS.deepResearch` was read in exactly one
place, the `submit` branch of the async-jobs route. That closes the job queue,
and nothing upstream of it knew the flag — so the agent still escalated, the
clarifier still put a plan in front of the reader, and the approval button
answered 403. The feature was disabled and still advertised.

The seam that matters is `_finalize_answer`, not the routing edge: by the time
the edge runs, `_escalation_update` has already replaced the message with the
ASK and dropped everything the answer knew about itself. Suppressing there ends
the turn on a promise. So the tests below care about two things at once —
that no hand-off happens, and that the reader is left holding an answer.
"""

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.piloti.conversation import DEEP_RESEARCH_UNAVAILABLE_NOTE
from aiq_agent.agents.piloti.conversation import ConversationGraph
from aiq_agent.agents.piloti.conversation import _finalize_answer
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.agents.piloti.models import ResearchAgentState


def _signals(**fields) -> ResearchAgentState:
    fields.setdefault("escalation_requested", True)
    return ResearchAgentState(messages=[], **fields)


class TestFinalizeAnswerWithoutDeepResearch:
    def test_the_partial_answer_survives_and_says_no_run_is_coming(self):
        """The insufficiency case: the prompt asks for the best partial answer
        alongside the ask, so there is something to keep."""
        update = _finalize_answer(
            AIMessage(content="Nach OIB 2 gilt X [1]."),
            _signals(answer_citation_grounded=True),
            deep_research_allowed=False,
        )

        assert update["escalate_to_deep"] is False
        assert update["messages"][0].content.startswith("Nach OIB 2 gilt X [1].")
        assert DEEP_RESEARCH_UNAVAILABLE_NOTE in update["messages"][0].content
        # It is an ANSWER now, so it carries what an answer carries.
        assert "answer_confidence" in update

    def test_a_bare_hand_off_sentence_becomes_the_note_rather_than_a_promise(self):
        """The commissioned case taken to its limit: the model wrote nothing but
        the hand-off. Left alone this turn ends on 'Dafür starte ich eine
        Tiefenrecherche' with nothing behind it."""
        update = _finalize_answer(AIMessage(content="   "), _signals(), deep_research_allowed=False)

        assert update["escalate_to_deep"] is False
        assert update["messages"][0].content == DEEP_RESEARCH_UNAVAILABLE_NOTE
        # Emphatically not the error branch: nothing failed.
        assert update.get("routing_decision") != "error"

    def test_an_empty_answer_with_no_ask_is_still_an_error_turn(self):
        """The guard must not turn a generation failure into a polite note."""
        update = _finalize_answer(
            AIMessage(content="   "), _signals(escalation_requested=False), deep_research_allowed=False
        )

        assert update["routing_decision"] == "error"

    def test_an_answer_that_never_asked_is_untouched(self):
        update = _finalize_answer(
            AIMessage(content="Eine direkte Antwort."),
            _signals(escalation_requested=False),
            deep_research_allowed=False,
        )

        assert update["messages"][0].content == "Eine direkte Antwort."
        assert DEEP_RESEARCH_UNAVAILABLE_NOTE not in update["messages"][0].content

    def test_a_tenant_with_the_flag_still_escalates(self):
        update = _finalize_answer(AIMessage(content="Partial."), _signals(), deep_research_allowed=True)

        assert update["escalate_to_deep"] is True
        assert DEEP_RESEARCH_UNAVAILABLE_NOTE not in update["messages"][0].content

    def test_allowed_is_the_default_so_no_caller_withdraws_it_by_forgetting(self):
        assert _finalize_answer(AIMessage(content="Partial."), _signals())["escalate_to_deep"] is True


class TestShouldEscalate:
    """The backstop on the only door into the clarifier."""

    def test_the_bit_set_without_the_capability_ends_the_turn(self):
        state = ConversationState(messages=[], escalate_to_deep=True, deep_research_allowed=False)
        assert ConversationGraph._should_escalate(state) == "END"

    def test_the_bit_set_with_the_capability_routes(self):
        state = ConversationState(messages=[], escalate_to_deep=True, deep_research_allowed=True)
        assert ConversationGraph._should_escalate(state) == "deep_research"


class TestEndToEnd:
    """Through the compiled graph: the hand-off never runs."""

    @pytest.fixture
    def deep_fn(self):
        async def deep(state):
            deep.ran = True
            return DeepResearchAgentState(messages=list(state.messages) + [AIMessage(content="Deep report.")])

        deep.ran = False
        return deep

    def _research_asking_to_escalate(self, answer: str, seen: dict):
        async def research(state_input):
            seen["deep_research_allowed"] = state_input.deep_research_allowed
            return ResearchAgentState(
                messages=list(state_input.messages) + [AIMessage(content=answer)],
                escalation_requested=True,
                answer_citation_grounded=True,
            )

        return research

    async def _run(self, research, deep_fn, thread_id: str, *, allowed: bool) -> ConversationState:
        graph = ConversationGraph(research_fn=research, deep_research_fn=deep_fn, clarifier_fn=None)
        state = ConversationState(
            messages=[HumanMessage(content="Erstell mir einen Bericht.")],
            deep_research_allowed=allowed,
        )
        return await graph.run(state, thread_id=thread_id)

    @pytest.mark.asyncio
    async def test_no_flag_means_no_hand_off_and_an_answer_instead(self, deep_fn):
        seen: dict = {}
        result = await self._run(
            self._research_asking_to_escalate("Soweit die Quellen tragen: X [1].", seen),
            deep_fn,
            "gate-1",
            allowed=False,
        )

        assert deep_fn.ran is False, "deep research ran for a tenant that does not have it"
        assert result.messages[-1].content != "Deep report."
        assert DEEP_RESEARCH_UNAVAILABLE_NOTE in result.messages[-1].content
        assert result.escalate_to_deep is False
        # It reached the agent too, which is what lets the prompt say so before
        # the model ever writes the ask.
        assert seen["deep_research_allowed"] is False

    @pytest.mark.asyncio
    async def test_the_flag_still_reaches_deep_research(self, deep_fn):
        seen: dict = {}
        result = await self._run(
            self._research_asking_to_escalate("Partial.", seen), deep_fn, "gate-2", allowed=True
        )

        assert deep_fn.ran is True
        assert result.messages[-1].content == "Deep report."
        assert seen["deep_research_allowed"] is True
