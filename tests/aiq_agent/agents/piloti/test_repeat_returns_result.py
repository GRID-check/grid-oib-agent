"""A withheld repeat is answered with the first execution's own result.

The duplicate-fetch guard stops the turn PAYING for the same fetch twice. It
used to answer the second call with a sentence — „das Ergebnis oben ist die
Antwort" — which is a scolding and a pointer, not an answer: it asks the model
to go and find something further up its own transcript, and a model that cannot
find it asks a third time. A tool delivers an answer, so the guard delivers
one: the text the first call returned, verbatim, behind one line saying it is
the earlier result and not a second, agreeing retrieval.

Nothing else about the guard moves. The fetch still runs once, the repeat is
still not charged, and the round that asked for nothing else still costs its one
round. Through the COMPILED GRAPH, because what is asserted is what the MODEL
reads next.
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

from aiq_agent.agents.piloti.agent import _REPEAT_FETCH_MESSAGE
from aiq_agent.agents.piloti.agent import _REPEAT_FETCH_PREFIX
from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.turn_status import FETCH_FAILED_MARKER

_PROMPT = "Du bist Piloti."

#: The body the fake store returns, long enough that "the model got the result"
#: is a claim about the whole passage and not about a label.
_PASSAGE = (
    "OIB-Richtlinie 2, Punkt 3.5.2: Die Länge des Fluchtweges darf in Gebäuden der "
    "Gebäudeklasse 4 höchstens 40 m betragen, gemessen in Lauflinie."
)

RAN: list[str] = []
FAILING: set[str] = set()


@tool
def read_passage(document: str, punkt: str | None = None) -> str:
    """Open a named passage of a known document."""
    RAN.append(f"read_passage:{document}|{punkt or ''}")
    if document in FAILING:
        FAILING.discard(document)
        return f"{FETCH_FAILED_MARKER} Der Speicher antwortet nicht. Versuche denselben Aufruf noch einmal."
    return _PASSAGE


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    RAN.append(f"knowledge_search:{query}")
    return f"Treffer zu: {query}"


_TOOLS = [read_passage, knowledge_search]


@pytest.fixture(autouse=True)
def _clean_slate():
    RAN.clear()
    FAILING.clear()
    turn_status._retrieval_round.set(None)
    yield
    RAN.clear()
    FAILING.clear()
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


def _call(name: str, call_id: str, **args) -> dict:
    return {"name": name, "args": args, "id": call_id}


def _batch(*calls: dict) -> AIMessage:
    return AIMessage(content="", tool_calls=list(calls))


def _agent(*rounds: AIMessage, ceiling: int = 7) -> PilotiAgent:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=list(rounds))
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return PilotiAgent(
        llm_provider=provider,
        tools=_TOOLS,
        system_prompt=_PROMPT,
        max_tool_iterations=ceiling,
    )


async def _run(agent: PilotiAgent):
    return await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang darf der Fluchtweg sein?")]))


def _answer_for(result, call_id: str) -> str:
    (message,) = [m for m in result.messages if isinstance(m, ToolMessage) and m.tool_call_id == call_id]
    return str(message.content)


class TestTheRepeatGetsTheResult:
    async def test_the_second_call_carries_the_first_results_text(self):
        agent = _agent(
            _batch(_call("read_passage", "a", document="OIB-Richtlinie 2", punkt="3.5.2")),
            _batch(_call("read_passage", "b", document="OIB-Richtlinie 2", punkt="3.5.2")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert RAN == ["read_passage:OIB-Richtlinie 2|3.5.2"], "the fetch ran once"
        answer = _answer_for(result, "b")
        assert _PASSAGE in answer, "the repeat was answered with a pointer instead of the passage"
        assert answer == f"{_REPEAT_FETCH_PREFIX}\n\n{_PASSAGE}"

    async def test_the_line_in_front_says_it_is_the_earlier_result(self):
        """Two answers that look independent are two sources to a model counting
        agreement — the false confidence the guard is supposed to prevent, not
        manufacture."""
        agent = _agent(
            _batch(_call("read_passage", "a", document="OIB-Richtlinie 2")),
            _batch(_call("read_passage", "b", document="OIB-Richtlinie 2")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert _answer_for(result, "b").startswith(_REPEAT_FETCH_PREFIX)

    async def test_a_repeat_inside_one_batch_gets_its_own_rounds_result(self):
        """The first occurrence runs and the rest are answered from it, without
        waiting for a later round to have cached anything."""
        agent = _agent(
            _batch(
                _call("read_passage", "a", document="OIB-Richtlinie 2", punkt="3.5.2"),
                _call("read_passage", "b", document="OIB-Richtlinie 2", punkt="3.5.2"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert len(RAN) == 1
        assert _PASSAGE in _answer_for(result, "b")

    async def test_the_repeat_is_still_not_charged_for_the_fetch(self):
        """The result is free; the ROUND that asked for it costs one, as before."""
        agent = _agent(
            _batch(_call("read_passage", "a", document="OIB-Richtlinie 2")),
            _batch(_call("read_passage", "b", document="OIB-Richtlinie 2")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert result.tool_iterations == 2
        assert result.research_truncated is None

    async def test_every_call_still_gets_exactly_one_result(self):
        """A provider rejects an un-answered call and a result with no call."""
        agent = _agent(
            _batch(
                _call("knowledge_search", "a", query="Fluchtweg"),
                _call("knowledge_search", "b", query="Fluchtweg"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        asked = [call["id"] for m in result.messages if isinstance(m, AIMessage) for call in (m.tool_calls or [])]
        answered = [m.tool_call_id for m in result.messages if isinstance(m, ToolMessage)]
        assert sorted(answered) == sorted(asked)
        assert len(answered) == len(set(answered))


class TestWhatIsStillTheSentence:
    async def test_a_failed_fetch_caches_nothing_and_its_retry_runs(self):
        """A failure signs nothing, so there is no result to hand back and the
        retry the tool's own message asked for is allowed through."""
        FAILING.add("OIB-Richtlinie 2")
        agent = _agent(
            _batch(_call("read_passage", "a", document="OIB-Richtlinie 2")),
            _batch(_call("read_passage", "b", document="OIB-Richtlinie 2")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert len(RAN) == 2, "the retry was withheld and answered with a result nothing fetched"
        assert _answer_for(result, "b") == _PASSAGE

    def test_a_signature_the_turn_does_not_hold_falls_back_to_the_sentence(self):
        """Driven directly (no cached map), the guard still answers rather than
        leaving a call un-answered — with the instruction, which is the honest
        thing to say when there is no earlier result to give."""
        from aiq_agent.agents.piloti.agent import _repeat_answer

        call = {"name": "read_passage", "args": {"document": "OIB-Richtlinie 2"}, "id": "x"}
        assert _repeat_answer(call, {}) == _REPEAT_FETCH_MESSAGE
