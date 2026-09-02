"""Tests for ChatResearcherState model."""

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import ShallowResult


class TestChatResearcherState:
    """Tests for the ChatResearcherState model."""

    def test_create_state_with_messages(self):
        """Test creating state with messages."""
        messages = [HumanMessage(content="Test query")]
        state = ChatResearcherState(messages=messages)

        assert len(state.messages) == 1
        assert state.messages[0].content == "Test query"

    def test_create_state_empty_messages(self):
        """Test creating state with empty messages list."""
        state = ChatResearcherState(messages=[])

        assert state.messages == []

    def test_state_with_user_info(self):
        """Test state with user info."""
        state = ChatResearcherState(
            messages=[HumanMessage(content="Test")],
            user_info={"name": "John", "preferences": {"theme": "dark"}},
        )

        assert state.user_info == {"name": "John", "preferences": {"theme": "dark"}}

    def test_state_with_routing_decision(self):
        """The observed routing is a plain literal on the state, set after the answer."""
        state = ChatResearcherState(
            messages=[HumanMessage(content="What is CUDA?")],
            routing_decision="shallow",
        )

        assert state.routing_decision == "shallow"

    def test_state_carries_no_classification(self):
        """ADR-0052: nothing decides the turn's shape before the answer, so the
        state has no field to hold such a decision."""
        for gone in ("user_intent", "depth_decision", "routing_reason"):
            assert gone not in ChatResearcherState.model_fields

    def test_state_with_shallow_result(self):
        """Test state with shallow result."""
        result = ShallowResult(
            answer="CUDA is a parallel computing platform.",
            confidence="high",
            escalate_to_deep=False,
        )
        state = ChatResearcherState(
            messages=[HumanMessage(content="Test")],
            shallow_result=result,
        )

        assert state.shallow_result == result

    def test_state_with_final_report(self):
        """Test state with final report."""
        report = "# Research Report\n\n## Summary\nThis is the summary..."
        state = ChatResearcherState(
            messages=[HumanMessage(content="Test")],
            final_report=report,
        )

        assert state.final_report == report

    def test_state_defaults(self):
        """Test state with default values."""
        state = ChatResearcherState(messages=[])

        assert state.user_info is None
        assert state.routing_decision is None
        assert state.escalation_reason is None
        assert state.final_report is None
        assert state.shallow_result is None
        assert state.data_sources is None

    def test_state_with_data_sources(self):
        """Test state with data_sources."""
        state = ChatResearcherState(
            messages=[HumanMessage(content="Test")],
            data_sources=["web_search", "confluence"],
        )

        assert state.data_sources == ["web_search", "confluence"]

    def test_state_with_single_data_source(self):
        """Test state with single data source."""
        state = ChatResearcherState(
            messages=[HumanMessage(content="Test")],
            data_sources=["sharepoint"],
        )

        assert state.data_sources == ["sharepoint"]

    def test_state_with_empty_data_sources(self):
        """Test state with empty data sources list."""
        state = ChatResearcherState(
            messages=[HumanMessage(content="Test")],
            data_sources=[],
        )

        assert state.data_sources == []

    def test_state_message_accumulation(self):
        """Test that messages properly accumulate."""
        state = ChatResearcherState(
            messages=[
                HumanMessage(content="First"),
                AIMessage(content="Response"),
                HumanMessage(content="Second"),
            ]
        )

        assert len(state.messages) == 3

    def test_state_full_workflow(self):
        """Test state with all fields populated (full workflow scenario)."""
        state = ChatResearcherState(
            messages=[
                HumanMessage(content="What is CUDA?"),
                AIMessage(content="CUDA is a parallel computing platform."),
            ],
            user_info={"role": "developer"},
            routing_decision="shallow",
            shallow_result=ShallowResult(
                answer="CUDA is a parallel computing platform by NVIDIA.",
                confidence="high",
                escalate_to_deep=False,
            ),
            final_report=None,
            data_sources=["web_search", "confluence"],
        )

        assert state.routing_decision == "shallow"
        assert state.shallow_result.confidence == "high"
        assert state.data_sources == ["web_search", "confluence"]
