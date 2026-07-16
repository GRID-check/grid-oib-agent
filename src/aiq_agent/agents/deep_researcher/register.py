"""NAT register function for deep research agent."""

import asyncio
import logging
from typing import Any
from typing import TypeVar

from langchain_core.messages import HumanMessage
from pydantic import ConfigDict
from pydantic import Field
from pydantic import field_validator

from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import VerboseTraceCallback
from aiq_agent.common import _create_chat_response
from aiq_agent.common import all_mapped_tools_filtered_out
from aiq_agent.common import filter_tools_by_sources
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import get_org_llm_credential_from_context
from aiq_agent.common import is_verbose
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.api_server import ChatResponse
from nat.data_models.component_ref import FunctionGroupRef
from nat.data_models.component_ref import FunctionRef
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig

from .agent import DEFAULT_MAX_CONCURRENT_SOURCE_TOOL_CALLS
from .agent import DEFAULT_MAX_RESEARCH_CONCURRENCY
from .agent import DEFAULT_MAX_SOURCE_TOOL_BATCH_SIZE
from .agent import DeepResearcherAgent
from .deepagents_runtime import DeepResearchSandboxConfig
from .deepagents_runtime import DeepResearchSkillsConfig
from .models import DeepResearchAgentState

logger = logging.getLogger(__name__)

ConfigT = TypeVar("ConfigT")


class DeepResearchAgentConfig(FunctionBaseConfig, name="deep_research_agent"):
    """Configuration for the deep research agent."""

    model_config = ConfigDict(extra="forbid")

    orchestrator_llm: LLMRef = Field(..., description="LLM for orchestrator")
    source_router_llm: LLMRef | None = Field(default=None, description="LLM for source-router subagent")
    researcher_llm: LLMRef | None = Field(default=None, description="LLM for researcher")
    planner_llm: LLMRef | None = Field(default=None, description="LLM for planner")
    writer_llm: LLMRef | None = Field(default=None, description="LLM for final writer/synthesis subagent")
    tools: list[FunctionRef | FunctionGroupRef] = Field(
        default_factory=list,
        description="Explicit tool list. Empty = inherit all from data_source_registry.",
    )
    exclude_tools: list[str] = Field(
        default_factory=list,
        description="Tool names to exclude when inheriting from registry.",
    )
    verbose: bool = Field(default=True)
    domain_catalog_path: str | None = Field(
        default=None,
        description="Optional YAML/JSON domain catalog path for source-router-agent.",
    )
    enable_source_router: bool = Field(
        default=True,
        description="Enable the advisory source-router-agent before planning.",
    )
    enable_citation_verification: bool = Field(
        default=True,
        description="Verify generated citations against sources captured from configured tools.",
    )
    skills: DeepResearchSkillsConfig | FunctionRef | None = Field(
        default=None,
        description="Optional inline skills config or function ref to a deep_research_skills config.",
    )
    sandbox: DeepResearchSandboxConfig | FunctionRef | None = Field(
        default=None,
        description="Optional inline sandbox config or function ref to a deep_research_sandbox config.",
    )
    max_research_concurrency: int = Field(
        default=DEFAULT_MAX_RESEARCH_CONCURRENCY,
        ge=1,
        description="Maximum ResearchQuery items accepted and run concurrently per run_research_batch call.",
    )
    max_concurrent_source_tool_calls: int = Field(
        default=DEFAULT_MAX_CONCURRENT_SOURCE_TOOL_CALLS,
        ge=1,
        description="Shared maximum concurrent source-tool calls across researcher workers.",
    )
    max_source_tool_batch_size: int = Field(
        default=DEFAULT_MAX_SOURCE_TOOL_BATCH_SIZE,
        ge=1,
        description="Maximum concrete inputs accepted by batch-capable source tool wrappers.",
    )

    @field_validator("skills", mode="before")
    @classmethod
    def _parse_inline_skills(cls, value):
        if isinstance(value, dict):
            return DeepResearchSkillsConfig.model_validate(value)
        return value

    @field_validator("sandbox", mode="before")
    @classmethod
    def _parse_inline_sandbox(cls, value):
        if isinstance(value, dict):
            return DeepResearchSandboxConfig.model_validate(value)
        return value


