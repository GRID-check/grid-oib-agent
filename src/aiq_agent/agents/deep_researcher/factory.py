"""Graph and middleware factory for the deep researcher agent and its subagents."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from deepagents import create_deep_agent
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.filesystem import FilesystemPermission
from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from deepagents.middleware.summarization import create_summarization_middleware
from langchain.agents import create_agent
from langchain.agents.middleware import ModelRetryMiddleware
from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool
from langchain_core.tools import tool
from langgraph.store.memory import InMemoryStore
from langgraph.types import Checkpointer

from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import render_prompt_template
from aiq_agent.common.norm_registry import JURISDICTION_GROUNDING
from aiq_agent.common.norm_registry import doctrine_for
from aiq_agent.common.norm_registry import parcel_note
from aiq_agent.common.norm_registry import render_block_for_prompt

from .custom_middleware import DeferredStructuredOutputMiddleware
from .custom_middleware import EmptyContentFixMiddleware
from .custom_middleware import SelectiveToolRetryMiddleware
from .custom_middleware import SourceRegistryMiddleware
from .custom_middleware import ToolNameSanitizationMiddleware
from .custom_middleware import ToolResultPruningMiddleware
from .custom_middleware import ToolVisibilityMiddleware
from .custom_middleware import is_retryable_tool_error
from .deepagents_runtime import BUILTIN_SKILL_SOURCE
from .deepagents_runtime import DeepAgentsRuntime
from .models import DeepResearchAgentState
from .models import ResearchNotes
from .models import ResearchPlan
from .tools.research import _positive_int_env
from .tools.research import build_research_batch_tool
from .tools.source_registry import build_get_verified_sources_tool
from .tools.source_routing import build_lookup_source_catalog_tool
from .tools.source_tool_batching import adapt_source_tools_for_research

logger = logging.getLogger(__name__)

# Orchestrator graph recursion limit. Lowered from the LangGraph default (25)
# and from the previous hard-coded 2000 so it can actually fire as a hard stop
# before the 40-minute wall-clock kill surfaces as a generic internal error.
# 150 steps is generous: each plan→batch→synthesis cycle costs ~5–10 steps,
# so 150 allows ~15–30 cycles before the limit triggers.
_ORCHESTRATOR_RECURSION_LIMIT = 150

FILESYSTEM_TOOL_NAMES = {
    "edit_file",
    "execute",
    "grep",
    "glob",
    "ls",
    "read_file",
    "write_file",
}
ORCHESTRATOR_AGENT = "orchestrator"
PLANNER_AGENT = "planner-agent"
RESEARCHER_AGENT = "researcher-agent"
SOURCE_ROUTER_AGENT = "source-router-agent"
WRITER_AGENT = "writer-agent"


@tool
def think(thought: str) -> str:
    """Use this tool to reason through decisions, verify constraints, or plan next steps."""
    return "Thought recorded."


@dataclass(frozen=True)
class DeepResearchToolSet:
    """Tool groupings used by the deep researcher graph and subagents."""

    source_tool_names: set[str]
    tools_info: list[dict[str, str]]
    helper_tools: list[BaseTool]
    all_tools: list[BaseTool]
    research_source_tools: list[BaseTool]
    researcher_tools: list[BaseTool]
    writer_tools: list[BaseTool]
    #: The ``use_skill`` closure of THIS run, when platform/org skills resolved.
    #: Already inside ``writer_tools``; kept separately because the writer's
    #: sanitizer has to be told the name (see ``build_deep_research_middleware_set``)
    #: and because it is the one tool in the set whose existence is per-run.
    writer_skill_tools: list[BaseTool]


@dataclass(frozen=True)
class DeepResearchMiddlewareSet:
    """Middleware stacks used by the deep researcher graph and subagents."""

    researcher: list[Any]
    planner: list[Any]
    writer: list[Any]
    orchestrator: list[Any]


@dataclass(frozen=True)
class DeepResearchGraphContext:
    """Shared graph-build inputs used by the orchestrator and subagent specs."""

    llm_provider: LLMProvider
    state: DeepResearchAgentState
    prompts: dict[str, str]
    tools: Sequence[BaseTool]
    runtime: DeepAgentsRuntime
    tool_set: DeepResearchToolSet
    middleware_set: DeepResearchMiddlewareSet
    domain_catalog_path: str | None
    current_datetime: str
    max_research_concurrency: int
    enable_source_router: bool
    backend: Any
    visibility_middleware: list[Any]
    #: The resolved platform/org skills for THIS run, rendered as the catalog +
    #: "Active skills" blocks the writer prompt shows. None when none
    #: resolved — including every run where the BFF could not be reached, which
    #: is why the writer prompt has to read as a complete instruction without it.
    skills_block: str | None = None

    @property
    def available_documents(self) -> list[dict[str, Any]]:
        return [doc.model_dump() for doc in (self.state.available_documents or [])]

    @property
    def project_context(self) -> str | None:
        return self.state.project_context

    @property
    def ris_catalog(self) -> str | None:
        """Lane-rendered norm registry block for prompts; None when the registry is unavailable."""
        return render_block_for_prompt(self.project_context)

    def render_prompt(self, prompt_name: str, **values: Any) -> str:
        return render_prompt_template(
            self.prompts[prompt_name],
            current_datetime=self.current_datetime,
            user_info=self.state.user_info,
            available_documents=self.available_documents,
            project_context=self.project_context,
            platform_lessons=self.state.platform_lessons,
            ris_catalog=self.ris_catalog,
            norm_doctrine=doctrine_for(self.project_context),
            jurisdiction_grounding=JURISDICTION_GROUNDING,
            parcel_note=parcel_note(self.available_documents),
            **values,
        )

    def middleware(self, base: Sequence[Any]) -> list[Any]:
        return [*base, *self.visibility_middleware]

    def permissions(self, agent_name: str) -> list[FilesystemPermission]:
        return runtime_skill_filesystem_permissions(self.runtime, agent_name)

    def skill_sources(self, agent_name: str) -> list[str] | None:
        return self.runtime.skill_sources_for(agent_name)


def build_deep_research_tool_set(
    tools: Sequence[BaseTool],
    *,
    source_registry_middleware: SourceRegistryMiddleware,
    max_concurrent_source_tool_calls: int,
    max_source_tool_batch_size: int,
    writer_skill_tools: Sequence[BaseTool] = (),
) -> DeepResearchToolSet:
    """Build helper, researcher, writer, and source tool groupings."""
    source_tool_names = {tool.name for tool in tools}
    helper_tools = [think, build_get_verified_sources_tool(source_registry_middleware)]
    research_source_tools = adapt_source_tools_for_research(
        list(tools),
        source_tool_names=source_tool_names,
        max_concurrent_source_tool_calls=max_concurrent_source_tool_calls,
        max_batch_size=max_source_tool_batch_size,
    )
    return DeepResearchToolSet(
        source_tool_names=source_tool_names,
        tools_info=[{"name": tool.name, "description": tool.description} for tool in tools],
        helper_tools=helper_tools,
        all_tools=[*helper_tools, *tools],
        research_source_tools=research_source_tools,
        researcher_tools=[*helper_tools, *research_source_tools],
        # ``use_skill`` goes to the WRITER and to no one else. A platform skill
        # that reaches this agent is an instruction about the ANSWER — the house
        # voice is the type case — and the answer is written here; the researcher
        # has a skills channel of its own in the sandbox mount.
        writer_tools=[*helper_tools, *writer_skill_tools],
        writer_skill_tools=list(writer_skill_tools),
    )


# run_research_batch raises deliberate errors (oversized batch, partial worker
# failure) that the ORCHESTRATOR must react to; re-executing the whole batch
# below the LLM would re-run every already-successful multi-LLM-call worker.
_NO_RETRY_TOOL_NAMES = frozenset({"run_research_batch"})


def _is_transient_model_error(exc: Exception) -> bool:
    """Retry model calls only on transient provider errors.

    The default retry_on=(Exception,) also retried permanent failures (schema
    rejections, auth errors, context overflow), stacking on top of the OpenAI
    client's own max_retries and multiplying latency for calls that can never
    succeed. Retry only what a wait can fix: rate limits, timeouts, transport
    errors, and 5xx.
    """
    import openai

    if isinstance(exc, (openai.RateLimitError, openai.APITimeoutError, openai.APIConnectionError)):
        return True
    if isinstance(exc, openai.APIStatusError):
        return 500 <= exc.status_code < 600
    return False


def _model_retry_middleware() -> ModelRetryMiddleware:
    return ModelRetryMiddleware(
        max_retries=2, backoff_factor=2.0, initial_delay=1.0, retry_on=_is_transient_model_error
    )


# The writer must read the plan, EVERY research note file, get_verified_sources,
# and skill files without truncation; pruning any of them corrupts the final
# synthesis and the citation whitelist. Sized as assumed-max research batches
# times per-batch queries, plus headroom for plan/skill/source reads.
_WRITER_ASSUMED_MAX_BATCHES = 5
_WRITER_TOOL_RESULT_HEADROOM = 20
_WRITER_MAX_TOOL_RESULT_CHARS = 20_000

# Total-character budget for the writer's tool-result context. Even with
# per-message max_chars and keep_last_n, the sum of all kept tool results can
# grow unbounded (e.g. many research-note files each at 20K chars). When the
# total exceeds this ceiling, the oldest oversized messages are truncated too.
# Overridable via GRID_WRITER_CHAR_BUDGET (falls back on unset/invalid/<=0).
_WRITER_CHAR_BUDGET = _positive_int_env("GRID_WRITER_CHAR_BUDGET", 200_000)

DEFAULT_TOOL_RESULT_KEEP_LAST_N = 10
DEFAULT_TOOL_RESULT_MAX_CHARS = 2000


def writer_tool_result_keep_last_n(max_research_concurrency: int) -> int:
    """Return a writer keep-last-n that covers every research note plus headroom."""
    return max_research_concurrency * _WRITER_ASSUMED_MAX_BATCHES + _WRITER_TOOL_RESULT_HEADROOM


def build_common_middleware(
    *,
    tool_set: DeepResearchToolSet,
    source_registry_middleware: SourceRegistryMiddleware,
    extra_valid_tool_names: Sequence[str] = (),
    tool_result_keep_last_n: int = DEFAULT_TOOL_RESULT_KEEP_LAST_N,
    tool_result_max_chars: int = DEFAULT_TOOL_RESULT_MAX_CHARS,
    tool_result_total_char_budget: int = 0,
) -> list[Any]:
    """Build the shared middleware stack with agent-specific valid tool names."""
    valid_tool_names = {tool.name for tool in [*tool_set.all_tools, *tool_set.researcher_tools]}
    valid_tool_names.update(FILESYSTEM_TOOL_NAMES)
    valid_tool_names.update(extra_valid_tool_names)
    return [
        EmptyContentFixMiddleware(),
        ToolNameSanitizationMiddleware(valid_tool_names=sorted(valid_tool_names)),
        SelectiveToolRetryMiddleware(
            max_retries=3,
            backoff_factor=2.0,
            initial_delay=1.0,
            retry_on=is_retryable_tool_error,
            no_retry_tools=_NO_RETRY_TOOL_NAMES,
        ),
        source_registry_middleware,
        ToolResultPruningMiddleware(
            keep_last_n=tool_result_keep_last_n,
            max_chars=tool_result_max_chars,
            total_char_budget=tool_result_total_char_budget,
        ),
        _model_retry_middleware(),
    ]


def build_source_router_middleware(*, extra_valid_tool_names: Sequence[str] = ()) -> list[Any]:
    """Build minimal middleware for the source-router-agent."""
    return [
        EmptyContentFixMiddleware(),
        ToolNameSanitizationMiddleware(valid_tool_names=sorted({"write_file", *extra_valid_tool_names})),
        SelectiveToolRetryMiddleware(
            max_retries=3,
            backoff_factor=2.0,
            initial_delay=1.0,
            retry_on=is_retryable_tool_error,
        ),
        _model_retry_middleware(),
    ]


def build_deep_research_middleware_set(
    *,
    tool_set: DeepResearchToolSet,
    source_registry_middleware: SourceRegistryMiddleware,
    max_research_concurrency: int,
) -> DeepResearchMiddlewareSet:
    """Build researcher, writer, and orchestrator middleware stacks."""

    def common(extra_valid_tool_names: Sequence[str] = (), **kwargs: Any) -> list[Any]:
        return build_common_middleware(
            tool_set=tool_set,
            source_registry_middleware=source_registry_middleware,
            extra_valid_tool_names=extra_valid_tool_names,
            **kwargs,
        )

    return DeepResearchMiddlewareSet(
        researcher=common(),
        planner=common(),
        writer=common(
            [tool.name for tool in tool_set.writer_skill_tools],
            tool_result_keep_last_n=writer_tool_result_keep_last_n(max_research_concurrency),
            tool_result_max_chars=_WRITER_MAX_TOOL_RESULT_CHARS,
            tool_result_total_char_budget=_WRITER_CHAR_BUDGET,
        ),
        orchestrator=common(["run_research_batch"]),
    )


def runtime_visibility_middleware(runtime: DeepAgentsRuntime) -> list[Any]:
    """Hide execution tools unless a sandbox backend is configured."""
    if runtime.execution_enabled:
        return []
    return [ToolVisibilityMiddleware(hidden_tool_names={"execute"})]


def skill_filesystem_permissions(skill_sources: Sequence[str] | None) -> list[FilesystemPermission]:
    """Build permissions that expose only assigned built-in skill collections as read-only."""
    allowed_source_paths = [source.rstrip("/") for source in skill_sources or ()]
    rules = [
        FilesystemPermission(
            operations=["write"],
            paths=[f"{BUILTIN_SKILL_SOURCE}**"],
            mode="deny",
        )
    ]
    if allowed_source_paths:
        rules.append(
            FilesystemPermission(
                operations=["read"],
                paths=[BUILTIN_SKILL_SOURCE],
                mode="allow",
            )
        )
    rules.extend(
        FilesystemPermission(
            operations=["read"],
            paths=[f"{source_path}{{,/**}}"],
            mode="allow",
        )
        for source_path in allowed_source_paths
    )
    rules.append(
        FilesystemPermission(
            operations=["read"],
            paths=[f"{BUILTIN_SKILL_SOURCE}**"],
            mode="deny",
        )
    )
    return rules


def runtime_skill_filesystem_permissions(runtime: DeepAgentsRuntime, agent_name: str) -> list[FilesystemPermission]:
    """Return filesystem-tool permissions for an agent's configured skill sources."""
    if not runtime.skills_enabled:
        return []
    return skill_filesystem_permissions(runtime.skill_sources_for(agent_name))


