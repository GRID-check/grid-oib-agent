"""Research agent: the bounded tool-calling turn loop.

Built ONCE per process (``register.py`` constructs it at boot): the prompt
template is read once, the LangGraph is compiled once, and the boot tool set
is bound once. What a turn may vary from that is a :class:`TurnConfig`: the
model override (BYOK / ZDR / per-org model) and the tool set (data-source
narrowing, the per-turn ``use_skill`` closure) with its reserved skill loads.
``run()`` binds those into a :class:`TurnBinding` that travels to the graph
nodes on the LangGraph config, so a turn costs one ``bind_tools`` at most and
never a prompt read or a graph compile.

The post-answer pipeline lives in :mod:`.answer_pipeline`, the repair pass in
:mod:`.repair`, the wire and ledger in :mod:`.ledger`, prompt assembly in
:mod:`.prompt`.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from typing import Protocol
from typing import runtime_checkable

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.graph import StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import ToolNode
from langgraph.prebuilt import tools_condition

from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import get_source_id_for_tool
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import begin_turn_capture
from aiq_agent.common.citation_verification import end_turn_capture
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import get_session_registry
from aiq_agent.common.citation_verification import get_turn_captures
from aiq_agent.common.citation_verification import record_turn_capture
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import bind_tools_deferred
from aiq_agent.common.turn_status import emit_research_truncated
from aiq_agent.common.turn_status import emit_retrieval
from aiq_agent.tools.bim.measurement_sources import begin_measurement_capture
from aiq_agent.tools.bim.measurement_sources import end_measurement_capture
from aiq_agent.tools.bim.measurement_sources import get_measurement_captures

from .answer_pipeline import FinalAnswer
from .answer_pipeline import RepairFn
from .answer_pipeline import finalize_answer
from .envelope_call import ainvoke_with_envelope_json_mode
from .grounding import tool_result_is_measurement
from .ledger import assemble_result
from .models import ResearchAgentState
from .prompt import build_tools_info
from .prompt import render_system_prompt
from .prompt import shelf_label
from .prompt import system_prompt_template
from .repair import VerificationFailures
from .repair import repair_answer
from .tool_search import ToolSearchIndex
from .tool_search import ToolSearchSettings
from .tool_search import build_query_parts
from .tool_search import tool_basename

logger = logging.getLogger(__name__)

# Imported from outside this package under this name
# (``tests/aiq_agent/agents/test_composer_subject_reaches_prompts.py``).
_shelf_label = shelf_label

# Interaction tools: `remember` (durable memory), `emit_card` and
# `describe_card` (UI cards), the four verbs of the conversation's working
# directory (`ls`, `read_file`, `write_file`, `edit_file` —
# ``tools/documents``) and the five write-side workspace tools that propose a
# file operation on a card (`move_document`, `rename_document`,
# `create_folder`, `set_doc_class`, `assign_document` — ``tools/files``) plus the
# working directory's two doors into the project (`file_draft`, `submit_draft` —
# ``tools/documents/register.py``). Each
# is an OUTPUT channel of the answer rather than a
# way of learning something, so their calls are budgeted apart from research
# (see ``_INTERACTION_TOOL_ALLOWANCE``). Matched on the tool's base name so an
# MCP/group-qualified variant (e.g. ``mcp__remember``) is still recognized.
_INTERACTION_TOOL_BASENAMES = frozenset(
    {
        "remember",
        "emit_card",
        "describe_card",
        "ls",
        "read_file",
        "write_file",
        "edit_file",
        "move_document",
        "rename_document",
        "create_folder",
        "set_doc_class",
        "assign_document",
        "file_draft",
        "submit_draft",
    }
)

# How many interaction calls a turn may make WITHOUT spending research budget.
# Sized from what the card doctrine sanctions, read at its most generous so the
# budget is never the thing that decides: one `describe_card`, three
# `emit_card` (the two content cards `_CARD_RESTRAINT` allows plus a verdict
# header), one `remember`, and one spare for the retry `emit_card` invites by
# returning a shape hint on a validation failure. Six.
#
# The working directory adds three on top, which is the more expensive of its
# two turn shapes: writing a first draft costs one `write_file`, while revising
# one costs a `read_file` and the two `edit_file` calls a "kürze Punkt 3 und
# ergänze die Frist" turn really makes. Nine.
#
# The five file-operation tools add NOTHING on top, and that is the calibration
# rather than an omission. A tidying turn proposes one or two operations —
# „leg den Brandschutznachweis zu den Einreichunterlagen" is one call, „räum
# die Einreichunterlagen zusammen" is a handful of `move_document` calls that
# all land on ONE card — and it is not a turn that also writes a draft and
# emits three cards. The two shapes are alternatives, so their ceilings are
# not additive; raising the number for a turn that never happens would only
# buy a runaway loop more room.
#
# `file_draft` and `submit_draft` add NOTHING either, for the same calibration
# read one step further along. They are the END of a drafting turn, not a shape
# of their own: the turn that files is the turn that wrote or revised, so the
# call lands inside the three the working directory already has — one
# `write_file` then one `file_draft` is two of three, and the expensive revision
# shape (`read_file` + two `edit_file`) is not a turn that also files, because
# the reader asked for a change and not for a handover. Raising the number for a
# turn that does all five would only buy a runaway loop more room.
#
# It is a CEILING on the exemption, not a second budget to spend: a call past it
# is charged to research exactly as before, so the tool loop still terminates on
# the ceiling no matter what the model does with the card channel, the
# working directory or the file verbs.
_INTERACTION_TOOL_ALLOWANCE = 9

# Cap on both tool-search caches (query → selection, selection → bound LLM).
# A shared agent serves many requests, so each map is dropped WHOLE at the cap
# rather than grown or LRU-tracked: a miss costs one re-rank (0.05 ms) or one
# bind_tools (pure CPU, no network), while an unbounded dict on a long-lived
# worker costs memory forever.
_MAX_CACHED_BINDINGS = 32

#: Where the turn's binding rides on the LangGraph config (``configurable``),
#: so the compiled graph is shared across turns and never rebuilt.
_TURN_BINDING_KEY = "researcher_turn"

_SYNTHESIS_ANCHOR = (
    "You have exhausted your research budget. Synthesize the final answer now "
    "as your ```answer_json envelope object, "
    "using the citations [1], [2] and the '## References' format. "
    "Do not attempt any further tool calls."
)


@runtime_checkable
class FinalReportSink(Protocol):
    """A callback that wants the verified, sanitised answer text."""

    def emit_final_report(self, text: str) -> None: ...


@dataclass(frozen=True)
class TurnConfig:
    """What one turn may vary from the boot-time agent. ``None`` keeps the boot value."""

    llm_provider: LLMProvider | None = None
    tools: Sequence[BaseTool] | None = None
    #: Extra tool calls granted ON TOP of the research budget for the
    #: ``use_skill`` calls this deployment forces (``delivery: standard``).
    reserved_tool_iterations: int | None = None


@dataclass(frozen=True)
class TurnBinding:
    """A turn's resolved LLM, tool set and budget; what the graph nodes read."""

    llm: BaseChatModel
    llm_with_tools: Any
    tools: tuple[BaseTool, ...]
    tools_info: list[dict[str, str]]
    tool_node: ToolNode
    source_tool_names: frozenset[str]
    reserved_tool_iterations: int
    #: The tool-call count at which synthesis is forced.
    ceiling: int


