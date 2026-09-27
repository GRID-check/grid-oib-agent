"""Tests for Piloti's conversation graph."""

from aiq_agent.agents.piloti.models import ConversationState


async def turn(graph, state: ConversationState, thread_id: str | None = None) -> ConversationState:
    """One turn through ``graph.stream``, its wire bodies dropped: the final state."""
    final = None
    async for item in graph.stream(state, thread_id=thread_id):
        final = item
    assert isinstance(final, ConversationState)
    return final
