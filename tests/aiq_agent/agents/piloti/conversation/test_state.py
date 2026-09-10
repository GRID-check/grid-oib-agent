"""Tests for ConversationState model."""

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.researcher.models import ConversationState


class TestConversationState:
    """Tests for the ConversationState model."""

    def test_create_state_with_messages(self):
        """Test creating state with messages."""
        messages = [HumanMessage(content="Test query")]
        state = ConversationState(messages=messages)

        assert len(state.messages) == 1
        assert state.messages[0].content == "Test query"

    def test_create_state_empty_messages(self):
        """Test creating state with empty messages list."""
        state = ConversationState(messages=[])

        assert state.messages == []

    def test_state_with_user_info(self):
        """Test state with user info."""
        state = ConversationState(
            messages=[HumanMessage(content="Test")],
            user_info={"name": "John", "preferences": {"theme": "dark"}},
        )

        assert state.user_info == {"name": "John", "preferences": {"theme": "dark"}}

    def test_state_with_routing_decision(self):
        """The observed routing is a plain literal on the state, set after the answer."""
        state = ConversationState(
            messages=[HumanMessage(content="What is CUDA?")],
            routing_decision="shallow",
        )

        assert state.routing_decision == "shallow"

    def test_state_carries_no_classification(self):
        """ADR-0052: nothing decides the turn's shape before the answer, so the
        state has no field to hold such a decision."""
        for gone in ("user_intent", "depth_decision", "routing_reason"):
            assert gone not in ConversationState.model_fields

    def test_state_carries_the_escalation_ask_as_two_plain_fields(self):
        """The whole of what the escalation edge reads: a bool and its reason.

        It used to be a nested ``ShallowResult`` model carrying the answer text
        as well, which nothing read — and being a custom pydantic type it also
        needed a row in the checkpointer's msgpack allow-list.
        """
        state = ConversationState(
            messages=[HumanMessage(content="Test")],
            escalate_to_deep=True,
            escalation_ask_reason="zu breit für eine Antwort",
        )

        assert state.escalate_to_deep is True
        assert state.escalation_ask_reason == "zu breit für eine Antwort"
        assert "shallow_result" not in ConversationState.model_fields

    def test_state_carries_no_field_nothing_reads(self):
        """``final_report`` and ``cards`` were never read or written by the graph;
        cards come from the registry, the report is the deep message."""
        for gone in ("final_report", "cards"):
            assert gone not in ConversationState.model_fields

    def test_state_defaults(self):
        """Test state with default values."""
        state = ConversationState(messages=[])

        assert state.user_info is None
        assert state.routing_decision is None
        assert state.escalation_reason is None
        assert state.escalate_to_deep is None
        assert state.data_sources is None

    def test_state_with_data_sources(self):
        """Test state with data_sources."""
        state = ConversationState(
            messages=[HumanMessage(content="Test")],
            data_sources=["web_search", "confluence"],
        )

        assert state.data_sources == ["web_search", "confluence"]

    def test_state_with_single_data_source(self):
        """Test state with single data source."""
        state = ConversationState(
            messages=[HumanMessage(content="Test")],
            data_sources=["sharepoint"],
        )

        assert state.data_sources == ["sharepoint"]

    def test_state_with_empty_data_sources(self):
        """Test state with empty data sources list."""
        state = ConversationState(
            messages=[HumanMessage(content="Test")],
            data_sources=[],
        )

        assert state.data_sources == []

    def test_state_message_accumulation(self):
        """Test that messages properly accumulate."""
        state = ConversationState(
            messages=[
                HumanMessage(content="First"),
                AIMessage(content="Response"),
                HumanMessage(content="Second"),
            ]
        )

        assert len(state.messages) == 3

    def test_state_full_workflow(self):
        """Test state with all fields populated (full workflow scenario)."""
        state = ConversationState(
            messages=[
                HumanMessage(content="What is CUDA?"),
                AIMessage(content="CUDA is a parallel computing platform."),
            ],
            user_info={"role": "developer"},
            routing_decision="shallow",
            escalate_to_deep=False,
            data_sources=["web_search", "confluence"],
        )

        assert state.routing_decision == "shallow"
        assert state.escalate_to_deep is False
        assert state.data_sources == ["web_search", "confluence"]
