"""NAT register function for shallow research agent."""

import logging

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from pydantic import Field

from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common import VerboseTraceCallback
from aiq_agent.common import _create_chat_response
from aiq_agent.common import all_mapped_tools_filtered_out
from aiq_agent.common import filter_tools_by_sources
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import get_org_llm_credential_from_context
from aiq_agent.common import get_zdr_only_from_context
from aiq_agent.common import is_verbose
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import verify_deferred_tool_loading
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.api_server import ChatResponse
from nat.data_models.component_ref import FunctionGroupRef
from nat.data_models.component_ref import FunctionRef
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig

from .agent import ShallowResearcherAgent
from .models import ShallowResearchAgentState
from .tool_search import ToolSearchSettings

logger = logging.getLogger(__name__)


class ShallowResearchAgentConfig(FunctionBaseConfig, name="shallow_research_agent"):
    """Configuration for the shallow research agent."""

    llm: LLMRef = Field(..., description="LLM to use")
    tools: list[FunctionRef | FunctionGroupRef] = Field(
        default_factory=list,
        description="Explicit tool list. Empty = inherit all from data_source_registry.",
    )
    exclude_tools: list[str] = Field(
        default_factory=list,
        description="Tool names to exclude when inheriting from registry.",
    )
    max_llm_turns: int = Field(default=10, description="Maximum number of LLM turns")
    max_tool_iterations: int = Field(default=5, description="Maximum tool-calling iterations before forcing synthesis")
    verbose: bool = Field(default=False, description="Whether to enable verbose logging")
    skills_enabled: bool = Field(
        default=True,
        description="Whether agent skills (progressive-disclosure `use_skill` tool) are active on research turns.",
    )
    skill_allowlist: list[str] = Field(
        default_factory=list,
        description="Optional skill-name allowlist; empty = every resolved skill is offered.",
    )
    tool_search: ToolSearchSettings = Field(
        default_factory=ToolSearchSettings,
        description=(
            "Retrieval-based tool narrowing (default OFF). When enabled, a local lexical ranking over "
            "tool name + description picks the tools bound for a research turn, BEFORE the LLM call — "
            "never as a tool the model has to call first, which would spend one of the five tool "
            "iterations on discovery. Absent from the YAML this validates to enabled=false and the "
            "agent binds every tool exactly as it always has."
        ),
    )
    deferred_tool_loading: DeferredToolLoadingSettings = Field(
        default_factory=DeferredToolLoadingSettings,
        description=(
            "OpenRouter server-side tool search (default OFF). When enabled, the tool "
            "schemas are declared deferred and held by the provider instead of being sent "
            "on every request; the model searches, loads and calls one inside a single "
            "response, so no tool iteration is spent on discovery. Requires an OpenRouter "
            "LLM with `api_type: responses` — enabling it against anything else fails the "
            "workflow build rather than silently sending the schemas anyway."
        ),
    )