def build_researcher_runnable(
    *,
    researcher_model: BaseChatModel,
    researcher_tools: list[BaseTool],
    researcher_middleware: list[Any],
    system_prompt: str,
    skill_sources: list[str] | None = None,
    backend: Any = None,
    visibility_middleware: list[Any] | None = None,
    filesystem_permissions: list[FilesystemPermission] | None = None,
) -> Any:
    """Build the reusable single-query researcher runnable."""
    middleware: list[Any] = []
    if skill_sources:
        middleware.append(SkillsMiddleware(backend=backend, sources=skill_sources))
    middleware.extend(
        [
            FilesystemMiddleware(backend=backend, _permissions=filesystem_permissions),
            create_summarization_middleware(researcher_model, backend),
            PatchToolCallsMiddleware(),
            # Strict structured output is deferred to the researcher's exit
            # turn: binding response_format on every tool-loop call makes
            # constrained decoders skip research entirely (backlog T2-8).
            DeferredStructuredOutputMiddleware(ResearchNotes),
            *researcher_middleware,
            *(visibility_middleware or []),
        ]
    )
    return create_agent(
        model=researcher_model,
        tools=researcher_tools,
        system_prompt=system_prompt,
        middleware=middleware,
    )


def _subagent_spec(
    context: DeepResearchGraphContext,
    *,
    name: str,
    description: str,
    prompt_name: str,
    role: LLMRole,
    tools: Sequence[BaseTool],
    middleware: Sequence[Any],
    prompt_values: dict[str, Any] | None = None,
    response_format: Any = None,
    skills: list[str] | None = None,
) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "name": name,
        "description": description,
        "system_prompt": context.render_prompt(prompt_name, **(prompt_values or {})),
        "tools": list(tools),
        "model": context.llm_provider.get(role),
        "permissions": context.permissions(name),
        "middleware": context.middleware(middleware),
    }
    if response_format is not None:
        spec["response_format"] = response_format
    if skills is not None:
        spec["skills"] = skills
    return spec


