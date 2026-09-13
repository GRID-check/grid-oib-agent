"""The digest across the turn boundary: persist, lift, forward.

The digest is conversation-scoped (same lifetime as ``messages``): the
checkpoint carries it, the research input threads it into the answering state,
and the finished answer lifts it back out. A turn that digests nothing must
not wipe the checkpointed lines.
"""

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from aiq_agent.agents.piloti.conversation import ANSWER_LIFTS
from aiq_agent.agents.piloti.conversation import CONVERSATION_SCOPED_FIELDS
from aiq_agent.agents.piloti.conversation import TURN_SCOPED_FIELDS
from aiq_agent.agents.piloti.conversation import ConversationGraph
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.agents.piloti.models import ResearchAgentState

DIGEST = ["oib-rl_2_ausgabe_mai_2023.pdf | oib_knowledge | Seiten 12 | Punkte 3.5.2 | Turn 1"]


def _answer(messages, text: str, **fields) -> ResearchAgentState:
    return ResearchAgentState(
        messages=list(messages) + [AIMessage(content=text)],
        escalation_requested=False,
        source_lookup_attempted=True,
        **fields,
    )


async def _unused(state):  # pragma: no cover - the route never reaches it
    raise AssertionError("must not be called")


class TestDigestIsConversationScoped:
    def test_the_field_exists_and_is_plain_strings(self):
        assert "already_read_digest" in ConversationState.model_fields
        state = ConversationState(messages=[], already_read_digest=list(DIGEST))
        assert state.already_read_digest == DIGEST
        assert ConversationState.model_validate(state.model_dump()).already_read_digest == DIGEST

    def test_it_survives_the_turn_boundary_like_messages(self):
        assert "already_read_digest" in CONVERSATION_SCOPED_FIELDS
        assert "already_read_digest" not in TURN_SCOPED_FIELDS

    def test_it_is_lifted_on_both_halves(self):
        assert ("already_read_digest", "already_read_digest") in ANSWER_LIFTS
        assert hasattr(ResearchAgentState(messages=[]), "already_read_digest")
        assert "already_read_digest" in ConversationState.model_fields


class TestDigestTravelsTheGraph:
    @pytest.mark.asyncio
    async def test_the_research_input_forwards_the_checkpointed_digest(self):
        seen: list = []

        async def research(state_input):
            seen.append(state_input.already_read_digest)
            return _answer(state_input.messages, "Antwort.", already_read_digest=state_input.already_read_digest)

        agent = ConversationGraph(
            research_fn=research, deep_research_fn=_unused, clarifier_fn=None, checkpointer=MemorySaver()
        )
        thread = "digest-forward"

        await agent.run(ConversationState(messages=[HumanMessage(content="Was gilt?")]), thread_id=thread)
        assert seen == [None]

        agent.research_fn = _digest_answering(DIGEST)
        await agent.run(ConversationState(messages=[HumanMessage(content="Und weiter?")]), thread_id=thread)

        async def capturing(state_input):
            seen.append(state_input.already_read_digest)
            return _answer(state_input.messages, "Antwort.")

        agent.research_fn = capturing
        await agent.run(ConversationState(messages=[HumanMessage(content="Und noch?")]), thread_id=thread)

        assert seen[-1] == DIGEST

    @pytest.mark.asyncio
    async def test_a_turn_that_digests_nothing_keeps_the_lines(self):
        agent = ConversationGraph(
            research_fn=_digest_answering(DIGEST),
            deep_research_fn=_unused,
            clarifier_fn=None,
            checkpointer=MemorySaver(),
        )
        thread = "digest-persist"

        first = await agent.run(ConversationState(messages=[HumanMessage(content="Was gilt?")]), thread_id=thread)
        assert first.already_read_digest == DIGEST

        agent.research_fn = _plain_answering("Gern geschehen!")
        second = await agent.run(ConversationState(messages=[HumanMessage(content="danke")]), thread_id=thread)

        assert second.already_read_digest == DIGEST

    @pytest.mark.asyncio
    async def test_an_escalated_turn_keeps_the_digest_for_the_next_turn(self):
        async def escalating(state_input):
            return ResearchAgentState(
                messages=list(state_input.messages) + [AIMessage(content="Teilantwort.")],
                escalation_requested=True,
                answer_escalation_reason="zu breit",
                source_lookup_attempted=True,
                already_read_digest=list(DIGEST),
            )

        async def deep(state):
            from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState

            return DeepResearchAgentState(messages=list(state.messages) + [AIMessage(content="Bericht.")])

        async def clarifier(request):
            from aiq_agent.agents.piloti.models import ClarifyResult

            return ClarifyResult(research_context="Kontext", outcome="approved")

        agent = ConversationGraph(research_fn=escalating, deep_research_fn=deep, clarifier_fn=clarifier)
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Vergleich?")]))

        assert result.already_read_digest == DIGEST


def _digest_answering(digest):
    async def research(state_input):
        return _answer(state_input.messages, "Antwort.", already_read_digest=list(digest))

    return research


def _plain_answering(text):
    async def research(state_input):
        return _answer(state_input.messages, text)

    return research
