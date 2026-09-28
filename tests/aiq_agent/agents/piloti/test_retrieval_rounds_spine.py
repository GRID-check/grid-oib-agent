"""The Herleitung spine's round stamp — across the node boundary that broke it.

The stamp (``turn_status._retrieval_round``) is read by the knowledge layer
while a TOOL runs, and it used to be set by ``emit_retrieval`` while the AGENT
node ran. LangGraph runs every node in a task built with ``copy_context()``, so
the tools node never saw it: every hit shipped unstamped and the frontend fell
back to stream order, which files both fetches of a two-round turn onto the
first checkpoint.

Which means the test for it CANNOT be a unit test of either side. A test that
sets the ContextVar and calls the reader passes on the broken code — that is
exactly ``test_trace_lanes.py::test_trace_lanes_sources_carry_the_retrieval_round``,
which was green throughout. The only test that can fail on the defect goes
through the COMPILED GRAPH with a real ToolNode and reads the stamp from inside
a tool, which is what :class:`TestTheRoundStampReachesTheTool` does.
"""

from __future__ import annotations

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
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.turn_status import current_retrieval_round

#: What each tool call saw in the round stamp, in execution order. Module level
#: because a LangChain ``@tool`` is a module-level object; cleared per test.
SEEN: list[tuple[str, int | None]] = []


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    SEEN.append(("knowledge_search", current_retrieval_round()))
    # What the real emitter does inside the tool's formatter. Recorded here so
    # the compiled-graph test below can prove the capture begun in run()
    # reaches a tool task and its hits join the announced round.
    turn_status.record_lane_hit(f"{query}.pdf", title=f"Treffer zu {query}")
    return f"Treffer zu: {query}"


@tool
def read_passage(document: str, punkt: str = "") -> str:
    """Open a named passage of a named document."""
    SEEN.append(("read_passage", current_retrieval_round()))
    turn_status.record_lane_hit(f"{document}.pdf", detail=f"p.{punkt}" if punkt else None)
    return f"{document}, Pkt. {punkt}"


@tool
def remember(text: str) -> str:
    """Store a durable fact about this project."""
    SEEN.append(("remember", current_retrieval_round()))
    return "gemerkt"


@pytest.fixture(autouse=True)
def _clean_slate():
    SEEN.clear()
    turn_status._retrieval_round.set(None)
    yield
    SEEN.clear()
    turn_status._retrieval_round.set(None)


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
            tools=[knowledge_search, read_passage, remember],
            max_tool_iterations=6,
        )

    return build


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


def _search(call_id: str, query: str, thought: str = "") -> AIMessage:
    return AIMessage(
        content=thought,
        tool_calls=[{"name": "knowledge_search", "args": {"query": query}, "id": call_id}],
    )