def _count_interaction_calls(tool_calls: Iterable[Any]) -> int:
    """How many of a round's tool calls are the answer's own output channel.

    Interaction calls (``emit_card``, ``describe_card``, ``remember``, the
    working directory's four file verbs, its two filing verbs and the five
    file-operation proposals)
    produce the answer's cards, its
    durable memory and its drafts, not evidence, so they are counted
    separately from the research budget. Matched on the BASE name, so a
    NAT/MCP-qualified variant counts too. A call whose shape cannot be read
    is counted as research: the conservative direction, it can only shorten a
    turn's research, never let the loop run longer.
    """
    count = 0
    for call in tool_calls or ():
        name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
        if name and tool_basename(str(name)) in _INTERACTION_TOOL_BASENAMES:
            count += 1
    return count


def _tool_call_rounds(messages: Sequence[Any]) -> int:
    """How many LLM turns of this run asked for tools at all.

    Rounds, not calls: the model emits its calls in parallel batches, so
    "7 calls" says nothing about how far the investigation got and "3 rounds
    of 7 calls" says everything.
    """
    return sum(1 for message in messages if getattr(message, "tool_calls", None))


def _call_basenames(message: Any) -> list[str]:
    """The basenames of one message's tool calls, in order."""
    names: list[str] = []
    for call in getattr(message, "tool_calls", None) or []:
        name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
        if name:
            names.append(tool_basename(str(name)))
    return names


