"""A conversation that was mid-flight when the deploy landed keeps working.

The checkpointer is the one piece of this graph that outlives a release: it
holds the message history and the reader's standing refusal of a research plan,
written by whatever version of the graph ran last. This turn's graph dropped a
channel (``shallow_result``, a custom pydantic type that carried one boolean)
and added two plain ones. These tests run the old graph against a real SQLite
checkpointer, then run the NEW graph on the same thread, and pin what survives.
"""

import os
import tempfile
from typing import Any

import aiosqlite
import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END
from langgraph.graph import StateGraph
from pydantic import BaseModel

from aiq_agent.agents.shallow_researcher.conversation import ConversationGraph
from aiq_agent.agents.shallow_researcher.models import ConversationState
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import _build_checkpointer_serde

THREAD = "conversation-across-the-deploy"


class _RetiredShallowResult(BaseModel):
    """``ShallowResult`` as the old graph wrote it into the checkpoint."""

    answer: str
    escalate_to_deep: bool
    escalation_reason: str | None = None


class _LegacyState(ConversationState):
    """The old conversation state: today's, plus the channel that was retired."""

    shallow_result: _RetiredShallowResult | None = None


def _legacy_graph(checkpointer):
    """The old graph, reduced to what it wrote: an answer and a shallow_result."""

    async def shallow_research(state: _LegacyState) -> dict[str, Any]:
        return {
            "messages": [AIMessage(content="Die alte Antwort.")],
            "routing_decision": "shallow",
            "shallow_result": _RetiredShallowResult(answer="Die alte Antwort.", escalate_to_deep=False),
            "deep_research_declined": True,
        }

    graph = StateGraph(_LegacyState)
    graph.add_node("shallow_research", shallow_research)
    graph.set_entry_point("shallow_research")
    graph.add_edge("shallow_research", END)
    return graph.compile(checkpointer=checkpointer)


async def _unused(state):  # pragma: no cover - the escalation route is suppressed
    raise AssertionError("must not be called")


async def _answering(state: ShallowResearchAgentState) -> ShallowResearchAgentState:
    return ShallowResearchAgentState(
        messages=list(state.messages) + [AIMessage(content="Die neue Antwort.")],
        source_lookup_attempted=True,
        escalation_requested=False,
    )


@pytest.fixture
async def checkpointer():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as handle:
        db_path = handle.name
    conn = await aiosqlite.connect(db_path)
    try:
        saver = AsyncSqliteSaver(conn, serde=_build_checkpointer_serde())
        await saver.setup()
        yield saver
    finally:
        await conn.close()
        os.unlink(db_path)


@pytest.mark.asyncio
async def test_the_next_turn_after_the_deploy_answers_on_the_old_history(checkpointer):
    """The history is the point of the checkpoint, and it crosses intact."""
    await _legacy_graph(checkpointer).ainvoke(
        {"messages": [HumanMessage(content="Was gilt für Brüstungen?")]},
        config={"configurable": {"thread_id": THREAD}},
    )

    agent = ConversationGraph(
        shallow_research_fn=_answering, deep_research_fn=_unused, clarifier_fn=None, checkpointer=checkpointer
    )
    result = await agent.run(ConversationState(messages=[HumanMessage(content="Und im Keller?")]), thread_id=THREAD)

    assert [message.content for message in result.messages] == [
        "Was gilt für Brüstungen?",
        "Die alte Antwort.",
        "Und im Keller?",
        "Die neue Antwort.",
    ]
    assert result.routing_decision == "shallow"


@pytest.mark.asyncio
async def test_a_refusal_recorded_by_the_old_graph_is_still_honoured(checkpointer):
    """``deep_research_declined`` is the conversation's memory of a "no", and it
    is a plain bool on both sides: a reader who declined a plan before the
    deploy is not asked again after it."""
    await _legacy_graph(checkpointer).ainvoke(
        {"messages": [HumanMessage(content="Vergleich über drei Bundesländer?")]},
        config={"configurable": {"thread_id": THREAD}},
    )

    async def escalating(state: ShallowResearchAgentState) -> ShallowResearchAgentState:
        return ShallowResearchAgentState(
            messages=list(state.messages) + [AIMessage(content="Teilantwort.")],
            escalation_requested=True,
            answer_escalation_reason="zu breit",
        )

    agent = ConversationGraph(
        shallow_research_fn=escalating, deep_research_fn=_unused, clarifier_fn=_unused, checkpointer=checkpointer
    )
    result = await agent.run(ConversationState(messages=[HumanMessage(content="Und jetzt?")]), thread_id=THREAD)

    assert result.deep_research_declined is True
    assert result.escalate_to_deep is True, "the ask is recorded"
    assert result.escalation_reason is None, "but no hand-off happened, so nothing narrates one"
    assert result.messages[-1].content == "Teilantwort."
