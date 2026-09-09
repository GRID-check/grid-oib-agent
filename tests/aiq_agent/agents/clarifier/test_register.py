"""Tests for the clarifier agent NAT registration."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.tools import tool

from aiq_agent.agents.clarifier.models import ClarifierAgentState
from aiq_agent.agents.clarifier.register import ClarifierConfig
from aiq_agent.agents.clarifier.register import ask_through_nat
from aiq_agent.agents.clarifier.register import request_turn
from aiq_agent.agents.clarifier.register import resolve_tools
from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from nat.data_models.interactive import HumanPromptRadio
from nat.data_models.interactive import HumanPromptText
from nat.data_models.interactive import HumanResponseRadio
from nat.data_models.interactive import HumanResponseText
from nat.data_models.interactive import InteractionResponse
from nat.data_models.interactive import MultipleChoiceOption


@tool
def alpha_tool(query: str) -> str:
    """Alpha."""
    return query


@tool
def beta_tool(query: str) -> str:
    """Beta."""
    return query


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

    def test_the_registered_type_is_stable(self):
        """The YAML and every persisted config address the clarifier by this name."""
        assert ClarifierConfig.static_type() == "clarifier_agent"

    def test_config_field_descriptions(self):
        """Test config fields have descriptions."""
        fields = ClarifierConfig.model_fields
        assert fields["llm"].description is not None
        assert fields["tools"].description is not None
        assert fields["max_turns"].description is not None


class TestResolveTools:
    """The tool set the clarifier boots with."""

    @staticmethod
    def builder_returning(*tools):
        builder = MagicMock()
        builder.get_tools = AsyncMock(return_value=list(tools))
        return builder

    @pytest.mark.asyncio
    async def test_configured_refs_are_used_verbatim(self):
        builder = self.builder_returning(alpha_tool)

        tools = await resolve_tools(ClarifierConfig(llm="llm", tools=["alpha_tool"]), builder)

        assert tools == [alpha_tool]
        assert builder.get_tools.await_args.kwargs["tool_names"] == ["alpha_tool"]

    @pytest.mark.asyncio
    async def test_an_empty_tool_list_inherits_the_registry(self):
        """Empty means "everything the data-source registry has", not "nothing"."""
        builder = self.builder_returning(alpha_tool)

        with patch("aiq_agent.agents.clarifier.register.get_all_tool_refs", return_value=["registry_tool"]):
            await resolve_tools(ClarifierConfig(llm="llm"), builder)

        assert builder.get_tools.await_args.kwargs["tool_names"] == ["registry_tool"]

    @pytest.mark.asyncio
    async def test_excluded_tools_are_dropped(self):
        builder = self.builder_returning(alpha_tool, beta_tool)

        tools = await resolve_tools(ClarifierConfig(llm="llm", exclude_tools=["beta_tool"]), builder)

        assert tools == [alpha_tool]


class TestAskThroughNat:
    """The HITL callback: NAT prompt out, user's reply in."""

    @staticmethod
    def context_answering(response):
        manager = MagicMock()
        manager.prompt_user_input = AsyncMock(return_value=response)
        context = MagicMock()
        context.user_interaction_manager = manager
        return context, manager

    @pytest.mark.asyncio
    async def test_a_question_without_options_is_a_text_prompt(self):
        """No options: byte-identical to the prompt the clarifier always sent."""
        answer = InteractionResponse(id="1", timestamp="2026-08-18T10:00:00Z", content=HumanResponseText(text="skip"))
        context, manager = self.context_answering(answer)

        with patch("aiq_agent.agents.clarifier.register.Context.get", return_value=context):
            reply = await ask_through_nat("Which period?", ())

        prompt = manager.prompt_user_input.await_args.args[0]
        assert isinstance(prompt, HumanPromptText)
        assert reply == "skip"

    @pytest.mark.asyncio
    async def test_options_become_a_picker(self):
        """The picker gets its data from the prompt, not from parsing the prose."""
        picked = InteractionResponse(
            id="1",
            timestamp="2026-08-18T10:00:00Z",
            content=HumanResponseRadio(selected_option=MultipleChoiceOption(value="Alpha", label="Alpha")),
        )
        context, manager = self.context_answering(picked)

        with patch("aiq_agent.agents.clarifier.register.Context.get", return_value=context):
            reply = await ask_through_nat("**Focus**: which area?", ["Alpha", "Beta"])

        prompt = manager.prompt_user_input.await_args.args[0]
        assert isinstance(prompt, HumanPromptRadio)
        assert [option.value for option in prompt.options] == ["Alpha", "Beta"]
        assert prompt.text == "**Focus**: which area?"
        # A radio answer has no `.text`; reading it wrong would feed the LLM junk.
        assert reply == "Alpha"

    @pytest.mark.asyncio
    async def test_a_typed_skip_survives_a_picker_prompt(self):
        """The skip path is only ever typed, so it must survive the picker prompt."""
        typed = InteractionResponse(id="1", timestamp="2026-08-18T10:00:00Z", content=HumanResponseText(text="skip"))
        context, _ = self.context_answering(typed)

        with patch("aiq_agent.agents.clarifier.register.Context.get", return_value=context):
            assert await ask_through_nat("**Focus**: which area?", ["Alpha", "Beta"]) == "skip"


class TestRequestTurn:
    """What one request varies from the boot-time agent."""

    @staticmethod
    def provider_varying(varies: bool):
        """A provider double whose override chain returns itself, or a new one."""
        provider = MagicMock(spec=LLMProvider)
        chained = MagicMock(spec=LLMProvider) if varies else provider
        provider.with_model_overrides.return_value.with_credential.return_value.with_zdr.return_value = chained
        return provider

    def test_nothing_varies(self):
        """The common request: the boot binding serves it, nothing is rebuilt."""
        provider = self.provider_varying(False)

        assert request_turn(provider, [alpha_tool], None, ClarifierAgentState(messages=[])) is None

    def test_an_org_override_produces_a_turn(self):
        """A model override, a BYOK credential or ZDR routing all arrive this way."""
        provider = self.provider_varying(True)

        turn = request_turn(provider, [alpha_tool], None, ClarifierAgentState(messages=[]))

        assert turn is not None
        assert turn.llm_provider is not provider

    def test_narrowed_data_sources_produce_a_turn(self):
        """Org-disabled sources narrow the tool set even without a model override."""
        provider = self.provider_varying(False)

        with patch("aiq_agent.agents.clarifier.register.filter_tools_by_sources", return_value=[alpha_tool]):
            turn = request_turn(provider, [alpha_tool, beta_tool], None, ClarifierAgentState(messages=[]))

        assert turn is not None
        assert turn.tools == [alpha_tool]

    def test_the_planner_is_carried_through_the_override(self):
        """The planner belongs to the same agent group as the clarifier LLM."""
        provider = self.provider_varying(True)
        planner = MagicMock()

        with (
            patch("aiq_agent.agents.clarifier.register.apply_model_override", return_value=planner) as override,
            patch("aiq_agent.agents.clarifier.register.apply_org_credential", return_value=planner),
        ):
            turn = request_turn(provider, [], planner, ClarifierAgentState(messages=[]))

        assert turn is not None
        assert turn.planner_llm is planner
        assert override.call_args.args[1] is AgentGroup.CLARIFIER

    def test_no_configured_planner_stays_none(self):
        """None means "fall back to the (already overridden) clarifier LLM"."""
        turn = request_turn(self.provider_varying(True), [], None, ClarifierAgentState(messages=[]))

        assert turn is not None
        assert turn.planner_llm is None
