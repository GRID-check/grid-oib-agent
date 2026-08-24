"""Tests for the clarifier agent NAT registration."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest

from aiq_agent.agents.clarifier.register import ClarifierConfig


class TestClarifierConfig:
    """Tests for the ClarifierConfig model."""

    def test_config_with_required_fields(self):
        """Test config with required fields only."""
        config = ClarifierConfig(llm="test_llm")

        assert config.llm == "test_llm"
        assert config.tools == []
        assert config.max_turns == 3
        assert config.log_response_max_chars == 2000
        assert config.verbose is False

    def test_config_with_all_fields(self):
        """Test config with all fields specified."""
        config = ClarifierConfig(
            llm="test_llm",
            tools=["tool1", "tool2"],
            max_turns=5,
            log_response_max_chars=1000,
            verbose=True,
        )

        assert config.llm == "test_llm"
        assert config.tools == ["tool1", "tool2"]
        assert config.max_turns == 5
        assert config.log_response_max_chars == 1000
        assert config.verbose is True

    def test_config_tools_default_factory(self):
        """Test tools default to empty list."""
        config = ClarifierConfig(llm="llm")
        assert config.tools == []
        # Verify it's a new list each time
        config2 = ClarifierConfig(llm="llm")
        assert config.tools is not config2.tools

    def test_config_inherits_from_function_base_config(self):
        """Test config inherits from FunctionBaseConfig."""
        from nat.data_models.function import FunctionBaseConfig

        assert issubclass(ClarifierConfig, FunctionBaseConfig)

    def test_config_field_descriptions(self):
        """Test config fields have descriptions."""
        fields = ClarifierConfig.model_fields
        assert fields["llm"].description is not None
        assert fields["tools"].description is not None
        assert fields["max_turns"].description is not None


class TestUserPromptCallback:
    """Tests for the user prompt callback creation."""

    @pytest.fixture
    def mock_context(self):
        """Create a mock NAT context."""
        mock_user_manager = MagicMock()
        mock_user_manager.prompt_user_input = AsyncMock()

        mock_ctx = MagicMock()
        mock_ctx.user_interaction_manager = mock_user_manager

        return mock_ctx

    @pytest.mark.asyncio
    async def test_user_prompt_callback_extracts_response(self, mock_context):
        """Test user prompt callback extracts text from response."""
        from aiq_agent.agents.clarifier.utils import extract_user_response

        # Test the extract function directly
        class MockContent:
            text = "User's choice"

        class MockResponse:
            content = MockContent()

        result = extract_user_response(MockResponse())
        assert result == "User's choice"

    @pytest.mark.asyncio
    async def test_user_prompt_callback_with_string_response(self):
        """Test user prompt callback with string response."""
        from aiq_agent.agents.clarifier.utils import extract_user_response

        result = extract_user_response("Direct string response")
        assert result == "Direct string response"


class TestClarificationPromptShape:
    """The clarifier's prompt must carry options as structured data."""

    def test_prompt_without_options_is_text(self):
        """No options: byte-identical to the prompt the clarifier always sent."""
        from aiq_agent.common import build_human_prompt
        from nat.data_models.interactive import HumanPromptText

        prompt = build_human_prompt("Which period?", None)

        assert isinstance(prompt, HumanPromptText)
        assert prompt.placeholder == "Please provide more details..."

    def test_prompt_with_options_carries_them(self):
        """The picker gets its data from the prompt, not from parsing the prose."""
        from aiq_agent.common import build_human_prompt
        from nat.data_models.interactive import HumanPromptRadio

        prompt = build_human_prompt("**Focus**: which area?", ["Alpha", "Beta"])

        assert isinstance(prompt, HumanPromptRadio)
        assert [option.value for option in prompt.options] == ["Alpha", "Beta"]
        assert prompt.text == "**Focus**: which area?"

    @pytest.mark.asyncio
    async def test_callback_reads_back_a_picked_option(self):
        """A radio answer has no `.text`; reading it wrong would feed the LLM junk."""
        from aiq_agent.agents.clarifier.utils import extract_user_response
        from nat.data_models.interactive import HumanResponseRadio
        from nat.data_models.interactive import InteractionResponse
        from nat.data_models.interactive import MultipleChoiceOption

        response = InteractionResponse(
            id="1",
            timestamp="2026-08-18T10:00:00Z",
            content=HumanResponseRadio(selected_option=MultipleChoiceOption(value="Alpha", label="Alpha")),
        )

        assert extract_user_response(response) == "Alpha"

    @pytest.mark.asyncio
    async def test_callback_reads_back_a_typed_skip(self):
        """The skip path is only ever typed, so it must survive the picker prompt."""
        from aiq_agent.agents.clarifier.utils import extract_user_response
        from nat.data_models.interactive import HumanResponseText
        from nat.data_models.interactive import InteractionResponse

        response = InteractionResponse(
            id="1",
            timestamp="2026-08-18T10:00:00Z",
            content=HumanResponseText(text="skip"),
        )

        assert extract_user_response(response) == "skip"
