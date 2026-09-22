"""Round 0: the decision's fetches run before the first LLM call, through the real tools node.

Through the COMPILED GRAPH, because what is pinned is the seam between the
prefetch and the two nodes: the model's first call sees the results, the
round costs no budget, the ledger draws it as round 0, a repeat by the
model is answered with the prefetch's own result, and nothing runs for a
tool the turn has not bound or a source it switched off.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.piloti.agent import _REPEAT_FETCH_PREFIX
from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.agent import TurnConfig
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

_PROMPT = "Du bist Piloti."
RAN: list[str] = []


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    RAN.append(f"knowledge_search:{query}")
    return f"Treffer zu: {query}"


@tool
def read_passage(document: str, punkt: str | None = None) -> str:
    """Open a named passage of a known document."""
    RAN.append(f"read_passage:{document}|{punkt or ''}")
    return f"Passage aus {document}"


_TOOLS = [knowledge_search, read_passage]


@pytest.fixture(autouse=True)
def _clean_slate():
    RAN.clear()
    turn_status._retrieval_round.set(None)
    yield
    RAN.clear()
    turn_status._retrieval_round.set(None)


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
def steps():
    from nat.builder.context import ContextState
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    seen: list[dict] = []

    def _on_next(step) -> None:
        payload = step.payload
        body = getattr(payload.data, "input", None)
        if isinstance(body, str) and str(payload.event_type).endswith("START"):
            seen.append({"step": payload.name, **json.loads(body)})

    state.event_stream.get().subscribe(_on_next)
    yield seen
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())


def _call(name: str, call_id: str, **args) -> dict:
    return {"name": name, "args": args, "id": call_id}


def _agent(*rounds: AIMessage, llm_calls: list | None = None) -> PilotiAgent:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)

    async def _ainvoke(messages, **_kwargs):
        if llm_calls is not None:
            llm_calls.append(list(messages))
        return rounds[len(llm_calls or []) - 1] if llm_calls is not None else rounds[0]

    llm.ainvoke = AsyncMock(side_effect=_ainvoke)
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return PilotiAgent(llm_provider=provider, tools=_TOOLS, system_prompt=_PROMPT, max_tool_iterations=7)


ANSWER = AIMessage(content="```answer_json\n" + json.dumps({"answer": "x" * 400 + " Antwort [1]."}) + "\n```")
PREFETCH = ({"name": "knowledge_search", "args": {"query": "Was weißt du über die OIB 2?"}},)


async def _run(agent: PilotiAgent, prefetch=PREFETCH, question="Was weißt du über die OIB 2?", **turn_kwargs):
    turn = TurnConfig(prefetch=tuple(prefetch), **turn_kwargs)
    return await agent.run(ResearchAgentState(messages=[HumanMessage(content=question)]), turn=turn)


class TestRoundZero:
    async def test_the_fetch_runs_before_the_first_llm_call_and_the_model_reads_it(self):
        calls: list = []
        result = await _run(_agent(ANSWER, llm_calls=calls))

        assert RAN == ["knowledge_search:Was weißt du über die OIB 2?"]
        first = calls[0]
        tool_messages = [m for m in first if isinstance(m, ToolMessage)]
        assert len(tool_messages) == 1 and "Treffer zu" in tool_messages[0].content
        ai = [m for m in first if isinstance(m, AIMessage) and m.tool_calls]
        assert ai and ai[0].tool_calls[0]["name"] == "knowledge_search"
        assert result.tool_iterations == 0

    async def test_the_round_is_announced_as_zero_and_costs_no_budget(self, steps):
        result = await _run(_agent(ANSWER, llm_calls=[]))
        assert any(s["step"] == "status:retrieval:0" for s in steps)
        assert [r.get("index") for r in result.retrieval_rounds] == [0]
        assert result.retrieval_ledger and result.retrieval_ledger[0]["index"] == 0
        assert result.tool_iterations == 0

    async def test_the_models_own_repeat_is_answered_with_the_prefetch_result(self):
        again = AIMessage(
            content="", tool_calls=[_call("knowledge_search", "c1", query="Was weißt du über die OIB 2?")]
        )
        calls: list = []
        result = await _run(_agent(again, ANSWER, llm_calls=calls))

        assert RAN == ["knowledge_search:Was weißt du über die OIB 2?"]
        second = calls[1]
        repeat = [m for m in second if isinstance(m, ToolMessage) and m.tool_call_id == "c1"]
        assert repeat and repeat[0].content.startswith(_REPEAT_FETCH_PREFIX)
        assert "Treffer zu" in repeat[0].content
        # The repeat-only round is still charged as the model's own decision.
        assert result.tool_iterations == 1

    async def test_a_second_fetch_of_the_model_is_round_one(self, steps):
        opens = AIMessage(content="", tool_calls=[_call("read_passage", "c1", document="OIB-RL 2", punkt="3.1")])
        result = await _run(_agent(opens, ANSWER, llm_calls=[]))
        assert [r.get("index") for r in result.retrieval_rounds] == [0, 1]
        assert any(s["step"] == "status:retrieval:1" for s in steps)
        assert result.tool_iterations == 1


class TestNothingRunsThatShouldNot:
    async def test_an_unbound_tool_is_dropped_silently(self):
        result = await _run(_agent(ANSWER, llm_calls=[]), prefetch=({"name": "web_search", "args": {"query": "x"}},))
        assert RAN == [] and result.retrieval_rounds == []

    async def test_a_switched_off_source_is_not_prefetched(self):
        with patch("aiq_agent.agents.piloti.agent.disabled_source_notice", return_value="Quelle ist aus."):
            result = await _run(_agent(ANSWER, llm_calls=[]), disabled_sources=frozenset({"knowledge"}))
        assert RAN == [] and result.retrieval_rounds == []

    async def test_no_prefetch_is_the_turn_as_before(self):
        result = await _run(_agent(ANSWER, llm_calls=[]), prefetch=())
        assert RAN == [] and result.retrieval_rounds == [] and result.tool_iterations == 0
