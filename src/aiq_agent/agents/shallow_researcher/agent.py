"""Shallow research agent for fast, bounded research with tool-calling."""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from langgraph.graph import StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import ToolNode
from langgraph.prebuilt import tools_condition

from aiq_agent.agents.bim.measurement_sources import MeasurementSource
from aiq_agent.agents.bim.measurement_sources import begin_measurement_capture
from aiq_agent.agents.bim.measurement_sources import end_measurement_capture
from aiq_agent.agents.bim.measurement_sources import get_measurement_captures
from aiq_agent.agents.bim.measurement_sources import measurement_sources_to_wire
from aiq_agent.common import citation_events
from aiq_agent.common import content_to_text
from aiq_agent.common import get_source_id_for_tool
from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import annotate_unverified_quotes
from aiq_agent.common.citation_verification import begin_turn_capture
from aiq_agent.common.citation_verification import end_turn_capture
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import get_session_registry
from aiq_agent.common.citation_verification import get_turn_captures
from aiq_agent.common.citation_verification import record_turn_capture
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.citation_verification import source_label
from aiq_agent.common.citation_verification import source_origin_token
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.citation_verification import verify_quoted_spans
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import bind_tools_deferred
from aiq_agent.common.norm_registry import doctrine_for
from aiq_agent.common.norm_registry import parcel_note
from aiq_agent.common.norm_registry import render_block_for_prompt
from aiq_agent.common.turn_status import emit_research_truncated

from ...common import LLMProvider
from ...common import LLMRole
from .dsml import strip_and_salvage_dsml_tool_calls
from .grounding import answer_mentions_normative_claim
from .grounding import tool_result_is_measurement
from .markers import answer_confidence_capped_reason
from .markers import detect_and_strip_confidence_marker
from .markers import detect_and_strip_escalation_marker
from .models import ShallowResearchAgentState
from .tool_search import ToolSearchIndex
from .tool_search import ToolSearchSettings
from .tool_search import build_query_parts
from .tool_search import tool_basename

logger = logging.getLogger(__name__)


# Path to this agent's directory (for loading prompts)
AGENT_DIR = Path(__file__).parent


def _shelf_label(shelf: str | None) -> str | None:
    """Reader-facing German shelf name for the focused file, or None.

    The prompt names the shelf the same way the inventory block does, so the
    subject line and the inventory cannot disagree about where a file sits.
    An unparseable shelf yields None: the focus line then names the file
    alone rather than inventing a shelf for it.
    """
    if not shelf:
        return None
    from aiq_agent.common.source_kinds import SHELF_QUALIFIERS
    from aiq_agent.common.source_kinds import parse_shelf

    parsed = parse_shelf(shelf)
    return SHELF_QUALIFIERS.get(parsed) if parsed is not None else None


# Interaction tools the model still needs on conversational/meta turns —
# `remember` (durable memory) and `emit_card` (UI cards). Matched on the tool's
# base name so an MCP/group-qualified variant (e.g. ``mcp__remember``) is still
# recognized. These are ALWAYS kept on meta turns, even if their qualified name
# happens to prefix-match a declared data-source group, so a "remember this"
# turn — which the orchestrator routes to this agent precisely for `remember` —
# never loses the tool it was routed here to use.
_INTERACTION_TOOL_BASENAMES = frozenset({"remember", "emit_card"})

# Tool-name base resolution lives with the retrieval that also needs it
# (``tool_search.tool_basename``) so both the meta partition and the
# ``always_include`` pin set resolve a group-qualified name the same way.
# This replaces the local separator-splitting helper: `TOOL_NAME_SEPARATORS`
# now lives beside `tool_basename` in `tool_search`, so a NAT-qualified name
# is decomposed in exactly one place rather than two that can disagree.
_tool_basename = tool_basename

# File-discovery tools that are NOT data-source registry entries, but still
# mix shelves if they stay bound on a listing/meta turn (the IFC models in
# "was hast du im Archiv" never came from available_documents).
_FILE_DISCOVERY_BASENAMES = frozenset({"surface_documents", "ifc_query", "ifc_measure"})

# Cap on both tool-search caches (query → selection, selection → bound LLM).
# A shared agent serves many requests, so each map is dropped WHOLE at the cap
# rather than grown or LRU-tracked: a miss costs one re-rank (0.05 ms) or one
# bind_tools (pure CPU, no network), while an unbounded dict on a long-lived
# worker costs memory forever.
_MAX_CACHED_BINDINGS = 32


def _is_search_tool(tool_name: str) -> bool:
    """True if a tool is a data-source/search tool (dropped on meta turns).

    A tool counts as a search tool iff it resolves to a configured data source
    via :func:`get_source_id_for_tool` AND is not one of the known interaction
    tools. The interaction allowlist wins, so a `remember`/`emit_card` tool
    whose qualified name prefix-matches a data-source group ref is never
    mistakenly treated as search and dropped from a conversational turn.
    """
    if _tool_basename(tool_name) in _INTERACTION_TOOL_BASENAMES:
        return False
    if _tool_basename(tool_name) in _FILE_DISCOVERY_BASENAMES:
        return True
    return get_source_id_for_tool(tool_name) is not None


def _tool_call_rounds(messages: Sequence[Any]) -> int:
    """How many LLM turns of this run asked for tools at all.

    Rounds, not calls: the model emits its calls in parallel batches, so
    "7 calls" says nothing about how far the investigation actually got and
    "3 rounds of 7 calls" says everything. The pair is what makes a truncation
    log readable — a run that burnt its budget in one greedy batch is a
    different failure from one that walked into the ceiling step by step.
    """
    return sum(1 for message in messages if getattr(message, "tool_calls", None))


def _tool_call_shape(messages: Sequence[Any], *, limit: int = 24) -> list[str]:
    """The ordered basenames of every tool this run called.

    The SHAPE of a question, standing in for the question itself: a truncated
    ``use_skill>use_skill>knowledge_search>find_elements>…`` is the recognisable
    fingerprint of an OIB 3 daylight chain, and grouping truncations by it is
    how "on which question shapes" gets answered. Deliberately the tool names
    and never the arguments — a query string is the reader's own words, and a
    warning log is not a place to put them.

    Capped, because the list is a fingerprint and not a transcript.
    """
    shape: list[str] = []
    for message in messages:
        for call in getattr(message, "tool_calls", None) or []:
            name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
            if name:
                shape.append(_tool_basename(str(name)))
            if len(shape) >= limit:
                return shape
    return shape


