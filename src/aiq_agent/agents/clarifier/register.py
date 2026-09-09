"""
NAT register function for the clarifier agent.

This module provides the NAT plugin registration for the ClarifierAgent,
allowing it to be used as a function in NAT workflows. The agent handles
interactive clarification dialogs for deep research queries.

Configuration example in YAML:
    functions:
      clarifier_agent:
        _type: clarifier_agent
        llm: my_llm
        tools:
          - web_search_tool
        max_turns: 3
        verbose: true
"""

import logging
from collections.abc import Sequence
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool
from pydantic import Field

from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common import VerboseTraceCallback
from aiq_agent.common import all_mapped_tools_filtered_out
from aiq_agent.common import apply_model_override
from aiq_agent.common import apply_org_credential
from aiq_agent.common import build_human_prompt
from aiq_agent.common import extract_user_response
from aiq_agent.common import filter_tools_by_sources
from aiq_agent.common import get_all_tool_refs
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import get_org_llm_credential_from_context
from aiq_agent.common import get_zdr_only_from_context
from aiq_agent.common import is_verbose
from nat.builder.builder import Builder
from nat.builder.context import Context
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.component_ref import FunctionGroupRef
from nat.data_models.component_ref import FunctionRef
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig

from .agent import ClarifierAgent
from .agent import TurnConfig
from .models import ClarifierAgentState
from .models import ClarifierResult

logger = logging.getLogger(__name__)


class ClarifierConfig(FunctionBaseConfig, name="clarifier_agent"):
    """
    Configuration for the clarifier agent NAT function.

    Attributes:
        llm: Reference to the LLM to use for generating clarification questions.
        tools: List of tool references for context gathering (e.g., web search).
        max_turns: Maximum number of clarification Q&A turns before auto-completing.
        enable_plan_approval: Whether to enable plan preview and approval after clarification.
        max_plan_iterations: Maximum number of plan feedback iterations before auto-approving.
        log_response_max_chars: Maximum characters to log from LLM responses.
        verbose: Whether to enable verbose logging with VerboseTraceCallback.
    """

    llm: LLMRef = Field(..., description="LLM to use for generating questions")
    planner_llm: LLMRef | None = Field(
        default=None,
        description="LLM to use for plan generation. If not specified, uses the main llm.",
    )
    tools: list[FunctionRef | FunctionGroupRef] = Field(
        default_factory=list,
        description="Explicit tool list. Empty = inherit all from data_source_registry.",
    )
    exclude_tools: list[str] = Field(
        default_factory=list,
        description="Tool names to exclude when inheriting from registry.",
    )
    max_turns: int = Field(
        default=3,
        description="Maximum number of clarification Q&A turns",
    )
    enable_plan_approval: bool = Field(
        default=False,
        description="Whether to enable plan preview and approval after clarification",
    )
    max_plan_iterations: int = Field(
        default=10,
        description="Maximum number of plan feedback iterations before auto-approving",
    )
    log_response_max_chars: int = Field(
        default=2000,
        description="Max characters to log from LLM responses",
    )
    verbose: bool = Field(
        default=False,
        description="Whether to enable verbose logging",
    )


async def ask_through_nat(question: str, options: Sequence[str] = ()) -> str:
    """
    Ask the user a question through NAT's user interaction manager.

    Args:
        question: The clarification question to display to the user.
        options: Short labels of the answers the question offers. When present
            the prompt becomes a multiple-choice one so the client can render a
            picker; the question text is unchanged either way, and the user may
            still type a free-text answer or "skip".

    Returns:
        The user's response text, extracted from the NAT response object — a
        typed answer and a picked option arrive as different response models,
        and `extract_user_response` normalizes both.
    """
    user_input_manager = Context.get().user_interaction_manager
    response = await user_input_manager.prompt_user_input(build_human_prompt(question, list(options)))
    return extract_user_response(response)


async def resolve_tools(config: ClarifierConfig, builder: Builder) -> list[BaseTool]:
    """The tool set the clarifier boots with: the configured refs, else the whole registry."""
    tools = await builder.get_tools(
        tool_names=config.tools or get_all_tool_refs(),
        wrapper_type=LLMFrameworkEnum.LANGCHAIN,
    )
    if not config.exclude_tools:
        return list(tools)
    excluded = set(config.exclude_tools)
    return [t for t in tools if getattr(t, "name", "") not in excluded]


