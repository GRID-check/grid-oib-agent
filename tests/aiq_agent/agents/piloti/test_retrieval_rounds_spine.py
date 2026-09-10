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

import json
from pathlib import Path
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

REPO_ROOT = Path(__file__).resolve().parents[4]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "herleitung" / "two_search_rounds_steps.json"

#: What each tool call saw in the round stamp, in execution order. Module level
#: because a LangChain ``@tool`` is a module-level object; cleared per test.
SEEN: list[tuple[str, int | None]] = []


@tool
def knowledge_search(query: str) -> str:
    """Search the OIB knowledge corpus."""
    SEEN.append(("knowledge_search", current_retrieval_round()))
    return f"Treffer zu: {query}"


@tool
def read_passage(document: str, punkt: str = "") -> str:
    """Open a named passage of a named document."""
    SEEN.append(("read_passage", current_retrieval_round()))
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


class TestCheckpointRate:
    """The spine's layer is drawn per round; its BODY only when the model wrote one."""

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

    @pytest.mark.asyncio
    async def test_a_turn_reports_a_checkpoint_per_round_and_whether_it_had_a_body(self, scripted_agent, steps):
        agent = scripted_agent(
            _search("k1", "Fluchtweglänge GK4", "Ich brauche zuerst die Grundregel."),
            _search("k2", "Treppenraum", ""),
            AIMessage(content="Die Antwort [1]."),
        )

        await agent.run(ResearchAgentState(messages=[HumanMessage(content="Wie lang?")]))

        checkpoints = [step for step in steps if str(step.get("slot", "")).startswith("checkpoint")]
        assert [(c["round"], c["hasConclusion"]) for c in checkpoints] == [(0, True), (1, False)], (
            "a two-round turn must leave two countable checkpoint records, one per layer of the "
            f"spine; steps were {[s.get('step') for s in steps]}"
        )
        # Two records, not one merged step: the frontend dedupes on the step
        # name, and a spine of N rounds reporting one checkpoint is not a rate.
        assert [c["step"] for c in checkpoints] == ["status:checkpoint:0", "status:checkpoint:1"]

    @pytest.mark.asyncio
    async def test_the_slot_wins_over_the_prose_through_the_whole_graph(self, scripted_agent, steps):
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

        checkpoints = [step for step in steps if str(step.get("slot", "")).startswith("checkpoint")]
        assert [(c["round"], c["hasConclusion"], c["source"]) for c in checkpoints] == [
            (0, False, "none"),
            (1, True, "argument"),
        ]
        rendered = [step["reason"] for step in steps if str(step.get("slot", "")).startswith("retrieval:1")]
        assert rendered == ["Die Grundregel steht; offen ist der GK."]


# --- The cross-language fixture ---------------------------------------------


def _lanes_for_round(round_index: int, chunks) -> list[dict]:
    """The Trace-Lanes lanes one fetch produces, stamped as the tools node stamps them."""
    from sources.knowledge_layer.src.register import _trace_lanes_json

    with turn_status.retrieval_round_scope(round_index):
        # Empty resolution maps rather than the process-global document store:
        # this fixture must not depend on whichever database another test
        # configured first.
        return json.loads(_trace_lanes_json(chunks, resolved={}, resolved_titles={}))["lanes"]


def _merge_lanes(*lane_groups: list[dict]) -> list[dict]:
    """Both fetches as ONE step, the way the frontend store merges them.

    The store keys thinking steps by function name, so the second
    ``knowledge_search`` completion lands on the step the first one created and
    the lane buckets are merged by key. That merge is precisely why stream order
    cannot separate two fetches — and why every hit carries its own ``round``.
    """
    merged: dict[str, dict] = {}
    for lanes in lane_groups:
        for lane in lanes:
            bucket = merged.setdefault(lane["key"], {**lane, "hitCount": 0, "sources": []})
            bucket["hitCount"] += lane["hitCount"]
            bucket["sources"].extend(lane["sources"])
    return list(merged.values())


def _chunk(*, file_name: str, page: int, collection: str, shelf: str | None = None):
    from types import SimpleNamespace

    metadata: dict[str, str] = {"collection": collection}
    if shelf:
        metadata["shelf"] = shelf
    return SimpleNamespace(
        file_name=file_name,
        page_number=page,
        content="snippet",
        content_type=SimpleNamespace(value="text"),
        score=0.9,
        metadata=metadata,
    )


