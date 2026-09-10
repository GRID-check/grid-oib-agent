"""NAT register function for deep research agent."""

import asyncio
import logging
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import TypeVar

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langgraph.types import Checkpointer
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
from aiq_agent.common import format_user_facing_tool_error
from aiq_agent.common import get_all_tool_refs
from aiq_agent.common import get_checkpointer
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import get_org_llm_credential_from_context
from aiq_agent.common import get_zdr_only_from_context
from aiq_agent.common import is_verbose
from aiq_agent.common import validate_tool_availability
from nat.builder.builder import Builder
from nat.builder.context import Context
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
from .agent import DEFAULT_MAX_RUN_SECONDS
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
    max_run_seconds: int = Field(
        default=DEFAULT_MAX_RUN_SECONDS,
        ge=0,
        description="Wall-clock budget for one deep-research run in seconds; 0 disables the guard.",
    )
    checkpoint_db: str | None = Field(
        default=None,
        description="Optional SQLite database path or Postgres DSN for durable per-job checkpointing of "
        "deep-research runs (LangGraph thread_id = job_id), enabling resume of a re-invoked job after a "
        "worker crash. None (default) keeps current behavior: an in-memory-only graph with no execution-"
        "state durability. Mirrors the workflow-level chat checkpoint_db pattern, but opt-in "
        "here since deep-research jobs run in ephemeral Dask worker processes.",
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


# ---------------------------------------------------------------------------
# Registration-time construction
# ---------------------------------------------------------------------------


async def _resolve_tools(builder: Builder, tool_refs: list[str], exclude_tools: list[str]) -> list:
    resolved = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
    if not exclude_tools:
        return resolved
    excluded = set(exclude_tools)
    return [t for t in resolved if getattr(t, "name", "") not in excluded]


async def _explicit_tools(builder: Builder, config: DeepResearchAgentConfig) -> list | None:
    """Eagerly resolved tools for an explicit ``config.tools``; None when inheriting.

    When tools are inherited (``config.tools`` empty) the data_source_registry
    may not be populated at BUILD time — NAT adds no build-order dependency in
    that case — so eager resolution would capture an empty list. Those are
    resolved lazily on the first request instead (:class:`LazyTools`).
    """
    if not config.tools:
        return None
    tools = await _resolve_tools(builder, list(config.tools), config.exclude_tools)
    is_valid, _, _ = validate_tool_availability(tools, research_type="deep research")
    if not is_valid:
        logger.warning(
            "Startup check: no tools available for deep research. "
            "All queries will fail until at least one tool is properly configured.",
        )
    return tools


#: The optional per-role LLMs, with the role and group each is configured under.
_ROLE_LLM_FIELDS: tuple[tuple[str, LLMRole, AgentGroup], ...] = (
    ("source_router_llm", LLMRole.ROUTER, AgentGroup.DEEP_RESEARCH_ROUTER),
    ("researcher_llm", LLMRole.RESEARCHER, AgentGroup.DEEP_RESEARCH),
    ("planner_llm", LLMRole.PLANNER, AgentGroup.DEEP_RESEARCH),
    ("writer_llm", LLMRole.REPORT_WRITER, AgentGroup.DEEP_RESEARCH),
)


async def _build_provider(builder: Builder, config: DeepResearchAgentConfig) -> LLMProvider:
    """The role-based provider, its LLMs resolved concurrently.

    Registration-only cost, but on the worker cold-start path the ghost reaper
    measures, so the five independent resolutions are one gather.
    """
    configured = [(name, role, group) for name, role, group in _ROLE_LLM_FIELDS if getattr(config, name)]
    refs = [config.orchestrator_llm, *(getattr(config, name) for name, _, _ in configured)]
    orchestrator_llm, *role_llms = await asyncio.gather(*(get_langchain_llm(builder, ref) for ref in refs))
    provider = LLMProvider()
    provider.set_default(orchestrator_llm, group=AgentGroup.DEEP_RESEARCH)
    provider.configure(LLMRole.ORCHESTRATOR, orchestrator_llm, group=AgentGroup.DEEP_RESEARCH)
    for (_, role, group), llm in zip(configured, role_llms, strict=True):
        provider.configure(role, llm, group=group)
    return provider


async def _open_checkpointer(checkpoint_db: str | None) -> Checkpointer | None:
    """The optional durable checkpointer, built once and shared by every agent built here.

    ``get_checkpointer`` caches by path/DSN, so this is a cache hit when the
    async job runner already opened the same one. Fails OPEN: durable
    checkpointing is an optional resilience feature, and an unopenable DB
    (read-only container FS, missing volume, bad DSN) must degrade to the
    in-memory default with a loud warning, never take application startup down.
    """
    if not checkpoint_db:
        return None
    try:
        return await get_checkpointer(checkpoint_db)
    except Exception:  # noqa: BLE001 - deliberate fail-open boundary
        logger.warning(
            "Durable deep-research checkpointing DISABLED: cannot open checkpoint_db %r "
            "(set AIQ_DEEP_CHECKPOINT_DB to a writable path/DSN to enable resume-by-job_id)",
            checkpoint_db,
            exc_info=True,
        )
        return None


@dataclass(frozen=True)
class _AgentBlueprint:
    """Everything a ``DeepResearcherAgent`` is built from, minus the tools."""

    config: DeepResearchAgentConfig
    provider: LLMProvider
    verbose: bool
    callbacks: list[Any]
    skills: DeepResearchSkillsConfig | None
    sandbox: DeepResearchSandboxConfig | None
    checkpointer: Checkpointer | None

    def build(self, tools: list, *, llm_provider: LLMProvider | None = None, job_id: str | None = None):
        """One constructor call for the eager, lazy and per-request build sites.

        Omitted overrides fall back to the registration-time provider and a
        fresh job_id, so per-request paths (model overrides / BYOK credential,
        source-filtered tools, sandbox-scoped job_id) reuse the same kwargs.
        """
        config = self.config
        return DeepResearcherAgent(
            llm_provider=llm_provider if llm_provider is not None else self.provider,
            tools=tools,
            verbose=self.verbose,
            callbacks=self.callbacks,
            domain_catalog_path=config.domain_catalog_path,
            enable_source_router=config.enable_source_router,
            enable_citation_verification=config.enable_citation_verification,
            skills=self.skills,
            sandbox=self.sandbox,
            job_id=job_id,
            max_research_concurrency=config.max_research_concurrency,
            max_concurrent_source_tool_calls=config.max_concurrent_source_tool_calls,
            max_source_tool_batch_size=config.max_source_tool_batch_size,
            max_run_seconds=config.max_run_seconds,
            checkpointer=self.checkpointer,
        )


@dataclass
class LazyTools:
    """The (tools, prebuilt agent) pair, resolved once and on first use.

    Populated eagerly for an explicit ``config.tools``; for inherited tools it
    is filled by the first request that resolves a non-empty set, so an early
    request that races registry population is retried on the next call. A
    genuinely empty set is handled by the runtime gate in :func:`run_deep_research`.
    """

    builder: Builder
    blueprint: _AgentBlueprint
    tools: list | None = None
    agent: DeepResearcherAgent | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def get(self) -> tuple[list, DeepResearcherAgent]:
        if self.tools is not None and self.agent is not None:
            return self.tools, self.agent
        async with self.lock:
            if self.tools is not None and self.agent is not None:
                return self.tools, self.agent
            tools = await _resolve_tools(self.builder, get_all_tool_refs(), self.blueprint.config.exclude_tools)
            agent = self.blueprint.build(tools)
            if tools:
                self.tools, self.agent = tools, agent
            return tools, agent


# ---------------------------------------------------------------------------
# Request time
# ---------------------------------------------------------------------------


def _agent_for_request(
    blueprint: _AgentBlueprint,
    prebuilt: DeepResearcherAgent,
    tools: list,
    selected_tools: list,
) -> DeepResearcherAgent:
    """The prebuilt agent, or a per-request one when something differs.

    Per-org model overrides and the org's BYOK credential / ZDR flag
    (ADR-0022) come off the request context; an identity check on the provider
    means "nothing to apply" keeps the prebuilt agent. There is deliberately no
    ``data_sources is not None`` guard: org-disabled sources narrow
    ``selected_tools`` even on "all tools" requests. A sandbox is scoped to the
    async job_id NAT carries (set by ``aiq_api/jobs/runner.py``; a per-request
    uuid in ``DeepAgentsRuntime`` when None), so it is always rebuilt.
    """
    provider = (
        blueprint.provider.with_model_overrides(get_model_overrides_from_context())
        .with_credential(get_org_llm_credential_from_context())
        .with_zdr(get_zdr_only_from_context())
    )
    if provider is blueprint.provider and blueprint.sandbox is None and selected_tools == tools:
        return prebuilt
    return blueprint.build(selected_tools, llm_provider=provider, job_id=Context.get().workflow_run_id)


async def run_deep_research(state: DeepResearchAgentState, lazy: LazyTools) -> DeepResearchAgentState:
    """Run deep research for one request against the resolved tool set."""
    tools, agent = await lazy.get()
    selected_tools = filter_tools_by_sources(tools, state.data_sources)
    active_agent = _agent_for_request(lazy.blueprint, agent, tools, selected_tools)
    if all_mapped_tools_filtered_out(tools, selected_tools, state.data_sources):
        logger.warning("Deep research received data_sources with no matching tools")
    # At least one tool must be available, or the agent would reason about
    # tools it cannot call. ``selected_tools`` already reflects data_sources.
    is_valid, _, unavailable_tools = validate_tool_availability(selected_tools, research_type="deep research")
    if not is_valid:
        error_msg = format_user_facing_tool_error("deep research", unavailable_tools)
        return DeepResearchAgentState(messages=state.messages + [AIMessage(content=error_msg)])
    return await active_agent.run(state)


@register_function(config_type=DeepResearchAgentConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def deep_research_agent(config: DeepResearchAgentConfig, builder: Builder):
    """Deep research agent using multi-phase workflow."""
    skills_config, sandbox_config = resolve_deep_research_runtime_config(config, builder)
    explicit_tools, provider, checkpointer = await asyncio.gather(
        _explicit_tools(builder, config),
        _build_provider(builder, config),
        _open_checkpointer(config.checkpoint_db),
    )
    verbose = is_verbose(config.verbose)
    blueprint = _AgentBlueprint(
        config=config,
        provider=provider,
        verbose=verbose,
        callbacks=[VerboseTraceCallback()] if verbose else [],
        skills=skills_config,
        sandbox=sandbox_config,
        checkpointer=checkpointer,
    )
    lazy = LazyTools(
        builder=builder,
        blueprint=blueprint,
        tools=explicit_tools,
        agent=blueprint.build(explicit_tools) if explicit_tools is not None else None,
    )

    async def _run(state: DeepResearchAgentState) -> DeepResearchAgentState:
        """Run deep research with a list of messages or payload."""
        return await run_deep_research(state, lazy)

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
