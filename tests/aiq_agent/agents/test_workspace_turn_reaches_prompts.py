"""The Büro context must reach the answering model, and replace the project one.

The office turn (ADR-0054) is the same agent on the same prompt with a different
context shape: organization memory plus Projektregister recall instead of one
project's profile. Two seams can silently lose that — the chat graph, which
copies fields onto the shallow state by hand, and the template, which renders
whichever block it is given. Spec AG-3 makes the second one sharper than
"render both": the project instructions ("this project's files", "patch only
properties of THIS project") must be REPLACED in the Büro, not joined, or the
model is told to do two contradictory things in the same prompt.
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.common import LLMProvider
from aiq_agent.common import render_prompt_template

WORKSPACE_BLOCK = (
    "WORKSPACE_CONTEXT v1\n\nDiese Unterhaltung läuft im Büro, nicht in einem Projekt.\n\n"
    "## Passende Projekte (Projektregister)\n### Seestadt Baufeld D (id: proj_1)\nWohnbau, GK5, Wien"
)


@tool
def searching_tool(query: str) -> str:
    """Search the knowledge base."""
    return ""


@pytest.fixture
def agent() -> ShallowResearcherAgent:
    provider = MagicMock(spec=LLMProvider)
    llm = MagicMock()
    llm.ainvoke = AsyncMock()
    llm.bind_tools = MagicMock(return_value=llm)
    provider.get = MagicMock(return_value=llm)
    return ShallowResearcherAgent(llm_provider=provider, tools=[searching_tool])


def _render(agent: ShallowResearcherAgent, **overrides) -> str:
    kwargs = {
        "tools": [{"name": "knowledge_search", "description": "Search the knowledge base"}],
        "user_info": None,
        "current_datetime": "2026-09-08",
        "available_documents": [],
        "project_context": None,
        "ris_catalog": None,
    }
    kwargs.update(overrides)
    return render_prompt_template(agent.system_prompt, **kwargs)


class TestTheOfficeBranch:
    def test_the_workspace_block_renders_with_its_rules(self, agent):
        rendered = _render(agent, workspace_context=WORKSPACE_BLOCK)

        assert "## Büro" in rendered
        assert "Seestadt Baufeld D" in rendered
        # The three rules the branch exists to state (spec AG-4, AG-5, PR-15).
        assert "You are in the office, not in a project." in rendered
        assert "may NOT describe its documents' content from it" in rendered
        assert "open_project" in rendered

    def test_the_office_replaces_the_project_block_rather_than_joining_it(self, agent):
        """AG-3. In the Büro the composed context IS the workspace block, so
        without this guard the same text renders twice — once under a heading
        that tells the model to patch the profile of a project it is not in.

        `<project_brief>` itself still renders: it sits ABOVE the KV-cache
        boundary, where making it conditional would split the cached prefix of
        every turn in the fleet. The office branch stands it down in words
        instead, which is the same instruction with a cheaper mechanism — and
        the reason that sentence is asserted here rather than left to reading.
        """
        rendered = _render(agent, project_context=WORKSPACE_BLOCK, workspace_context=WORKSPACE_BLOCK)

        assert "## Büro" in rendered
        assert "## Project Context" not in rendered
        assert rendered.count("WORKSPACE_CONTEXT v1") == 1, "the office context must not be rendered twice"
        assert "The instructions in <project_brief> are about a project turn and do not apply here." in rendered

    def test_a_project_turn_is_unchanged(self, agent):
        rendered = _render(agent, project_context="PROJECT_CONTEXT v1\nconfirmed:\n- gk=5")

        assert "## Project Context" in rendered
        assert "## Büro" not in rendered

    def test_a_caller_that_passes_neither_still_renders(self, agent):
        """StrictUndefined: the office branch must be guarded on `is defined`,
        because the deep researcher and every direct caller pass no such kwarg."""
        rendered = _render(agent)

        assert "## Büro" not in rendered
        assert "## Project Context" not in rendered

    def test_the_fifth_shelf_is_named_in_the_shelf_register(self, agent):
        """KH-2: the Projektregister is a level of its own, not a fold of the
        project level — and the prompt is where the model learns the difference."""
        rendered = _render(agent)

        assert "**Projektregister** (`register`)" in rendered
        assert "five nested shelves" in rendered


class TestTheGraphHandoff:
    @pytest.mark.asyncio
    async def test_the_shallow_node_forwards_the_workspace_context(self):
        from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent

        captured: dict = {}

        async def shallow(state):
            captured["workspace_context"] = state.workspace_context
            captured["project_context"] = state.project_context
            result = MagicMock()
            result.messages = list(state.messages) + [AIMessage(content="Im Büro.")]
            result.escalation_requested = False
            result.answer_confidence_marker = None
            return result

        async def unused(state):  # pragma: no cover — the route never reaches these
            raise AssertionError("a Büro turn must not escalate here")

        agent = ChatResearcherAgent(shallow_research_fn=shallow, deep_research_fn=unused, clarifier_fn=unused)

        await agent.run(
            ChatResearcherState(
                messages=[HumanMessage(content="In welchen Projekten haben wir GK5 in Holzbau?")],
                project_context=WORKSPACE_BLOCK,
                workspace_context=WORKSPACE_BLOCK,
            )
        )

        assert captured["workspace_context"] == WORKSPACE_BLOCK
        assert captured["project_context"] == WORKSPACE_BLOCK
