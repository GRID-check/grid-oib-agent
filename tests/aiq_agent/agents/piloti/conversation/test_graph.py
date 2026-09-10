"""Tests for the ConversationGraph.

Since ADR-0052 there is no classifier in front of the answering agent: every
turn enters ``shallow_research`` with the full tool set, and the shape of the
turn — a direct reply, a researched answer, a hand-off to deep research — is
read off Piloti's result AFTER the answer exists. The fixtures here
therefore seed the shallow path directly; nothing routes ahead of it.
"""

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.piloti.conversation import CONVERSATION_SCOPED_FIELDS
from aiq_agent.agents.piloti.conversation import TURN_SCOPED_FIELDS
from aiq_agent.agents.piloti.conversation import ConversationGraph
from aiq_agent.agents.piloti.markers import ESCALATION_MARKER
from aiq_agent.agents.piloti.models import ClarifyResult
from aiq_agent.agents.piloti.models import ConversationState
from aiq_agent.agents.piloti.models import ResearchAgentState


def _research_result(messages, answer: str, *, escalating: bool = False, direct: bool = False):
    """A Piloti result: the real state Piloti returns.

    ``direct`` models a reply that consulted no source and graded nothing — a
    greeting, a listing, an off-topic decline — which is what the observed
    routing reads as ``meta``.
    """
    return ResearchAgentState(
        messages=list(messages) + [AIMessage(content=answer + (f"\n{ESCALATION_MARKER}" if escalating else ""))],
        escalation_requested=escalating,
        source_lookup_attempted=not direct,
    )