def build_deep_research_subagents(context: DeepResearchGraphContext) -> list[dict[str, Any]]:
    """Build all DeepAgents subagent specs."""
    subagents: list[dict[str, Any]] = []
    if context.enable_source_router:
        source_catalog_tool = build_lookup_source_catalog_tool(
            context.tools,
            allowed_source_ids=context.state.data_sources,
            domain_catalog_path=context.domain_catalog_path,
        )
        subagents.append(
            _subagent_spec(
                context,
                name=SOURCE_ROUTER_AGENT,
                description=(
                    "Source router - chooses an advisory domain route and configured source set before detailed "
                    "planning"
                ),
                prompt_name="source_router",
                role=LLMRole.ROUTER,
                tools=[source_catalog_tool],
                middleware=build_source_router_middleware(extra_valid_tool_names=[source_catalog_tool.name]),
                prompt_values={"clarifier_result": context.state.clarifier_result},
            )
        )

    subagents.append(
        _subagent_spec(
            context,
            name=PLANNER_AGENT,
            description=(
                "Content-driven research planning - iteratively builds evidence-grounded answer strategies through "
                "interleaved search and planning"
            ),
            prompt_name="planner",
            role=LLMRole.PLANNER,
            tools=context.tool_set.researcher_tools,
            # Same deferred structured output as the researcher (T2-8): the
            # planner also runs a tool loop, so the strict ResearchPlan schema
            # is applied only on its exit turn.
            middleware=[DeferredStructuredOutputMiddleware(ResearchPlan), *context.middleware_set.planner],
            prompt_values={
                "tools": context.tool_set.tools_info,
                "enable_source_router": context.enable_source_router,
                "max_research_concurrency": context.max_research_concurrency,
            },
        )
    )
    subagents.append(
        _subagent_spec(
            context,
            name=WRITER_AGENT,
            description=(
                "Final synthesis writer - reads the plan and research notes, then returns a cited Markdown answer "
                "in the requested output shape"
            ),
            prompt_name="writer",
            role=LLMRole.REPORT_WRITER,
            tools=context.tool_set.writer_tools,
            middleware=context.middleware_set.writer,
            prompt_values={"skills_block": context.skills_block},
            skills=context.skill_sources(WRITER_AGENT),
        ),
    )
    return subagents