class TestTheRoundStampReachesTheTool:
    """Through the compiled graph, read from inside the running tool."""

    @pytest.mark.asyncio
    async def test_each_search_round_stamps_its_own_number(self, scripted_agent):
        agent = scripted_agent(
            _search("k1", "Fluchtweglänge GK4", "Ich brauche zuerst die Grundregel."),
            AIMessage(content="", tool_calls=[{"name": "remember", "args": {"text": "GK4"}, "id": "r1"}]),
            _search("k2", "Treppenraum Entrauchung", "Die Grundregel steht; jetzt der Treppenraum."),
            AIMessage(content="Die Antwort [1]."),
        )

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang darf der Fluchtweg sein?")]))

        assert SEEN == [
            ("knowledge_search", 0),
            # An action round is not a layer of the spine. Stamping it with the
            # previous fetch's number would file a memory write under the search
            # before it.
            ("remember", None),
            ("knowledge_search", 1),
        ], (
            "the round stamp did not survive the agent→tools node boundary "
            "(LangGraph copies the context per node), so every hit ships "
            f"unstamped and the Herleitung falls back to stream order; saw {SEEN}"
        )

    @pytest.mark.asyncio
    async def test_a_search_then_a_locator_are_two_layers_of_one_spine(self, scripted_agent):
        """The shape the locator exists to make possible.

        Round 0 searches, the conclusion names a Punkt, round 1 OPENS it. Both
        are fetches, so both are layers — and each is stamped with its own
        number, or the Herleitung files the located passage under the search
        that only pointed at it.
        """
        agent = scripted_agent(
            _search("k1", "Fluchtweglänge GK4", "Ich brauche zuerst die Grundregel."),
            AIMessage(
                content="Die Grundregel verweist auf Pkt. 3.5.2; den habe ich noch nicht gelesen.",
                tool_calls=[
                    {
                        "name": "read_passage",
                        "args": {"document": "OIB-Richtlinie 2", "punkt": "3.5.2"},
                        "id": "p1",
                    }
                ],
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang darf der Fluchtweg sein?")]))

        assert SEEN == [("knowledge_search", 0), ("read_passage", 1)]

    @pytest.mark.asyncio
    async def test_the_stamp_does_not_outlive_the_turn(self, scripted_agent):
        agent = scripted_agent(_search("k1", "Geländerhöhe"), AIMessage(content="Die Antwort [1]."))

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie hoch?")]))

        assert current_retrieval_round() is None


class TestSynthesisAnnouncement:
    """The live line during the answer write: `status:synthesis`, once per researched turn.

    Without it the line keeps showing the last retrieval event through the
    whole synthesis call — the stale-label fault the legacy path fixed by
    never letting a finished step drive the phrase, reintroduced by events
    that never complete.
    """

    @pytest.mark.asyncio
    async def test_a_researched_turn_announces_synthesis_once(self, scripted_agent, emitted):
        """One synthesis event per researched turn, keyed for the live line."""
        agent = scripted_agent(
            _search("k1", "Fluchtweglänge GK4"),
            AIMessage(content="Die Antwort [1]."),
        )

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang?")]))

        syntheses = [step for step in emitted.steps if step.id == "status:synthesis"]
        assert [step.key for step in syntheses] == ["status.synthesis"]

    @pytest.mark.asyncio
    async def test_a_direct_reply_announces_no_synthesis(self, scripted_agent, emitted):
        """A reply with no tool work announces no synthesis phase."""
        agent = scripted_agent(AIMessage(content="Hallo!"))

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Hallo?")]))

        assert [step for step in emitted.steps if step.id == "status:synthesis"] == []


class TestTheLaneCaptureReachesTheLedger:
    """Capture begun in ``run()`` must be visible to the TOOL task.

    The round-stamp hazard above applies to the capture list too: it is a
    ContextVar created in ``run()`` and mutated from inside tool tasks, and a
    unit test that calls an emitter in the same context that began the capture
    passes on broken propagation. The only test that can fail on that defect
    goes through the compiled graph with a real ToolNode — which is this one.
    """

    @pytest.mark.asyncio
    async def test_a_tools_hits_join_their_round_in_the_ledger(self, scripted_agent):
        """Hits recorded inside the tool task join their round — the ContextVar crossed the node boundary."""
        agent = scripted_agent(
            _search("k1", "OIB 2", "Ich brauche zuerst die Grundregel."),
            AIMessage(
                content="Die Grundregel steht; den Punkt noch nicht gelesen.",
                tool_calls=[{"name": "read_passage", "args": {"document": "OIB 2", "punkt": "3.5.2"}, "id": "p1"}],
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Was weißt du über die OIB 2?")]))

        ledger = result.retrieval_ledger
        assert ledger is not None, (
            "the tools' hits never reached the ledger — the capture did not cross the node boundary"
        )
        assert [entry["index"] for entry in ledger] == [0, 1]
        # Round 0 found the document; round 1 opened the same file at a Punkt.
        assert ledger[0]["docs"][0]["name"] == "OIB 2.pdf"
        assert ledger[1]["docs"] == [{"name": "OIB 2.pdf", "detail": "p.3.5.2", "repeat": False}]
        # Round 0 only RANKED the file; round 1 is the first to read into it,
        # so the open is work, not a re-fetch. The frontend folds the two
        # rounds' hits onto one card per document; „bereits abgerufen" is
        # reserved for the round that fetches a passage a second time.
        assert ledger[1]["new_docs"] == ["OIB 2.pdf"]

    @pytest.mark.asyncio
    async def test_the_capture_does_not_outlive_the_turn(self, scripted_agent):
        """The capture window closes with the turn; nothing leaks across turns."""
        agent = scripted_agent(_search("k1", "Geländerhöhe"), AIMessage(content="Die Antwort [1]."))

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie hoch?")]))

        assert turn_status.get_lane_captures() == []


class TestCheckpointRate:
    """The spine's layer is drawn per round; its BODY only when the model wrote one."""

    @pytest.mark.asyncio
    async def test_a_turn_reports_a_checkpoint_per_round_and_whether_it_had_a_body(self, scripted_agent, emitted):
        agent = scripted_agent(
            _search("k1", "Fluchtweglänge GK4", "Ich brauche zuerst die Grundregel."),
            _search("k2", "Treppenraum", ""),
            AIMessage(content="Die Antwort [1]."),
        )

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang?")]))

        checkpoints = [step for step in emitted.steps if step.id.startswith("status:checkpoint")]
        assert [(c.detail["round"], c.detail["hasConclusion"]) for c in checkpoints] == [(0, True), (1, False)], (
            "a two-round turn must leave two countable checkpoint records, one per layer of the "
            f"spine; steps were {[step.id for step in emitted.steps]}"
        )
        # Two records, not one merged row: the same id replaces the row, and a
        # spine of N rounds reporting one checkpoint is not a rate.
        assert [c.id for c in checkpoints] == ["status:checkpoint:0", "status:checkpoint:1"]

    @pytest.mark.asyncio
    async def test_the_slot_wins_over_the_prose_through_the_whole_graph(self, scripted_agent, emitted):
        """The checkpoint the reader sees is the one the prompt asked for.

        Round 0 leaves the argument empty, which is what the prompt asks for on
        a first call, and writes no prose either — a bodyless layer. Round 1
        fills the argument AND narrates; the argument is what the spine renders
        and what the rate counts.
        """
        agent = scripted_agent(
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "knowledge_search", "args": {"query": "Fluchtweglänge GK4", "conclusion": ""}, "id": "k1"}
                ],
            ),
            AIMessage(
                content="Prosa nebenher.",
                tool_calls=[
                    {
                        "name": "knowledge_search",
                        "args": {"query": "Treppenraum", "conclusion": "Die Grundregel steht; offen ist der GK."},
                        "id": "k2",
                    }
                ],
            ),
            AIMessage(content="Die Antwort [1]."),
        )

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang?")]))

        checkpoints = [step for step in emitted.steps if step.id.startswith("status:checkpoint")]
        assert [(c.detail["round"], c.detail["hasConclusion"], c.detail["source"]) for c in checkpoints] == [
            (0, False, "none"),
            (1, True, "argument"),
        ]
        rendered = [step.reason for step in emitted.steps if step.id == "status:retrieval:1"]
        assert rendered == ["Die Grundregel steht; offen ist der GK."]