def build_two_search_round_steps() -> list[dict]:
    """The thinking steps two search rounds produce, from the REAL producers.

    Status payloads come from :mod:`aiq_agent.common.turn_status`; the
    Trace-Lanes hits from the knowledge layer's own ``_trace_lanes_json``, each
    under the round stamp its fetch ran with. Nothing here is hand-written, so
    the fixture cannot quietly describe a wire nobody emits.
    """
    from nat.builder.context import ContextState
    from nat.utils.reactive.subject import Subject

    state = ContextState.get()
    previous_stack = state.active_span_id_stack.get()
    state.active_span_id_stack.set(["root"])
    state._event_stream.set(Subject())
    emitted: list[tuple[str, dict]] = []

    def _on_next(step) -> None:
        payload = step.payload
        body = getattr(payload.data, "input", None)
        if isinstance(body, str) and str(payload.event_type).endswith("START"):
            emitted.append((payload.name, json.loads(body)))

    state.event_stream.get().subscribe(_on_next)
    try:
        turn_status.emit_retrieval(
            [{"name": "knowledge_search", "args": {"query": "Fluchtweglänge GK4"}}],
            round_index=0,
            conclusion="Ich brauche zuerst die Grundregel für Fluchtweglängen.",
        )
        first = _lanes_for_round(0, [_chunk(file_name="OIB-RL_2.pdf", page=12, collection="oib_knowledge")])
        # Round 1 carries its checkpoint in the tool-call ARGUMENT, which is
        # what the prompt now asks for and what a tool-calling model actually
        # fills. Round 0 above carries prose, the fallback channel. One of each,
        # so the fixture pins both on the wire — and both reach the frontend as
        # the same `reason` field, which is why the walker needed no change.
        turn_status.emit_retrieval(
            [
                {
                    "name": "knowledge_search",
                    "args": {
                        "query": "Treppenraum Entrauchung",
                        "conclusion": "Die Grundregel steht; offen ist der Treppenraum.",
                    },
                }
            ],
            round_index=1,
        )
        second = _lanes_for_round(
            1,
            [_chunk(file_name="Brandschutzkonzept.pdf", page=4, collection="proj_abc", shelf="project")],
        )
    finally:
        state.active_span_id_stack.set(previous_stack or ["root"])
        state._event_stream.set(Subject())
        turn_status._retrieval_round.set(None)

    def status_step(name: str) -> dict:
        payload = next(body for step_name, body in emitted if step_name == name)
        return {
            "id": name,
            "category": "agents",
            "functionName": name,
            "displayName": name,
            "content": json.dumps(payload, ensure_ascii=False),
            "isComplete": True,
        }

    # Order is the wire's: the merged tool step keeps the position of the FIRST
    # completion, ahead of the second round's status line. Stream order would
    # therefore give round 1 no files at all — the `round` stamps are the only
    # thing that can split them.
    return [
        status_step("status:retrieval:0"),
        status_step("status:checkpoint:0"),
        {
            "id": "knowledge_search",
            "category": "tools",
            "functionName": "knowledge_search",
            "displayName": "knowledge_search",
            "content": "",
            "isComplete": True,
            "traceLanes": _merge_lanes(first, second),
        },
        status_step("status:retrieval:1"),
        status_step("status:checkpoint:1"),
    ]


class TestTheSharedFixtureIsCurrent:
    """Pin the spine's wire for the frontend, which cannot run in this process.

    ``tests/fixtures/herleitung/two_search_rounds_steps.json`` is a sample of
    what a two-round turn puts on the wire, produced by the real emitters here.
    Its consumer is the frontend round walker,
    ``frontends/ui/src/features/chat/lib/retrieval-rounds.ts``, exercised by
    ``retrieval-rounds.spec.ts`` (which today builds its steps by hand): a spec
    loading this file gets rounds 0 and 1 with one document each, and gets them
    from the backend's own bytes instead of a copy written to match the parser.

    Change the wire and exactly one side fails — which is the point. When the
    change is intended, rewrite the fixture from
    :func:`build_two_search_round_steps` and then run the frontend spec.
    """

    def test_the_fixture_is_what_the_emitters_produce(self):
        assert json.loads(FIXTURE.read_text(encoding="utf-8")) == build_two_search_round_steps()

    def test_the_fixture_splits_the_two_fetches_by_round_and_not_by_order(self):
        """The property the frontend depends on, asserted on the file itself."""
        steps = json.loads(FIXTURE.read_text(encoding="utf-8"))
        (tool_step,) = [step for step in steps if step["functionName"] == "knowledge_search"]
        hits = [(source["name"], source.get("round")) for lane in tool_step["traceLanes"] for source in lane["sources"]]
        assert sorted(hits) == [("Brandschutzkonzept.pdf", 1), ("OIB-RL_2.pdf", 0)]
        # …and it sits AHEAD of round 1's status line, so stream order alone
        # would hand round 1 nothing.
        names = [step["functionName"] for step in steps]
        assert names.index("knowledge_search") < names.index("status:retrieval:1")