def build_deep_research_graph(
    *,
    llm_provider: LLMProvider,
    state: DeepResearchAgentState,
    prompts: dict[str, str],
    tools: Sequence[BaseTool],
    runtime: DeepAgentsRuntime,
    tool_set: DeepResearchToolSet,
    middleware_set: DeepResearchMiddlewareSet,
    source_registry_middleware: SourceRegistryMiddleware,
    callbacks: list[Any],
    domain_catalog_path: str | None,
    max_research_concurrency: int,
    enable_source_router: bool = True,
    checkpointer: Checkpointer | None = None,
    skills_block: str | None = None,
) -> Any:
    """Build the full DeepAgents graph for one deep research run.

    ``checkpointer`` is execution-state durability (LangGraph's
    per-thread checkpoint log: messages, DeepAgents filesystem, todos),
    distinct from ``store`` below (longterm cross-thread memory, always
    an in-memory store here). None (default) matches current behavior:
    an ephemeral in-process run with no restart safety. When set, the
    caller (``DeepResearcherAgent``) also invokes the compiled graph with
    a stable ``thread_id`` so a re-run of the same job resumes from the
    last persisted checkpoint instead of starting over.
    """
    context = DeepResearchGraphContext(
        llm_provider=llm_provider,
        state=state,
        prompts=prompts,
        tools=tools,
        runtime=runtime,
        tool_set=tool_set,
        middleware_set=middleware_set,
        domain_catalog_path=domain_catalog_path,
        # Date only: a per-second timestamp made every subagent system prompt
        # unique, defeating provider prompt caching across a run's many calls.
        current_datetime=datetime.now().strftime("%Y-%m-%d"),
        max_research_concurrency=max_research_concurrency,
        enable_source_router=enable_source_router,
        backend=runtime.backend,
        visibility_middleware=runtime_visibility_middleware(runtime),
        skills_block=skills_block,
    )
    researcher_model = context.llm_provider.get(LLMRole.RESEARCHER)
    researcher_skill_sources = context.skill_sources(RESEARCHER_AGENT)
    researcher_runnable = build_researcher_runnable(
        researcher_model=researcher_model,
        researcher_tools=context.tool_set.researcher_tools,
        system_prompt=context.render_prompt(
            "researcher",
            tools=context.tool_set.tools_info,
            execution_enabled=context.runtime.execution_enabled,
        ),
        researcher_middleware=context.middleware_set.researcher,
        skill_sources=researcher_skill_sources,
        backend=context.backend,
        visibility_middleware=context.visibility_middleware,
        filesystem_permissions=context.permissions(RESEARCHER_AGENT),
    )
    research_batch_tool = build_research_batch_tool(
        researcher_runnable=researcher_runnable,
        backend=context.backend,
        callbacks=callbacks,
        max_research_concurrency=max_research_concurrency,
        researcher_tool_names={tool.name for tool in context.tool_set.researcher_tools},
        source_registry_middleware=source_registry_middleware,
    )

    # Single source of truth for the orchestrator's toolset: the prompt's
    # "Available Tools" section is rendered from the same list that is bound
    # here, so it can never advertise tools the orchestrator cannot call
    # (backlog T2-9 — the prompt previously listed every configured source
    # tool, and the model tried to call them directly).
    orchestrator_tools = [*context.tool_set.helper_tools, research_batch_tool]
    agent = create_deep_agent(
        model=context.llm_provider.get(LLMRole.ORCHESTRATOR),
        tools=orchestrator_tools,
        system_prompt=context.render_prompt(
            "orchestrator",
            clarifier_result=context.state.clarifier_result,
            tools=[{"name": tool.name, "description": tool.description} for tool in orchestrator_tools],
            research_source_tools=context.tool_set.tools_info,
            enable_source_router=context.enable_source_router,
            max_research_concurrency=context.max_research_concurrency,
            execution_enabled=context.runtime.execution_enabled,
        ),
        subagents=build_deep_research_subagents(context),
        store=InMemoryStore(),
        checkpointer=checkpointer,
        middleware=context.middleware(context.middleware_set.orchestrator),
        permissions=context.permissions(ORCHESTRATOR_AGENT),
        backend=context.backend,
    )
    return agent.with_config({"recursion_limit": _ORCHESTRATOR_RECURSION_LIMIT})
