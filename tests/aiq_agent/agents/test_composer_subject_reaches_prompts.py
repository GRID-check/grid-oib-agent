"""The composer's "Asking about <file>" subject must reach the models.

`focus_file_name` arrives on the wire and is stored in the turn ContextVars,
where retrieval reads it. For a long while that was ALL it did: no prompt in
the repo named the focused file, so a deictic turn ("summarize this document",
"fass zusammen") reached the answering model with no antecedent at all. The
model did the only reasonable thing and asked which file was meant — over an
open PDF, with the composer bar on screen saying exactly which one.

These tests hold the wire → state → prompt path shut at each seam.
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.agents.shallow_researcher.agent import _shelf_label
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import render_prompt_template
from aiq_agent.common.data_source_registry import populate_from_config

SUBJECT = "220724_Aufsicht_1_100.pdf"


@tool
def searching_tool(query: str) -> str:
    """Search the knowledge base."""
    return ""


@tool
def remember_tool(fact: str) -> str:
    """Remember a fact for later conversations."""
    return "saved"


@pytest.fixture
def mock_llm():
    llm = MagicMock()
    llm.ainvoke = AsyncMock()
    llm.bind_tools = MagicMock(return_value=llm)
    return llm


@pytest.fixture
def mock_llm_provider(mock_llm):
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=mock_llm)
    return provider


@pytest.fixture
def real_tool():
    return searching_tool


def _render(agent: ShallowResearcherAgent, **overrides) -> str:
    kwargs = {
        "tools": [{"name": "knowledge_search", "description": "Search the knowledge base"}],
        "user_info": None,
        "current_datetime": "2026-08-18",
        "available_documents": [],
        "project_context": None,
        "ris_catalog": None,
    }
    kwargs.update(overrides)
    return render_prompt_template(agent.system_prompt, **kwargs)


class TestResearcherPromptNamesTheSubject:
    def test_focused_file_is_named_with_its_shelf(self, mock_llm_provider, real_tool):
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        rendered = _render(agent, focus_file_name=SUBJECT, focus_shelf_label="Projektwissen")

        assert SUBJECT in rendered
        assert "Projektwissen" in rendered
        # The point of the block: bare references resolve to THIS file, and the
        # model must not ask for it or ask the user to upload it.
        assert "never ask which file is meant" in rendered
        assert f'file_name="{SUBJECT}"' in rendered

    def test_shelf_is_omitted_rather_than_invented(self, mock_llm_provider, real_tool):
        """An unknown shelf names the file alone — never a guessed shelf."""
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        rendered = _render(agent, focus_file_name=SUBJECT, focus_shelf_label=None)

        assert f"## This turn's subject: **{SUBJECT}**\n" in rendered

    def test_no_subject_renders_no_subject_block(self, mock_llm_provider, real_tool):
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        rendered = _render(agent, focus_file_name=None, focus_shelf_label=None)

        assert "This turn's subject" not in rendered

    def test_render_survives_callers_that_pass_no_focus_at_all(self, mock_llm_provider, real_tool):
        """The template is rendered under StrictUndefined; the guards must hold."""
        agent = ShallowResearcherAgent(llm_provider=mock_llm_provider, tools=[real_tool])

        rendered = _render(agent)

        assert "This turn's subject" not in rendered


class TestShelfLabel:
    @pytest.mark.parametrize(
        ("shelf", "expected"),
        [
            ("project", "Projektwissen"),
            ("archiv", "Büroarchiv"),
            ("session", "Private Sitzung"),
            ("base", "Basiswissen"),
            (None, None),
            ("", None),
            ("nonsense", None),
        ],
    )
    def test_labels_match_the_inventory_vocabulary(self, shelf, expected):
        assert _shelf_label(shelf) == expected


class TestSubjectKeepsTheSearchTools:
    """A deictic turn with a subject must have the search tools on it.

    A pre-answer partition once withheld the search tools from anything that
    read as chit-chat, and "fass zusammen" over an open PDF read as chit-chat —
    so the only tool that could read the file was gone before the model saw
    the question. Since ADR-0052 every turn carries the full tool set; this
    pins that the bare summary request is one of them.
    """

    @pytest.mark.asyncio
    async def test_a_bare_summary_request_with_a_subject_has_the_search_tools(self, mock_llm_provider, mock_llm):
        populate_from_config(
            [
                {
                    "id": "web_search",
                    "name": "Web Search",
                    "description": "Search the web.",
                    "tools": ["searching_tool"],
                }
            ],
        )
        mock_llm.ainvoke = AsyncMock(side_effect=[AIMessage(content="Zusammenfassung.")])

        agent = ShallowResearcherAgent(
            llm_provider=mock_llm_provider,
            tools=[searching_tool, remember_tool],
        )
        mock_llm.bind_tools.reset_mock()

        state = ShallowResearchAgentState(
            messages=[HumanMessage(content="fass zusammen")],
            focus_file_name=SUBJECT,
            focus_shelf="project",
        )
        await agent.run(state)

        # The prompt's tool list mirrors the binding, so it is the readable
        # proof of which tools the model was actually offered.
        system_prompt = mock_llm.ainvoke.call_args[0][0][0].content
        assert "**searching_tool**" in system_prompt


class TestSubjectSurvivesTheGraphHandoff:
    """The chat graph is the only thing between the wire and the answering
    agent; a field it forgets to copy is a field the model never sees."""

    @pytest.mark.asyncio
    async def test_shallow_node_forwards_the_subject(self):
        from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent

        captured: dict = {}

        async def shallow(state):
            captured["focus_file_name"] = state.focus_file_name
            captured["focus_shelf"] = state.focus_shelf
            result = MagicMock()
            result.messages = list(state.messages) + [AIMessage(content="Zusammenfassung.")]
            result.escalation_requested = False
            result.answer_confidence_marker = None
            return result

        async def unused(state):  # pragma: no cover — the route never reaches these
            raise AssertionError("shallow turn must not escalate")

        agent = ChatResearcherAgent(
            shallow_research_fn=shallow,
            deep_research_fn=unused,
            clarifier_fn=unused,
            enable_escalation=False,
        )

        await agent.run(
            ChatResearcherState(
                messages=[HumanMessage(content="fass zusammen")],
                focus_file_name=SUBJECT,
                focus_shelf="project",
            )
        )

        assert captured == {"focus_file_name": SUBJECT, "focus_shelf": "project"}
