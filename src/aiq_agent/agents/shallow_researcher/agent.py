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

from aiq_agent.common import get_source_id_for_tool
from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common.citation_verification import EmptySourceRegistryError
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import get_session_registry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import sanitize_report
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.citation_verification import source_origin_token
from aiq_agent.common.citation_verification import verify_citations
from aiq_agent.common.norm_registry import doctrine_for
from aiq_agent.common.norm_registry import parcel_note
from aiq_agent.common.norm_registry import render_block_for_prompt

from ...common import LLMProvider
from ...common import LLMRole
from .dsml import strip_and_salvage_dsml_tool_calls
from .markers import detect_and_strip_confidence_marker
from .markers import detect_and_strip_escalation_marker
from .models import ShallowResearchAgentState

logger = logging.getLogger(__name__)


# Path to this agent's directory (for loading prompts)
AGENT_DIR = Path(__file__).parent


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


def _strip_tool_calls(message: AIMessage) -> AIMessage:
    """Return a copy of ``message`` with every tool call removed, content kept.

    Belt-and-suspenders guard for the forced-synthesis call: that request already
    forbids tool calls via ``tool_choice="none"``, but if the model emits them
    anyway they must not reach ``tools_condition`` — it would route back to the
    tools node and break the tool-budget guarantee. Stripping the tool calls lets
    the graph terminate on the synthesized content while preserving message
    metadata.
    """
    additional_kwargs = dict(getattr(message, "additional_kwargs", {}) or {})
    additional_kwargs.pop("tool_calls", None)
    return message.model_copy(
        update={
            "tool_calls": [],
            "invalid_tool_calls": [],
            "additional_kwargs": additional_kwargs,
        }
    )


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
        callbacks: list[Any] | None = None,
    ) -> None:
        """
        Initialize the shallow researcher agent.

        Args:
            llm_provider: LLMProvider for role-based LLM access.
            tools: Sequence of LangChain tools for research.
            system_prompt: Optional custom system prompt. If not provided,
                          loads system.j2 from prompts.
            max_llm_turns: Maximum LLM interaction turns (default 10).
            max_tool_iterations: Maximum tool-calling iterations before forcing
                                synthesis (default 5).
            callbacks: Optional list of LangGraph callbacks.
        """
        self.llm_provider = llm_provider
        self.tools = list(tools)
        self.max_llm_turns = max_llm_turns
        self.max_tool_iterations = max_tool_iterations
        self.callbacks = callbacks or []

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
        self._llm_with_tools = self._get_llm().bind_tools(self.tools, parallel_tool_calls=True)

        # Second binding for the forced-synthesis (budget-exhausted) call. It
        # carries the SAME tools array with the SAME parallel_tool_calls flag, so
        # the serialized `tools` field is byte-identical to the loop iterations
        # and the provider's cacheable prefix (tools + system + messages) stays
        # matched — the previous unbound `_get_llm().ainvoke(...)` dropped the
        # tools array entirely and busted the cache for that terminal call.
        # `tool_choice="none"` forbids new tool calls while preserving the array
        # (verified against langchain-openai: "none" passes through unchanged as
        # the OpenAI tool_choice value, not folded into a tool object).
        self._llm_with_tools_no_calls = self._get_llm().bind_tools(
            self.tools, parallel_tool_calls=True, tool_choice="none"
        )

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

    def _build_graph(self) -> CompiledStateGraph:
        """Build the LangGraph StateGraph."""

        async def agent_node(state: ShallowResearchAgentState) -> dict[str, Any]:
            """Execute the agent with parallel call tracking and context anchoring."""
            messages = state.messages
            user_info = state.user_info
            iterations = state.tool_iterations

            tools_info = state.tools_info if state.tools_info else self.tools_info

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
            # project_context, the three norm blocks, requires_sources) is fixed
            # for the life of a single run(), so the rendered string is
            # byte-identical across tool-loop iterations. When the cache is
            # populated we skip both the Jinja render AND the norm-block
            # computation (registry reads / applicability compute) entirely. The
            # inline path below stays as the fallback for the first iteration and
            # the graph-direct path (where the field is None).
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
                    ris_catalog=render_block_for_prompt(state.project_context) if state.requires_sources else None,
                    norm_doctrine=doctrine_for(state.project_context) if state.requires_sources else None,
                    parcel_note=parcel_note(_documents_dump) if state.requires_sources else None,
                    # Deterministically suppress the control-marker mandate on
                    # conversational/meta turns instead of relying on model judgment.
                    requires_sources=state.requires_sources,
                )
                if os.environ.get("DEBUG_PROMPTS"):
                    logger.debug("Rendered system prompt:\n%s", rendered_system_prompt)

            system_message = SystemMessage(content=rendered_system_prompt)

            processed_history = list(messages)

            try:
                if iterations >= self.max_tool_iterations:
                    logger.warning("Max iterations (%d) reached. Forcing synthesis.", iterations)

                    # Anchor instruction at the end to combat "Loss in the Middle"
                    synthesis_anchor = HumanMessage(
                        content=(
                            "You have exhausted your research budget. Synthesize the final answer now "
                            "using the citations [1], [2] and the '## References' format. "
                            "Do not attempt any further tool calls."
                        )
                    )

                    full_messages = [system_message] + processed_history + [synthesis_anchor]
                    # Use the tools-bound-but-forbidden instance so the request's
                    # serialized `tools` array stays byte-identical to the loop
                    # iterations (preserving the provider's cacheable prefix)
                    # while `tool_choice="none"` forbids further tool calls.
                    response = await self._llm_with_tools_no_calls.ainvoke(full_messages)
                    # Belt-and-suspenders: if the model emits tool_calls anyway,
                    # strip them so `tools_condition` routes to __end__ instead of
                    # back to the tools node — the budget is exhausted and the
                    # graph must terminate here.
                    if getattr(response, "tool_calls", None):
                        logger.warning(
                            "Forced-synthesis response carried %d tool call(s) despite tool_choice='none'; "
                            "stripping them to terminate the graph.",
                            len(response.tool_calls),
                        )
                        response = _strip_tool_calls(response)
                    return {
                        "messages": [response],
                        "tool_iterations": iterations,
                        "cached_system_prompt": rendered_system_prompt,
                    }

                llm_with_tools = self._llm_with_tools
                full_messages = [system_message] + processed_history
                response = await llm_with_tools.ainvoke(full_messages)

                new_iterations = iterations
                if hasattr(response, "tool_calls") and response.tool_calls:
                    added_calls = len(response.tool_calls)
                    new_iterations += added_calls
                    logger.info("Added %d tool calls to budget. Total: %d", added_calls, new_iterations)

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
            """
            result = await tool_node.ainvoke(state)
            # Resolve registry at call time (not build time) so each request
            # writes to its own session-scoped registry when available.
            active_registry = get_session_registry() or self.source_registry
            for msg in result.get("messages", []):
                if isinstance(msg, ToolMessage) and msg.content:
                    tool_name = getattr(msg, "name", "") or ""
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
                    if sources:
                        logger.info(
                            "[CitationRegistry] Captured %d source(s) from %s: %s",
                            len(sources),
                            tool_name,
                            [s.url or s.citation_key for s in sources],
                        )
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
        try:
            result = await self._graph.ainvoke(state, config=config)
        finally:
            if registry_token is not None:
                reset_session_registry(registry_token)

        # Post-process: verify citations against source registry
        validated_result = dict(result)
        # Overconfidence guard signal for the chat node: True only when the
        # final answer carries at least one verified citation (see the
        # ``answer_citation_grounded`` field docstring). Conservative default.
        citation_grounded = False
        # Sources the model actually cited in THIS turn's answer (its own
        # relevance decision), resolved from ``verification.valid_citations``.
        # These — NOT the cumulative session registry — become the turn's
        # "Belegt durch" chips, so a greeting/meta turn never re-emits a prior
        # turn's RIS sources. Defaults to empty; populated in the verification
        # block below where ``verification`` is in scope.
        relevant_sources: list[SourceEntry] = []
        # Control-marker signals extracted from the model's answer. Populated
        # below and carried as STRUCTURED state so the chat node does not have to
        # re-parse the answer string (which also leaked the markers downstream).
        # ``escalation_requested`` stays None until extraction actually runs on a
        # real answer message; the chat node reads None as "fall back to string
        # detection". A bool means extraction ran and the value is authoritative.
        escalation_requested: bool | None = None
        answer_confidence_marker: str | None = None
        # Transparency summary of any citations dropped by verify_citations this
        # turn. Populated in the verification block below; stays None when the
        # registry was empty or nothing was removed, so the field stays absent.
        citations_removed_summary: dict[str, Any] | None = None
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
                content = str(answer_msg.content)

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
                content, answer_confidence_marker = detect_and_strip_confidence_marker(content)

                # Step 1: verify citations against registry
                if registry.all_sources():
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
                    elif len(sources) == 1:
                        # No model citation survived, but exactly one registry
                        # source is available: append it as the single minimal
                        # citation, which grounds the answer in a real source.
                        # That one source IS the relevant one for this turn — but
                        # only surface it as a chip on a research turn.
                        content = _append_minimal_citation(content, sources[0])
                        citation_grounded = True
                        if state.requires_sources:
                            relevant_sources = [sources[0]]
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

                # Emit verified/sanitized report so the frontend shows the
                # cleaned version (overwrites the raw draft auto-emitted
                # during ainvoke).
                for cb in self.callbacks:
                    if hasattr(cb, "emit_final_report"):
                        cb.emit_final_report(content)
                        break

                if hasattr(answer_msg, "model_copy"):
                    messages_list[answer_index] = answer_msg.model_copy(update={"content": content})
                else:
                    messages_list[answer_index] = type(answer_msg)(content=content)

        # Carry the grounding signal to the chat node's overconfidence guard.
        validated_result["answer_citation_grounded"] = citation_grounded
        # Carry the extracted control-marker signals as structured state. A
        # non-None ``escalation_requested`` tells the chat node these ran on a
        # real answer message and are authoritative (else it re-parses text).
        validated_result["escalation_requested"] = escalation_requested
        validated_result["answer_confidence_marker"] = answer_confidence_marker
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
                wire_sources.append(source_entry_to_wire(entry))
            except Exception:
                logger.warning(
                    "Skipping source that failed wire serialization: %s",
                    entry.url or entry.citation_key,
                    exc_info=True,
                )
        validated_result["verified_sources"] = wire_sources or None
        # Transparency: only present when ≥1 citation was actually removed.
        if citations_removed_summary is not None:
            validated_result["citations_removed"] = citations_removed_summary

        return ShallowResearchAgentState.model_validate(validated_result)

    @property
    def graph(self) -> CompiledStateGraph:
        """Get the compiled LangGraph for direct access."""
        return self._graph
