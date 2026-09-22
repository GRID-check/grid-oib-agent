"""The model's transcript carries a tool result without its ``## Trace-Lanes`` line.

Through the compiled graph, because the strip sits in the tools node between
two readers that must see different bytes: the source capture, which files the
hits under the bytes the tool returned, runs BEFORE it; the transcript the
model reads on its next call, the repeat-fetch answer and the checkpointed
history all read AFTER it. A unit test of the helper cannot fail on the order.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.grounding_block import TRACE_LANES_MARKER

_RESULT = (
    "Found 1 relevant document(s):\n"
    "\n"
    "--- Result 1 ---\n"
    "Source: OIB-Richtlinie 2, Ausgabe Mai 2023\n"
    "Citation: oib-rl_2_ausgabe_mai_2023.pdf, p.3\n"
    "\n"
    "Diese Richtlinie gilt für …\n"
    "\n"
    "## Trace-Lanes\n"
    '{"lanes": [{"key": "baurecht_oib", "sources": [{"name": "oib-rl_2_ausgabe_mai_2023.pdf"}]}]}\n'
    "\n"
    "## Gliederung\n"
    "- Punkt 0: Vorbemerkungen (S. 3)\n"
)


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    turn_status.record_lane_hit("oib-rl_2_ausgabe_mai_2023.pdf", title="OIB-Richtlinie 2, Ausgabe Mai 2023")
    return _RESULT


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
    with (
        patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
        patch("aiq_agent.agents.piloti.answer_pipeline.verify_citations") as verify,
        patch("aiq_agent.agents.piloti.answer_pipeline.sanitize_report") as sanitize,
    ):
        verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
            verified_report=content, removed_citations=[]
        )
        sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
        yield


def _agent(*rounds: AIMessage) -> PilotiAgent:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=list(rounds))
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return PilotiAgent(llm_provider=provider, tools=[knowledge_search], max_tool_iterations=4)


def _search(call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {"query": "OIB 2"}, "id": call_id}])


@pytest.mark.asyncio
async def test_the_transcript_carries_the_passages_and_not_the_lanes():
    agent = _agent(
        _search("c1"), AIMessage(content='```answer_json\n{"answer": "Die OIB 2 [1].", "kind": "walkthrough"}\n```')
    )

    result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="was weißt du über die OIB 2")]))

    tool_messages = [m for m in result.messages if isinstance(m, ToolMessage)]
    assert len(tool_messages) == 1
    content = str(tool_messages[0].content)
    assert TRACE_LANES_MARKER not in content
    assert "Citation: oib-rl_2_ausgabe_mai_2023.pdf, p.3" in content
    assert "## Gliederung\n- Punkt 0: Vorbemerkungen (S. 3)" in content


@pytest.mark.asyncio
async def test_the_capture_still_sees_the_hit_the_tool_recorded():
    """Stripping happens after the capture: the ledger and the registry lose nothing."""
    agent = _agent(
        _search("c1"), AIMessage(content='```answer_json\n{"answer": "Die OIB 2 [1].", "kind": "walkthrough"}\n```')
    )

    result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="was weißt du über die OIB 2")]))

    ledger = result.retrieval_ledger or []
    assert [doc["name"] for entry in ledger for doc in entry["docs"]] == ["oib-rl_2_ausgabe_mai_2023.pdf"]


@pytest.mark.asyncio
async def test_a_repeat_is_answered_with_the_stripped_result():
    """The duplicate-fetch guard hands back the first execution's text — the text the model read."""
    agent = _agent(
        _search("c1"),
        _search("c2"),
        AIMessage(content='```answer_json\n{"answer": "Die OIB 2 [1].", "kind": "walkthrough"}\n```'),
    )

    result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="was weißt du über die OIB 2")]))

    tool_messages = [str(m.content) for m in result.messages if isinstance(m, ToolMessage)]
    assert len(tool_messages) == 2
    assert all(TRACE_LANES_MARKER not in content for content in tool_messages)
    assert "Wiederholter Aufruf" in tool_messages[1]
