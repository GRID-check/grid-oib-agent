"""Tests for the ChatResearcherAgent."""

from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import DepthDecision
from aiq_agent.agents.chat_researcher.models import IntentResult


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