def _tool_call_shape(messages: Sequence[Any], *, limit: int = 24) -> list[str]:
    """The ordered basenames of every tool this run called.

    The SHAPE of a question, standing in for the question itself: a truncated
    ``use_skill>use_skill>knowledge_search>find_elements>…`` is the fingerprint
    of an OIB 3 daylight chain, and grouping truncations by it is how "on which
    question shapes" gets answered. The tool names and never the arguments: a
    query string is the reader's own words. Capped, because it is a
    fingerprint and not a transcript.
    """
    shape: list[str] = []
    for message in messages:
        shape.extend(_call_basenames(message))
        if len(shape) >= limit:
            return shape[:limit]
    return shape


def _charge_tool_calls(response: Any, state: ResearchAgentState, ceiling: int) -> tuple[int, int]:
    """What this round COSTS, and to which budget: ``(research, interaction)`` totals.

    ``max_tool_iterations`` is the RESEARCH budget, but every call used to be
    charged to it, ``emit_card`` and ``describe_card`` included. Those are
    the answer's OUTPUT channel and are called last, so on any turn that
    actually researched the ceiling landed on the cards rather than on the
    research, and the second card the doctrine allows was unreachable by
    construction. So the interaction channel gets its own allowance, spent
    before the research budget is touched. Bounded rather than free: past the
    allowance the calls are charged normally again.
    """
    calls = getattr(response, "tool_calls", None) or []
    if not calls:
        return state.tool_iterations, state.interaction_iterations
    interaction_calls = _count_interaction_calls(calls)
    research_calls = len(calls) - interaction_calls
    exempt = min(interaction_calls, max(0, _INTERACTION_TOOL_ALLOWANCE - state.interaction_iterations))
    research = state.tool_iterations + research_calls + (interaction_calls - exempt)
    interaction = state.interaction_iterations + interaction_calls
    logger.info(
        "Added %d tool calls (%d research, %d interaction of which %d free). "
        "Research budget spent: %d/%d. Interaction spent: %d/%d",
        len(calls),
        research_calls,
        interaction_calls,
        exempt,
        research,
        ceiling,
        interaction,
        _INTERACTION_TOOL_ALLOWANCE,
    )
    # The same fact, said to the USER instead of the log: one line per ROUND.
    emit_retrieval(calls, round_index=state.tool_iterations)
    return research, interaction


def _recursion_limit(ceiling: int) -> int:
    """The LangGraph step guard, derived from the ceiling the loop really stops at.

    Two graph steps per tool-call round (agent + tools), plus slack. The
    interaction allowance is added because it buys rounds the research budget
    no longer pays for: a model that emits its cards one call at a time must
    reach the ceiling it is supposed to reach instead of a
    ``GraphRecursionError`` on the way there.
    """
    return ((ceiling + _INTERACTION_TOOL_ALLOWANCE) * 2) + 10


