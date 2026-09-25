"""NAT register function for research agent.

One :class:`PilotiAgent` is built at boot. Per request ``_run_turn``
computes only what the turn varies (the switched-off data sources, the org's
skills as a ``use_skill`` tool, the model override) as a :class:`TurnConfig`
and hands it to ``agent.run``; nothing is compiled, read or re-indexed per turn.
The tool SET no longer varies with the data-source toggles — a switched-off
source keeps its tool and refuses the call (``common/data_sources.py``), so
every turn of an org sends the same tool payload to the same cache shard —
except that a turn without a project is not sent the building-model tools
(``_tools_in_scope``), which cannot run there.
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
from aiq_agent.common import get_reasoning_efforts
from aiq_agent.common import get_zdr_only_from_context
from aiq_agent.common import is_verbose
from aiq_agent.common import unavailable_source_ids
from aiq_agent.common import validate_tool_availability
from aiq_agent.common.agent_tools import load_agent_tools
from aiq_agent.common.canned_replies import SCOPED_NO_SOURCES_MESSAGE
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.data_source_registry import get_all_sources
from aiq_agent.common.decisions import SKIPPED_TOO_SHORT
from aiq_agent.common.decisions import record_skipped
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import verify_deferred_tool_loading
from aiq_agent.project_context import get_organization_id_from_context
from aiq_agent.project_context import get_project_id_from_context
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
from .decisions import SLOT as DECISION_SLOT
from .decisions import TurnDecisions
from .decisions import TurnFacts
from .decisions import attached_card_types
from .decisions import decide_turn
from .decisions import prefetch_calls
from .decisions import prefetch_query
from .models import ResearchAgentState
from .tool_search import ToolSearchSettings
from .tool_search import tool_basename

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
    max_calls_per_round: int = Field(
        default=12,
        description=(
            "How many tool calls of ONE round are actually run. A runaway guard, not a doctrine: "
            "a round costs one whatever it fans out into, and a model that opens all five members "
            "of a Richtlinien-Familie at once is using its round well — so this sits far above any "
            "batch the prompt asks for. What it bounds is the shape nothing else sees, a round of "
            "sixty parallel calls into the stores, which `max_input_tokens_per_turn` only notices "
            "at the START of the next round. The calls past it are answered with a notice saying "
            "they may be issued again next round, never removed from the message. 0 disables it."
        ),
    )
    repair_pass: bool = Field(
        default=True,
        description=(
            "Correct a quotation no retrieved passage holds verbatim, when one passage comes close: "
            "the small `card_repair_llm` returns that passage's own wording and only the text "
            "between the quotation marks is replaced, then re-verified (ADR-0067). Off, or without "
            "`card_repair_llm`, ships the marker."
        ),
    )
    card_repair_llm: LLMRef | None = Field(
        default=None,
        description=(
            "The small model that fixes ONE card the answer envelope carried and the validator "
            "refused (`cards/repair.py`): the failed object, the refusal and the type's shape in a "
            "message of a few thousand tokens, instead of the full-context round the `emit_card` "
            "retry cost. Unset drops a card that fails validation, and records that it did; it also "
            "turns off the quote repair (`repair_pass`), which runs on this model."
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
    skills_inline_max_body_chars: int = Field(
        default=0,
        description=(
            "OPT-IN budget: a skill whose body is at most this many characters rides the system prompt "
            "in full on every turn (ADR-0063, amended). 0, the default: no body rides by budget; the "
            "turn-start decision (ADR-0064) reads the ONE skill the question is the subject of into the "
            "turn, and the rest stay a catalog line behind `use_skill`."
        ),
    )
    turn_decisions: bool = Field(
        default=True,
        description=(
            "Ask the decision model (Jev, ADR-0064) at turn start whether the message needs evidence, "
            "which corpus and which OIB families it needs, which skill it is the subject of and which "
            "card types it is likely to earn — and act on the answers only by ADDING: the named fetches "
            "run as round 0 before the first LLM call, the chosen skill's body and card shapes ride this "
            "turn's prompt. Every tool stays bound whatever it says; "
            "a decision that cannot run leaves the turn exactly as before. GRID_DECISIONS_ENABLED=false "
            "is the global switch."
        ),
    )
    skills_inline_budget_chars: int = Field(
        default=0,
        description=(
            "OPT-IN budget: ceiling on the characters of skill bodies that ride the prompt per turn by "
            "size alone, filled in catalog order. 0, the default: see skills_inline_max_body_chars."
        ),
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
    tools = await load_agent_tools(builder, tool_refs, config.exclude_tools)
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
    runtime = SkillRuntime(
        skills=resolved,
        inline_max_body_chars=config.skills_inline_max_body_chars,
        inline_budget_chars=config.skills_inline_budget_chars,
    )
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


async def _read_reasoning_efforts() -> dict[str, str]:
    try:
        return await asyncio.to_thread(get_reasoning_efforts)
    except Exception:  # noqa: BLE001 - a lost effort costs the thinking level, never the turn
        logger.debug("Reasoning-efforts lookup failed; continuing with the configured levels", exc_info=True)
        return {}


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
    """Per-org model overrides + platform thinking level + BYOK credential + ZDR (ADR-0022).

    Each returns the boot provider unchanged when inactive, so the agent's
    identity check keeps the boot binding on a turn that overrides nothing.

    The lookups are header-first (the platform efforts are cache-first) but
    each falls back to a blocking BFF call (5s timeout, 60s in-process TTL),
    so a cold miss used to freeze the event loop for every turn on the
    replica. Each runs on its own thread hop and fails open (the ZDR bit
    closed) on its own, so they overlap and one bad reader costs its own
    value -- never the turn, and never the others. ContextVars travel with
    each hop.
    """
    model_overrides, efforts, org_credential, zdr_only = await asyncio.gather(
        _read_model_overrides(),
        _read_reasoning_efforts(),
        _read_org_credential(),
        _read_zdr_only(),
    )
    return (
        provider.with_model_overrides(model_overrides)
        .with_reasoning_efforts(efforts)
        .with_credential(org_credential)
        .with_zdr(zdr_only)
    )


def _skills_block(runtime: SkillRuntime) -> str:
    return runtime.prompt_block() or ""


def _turn_facts(state: ResearchAgentState, runtime: SkillRuntime | None) -> TurnFacts:
    """What the decider is shown, from the state the gather already filled."""
    from aiq_agent.cards.catalog import CHAT_ONLY_CARD_TYPES
    from aiq_agent.cards.catalog import MARKDOWN_CARD_TYPES
    from aiq_agent.cards.catalog import card_index_entries
    from aiq_agent.cards.envelope import ENVELOPE_SHAPE_TYPES
    from aiq_agent.common.applicability import facts_from_project_context
    from aiq_agent.common.source_kinds import Shelf
    from aiq_agent.knowledge.inventory import get_norm_families

    humans = [str(m.content) for m in state.messages if isinstance(m, HumanMessage) and isinstance(m.content, str)]
    question = humans[-1] if humans else ""
    previous = humans[-2] if len(humans) > 1 else None
    answers = [
        str(m.content)
        for m in state.messages
        if isinstance(m, AIMessage) and isinstance(m.content, str) and not getattr(m, "tool_calls", None)
    ]
    previous_answer = answers[-1] if answers else None
    documents = state.available_documents or []
    offered = tuple(runtime.skills) if runtime is not None else ()
    return TurnFacts(
        question=question,
        previous_message=previous,
        previous_answer=previous_answer,
        skills=[(skill.name, " ".join(skill.description.split())) for skill in offered],
        focus_file_name=state.focus_file_name,
        project_facts={k: str(v) for k, v in facts_from_project_context(state.project_context or "").items()},
        families=get_norm_families(),
        project_files=sum(1 for doc in documents if getattr(doc, "shelf", None) == Shelf.PROJECT),
        archive_files=sum(1 for doc in documents if getattr(doc, "shelf", None) == Shelf.ARCHIV),
        # `surface`'s shape IS the compose rule the envelope contract already
        # carries: attached, it would ride twice and take a shape slot.
        card_types=[
            entry
            for entry in card_index_entries(exclude=MARKDOWN_CARD_TYPES | CHAT_ONLY_CARD_TYPES)
            if entry[0] not in ENVELOPE_SHAPE_TYPES
        ],
    )


async def _decide_turn(facts: TurnFacts | None) -> TurnDecisions:
    """The turn-start decision, or none: never raises, never blocks longer than its timeout.

    ``facts`` is ``None`` when the config switched the decision off.
    """
    if facts is None:
        return TurnDecisions.none()
    # A first message of one or two words („Hallo", „Danke!") needs no
    # decision: no method to read in, and the ~0.6 s the call costs would be
    # a third of the reply's whole latency. What it may prefetch needs none
    # either: a bare family name („OIB 2") is searched by the undecided path
    # (``prefetch_calls``), and anything else of two words searches nothing.
    if facts.previous_message is None and len(facts.question.split()) < 3:
        record_skipped(DECISION_SLOT, SKIPPED_TOO_SHORT)
        return TurnDecisions.none()
    try:
        return await decide_turn(facts, organization_id=get_organization_id_from_context())
    except Exception:  # noqa: BLE001 — a decision is worth less than the turn
        logger.warning("Turn decision failed; running the turn as before", exc_info=True)
        return TurnDecisions.none()


#: The warm-ups still running (see _warm_question).
_WARMING: set[asyncio.Task[None]] = set()


def _warm_question(facts: TurnFacts | None) -> None:
    """Start embedding the question the round-0 prefetch will search; not awaited.

    The prefetch is known only after the decision, and its search then pays
    the query embedding (280-980 ms, measured 2026-09-24) before it can rank.
    The string it will search is known now, so the embedding runs beside the
    decision and the search finds it cached, or in flight. Nothing waits on it.

    Warmed only where ``prefetch_calls`` can search the raw question, as far
    as that is known before the decision: a FIRST message of three words or
    more, which the decision may prefetch, or one that names an OIB family,
    which is prefetched even undecided — „OIB 2" skips the decision and is
    still searched. A later message is searched only when the decision rules it
    self-contained, and without a decision never (``prefetch_calls``), so
    warming it would mostly be an embedding call nobody reads. A decided
    first message whose corpus is not searched still wastes one call.
    """
    if facts is None or facts.previous_message is not None:
        return
    from aiq_agent.common.norm_registry import family_query_number

    query = prefetch_query(facts.question)
    if len(query.split()) < 3 and family_query_number(query) is None:
        return
    from aiq_agent.knowledge.factory import warm_search_query

    # Held until done: the loop keeps only a weak reference to a task.
    task = asyncio.create_task(warm_search_query(query))
    _WARMING.add(task)
    task.add_done_callback(_WARMING.discard)


#: Tools that read the PROJECT's building model. Outside a project they can
#: only answer "no project" (``tools/bim/failures.NO_PROJECT_TEXT``), and
#: their two schemas are ~8 200 of the ~17 000 tool tokens every call of the
#: turn re-sends (measured 2026-09-23 on the live request; deferral did not
#: reduce what was billed).
_PROJECT_MODEL_TOOLS = frozenset({"ifc_query", "ifc_measure"})


def _tools_in_scope(tools: list[Any]) -> list[Any]:
    """The turn's tools less those that cannot run in its scope.

    The tool payload still does not vary with the data-source toggles (the
    cache shard stays one per org); it varies with one fact the turn cannot
    change — whether there is a project — so an org has two shards, not one
    per combination.
    """
    if get_project_id_from_context():
        return tools
    # The BASE name: a grouped or MCP tool arrives as ``bim__ifc_query``.
    return [tool for tool in tools if tool_basename(getattr(tool, "name", "") or "") not in _PROJECT_MODEL_TOOLS]


def _apply_decisions(decisions: TurnDecisions, state: ResearchAgentState, runtime: SkillRuntime | None) -> None:
    """The two prompt-side effects: the chosen skill's body, and the likely card shapes.

    The chosen skill rides this turn's prompt in full (``inline_also``), the
    one method the question is the subject of; the shapes are its preferred
    cards beyond the three shapes the envelope teaches, the Markdown-written
    types and ``surface`` — what ``use_skill`` hands over with the body — then
    the turn decision's card picks, capped (``attached_card_types``). The
    Markdown types are left out because the answer writes them as Markdown,
    not as a card, and ``surface`` because its shape is the envelope's
    compose rule, already in the prompt. Still offers: the model decides.
    """
    from aiq_agent.cards.catalog import CHAT_ONLY_CARD_TYPES
    from aiq_agent.cards.catalog import MARKDOWN_CARD_TYPES
    from aiq_agent.cards.envelope import ENVELOPE_SHAPE_TYPES
    from aiq_agent.skills.models import preferred_cards

    withheld_shapes = {*ENVELOPE_SHAPE_TYPES, *MARKDOWN_CARD_TYPES, *CHAT_ONLY_CARD_TYPES}

    if runtime is not None and decisions.chosen_skill:
        runtime.inline_also((decisions.chosen_skill,))
    skill_cards = {
        skill.name: [card for card in preferred_cards(skill.metadata) if card not in withheld_shapes]
        for skill in (runtime.skills if runtime is not None else ())
    }
    chosen = attached_card_types(decisions, skill_cards)
    if chosen:
        from aiq_agent.cards.catalog import render_card_details

        state.card_shapes_block = render_card_details(chosen) or None


def _report_skills(result: ResearchAgentState, runtime: SkillRuntime) -> None:
    """Lift what was DELIVERED AND FOLLOWED onto the result.

    ``skills_activated`` is rendered to the reader as what shaped this answer,
    so only a skill whose body reached the model belongs in it: opened through
    ``use_skill``, or ridden in the prompt and named in the envelope's
    ``skills_applied`` (ADR-0063), which the runtime accepts only for a body
    it inlined. A catalog the model read past is not a miss to report: the
    offer was the whole mechanism.
    """
    runtime.record_applied(result.skills_applied or ())
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
    # the same way it decides whether to search (ADR-0052). A short body rides
    # the prompt (ADR-0063); a long one still travels on a `use_skill` call.
    runtime = await _resolve_skill_runtime(config, state)
    # The conversation's working directory, folded in the same way: four file
    # verbs over a store namespaced by conversation, or nothing at all when the
    # turn has no conversation to namespace by (CLI, eval, worker).
    # The turn-start decision (ADR-0064) runs beside it: a bounded call that
    # only adds to the turn — round-0 fetches, card shapes, the IFC skill.
    # The provider reads (four cache-first BFF lookups) run beside them too:
    # nothing here depends on another, so the turn pays the slowest of the
    # three, not their sum.
    # The question's embedding is warmed beside them (see _warm_question), so
    # the round-0 search it prefetches does not pay that round trip after.
    # The facts only feed the decision, so a config without it builds none.
    facts = _turn_facts(state, runtime) if config.turn_decisions else None
    _warm_question(facts)
    draft_tools, decisions, llm_provider = await asyncio.gather(
        draft_tools_for_turn(), _decide_turn(facts), _active_provider(deployment.provider)
    )
    _apply_decisions(decisions, state, runtime)
    # After the decision: the skill it inlined is part of what this turn inlined.
    if runtime is not None:
        emit_skills_offered(runtime)
    turn_tools = _tools_in_scope(
        list(deployment.tools) + (list(runtime.build_tools()) if runtime is not None else []) + draft_tools
    )
    turn = TurnConfig(
        llm_provider=llm_provider,
        tools=turn_tools,
        disabled_sources=disabled_sources,
        prefetch=_turn_prefetch(decisions, facts, state),
    )
    if runtime is not None:
        state.skills_block = _skills_block(runtime)
    result = await _run_agent(deployment, state, turn)
    if result is None:
        return _reply(state, SCOPED_NO_SOURCES_MESSAGE)
    if runtime is not None:
        _report_skills(result, runtime)
    return result


def _turn_prefetch(decisions: TurnDecisions, facts: TurnFacts | None, state: ResearchAgentState) -> tuple:
    """Round 0's tool calls; none when the config switched the decision off."""
    if facts is None:
        return ()
    return tuple(
        prefetch_calls(
            decisions,
            facts.question,
            focus_file_name=state.focus_file_name,
            previous_message=facts.previous_message,
        )
    )


async def _run_agent(deployment: _Deployment, state: ResearchAgentState, turn: TurnConfig) -> ResearchAgentState | None:
    """The shared agent's run, or None on a scoped miss, which the caller answers."""
    try:
        return await deployment.agent.run(state, turn=turn)
    except EmptySourceRegistryError:
        # A scoped miss (this-file / this-shelf) is a valid empty answer, not
        # an unhandled NAT error. Raising here became err2issue #447 and left
        # the user with no reply.
        logger.warning("Research captured no sources; returning an empty-result answer.")
        return None


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
        max_calls_per_round=config.max_calls_per_round,
        callbacks=callbacks,
        tool_search=config.tool_search,
        deferred_tool_loading=config.deferred_tool_loading,
        envelope_json_mode_with_tools=config.envelope_json_mode_with_tools,
        repair_pass=config.repair_pass,
        card_repair_llm=(await get_langchain_llm(builder, config.card_repair_llm)) if config.card_repair_llm else None,
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
