"""A tool round's restricted content is admitted before the model reads it (ADR-0078, ADR-0079).

Through the compiled graph, because the admission sits in the tools node between
the tool and every reader of its result: the source capture, the transcript the
model reads on its next call, and the checkpointed history. A share that races
the turn makes the BFF refuse, and then none of them may see the passages.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

import nat.plugins.langchain.tool_wrapper  # noqa: F401  registers the LangChain wrapper
from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common.agent_tools import load_agent_tools
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.knowledge import restricted_use as ru
from aiq_agent.knowledge.restricted_use import WITHHELD_NOTICE
from aiq_agent.knowledge.restricted_use import RestrictedUse
from aiq_agent.knowledge.restricted_use import bind_restricted_use
from aiq_agent.knowledge.restricted_use import note_collections_read
from aiq_agent.knowledge.restricted_use import reset_restricted_use
from nat.builder.workflow_builder import WorkflowBuilder
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

VERTRAEGE = "proj_p1_r0123456789ab"
_RESULT = (
    "Found 1 relevant document(s):\n"
    "\n"
    "--- Result 1 ---\n"
    "Source: Honorarvertrag Statik\n"
    "Citation: honorarvertrag.pdf, p.2\n"
    f"Collection: {VERTRAEGE}\n"
    "\n"
    "Das Honorar beträgt pauschal 48.000 € netto.\n"
)


@tool
def knowledge_search(query: str) -> str:
    """Search the project's documents."""
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


def _agent(tools: list[Any] | None = None) -> PilotiAgent:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(
        side_effect=[
            AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {"query": "Honorar"}, "id": "c1"}]),
            AIMessage(content='```answer_json\n{"answer": "Siehe Vertrag.", "kind": "walkthrough"}\n```'),
        ]
    )
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return PilotiAgent(llm_provider=provider, tools=tools or [knowledge_search], max_tool_iterations=4)


async def _run(monkeypatch, answer: dict[str, Any] | None) -> tuple[list[str], RestrictedUse, list[dict]]:
    asked: list[dict] = []

    def post(_use, body):
        asked.append(body)
        return answer

    monkeypatch.setattr(ru, "_post", post)
    use = RestrictedUse(
        organization_id="org", user_id="u1", conversation_id="c1", project_id="p1", drawable={VERTRAEGE}
    )
    token = bind_restricted_use(use)
    try:
        result = await _agent().run(ResearchAgentState(messages=[HumanMessage(content="Was ist das Honorar?")]))
    finally:
        reset_restricted_use(token)
    return [str(m.content) for m in result.messages if isinstance(m, ToolMessage)], use, asked


@pytest.mark.asyncio
async def test_a_refused_result_never_reaches_the_transcript(monkeypatch):
    contents, use, asked = await _run(monkeypatch, {"admitted": [], "refused": [VERTRAEGE]})

    assert asked == [{"admit": [VERTRAEGE]}]
    assert contents == [WITHHELD_NOTICE]
    assert all("48.000" not in content for content in contents)
    assert use.drawable == set()


@pytest.mark.asyncio
async def test_an_admitted_result_reaches_the_model_and_confines_the_conversation(monkeypatch):
    contents, use, _asked = await _run(monkeypatch, {"admitted": [VERTRAEGE], "refused": []})

    assert len(contents) == 1 and "48.000" in contents[0]
    assert use.confined is True


# ---------------------------------------------------------------------------
# The side channel, through NAT's real tool wrapper and the compiled graph
# ---------------------------------------------------------------------------
#
# A tool reports what it read (`note_collections_read`); the ToolNode's call
# wrapper stamps it onto the result; the tools node admits it. Each half has a
# unit test, and each would pass with the join broken: a wrapper the ToolNode
# never runs, or a note the wrapper's context never sees because NAT ran the
# tool in a context of its own. Only a call through NAT's LangChain wrapper and
# the compiled graph can fail on that (docs/contributing/gotchas.md).


class _QuietReaderConfig(FunctionBaseConfig, name="grid_test_quiet_restricted_reader"):
    pass


@register_function(config_type=_QuietReaderConfig)
async def _quiet_reader(config: _QuietReaderConfig, builder: Builder):
    async def _read(query: str) -> str:
        """Read a restricted folder and say so only on the side channel."""
        note_collections_read([VERTRAEGE])
        # No `Collection:` line: the text alone would let this through.
        return "Das Honorar beträgt pauschal 48.000 € netto."

    yield FunctionInfo.from_fn(_read, description="Search the project's documents.")


async def _run_nat(monkeypatch, answer: dict[str, Any] | None) -> tuple[list[str], RestrictedUse, list[dict]]:
    asked: list[dict] = []

    def post(_use, body):
        asked.append(body)
        return answer

    monkeypatch.setattr(ru, "_post", post)
    use = RestrictedUse(
        organization_id="org", user_id="u1", conversation_id="c1", project_id="p1", drawable={VERTRAEGE}
    )
    async with WorkflowBuilder() as builder:
        await builder.add_function("knowledge_search", _QuietReaderConfig())
        tools = await load_agent_tools(builder, ["knowledge_search"])
        agent = _agent(tools)
        token = bind_restricted_use(use)
        try:
            result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Was ist das Honorar?")]))
        finally:
            reset_restricted_use(token)
    return [str(m.content) for m in result.messages if isinstance(m, ToolMessage)], use, asked


@pytest.mark.asyncio
async def test_a_read_reported_only_on_the_side_channel_is_admitted(monkeypatch):
    contents, use, asked = await _run_nat(monkeypatch, {"admitted": [VERTRAEGE], "refused": []})

    assert asked == [{"admit": [VERTRAEGE]}]
    assert len(contents) == 1 and "48.000" in contents[0]
    assert use.confined is True


@pytest.mark.asyncio
async def test_a_read_reported_only_on_the_side_channel_is_withheld_when_refused(monkeypatch):
    contents, use, asked = await _run_nat(monkeypatch, {"admitted": [], "refused": [VERTRAEGE]})

    assert asked == [{"admit": [VERTRAEGE]}]
    assert contents == [WITHHELD_NOTICE]
    assert all("48.000" not in content for content in contents)
    assert use.drawable == set()