def _capture_sources(
    tool_name: str,
    content: str,
    source_tool_names: frozenset[str],
    registry: SourceRegistry,
) -> None:
    """Register the sources one tool result carries, gated twice.

    The tool must be in the agent's loaded tool set AND resolve to a
    configured data source: the researcher tool list also carries interaction
    tools such as ``emit_card`` and ``remember``, whose confirmations would
    otherwise register as tool-name citation keys via the non-URL fallback.
    The registry is cumulative across the conversation; the citation-health
    ledger needs THIS turn's retrieval, so it is recorded separately.
    """
    if tool_name not in source_tool_names:
        return
    source_id = get_source_id_for_tool(tool_name)
    if source_id is None:
        logger.debug("[CitationRegistry] Skipping non-data-source tool result from %s", tool_name)
        return
    sources = extract_sources_from_tool_result(tool_name, content, source_id=source_id)
    for source in sources:
        registry.add(source)
    record_turn_capture(sources)
    if sources:
        logger.info(
            "[CitationRegistry] Captured %d source(s) from %s: %s",
            len(sources),
            tool_name,
            [s.url or s.citation_key for s in sources],
        )


def _bind_registry() -> tuple[SourceRegistry, Any]:
    """The registry this run captures into: the session's, else a fresh one.

    The fresh registry is bound via the ContextVar so the tools node sees it,
    and unbound by the caller with the returned token (``None`` when the
    session's registry was already bound). Concurrent standalone runs (``nat
    eval``) therefore never share one and cannot cross-pollinate citations.
    """
    registry = get_session_registry()
    if registry is not None:
        return registry, None
    registry = SourceRegistry()
    return registry, set_session_registry(registry)


