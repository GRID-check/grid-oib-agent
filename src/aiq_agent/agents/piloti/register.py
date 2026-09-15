"""NAT register function for research agent.

One :class:`PilotiAgent` is built at boot. Per request ``_run_turn``
computes only what the turn varies (the switched-off data sources, the org's
skills as a ``use_skill`` tool, the model override) as a :class:`TurnConfig`
and hands it to ``agent.run``; nothing is compiled, read or re-indexed per turn.
The tool SET no longer varies with the data-source toggles — a switched-off
source keeps its tool and refuses the call (``common/data_sources.py``), so
every turn of an org sends the same tool payload to the same cache shard.
"""

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from pydantic import Field

from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common import VerboseTraceCallback
from aiq_agent.common import _create_chat_response
from aiq_agent.common import format_user_facing_tool_error
from aiq_agent.common import get_all_tool_refs
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import get_org_llm_credential_from_context
from aiq_agent.common import get_zdr_only_from_context
from aiq_agent.common import is_verbose
from aiq_agent.common import unavailable_source_ids
from aiq_agent.common import validate_tool_availability
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.data_source_registry import get_all_sources
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import verify_deferred_tool_loading
from aiq_agent.project_context import get_organization_id_from_context
from aiq_agent.skills import SkillResolver
from aiq_agent.skills import SkillRuntime
from aiq_agent.skills.events import emit_skills_offered
from aiq_agent.tools.documents.tools import draft_tools_for_turn
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.api_server import ChatResponse
from nat.data_models.component_ref import FunctionGroupRef
from nat.data_models.component_ref import FunctionRef
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig

# Importing this module runs its ``@register_function`` so NAT discovers the
# ``ask_user`` tool through the same ``aiq_researcher`` entry point
# that imports this file, the pattern ``cards/register.py`` uses for
# ``surface_documents``, and no extra plugin entry point to keep in sync.
from . import ask_user as _ask_user  # noqa: F401
from .agent import PilotiAgent
from .agent import TurnConfig
from .models import ResearchAgentState
from .tool_search import ToolSearchSettings

logger = logging.getLogger(__name__)

_RESEARCH_TYPE = "research"

#: Distinct tool selections a deployment sees is small (one per data-source
#: combination); the availability memo is dropped whole past this.
_MAX_MEMOISED_SELECTIONS = 64


class ResearchAgentConfig(FunctionBaseConfig, name="research_agent"):
    """Configuration for the research agent."""

    llm: LLMRef = Field(..., description="LLM to use")
    tools: list[FunctionRef | FunctionGroupRef] = Field(
        default_factory=list,
        description="Explicit tool list. Empty = inherit all from data_source_registry.",
    )
    exclude_tools: list[str] = Field(
        default_factory=list,
        description="Tool names to exclude when inheriting from registry.",
    )
    max_tool_iterations: int = Field(
        default=5,
        description=(
            "The research budget in tool-calling ROUNDS — LLM decisions that emitted tool calls — "
            "before synthesis is forced. A round costs one whatever it asked for, so a batch of five "
            "parallel passage opens is one and so is a single `use_skill`. The graph's recursion "
            "guard is derived from it; nothing else bounds the loop."
        ),
    )
    max_input_tokens_per_turn: int = Field(
        default=600_000,
        description=(
            "Cumulative INPUT tokens one turn may spend before synthesis is forced, read off the "
            "cost tracker that already meters every call. The bound that protects the person paying, "
            "since rounds no longer do: a round is one decision however many calls it fans out into. "
            "Sized well above the worst turn measured (~289k prompt tokens over eight calls), because "
            "a bound that fires on a hard question is a hobble — this one is here to stop a runaway. "
            "0 disables it."
        ),
    )
    repair_pass: bool = Field(
        default=True,
        description=(
            "After citation and quote verification, try ONE repair when something failed: "
            "one more retrieval aimed at the failing quote or citation, one rewrite, then "
            "re-verify and keep the better answer. Off ships the markers as before."
        ),
    )
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
    envelope_json_mode_with_tools: bool = Field(
        default=False,
        description=(
            "Whether provider JSON mode (`response_format: json_object`) for the answer envelope is "
            "ALSO bound on tool-bound research iterations, not only on the tool-free forced-synthesis "
            "call (default OFF). Some OpenRouter-routed providers accept the parameter and then stop "
            "emitting tool calls — a silent degradation the per-call fallback cannot see — so turning "
            "this on is a per-deployment decision made against a provider known to honor both."
        ),
    )