def _request_planner(
    planner_llm: BaseChatModel | None, model_overrides: Any, org_credential: Any
) -> BaseChatModel | None:
    """This request's planner: the boot one under the org's override and credential.

    ``None`` stays ``None`` — no configured planner means the binding falls back
    to the (already overridden) clarifier LLM.
    """
    if planner_llm is None:
        return None
    overridden = apply_model_override(planner_llm, AgentGroup.CLARIFIER, model_overrides)
    return apply_org_credential(overridden, org_credential)


def request_turn(
    provider: LLMProvider,
    tools: Sequence[BaseTool],
    planner_llm: BaseChatModel | None,
    state: ClarifierAgentState,
) -> TurnConfig | None:
    """What this request varies from the boot-time agent, or None when nothing does.

    Two sources of variation, both per-org: the runtime model override
    (X-Grid-Model-Overrides), the provider credential (BYOK) and ZDR routing on
    the LLM side; the data sources this request selected on the tool side. The
    planner LLM belongs to the same ``clarifier`` agent group.
    """
    # No `data_sources is not None` guard: org-disabled sources (ADR-0022)
    # narrow the tool set even when the request selects "all tools".
    selected_tools = filter_tools_by_sources(tools, state.data_sources)
    if all_mapped_tools_filtered_out(tools, selected_tools, state.data_sources):
        logger.warning("Clarifier received data_sources with no matching tools")
    model_overrides = get_model_overrides_from_context()
    org_credential = get_org_llm_credential_from_context()
    active_provider = (
        provider.with_model_overrides(model_overrides)
        .with_credential(org_credential)
        .with_zdr(get_zdr_only_from_context())
    )
    if active_provider is provider and selected_tools == list(tools):
        return None
    return TurnConfig(
        llm_provider=active_provider,
        tools=selected_tools,
        planner_llm=_request_planner(planner_llm, model_overrides, org_credential),
    )


@register_function(config_type=ClarifierConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def clarifier_agent(config: ClarifierConfig, builder: Builder):
    """
    NAT function for interactive clarification dialog.

    Builds one ClarifierAgent at registration. Per-request variation — the
    org's model override, its BYOK credential, ZDR routing, and the data
    sources this request selected — travels as a ``TurnConfig`` into
    ``agent.run``, so nothing is rebuilt and no prompt is re-read to serve a
    request.

    Args:
        config: ClarifierConfig with LLM reference, tools, and settings.
        builder: NAT Builder for obtaining LLM and tool instances.

    Yields:
        FunctionInfo: A callable that accepts ClarifierAgentState and returns
            the ClarifierResult of the clarification dialog.
    """
    llm = await get_langchain_llm(builder, config.llm)
    planner_llm = await get_langchain_llm(builder, config.planner_llm) if config.planner_llm else None
    tools = await resolve_tools(config, builder)

    provider = LLMProvider()
    provider.set_default(llm, group=AgentGroup.CLARIFIER)

    verbose = is_verbose(config.verbose)
    callbacks = [VerboseTraceCallback(log_reasoning=True, max_chars=config.log_response_max_chars)] if verbose else []

    agent = ClarifierAgent(
        llm_provider=provider,
        tools=tools,
        user_prompt_callback=ask_through_nat,
        max_turns=config.max_turns,
        enable_plan_approval=config.enable_plan_approval,
        max_plan_iterations=config.max_plan_iterations,
        planner_llm=planner_llm,
        callbacks=callbacks,
    )

    async def _run(state: ClarifierAgentState) -> ClarifierResult:
        """Run the clarification dialog on the provided chat history.

        Args:
            state: ClarifierAgentState with conversation messages.

        Returns:
            ClarifierResult with clarification log and plan approval details.
        """
        return await agent.run(state, turn=request_turn(provider, tools, planner_llm, state))

    yield FunctionInfo.from_fn(
        _run,
        description=(
            "Handles interactive clarification dialog with users "
            "for deep research queries. Asks follow-up questions and refines the research "
            "scope, constraints, and requirements before planning begins."
        ),
    )
