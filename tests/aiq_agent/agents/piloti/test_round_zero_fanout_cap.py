"""The first round runs two searches, so the second one can be precise.

Calls are charged when the model EMITS them and never refunded, and parallel
calls each cost one. So a greedy first batch of five spends five of a ceiling of
seven before a single result has been observed — and the tighter second round,
the one PR 644 made permitted and the one where precision actually comes from,
is paid for out of what is left. Before the model has read anything it knows
only which CORPORA the question could live in, so a third parallel search is the
same guess said a third time.

These tests go through the COMPILED GRAPH, because the cap has two halves that
must agree: the agent node decides what to charge, the tools node decides what
to run. A unit test of either half passes while they disagree, and a
disagreement means either a charge for a call nothing executed or a call nothing
paid for.

The transcript invariant is the other thing pinned here. The AIMessage keeps
every tool call it made and each one gets exactly one result — the withheld ones
get the sentence saying why — because a provider rejects a tool result with no
matching call, and rejects an un-answered call too.
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

from aiq_agent.agents.piloti.agent import _FANOUT_DROPPED_MESSAGE
from aiq_agent.agents.piloti.agent import _ROUND_ZERO_SEARCH_LIMIT
from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

#: Which tools actually ran, in execution order. Module level because a
#: LangChain ``@tool`` is a module-level object; cleared per test.
RAN: list[str] = []


def _batches(ran: list[str], *sizes: int) -> list[set[str]]:
    """``ran`` cut into the graph's batches, each as a set.

    The order BETWEEN batches is the loop's contract (round zero runs before
    round one). The order WITHIN a batch is not: ``ToolNode`` runs a batch's
    calls concurrently, sync tools on worker threads, and which thread appends
    first is the scheduler's choice — CPython 3.13 makes a different one from
    3.12 often enough that an ordered assertion here failed only on the 3.13 CI
    leg. The cap decides which calls run, never in which order.
    """
    assert sum(sizes) == len(ran), f"expected {sum(sizes)} calls, got {ran}"
    out: list[set[str]] = []
    start = 0
    for size in sizes:
        out.append(set(ran[start : start + size]))
        start += size
    return out


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    RAN.append(f"knowledge_search:{query}")
    return f"Treffer zu: {query}"


@tool
def ris_search_tool(query: str) -> str:
    """Search Austrian law in RIS."""
    RAN.append(f"ris_search_tool:{query}")
    return f"RIS-Treffer zu: {query}"


@tool
def web_search_tool(query: str) -> str:
    """Search the web."""
    RAN.append(f"web_search_tool:{query}")
    return f"Web-Treffer zu: {query}"


@tool
def emit_card(kind: str) -> str:
    """Emit a UI card."""
    RAN.append(f"emit_card:{kind}")
    return "Karte erstellt"


@tool
def remember(text: str) -> str:
    """Store a durable fact about this project."""
    RAN.append(f"remember:{text}")
    return "gemerkt"


@pytest.fixture(autouse=True)
def _clean_slate():
    RAN.clear()
    turn_status._retrieval_round.set(None)
    yield
    RAN.clear()
    turn_status._retrieval_round.set(None)


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
    """The answer pipeline is not what these tests are about."""
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
def scripted_agent():
    """A PilotiAgent whose LLM plays a fixed script of tool rounds."""

    def build(*rounds: AIMessage) -> PilotiAgent:
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(side_effect=list(rounds))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        return PilotiAgent(
            llm_provider=provider,
            tools=[knowledge_search, ris_search_tool, web_search_tool, emit_card, remember],
            max_tool_iterations=7,
        )

    return build


def _call(name: str, call_id: str, **args) -> dict:
    return {"name": name, "args": args, "id": call_id}


def _batch(*calls: dict, thought: str = "") -> AIMessage:
    return AIMessage(content=thought, tool_calls=list(calls))


async def _run(agent: PilotiAgent, question: str = "Wie lang darf der Fluchtweg sein?"):
    return await agent.run(ResearchAgentState(messages=[HumanMessage(content=question)]))


def _tool_messages(result) -> list[ToolMessage]:
    return [m for m in result.messages if isinstance(m, ToolMessage)]


class TestRoundZero:
    async def test_three_parallel_searches_run_two_and_the_third_says_why(self, scripted_agent):
        agent = scripted_agent(
            _batch(
                _call("knowledge_search", "a", query="Fluchtweglänge GK4"),
                _call("ris_search_tool", "b", query="Wiener Bauordnung Fluchtweg"),
                _call("web_search_tool", "c", query="Fluchtweg Österreich"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert _batches(RAN, 2) == [
            {"knowledge_search:Fluchtweglänge GK4", "ris_search_tool:Wiener Bauordnung Fluchtweg"}
        ]
        notices = [m for m in _tool_messages(result) if m.content == _FANOUT_DROPPED_MESSAGE]
        assert [m.tool_call_id for m in notices] == ["c"]
        assert notices[0].name == "web_search_tool"

    async def test_every_tool_call_still_gets_exactly_one_result(self, scripted_agent):
        """The transcript invariant. A provider rejects an un-answered call and
        rejects a result with no call, so the two sets must be equal."""
        agent = scripted_agent(
            _batch(
                _call("knowledge_search", "a", query="a"),
                _call("knowledge_search", "b", query="b"),
                _call("knowledge_search", "c", query="c"),
                _call("ris_search_tool", "d", query="d"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        asked = {call["id"] for m in result.messages if isinstance(m, AIMessage) for call in (m.tool_calls or [])}
        answered = [m.tool_call_id for m in _tool_messages(result)]
        assert sorted(answered) == sorted(asked)
        assert len(answered) == len(set(answered)), "a call answered twice is as invalid as one answered never"

    async def test_the_loop_continues_and_the_second_round_is_uncapped(self, scripted_agent):
        """The point of the cap: the budget survives to the round that knows
        what it is looking for."""
        agent = scripted_agent(
            _batch(
                _call("knowledge_search", "a", query="a"),
                _call("ris_search_tool", "b", query="b"),
                _call("web_search_tool", "c", query="c"),
            ),
            _batch(
                _call("knowledge_search", "d", query="Pkt. 3.5.2"),
                _call("ris_search_tool", "e", query="§ 108 BO"),
                _call("web_search_tool", "f", query="OIB 2 Kommentar"),
                thought="Die Grundregel steht; jetzt der Treppenraum.",
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert _batches(RAN, 2, 3) == [
            {"knowledge_search:a", "ris_search_tool:b"},
            {"knowledge_search:Pkt. 3.5.2", "ris_search_tool:§ 108 BO", "web_search_tool:OIB 2 Kommentar"},
        ]
        assert _FANOUT_DROPPED_MESSAGE not in [
            m.content for m in _tool_messages(result) if m.tool_call_id in {"d", "e", "f"}
        ]

    async def test_two_searches_are_untouched(self, scripted_agent):
        agent = scripted_agent(
            _batch(_call("knowledge_search", "a", query="a"), _call("ris_search_tool", "b", query="b")),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert _batches(RAN, 2) == [{"knowledge_search:a", "ris_search_tool:b"}]
        assert all(m.content != _FANOUT_DROPPED_MESSAGE for m in _tool_messages(result))

    async def test_interaction_tools_are_never_the_call_that_is_dropped(self, scripted_agent):
        """`emit_card` and `remember` are the answer's output channel, not
        searches. They have their own allowance and the cap must not reach
        them — nor may they push a real search over the limit."""
        agent = scripted_agent(
            _batch(
                _call("emit_card", "x", kind="legal_basis"),
                _call("knowledge_search", "a", query="a"),
                _call("remember", "y", text="GK4"),
                _call("ris_search_tool", "b", query="b"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert _batches(RAN, 4) == [
            {"emit_card:legal_basis", "knowledge_search:a", "remember:GK4", "ris_search_tool:b"}
        ]
        assert all(m.content != _FANOUT_DROPPED_MESSAGE for m in _tool_messages(result))

    async def test_an_action_round_before_the_first_search_does_not_consume_round_zero(self, scripted_agent):
        """`retrieval_round` counts FETCHES. A card written first is not a
        layer of the spine, so the search that follows is still round zero —
        and is still capped."""
        agent = scripted_agent(
            _batch(_call("emit_card", "x", kind="legal_basis")),
            _batch(
                _call("knowledge_search", "a", query="a"),
                _call("ris_search_tool", "b", query="b"),
                _call("web_search_tool", "c", query="c"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        await _run(agent)

        assert _batches(RAN, 1, 2) == [{"emit_card:legal_basis"}, {"knowledge_search:a", "ris_search_tool:b"}]


class TestTheBudgetSurvives:
    async def test_the_capped_calls_are_not_charged(self, scripted_agent):
        """Charging the whole batch would leave the cap protecting nothing:
        the budget would be spent on calls whose only answer is a sentence."""
        agent = scripted_agent(
            _batch(
                _call("knowledge_search", "a", query="a"),
                _call("ris_search_tool", "b", query="b"),
                _call("web_search_tool", "c", query="c"),
                _call("knowledge_search", "d", query="d"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await _run(agent)

        assert result.tool_iterations == _ROUND_ZERO_SEARCH_LIMIT

    async def test_the_cap_is_reported_as_its_own_technical_event(self, scripted_agent, steps):
        """`status:budget` means "evidence-gathering was cut off". This is the
        opposite fact — the budget was PROTECTED — so it gets its own slot, or
        the frontend's name dedupe drops one of them on the turns that had both.
        """
        agent = scripted_agent(
            _batch(
                _call("knowledge_search", "a", query="a"),
                _call("ris_search_tool", "b", query="b"),
                _call("web_search_tool", "c", query="c"),
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        await _run(agent)

        (record,) = [step for step in steps if step.get("slot") == "budget:fanout"]
        assert record["step"] == "status:budget:fanout"
        assert (record["round"], record["kept"], record["dropped"]) == (0, 2, 1)
        assert record["channel"] == turn_status.CHANNEL_TECHNICAL

    @pytest.fixture
    def steps(self):
        """Every custom step pushed during the test, as parsed payloads."""
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


class TestTheLimitItself:
    def test_two_is_one_per_corpus_the_question_could_live_in(self):
        """Not a round number: before it has read anything the model knows only
        which corpora the question could be in, and one search per plausible
        corpus is the most that guess is worth."""
        assert _ROUND_ZERO_SEARCH_LIMIT == 2

    def test_the_notice_tells_the_model_what_to_do_next(self):
        """An error string would invite a retry of the same search."""
        assert "erste Runde" in _FANOUT_DROPPED_MESSAGE
        assert "gezielt nachsuchen" in _FANOUT_DROPPED_MESSAGE
