"""The platform's own skills, on the surface that writes the LONGEST answers.

``grid-agents: shallow_researcher,deep_researcher`` on a ``platform_skills`` row
used to be honoured on one half and inert on the other: the chat researcher
built a ``SkillRuntime`` and the deep pipeline resolved builtin skill FILES out
of its sandbox instead, so ``piloti-voice`` — the row that carries the house
voice — never reached the writer of a five-thousand-word report.

These tests pin both halves of the fix, and they are asserted against the REAL
resolution path (only the BFF round trip is stubbed) because every layer between
a row and the writer's context is somewhere the skill can quietly go missing:
the ``grid-agents`` gate, the origin filter, the runtime's forcing of a standard
skill, the writer's prompt, and the tool that carries the body.

The second test is the more important one. A skill is additive; a report is the
product. If the BFF cannot be reached — an anonymous run, an unset
``GRID_INTERNAL_API_TOKEN``, a restarting frontend — the run must still produce
its report, with no skills section and no ``use_skill`` tool to call.
"""

from __future__ import annotations

from unittest import mock
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
from aiq_agent.agents.deep_researcher.factory import WRITER_AGENT
from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import cache as shared_cache
from aiq_agent.skills.resolver import SkillResolver

VOICE_BODY = "# Wie eine Antwort gebaut ist\n\nDie Zahl steht im ersten Satz."


@tool
def web_search_tool(query: str) -> str:
    """Search the web for information."""
    return f"Results for: {query}"


@pytest.fixture(autouse=True)
def _stub_researcher_construction():
    """The researcher runnable needs a concrete chat model; nothing here does.

    Same stub as ``test_agent.py``: these tests are about the writer subagent's
    spec, and building a real summarization middleware around a MagicMock model
    is a dependency of the researcher, not of what is under test.
    """

    class FakeSummarizationMiddleware(AgentMiddleware):
        pass

    researcher_runnable = MagicMock(name="researcher_runnable")
    researcher_runnable.ainvoke = AsyncMock()
    with (
        mock.patch(
            "aiq_agent.agents.deep_researcher.factory.create_summarization_middleware",
            return_value=FakeSummarizationMiddleware(),
        ),
        mock.patch(
            "aiq_agent.agents.deep_researcher.factory.create_agent",
            return_value=researcher_runnable,
        ),
    ):
        yield


@pytest.fixture(autouse=True)
def _reset_cache():
    shared_cache.reset_local_store()
    yield
    shared_cache.reset_local_store()


@pytest.fixture
def llm_provider() -> LLMProvider:
    llm = MagicMock()
    provider = LLMProvider()
    provider.set_default(llm)
    for role in (LLMRole.ROUTER, LLMRole.PLANNER, LLMRole.RESEARCHER, LLMRole.REPORT_WRITER, LLMRole.ORCHESTRATOR):
        provider.configure(role, llm)
    return provider


@pytest.fixture
def graph() -> MagicMock:
    """A stand-in for the compiled DeepAgents graph that returns a report."""
    final_state = {
        "messages": [AIMessage(content="Deep research answer")],
        "files": {
            "/shared/output.md": {
                "content": "1,10 m. Ab 12 m Absturzhöhe [1].\n\n## Sources\n[1] OIB: https://example.test/oib",
                "encoding": "utf-8",
            }
        },
    }

    compiled = MagicMock()
    compiled.with_config = MagicMock(return_value=compiled)

    def _astream(*_args, **_kwargs):
        # run() streams the graph (stream_mode="values") so a cut-off run has a
        # last known state to salvage; one chunk is one full graph state.
        async def _generate():
            yield final_state

        return _generate()

    compiled.astream = MagicMock(side_effect=_astream)
    return compiled


def _voice_row() -> dict[str, object]:
    """The BFF's payload for the seeded ``piloti-voice`` row, verbatim in shape."""
    return {
        "name": "piloti-voice",
        "description": "Vor dem Schreiben der Antwort laden: wie eine Piloti-Antwort gebaut ist.",
        "body": VOICE_BODY,
        "metadata": {"grid-agents": "shallow_researcher,deep_researcher", "grid-hidden": "true"},
        "standard": True,
    }


def _prepare(agent: DeepResearcherAgent, graph: MagicMock, state: DeepResearchAgentState) -> dict:
    """Build one run's graph and return the writer subagent spec."""
    with mock.patch(
        "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
        return_value=graph,
    ) as create:
        agent._prepare_run(state)
    subagents = create.call_args.kwargs["subagents"]
    return next(spec for spec in subagents if spec["name"] == WRITER_AGENT)