class TestConversationGraph:
    """Tests for the ConversationGraph class."""

    @pytest.fixture
    def mock_research(self):
        """A research function that answers with sources."""

        async def research(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            return _research_result(messages, "Here's a quick answer with sources.")

        return research

    @pytest.fixture
    def mock_deep_research(self):
        """Create a mock deep research function."""

        async def deep(state):
            return DeepResearchAgentState(
                messages=list(state.messages)
                + [
                    AIMessage(content="Here's a comprehensive report."),
                ]
            )

        return deep

    @pytest.fixture
    def mock_clarifier(self):
        """A clarification step that asked its questions and got a plan approved."""

        async def clarifier(request):
            return ClarifyResult(research_context="User clarified: technical focus", outcome="approved")

        return clarifier

    def test_init_with_defaults(self, mock_research, mock_deep_research, mock_clarifier):
        """Test ConversationGraph initialization with defaults."""
        agent = ConversationGraph(
            research_fn=mock_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        assert agent.graph is not None

    def test_graph_property(self, mock_research, mock_deep_research, mock_clarifier):
        """Test that graph property returns the compiled graph."""
        agent = ConversationGraph(
            research_fn=mock_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        assert agent.graph is not None

    def test_the_graph_has_no_classifier_and_starts_with_the_answering_agent(
        self, mock_research, mock_deep_research, mock_clarifier
    ):
        """ADR-0052: nothing classifies a turn before the answer.

        The compiled graph has no ``intent_classifier`` node, and the only edge
        out of START goes to ``shallow_research``.
        """
        agent = ConversationGraph(
            research_fn=mock_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        graph = agent.graph.get_graph()
        node_names = set(graph.nodes)
        assert "intent_classifier" not in node_names
        assert {"shallow_research", "clarifier", "deep_research"} <= node_names

        from_start = {edge.target for edge in graph.edges if edge.source == "__start__"}
        assert from_start == {"shallow_research"}

    @pytest.mark.asyncio
    async def test_a_direct_reply_is_observed_as_meta(self, mock_deep_research, mock_clarifier):
        """A greeting answered without a source lookup and without a
        self-assessment is a direct reply: ``routing_decision`` reads ``meta``."""

        async def direct_research(state_input):
            return _research_result(state_input.messages, "Hello! I'm an AI assistant.", direct=True)

        agent = ConversationGraph(
            research_fn=direct_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(messages=[HumanMessage(content="Hello!")])
        result = await agent.run(state, thread_id="test-thread")

        assert result.routing_decision == "meta"
        contents = [m.content for m in result.messages if isinstance(m, AIMessage)]
        assert "Hello! I'm an AI assistant." in contents

    @pytest.mark.asyncio
    async def test_run_shallow_research_flow(self, mock_research, mock_deep_research, mock_clarifier):
        """A researched answer (a source was consulted) is observed as shallow."""
        agent = ConversationGraph(
            research_fn=mock_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(messages=[HumanMessage(content="What is CUDA?")])
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None
        assert result.routing_decision == "shallow"

    @pytest.mark.asyncio
    async def test_run_deep_research_flow(self, mock_deep_research, mock_clarifier):
        """An escalating shallow result reaches deep research through the clarifier."""

        async def escalating_research(state_input):
            return _research_result(state_input.messages, "Partial answer.", escalating=True)

        agent = ConversationGraph(
            research_fn=escalating_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(
            messages=[HumanMessage(content="Compare CUDA vs OpenCL")],
        )
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None
        assert result.routing_decision == "deep"
        assert result.messages[-1].content == "Here's a comprehensive report."

    @pytest.mark.asyncio
    async def test_a_direct_reply_never_escalates(self, mock_clarifier):
        """A direct reply (a memory/`remember` request, a greeting) ends on the
        shallow path. Piloti owns `remember`; a deep-research job
        does not have it, and there is no classifier left to misroute the turn
        there anyway — only Piloti's own envelope can escalate."""
        deep_called = False

        async def direct_research(state_input):
            return _research_result(state_input.messages, "Notiert: die Firma heißt Grid and Partners.", direct=True)

        async def tracking_deep(state):
            nonlocal deep_called
            deep_called = True
            return DeepResearchAgentState(
                messages=list(state.messages)
                + [
                    AIMessage(content="Here's a comprehensive report."),
                ]
            )

        agent = ConversationGraph(
            research_fn=direct_research,
            deep_research_fn=tracking_deep,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(
            messages=[HumanMessage(content="Remember for the whole org: the firm is Grid and Partners")],
        )
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None
        assert deep_called is False, "a direct reply must not reach deep research"
        assert result.routing_decision == "meta"
        contents = [m.content for m in result.messages if isinstance(m, AIMessage)]
        assert any("Notiert" in c for c in contents), "Piloti should have answered"
        assert not any("comprehensive report" in c for c in contents)

    @pytest.mark.asyncio
    async def test_run_with_empty_messages(self, mock_research, mock_deep_research, mock_clarifier):
        """Test run() handles empty messages."""
        agent = ConversationGraph(
            research_fn=mock_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(messages=[])
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None

    @pytest.mark.asyncio
    async def test_run_without_thread_id(self, mock_deep_research, mock_clarifier):
        """Test run() works without thread_id."""

        async def direct_research(state_input):
            return _research_result(state_input.messages, "Hi there!", direct=True)

        agent = ConversationGraph(
            research_fn=direct_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(messages=[HumanMessage(content="Hi")])
        result = await agent.run(state)

        assert result is not None

    @pytest.mark.asyncio
    async def test_run_propagates_data_sources(self, mock_deep_research, mock_clarifier):
        """Test that run() propagates data_sources to Piloti."""
        captured_state = {}

        async def capturing_research(state_input):
            captured_state["data_sources"] = state_input.data_sources
            return _research_result(state_input.messages, "Hello!", direct=True)

        agent = ConversationGraph(
            research_fn=capturing_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(
            messages=[HumanMessage(content="Hello!")],
            data_sources=["gdrive", "confluence"],
        )
        await agent.run(state, thread_id="test-thread")

        assert captured_state["data_sources"] == ["gdrive", "confluence"]

    @pytest.mark.asyncio
    async def test_run_propagates_collection_scope(self, mock_deep_research, mock_clarifier):
        """Test that run() propagates collection_scope into the graph state."""

        async def direct_research(state_input):
            return _research_result(state_input.messages, "Hello!", direct=True)

        agent = ConversationGraph(
            research_fn=direct_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(
            messages=[HumanMessage(content="Hello!")],
            collection_scope=["oib_knowledge", "proj_project-1", "s_conv-1"],
        )
        result = await agent.run(state, thread_id="test-thread")

        assert result.collection_scope == ["oib_knowledge", "proj_project-1", "s_conv-1"]

    @pytest.mark.asyncio
    async def test_run_propagates_none_data_sources(self, mock_deep_research, mock_clarifier):
        """Test that run() propagates None data_sources correctly."""
        captured_state = {}

        async def capturing_research(state_input):
            captured_state["data_sources"] = state_input.data_sources
            return _research_result(state_input.messages, "Hello!", direct=True)

        agent = ConversationGraph(
            research_fn=capturing_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(
            messages=[HumanMessage(content="Hello!")],
            data_sources=None,
        )
        await agent.run(state, thread_id="test-thread")

        assert captured_state["data_sources"] is None

    @pytest.mark.asyncio
    async def test_run_propagates_empty_data_sources(self, mock_deep_research, mock_clarifier):
        """Test that run() propagates empty data_sources list."""
        captured_state = {}

        async def capturing_research(state_input):
            captured_state["data_sources"] = state_input.data_sources
            return _research_result(state_input.messages, "Hello!", direct=True)

        agent = ConversationGraph(
            research_fn=capturing_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ConversationState(
            messages=[HumanMessage(content="Hello!")],
            data_sources=[],
        )
        await agent.run(state, thread_id="test-thread")

        assert captured_state["data_sources"] == []

    @pytest.mark.asyncio
    async def test_piloti_sets_the_listing_shelf_from_the_query(self, mock_deep_research, mock_clarifier):
        """A shelf named in the question is the one the inventory prints in
        full this turn. Piloti sets it as a ContextVar before the
        Piloti runs, so the prompt renderer sees it."""
        from aiq_agent.knowledge.inventory import Shelf
        from aiq_agent.knowledge.inventory import get_listing_shelf

        seen: dict[str, object] = {}

        async def observing_research(state_input):
            seen["shelf"] = get_listing_shelf()
            return _research_result(state_input.messages, "Im Büroarchiv liegen drei Dateien.", direct=True)

        agent = ConversationGraph(
            research_fn=observing_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        await agent.run(
            ConversationState(messages=[HumanMessage(content="welche Dateien hast du im Büroarchiv")]),
            thread_id="t",
        )
        assert seen["shelf"] == Shelf.ARCHIV

        await agent.run(
            ConversationState(messages=[HumanMessage(content="was sagt OIB-RL 2 zum Brandschutz")]),
            thread_id="t2",
        )
        assert seen["shelf"] is None


class TestRoutingBoundary:
    """Pins the shallow/deep split as the graph DOES it.

    There is no classification to route on any more: Piloti's own
    envelope is the only thing that can send a turn to deep research, and a
    turn it answers directly ends where it is.
    """

    @pytest.fixture
    def trackers(self):
        """Shallow/deep/clarifier call trackers plus their mock functions."""
        calls = {"research": False, "deep": False, "clarifier": False}

        def research_answering(answer: str, *, escalating: bool = False, direct: bool = False):
            async def research(state_input):
                calls["research"] = True
                messages = state_input.messages if hasattr(state_input, "messages") else state_input
                return _research_result(messages, answer, escalating=escalating, direct=direct)

            return research

        async def deep(state):
            calls["deep"] = True
            return DeepResearchAgentState(
                messages=list(state.messages) + [AIMessage(content="Here's a comprehensive report.")]
            )

        async def clarifier(request):
            calls["clarifier"] = True
            return ClarifyResult(research_context="clarified", outcome="approved")

        return calls, research_answering, deep, clarifier

    @pytest.mark.asyncio
    async def test_out_of_scope_is_answered_by_piloti(self, trackers):
        """An off-topic question is Piloti's to decline — there is
        no fixed redirect ahead of it any more. It declines without a source
        lookup, so the turn is observed as a direct reply; no clarifier, no
        deep research."""
        calls, research_answering, deep, clarifier = trackers

        agent = ConversationGraph(
            research_fn=research_answering("Das liegt außerhalb meines Fachgebiets. …", direct=True),
            deep_research_fn=deep,
            clarifier_fn=clarifier,
        )
        state = ConversationState(messages=[HumanMessage(content="How do I bake a cake?")])
        result = await agent.run(state, thread_id="t")

        assert calls["research"] is True, "Piloti answers every turn, off-topic ones included"
        assert calls["deep"] is False
        assert calls["clarifier"] is False
        assert result.routing_decision == "meta"
        contents = [m.content for m in result.messages if isinstance(m, AIMessage)]
        assert any("Fachgebiet" in c for c in contents)

    @pytest.mark.asyncio
    async def test_well_specified_shallow_answers_without_overclarifying(self, trackers):
        """Guardrail against over-correction: a normal, well-specified OIB
        question is answered directly — no clarifier, no deep escalation."""
        calls, research_answering, deep, clarifier = trackers

        agent = ConversationGraph(
            research_fn=research_answering("Here's a quick answer with sources."),
            deep_research_fn=deep,
            clarifier_fn=clarifier,
        )
        state = ConversationState(messages=[HumanMessage(content="Was regelt die OIB-Richtlinie 2?")])
        result = await agent.run(state, thread_id="t")

        assert calls["research"] is True
        assert calls["clarifier"] is False, "a well-specified shallow question must not be sent to the clarifier"
        assert calls["deep"] is False
        assert result.routing_decision == "shallow"

    @pytest.mark.asyncio
    async def test_an_escalating_shallow_result_routes_through_clarifier(self, trackers):
        """A shallow answer that asks for deep research goes through the
        clarifier (the HITL push-back point) before deep research runs."""
        calls, research_answering, deep, clarifier = trackers

        agent = ConversationGraph(
            research_fn=research_answering("Das braucht eine breitere Recherche.", escalating=True),
            deep_research_fn=deep,
            clarifier_fn=clarifier,
        )
        state = ConversationState(
            messages=[HumanMessage(content="Vergleiche die OIB-2-Anforderungen über alle Gebäudeklassen")],
        )
        result = await agent.run(state, thread_id="t")

        assert calls["research"] is True, "every turn starts with the answering agent"
        assert calls["clarifier"] is True, "an escalation must pass through the clarifier"
        assert calls["deep"] is True
        assert result.routing_decision == "deep"


class TestAppendContextMessage:
    """Ingest-only context (ADR-0034 addendum): the agent SEES it, without answering.

    The gap this closes: suppressing the agent by not invoking it left its history —
    the LangGraph checkpoint — with a hole where the colleague's turn should be, so
    "@Piloti given that, recheck" referred to nothing.
    """

    @pytest.fixture
    def trackers(self):
        """Fake agent fns that record whether they were ever reached."""
        calls: list[str] = []

        async def research(state_input):
            calls.append("research")
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            return _research_result(messages, "Quick answer.")

        async def deep(state):
            calls.append("deep")
            return DeepResearchAgentState(messages=list(state.messages))

        return calls, research, deep

    def _agent(self, trackers) -> ConversationGraph:
        from langgraph.checkpoint.memory import InMemorySaver

        _calls, research, deep = trackers
        return ConversationGraph(
            research_fn=research,
            deep_research_fn=deep,
            clarifier_fn=None,
            checkpointer=InMemorySaver(),
        )

    @pytest.mark.asyncio
    async def test_appends_to_the_checkpoint_without_running_a_node(self, trackers):
        """No node, therefore no LLM, therefore no token — suppression stays free."""
        calls, *_ = trackers
        agent = self._agent(trackers)

        await agent.append_context_message("conv-1", "Anna Weber: Ja, eigener Abschnitt.")

        snapshot = await agent.graph.aget_state({"configurable": {"thread_id": "conv-1"}})
        assert [m.content for m in snapshot.values["messages"]] == ["Anna Weber: Ja, eigener Abschnitt."]
        assert calls == []

    @pytest.mark.asyncio
    async def test_the_next_real_turn_sees_the_ingested_context(self, trackers):
        """THE POINT: "given that" now refers to something."""
        calls, *_ = trackers
        agent = self._agent(trackers)

        # 1. Matthias asks Piloti.
        await agent.run(
            ConversationState(messages=[HumanMessage(content="Ist das Atrium ein eigener Abschnitt?")]),
            thread_id="conv-1",
        )
        # 2/3. Matthias tags Anna, Anna answers — neither is an agent turn. Measured
        # as a DELTA over turn 1's calls: what matters is that ingestion adds none.
        after_turn_one = list(calls)
        await agent.append_context_message("conv-1", "Matthias Bigl: @Anna Weber weißt du das?")
        await agent.append_context_message("conv-1", "Anna Weber: Ja, laut Einreichplan eigener Abschnitt.")
        assert calls == after_turn_one, "ingestion must not have run a single node"

        # 4. Matthias asks Piloti to recheck.
        seen: list[str] = []

        async def capture_research(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            seen.extend(str(m.content) for m in messages)
            return _research_result(messages, "Neu geprüft.")

        agent.research_fn = capture_research
        await agent.run(
            ConversationState(messages=[HumanMessage(content="@Piloti given that, recheck")]),
            thread_id="conv-1",
        )

        assert "Anna Weber: Ja, laut Einreichplan eigener Abschnitt." in seen
        assert "Matthias Bigl: @Anna Weber weißt du das?" in seen

    @pytest.mark.asyncio
    async def test_a_missing_thread_or_text_is_a_no_op(self, trackers):
        calls, *_ = trackers
        agent = self._agent(trackers)

        await agent.append_context_message("", "Anna: ja")
        await agent.append_context_message("conv-1", "")

        snapshot = await agent.graph.aget_state({"configurable": {"thread_id": "conv-1"}})
        assert snapshot.values == {} or not snapshot.values.get("messages")
        assert calls == []


async def _unused(state):  # pragma: no cover - the route never reaches it
    raise AssertionError("must not be called")


class TestTurnBoundary:
    """What ``run()`` resets and what it keeps, derived from the model rather
    than hand-listed — a field missing from a hand-written reset dict persisted
    silently across turns via the checkpoint, and ``in_flight_documents`` was
    such a field: set by the register on every turn and never reaching the graph.
    """

    def test_the_reset_set_is_every_field_that_is_not_conversation_scoped(self):
        assert CONVERSATION_SCOPED_FIELDS == {"messages", "deep_research_declined"}
        assert TURN_SCOPED_FIELDS == set(ConversationState.model_fields) - CONVERSATION_SCOPED_FIELDS

    @pytest.mark.asyncio
    async def test_in_flight_documents_reach_piloti(self):
        seen: dict[str, object] = {}

        async def research(state_input):
            seen["in_flight"] = state_input.in_flight_documents
            return _research_result(state_input.messages, "Die Datei wird noch gelesen.", direct=True)

        agent = ConversationGraph(research_fn=research, deep_research_fn=_unused, clarifier_fn=None)
        await agent.run(
            ConversationState(messages=[HumanMessage(content="Was steht im Plan?")], in_flight_documents=["plan.pdf"]),
            thread_id="t",
        )

        assert seen["in_flight"] == ["plan.pdf"]

    @pytest.mark.asyncio
    async def test_run_returns_the_typed_state(self):
        async def research(state_input):
            return _research_result(state_input.messages, "Antwort [1].")

        agent = ConversationGraph(research_fn=research, deep_research_fn=_unused, clarifier_fn=None)
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Was gilt?")]), thread_id="t")
        assert isinstance(result, ConversationState)


class TestEscalation:
    """The one bit the escalation edge and the clarifier read."""

    def test_only_an_explicit_ask_escalates(self):
        assert ConversationState(messages=[], escalate_to_deep=True).escalate_to_deep is True
        assert not ConversationState(messages=[], escalate_to_deep=False).escalate_to_deep
        assert not ConversationState(messages=[]).escalate_to_deep

    @pytest.mark.asyncio
    async def test_insufficiency_prose_alone_is_not_an_ask(self):
        """A hedging answer that did NOT set the structured ask ends the turn.

        German legal hedging in a successful answer ("nicht finden", "weitere
        Recherche erforderlich") false-positived a substring match and
        surprise-escalated good answers; the ask is structured for that reason.
        """

        async def research(state_input):
            return _research_result(state_input.messages, "Ich konnte keine Informationen dazu finden.")

        agent = ConversationGraph(research_fn=research, deep_research_fn=_unused, clarifier_fn=_unused)
        result = await agent.run(ConversationState(messages=[HumanMessage(content="Was gilt?")]), thread_id="t")

        assert not result.escalate_to_deep
        assert result.routing_decision == "shallow"