@dataclass(frozen=True)
class _Deployment:
    """What the boot built, shared by every turn."""

    config: ResearchAgentConfig
    agent: PilotiAgent
    provider: LLMProvider
    tools: list[Any]
    #: tool names → (is_valid, unavailable): the availability check is a scan
    #: with an INFO line per tool, and the tool set is fixed per deployment.
    availability: dict[tuple[str, ...], tuple[bool, list[str]]] = field(default_factory=dict)


async def _load_tools(config: ResearchAgentConfig, builder: Builder) -> list[Any]:
    tool_refs = config.tools or get_all_tool_refs()
    tools = await builder.get_tools(tool_names=tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
    if config.exclude_tools:
        excluded = set(config.exclude_tools)
        tools = [t for t in tools if getattr(t, "name", "") not in excluded]
    is_valid, _, _ = validate_tool_availability(tools, research_type=_RESEARCH_TYPE)
    if not is_valid:
        logger.warning(
            "Startup check: no tools available for research. "
            "All queries will fail until at least one tool is properly configured.",
        )
    return tools


def _tool_availability(deployment: _Deployment, tools: Sequence[Any]) -> tuple[bool, list[str]]:
    key = tuple(getattr(tool, "name", "") for tool in tools)
    known = deployment.availability.get(key)
    if known is not None:
        return known
    is_valid, _, unavailable = validate_tool_availability(list(tools), research_type=_RESEARCH_TYPE)
    if len(deployment.availability) >= _MAX_MEMOISED_SELECTIONS:
        deployment.availability.clear()
    deployment.availability[key] = (is_valid, unavailable)
    return is_valid, unavailable


async def _resolve_skill_runtime(
    config: ResearchAgentConfig,
    state: ResearchAgentState,
) -> SkillRuntime | None:
    """The org's skills for THIS run (ADR-0018: never cached on the agent), or None.

    Builtin + org set from the resolver, narrowed by the config allowlist. The
    catalog is announced BEFORE the LLM runs — how many skills were offered, on
    the technical channel. The per-skill announcement fires at delivery instead,
    because a catalog line is an offer until the model calls ``use_skill``. No
    skills resolved: nothing to offer, no tool to bind, and silence is the
    correct announcement.
    """
    if not config.skills_enabled:
        return None
    # A cold resolve is a blocking BFF round-trip (5s timeout); on a thread so
    # the miss stalls this turn and not every other conversation on the
    # replica. The org id is read here, on the loop, because it is a ContextVar.
    # ``researcher`` and not ``piloti``: this is the skill scope stored in
    # ``platform_skills.grid_agents`` and written by hand into every skill's
    # frontmatter. Both resolvers ignore a name they do not know, so renaming
    # it here without a migration and read-side aliases would silently serve
    # the chat-scoped skills to deep research too. See ``skills/resolver.py``.
    resolver = SkillResolver(agent="researcher")
    resolved = await asyncio.to_thread(resolver.resolve, get_organization_id_from_context())
    if config.skill_allowlist:
        allow = set(config.skill_allowlist)
        resolved = tuple(skill for skill in resolved if skill.name in allow)
    if not resolved:
        return None
    runtime = SkillRuntime(skills=resolved)
    emit_skills_offered(runtime)
    return runtime


async def _read_model_overrides() -> dict:
    try:
        return await asyncio.to_thread(get_model_overrides_from_context)
    except Exception:  # noqa: BLE001 - a lost override costs the model choice, never the turn
        logger.debug("Model-overrides lookup failed; continuing without", exc_info=True)
        return {}


async def _read_org_credential():
    try:
        return await asyncio.to_thread(get_org_llm_credential_from_context)
    except Exception:  # noqa: BLE001 - see above; the env chain still has a credential
        logger.debug("Org-credential lookup failed; continuing without", exc_info=True)
        return None


async def _read_zdr_only() -> bool:
    try:
        return await asyncio.to_thread(get_zdr_only_from_context)
    except Exception:  # noqa: BLE001 - fails CLOSED, unlike its two siblings
        # A missing override costs the org its model choice; a missing ZDR bit
        # sends the org's prompts to endpoints that may retain them, which is
        # the ADR-0014 control itself. This is NOT the "BFF is down" path --
        # `resolve_org_zdr_only` already answers False for that, deliberately.
        # Reaching here means the lookup itself broke unexpectedly, so it logs
        # at error rather than debug: a privacy control that switches itself
        # off must never do it quietly.
        logger.error("ZDR lookup failed; pinning ZDR routing for this turn", exc_info=True)
        return True


async def _active_provider(provider: LLMProvider) -> LLMProvider:
    """Per-org model overrides + BYOK credential + ZDR (ADR-0022).

    Each returns the boot provider unchanged when inactive, so the agent's
    identity check keeps the boot binding on a turn that overrides nothing.

    The three lookups are header-first but each falls back to a blocking BFF
    call (5s timeout, 60s in-process TTL), so a cold miss used to freeze the
    event loop for every turn on the replica. Each runs on its own thread hop
    and fails open (the ZDR bit closed) on its own, so the three overlap and
    one bad reader costs its own value -- never the turn, and never the other
    two. ContextVars travel with each hop.
    """
    model_overrides, org_credential, zdr_only = await asyncio.gather(
        _read_model_overrides(),
        _read_org_credential(),
        _read_zdr_only(),
    )
    return provider.with_model_overrides(model_overrides).with_credential(org_credential).with_zdr(zdr_only)


def _skills_block(runtime: SkillRuntime) -> str:
    return runtime.prompt_block() or ""


def _report_skills(result: ResearchAgentState, runtime: SkillRuntime) -> None:
    """Lift what was DELIVERED onto the result.

    ``skills_activated`` is rendered to the reader as what shaped this answer,
    so only a skill whose body the model opened belongs in it. A catalog the
    model read past is not a miss to report: the offer was the whole mechanism.
    """
    result.skills_activated = list(runtime.activated)
    hidden = list(runtime.hidden_activated)
    if hidden:
        result.skills_hidden = hidden


def _reply(state: ResearchAgentState, text: str) -> ResearchAgentState:
    return ResearchAgentState(messages=state.messages + [AIMessage(content=text)])


def _warn_if_nothing_is_reachable(disabled_sources: frozenset[str]) -> None:
    """The one diagnostic the narrowing used to give: a turn with no source left.

    It is a request the caller probably did not mean (``data_sources`` naming
    nothing the registry knows, or every source toggled off), and it no longer
    shows up as an empty tool list — the tools are all still bound, they will
    all just refuse.
    """
    if not disabled_sources:
        return
    reachable = [meta.id for meta in get_all_sources() if meta.id.lower() not in disabled_sources]
    if not reachable:
        logger.warning("Research turn has every data source switched off; every retrieval call will be refused")


async def _run_turn(deployment: _Deployment, state: ResearchAgentState) -> ResearchAgentState:
    """One request: narrow the tools, resolve the skills, run the shared agent."""
    config = deployment.config
    # The tool set does NOT vary with the toggles any more (row 6). A source the
    # org switched off (ADR-0022) or the request did not select stays BOUND and
    # is refused per call in the tools node, so every turn of an org sends the
    # same tool payload and lands on one prompt-cache shard instead of one per
    # toggle combination. No `data_sources is not None` guard, for the same
    # reason as before: an org's toggle applies to a request that asked for
    # "all tools".
    disabled_sources = unavailable_source_ids(state.data_sources)
    _warn_if_nothing_is_reachable(disabled_sources)
    is_valid, unavailable_tools = _tool_availability(deployment, deployment.tools)
    if not is_valid:
        return _reply(state, format_user_facing_tool_error(_RESEARCH_TYPE, unavailable_tools))

    # The runtime's `use_skill` tool is folded into the tool set on every
    # turn: the model has the catalog and decides whether a skill applies,
    # the same way it decides whether to search (ADR-0052). A skill's BODY
    # still only travels on a `use_skill` call.
    runtime = await _resolve_skill_runtime(config, state)
    # The conversation's working directory, folded in the same way: four file
    # verbs over a store namespaced by conversation, or nothing at all when the
    # turn has no conversation to namespace by (CLI, eval, worker).
    draft_tools = await draft_tools_for_turn()
    turn_tools = list(deployment.tools) + (list(runtime.build_tools()) if runtime is not None else []) + draft_tools
    turn = TurnConfig(
        llm_provider=await _active_provider(deployment.provider),
        tools=turn_tools,
        disabled_sources=disabled_sources,
    )
    if runtime is not None:
        state.skills_block = _skills_block(runtime)
    try:
        result = await deployment.agent.run(state, turn=turn)
    except EmptySourceRegistryError:
        # A scoped miss (this-file / this-shelf) is a valid empty answer, not
        # an unhandled NAT error. Raising here became err2issue #447 and left
        # the user with no reply.
        logger.warning("Research captured no sources; returning an empty-result answer.")
        return _reply(
            state,
            "I searched the available sources but couldn't retrieve anything usable. "
            "Try a broader question, or ask without limiting to one file.",
        )
    if runtime is not None:
        _report_skills(result, runtime)
    return result


@register_function(config_type=ResearchAgentConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def research_agent(config: ResearchAgentConfig, builder: Builder):
    """Research agent with tool-calling capabilities."""
    llm = await get_langchain_llm(builder, config.llm)
    tools = await _load_tools(config, builder)

    # Deferred tool loading is verified HERE, at build time, against the live
    # endpoint, before a user turn exists to lose. The failure it guards is a
    # request that looks configured and defers nothing, which is invisible
    # from the inside: the only symptom is the token bill.
    await verify_deferred_tool_loading(llm, settings=config.deferred_tool_loading)

    provider = LLMProvider()
    provider.set_default(llm, group=AgentGroup.RESEARCH)
    callbacks = [VerboseTraceCallback()] if is_verbose(config.verbose) else []
    agent = PilotiAgent(
        llm_provider=provider,
        tools=tools,
        max_tool_iterations=config.max_tool_iterations,
        max_input_tokens_per_turn=config.max_input_tokens_per_turn,
        callbacks=callbacks,
        tool_search=config.tool_search,
        deferred_tool_loading=config.deferred_tool_loading,
        envelope_json_mode_with_tools=config.envelope_json_mode_with_tools,
        repair_pass=config.repair_pass,
    )
    deployment = _Deployment(config=config, agent=agent, provider=provider, tools=tools)

    async def _run(state: ResearchAgentState) -> ResearchAgentState:
        return await _run_turn(deployment, state)

    yield FunctionInfo.from_fn(_run, description="Research agent for fast, bounded research.")


########################################################
# Research Workflow (Wrapper for Evaluation)
########################################################
class ResearchWorkflowConfig(FunctionBaseConfig, name="research_workflow"):
    """Configuration for the research workflow wrapper.

    This wrapper accepts a string query and converts it to messages
    for the shallow_research_agent. Use this as the workflow for evaluation.
    """


@register_function(config_type=ResearchWorkflowConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def research_workflow(config: ResearchWorkflowConfig, builder: Builder):
    """Wrapper workflow that accepts string queries for evaluation."""
    research_agent_fn = await builder.get_function("shallow_research_agent")
    workflow_id = config.name or config.type

    async def _run(query: str, project_context: str | None = None) -> ChatResponse:
        """Run research on a query string."""
        result = await research_agent_fn.ainvoke(
            ResearchAgentState(messages=[HumanMessage(content=query)], project_context=project_context)
        )
        response_content = result.messages[-1].content
        return _create_chat_response(response_content, response_id="research_response", model=workflow_id)

    yield FunctionInfo.from_fn(_run, description="Research workflow for evaluation (accepts string query).")