@register_function(config_type=ShallowResearchAgentConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def shallow_research_agent(config: ShallowResearchAgentConfig, builder: Builder):
    """Shallow research agent with tool-calling capabilities."""
    llm = await get_langchain_llm(builder, config.llm)

    if config.tools:
        tool_refs = config.tools
    else:
        from aiq_agent.common import get_all_tool_refs

        tool_refs = get_all_tool_refs()

    tools = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)

    if config.exclude_tools:
        excluded = set(config.exclude_tools)
        tools = [t for t in tools if getattr(t, "name", "") not in excluded]

    from aiq_agent.common import validate_tool_availability

    is_valid, available_count, unavailable = validate_tool_availability(
        tools,
        research_type="shallow research",
    )
    if not is_valid:
        logger.warning(
            "Startup check: no tools available for shallow research. "
            "All queries will fail until at least one tool is properly configured.",
        )

    # Deferred tool loading is verified HERE, at build time, against the live
    # endpoint — before a user turn exists to lose. The failure it guards is a
    # request that looks configured and defers nothing (OpenRouter silently
    # drops `defer_loading` from a top-level function tool), which is invisible
    # from the inside: the agent still answers, and the only symptom is the
    # token bill. A deployment that asked for deferral and cannot have it
    # therefore fails to start instead.
    await verify_deferred_tool_loading(llm, settings=config.deferred_tool_loading)

    provider = LLMProvider()
    provider.set_default(llm, group=AgentGroup.SHALLOW_RESEARCH)

    verbose = is_verbose(config.verbose)
    callbacks = [VerboseTraceCallback()] if verbose else []

    agent = ShallowResearcherAgent(
        llm_provider=provider,
        tools=tools,
        max_llm_turns=config.max_llm_turns,
        max_tool_iterations=config.max_tool_iterations,
        callbacks=callbacks,
        tool_search=config.tool_search,
        deferred_tool_loading=config.deferred_tool_loading,
    )

    async def _run(state: ShallowResearchAgentState) -> ShallowResearchAgentState:
        try:
            data_sources = state.data_sources
            selected_tools = filter_tools_by_sources(tools, data_sources)
            # Agent skills: resolved per RUN (ADR-0018 — never cached on the
            # shared agent instance), builtin + org set from the resolver, then
            # narrowed by the config allowlist. The runtime's `use_skill` tool
            # is folded into the tool set on research turns
            # (requires_sources=True): meta/conversational turns keep their
            # interaction-only binding — a greeting cannot load a skill.
            #
            # A turn the user EXPLICITLY invoked a skill on (`/name` in the
            # composer, arriving as `force_skills`) is wired regardless of that
            # classification. The classifier decides whether an unprompted turn
            # needs sources; it does not get to overrule a direct instruction,
            # and dropping the tool there made `/name` a silent no-op on exactly
            # the short, imperative messages people type after a slash command.
            skill_runtime = None
            run_tools = selected_tools
            if config.skills_enabled and (state.requires_sources or state.force_skills):
                from aiq_agent.project_context import get_organization_id_from_context
                from aiq_agent.skills import SkillResolver
                from aiq_agent.skills import SkillRuntime

                resolver = SkillResolver(agent="shallow_researcher")
                resolved_skills = resolver.resolve(get_organization_id_from_context())
                if config.skill_allowlist:
                    allow = set(config.skill_allowlist)
                    resolved_skills = tuple(s for s in resolved_skills if s.name in allow)
                skill_runtime = SkillRuntime(skills=resolved_skills, force_names=state.force_skills)
                # Announce the catalog BEFORE the LLM runs. Constructing the
                # runtime already announced each FORCED skill by its human
                # title (SkillRuntime._record_activation), so a `/name`
                # invocation is named to the user before the first token
                # rather than in `skills_activated[]` after the answer.
                from aiq_agent.skills.events import emit_skills_offered

                emit_skills_offered(skill_runtime)
                run_tools = list(selected_tools) + list(skill_runtime.build_tools())
            # Per-org runtime model overrides (X-Grid-Model-Overrides). Returns
            # the build-time provider unchanged when no override targets this
            # agent, so the identity check below keeps the prebuilt agent.
            # Model overrides + the org's BYOK credential (ADR-0022); both
            # return the build-time provider unchanged when inactive, so the
            # identity check below keeps the prebuilt agent.
            active_provider = (
                provider.with_model_overrides(get_model_overrides_from_context())
                .with_credential(get_org_llm_credential_from_context())
                .with_zdr(get_zdr_only_from_context())
            )
            active_agent = agent
            # No `data_sources is not None` guard: org-disabled sources (ADR-0022)
            # narrow selected_tools even when the request selects "all tools".
            if active_provider is not provider or run_tools != tools:
                active_agent = ShallowResearcherAgent(
                    llm_provider=active_provider,
                    tools=run_tools,
                    max_llm_turns=config.max_llm_turns,
                    max_tool_iterations=config.max_tool_iterations,
                    callbacks=callbacks,
                    # The per-run agent is narrowed by data_sources/skills, so
                    # it indexes a DIFFERENT tool set — it has to carry the
                    # setting or tool search would silently stop applying on
                    # exactly the requests that select sources.
                    tool_search=config.tool_search,
                    # Same reason as tool_search: the per-run agent binds a
                    # DIFFERENT tool set, so without carrying this the deferral
                    # would silently stop applying on exactly the requests that
                    # select sources or activate a skill.
                    deferred_tool_loading=config.deferred_tool_loading,
                )

            if all_mapped_tools_filtered_out(tools, selected_tools, data_sources):
                logger.warning("Shallow research received data_sources with no matching tools")

            # Validate tool availability before starting shallow research
            # At least one tool must be available
            # This prevents the agent from trying to reason about unavailable tools
            # Check selected_tools directly - they already reflect data_sources filtering
            from aiq_agent.common import format_user_facing_tool_error
            from aiq_agent.common import validate_tool_availability

            is_valid, _, unavailable_tools = validate_tool_availability(
                selected_tools, research_type="shallow research"
            )

            # Fail if no tools are available
            if not is_valid:
                error_msg = format_user_facing_tool_error("shallow research", unavailable_tools)

                # Return error state with error message - this prevents the agent from running
                error_state = ShallowResearchAgentState(messages=state.messages + [AIMessage(content=error_msg)])
                return error_state

            if skill_runtime is not None:
                state.skills_block = "\n\n".join(
                    block for block in (skill_runtime.prompt_block(), skill_runtime.forced_block()) if block
                )
            result = await active_agent.run(state)
            if skill_runtime is not None:
                result.skills_activated = list(skill_runtime.activated)
            return result
        except EmptySourceRegistryError:
            # A scoped miss (this-file / this-shelf) is a valid empty
            # answer, not an unhandled NAT error. Raising here became
            # err2issue #447 and left the user with no reply.
            logger.warning("Shallow research captured no sources; returning an empty-result answer.")
            empty_msg = (
                "I searched the available sources but couldn't retrieve anything usable. "
                "Try a broader question, or ask without limiting to one file."
            )
            return ShallowResearchAgentState(messages=state.messages + [AIMessage(content=empty_msg)])
        except Exception:
            logger.exception("Error in shallow research execution.")
            raise

    yield FunctionInfo.from_fn(_run, description="Shallow research agent for fast, bounded research.")


########################################################
# Shallow Research Workflow (Wrapper for Evaluation)
########################################################
class ShallowResearchWorkflowConfig(FunctionBaseConfig, name="shallow_research_workflow"):
    """Configuration for the shallow research workflow wrapper.

    This wrapper accepts a string query and converts it to messages
    for the shallow_research_agent. Use this as the workflow for evaluation.
    """

    pass


@register_function(config_type=ShallowResearchWorkflowConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def shallow_research_workflow(config: ShallowResearchWorkflowConfig, builder: Builder):
    """Wrapper workflow that accepts string queries for evaluation."""
    shallow_research_agent_fn = await builder.get_function("shallow_research_agent")
    workflow_id = config.name or config.type

    async def _run(query: str, project_context: str | None = None) -> ChatResponse:
        """Run shallow research on a query string."""
        result = await shallow_research_agent_fn.ainvoke(
            ShallowResearchAgentState(messages=[HumanMessage(content=query)], project_context=project_context)
        )
        response_content = result.messages[-1].content
        return _create_chat_response(response_content, response_id="research_response", model=workflow_id)

    yield FunctionInfo.from_fn(_run, description="Shallow research workflow for evaluation (accepts string query).")
