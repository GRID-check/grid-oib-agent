"""How much of a Richtlinien-Familie a turn actually read.

"OIB-Richtlinie 2" is four documents — 2, 2.1 (Betriebsbauten), 2.2 (Garagen),
2.3 (Hochhäuser). An overview answer that opened three of them reads exactly
like one that opened all four: the prose is fluent, every citation resolves,
and the missing part is missing in the one way nothing checks. The inventory
knows the family, the source registry knows what was read, and until
`status:coverage` the difference was not countable.

The test goes through the COMPILED GRAPH with a scripted LLM and a real tool,
because the two halves of this live at opposite ends of a turn: the family list
is set at inventory time and the sources are captured as the tools node runs,
and only a run that does both can fail on a mismatch between them.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.researcher.agent import ResearcherAgent
from aiq_agent.agents.researcher.agent import _opened_documents
from aiq_agent.agents.researcher.models import ResearchAgentState
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.data_source_registry import populate_from_config
from aiq_agent.common.data_source_registry import reset_registry
from aiq_agent.common.norm_registry import oib_families
from aiq_agent.knowledge.inventory import set_norm_families

#: The corpus these tests stand in front of: OIB-RL 2 in three parts.
CORPUS = (
    "oib-rl_2_ausgabe_mai_2023.pdf",
    "oib-rl_2.1_ausgabe_mai_2023.pdf",
    "oib-rl_2.2_ausgabe_mai_2023.pdf",
)

#: Which document each scripted search returns, keyed by the query.
RETURNS: dict[str, str] = {}


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    name = RETURNS.get(query, "")
    if not name:
        return "No relevant documents found."
    return (
        f"Found 1 relevant document(s):\n\n--- Result 1 ---\n"
        f"Source: {name}\nCollection: oib_knowledge\nShelf: base\n"
        f"Citation: {name}, p.4\nContent Type: text\nRelevance Score: 0.90\n\nText.\n"
    )


@pytest.fixture(autouse=True)
def _clean_slate():
    RETURNS.clear()
    set_norm_families(oib_families(CORPUS))
    reset_registry()
    populate_from_config(
        [
            {
                "id": "knowledge_layer",
                "name": "Knowledge Base",
                "description": "Search uploaded documents and files.",
                "tools": ["knowledge_search"],
            }
        ]
    )
    yield
    RETURNS.clear()
    set_norm_families(None)
    reset_registry()
    turn_status._retrieval_round.set(None)


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
    with (
        patch("aiq_agent.agents.researcher.answer_pipeline.verify_citations") as verify,
        patch("aiq_agent.agents.researcher.answer_pipeline.sanitize_report") as sanitize,
    ):
        verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
            verified_report=content, removed_citations=[]
        )
        sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
        yield


@pytest.fixture
def steps():
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


@pytest.fixture
def scripted_agent():
    def build(*rounds: AIMessage) -> ResearcherAgent:
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(side_effect=list(rounds))
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        return ResearcherAgent(llm_provider=provider, tools=[knowledge_search], max_tool_iterations=7)

    return build


def _search(call_id: str, query: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {"query": query}, "id": call_id}])


def _coverage(steps: list[dict]) -> list[tuple[str, int, int]]:
    return [
        (step["family"], step["listed"], step["opened"])
        for step in steps
        if str(step.get("slot", "")).startswith("coverage")
    ]


class TestCoverageIsCounted:
    async def test_two_of_three_members_report_listed_three_opened_two(self, scripted_agent, steps):
        """The failure this exists for, made countable."""
        RETURNS.update({"Brandabschnitte": CORPUS[0], "Betriebsbauten": CORPUS[1]})
        agent = scripted_agent(
            _search("a", "Brandabschnitte"),
            _search("b", "Betriebsbauten"),
            AIMessage(content="Die Antwort [1]."),
        )

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Was weißt du über die OIB 2?")]))

        assert _coverage(steps) == [("2", 3, 2)]

    async def test_reading_every_member_reports_a_complete_family(self, scripted_agent, steps):
        RETURNS.update({"a": CORPUS[0], "b": CORPUS[1], "c": CORPUS[2]})
        agent = scripted_agent(
            _search("1", "a"),
            _search("2", "b"),
            _search("3", "c"),
            AIMessage(content="Die Antwort [1]."),
        )

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Was weißt du über die OIB 2?")]))

        assert _coverage(steps) == [("2", 3, 3)]

    async def test_a_turn_that_touched_no_family_reports_nothing(self, scripted_agent, steps):
        """A constant is not an event. Six records on a question about the
        office's own plan would make the rate noise as well as meaningless."""
        RETURNS.update({"Fluchtwege im Plan": "Brandschutzplan_EG.pdf"})
        agent = scripted_agent(_search("a", "Fluchtwege im Plan"), AIMessage(content="Die Antwort [1]."))

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Was steht im Brandschutzplan?")]))

        assert _coverage(steps) == []

    async def test_it_is_the_technical_channel_and_carries_no_filenames(self, scripted_agent, steps):
        RETURNS.update({"a": CORPUS[0]})
        agent = scripted_agent(_search("1", "a"), AIMessage(content="Die Antwort [1]."))

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="OIB 2?")]))

        (record,) = [step for step in steps if str(step.get("slot", "")).startswith("coverage")]
        assert record["channel"] == turn_status.CHANNEL_TECHNICAL
        assert set(record) == {"step", "kind", "channel", "slot", "family", "listed", "opened"}
        assert "oib-rl" not in json.dumps(record)

    async def test_each_family_gets_its_own_step_name(self, scripted_agent, steps):
        """Two families under one step name collapse into one under the
        frontend's dedupe, the same trap `status:checkpoint:N` avoids."""
        set_norm_families(oib_families([*CORPUS, "oib-rl_4_ausgabe_mai_2023.pdf"]))
        RETURNS.update({"a": CORPUS[0], "b": "oib-rl_4_ausgabe_mai_2023.pdf"})
        agent = scripted_agent(_search("1", "a"), _search("2", "b"), AIMessage(content="Die Antwort [1]."))

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="OIB 2 und 4?")]))

        names = [step["step"] for step in steps if str(step.get("slot", "")).startswith("coverage")]
        assert names == ["status:coverage:2", "status:coverage:4"]


class TestWhatCountsAsOpened:
    """The citation key is the identity plus rendering. Both come off."""

    def test_a_page_suffix_is_not_part_of_the_name(self):
        assert _opened_documents([SourceEntry(citation_key="oib-rl_2.1_x.pdf, p.12")]) == {"oib-rl_2.1_x.pdf"}

    def test_a_shelf_qualifier_is_not_part_of_the_name(self):
        """One filename on two shelves is qualified in the key it prints."""
        assert _opened_documents([SourceEntry(citation_key="Plan.pdf (Projektwissen), p.3")]) == {"Plan.pdf"}

    def test_a_url_source_contributes_no_document(self):
        assert _opened_documents([SourceEntry(url="https://example.com")]) == set()


class TestFailOpen:
    async def test_a_broken_family_list_does_not_take_the_turn_down(self, scripted_agent, steps):
        """A count of the answer is worth strictly less than the answer."""
        set_norm_families([object()])
        RETURNS.update({"a": CORPUS[0]})
        agent = scripted_agent(_search("1", "a"), AIMessage(content="Die Antwort [1]."))

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="OIB 2?")]))

        assert result is not None
        assert _coverage(steps) == []
