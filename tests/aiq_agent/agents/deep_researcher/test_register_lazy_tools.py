"""Tests for lazy (request-time) inherited-tool resolution in the deep research register."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.tools import tool

import aiq_agent.common as common_module
from aiq_agent.agents.deep_researcher import register as register_module
from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig
from aiq_agent.agents.deep_researcher.register import deep_research_agent


@tool
def web_search_tool(query: str) -> str:
    """Search the web."""
    return f"results: {query}"


class _FakeBuilder:
    def __init__(self, tools_by_name):
        self._tools_by_name = tools_by_name
        self.get_tools_calls = []

    async def get_tools(self, tool_names, wrapper_type):
        self.get_tools_calls.append(list(tool_names))
        return [self._tools_by_name[n] for n in tool_names if n in self._tools_by_name]

    async def get_llm(self, ref, wrapper_type):
        return MagicMock()

    def get_function_config(self, ref):
        return None


def _make_agent_stub():
    """DeepResearcherAgent replacement whose .run echoes the input state."""

    def _factory(*args, **kwargs):
        agent = MagicMock()
        agent.run = AsyncMock(side_effect=lambda state: state)
        agent._init_tools = kwargs.get("tools")
        return agent

    return _factory


async def _get_run_fn(config, builder):
    gen = deep_research_agent.__wrapped__(config, builder)
    function_info = await gen.__anext__()
    return function_info.single_fn, gen


@pytest.mark.asyncio
async def test_inherited_tools_resolved_lazily_after_registry_populated():
    """Empty registry at build time: first run resolves nothing; a later run resolves once populated."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = DeepResearchAgentConfig(orchestrator_llm="orch_llm", tools=[])

    with patch.object(register_module, "DeepResearcherAgent", _make_agent_stub()):
        # Registry empty at build time.
        with patch.object(common_module, "get_all_tool_refs", return_value=[]):
            run_fn, gen = await _get_run_fn(config, builder)
            # No build-time tool resolution for inherited tools.
            assert builder.get_tools_calls == []

            # First request: registry still empty -> runtime gate returns an error state,
            # and the empty result is NOT cached.
            result = await run_fn(DeepResearchAgentState(messages=[]))
            assert result.messages  # error AIMessage placed by the runtime gate

        # Registry now populated (build-order race resolved by request time).
        with patch.object(common_module, "get_all_tool_refs", return_value=["web_search_tool"]):
            result2 = await run_fn(DeepResearchAgentState(messages=[]))
            # Tools were resolved lazily and the agent actually ran.
            assert result2 is not None
            assert ["web_search_tool"] in builder.get_tools_calls

        await gen.aclose()


@pytest.mark.asyncio
async def test_explicit_tools_resolved_eagerly_and_registry_never_consulted():
    """Explicit config.tools keeps the original eager-resolution behavior."""
    builder = _FakeBuilder({"web_search_tool": web_search_tool})
    config = DeepResearchAgentConfig(orchestrator_llm="orch_llm", tools=["web_search_tool"])

    get_all = MagicMock(return_value=[])
    with (
        patch.object(register_module, "DeepResearcherAgent", _make_agent_stub()),
        patch.object(common_module, "get_all_tool_refs", get_all),
    ):
        run_fn, gen = await _get_run_fn(config, builder)
        # Eager resolution at build time for the explicit list.
        assert builder.get_tools_calls == [["web_search_tool"]]

        result = await run_fn(DeepResearchAgentState(messages=[]))
        assert result is not None
        # The inherited-tools registry path is never taken for explicit configs.
        get_all.assert_not_called()

        await gen.aclose()
