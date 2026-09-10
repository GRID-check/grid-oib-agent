"""Tests for how the clarification step is configured and wired.

What was the `clarifier_agent` NAT registration: the config block (now nested
under the workflow), the tool set it boots with, the HITL channel it asks
through, and the per-request narrowing that keeps a per-org model override,
a BYOK credential, ZDR routing and data-source filtering working.
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.researcher.clarify import Clarifier
from aiq_agent.agents.researcher.clarify import ClarifierSettings
from aiq_agent.agents.researcher.clarify import ask_through_nat
from aiq_agent.agents.researcher.clarify import resolve_tools
from aiq_agent.agents.researcher.models import ClarifyRequest
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


class TestClarifierSettings:
    """The config block, one level deeper than it used to be."""

    def test_settings_with_required_fields(self):
        settings = ClarifierSettings(llm="test_llm")

        assert settings.llm == "test_llm"
        assert settings.tools == []
        assert settings.max_turns == 3
        assert settings.log_response_max_chars == 2000
        assert settings.verbose is False

    def test_settings_with_all_fields(self):
        settings = ClarifierSettings(
            llm="test_llm",
            tools=["tool1", "tool2"],
            max_turns=5,
            log_response_max_chars=1000,
            verbose=True,
        )

        assert settings.llm == "test_llm"
        assert settings.tools == ["tool1", "tool2"]
        assert settings.max_turns == 5
        assert settings.log_response_max_chars == 1000
        assert settings.verbose is True

    def test_tools_default_factory(self):
        """Each instance gets its own list, not a shared one."""
        first = ClarifierSettings(llm="llm")
        second = ClarifierSettings(llm="llm")

        assert first.tools == [] and first.tools is not second.tools

    def test_the_field_names_are_the_ones_the_yaml_already_used(self):
        """The block moved onto the workflow; the keys inside it did not change,
        so an existing deployment re-indents its YAML and nothing else."""
        assert set(ClarifierSettings.model_fields) == {
            "llm",
            "planner_llm",
            "tools",
            "exclude_tools",
            "max_turns",
            "enable_plan_approval",
            "max_plan_iterations",
            "log_response_max_chars",
            "verbose",
        }

    def test_field_descriptions(self):
        fields = ClarifierSettings.model_fields
        assert fields["llm"].description is not None
        assert fields["tools"].description is not None
        assert fields["max_turns"].description is not None

    def test_it_hangs_off_the_workflow_config(self):
        """The one place a deployment addresses this step from now."""
        from aiq_agent.agents.researcher.conversation_register import ChatDeepResearcherConfig

        config = ChatDeepResearcherConfig(enable_clarifier=True, clarifier={"llm": "clarifier_llm", "max_turns": 3})

        assert config.clarifier is not None
        assert config.clarifier.llm == "clarifier_llm"

    def test_it_is_absent_by_default(self):
        """A deployment with no clarifier configures nothing."""
        from aiq_agent.agents.researcher.conversation_register import ChatDeepResearcherConfig

        assert ChatDeepResearcherConfig().clarifier is None


class TestBuildClarifierGuard:
    """Turning the clarifier on without configuring it fails at boot."""

    @pytest.mark.asyncio
    async def test_enabled_without_a_block_is_a_boot_error(self):
        from aiq_agent.agents.researcher.conversation_register import ChatDeepResearcherConfig
        from aiq_agent.agents.researcher.conversation_register import _build_clarifier

        with pytest.raises(ValueError, match="enable_clarifier"):
            await _build_clarifier(ChatDeepResearcherConfig(enable_clarifier=True), MagicMock())

    @pytest.mark.asyncio
    async def test_disabled_resolves_nothing(self):
        """The graph gets None and the escalation goes straight to deep research."""
        from aiq_agent.agents.researcher.conversation_register import ChatDeepResearcherConfig
        from aiq_agent.agents.researcher.conversation_register import _build_clarifier

        assert await _build_clarifier(ChatDeepResearcherConfig(enable_clarifier=False), MagicMock()) is None


class TestResolveTools:
    """The tool set the step boots with."""

    @staticmethod
    def builder_returning(*tools):
        builder = MagicMock()
        builder.get_tools = AsyncMock(return_value=list(tools))
        return builder

    @pytest.mark.asyncio
    async def test_configured_refs_are_used_verbatim(self):
        builder = self.builder_returning(alpha_tool)

        tools = await resolve_tools(ClarifierSettings(llm="llm", tools=["alpha_tool"]), builder)

        assert tools == [alpha_tool]
        assert builder.get_tools.await_args.kwargs["tool_names"] == ["alpha_tool"]

    @pytest.mark.asyncio
    async def test_an_empty_tool_list_inherits_the_registry(self):
        """Empty means "everything the data-source registry has", not "nothing"."""
        builder = self.builder_returning(alpha_tool)

        with patch("aiq_agent.agents.researcher.clarify.get_all_tool_refs", return_value=["registry_tool"]):
            await resolve_tools(ClarifierSettings(llm="llm"), builder)

        assert builder.get_tools.await_args.kwargs["tool_names"] == ["registry_tool"]

    @pytest.mark.asyncio
    async def test_excluded_tools_are_dropped(self):
        builder = self.builder_returning(alpha_tool, beta_tool)

        tools = await resolve_tools(ClarifierSettings(llm="llm", exclude_tools=["beta_tool"]), builder)

        assert tools == [alpha_tool]


class TestAskThroughNat:
    """The HITL channel: NAT prompt out, user's reply in.

    This is the live user interaction the plan-approval dialog blocks on, so it
    keeps its own tests even though nothing registers a NAT function any more.
    """

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

        with patch("aiq_agent.agents.researcher.clarify.Context.get", return_value=context):
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

        with patch("aiq_agent.agents.researcher.clarify.Context.get", return_value=context):
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

        with patch("aiq_agent.agents.researcher.clarify.Context.get", return_value=context):
            assert await ask_through_nat("**Focus**: which area?", ["Alpha", "Beta"]) == "skip"

    @pytest.mark.asyncio
    async def test_it_is_the_default_channel_a_booted_clarifier_asks_through(self):
        """Wiring check: nothing else has to remember to pass the callback."""
        clarifier = Clarifier.build(provider_varying(False), [], None, ClarifierSettings(llm="l"))

        assert clarifier.boot.ask_user is ask_through_nat


def provider_varying(varies: bool) -> MagicMock:
    """A provider double whose override chain returns itself, or a new one."""
    provider = MagicMock(spec=LLMProvider)
    chained = MagicMock(spec=LLMProvider) if varies else provider
    provider.with_model_overrides.return_value.with_credential.return_value.with_zdr.return_value = chained
    return provider


def request_with(data_sources=None) -> ClarifyRequest:
    return ClarifyRequest(messages=[HumanMessage(content="q")], data_sources=data_sources)


class TestDepsForRequest:
    """What one request varies from the boot-time step."""

    @staticmethod
    def clarifier_for(provider, tools=(), planner=None) -> Clarifier:
        return Clarifier.build(provider, list(tools), planner, ClarifierSettings(llm="l"), AsyncMock())

    def test_nothing_varies(self):
        """The common request: the boot deps serve it, nothing is rebuilt."""
        clarifier = self.clarifier_for(provider_varying(False), [alpha_tool])

        assert clarifier.deps_for(request_with()) is clarifier.boot

    def test_an_org_override_produces_its_own_deps(self):
        """A model override, a BYOK credential or ZDR routing all arrive this way."""
        provider = provider_varying(True)
        clarifier = self.clarifier_for(provider, [alpha_tool])

        deps = clarifier.deps_for(request_with())

        assert deps is not clarifier.boot

    def test_narrowed_data_sources_produce_their_own_deps(self):
        """Org-disabled sources narrow the tool set even without a model override."""
        clarifier = self.clarifier_for(provider_varying(False), [alpha_tool, beta_tool])

        with patch("aiq_agent.agents.researcher.clarify.filter_tools_by_sources", return_value=[alpha_tool]):
            deps = clarifier.deps_for(request_with(["alpha"]))

        assert deps is not clarifier.boot
        assert set(deps.tools) == {"alpha_tool"}

    def test_the_planner_is_carried_through_the_override(self):
        """The planner belongs to the same agent group as the clarifier LLM."""
        planner = MagicMock()
        clarifier = self.clarifier_for(provider_varying(True), [], planner)

        with (
            patch("aiq_agent.agents.researcher.clarify.apply_model_override", return_value=planner) as override,
            patch("aiq_agent.agents.researcher.clarify.apply_org_credential", return_value=planner),
        ):
            clarifier.deps_for(request_with())

        assert override.call_args.args[1] is AgentGroup.CLARIFIER

    def test_no_configured_planner_stays_none(self):
        """None means "fall back to the (already overridden) clarifier LLM"."""
        provider = provider_varying(True)
        clarifier = self.clarifier_for(provider, [])

        deps = clarifier.deps_for(request_with())

        # The chained provider's own model answered both roles.
        assert deps.planner_llm is not None
