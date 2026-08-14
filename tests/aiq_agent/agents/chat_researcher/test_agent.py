"""Tests for the ChatResearcherAgent."""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import DepthDecision
from aiq_agent.agents.chat_researcher.models import IntentResult
from aiq_agent.common.turn_attachments import SessionAttachment


class TestChatResearcherAgent:
    """Tests for the ChatResearcherAgent class."""

    @pytest.fixture
    def mock_intent_classifier(self):
        """Create a mock combined orchestration (intent + depth + meta) function."""

        async def classifier(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(
                    decision="shallow",
                    raw_reasoning="Simple query",
                ),
            }

        return classifier

    @pytest.fixture
    def mock_shallow_research(self):
        """Create a mock shallow research function."""

        async def shallow(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages) + [
                AIMessage(content="Here's a quick answer with sources."),
            ]
            return result

        return shallow

    @pytest.fixture
    def mock_deep_research(self):
        """Create a mock deep research function."""

        async def deep(state):
            result = MagicMock()
            result.messages = list(state.messages) + [
                AIMessage(content="Here's a comprehensive report."),
            ]
            return result

        return deep

    @pytest.fixture
    def mock_clarifier(self):
        """Create a mock clarifier function."""

        async def clarifier(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages)
            result.clarifier_log = "User clarified: technical focus"
            return result

        return clarifier

    def test_init_with_defaults(
        self,
        mock_intent_classifier,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test ChatResearcherAgent initialization with defaults."""
        agent = ChatResearcherAgent(
            intent_classifier_fn=mock_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        assert agent.enable_escalation is True
        assert agent.callbacks == []
        assert agent.graph is not None

    def test_init_with_escalation_disabled(
        self,
        mock_intent_classifier,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test ChatResearcherAgent initialization with escalation disabled."""
        agent = ChatResearcherAgent(
            intent_classifier_fn=mock_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
            enable_escalation=False,
        )

        assert agent.enable_escalation is False

    def test_init_with_callbacks(
        self,
        mock_intent_classifier,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test ChatResearcherAgent initialization with callbacks."""
        callbacks = [MagicMock()]
        agent = ChatResearcherAgent(
            intent_classifier_fn=mock_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
            callbacks=callbacks,
        )

        assert agent.callbacks == callbacks

    def test_graph_property(
        self,
        mock_intent_classifier,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test that graph property returns the compiled graph."""
        agent = ChatResearcherAgent(
            intent_classifier_fn=mock_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        assert agent.graph is not None

    @pytest.mark.asyncio
    async def test_run_meta_intent_flow(
        self,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test run() handles meta intent correctly (orchestration returns meta + messages)."""

        async def meta_intent_classifier(state):
            return {
                "user_intent": IntentResult(intent="meta", raw=None),
                "messages": [
                    AIMessage(content="Hello! I'm an AI assistant."),
                ],
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=meta_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(messages=[HumanMessage(content="Hello!")])
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None
        assert "messages" in result

    @pytest.mark.asyncio
    async def test_run_shallow_research_flow(
        self,
        mock_intent_classifier,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test run() handles shallow research flow (orchestration returns research + shallow)."""
        agent = ChatResearcherAgent(
            intent_classifier_fn=mock_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
            enable_escalation=False,
        )

        state = ChatResearcherState(messages=[HumanMessage(content="What is CUDA?")])
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None

    @pytest.mark.asyncio
    async def test_run_deep_research_flow(
        self,
        mock_intent_classifier,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test run() handles deep research flow (orchestration returns research + deep)."""

        async def deep_orchestration(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(
                    decision="deep",
                    raw_reasoning="Complex",
                ),
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=deep_orchestration,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(
            messages=[HumanMessage(content="Compare CUDA vs OpenCL")],
        )
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None

    @pytest.mark.asyncio
    async def test_meta_intent_with_deep_depth_stays_shallow(
        self,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """A meta turn (e.g. a memory/`remember` request) must route to the
        shallow agent — which owns the `remember` tool — even when the depth
        classifier says "deep". Regression for memory requests being misrouted
        into a deep-research job that lacks `remember`."""

        async def meta_deep_classifier(state):
            return {
                "user_intent": IntentResult(intent="meta", raw=None),
                "depth_decision": DepthDecision(
                    decision="deep",
                    raw_reasoning="Phrasing looked comprehensive",
                ),
            }

        deep_called = False

        async def tracking_deep(state):
            nonlocal deep_called
            deep_called = True
            result = MagicMock()
            result.messages = list(state.messages) + [
                AIMessage(content="Here's a comprehensive report."),
            ]
            return result

        agent = ChatResearcherAgent(
            intent_classifier_fn=meta_deep_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=tracking_deep,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(
            messages=[HumanMessage(content="Remember for the whole org: the firm is Grid and Partners")],
        )
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None
        assert deep_called is False, "meta turn must not reach deep research"
        contents = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert any("quick answer" in c for c in contents), "shallow agent should have answered"
        assert not any("comprehensive report" in c for c in contents)

    @pytest.mark.asyncio
    async def test_run_with_empty_messages(
        self,
        mock_intent_classifier,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test run() handles empty messages."""
        agent = ChatResearcherAgent(
            intent_classifier_fn=mock_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(messages=[])
        result = await agent.run(state, thread_id="test-thread")

        assert result is not None

    @pytest.mark.asyncio
    async def test_run_without_thread_id(
        self,
        mock_intent_classifier,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test run() works without thread_id."""

        async def meta_intent_classifier(state):
            return {
                "user_intent": IntentResult(intent="meta", raw=None),
                "messages": [AIMessage(content="Hi there!")],
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=meta_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(messages=[HumanMessage(content="Hi")])
        result = await agent.run(state)

        assert result is not None

    @pytest.mark.asyncio
    async def test_run_propagates_data_sources(
        self,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test that run() propagates data_sources to the graph."""
        captured_state = {}

        async def capturing_intent_classifier(state):
            captured_state["data_sources"] = state.data_sources
            return {
                "user_intent": IntentResult(intent="meta", raw=None),
                "messages": [AIMessage(content="Hello!")],
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=capturing_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(
            messages=[HumanMessage(content="Hello!")],
            data_sources=["gdrive", "confluence"],
        )
        await agent.run(state, thread_id="test-thread")

        assert captured_state["data_sources"] == ["gdrive", "confluence"]

    @pytest.mark.asyncio
    async def test_run_propagates_collection_scope(
        self,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test that run() propagates collection_scope to the graph."""
        captured_state = {}

        async def capturing_intent_classifier(state):
            captured_state["collection_scope"] = state.collection_scope
            return {
                "user_intent": IntentResult(intent="meta", raw=None),
                "messages": [AIMessage(content="Hello!")],
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=capturing_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(
            messages=[HumanMessage(content="Hello!")],
            collection_scope=["oib_knowledge", "proj_project-1", "s_conv-1"],
        )
        await agent.run(state, thread_id="test-thread")

        assert captured_state["collection_scope"] == ["oib_knowledge", "proj_project-1", "s_conv-1"]

    @pytest.mark.asyncio
    async def test_run_propagates_session_attachments_to_the_shallow_agent(
        self,
        mock_intent_classifier,
        mock_deep_research,
        mock_clarifier,
    ):
        """The turn's attachments must reach the agent that answers the turn (#429).

        `available_documents` is the searchable INVENTORY and can legitimately
        not list a just-dropped file yet; the attachment list is what the user
        actually handed over. Threading only the inventory is the original bug.
        """
        captured = {}

        async def capturing_shallow(state_input):
            captured["session_attachments"] = state_input.session_attachments
            result = MagicMock()
            result.messages = list(state_input.messages) + [AIMessage(content="Zusammenfassung.")]
            return result

        agent = ChatResearcherAgent(
            intent_classifier_fn=mock_intent_classifier,
            shallow_research_fn=capturing_shallow,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
            enable_escalation=False,
        )

        attachments = [
            SessionAttachment(file_name="Statik.pdf", state="ready"),
            SessionAttachment(file_name="Gross.pdf", state="indexing"),
        ]
        state = ChatResearcherState(
            messages=[HumanMessage(content="Fass den Inhalt zusammen")],
            session_attachments=attachments,
        )
        await agent.run(state, thread_id="test-thread")

        assert captured["session_attachments"] == attachments

    @pytest.mark.asyncio
    async def test_run_propagates_force_skills_to_the_shallow_agent(
        self,
        mock_intent_classifier,
        mock_deep_research,
        mock_clarifier,
    ):
        """Regression: a `/name` invocation reached the graph as nothing.

        `run()` builds its graph input as an explicit allow-list of channels, and
        `force_skills` was not on it — so the skills a user forced were set on
        `ChatResearcherState` in the register layer, read by `shallow_research_node`
        via `state.force_skills`, and were `None` by the time they got there.
        A channel missing from that list never reaches the graph at all.
        """
        captured = {}

        async def capturing_shallow(state_input):
            captured["force_skills"] = state_input.force_skills
            result = MagicMock()
            result.messages = list(state_input.messages) + [AIMessage(content="Geprüft.")]
            return result

        agent = ChatResearcherAgent(
            intent_classifier_fn=mock_intent_classifier,
            shallow_research_fn=capturing_shallow,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
            enable_escalation=False,
        )

        state = ChatResearcherState(
            messages=[HumanMessage(content="Prüfe die Einreichunterlagen")],
            force_skills=["oib-vorpruefung"],
        )
        await agent.run(state, thread_id="test-thread")

        assert captured["force_skills"] == ["oib-vorpruefung"]

    @pytest.mark.asyncio
    async def test_run_propagates_none_data_sources(
        self,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test that run() propagates None data_sources correctly."""
        captured_state = {}

        async def capturing_intent_classifier(state):
            captured_state["data_sources"] = state.data_sources
            return {
                "user_intent": IntentResult(intent="meta", raw=None),
                "messages": [AIMessage(content="Hello!")],
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=capturing_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(
            messages=[HumanMessage(content="Hello!")],
            data_sources=None,
        )
        await agent.run(state, thread_id="test-thread")

        assert captured_state["data_sources"] is None

    @pytest.mark.asyncio
    async def test_run_propagates_empty_data_sources(
        self,
        mock_shallow_research,
        mock_deep_research,
        mock_clarifier,
    ):
        """Test that run() propagates empty data_sources list."""
        captured_state = {}

        async def capturing_intent_classifier(state):
            captured_state["data_sources"] = state.data_sources
            return {
                "user_intent": IntentResult(intent="meta", raw=None),
                "messages": [AIMessage(content="Hello!")],
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=capturing_intent_classifier,
            shallow_research_fn=mock_shallow_research,
            deep_research_fn=mock_deep_research,
            clarifier_fn=mock_clarifier,
        )

        state = ChatResearcherState(
            messages=[HumanMessage(content="Hello!")],
            data_sources=[],
        )
        await agent.run(state, thread_id="test-thread")

        assert captured_state["data_sources"] == []


class TestRoutingBoundary:
    """Pins the intent -> depth routing boundary and the shallow/deep split.

    Complements the classifier-prompt taxonomy tests: those assert what the LLM
    is TOLD to do; these assert what the graph DOES with a given classification —
    the deterministic half of the routing contract.
    """

    def test_derive_routing_decision_depth_boundary(self):
        """The shallow-vs-deep boundary: a research turn is 'deep' only when the
        depth classifier said 'deep', otherwise 'shallow'. meta/error win over
        depth; no classification -> None."""
        from aiq_agent.agents.chat_researcher.agent import derive_routing_decision

        deep = DepthDecision(decision="deep", raw_reasoning="comparison")
        shallow = DepthDecision(decision="shallow", raw_reasoning="single lookup")
        research = IntentResult(intent="research", raw=None)

        # The pinned boundary: identical intent, depth decides the path.
        assert derive_routing_decision(research, deep) == "deep"
        assert derive_routing_decision(research, shallow) == "shallow"
        # Depth is ignored for non-research intents.
        assert derive_routing_decision(IntentResult(intent="meta", raw=None), deep) == "meta"
        assert derive_routing_decision(IntentResult(intent="error", raw=None), deep) == "error"
        # Out-of-scope surfaces as a "meta"/direct-answer route (frontend renders
        # it as "Direktantwort"); it never carries a depth path.
        assert derive_routing_decision(IntentResult(intent="out_of_scope", raw=None), None) == "meta"
        # A research turn with no depth decision falls back to shallow, never deep.
        assert derive_routing_decision(research, None) == "shallow"
        # No classification at all -> nothing to surface.
        assert derive_routing_decision(None, None) is None

    @pytest.fixture
    def trackers(self):
        """Shallow/deep/clarifier call trackers plus their mock functions."""
        calls = {"shallow": False, "deep": False, "clarifier": False}

        async def shallow(state_input):
            calls["shallow"] = True
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages) + [AIMessage(content="Here's a quick answer with sources.")]
            return result

        async def deep(state):
            calls["deep"] = True
            result = MagicMock()
            result.messages = list(state.messages) + [AIMessage(content="Here's a comprehensive report.")]
            return result

        async def clarifier(state_input):
            calls["clarifier"] = True
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages)
            result.clarifier_log = "clarified"
            # Explicit non-rejection so clarifier_node proceeds to deep_research
            # (a bare MagicMock's .plan_rejected is truthy and would short to END).
            result.plan_rejected = False
            result.get_approved_plan_context = MagicMock(return_value=None)
            return result

        return calls, shallow, deep, clarifier

    @pytest.mark.asyncio
    async def test_out_of_scope_short_circuits_without_any_agent(self, trackers):
        """An out-of-scope query is answered by the classifier's fixed redirect
        (already in state) and ends — NO answering agent runs: not shallow, not
        deep, not the clarifier. This is the 'predefined text, no research agent'
        path."""
        calls, shallow, deep, clarifier = trackers

        async def out_of_scope_classifier(state):
            # The classifier emits the redirect itself and no depth decision.
            return {
                "user_intent": IntentResult(intent="out_of_scope", raw=None),
                "messages": [AIMessage(content="Das liegt außerhalb meines Fachgebiets. …")],
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=out_of_scope_classifier,
            shallow_research_fn=shallow,
            deep_research_fn=deep,
            clarifier_fn=clarifier,
        )
        state = ChatResearcherState(messages=[HumanMessage(content="How do I bake a cake?")])
        result = await agent.run(state, thread_id="t")

        assert calls["shallow"] is False, "out-of-scope must NOT spin up the shallow/research agent"
        assert calls["deep"] is False
        assert calls["clarifier"] is False
        # The redirect authored by the classifier survives to the terminal state.
        contents = [m.content for m in result["messages"] if isinstance(m, AIMessage)]
        assert any("Fachgebiet" in c for c in contents)

    @pytest.mark.asyncio
    async def test_well_specified_shallow_answers_without_overclarifying(self, trackers):
        """Guardrail against over-correction: a normal, well-specified OIB
        question classified research+shallow answers directly — no clarifier,
        no deep escalation."""
        calls, shallow, deep, clarifier = trackers

        async def shallow_classifier(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="shallow", raw_reasoning="single factual lookup"),
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=shallow_classifier,
            shallow_research_fn=shallow,
            deep_research_fn=deep,
            clarifier_fn=clarifier,
            enable_escalation=False,
        )
        state = ChatResearcherState(messages=[HumanMessage(content="Was regelt die OIB-Richtlinie 2?")])
        result = await agent.run(state, thread_id="t")

        assert calls["shallow"] is True
        assert calls["clarifier"] is False, "a well-specified shallow question must not be sent to the clarifier"
        assert calls["deep"] is False
        assert result is not None

    @pytest.mark.asyncio
    async def test_deep_query_routes_through_clarifier(self, trackers):
        """A research+deep classification goes through the clarifier (the HITL
        push-back point) before deep research runs."""
        calls, shallow, deep, clarifier = trackers

        async def deep_classifier(state):
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="deep", raw_reasoning="multi-faceted comparison"),
            }

        agent = ChatResearcherAgent(
            intent_classifier_fn=deep_classifier,
            shallow_research_fn=shallow,
            deep_research_fn=deep,
            clarifier_fn=clarifier,
        )
        state = ChatResearcherState(
            messages=[HumanMessage(content="Vergleiche die OIB-2-Anforderungen über alle Gebäudeklassen")],
        )
        result = await agent.run(state, thread_id="t")

        assert calls["clarifier"] is True, "deep queries must pass through the clarifier"
        assert calls["deep"] is True
        assert calls["shallow"] is False
        assert result is not None


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

        async def classifier(state):
            calls.append("intent")
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="shallow", raw_reasoning="simple"),
            }

        async def shallow(state_input):
            calls.append("shallow")
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            result = MagicMock()
            result.messages = list(messages) + [AIMessage(content="Quick answer.")]
            return result

        async def deep(state):
            calls.append("deep")
            result = MagicMock()
            result.messages = list(state.messages)
            return result

        return calls, classifier, shallow, deep

    def _agent(self, trackers) -> ChatResearcherAgent:
        from langgraph.checkpoint.memory import InMemorySaver

        _calls, classifier, shallow, deep = trackers
        return ChatResearcherAgent(
            intent_classifier_fn=classifier,
            shallow_research_fn=shallow,
            deep_research_fn=deep,
            clarifier_fn=None,
            enable_clarifier=False,
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
            ChatResearcherState(messages=[HumanMessage(content="Ist das Atrium ein eigener Abschnitt?")]),
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

        async def capture_shallow(state_input):
            messages = state_input.messages if hasattr(state_input, "messages") else state_input
            seen.extend(str(m.content) for m in messages)
            result = MagicMock()
            result.messages = list(messages) + [AIMessage(content="Neu geprüft.")]
            return result

        agent.shallow_research_fn = capture_shallow
        await agent.run(
            ChatResearcherState(messages=[HumanMessage(content="@Piloti given that, recheck")]),
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