class ResearcherAgent:
    """Fast, bounded research with tool-calling.

    A two-node LangGraph (``agent`` → ``tools`` → ``agent`` …) whose loop
    terminates on the tool-iteration ceiling, followed by the post-answer
    pipeline. NAT-independent: every dependency arrives via the constructor,
    and what varies per turn arrives via :meth:`run`'s ``turn``.

    Example:
        >>> provider = LLMProvider()
        >>> provider.set_default(my_llm)
        >>> agent = ResearcherAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=5)
        >>> result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="What is CUDA?")]))
    """

    def __init__(
        self,
        llm_provider: LLMProvider,
        tools: Sequence[BaseTool],
        *,
        system_prompt: str | None = None,
        max_tool_iterations: int = 5,
        reserved_tool_iterations: int = 0,
        callbacks: list[Any] | None = None,
        tool_search: ToolSearchSettings | None = None,
        deferred_tool_loading: DeferredToolLoadingSettings | None = None,
        envelope_json_mode_with_tools: bool = False,
        repair_pass: bool = True,
    ) -> None:
        """Build the agent once.

        Args:
            llm_provider: LLMProvider for role-based LLM access.
            tools: The boot tool set. A turn may narrow or extend it.
            system_prompt: Optional custom template; the default is
                ``prompts/researcher.j2``, read once per process.
            max_tool_iterations: The RESEARCH budget, tool calls the turn may
                spend looking things up before synthesis is forced.
            reserved_tool_iterations: Extra tool calls granted ON TOP of the
                research budget for the ``use_skill`` calls a deployment
                forces. Charged to the research budget they would shrink every
                research chain by one per published standard skill.
            callbacks: Optional LangGraph callbacks.
            tool_search: Optional retrieval-based tool narrowing. None (or
                disabled) binds the full set.
            deferred_tool_loading: Optional OpenRouter server-side tool
                search. Orthogonal to ``tool_search``: that one decides WHICH
                tools are bound, this one whether their schemas travel.
            envelope_json_mode_with_tools: Whether provider JSON mode is ALSO
                bound on tool-bound research iterations, not only on the
                tool-free forced-synthesis call. Default False: some
                OpenRouter-routed providers accept the parameter and then stop
                emitting tool calls, a silent degradation the per-call
                fallback cannot see.
            repair_pass: One bounded repair after verification (``repair.py``).
                Off is the pre-repair behaviour: ship the markers, never
                re-search.
        """
        self.llm_provider = llm_provider
        self.tools = list(tools)
        self.max_tool_iterations = max_tool_iterations
        self.reserved_tool_iterations = max(0, reserved_tool_iterations)
        self.callbacks = callbacks or []
        self.repair_pass = repair_pass
        self.tool_search = tool_search if (tool_search is not None and tool_search.enabled) else None
        self.deferred_tool_loading = (
            deferred_tool_loading if (deferred_tool_loading is not None and deferred_tool_loading.enabled) else None
        )
        self.envelope_json_mode_with_tools = envelope_json_mode_with_tools
        self.system_prompt = system_prompt or system_prompt_template()
        self.tools_info = build_tools_info(self.tools)
        # Retrieval-based tool narrowing, off unless configured. A pure
        # in-process BM25 over tool name + description, built here once: a
        # turn never pays for it, and a deployment that does not ask for it
        # does not even tokenize its tool descriptions. Indexed over the BOOT
        # tools; a tool a turn adds (``use_skill``) is never withheld.
        self._tool_search_index: ToolSearchIndex | None = ToolSearchIndex(self.tools) if self.tool_search else None
        # Selected-tool-set → bound LLM, for the boot binding only.
        self._narrowed_bindings: dict[frozenset[str], Any] = {}
        # Query string → selection, so the retrieval runs once per run.
        self._tool_search_selections: dict[str, Any] = {}
        self._boot = self._bind_turn(self.llm_provider, tuple(self.tools), self.reserved_tool_iterations)
        self._graph = self._build_graph()

    # -- bindings ---------------------------------------------------------------

    @property
    def _llm_with_tools(self) -> Any:
        """The boot binding: every boot tool, bound once at construction."""
        return self._boot.llm_with_tools

    @property
    def tool_iteration_ceiling(self) -> int:
        """The tool-call count at which synthesis is forced, for the boot budget.

        ``max_tool_iterations`` stays exactly what the config's traced floors
        measure; the reserve on top pays for the ``use_skill`` calls the
        deployment forces on every research turn.
        """
        return self.max_tool_iterations + self.reserved_tool_iterations

    @property
    def graph(self) -> CompiledStateGraph:
        """The compiled LangGraph, for direct access."""
        return self._graph

    def _get_llm(self) -> BaseChatModel:
        """The boot researcher LLM."""
        return self.llm_provider.get(LLMRole.RESEARCHER)

    def _bind_research_tools(self, llm: BaseChatModel, tools: Sequence[BaseTool]) -> Any:
        """Bind a RESEARCH-turn tool set, deferring the schemas when configured.

        The single binding seam: the boot binding, every per-turn binding and
        every narrowed one go through it, so the deferral cannot apply to one
        and silently miss another.
        """
        return bind_tools_deferred(llm, list(tools), settings=self.deferred_tool_loading, parallel_tool_calls=True)

    def _bind_turn(self, provider: LLMProvider, tools: tuple[BaseTool, ...], reserved: int) -> TurnBinding:
        """Resolve one tool set against one provider: the only per-turn cost, one ``bind_tools``."""
        llm = provider.get(LLMRole.RESEARCHER)
        boot_tools = tools == tuple(self.tools)
        return TurnBinding(
            llm=llm,
            llm_with_tools=self._bind_research_tools(llm, tools),
            tools=tools,
            tools_info=self.tools_info if boot_tools else build_tools_info(tools),
            tool_node=ToolNode(list(tools)),
            source_tool_names=frozenset(t.name for t in tools),
            reserved_tool_iterations=reserved,
            ceiling=self.max_tool_iterations + reserved,
        )

    def _resolve_turn(self, turn: TurnConfig | None) -> TurnBinding:
        """The boot binding when the turn varies nothing; a fresh one otherwise."""
        if turn is None:
            return self._boot
        provider = turn.llm_provider or self.llm_provider
        tools = tuple(self.tools if turn.tools is None else turn.tools)
        reserved = self._boot.reserved_tool_iterations
        if turn.reserved_tool_iterations is not None:
            reserved = max(0, turn.reserved_tool_iterations)
        unchanged = provider is self.llm_provider and tools == self._boot.tools
        if unchanged and reserved == self._boot.reserved_tool_iterations:
            return self._boot
        return self._bind_turn(provider, tools, reserved)

    def _select_tools_for_query(self, messages: Sequence[Any]) -> Any:
        """Run (or replay) the tool-search retrieval for this run's question.

        Cached on the query string: the query is built from HUMAN turns only,
        so it is identical across every iteration of one run. Returns ``None``
        when the feature is off or the retrieval could not produce a decision;
        both mean "use the full set".
        """
        settings = self.tool_search
        index = self._tool_search_index
        if settings is None or index is None:
            return None
        try:
            query_parts = build_query_parts(messages)
            if not query_parts:
                return None
            cache_key = "\n<<part>>\n".join(f"{part.weight}:{part.text}" for part in query_parts)
            cached = self._tool_search_selections.get(cache_key)
            if cached is not None:
                return cached
            selection = index.select(query_parts, top_k=settings.top_k, always_include=settings.always_include)
        except Exception:  # noqa: BLE001 - a ranking is a convenience; the tool set is the contract
            logger.warning("[ToolSearch] retrieval failed; binding the full tool set", exc_info=True)
            return None
        # ADR-0045: the shape of the call, never the building. Tool names are
        # code identifiers from our own config.
        logger.info(
            "[ToolSearch] %s: bound %d/%d tool(s) — selected=%s withheld=%s",
            selection.reason,
            len(selection.selected),
            len(index.tool_names),
            list(selection.selected),
            list(selection.withheld),
        )
        if len(self._tool_search_selections) >= _MAX_CACHED_BINDINGS:
            self._tool_search_selections.clear()
        self._tool_search_selections[cache_key] = selection
        return selection

    def _narrowed_binding(self, binding: TurnBinding, chosen: frozenset[str], tools: list[BaseTool]) -> Any:
        """The bound LLM for a narrowed set; cached for the boot binding only."""
        if binding is not self._boot:
            return self._bind_research_tools(binding.llm, tools)
        bound = self._narrowed_bindings.get(chosen)
        if bound is not None:
            return bound
        bound = self._bind_research_tools(binding.llm, tools)
        if len(self._narrowed_bindings) >= _MAX_CACHED_BINDINGS:
            self._narrowed_bindings.clear()
        self._narrowed_bindings[chosen] = bound
        return bound

    def _research_tool_binding(
        self,
        messages: Sequence[Any],
        tools_info: list[dict[str, str]],
        binding: TurnBinding | None = None,
    ) -> tuple[Any, list[dict[str, str]]]:
        """LLM + prompt tool list for a RESEARCH turn, narrowed if configured.

        With tool search off this returns the turn's binding and the caller's
        tool list untouched. With it on, the narrowing happens HERE, around
        the LLM call: the model is offered fewer tools, not asked to find
        them, so a narrowed turn costs exactly what an unnarrowed one costs.
        The prompt's tool list is narrowed to match the binding, so the model
        is never told about a tool it has not been given. A tool the index
        never saw (one the turn added) is always kept.
        """
        binding = binding or self._boot
        selection = self._select_tools_for_query(messages)
        if selection is None or not selection.narrowed:
            return binding.llm_with_tools, tools_info
        chosen = frozenset(selection.selected)
        indexed = set(self._tool_search_index.tool_names) if self._tool_search_index else set()
        keep = {t.name for t in binding.tools if t.name in chosen or t.name not in indexed}
        narrowed_tools = [t for t in binding.tools if t.name in keep]
        if not narrowed_tools:
            # Belt and braces over ``select``'s own empty guard: an empty
            # binding would leave the model with no way to answer at all.
            return binding.llm_with_tools, tools_info
        bound = self._narrowed_binding(binding, chosen, narrowed_tools)
        return bound, [ti for ti in tools_info if ti.get("name") in keep]

    # -- graph ------------------------------------------------------------------

    def _build_graph(self) -> CompiledStateGraph:
        """Compile the two-node loop once; turns vary through the config."""
        builder = StateGraph(ResearchAgentState)
        builder.set_entry_point("agent")
        builder.add_node("agent", self._agent_node)
        builder.add_node("tools", self._tools_node)
        builder.add_conditional_edges("agent", tools_condition, {"tools": "tools", "__end__": "__end__"})
        builder.add_edge("tools", "agent")
        return builder.compile()

    def _turn_binding(self, config: RunnableConfig) -> TurnBinding:
        """The binding ``run()`` put on the config; the boot one on the graph-direct path."""
        return (config.get("configurable") or {}).get(_TURN_BINDING_KEY) or self._boot

    async def _agent_node(self, state: ResearchAgentState, config: RunnableConfig) -> dict[str, Any]:
        """One LLM call: the full binding (ADR-0052), or forced synthesis at the ceiling."""
        binding = self._turn_binding(config)
        tools_info = state.tools_info if state.tools_info else binding.tools_info
        llm_with_tools, tools_info = self._research_tool_binding(state.messages, tools_info, binding)
        # Rendered once per run and cached on the state: every input is fixed
        # for the life of one run(), so the string is byte-identical across
        # tool-loop iterations and the norm-block computation runs once.
        system_prompt = state.cached_system_prompt
        if system_prompt is None:
            system_prompt = render_system_prompt(self.system_prompt, state, tools_info)
        if state.tool_iterations >= binding.ceiling:
            return await self._forced_synthesis(state, binding, system_prompt)

        messages = [SystemMessage(content=system_prompt), *state.messages]
        if self.envelope_json_mode_with_tools:
            response = await ainvoke_with_envelope_json_mode(llm_with_tools, messages)
        else:
            response = await llm_with_tools.ainvoke(messages)
        research, interaction = _charge_tool_calls(response, state, binding.ceiling)
        return {
            "messages": [response],
            "tool_iterations": research,
            "interaction_iterations": interaction,
            "cached_system_prompt": system_prompt,
        }

    async def _forced_synthesis(
        self,
        state: ResearchAgentState,
        binding: TurnBinding,
        system_prompt: str,
    ) -> dict[str, Any]:
        """TRUNCATION: the turn ran out of budget mid-investigation.

        The worst failure this product has (see the traced floors in
        ``configs/config_oib_openrouter.yml``). What is recorded is the SHAPE
        of the run, the ordered tool names, because that is what makes the
        population answerable without logging the reader's question; the
        answer carries ``research_truncated`` so the reader can be told too.
        Forced synthesis is the tool-FREE call, so provider JSON mode is safe
        here unconditionally.
        """
        shape = _tool_call_shape(state.messages)
        rounds = _tool_call_rounds(state.messages)
        logger.warning(
            "Research budget exhausted: forcing synthesis "
            "(ceiling=%d research_budget=%d reserved=%d spent=%d rounds=%d skill_calls=%d shape=%s)",
            binding.ceiling,
            self.max_tool_iterations,
            binding.reserved_tool_iterations,
            state.tool_iterations,
            rounds,
            shape.count("use_skill"),
            ">".join(shape) or "-",
        )
        emit_research_truncated(
            ceiling=binding.ceiling,
            research_budget=self.max_tool_iterations,
            reserved=binding.reserved_tool_iterations,
            spent=state.tool_iterations,
            rounds=rounds,
            shape=shape,
        )
        # Anchored at the end to combat "Loss in the Middle".
        messages = [SystemMessage(content=system_prompt), *state.messages, HumanMessage(content=_SYNTHESIS_ANCHOR)]
        response = await ainvoke_with_envelope_json_mode(binding.llm, messages)
        return {
            "messages": [response],
            "tool_iterations": state.tool_iterations,
            "cached_system_prompt": system_prompt,
            "research_truncated": True,
        }

    async def _tools_node(self, state: ResearchAgentState, config: RunnableConfig) -> dict[str, Any]:
        """Execute the round's tools and capture sources and measurements.

        Tool-search narrowing gets no execution-side defense: it is a GUESS
        about relevance, and if the model calls a withheld tool anyway the
        guess was wrong and the model is right. Measurement grounding is
        STICKY (OR-ed with what the loop already saw) and recorded BEFORE the
        data-source gate, because ``ifc_measure`` is deliberately not a data
        source: it produces no citable passage.
        """
        binding = self._turn_binding(config)
        result = await binding.tool_node.ainvoke(state)
        registry = get_session_registry()
        if registry is None:
            raise RuntimeError("ResearcherAgent graph invoked outside run(): no source registry is bound")
        measured = bool(state.answer_measurement_grounded)
        for message in result.get("messages", []):
            if not isinstance(message, ToolMessage) or not message.content:
                continue
            tool_name = getattr(message, "name", "") or ""
            content = str(message.content)
            measured = measured or tool_result_is_measurement(tool_name, content)
            _capture_sources(tool_name, content, binding.source_tool_names, registry)
        if measured:
            return {**result, "answer_measurement_grounded": True}
        return result

    # -- the turn ---------------------------------------------------------------

    def _graph_config(self, binding: TurnBinding) -> dict[str, Any]:
        config: dict[str, Any] = {
            "recursion_limit": _recursion_limit(binding.ceiling),
            "configurable": {_TURN_BINDING_KEY: binding},
        }
        if self.callbacks:
            config["callbacks"] = self.callbacks
        return config

    def _repairer(self, binding: TurnBinding, graph_result: dict[str, Any]) -> RepairFn | None:
        """The turn's one repair, bound to this turn's LLM and tools; ``None`` when off."""
        if not self.repair_pass:
            return None
        system_prompt = graph_result.get("cached_system_prompt") or self.system_prompt

        async def repair(prose: str, failures: VerificationFailures, history: list[Any]) -> Any:
            return await repair_answer(
                prose,
                failures=failures,
                tools=binding.tools,
                llm=binding.llm,
                system_prompt=system_prompt,
                history=history,
            )

        return repair

    def _emit_final_report(self, final: FinalAnswer) -> None:
        """Hand the verified, sanitised text to the first callback that renders it
        (it overwrites the raw draft auto-emitted during ``ainvoke``)."""
        if not final.answered or final.content is None:
            return
        for callback in self.callbacks:
            if isinstance(callback, FinalReportSink):
                callback.emit_final_report(final.content)
                return

    async def run(
        self,
        state: ResearchAgentState,
        *,
        turn: TurnConfig | None = None,
    ) -> ResearchAgentState:
        """Execute one research turn: the tool loop, then the post-answer pipeline.

        What THIS turn's tools returned and MEASURED are captured on two
        separate ledgers beside the cumulative registry. That separation is
        the safety property: ``citation_grounded`` derives from the registry
        and is the only route to a surfaced "high", while the normative brake
        is gated on its ABSENCE; a measurement in the registry would hand an
        uncited legal verdict the evidence of the basement measurement standing
        next to it (see ``bim.measurement_sources``).
        """
        binding = self._resolve_turn(turn)
        registry, registry_token = _bind_registry()
        turn_capture = begin_turn_capture()
        measurement_capture = begin_measurement_capture()
        try:
            graph_result = await self._graph.ainvoke(state, config=self._graph_config(binding))
            turn_sources = get_turn_captures()
            turn_measurements = get_measurement_captures()
        finally:
            end_measurement_capture(measurement_capture)
            end_turn_capture(turn_capture)
            if registry_token is not None:
                reset_session_registry(registry_token)

        final = await finalize_answer(
            graph_result.get("messages") or [],
            registry=registry,
            tools=binding.tools,
            repair=self._repairer(binding, graph_result),
        )
        self._emit_final_report(final)
        return assemble_result(
            graph_result,
            final,
            turn_sources=[*turn_sources, *final.repair_sources],
            turn_measurements=turn_measurements,
        )
