"""Regression tests for fail-open checkpointer resolution in the deep research register.

An unopenable checkpoint_db (read-only container filesystem, missing volume,
bad DSN) must degrade to no-durability with a warning — never take application
startup down (post-#72 incident: a default-on relative sqlite path crashed the
container at WorkflowBuilder.populate_builder time).
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.tools import tool

from aiq_agent.agents.deep_researcher import register as register_module
from aiq_agent.agents.deep_researcher.register import DeepResearchAgentConfig
from aiq_agent.agents.deep_researcher.register import deep_research_agent


@tool
def web_search_tool(query: str) -> str:
    """Search the web."""
    return f"results: {query}"


class _FakeBuilder:
    async def get_tools(self, tool_names, wrapper_type):
        return [web_search_tool]

    async def get_llm(self, ref, wrapper_type):
        return MagicMock()

    def get_function_config(self, ref):
        return None


def _agent_stub_factory(seen_kwargs: dict):
    def _factory(*args, **kwargs):
        seen_kwargs.update(kwargs)
        agent = MagicMock()
        agent.run = AsyncMock(side_effect=lambda state: state)
        return agent

    return _factory


@pytest.mark.asyncio
async def test_unopenable_checkpoint_db_fails_open_and_registration_succeeds(caplog):
    """A checkpoint_db that cannot be opened disables durability with a warning, not a crash."""
    seen: dict = {}
    config = DeepResearchAgentConfig(
        orchestrator_llm="orch_llm",
        tools=["web_search_tool"],
        checkpoint_db="/nonexistent-dir/deep_research_checkpoints.db",
    )
    with patch.object(register_module, "DeepResearcherAgent", _agent_stub_factory(seen)):
        gen = deep_research_agent.__wrapped__(config, _FakeBuilder())
        with caplog.at_level("WARNING"):
            function_info = await gen.__anext__()
        assert function_info is not None
        assert seen.get("checkpointer") is None
        assert any("checkpointing DISABLED" in r.message for r in caplog.records)
        await gen.aclose()


@pytest.mark.asyncio
async def test_empty_checkpoint_db_means_no_checkpointer_and_no_warning(caplog):
    """checkpoint_db None/empty (the opt-in default) never touches get_checkpointer."""
    seen: dict = {}
    config = DeepResearchAgentConfig(orchestrator_llm="orch_llm", tools=["web_search_tool"], checkpoint_db=None)
    with (
        patch.object(register_module, "DeepResearcherAgent", _agent_stub_factory(seen)),
        patch("aiq_agent.common.get_checkpointer", side_effect=AssertionError("must not be called")),
    ):
        gen = deep_research_agent.__wrapped__(config, _FakeBuilder())
        with caplog.at_level("WARNING"):
            function_info = await gen.__anext__()
        assert function_info is not None
        assert seen.get("checkpointer") is None
        assert not any("checkpointing DISABLED" in r.message for r in caplog.records)
        await gen.aclose()
