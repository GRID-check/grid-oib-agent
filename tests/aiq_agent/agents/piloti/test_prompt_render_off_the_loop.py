"""The system prompt is rendered in a THREAD, not on the event loop.

``render_system_prompt`` is a sync function, and one of its inputs is not
local: the static half is resolved through the prompt store, which — with
Langfuse prompt management on — makes one bounded HTTP call (2 s) the first
time a TTL window needs it. Called straight from the async agent node that is
one blocking socket read inside a coroutine, and a coroutine that blocks does
not block its own turn: it blocks every other turn the worker is serving,
including turns that are nowhere near a prompt render.

Which is why the test cannot be a unit test of the renderer. What is asserted
is WHERE it ran, so the fake store records ``threading.current_thread()`` from
inside ``get`` and the assertion compares it with the thread the event loop is
on — exactly the shape ``register.py`` already uses for its own blocking reads
(``asyncio.to_thread``).

The second claim is the one that makes the first one cheap: the render happens
ONCE per turn, cached on the state, so the tool loop never pays for it twice.
"""

from __future__ import annotations

import threading
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

_PROMPT = "Du bist Piloti."


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    return f"Treffer zu: {query}"


class _RecordingStore:
    """A prompt store that records the thread its (blocking) fetch ran on."""

    def __init__(self) -> None:
        self.threads: list[threading.Thread] = []

    def get(self, name, *, fallback):
        self.threads.append(threading.current_thread())
        return fallback


@pytest.fixture
def store():
    recording = _RecordingStore()
    with patch("aiq_agent.agents.piloti.prompt.prompt_store", return_value=recording):
        yield recording


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
    return PilotiAgent(llm_provider=provider, tools=[knowledge_search], system_prompt=_PROMPT)


async def _run(agent: PilotiAgent):
    return await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang darf der Fluchtweg sein?")]))


class TestTheRenderDoesNotRunOnTheLoopThread:
    async def test_the_store_is_read_off_the_event_loop(self, store):
        loop_thread = threading.current_thread()
        agent = _agent(AIMessage(content="Die Antwort [1]."))

        await _run(agent)

        assert store.threads, "the prompt store was never read; the fake is not wired in"
        assert loop_thread not in store.threads, (
            "the static prompt was resolved on the event-loop thread, so a slow Langfuse "
            "blocks every other turn this worker is serving"
        )

    async def test_the_render_still_happens_once_per_turn(self, store):
        """Three rounds, one render: the string is cached on the state, and a
        thread hop per iteration would be a new cost, not a saved one."""
        agent = _agent(
            AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {"query": "a"}, "id": "1"}]),
            AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {"query": "b"}, "id": "2"}]),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert result.tool_iterations == 2
        assert len(store.threads) == 1