@register_function(config_type=DeepResearchSkillsConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def deep_research_skills(config: DeepResearchSkillsConfig, builder: Builder):
    """Config-only function for deep research skill collection assignments."""

    async def _noop(query: str) -> str:
        """Deep research skills config placeholder."""
        return "This is a config-only function."

    yield FunctionInfo.from_fn(_noop, description="Deep research skills config-only function.")


@register_function(config_type=DeepResearchSandboxConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def deep_research_sandbox(config: DeepResearchSandboxConfig, builder: Builder):
    """Config-only function for deep research sandbox settings."""

    async def _noop(query: str) -> str:
        """Deep research sandbox config placeholder."""
        return "This is a config-only function."

    yield FunctionInfo.from_fn(_noop, description="Deep research sandbox config-only function.")


def _resolve_config_ref(
    builder: Builder, value: ConfigT | FunctionRef | None, expected_type: type[ConfigT]
) -> ConfigT | None:
    if value is None or isinstance(value, expected_type):
        return value

    resolved = builder.get_function_config(value)
    if not isinstance(resolved, expected_type):
        raise TypeError(f"{value!r} must reference {expected_type.__name__}, got {type(resolved).__name__}")
    return resolved


def resolve_deep_research_runtime_config(
    config: DeepResearchAgentConfig,
    builder: Builder,
) -> tuple[DeepResearchSkillsConfig | None, DeepResearchSandboxConfig | None]:
    """Resolve optional Deep Research runtime config refs into concrete config objects."""
    skills = _resolve_config_ref(builder, config.skills, DeepResearchSkillsConfig)
    sandbox = _resolve_config_ref(builder, config.sandbox, DeepResearchSandboxConfig)
    return skills, sandbox


@register_function(config_type=DeepResearchAgentConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def deep_research_agent(config: DeepResearchAgentConfig, builder: Builder):
    """Deep research agent using multi-phase workflow."""
    skills_config, sandbox_config = resolve_deep_research_runtime_config(config, builder)

    async def _resolve_tools(tool_refs: list[str]) -> list:
        resolved = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
        if config.exclude_tools:
            excluded = set(config.exclude_tools)
            resolved = [t for t in resolved if getattr(t, "name", "") not in excluded]
        return resolved

    # Tool resolution is eager only when tools are configured explicitly. When
    # tools are inherited (config.tools empty), the data_source_registry may not
    # be populated at BUILD time -- NAT adds no build-order dependency in that
    # case -- so eager resolution would capture an empty list. Resolve those
    # lazily on the first request instead (see _ensure_resolved below).
    explicit_tools: list | None = None
    if config.tools:
        explicit_tools = await _resolve_tools(list(config.tools))

        from aiq_agent.common import validate_tool_availability

        is_valid, available_count, unavailable = validate_tool_availability(
            explicit_tools,
            research_type="deep research",
        )
        if not is_valid:
            logger.warning(
                "Startup check: no tools available for deep research. "
                "All queries will fail until at least one tool is properly configured.",
            )

    llm = await get_langchain_llm(builder, config.orchestrator_llm)

    provider = LLMProvider()
    provider.set_default(llm, group=AgentGroup.DEEP_RESEARCH)

    provider.configure(LLMRole.ORCHESTRATOR, llm, group=AgentGroup.DEEP_RESEARCH)
    if config.source_router_llm:
        source_router_llm = await get_langchain_llm(builder, config.source_router_llm)
        provider.configure(LLMRole.ROUTER, source_router_llm, group=AgentGroup.DEEP_RESEARCH_ROUTER)
    if config.researcher_llm:
        researcher_llm = await get_langchain_llm(builder, config.researcher_llm)
        provider.configure(LLMRole.RESEARCHER, researcher_llm, group=AgentGroup.DEEP_RESEARCH)
    if config.planner_llm:
        planner_llm = await get_langchain_llm(builder, config.planner_llm)
        provider.configure(LLMRole.PLANNER, planner_llm, group=AgentGroup.DEEP_RESEARCH)
    if config.writer_llm:
        writer_llm = await get_langchain_llm(builder, config.writer_llm)
        provider.configure(LLMRole.REPORT_WRITER, writer_llm, group=AgentGroup.DEEP_RESEARCH)

    verbose = is_verbose(config.verbose)
    callbacks = [VerboseTraceCallback()] if verbose else []

    def _build_agent(
        tool_list: list,
        *,
        llm_provider: Any = None,
        job_id: str | None = None,
    ) -> DeepResearcherAgent:
        # Optional overrides let per-request paths (model overrides / BYOK
        # credential, source-filtered tools, sandbox-scoped job_id) reuse this
        # single constructor call instead of duplicating every kwarg. Omitted
        # overrides fall back to the module-level provider / a fresh job_id,
        # matching the eager and lazy build sites.
        return DeepResearcherAgent(
            llm_provider=llm_provider if llm_provider is not None else provider,
            tools=tool_list,
            verbose=verbose,
            callbacks=callbacks,
            domain_catalog_path=config.domain_catalog_path,
            enable_source_router=config.enable_source_router,
            enable_citation_verification=config.enable_citation_verification,
            skills=skills_config,
            sandbox=sandbox_config,
            job_id=job_id,
            max_research_concurrency=config.max_research_concurrency,
            max_concurrent_source_tool_calls=config.max_concurrent_source_tool_calls,
            max_source_tool_batch_size=config.max_source_tool_batch_size,
        )

    # Cache of the lazily-resolved (tools, prebuilt agent) pair. For explicit
    # config.tools this is populated eagerly at build time; for inherited tools
    # it is filled on the first request that resolves a non-empty tool set.
    _resolved: dict[str, Any] = {"tools": None, "agent": None}
    if explicit_tools is not None:
        _resolved["tools"] = explicit_tools
        _resolved["agent"] = _build_agent(explicit_tools)
    _resolve_lock = asyncio.Lock()

    async def _ensure_resolved() -> tuple[list, DeepResearcherAgent]:
        """Resolve inherited tools + prebuilt agent, lazily and once."""
        if _resolved["tools"] is not None:
            return _resolved["tools"], _resolved["agent"]
        async with _resolve_lock:
            if _resolved["tools"] is not None:
                return _resolved["tools"], _resolved["agent"]
            from aiq_agent.common import get_all_tool_refs

            tool_refs = get_all_tool_refs()
            resolved_tools = await _resolve_tools(tool_refs)
            agent_local = _build_agent(resolved_tools)
            # Cache only a successful (non-empty) resolution so an early request
            # that races registry population is retried on the next call. A
            # genuinely-empty set is handled by the runtime gate below.
            if resolved_tools:
                _resolved["tools"] = resolved_tools
                _resolved["agent"] = agent_local
            return resolved_tools, agent_local

    async def _run(state: DeepResearchAgentState) -> DeepResearchAgentState:
        """Run deep research with a list of messages or payload."""
        try:
            tools, agent = await _ensure_resolved()
            data_sources = state.data_sources
            selected_tools = filter_tools_by_sources(tools, data_sources)
            # Per-org runtime model overrides (X-Grid-Model-Overrides); identity
            # check means "no override for deep research" keeps the prebuilt agent.
            # Model overrides + the org's BYOK credential (ADR-0022); identity
            # check means "nothing to apply" keeps the prebuilt agent.
            active_provider = provider.with_model_overrides(get_model_overrides_from_context()).with_credential(
                get_org_llm_credential_from_context()
            )
            active_agent = agent
            if (
                active_provider is not provider
                or sandbox_config is not None
                # No `data_sources is not None` guard: org-disabled sources
                # (ADR-0022) narrow selected_tools even on "all tools" requests.
                or selected_tools != tools
            ):
                # Scope the Modal sandbox to the async job_id when one is in
                # NAT context (set by aiq_api/jobs/runner.py). Falls back to a
                # per-request uuid in DeepAgentsRuntime when None.
                job_id: str | None = None
                try:
                    from nat.builder.context import Context

                    job_id = Context.get().workflow_run_id
                except Exception:  # noqa: BLE001 - Context may be unavailable in sync/eval paths
                    job_id = None
                active_agent = _build_agent(selected_tools, llm_provider=active_provider, job_id=job_id)

            if all_mapped_tools_filtered_out(tools, selected_tools, data_sources):
                logger.warning("Deep research received data_sources with no matching tools")

            # Validate tool availability before starting deep research
            # At least one tool must be available
            # This prevents the agent from trying to reason about unavailable tools
            # Check selected_tools directly - they already reflect data_sources filtering
            from aiq_agent.common import format_user_facing_tool_error
            from aiq_agent.common import validate_tool_availability

            is_valid, _, unavailable_tools = validate_tool_availability(selected_tools, research_type="deep research")

            # Fail if no tools are available
            if not is_valid:
                error_msg = format_user_facing_tool_error("deep research", unavailable_tools)

                # Return error state with error message - this prevents the agent from running
                from langchain_core.messages import AIMessage

                error_state = DeepResearchAgentState(messages=state.messages + [AIMessage(content=error_msg)])
                return error_state

            result = await active_agent.run(state)
            return result
        except Exception:
            logger.exception("Error in deep research execution")
            raise

    yield FunctionInfo.from_fn(_run, description="Deep research agent for comprehensive multi-phase research.")


########################################################
# Deep Research Workflow (Wrapper for Evaluation)
########################################################
class DeepResearchWorkflowConfig(FunctionBaseConfig, name="deep_research_workflow"):
    """Configuration for the deep research workflow wrapper.

    This wrapper accepts a string query and converts it to messages
    for the deep_research_agent. Use this as the workflow for evaluation.
    """

    pass


@register_function(config_type=DeepResearchWorkflowConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def deep_research_workflow(config: DeepResearchWorkflowConfig, builder: Builder):
    """Wrapper workflow that accepts string queries for evaluation."""
    deep_research_agent_fn = await builder.get_function("deep_research_agent")
    workflow_id = config.name or config.type

    async def _run(query: str, project_context: str | None = None) -> ChatResponse:
        """Run deep research on a query string."""
        state = DeepResearchAgentState(messages=[HumanMessage(content=query)], project_context=project_context)
        result = await deep_research_agent_fn.ainvoke(state)
        response_content = result.messages[-1].content
        return _create_chat_response(response_content, response_id="research_response", model=workflow_id)

    yield FunctionInfo.from_fn(_run, description="Deep research workflow for evaluation (accepts string query).")