def _summarize_removed_citations(removed_citations: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Summarize ``verify_citations`` drops for the transparency wire.

    Returns ``{"count": int, "reasons": [str, ...]}`` (reasons deduplicated in
    first-seen order, max 5) only when ≥1 citation was removed; otherwise
    ``None`` so the ``citations_removed`` field stays absent. Shape matches the
    chat researcher's ``_normalize_citations_removed`` reader.
    """
    if not removed_citations:
        return None
    reasons: list[str] = []
    for entry in removed_citations:
        reason = str(entry.get("reason") or "unverifiable") if isinstance(entry, dict) else "unverifiable"
        if reason and reason not in reasons:
            reasons.append(reason)
        if len(reasons) >= 5:
            break
    return {"count": len(removed_citations), "reasons": reasons}


def _append_minimal_citation(report_text: str, source: SourceEntry) -> str:
    """Append one verified citation when the model omitted references."""
    citation_target = source.url or source.citation_key
    if not citation_target:
        return report_text

    # verify_citations may strip every citation line under a **References:**
    # (or ## References / ## Sources) header and leave the empty header
    # behind. Drop that trailing header before we append our own so the final
    # output has exactly one references section.
    content = report_text.rstrip()
    content = re.sub(
        r"\n{1,2}\*\*References:?\*\*\s*$",
        "",
        content,
        flags=re.IGNORECASE,
    ).rstrip()
    content = re.sub(
        r"\n{1,2}#{2,3}\s+(?:References|Sources)\s*$",
        "",
        content,
        flags=re.IGNORECASE,
    ).rstrip()
    if content.endswith((".", "!", "?")):
        content = f"{content[:-1]} [1]{content[-1]}"
    else:
        content = f"{content} [1]"

    token = source_origin_token(source)
    prefix = f"{token} " if token else ""
    if source.url:
        title = source.title or source.url
        reference = f"- [1] {prefix}{title} - {source.url}"
    else:
        reference = f"- [1] {prefix}{citation_target}"

    return f"{content}\n\n**References:**\n{reference}"


#: A trailing reference list, in the headings this agent and the models it runs
#: actually produce.
_REFERENCES_SECTION_RE = re.compile(
    r"\n\s*(?:\*\*(?:References|Sources|Quellen):?\*\*|#{2,3}\s+(?:References|Sources|Quellen))\s*(?:\n|$)",
    re.IGNORECASE,
)


#: What a reference list is allowed to consist of: a blank line, or a line that
#: carries an actual REFERENCE — a URL or a „[n]" citation marker. List
#: punctuation is not enough and never was: „- " is available to any sentence,
#: so accepting it let „- Damit ist der Raum unzulässig …" under a
#: „**Quellen:**" heading count as a bibliography entry and leave the text
#: before the brake ever read it. A bullet, a numbered entry and a nested item
#: are all still references when they point at something.
_REFERENCE_LINE_RE = re.compile(r"^\s*$|\[\d+\]|<?https?://")


def _prose_without_references(content: str) -> str:
    """The answer's own sentences, with any trailing reference list removed.

    The normative brake judges what the ANSWER asserts, and a bibliography
    asserts nothing — „- [1] Wiener Bauordnung — https://ris…" is a pointer to a
    source, not a claim about the law. It matters because of where that line
    comes from: the single-source fallback appends it, so leaving it in made
    every fallback-grounded answer read as normative and floored measured,
    purely descriptive answers to "low" under a reason („normative_claim_uncited")
    that was not true of a single sentence the model wrote.

    Only a genuinely TRAILING list is cut. Taking everything before the last
    heading match assumed the heading was the last thing in the answer, and a
    model that writes „**Quellen:** …" and then carries on — or that puts a
    ``## Sources`` line inside a fenced example — had the rest of its answer
    dropped before the brake ever read it:

        kept:    „Die Höhe beträgt 2,20 m."
        dropped: „…erfüllt die Anforderung nicht und ist unzulässig."

    That is the laundering this module exists to prevent, arriving through the
    door marked "bibliography". So a heading is a cut point only when every line
    after it POINTS AT A SOURCE — carries a URL or a „[n]" marker — or is blank;
    otherwise the search moves to the previous heading, and failing that nothing
    is removed. Erring towards keeping text is the safe direction here — a
    reference line that survives costs a hedge, a verdict that is dropped costs
    a claim about the law.

    Known gap: the test above is „does this line POINT AT A SOURCE", so ANY
    tail line carrying a URL or a „[n]" marker is cut — whatever else it says.
    A markdown link title is the tidiest example („- [Damit ist der Raum
    unzulässig](https://ris…)"), but the rule is wider than that, and a verdict
    that merely carries a „[1]" or trails a bare URL is cut the same way:

        cut:  „- Damit ist der Raum unzulässig [1]"
        cut:  „- Damit ist der Raum unzulässig, siehe https://ris…"
        kept: „- Damit ist der Raum unzulässig"          (no pointer)
        kept: „1. Damit ist der Raum unzulässig"         (no pointer)

    Nothing structural separates any of them from „- [Wiener Bauordnung](https://ris…)".
    The asymmetry that LOOKS like it should — a bibliography entry is a noun
    phrase, a verdict has a finite verb — is real, but the cheap proxy for it is
    not. Running :func:`~.grounding.answer_mentions_normative_claim` over the
    stripped tail and keeping the lines it fires on was measured, because the
    strong tier has changed since it was first dismissed, and it is still wrong
    — by more than the original note claimed. Over the reference shapes this
    repo actually emits (``_append_minimal_citation``'s own output plus the
    fixtures pinned in ``tests/…/test_grounding.py``) the brake fires on 11 of
    14 GENUINE entries, against 5 of 5 smuggled verdicts:

        FIRES  - [1] Wiener Bauordnung - https://…        ← appended by US
        FIRES  - [1] OIB-Richtlinie 4, Punkt 2.1 - https://…
        FIRES  - [5] ÖNORM B 1600 - https://…
        FIRES  - [Damit ist der Raum unzulässig](https://…)

    That is not a weak signal, it is an inverted one. The brake's strong tier is
    a list of the NAMES of Austrian legal instruments — „bauordnung", „oib",
    „richtlinie", „verordnung", „§", „norm" — and a compliance bibliography is a
    list of exactly those names, so the tail is the densest patch of strong
    stems in the whole answer. The three silent entries are the three that name
    no instrument („[RIS] BauO", a bare URL, a tool name). Adopting the rule
    would retain the reference line this module appends ITSELF, re-floor every
    single-source-fallback answer to "low", and reintroduce precisely the
    regression the paragraph above describes.

    A real finite-verb test needs a POS tagger or the hand-written verb list
    that was ruled out for guessing. So this stays open. It also takes a model
    that writes an ALL-references tail under a „**Quellen:**"/„## Sources"
    heading and smuggles the verdict into it; one ordinary prose line in that
    tail and nothing is cut at all. Left open deliberately rather than fixed
    with a heuristic that cuts the wrong way.
    """
    if not isinstance(content, str):
        return ""
    for match in reversed(list(_REFERENCES_SECTION_RE.finditer(content))):
        tail = content[match.end() :]
        if all(_REFERENCE_LINE_RE.search(line) for line in tail.splitlines()):
            return content[: match.start()]
    return content


class ShallowResearcherAgent:
    """
    Shallow research agent for fast, bounded research with tool-calling.

    This agent performs quick lookups and straightforward queries using a
    LangGraph StateGraph with tool-calling capabilities. It generates optional
    mini-plans for multi-step queries and executes bounded tool-calling loops.

    The agent is NAT-independent and receives all dependencies via constructor.

    Example:
        >>> from aiq_agent.common import LLMProvider, LLMRole
        >>> provider = LLMProvider()
        >>> provider.set_default(my_llm)
        >>>
        >>> from lib.models import ShallowResearchAgentState
        >>> agent = ShallowResearcherAgent(
        ...     llm_provider=provider,
        ...     tools=[web_search_tool, doc_search_tool],
        ...     max_tool_iterations=5,
        ... )
        >>> state = ShallowResearchAgentState(messages=[HumanMessage(content="What is CUDA?")])
        >>> result = await agent.run(state)
    """

    def __init__(
        self,
        llm_provider: LLMProvider,
        tools: Sequence[BaseTool],
        *,
        system_prompt: str | None = None,
        max_llm_turns: int = 10,
        max_tool_iterations: int = 5,
        reserved_tool_iterations: int = 0,
        callbacks: list[Any] | None = None,
        tool_search: ToolSearchSettings | None = None,
        deferred_tool_loading: DeferredToolLoadingSettings | None = None,
    ) -> None:
        """
        Initialize the shallow researcher agent.

        Args:
            llm_provider: LLMProvider for role-based LLM access.
            tools: Sequence of LangChain tools for research.
            system_prompt: Optional custom system prompt. If not provided,
                          loads system.j2 from prompts.
            max_llm_turns: Maximum LLM interaction turns (default 10).
            max_tool_iterations: The RESEARCH budget — tool calls the turn may
                spend looking things up before synthesis is forced (default 5).
            reserved_tool_iterations: Extra tool calls granted ON TOP of the
                research budget for overhead the turn did not choose. The
                caller sets it to the number of skills this deployment FORCES
                (``delivery: standard``): each one costs a ``use_skill`` call
                the question never asked for, and charging those to the research
                budget makes the effective research ceiling shrink every time
                the platform owner publishes another house skill — silently,
                and on exactly the long measurement chains that need the room.
                Default 0, so every existing caller is unchanged.
            callbacks: Optional list of LangGraph callbacks.
            tool_search: Optional retrieval-based tool narrowing. None (or a
                disabled settings object) leaves every path below exactly as it
                was: the full binding, the full prompt tool list, the full
                ToolNode.
            deferred_tool_loading: Optional OpenRouter server-side tool search.
                None (or disabled) binds tool schemas the way it always has.
                Orthogonal to ``tool_search``: that one decides WHICH tools are
                bound, this one decides whether their schemas travel with the
                request — a narrowed set is deferred exactly like a full one.
        """
        self.llm_provider = llm_provider
        self.tools = list(tools)
        self.max_llm_turns = max_llm_turns
        self.max_tool_iterations = max_tool_iterations
        self.reserved_tool_iterations = max(0, reserved_tool_iterations)
        self.callbacks = callbacks or []
        self.tool_search = tool_search if (tool_search is not None and tool_search.enabled) else None
        self.deferred_tool_loading = (
            deferred_tool_loading if (deferred_tool_loading is not None and deferred_tool_loading.enabled) else None
        )

        # Load prompts
        self.system_prompt = system_prompt or self._load_system_prompt()

        # Build tools info for prompt rendering
        self.tools_info = self._build_tools_info()

        # Source registry for citation verification (standalone mode fallback)
        self.source_registry = SourceRegistry()

        # Build the LangGraph
        self._graph = self._build_graph()

        # Bind tools once at construction rather than per iteration: `self.tools`
        # and the provider's role map are fixed for the life of this instance
        # (the per-org override path builds a NEW agent instance in register.py,
        # so the bound object cannot go stale). bind_tools converts every tool to
        # its OpenAI JSON schema, so hoisting it out of `agent_node` removes that
        # pure-CPU conversion from every tool-loop iteration. Request payloads are
        # byte-identical; only when the conversion happens changes.
        self._llm_with_tools = self._bind_research_tools(self.tools)

        # Conversational/meta turns use a NARROWER tool set: only interaction
        # tools (`remember`, `emit_card`), never the data-source search tools.
        # A greeting or a memory request must not be able to fire a web or
        # knowledge-base search — so on meta turns the model is neither OFFERED
        # the search tools (narrowed binding) nor able to EXECUTE one it
        # hallucinated (narrowed ToolNode returns an invalid-tool error instead
        # of running it). Computed lazily on the first meta turn (see
        # ``_ensure_meta_partition``) because the data-source registry that
        # classifies tools is not reliably populated at construction time.
        self._llm_with_meta_tools: Any = None
        self._meta_tool_names: set[str] | None = None
        self._meta_tool_node: ToolNode | None = None

        # Retrieval-based tool narrowing (off unless configured). The index is
        # built HERE, once, off the hot path: it is a pure in-process BM25 over
        # tool name + description, so construction touches no network and no
        # model, and a turn never pays for it. Nothing is built at all when the
        # feature is off, so a deployment that does not ask for it does not
        # even tokenize its tool descriptions.
        self._tool_search_index: ToolSearchIndex | None = ToolSearchIndex(self.tools) if self.tool_search else None
        # Selected-tool-set → bound LLM. Keyed by the SELECTION rather than the
        # query so two questions that retrieve the same tools share one
        # binding.
        self._narrowed_bindings: dict[frozenset[str], Any] = {}
        # Query string → selection, so the retrieval runs once per run instead
        # of once per tool-loop iteration (the query is built from human turns
        # only, which do not change while the loop appends AI/Tool messages).
        self._tool_search_selections: dict[str, Any] = {}

    def _load_system_prompt(self) -> str:
        """Load the default system prompt."""
        try:
            return load_prompt(AGENT_DIR / "prompts", "researcher")
        except Exception:
            logger.warning("Shallow research prompt not found, using inline default")
            return (
                "You are a research assistant. Answer the user's question using the "
                "available tools. Be concise and cite sources when possible.\n\n"
                "{% if tools %}Available tools: "
                "{{ tools | map(attribute='name') | join(', ') }}{% endif %}"
            )

    def _build_tools_info(self) -> list[dict[str, str]]:
        """Build tools information for prompt rendering."""
        tools_info = []
        for tool in self.tools:
            tool_name = getattr(tool, "name", str(tool))
            tool_desc = getattr(tool, "description", "No description available")
            tools_info.append({"name": tool_name, "description": tool_desc})
        return tools_info

    def _get_llm(self) -> BaseChatModel:
        """Get the LLM for shallow research."""
        return self.llm_provider.get(LLMRole.RESEARCHER)

    def _bind_research_tools(self, tools: Sequence[BaseTool]) -> Any:
        """Bind a RESEARCH-turn tool set, deferring the schemas when configured.

        The single binding seam for research turns — the construction-time full
        binding and every narrowed one go through it, so the deferral cannot
        apply to one and silently miss the other.

        Meta turns deliberately do NOT go through here. They bind only the
        interaction tools (``remember``, ``emit_card``), whose schemas are a few
        hundred characters, and OpenRouter's tool-search apparatus costs input
        tokens of its own (~600 measured on an otherwise empty request) — so
        deferring there would spend more than it withholds.
        """
        return bind_tools_deferred(
            self._get_llm(),
            list(tools),
            settings=self.deferred_tool_loading,
            parallel_tool_calls=True,
        )

    def _ensure_meta_partition(self) -> None:
        """Lazily compute the meta-turn tool partition (binding, names, ToolNode).

        Meta/conversational turns keep only interaction tools (``remember``,
        ``emit_card``); the data-source search tools are dropped so a greeting,
        small talk, or a ``remember`` request cannot trigger a web or
        knowledge-base search. ``_is_search_tool`` classifies each tool.

        Computed lazily and cached: the data-source registry that classifies
        tools is reliably populated by the time a turn runs (unlike at
        ``__init__``), and both the tool set and the registry mapping are fixed
        for the life of this instance (the per-org override path builds a new
        agent, so the cache cannot go stale). Guarded on ``_meta_tool_names``
        (not the bound LLM) so an empty interaction set still caches.

        Two artifacts back the two defenses:
        - ``_llm_with_meta_tools`` — the LLM bound to interaction tools only
          (bare LLM when there are none), so search is never OFFERED.
        - ``_meta_tool_node`` — a ToolNode over interaction tools only, so a
          hallucinated search call cannot EXECUTE (it returns an invalid-tool
          error). ``None`` when there are no interaction tools: then the meta
          binding offers no tools at all, the tools node is unreachable, and no
          ToolNode is needed (``ToolNode([])`` is not constructible anyway).
        """
        if self._meta_tool_names is not None:
            return
        meta_tools = [t for t in self.tools if not _is_search_tool(t.name)]
        self._meta_tool_names = {t.name for t in meta_tools}
        self._llm_with_meta_tools = (
            self._get_llm().bind_tools(meta_tools, parallel_tool_calls=True) if meta_tools else self._get_llm()
        )
        self._meta_tool_node = ToolNode(meta_tools) if meta_tools else None

    def _meta_tool_binding(self, tools_info: list[dict[str, str]]) -> tuple[Any, list[dict[str, str]]]:
        """LLM bound to interaction-only tools + the matching tool list, for meta turns.

        The deterministic complement to the prompt's meta output contract
        ("no tool calls"): the search tools are simply not offered, so a weak
        model cannot fire one against the instruction. The prompt's tool list
        is narrowed to match, so the model is not told it has search it cannot
        use.
        """
        self._ensure_meta_partition()
        meta_names = self._meta_tool_names or set()
        narrowed = [ti for ti in tools_info if ti.get("name") in meta_names]
        return self._llm_with_meta_tools, narrowed

    def _select_tools_for_query(self, messages: Sequence[Any]) -> Any:
        """Run (or replay) the tool-search retrieval for this run's question.

        Cached on the query string: the query is built from HUMAN turns only,
        so it is identical across every iteration of one run, and the retrieval
        runs once per run rather than once per LLM call. That stability also
        keeps the per-run ``cached_system_prompt`` honest — the prompt's tool
        list cannot disagree with the binding on iteration two.

        Returns ``None`` when the feature is off or the retrieval could not
        produce a decision; both mean "use the full set".
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
            selection = index.select(
                query_parts,
                top_k=settings.top_k,
                always_include=settings.always_include,
            )
        except Exception:
            # A ranking is a convenience; the tool set is the contract. Any
            # failure here falls back to binding everything, which is the
            # behaviour this agent had before tool search existed.
            logger.warning("[ToolSearch] retrieval failed; binding the full tool set", exc_info=True)
            return None

        # ADR-0045: the shape of the call, never the building. Tool names are
        # code identifiers from our own config — no user text, no model output,
        # no element names, no property values.
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

    def _research_tool_binding(
        self,
        messages: Sequence[Any],
        tools_info: list[dict[str, str]],
    ) -> tuple[Any, list[dict[str, str]]]:
        """LLM + prompt tool list for a RESEARCH turn, narrowed if configured.

        With tool search off this returns the prebuilt full binding and the
        caller's tool list untouched — the same two objects the agent used
        before this method existed.

        With it on, the narrowing happens HERE: around the LLM call, not inside
        the tool loop. The model is offered fewer tools; it is not asked to
        find them. No node is added to the graph, no message is added to the
        history, and ``tool_iterations`` is not touched, so a narrowed turn
        costs exactly what an unnarrowed one costs. That is the whole point —
        an agent that force-synthesizes after five tool calls cannot afford to
        spend one of them on discovery.

        The prompt's tool list is narrowed to match the binding, so the model
        is never told about a tool it has not been given.
        """
        selection = self._select_tools_for_query(messages)
        if selection is None or not selection.narrowed:
            return self._llm_with_tools, tools_info

        chosen = frozenset(selection.selected)
        bound = self._narrowed_bindings.get(chosen)
        if bound is None:
            narrowed_tools = [t for t in self.tools if t.name in chosen]
            if not narrowed_tools:
                # Belt and braces over ``select``'s own empty guard: an empty
                # binding would leave the model with no way to answer at all.
                return self._llm_with_tools, tools_info
            bound = self._bind_research_tools(narrowed_tools)
            if len(self._narrowed_bindings) >= _MAX_CACHED_BINDINGS:
                self._narrowed_bindings.clear()
            self._narrowed_bindings[chosen] = bound
        return bound, [ti for ti in tools_info if ti.get("name") in chosen]

    @property
    def tool_iteration_ceiling(self) -> int:
        """The tool-call count at which synthesis is forced.

        ``max_tool_iterations`` is the RESEARCH budget and stays exactly what
        the config's traced floors measure. The reserve on top of it pays for
        the ``use_skill`` calls the deployment forces on every research turn:
        without it, publishing a second standard skill takes an iteration away
        from every measurement chain in the product, and the only symptom is
        an answer written from declared values instead of measured ones.
        """
        return self.max_tool_iterations + self.reserved_tool_iterations

    def _build_graph(self) -> CompiledStateGraph:
        """Build the LangGraph StateGraph."""

        async def agent_node(state: ShallowResearchAgentState) -> dict[str, Any]:
            """Execute the agent with parallel call tracking and context anchoring."""
            messages = state.messages
            user_info = state.user_info
            iterations = state.tool_iterations

            tools_info = state.tools_info if state.tools_info else self.tools_info

            # On conversational/meta turns (requires_sources=False) offer ONLY
            # interaction tools (remember, emit_card) and drop the data-source
            # search tools, so a greeting or memory request cannot fire a web or
            # knowledge-base search. This also narrows the prompt's tool list
            # below so the model is not told it has search it must not use.
            #
            # Research turns take the full binding unless tool search is
            # configured, in which case the bound set is narrowed by retrieval
            # BEFORE this LLM call — no discovery turn, no extra node, no
            # change to the iteration budget.
            # A bound composer subject widens the binding: the meta partition
            # exists so a weak model cannot fire search at a greeting, but a
            # file the user is looking at is an explicit statement that a file
            # is in play. Stripping search from that turn is why "fass das
            # zusammen" over an open PDF could only ever answer "which file?".
            # `requires_sources` itself is untouched — the grounding contract
            # still follows the classified intent, not the subject.
            if state.requires_sources or state.focus_file_name:
                active_llm_with_tools, tools_info = self._research_tool_binding(messages, tools_info)
            else:
                active_llm_with_tools, tools_info = self._meta_tool_binding(tools_info)

            # Get available documents (user-uploaded files with summaries)
            available_documents = state.available_documents or []

            if available_documents:
                logger.debug("ShallowResearcher received %d available documents", len(available_documents))
                for doc in available_documents:
                    logger.debug("  - [file]: %s", "summary available" if doc.summary else "no summary")
            else:
                logger.debug("ShallowResearcher received no available documents")

            # Render the system prompt once per run and cache it on the state.
            # Every input below (system_prompt, tools_info, user_info,
            # current_datetime at DATE precision, available_documents,
            # project_context, the three norm blocks, requires_sources,
            # skills_block) is fixed for the life of a single run(), so the
            # rendered string is byte-identical across tool-loop iterations.
            # When the cache is populated we skip both the Jinja render AND the
            # norm-block computation (registry reads / applicability compute)
            # entirely. The inline path below stays as the fallback for the
            # first iteration and the graph-direct path (where the field is
            # None).
            rendered_system_prompt = state.cached_system_prompt
            if rendered_system_prompt is None:
                # Render system prompt with the current DATE (not time): a
                # second-precision timestamp made every rendered prompt unique,
                # defeating provider prompt caching across tool-loop iterations
                # and turns. Research needs the date, not the wall clock.
                current_datetime = datetime.now().strftime("%Y-%m-%d")
                # The source-hierarchy scaffolding (RIS Normenkatalog, norm doctrine,
                # parcel note) is only consulted on research turns. Meta/conversational
                # turns (requires_sources=False) never do source lookup, so skip both
                # the ~1400-token catalog render AND its underlying registry read/
                # applicability compute. Each block is truthiness-guarded in the
                # template, so passing None simply omits it. Research turns are
                # unchanged.
                _documents_dump = [doc.model_dump() for doc in available_documents]
                rendered_system_prompt = render_prompt_template(
                    self.system_prompt,
                    tools=tools_info,
                    user_info=user_info,
                    current_datetime=current_datetime,
                    available_documents=_documents_dump,
                    project_context=state.project_context,
                    focus_file_name=state.focus_file_name,
                    focus_shelf_label=_shelf_label(state.focus_shelf),
                    ris_catalog=render_block_for_prompt(state.project_context) if state.requires_sources else None,
                    norm_doctrine=doctrine_for(state.project_context) if state.requires_sources else None,
                    parcel_note=parcel_note(_documents_dump) if state.requires_sources else None,
                    # Deterministically suppress the control-marker mandate on
                    # conversational/meta turns instead of relying on model judgment.
                    requires_sources=state.requires_sources,
                    # Skills catalog + forced-skills block (already collated by
                    # the register layer; None renders no section).
                    skills_block=state.skills_block,
                )
                if os.environ.get("DEBUG_PROMPTS"):
                    logger.debug("Rendered system prompt:\n%s", rendered_system_prompt)

            system_message = SystemMessage(content=rendered_system_prompt)

            processed_history = list(messages)

            try:
                if iterations >= self.tool_iteration_ceiling:
                    # TRUNCATION. Not "the loop finished" — the turn ran out of
                    # budget mid-investigation and the answer below is written
                    # from whatever happened to be gathered by then. It is the
                    # worst failure this product has (see the traced floors in
                    # `configs/config_oib_openrouter.yml`) and until now the only
                    # trace it left was one warning with a single number in it,
                    # so nobody could answer "how often, and on which questions".
                    # `[CONFIDENCE:…]` does not cover it: that grades whether the
                    # claims are sourced, not whether the search was cut off.
                    #
                    # What is recorded is the SHAPE of the run — the ordered tool
                    # names — because that is what makes the population
                    # answerable ("every Lichteinfall chain truncates after
                    # find_elements") without logging the reader's question.
                    shape = _tool_call_shape(messages)
                    skill_calls = shape.count("use_skill")
                    logger.warning(
                        "Research budget exhausted: forcing synthesis "
                        "(ceiling=%d research_budget=%d reserved=%d spent=%d rounds=%d "
                        "skill_calls=%d shape=%s)",
                        self.tool_iteration_ceiling,
                        self.max_tool_iterations,
                        self.reserved_tool_iterations,
                        iterations,
                        _tool_call_rounds(messages),
                        skill_calls,
                        ">".join(shape) or "-",
                    )
                    emit_research_truncated(
                        ceiling=self.tool_iteration_ceiling,
                        research_budget=self.max_tool_iterations,
                        reserved=self.reserved_tool_iterations,
                        spent=iterations,
                        rounds=_tool_call_rounds(messages),
                        shape=shape,
                    )

                    # Anchor instruction at the end to combat "Loss in the Middle"
                    synthesis_anchor = HumanMessage(
                        content=(
                            "You have exhausted your research budget. Synthesize the final answer now "
                            "using the citations [1], [2] and the '## References' format. "
                            "Do not attempt any further tool calls."
                        )
                    )

                    full_messages = [system_message] + processed_history + [synthesis_anchor]
                    response = await self._get_llm().ainvoke(full_messages)
                    return {
                        "messages": [response],
                        "tool_iterations": iterations,
                        "cached_system_prompt": rendered_system_prompt,
                        # Carried out of the graph so the ANSWER can say it, not
                        # just the log. Everything above this line is for us;
                        # this field is the half the reader gets.
                        "research_truncated": True,
                    }

                full_messages = [system_message] + processed_history
                response = await active_llm_with_tools.ainvoke(full_messages)

                new_iterations = iterations
                if hasattr(response, "tool_calls") and response.tool_calls:
                    added_calls = len(response.tool_calls)
                    new_iterations += added_calls
                    logger.info("Added %d tool calls to budget. Total: %d", added_calls, new_iterations)
                    # The same fact, said to the USER instead of the log: which
                    # corpus is about to be read, and with what wording. One
                    # line per ROUND, not per call -- the model emits its calls
                    # in a parallel batch, and three lines in the same instant
                    # is a log stream, not a status.
                    try:
                        from aiq_agent.common.turn_status import emit_retrieval

                        emit_retrieval(response.tool_calls, round_index=iterations)
                    except Exception:  # noqa: BLE001 — transparency must never take a turn down
                        logger.debug("Retrieval status not emitted", exc_info=True)

                return {
                    "messages": [response],
                    "tool_iterations": new_iterations,
                    "cached_system_prompt": rendered_system_prompt,
                }

            except Exception as ex:
                logger.error("Failed in agent_node: %s", ex)
                raise

        builder = StateGraph(ShallowResearchAgentState)

        builder.set_entry_point("agent")

        tool_node = ToolNode(self.tools)

        # Per-agent allowlist: only tools this agent was loaded with are
        # candidates for source capture. Unlike the deep researcher — whose
        # tool set is evidence-only (inherited from the data source registry)
        # and therefore captures every allowlisted tool — the shallow agent's
        # tool list may also contain interaction tools such as `emit_card`
        # and `remember`. Those produce confirmations, not evidence, so the
        # data_source_registry acts as the second gate here: only tools that
        # resolve to a configured data source contribute citation sources.
        # Evidence-bearing MCP/utility tools should be declared under
        # `data_sources:` (group or exact tool) to become citable.
        source_tool_names = {t.name for t in self.tools}

        async def tool_node_with_source_capture(state: ShallowResearchAgentState) -> dict[str, Any]:
            """Execute tools and capture source URLs/citations for verification.

            Source capture is gated by two conditions:

            1. The tool must be in this agent's loaded tool set
               (``source_tool_names``).
            2. The tool must resolve to a configured data source via
               :func:`get_source_id_for_tool` (i.e. declared under
               ``data_sources`` in the workflow YAML).

            The second gate keeps interaction tools (`emit_card`, `remember`)
            and other non-evidence utilities out of the citation registry —
            their confirmations would otherwise register as tool-name
            citation keys via the non-URL fallback and could surface as bogus
            references on turns where no real research tool succeeded.

            On conversational/meta turns the search tools are not offered to
            the model, but a weak model can still hallucinate a call to one.
            Executing via the meta-scoped ToolNode (interaction tools only)
            makes that impossible: an unheld search call returns an
            invalid-tool error instead of running. Falls back to the full
            ToolNode on research turns (and when no interaction tool exists,
            where the meta path binds no tools and this node is unreachable).

            Tool search deliberately does NOT get the same second defense. The
            meta partition has two arms because firing a web search on a
            greeting is a POLICY violation: refusing to execute it is the
            correct outcome even though the refusal costs a turn. Tool-search
            narrowing is not a policy, it is a GUESS about relevance, and its
            one real failure mode is withholding the tool that would have
            answered. If the model calls a withheld tool anyway — it can, by
            copying a name out of an earlier turn's history — then the guess
            was wrong and the model is right. Executing it spends a turn and
            produces evidence; refusing it spends the same turn and produces an
            error, out of a budget of five. So research turns keep the full
            ToolNode, and execution stays the escape hatch that makes a
            recall-biased retrieval safe to run at all.
            """
            active_tool_node = tool_node
            if not state.requires_sources:
                self._ensure_meta_partition()
                if self._meta_tool_node is not None:
                    active_tool_node = self._meta_tool_node
            result = await active_tool_node.ainvoke(state)
            # Resolve registry at call time (not build time) so each request
            # writes to its own session-scoped registry when available.
            active_registry = get_session_registry() or self.source_registry
            # The second kind of grounding, captured on the same pass. STICKY:
            # OR-ed with what the loop already saw, so a later refused call
            # cannot un-measure an earlier successful one. Recorded BEFORE the
            # data-source filter below, because `ifc_measure` is deliberately not
            # a data source — it produces no citable passage, which is exactly
            # why the citation gate could never see it.
            measurement_grounded = state.answer_measurement_grounded
            for msg in result.get("messages", []):
                if isinstance(msg, ToolMessage) and msg.content:
                    tool_name = getattr(msg, "name", "") or ""
                    if tool_result_is_measurement(tool_name, str(msg.content)):
                        measurement_grounded = True
                    if tool_name not in source_tool_names:
                        continue
                    source_id = get_source_id_for_tool(tool_name)
                    if source_id is None:
                        logger.debug(
                            "[CitationRegistry] Skipping non-data-source tool result from %s",
                            tool_name,
                        )
                        continue
                    sources = extract_sources_from_tool_result(tool_name, str(msg.content), source_id=source_id)
                    for source in sources:
                        active_registry.add(source)
                    # The registry is cumulative across the conversation; the
                    # citation-health ledger needs THIS turn's retrieval.
                    record_turn_capture(sources)
                    if sources:
                        logger.info(
                            "[CitationRegistry] Captured %d source(s) from %s: %s",
                            len(sources),
                            tool_name,
                            [s.url or s.citation_key for s in sources],
                        )
            if measurement_grounded:
                return {**result, "answer_measurement_grounded": True}
            return result

        builder.add_node("agent", agent_node)
        builder.add_node("tools", tool_node_with_source_capture)

        builder.add_conditional_edges(
            "agent",
            tools_condition,
            {"tools": "tools", "__end__": "__end__"},
        )
        builder.add_edge("tools", "agent")

        return builder.compile()

    async def run(self, state: ShallowResearchAgentState) -> ShallowResearchAgentState:
        """
        Execute shallow research with tool-calling.

        Args:
            state: ShallowResearchAgentState with conversation messages.

        Returns:
            Updated state with response in messages.
        """
        # Resolve the registry for this request: session-scoped (conversation
        # mode) or a fresh per-run registry (standalone mode). The agent
        # instance is shared, so falling back to `self.source_registry` with a
        # clear() would let concurrent standalone runs (e.g. `nat eval`) wipe
        # each other's captured sources mid-run and cross-pollinate citations.
        # The fresh registry is bound via the ContextVar so the tool-capture
        # node (which resolves get_session_registry() at call time) sees it.
        registry_token = None
        session_registry = get_session_registry()
        if session_registry is not None:
            registry = session_registry
        else:
            registry = SourceRegistry()
            registry_token = set_session_registry(registry)

        recursion_limit = (self.max_llm_turns * 2) + 10
        config = {"recursion_limit": recursion_limit}
        if self.callbacks:
            config["callbacks"] = self.callbacks
        # What THIS turn's tool calls returned. The registry is cumulative
        # across the conversation (so a later turn can still cite an earlier
        # turn's document), which makes it the wrong denominator for a per-turn
        # citation-health row — see ``get_turn_captures``.
        turn_sources: list[SourceEntry] = []
        turn_capture_token = begin_turn_capture()
        # …and what THIS turn MEASURED. A separate log, not the registry, and
        # that separation is the safety property: `citation_grounded` is derived
        # from the registry's contents and is the only route to a surfaced
        # "high", while the normative brake is gated on its ABSENCE. A
        # measurement in there would hand an uncited legal verdict the evidence
        # of the basement measurement standing next to it, and would change what
        # an empty registry means. See `bim.measurement_sources`.
        turn_measurements: list[MeasurementSource] = []
        measurement_capture_token = begin_measurement_capture()
        try:
            result = await self._graph.ainvoke(state, config=config)
            turn_sources = get_turn_captures()
            turn_measurements = get_measurement_captures()
        finally:
            end_measurement_capture(measurement_capture_token)
            end_turn_capture(turn_capture_token)
            if registry_token is not None:
                reset_session_registry(registry_token)

        # Post-process: verify citations against source registry
        validated_result = dict(result)
        # Overconfidence guard signal for the chat node: True only when the
        # final answer carries at least one verified citation (see the
        # ``answer_citation_grounded`` field docstring). Conservative default.
        citation_grounded = False
        # Whether every QUOTED span in the final answer was found (fuzzily) in a
        # retrieved passage. Starts True and flips to False the moment a quote
        # cannot be verified, so the chat node caps confidence to "low" with the
        # ``quote_unverified`` reason. Fail-open default: no sources / no quotes
        # leaves it True.
        answer_quotes_verified = True
        # Same signal as a count, for the citation-health ledger (how MANY spans
        # failed, not just whether any did).
        unverified_quote_count = 0
        # Whether the answer asserts something normative without a verified
        # citation — the brake that stops measurement grounding from laundering a
        # legal claim (see ``shallow_researcher.grounding``). Computed below on
        # the final answer text; False when there is no answer message to read,
        # which is safe because measurement grounding alone never reaches "high".
        answer_normative_claim_uncited = False
        # Whether the single-source fallback below had to supply the citation
        # because nothing the model wrote survived verification. Grounded, but
        # not by the model's own choice — recorded as its own ledger event.
        citation_fallback_used = False
        # Sources the model actually cited in THIS turn's answer (its own
        # relevance decision), resolved from ``verification.valid_citations``.
        # These — NOT the cumulative session registry — become the turn's
        # "Belegt durch" chips, so a greeting/meta turn never re-emits a prior
        # turn's RIS sources. Defaults to empty; populated in the verification
        # block below where ``verification`` is in scope.
        relevant_sources: list[SourceEntry] = []
        # ``id(entry)`` → the ``[N]`` citation label that entry carries in the
        # answer prose. Only the verifier knows this binding, so it travels on
        # the wire; the FE renders one numbered provenance block from it instead
        # of duplicating the written source list next to an unnumbered chip row.
        citation_numbers: dict[int, int] = {}
        # Control-marker signals extracted from the model's answer. Populated
        # below and carried as STRUCTURED state so the chat node does not have to
        # re-parse the answer string (which also leaked the markers downstream).
        # ``escalation_requested`` stays None until extraction actually runs on a
        # real answer message; the chat node reads None as "fall back to string
        # detection". A bool means extraction ran and the value is authoritative.
        escalation_requested: bool | None = None
        answer_confidence_marker: str | None = None
        answer_confidence_marker_reason: str | None = None
        # Transparency summary of any citations dropped by verify_citations this
        # turn. Populated in the verification block below; stays None when the
        # registry was empty or nothing was removed, so the field stays absent.
        citations_removed_summary: dict[str, Any] | None = None
        # The raw drop records behind that summary. The ledger needs per-reason
        # COUNTS (the wire summary only carries deduplicated reason keys).
        removed_citations_detail: list[dict[str, Any]] = []
        messages_list = validated_result.get("messages") or []
        # Select the answer message with the SAME selector the chat node uses:
        # the last AIMessage that is not a tool call. Marker extraction, citation
        # verification, sanitization, and the write-back all target THIS message,
        # leaving any other messages (tool calls/results) untouched.
        answer_index = next(
            (
                i
                for i in range(len(messages_list) - 1, -1, -1)
                if isinstance(messages_list[i], AIMessage) and not messages_list[i].tool_calls
            ),
            None,
        )
        if answer_index is not None:
            answer_msg = messages_list[answer_index]
            if hasattr(answer_msg, "content") and answer_msg.content:
                content = content_to_text(answer_msg.content)

                # Step 0: extract AND strip both control markers up front, before
                # citation verification, before emit_final_report, and before the
                # cleaned content is written back into the returned messages — so
                # neither marker can leak onto job/streaming callbacks or to the
                # frontend. The detected signals travel as structured fields.
                #
                # First strip any DeepSeek DSML tool-call machinery the model
                # leaked as literal text (and salvage a leaked emit_card into the
                # card registry) so the markers below and the citation pipeline
                # operate on clean prose.
                content = strip_and_salvage_dsml_tool_calls(content)
                content, escalation_requested = detect_and_strip_escalation_marker(content)
                content, answer_confidence_marker, answer_confidence_marker_reason = detect_and_strip_confidence_marker(
                    content
                )

                # Step 1: verify citations against registry
                if registry.all_sources():
                    # The blankest stretch of the turn: the answer text exists
                    # but nothing may be shown until every citation in it has
                    # been checked against what was actually retrieved. Saying
                    # so is not filler -- it is the product's trust proposition
                    # stated at the moment it is being honoured.
                    try:
                        from aiq_agent.common.turn_status import emit_citation_check

                        emit_citation_check(source_count=len(registry.all_sources()))
                    except Exception:  # noqa: BLE001 — transparency must never take a turn down
                        logger.debug("Citation-check status not emitted", exc_info=True)
                    # Pass the writer-facing source list (ordered as the model
                    # saw them, mirroring the deep researcher's call) so that an
                    # answer with inline [N] citations but no Sources section can
                    # have one synthesized instead of the citations being dropped.
                    verification = verify_citations(content, registry, reference_sources=registry.all_sources())
                    logger.debug(
                        "Shallow researcher: citation verification complete — "
                        "%d valid, %d removed, %d sources in registry",
                        len(verification.valid_citations),
                        len(verification.removed_citations),
                        len(registry.all_sources()),
                    )
                    content = verification.verified_report
                    citations_removed_summary = _summarize_removed_citations(verification.removed_citations)
                    removed_citations_detail = list(verification.removed_citations)
                    # Quote verification: verify_citations only proves a cited
                    # SOURCE is real, not that a QUOTED sentence actually appears
                    # in it. Catch the weak model's "real section, fabricated
                    # quote" pattern by checking each quoted span against the
                    # retrieved passage text. Fail-open: annotate inline, never
                    # strip; a single unverified quote caps this answer's
                    # confidence (see answer_quotes_verified).
                    unverified_quotes = verify_quoted_spans(content, registry)
                    if unverified_quotes:
                        content = annotate_unverified_quotes(content, unverified_quotes)
                        answer_quotes_verified = False
                        unverified_quote_count = len(unverified_quotes)
                        logger.info(
                            "Shallow researcher: %d quoted span(s) not verbatim in any retrieved "
                            "passage; annotated inline and capping confidence",
                            len(unverified_quotes),
                        )
                    sources = registry.all_sources()
                    if verification.valid_citations:
                        # Verification kept at least one grounded citation.
                        citation_grounded = True
                        # Resolve each surviving citation back to its registry
                        # SourceEntry — these are the sources the model actually
                        # cited in THIS answer, and only these become chips.
                        # Dedup while preserving first-cited order. Gated on
                        # requires_sources so a meta turn that reaches this
                        # branch only because the cumulative registry carried
                        # prior-turn sources still emits no chips.
                        if state.requires_sources:
                            seen_ids: set[int] = set()
                            for citation in verification.valid_citations:
                                entry: SourceEntry | None = None
                                if citation.get("citation_key"):
                                    entry = registry.entry_for_citation_key(citation["citation_key"])
                                elif citation.get("url"):
                                    entry = registry.entry_for_url(citation["url"])
                                if entry is not None and id(entry) not in seen_ids:
                                    seen_ids.add(id(entry))
                                    relevant_sources.append(entry)
                                    # Keep the [N] label this source carries in the
                                    # prose. The binding exists only here (the
                                    # verifier resolved it); without it the FE
                                    # cannot fold the written "## Sources" list
                                    # and the chip row into one provenance block.
                                    number = citation.get("number")
                                    if isinstance(number, int):
                                        citation_numbers[id(entry)] = number
                    elif len(sources) == 1:
                        # No model citation survived, but exactly one registry
                        # source is available: append it as the single minimal
                        # citation, which grounds the answer in a real source.
                        # That one source IS the relevant one for this turn — but
                        # only surface it as a chip on a research turn.
                        content = _append_minimal_citation(content, sources[0])
                        citation_grounded = True
                        citation_fallback_used = True
                        if state.requires_sources:
                            relevant_sources = [sources[0]]
                            # ``_append_minimal_citation`` always writes "[1]".
                            citation_numbers = {id(sources[0]): 1}
                elif state.requires_sources:
                    # Distinguish "retrieval genuinely failed" from "the agent
                    # answered from conversation/project context without ever
                    # querying a data source". Only the former is an error: when
                    # no data-source tool was attempted there was nothing to
                    # cite, and discarding a substantive answer would replace it
                    # with a misleading "search tools failed" message (typical
                    # for conversational turns misrouted as research).
                    attempted_source_lookup = any(
                        isinstance(msg, ToolMessage)
                        and get_source_id_for_tool(getattr(msg, "name", "") or "") is not None
                        for msg in validated_result["messages"]
                    )
                    if attempted_source_lookup:
                        from aiq_agent.common.tool_validation import validate_tool_availability

                        _, available_count, unavailable = validate_tool_availability(
                            self.tools,
                            research_type="shallow research",
                            enable_logging=False,
                        )
                        # Record the hardest citation failure there is — the turn
                        # captured nothing to cite — before it becomes an error
                        # the user sees, so it lands on the platform dashboard
                        # beside the softer defects instead of only in the logs.
                        citation_events.record_empty_registry(
                            agent="shallow",
                            unavailable_tools=unavailable,
                            available_count=available_count,
                        )
                        raise EmptySourceRegistryError(
                            "shallow research",
                            unavailable_tools=unavailable,
                            available_count=available_count,
                        )
                    logger.warning(
                        "Shallow researcher: research turn answered without querying any "
                        "data-source tool; returning the answer without citation verification",
                    )
                else:
                    # Conversational/meta turn: no sources are expected, so an
                    # empty registry is NOT a failure. Return the assistant's
                    # answer as-is — there is nothing to cite or verify. The
                    # research-only "no sources captured" guard must not apply to
                    # persona/chit-chat turns; the orchestrator signals these via
                    # requires_sources=False (derived from intent == "meta").
                    logger.debug(
                        "Shallow researcher: conversational turn (requires_sources=False); "
                        "returning answer without citation verification",
                    )

                # Step 2: sanitize report (strip body URLs, shortened URLs, unsafe URLs)
                sanitization = sanitize_report(content)
                content = sanitization.sanitized_report
                # Sanitization closes the gaps that verify_citations' removals
                # left in the [N] sequence, so the numbers captured above (which
                # the model wrote) can be stale by the time the reader sees the
                # answer. Remap them or a chip is labelled [3] while the prose
                # that points at it now says [2] — and the inline marker's anchor
                # scrolls to a row that does not exist.
                if sanitization.renumber_map:
                    citation_numbers = {
                        entry_id: sanitization.renumber_map.get(number, number)
                        for entry_id, number in citation_numbers.items()
                    }

                # Emit verified/sanitized report so the frontend shows the
                # cleaned version (overwrites the raw draft auto-emitted
                # during ainvoke).
                for cb in self.callbacks:
                    if hasattr(cb, "emit_final_report"):
                        cb.emit_final_report(content)
                        break

                # The anti-laundering brake, read off the FINAL user-visible text
                # (post-verification, post-sanitization) so it judges the answer
                # the reader actually gets. Only meaningful when the citation gate
                # already failed: with no verified citation, "mentions the law"
                # and "asserts the law without support" are the same thing. A
                # measurement grounds the measurement — it must not carry
                # „…und erfüllt damit OIB 4 Punkt 2.1" out at "medium".
                #
                # The single-source FALLBACK does not count as the citation that
                # switches this brake off. It fires when nothing the model cited
                # survived verification, and the source it appends comes from the
                # cumulative session registry — one Bauordnung link captured two
                # turns ago was enough to disarm the brake AND to hand the whole
                # mixed answer the model's own "high", with that unrelated link
                # attached to the verdict.
                model_cited_grounding = citation_grounded and not citation_fallback_used
                answer_normative_claim_uncited = not model_cited_grounding and answer_mentions_normative_claim(
                    _prose_without_references(content)
                )

                if hasattr(answer_msg, "model_copy"):
                    messages_list[answer_index] = answer_msg.model_copy(update={"content": content})
                else:
                    messages_list[answer_index] = type(answer_msg)(content=content)

        # Carry the grounding signal to the chat node's overconfidence guard.
        validated_result["answer_citation_grounded"] = citation_grounded
        # The second kind of grounding and its brake. ``answer_measurement_grounded``
        # was written by the tools node (it is the only place that sees the raw
        # tool results); it is echoed here rather than recomputed so both signals
        # reach the chat node by the same path as ``answer_citation_grounded``.
        measurement_grounded = bool(validated_result.get("answer_measurement_grounded", False))
        validated_result["answer_measurement_grounded"] = measurement_grounded
        validated_result["answer_normative_claim_uncited"] = answer_normative_claim_uncited
        # …and WHICH citation grounded it. The guard needs the difference between
        # "the model cited a source and the verifier resolved it" and "we
        # attached the one source in the registry because nothing else survived".
        validated_result["answer_citation_fallback_used"] = citation_fallback_used
        # Carry the quote-verification signal too: False iff a quoted span could
        # not be verified against a retrieved passage this turn. The chat node
        # composes it with grounding to cap confidence (reason quote_unverified).
        validated_result["answer_quotes_verified"] = answer_quotes_verified
        # Carry the extracted control-marker signals as structured state. A
        # non-None ``escalation_requested`` tells the chat node these ran on a
        # real answer message and are authoritative (else it re-parses text).
        validated_result["escalation_requested"] = escalation_requested
        validated_result["answer_confidence_marker"] = answer_confidence_marker
        validated_result["answer_confidence_marker_reason"] = answer_confidence_marker_reason
        # Wire-ready sources for Belegt-durch chips / PDF open (file/page/collection).
        # Emit ONLY the sources the model cited in THIS turn's answer
        # (``relevant_sources``), never the cumulative session registry — a
        # conversational/meta turn cites nothing, so it emits no chips instead
        # of leaking the previous turn's RIS sources.
        # Serialize per-entry so a single malformed source can't zero out the
        # whole turn's chips — a bad entry is skipped, the rest still render.
        from aiq_agent.common.citation_verification import source_entry_to_wire

        wire_sources: list[dict[str, Any]] = []
        for entry in relevant_sources:
            try:
                wire_sources.append(source_entry_to_wire(entry, number=citation_numbers.get(id(entry))))
            except Exception:
                logger.warning(
                    "Skipping source that failed wire serialization: %s",
                    entry.url or entry.citation_key,
                    exc_info=True,
                )
        # This turn's MEASUREMENTS, appended to the same wire so the chips, the
        # Herleitung fan-out and the report pick them up off their coarse
        # ``kind`` exactly as they pick up a retrieved passage — which is the
        # whole reason ``messung`` is a source kind and not a bespoke payload.
        #
        # Appended AFTER ``wire_sources`` is closed and read for the ledger
        # below, and kept in its own variable, because the two are different
        # claims. ``cited_count`` is measured against the turn's RETRIEVAL, and
        # a measurement counted there would report a cited source out of zero
        # retrieved ones — the same category error, one layer down, that putting
        # a measurement in the registry would be.
        measurement_wire = measurement_sources_to_wire(turn_measurements)
        validated_result["verified_sources"] = (wire_sources + measurement_wire) or None
        # Transparency: only present when ≥1 citation was actually removed.
        if citations_removed_summary is not None:
            validated_result["citations_removed"] = citations_removed_summary

        # Citation-health ledger: one batch per RESEARCH turn (a meta turn has
        # nothing to cite, so counting it would inflate the clean rate). Gated
        # on an answer message actually having been verified. Best-effort by
        # construction — ``record_turn`` swallows everything.
        if state.requires_sources and answer_index is not None:
            # THIS turn's retrieval, not the cumulative conversation registry:
            # the ledger's source_count is the denominator that cited_count is
            # measured against, and cited_count has always been per-turn.
            registry_sources = turn_sources
            citation_events.record_turn(
                agent="shallow",
                source_count=len(registry_sources),
                cited_count=len(wire_sources),
                removed_citations=removed_citations_detail,
                unverified_quote_count=unverified_quote_count,
                grounded=citation_grounded,
                fallback_used=citation_fallback_used,
                confidence_capped_reason=answer_confidence_capped_reason(
                    answer_confidence_marker,
                    citation_grounded,
                    answer_quotes_verified,
                    measurement_grounded=measurement_grounded,
                    normative_claim_uncited=answer_normative_claim_uncited,
                    citation_fallback_used=citation_fallback_used,
                ),
                source_origins=[source_origin_token(entry).strip("[]").lower() or None for entry in registry_sources],
                source_lanes=[source.get("lane") for source in wire_sources],
                source_tools=[entry.tool_name or None for entry in registry_sources],
                # Source IDENTITIES (URL / document key) — never answer prose.
                # They turn the platform export from "3 citations removed" into
                # "these three documents were cited but never retrieved".
                retrieved_source_labels=[label for label in map(source_label, registry_sources) if label],
                cited_source_labels=[
                    label for label in ((s.get("citation_key") or s.get("url")) for s in wire_sources) if label
                ],
            )

        return ShallowResearchAgentState.model_validate(validated_result)

    @property
    def graph(self) -> CompiledStateGraph:
        """Get the compiled LangGraph for direct access."""
        return self._graph
