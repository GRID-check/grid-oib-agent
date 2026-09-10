"""The agent is built once; a turn binds only what it varies.

Before this, every skills-enabled turn (every production turn: the builtin
skills always resolve, so ``use_skill`` is always folded in) constructed a
fresh ``PilotiAgent``: the 43 KB prompt re-read from disk inside
the async request, the LangGraph recompiled, every tool schema rebound, the
BM25 index rebuilt. The "bind once at construction" comments were true of a
path production never took. These tests count what a turn costs.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

import aiq_agent.agents.piloti.register as register_module
from aiq_agent.agents.piloti import prompt as prompt_module
from aiq_agent.agents.piloti.agent import _INTERACTION_TOOL_ALLOWANCE
from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.agent import TurnConfig
from aiq_agent.agents.piloti.agent import _recursion_limit
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.register import ResearchAgentConfig
from aiq_agent.agents.piloti.register import research_agent
from aiq_agent.common import LLMProvider
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry


@tool
def web_search_tool(query: str) -> str:
    """Search the web."""
    return f"results: {query}"


@tool
def use_skill(skill_name: str) -> str:
    """Return the full instructions of ``skill_name``."""
    return f"instructions for {skill_name}"


class _FakeBuilder:
    def __init__(self, llm):
        self._llm = llm

    async def get_tools(self, tool_names, wrapper_type):
        return [web_search_tool]

    async def get_llm(self, ref, wrapper_type):
        return self._llm


def _mock_llm():
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(return_value=AIMessage(content="Die Antwort [1]."))
    return llm


def _skill_runtime(standard_count: int = 2):
    runtime = MagicMock()
    runtime.prompt_block.return_value = "## Verfügbare Skills"
    runtime.forced_block.return_value = None
    runtime.build_tools.return_value = [use_skill]
    runtime.activated = []
    runtime.forced_not_activated = ()
    runtime.hidden_activated = ()
    runtime.standard_count = standard_count
    return runtime


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


@pytest.fixture
def counters(monkeypatch):
    """How many times the expensive parts ran: prompt reads, graph compiles, constructions."""
    counts = {"prompt_reads": 0, "graph_compiles": 0, "agents_built": 0}
    real_load = prompt_module.load_prompt
    real_build = PilotiAgent._build_graph
    real_init = PilotiAgent.__init__

    def counting_load(path, name):
        counts["prompt_reads"] += 1
        return real_load(path, name)

    def counting_build(self):
        counts["graph_compiles"] += 1
        return real_build(self)

    def counting_init(self, *args, **kwargs):
        counts["agents_built"] += 1
        real_init(self, *args, **kwargs)

    prompt_module.system_prompt_template.cache_clear()
    monkeypatch.setattr(prompt_module, "load_prompt", counting_load)
    monkeypatch.setattr(PilotiAgent, "_build_graph", counting_build)
    monkeypatch.setattr(PilotiAgent, "__init__", counting_init)
    yield counts
    prompt_module.system_prompt_template.cache_clear()


@pytest.mark.asyncio
async def test_two_skills_turns_build_one_agent_read_the_prompt_once_and_compile_once(counters):
    """The production path: skills on, two turns, one construction."""
    llm = _mock_llm()
    config = ResearchAgentConfig(llm="research_llm", tools=["web_search_tool"], skills_enabled=True)
    runtime = _skill_runtime()

    with (
        patch.object(register_module, "get_organization_id_from_context", return_value="org-1"),
        patch.object(register_module, "SkillRuntime", return_value=runtime),
        patch.object(register_module, "SkillResolver") as ResolverCls,
    ):
        ResolverCls.return_value.resolve.return_value = (MagicMock(name="piloti-voice"),)
        gen = research_agent.__wrapped__(config, _FakeBuilder(llm))
        run_fn = (await gen.__anext__()).single_fn
        try:
            first = await run_fn(ResearchAgentState(messages=[HumanMessage(content="Wie tief?")]))
            second = await run_fn(ResearchAgentState(messages=[HumanMessage(content="Und wie hoch?")]))
        finally:
            await gen.aclose()

    assert first.messages[-1].content == "Die Antwort [1]."
    assert second.messages[-1].content == "Die Antwort [1]."
    assert counters == {"prompt_reads": 1, "graph_compiles": 1, "agents_built": 1}
    # What a turn DOES cost: one binding of the turn's tool set (search +
    # use_skill), because the skill closure is per turn. Never more.
    assert llm.bind_tools.call_count == 1 + 2
    bound_names = [[t.name for t in call.args[0]] for call in llm.bind_tools.call_args_list]
    assert bound_names[0] == ["web_search_tool"]
    assert bound_names[1] == ["web_search_tool", "use_skill"]


@pytest.mark.asyncio
async def test_a_turn_that_varies_nothing_reuses_the_boot_binding():
    llm = _mock_llm()
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    agent = PilotiAgent(llm_provider=provider, tools=[web_search_tool])
    llm.bind_tools.reset_mock()

    await agent.run(ResearchAgentState(messages=[HumanMessage(content="Q")]))
    await agent.run(
        ResearchAgentState(messages=[HumanMessage(content="Q")]),
        turn=TurnConfig(llm_provider=provider, tools=[web_search_tool], reserved_tool_iterations=0),
    )

    llm.bind_tools.assert_not_called()


@pytest.mark.asyncio
async def test_the_turns_reserve_reaches_the_ceiling_through_the_graph_config():
    """The binding travels on the LangGraph config, not on a rebuilt agent.

    Research budget 3, two skill loads already spent: without the reserve the
    first call is forced synthesis; with it, the model gets its research.
    """
    llm = _mock_llm()
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    agent = PilotiAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=3)
    spent = ResearchAgentState(messages=[HumanMessage(content="Wie tief?")], tool_iterations=3)

    truncated = await agent.run(spent.model_copy(deep=True))
    reserved = await agent.run(spent.model_copy(deep=True), turn=TurnConfig(reserved_tool_iterations=2))

    assert truncated.research_truncated is True
    assert reserved.research_truncated is None
    # The boot agent is unchanged by the turn.
    assert agent.tool_iteration_ceiling == 3


def test_the_recursion_guard_is_derived_from_the_ceiling():
    """Two steps per round: every costing round (≤ ceiling) plus every free
    interaction round (≤ allowance), the final synthesis, and slack."""
    for ceiling in (0, 5, 7):
        rounds = ceiling + _INTERACTION_TOOL_ALLOWANCE
        assert _recursion_limit(ceiling) > 2 * rounds + 1
    assert _recursion_limit(5) < _recursion_limit(7)
