"""Tests for ClarifierAgentState and ClarifierResult models."""

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.clarifier.models import ClarificationResponse
from aiq_agent.agents.clarifier.models import ClarifierAgentState
from aiq_agent.agents.clarifier.models import ClarifierResult


class TestClarifierAgentState:
    """Tests for the ClarifierAgentState model."""

    def test_create_with_messages(self):
        """Test creating state with messages."""
        state = ClarifierAgentState(messages=[HumanMessage(content="Research AI agents")])

        assert len(state.messages) == 1
        assert state.messages[0].content == "Research AI agents"

    def test_default_data_sources(self):
        """Test default data_sources is None."""
        assert ClarifierAgentState(messages=[]).data_sources is None

    def test_custom_data_sources(self):
        """Test custom data_sources."""
        state = ClarifierAgentState(messages=[], data_sources=["web_search"])
        assert state.data_sources == ["web_search"]

    def test_default_clarifier_log(self):
        """Test default clarifier_log is empty string."""
        assert ClarifierAgentState(messages=[]).clarifier_log == ""

    def test_custom_clarifier_log(self):
        """Test custom clarifier_log."""
        state = ClarifierAgentState(messages=[], clarifier_log="Turn 1: Hello")
        assert state.clarifier_log == "Turn 1: Hello"

    def test_default_iteration(self):
        """Test default iteration is 0."""
        assert ClarifierAgentState(messages=[]).iteration == 0

    def test_custom_iteration(self):
        """Test custom iteration."""
        assert ClarifierAgentState(messages=[], iteration=2).iteration == 2

    def test_the_turn_limit_is_not_on_the_state(self):
        """It is configuration, and a copy here was only ever stamped over by run()."""
        assert "max_turns" not in ClarifierAgentState.model_fields

    def test_the_parsed_clarification_rides_on_the_state(self):
        """Parsed once by the node that received it, read by the router and the ask node."""
        state = ClarifierAgentState(messages=[], clarification=ClarificationResponse.complete())

        assert state.clarification is not None
        assert state.clarification.needs_clarification is False

    def test_multiple_messages(self):
        """Test state with multiple messages."""
        messages = [
            HumanMessage(content="Research AI"),
            AIMessage(content="What aspect?"),
            HumanMessage(content="Technical"),
        ]
        assert len(ClarifierAgentState(messages=messages).messages) == 3

    def test_model_validate(self):
        """Test validation from dict."""
        data = {
            "messages": [{"type": "human", "content": "Hello"}],
            "iteration": 1,
            "clarifier_log": "Log",
            "data_sources": ["confluence", "sharepoint"],
        }
        state = ClarifierAgentState.model_validate(data)

        assert state.iteration == 1
        assert state.clarifier_log == "Log"
        assert state.data_sources == ["confluence", "sharepoint"]


class TestClarifierResult:
    """Tests for the ClarifierResult model."""

    def test_default_values(self):
        """Test default values for ClarifierResult."""
        result = ClarifierResult()

        assert result.clarifier_log == ""
        assert result.plan_title is None
        assert result.plan_sections == []
        assert result.plan_outcome is None
        assert result.plan_approved is False
        assert result.plan_rejected is False
        assert result.plan_cancelled is False

    def test_custom_values(self):
        """Test custom values for ClarifierResult."""
        result = ClarifierResult(
            clarifier_log="Test log",
            plan_title="Research Plan",
            plan_sections=["Intro", "Analysis"],
            plan_outcome="approved",
        )

        assert result.clarifier_log == "Test log"
        assert result.plan_title == "Research Plan"
        assert result.plan_sections == ["Intro", "Analysis"]
        assert result.plan_approved is True
        assert result.plan_rejected is False

    def test_exactly_one_flag_can_be_true(self):
        """The three booleans are derived, so they cannot contradict each other."""
        for outcome, expected in (("approved", 0), ("shallow", 1), ("cancelled", 2)):
            result = ClarifierResult(plan_outcome=outcome)
            flags = [result.plan_approved, result.plan_rejected, result.plan_cancelled]

            assert flags.count(True) == 1
            assert flags[expected] is True

    def test_the_flags_survive_serialization(self):
        """The caller reads them off the model; NAT may read them off the dump."""
        dumped = ClarifierResult(plan_outcome="cancelled").model_dump()

        assert dumped["plan_cancelled"] is True
        assert dumped["plan_approved"] is False

    def test_from_state_projects_the_finished_state(self):
        """The result is the state's product, copied field for field."""
        state = ClarifierAgentState(
            messages=[HumanMessage(content="Research AI")],
            clarifier_log="Turn 1",
            plan_title="A Plan",
            plan_sections=["One"],
            plan_outcome="shallow",
        )

        result = ClarifierResult.from_state(state)

        assert result.clarifier_log == "Turn 1"
        assert result.plan_title == "A Plan"
        assert result.plan_sections == ["One"]
        assert result.plan_rejected is True

    def test_get_approved_plan_context_when_approved(self):
        """Test get_approved_plan_context returns formatted string when approved."""
        result = ClarifierResult(
            plan_title="AI Research Report",
            plan_sections=["Introduction", "Background", "Analysis"],
            plan_outcome="approved",
        )
        context = result.get_approved_plan_context()

        assert context is not None
        assert "**Approved Research Plan**" in context
        assert "AI Research Report" in context
        assert "- Introduction" in context
        assert "- Background" in context
        assert "- Analysis" in context

    def test_get_approved_plan_context_when_not_approved(self):
        """Test get_approved_plan_context returns None when not approved."""
        result = ClarifierResult(plan_title="Research Plan", plan_sections=["Section 1"], plan_outcome="shallow")

        assert result.get_approved_plan_context() is None

    def test_get_approved_plan_context_when_no_title(self):
        """Test get_approved_plan_context returns None when no title."""
        result = ClarifierResult(plan_title=None, plan_sections=["Section 1"], plan_outcome="approved")

        assert result.get_approved_plan_context() is None

    def test_get_approved_plan_context_empty_sections(self):
        """Test get_approved_plan_context with empty sections."""
        result = ClarifierResult(plan_title="Research Plan", plan_sections=[], plan_outcome="approved")
        context = result.get_approved_plan_context()

        assert context is not None
        assert "Research Plan" in context
        assert "Sections:" in context