def test_a_standard_platform_skill_reaches_the_writer_as_a_requirement_and_a_body(llm_provider, graph):
    """The voice is listed, required, and loadable — the three things it needs.

    A catalog line alone would leave the model free to ignore it, and a tool
    alone would leave it with nothing to call. ``delivery: 'standard'`` means the
    platform decided for the fleet, so the writer is TOLD to load it, and what it
    gets back is the body a platform owner edits in the dashboard.
    """
    agent = DeepResearcherAgent(llm_provider=llm_provider, tools=[web_search_tool])
    state = DeepResearchAgentState(
        messages=[HumanMessage(content="Wie hoch muss das Geländer sein?")],
        organization_id="org-1",
    )

    with mock.patch.object(SkillResolver, "_fetch_org_skills", return_value=[_voice_row()]):
        writer = _prepare(agent, graph, state)

    prompt = writer["system_prompt"]
    assert "## Available skills" in prompt
    assert "- `piloti-voice`:" in prompt
    # Standard delivery is what makes it policy rather than an offer.
    assert "## Active skills (required for this turn)" in prompt
    assert "- `piloti-voice`" in prompt.split("## Active skills (required for this turn)")[1]
    # The preflight has to tell the writer which of the two channels loads it.
    assert "use_skill" in prompt

    use_skill = next(item for item in writer["tools"] if item.name == "use_skill")
    assert VOICE_BODY in use_skill.invoke({"skill_name": "piloti-voice"})
    # And the writer's sanitizer must accept the name, or the call is rewritten
    # into a tool that does not exist.
    sanitizer = next(m for m in writer["middleware"] if m.__class__.__name__ == "ToolNameSanitizationMiddleware")
    assert "use_skill" in sanitizer.valid_tool_names


def test_the_writer_keeps_its_own_lead_rule_alongside_the_voice(llm_provider, graph):
    """The prompt's floor and the skill's craft compose; neither replaced the other.

    The lead paragraph in ``writer.j2`` is the only answer-shape guidance a run
    has when the voice cannot be fetched, so it stays — and it must not be
    deleted as a duplicate the day the voice starts arriving.
    """
    agent = DeepResearcherAgent(llm_provider=llm_provider, tools=[web_search_tool])
    state = DeepResearchAgentState(messages=[HumanMessage(content="q")], organization_id="org-1")

    with mock.patch.object(SkillResolver, "_fetch_org_skills", return_value=[_voice_row()]):
        writer = _prepare(agent, graph, state)

    assert "- Open with the answer." in writer["system_prompt"]


def test_the_writer_prompt_carries_the_diagram_contract(llm_provider, graph):
    """The deep half of "a diagram printed as a shell listing".

    Chat routes a diagram request to a drawing CARD; the deep report has no
    card surface, so a tagged ```mermaid fence IS the drawing here — the PDF
    converter renders it and prints a placeholder for anything else. Without
    this block the writer had no diagram guidance at all and fell back to box
    art, which is a monospace listing in the file the reader files.
    """
    agent = DeepResearcherAgent(llm_provider=llm_provider, tools=[web_search_tool])
    state = DeepResearchAgentState(messages=[HumanMessage(content="q")], organization_id="org-1")

    with mock.patch.object(SkillResolver, "_fetch_org_skills", return_value=[_voice_row()]):
        writer = _prepare(agent, graph, state)

    prompt = writer["system_prompt"]
    # The fence, and the declaration line without which mermaid draws nothing.
    assert "```mermaid" in prompt
    assert "`stateDiagram-v2`" in prompt
    # The ban that the field transcripts are about, and the reason for it.
    assert "Never draw with ASCII box art" in prompt
    # Meaning survives a converter that drops styling, and a label cannot
    # outrun the report's own grounding.
    assert "never in colour or styling" in prompt
    assert "No label may carry a claim the report has not grounded" in prompt


def test_a_chat_only_platform_skill_is_not_offered_to_the_writer(llm_provider, graph):
    """``grid-agents`` is one gate read the same way on both sides of it."""
    agent = DeepResearcherAgent(llm_provider=llm_provider, tools=[web_search_tool])
    state = DeepResearchAgentState(messages=[HumanMessage(content="q")], organization_id="org-1")
    chat_only = {**_voice_row(), "name": "chat-voice", "metadata": {"grid-agents": "shallow_researcher"}}

    with mock.patch.object(SkillResolver, "_fetch_org_skills", return_value=[chat_only]):
        writer = _prepare(agent, graph, state)

    assert "chat-voice" not in writer["system_prompt"]
    assert [item.name for item in writer["tools"]] == ["think", "get_verified_sources"]


@pytest.mark.asyncio
async def test_the_report_is_still_written_when_skills_cannot_be_resolved(llm_provider, graph):
    """A BFF that does not answer costs the run its voice, never its report.

    The whole resolution path is allowed to fail here — the way it fails on an
    anonymous run or with ``GRID_INTERNAL_API_TOKEN`` unset — and the assertion
    is that the run reaches its finished Markdown anyway, with no skills section
    promising instructions that never arrived and no ``use_skill`` tool bound to
    a catalog that is empty.
    """
    agent = DeepResearcherAgent(
        llm_provider=llm_provider,
        tools=[web_search_tool],
        enable_citation_verification=False,
    )
    state = DeepResearchAgentState(messages=[HumanMessage(content="q")], organization_id="org-1")

    with mock.patch.object(SkillResolver, "_fetch_org_skills", side_effect=RuntimeError("frontend unreachable")):
        writer = _prepare(agent, graph, state)

        assert "## Available skills" not in writer["system_prompt"]
        assert [item.name for item in writer["tools"]] == ["think", "get_verified_sources"]

        with mock.patch(
            "aiq_agent.agents.deep_researcher.factory.create_deep_agent",
            return_value=graph,
        ):
            result = await agent.run(state)

    assert "1,10 m." in result.messages[-1].content
