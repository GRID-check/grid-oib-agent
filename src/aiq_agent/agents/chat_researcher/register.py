"""NAT register function for chat researcher agent."""

import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import Annotated
from typing import Any

import aiofiles
from langchain_core.messages import HumanMessage
from pydantic import Field

from aiq_agent.cards.registry import get_or_create_card_registry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common import VerboseTraceCallback
from aiq_agent.common import _create_chat_response
from aiq_agent.common import format_data_source_tools
from aiq_agent.common import get_checkpointer
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import is_verbose
from aiq_agent.common.citation_verification import get_or_create_session_registry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.nat_converters import ensure_registered as _ensure_nat_converters_registered
from aiq_agent.conversation_context import register_context_appender
from aiq_agent.observability.otel_header_redaction_exporter import (
    ensure_registered as _ensure_otel_redaction_registered,
)
from aiq_agent.observability.otlp_logging_method import ensure_registered as _ensure_otlp_logging_registered
from aiq_agent.project_context import get_memory_reflection_enabled_from_context
from nat.builder.builder import Builder
from nat.builder.context import Context
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.api_server import ChatResponse
from nat.data_models.api_server import ChatResponseChunk
from nat.data_models.component_ref import FunctionGroupRef
from nat.data_models.component_ref import FunctionRef
from nat.data_models.component_ref import LLMRef
from nat.data_models.function import FunctionBaseConfig
from nat.data_models.streaming import Streaming

from .models import ChatResearcherState
from .utils import extract_turn_inputs

logger = logging.getLogger(__name__)

_ensure_otel_redaction_registered()
_ensure_otlp_logging_registered()
# Register a direct ChatResponse -> ChatResponseChunk converter so Grid cards
# (attached as an extra field on the response) survive NAT's CHAT_STREAM
# serialization instead of being dropped by the lossy indirect str conversion.
_ensure_nat_converters_registered()

# Canned error/empty answers that must never trigger a memory-reflection pass.
_REFLECTION_NON_ANSWERS = (
    "No response generated.",
    "An error occurred",
    "The search tools did not return any results",
    "I searched the available sources but couldn't retrieve anything usable",
)


def _reflection_answer_is_substantive(result: object, answer_text: str) -> bool:
    """Whether a turn's answer is worth running memory reflection on.

    Skips meta/conversational and error turns (by classified intent) and the
    canned insufficiency/error answers — none carry a durable, project-specific
    finding, and reflecting on them only risks spurious writes.
    """
    from .agent import matches_escalation_keywords

    text = (answer_text or "").strip()
    if not text or any(text.startswith(prefix) for prefix in _REFLECTION_NON_ANSWERS):
        return False
    if matches_escalation_keywords(text):
        return False

    user_intent = getattr(result, "user_intent", None)
    if user_intent is None and isinstance(result, dict):
        user_intent = result.get("user_intent")
    intent = getattr(user_intent, "intent", None)
    if intent in {"meta", "error", "out_of_scope"}:
        return False
    return True


def _admission_organization_id() -> str | None:
    """Tenant this turn is admitted against (ADR-0040 L3), or None.

    Read from the signed request-context envelope rather than threaded down
    through the turn: the organization is needed at exactly one point, and the
    envelope is the authority for it. Degrades to None — the turn is then
    admitted against the global pool only — because a missing tenant must cost
    a coarser limit, never a failed answer.
    """
    try:
        from aiq_agent.project_context import GridRequestContext

        return GridRequestContext.from_context().organization_id
    except Exception:
        logger.debug("No organization in request context for turn admission", exc_info=True)
        return None


def _available_documents_limit() -> int:
    """Top-N cap for the per-turn ``available_documents`` prompt block.

    ``get_all_async`` does an unbounded ``SELECT`` of the project's document
    summaries, and every chat turn injects the full list into ~5 prompt
    templates (shallow/clarifier live, deep on escalation) — so per-turn LLM
    cost grew linearly with the corpus, paid even on chit-chat. Cap it.
    ``GRID_AVAILABLE_DOCUMENTS_MAX`` (default 50) tunes it; 0/negative disables.
    """
    import os

    try:
        return int(os.environ.get("GRID_AVAILABLE_DOCUMENTS_MAX", "50"))
    except (TypeError, ValueError):
        return 50


def _as_scoped_collection(item):
    """Normalize a scope entry to ``ScopedCollection``.

    Bare strings (legacy tests / names-only callers) state no shelf — unknown,
    never guessed from the collection-id prefix (ADR-0047).
    """
    from aiq_agent.knowledge.scoping import ScopedCollection

    if isinstance(item, ScopedCollection):
        return item
    if isinstance(item, str) and item.strip():
        return ScopedCollection(item.strip())
    return None


async def _aggregate_documents_across_collections(collections, fetch_one, max_documents=None):
    """Concurrently load document summaries for each collection and merge them.

    ``fetch_one`` is an async callable ``fetch_one(collection) -> list`` (its
    per-collection round-trip). The reads run concurrently instead of one at a
    time. Each row is stamped with the collection it came from and the shelf
    the signed scope stated (unknown when the caller passed a bare name).

    Identity is ``(collection, file_name)`` — the same filename on the
    Büroarchiv and in a project is two documents (ADR-0047). The cap
    (``max_documents`` or ``GRID_AVAILABLE_DOCUMENTS_MAX``) keeps user-shelf
    files first so the OIB corpus cannot evict the archive. ``0``/negative
    disables the cap.

    Fail-open per collection: if ``fetch_one`` raises for a collection, that
    collection contributes an empty list (matching the old ``continue``) rather
    than failing the whole aggregation.
    """
    from aiq_agent.knowledge.inventory import allocate_inventory
    from aiq_agent.knowledge.inventory import stamp_document

    scoped = [entry for item in collections if (entry := _as_scoped_collection(item)) is not None]

    async def _guarded(entry):
        try:
            return entry, await fetch_one(entry.collection)
        except Exception as e:
            logger.debug("No document summaries for collection %s: %s", entry.collection, e)
            return entry, []

    # gather preserves input order, so stamping still follows the scope order.
    per_collection = await asyncio.gather(*(_guarded(entry) for entry in scoped))

    aggregated = []
    for entry, docs in per_collection:
        for doc in docs or []:
            aggregated.append(stamp_document(doc, collection=entry.collection, shelf=entry.shelf))

    limit = _available_documents_limit() if max_documents is None else max_documents
    before = len(aggregated)
    aggregated = allocate_inventory(aggregated, limit)
    if limit and limit > 0 and before > len(aggregated):
        logger.info(
            "Capping available_documents from %d to %d (GRID_AVAILABLE_DOCUMENTS_MAX)",
            before,
            len(aggregated),
        )
    return aggregated


# --- Final-answer streaming ------------------------------------------------
#
# The chat turn is generated, citation-verified, and sanitized fully buffered
# (verify_citations/sanitize_report need the complete answer, and a shallow
# answer can still escalate to deep research — so raw token streaming would
# leak unverified citations or superseded text). We therefore stream the
# ALREADY-FINAL text as deltas: progressive rendering, not a change to the
# answer. See docs/design/streaming-chat-answer.md.

_STREAM_EXTRA_FIELDS = (
    "cards",
    "deep_research_job_id",
    "answer_confidence",
    "sources",
    # Transparency extras (WP-A): each surfaced only when applicable.
    "routing_decision",
    "routing_reason",
    "escalation_reason",
    "answer_confidence_capped_reason",
    "answer_confidence_reason",
    "citations_removed",
    # The research turn ran out of budget before it ran out of question.
    "research_truncated",
    "job_admission_rejected",
    "retry_after_seconds",
    # Agent Skills: which skills ran this turn — i.e. whose instructions the
    # model actually fetched, in the order it fetched them.
    "skills_activated",
)


def _iter_answer_deltas(text: str, *, target_size: int = 24) -> list[str]:
    """Split ``text`` into streaming deltas whose concatenation is EXACTLY
    ``text`` (nothing added or lost).

    Splits on whitespace boundaries so words are not torn mid-token, coalescing
    small tokens up to ``target_size`` chars per delta. ``"".join(result)`` is
    guaranteed to reproduce ``text`` verbatim.
    """
    if not text:
        return []
    import re

    # Each piece is a non-space run with its trailing whitespace, or a run of
    # whitespace — together they tile the string with no gaps or overlaps.
    pieces = re.findall(r"\S+\s*|\s+", text)
    deltas: list[str] = []
    buf = ""
    for piece in pieces:
        buf += piece
        if len(buf) >= target_size:
            deltas.append(buf)
            buf = ""
    if buf:
        deltas.append(buf)
    return deltas


def _chunk_content(chunk: ChatResponseChunk) -> str | None:
    """The content delta carried by a chunk, or None."""
    try:
        return chunk.choices[0].delta.content
    except (AttributeError, IndexError):
        return None


def _chunk_finish_reason(chunk: ChatResponseChunk) -> str | None:
    """The finish_reason carried by a chunk, or None."""
    try:
        return chunk.choices[0].finish_reason
    except (AttributeError, IndexError):
        return None


def _result_field(result: object, name: str) -> Any:
    """Read a graph-state field from the workflow result (state object or dict)."""
    value = getattr(result, name, None)
    if value is None and isinstance(result, dict):
        value = result.get(name)
    return value


def _response_to_chunks(response: ChatResponse, *, stream: bool) -> list[ChatResponseChunk]:
    """Turn a fully-built ChatResponse into the chunk sequence to yield.

    - ``stream=False``: a single terminal chunk (``finish_reason="stop"``) with
      the full content and the Grid extras — identical delivery to the
      pre-streaming single-response path.
    - ``stream=True``: incremental delta chunks (``finish_reason=None``, no
      extras) whose contents concatenate to exactly the final text, followed by
      one terminal chunk carrying the FULL content and the extras. The terminal
      is authoritative for persistence and the single-consumer fold.
    """
    try:
        content = response.choices[0].message.content or ""
    except (AttributeError, IndexError):
        content = ""
    model_name = getattr(response, "model", None)
    response_id = getattr(response, "id", None)
    extras = {field: value for field in _STREAM_EXTRA_FIELDS if (value := getattr(response, field, None)) is not None}

    # A job-admission rejection ("queue full") is NOT a research answer: its
    # prose is surfaced by the frontend as a warning banner, never an answer
    # bubble. Emit ONLY the terminal chunk (carrying the extras) — no answer
    # deltas — so no streaming assistant bubble is ever opened for it. Normal
    # turns are unaffected and stream as usual.
    job_admission_rejected = bool(getattr(response, "job_admission_rejected", None))

    chunks: list[ChatResponseChunk] = []
    if stream and content and not job_admission_rejected:
        for delta in _iter_answer_deltas(content):
            chunks.append(
                ChatResponseChunk.create_streaming_chunk(delta, id_=response_id, model=model_name, finish_reason=None)
            )
    terminal = ChatResponseChunk.create_streaming_chunk(
        content, id_=response_id, model=model_name, finish_reason="stop"
    )
    for field, value in extras.items():
        setattr(terminal, field, value)
    chunks.append(terminal)
    return chunks


def _fold_chunks_to_response(chunks: list[ChatResponseChunk]) -> ChatResponse:
    """Collapse a streamed chunk sequence back into a single ChatResponse for
    non-streaming consumers (the ``--input`` CLI, single-shot HTTP).

    The terminal chunk's (``finish_reason="stop"``) content is authoritative, so
    deltas are ignored when a terminal is present and the folded content is never
    doubled. Grid extras are copied from whichever chunk carries them.
    """
    delta_parts: list[str] = []
    final_content: str | None = None
    extras: dict[str, object] = {}
    model_name: str | None = None
    response_id: str | None = None
    for chunk in chunks:
        model_name = model_name or getattr(chunk, "model", None)
        response_id = response_id or getattr(chunk, "id", None)
        content = _chunk_content(chunk)
        if _chunk_finish_reason(chunk) == "stop":
            if content:
                final_content = content
        elif content:
            delta_parts.append(content)
        model_extra = getattr(chunk, "model_extra", None) or {}
        for field in _STREAM_EXTRA_FIELDS:
            value = getattr(chunk, field, None)
            if value is None:
                value = model_extra.get(field)
            if value is not None:
                extras[field] = value
    content = final_content if final_content is not None else "".join(delta_parts)
    response = _create_chat_response(content, response_id=response_id or "research_response", model=model_name)
    for field, value in extras.items():
        setattr(response, field, value)
    return response


########################################################
# Intent Classifier
########################################################


class IntentClassifierConfig(FunctionBaseConfig, name="intent_classifier"):
    """Configuration for the combined orchestration node (intent + meta response + depth)."""

    llm: LLMRef = Field(..., description="LLM to use")
    tools: list[FunctionRef | FunctionGroupRef] = Field(
        default_factory=list,
        description="Explicit tool list. Empty = inherit all from data_source_registry.",
    )
    exclude_tools: list[str] = Field(
        default_factory=list,
        description="Tool names to exclude when inheriting from registry.",
    )
    verbose: bool = Field(default=False)
    llm_timeout: float = Field(
        default=90,
        description="Timeout in seconds for the intent-classification LLM call. Default 90 if not set.",
    )


# Strong references to in-flight fire-and-forget persistence tasks so the event
# loop cannot garbage-collect them mid-run (and so an unretrieved exception is
# never logged as a warning). Entries are discarded on completion.
_persist_tasks: set[asyncio.Task] = set()


def _schedule_registry_persist(conversation_id: str) -> None:
    """Persist the turn's citation registry to the shared cache off the TTFT path.

    The write is best-effort/fail-open (ADR-0020 cross-replica/restart source
    recovery) and nothing downstream reads its result, so it must not gate the
    first streamed token. Mirrors ``schedule_memory_reflection``: run the
    blocking cache write in a thread, swallow/log any failure, and hold a strong
    reference until the task completes.
    """

    async def _persist() -> None:
        try:
            from aiq_agent.common.citation_verification import persist_session_registry

            await asyncio.to_thread(persist_session_registry, conversation_id)
        except Exception:
            logger.debug("Citation registry persistence failed (non-fatal)", exc_info=True)

    try:
        task = asyncio.get_running_loop().create_task(_persist())
    except RuntimeError:
        # No running loop (e.g. sync test context) — persist inline as a fallback.
        try:
            from aiq_agent.common.citation_verification import persist_session_registry

            persist_session_registry(conversation_id)
        except Exception:
            logger.debug("Citation registry persistence failed (non-fatal)", exc_info=True)
        return
    _persist_tasks.add(task)
    task.add_done_callback(_persist_tasks.discard)


def _compact_tool_blurb(tool_name: str, full_description: str) -> str:
    """One-line routing blurb for a tool used by the intent classifier.

    The classifier only needs each tool's PURPOSE to route (meta-vs-research,
    shallow-vs-deep) — not its argument-level usage contract. It renders the
    tool list below the KV-cache boundary and does not ``bind_tools``, so a
    full agent-facing docstring (e.g. ris_search's ~40 lines) is pure prefill
    weight on the gating LLM call of every turn.

    Prefer the data-source registry's short description — the exact text the
    pinned-sources path already renders via ``format_data_source_tools`` — so
    the two paths converge. Fall back to the first sentence of the tool's own
    description for non-registry tools (e.g. ``remember``). Always single-line.
    """
    try:
        from aiq_agent.common.data_source_registry import get_source
        from aiq_agent.common.data_source_registry import get_source_id_for_tool

        source_id = get_source_id_for_tool(tool_name)
        if source_id:
            meta = get_source(source_id)
            if meta and meta.description:
                return " ".join(meta.description.split())
    except Exception:
        pass

    text = " ".join((full_description or "").split())
    if not text:
        return ""
    # First sentence, so a non-registry tool still conveys its purpose.
    for sep in (". ", "! ", "? "):
        idx = text.find(sep)
        if idx != -1:
            return text[: idx + 1]
    # No sentence terminator: cap length so a stray long docstring can't bloat.
    return text if len(text) <= 240 else text[:237] + "..."


@register_function(config_type=IntentClassifierConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def intent_classifier(config: IntentClassifierConfig, builder: Builder):
    """Combined orchestration: classifies intent, produces meta response, and routes depth in one node."""
    from .nodes import IntentClassifier

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

    verbose = is_verbose(config.verbose)
    callbacks = [VerboseTraceCallback()] if verbose else []

    # Routing only needs each tool's purpose, not its full call docstring: keep
    # the exact tool name (the registry/non-registry split below keys on it) but
    # collapse the description to a short single-line blurb (see helper).
    tools_info = [
        {
            "name": getattr(t, "name", str(t)),
            "description": _compact_tool_blurb(getattr(t, "name", str(t)), getattr(t, "description", "")),
        }
        for t in tools
    ]
    classifier = IntentClassifier(
        llm=llm,
        tools_info=tools_info,
        callbacks=callbacks,
        llm_timeout=config.llm_timeout,
    )

    # Tools that exist outside the data-source registry (e.g. `remember`) must
    # survive the per-request data-source narrowing below, otherwise the
    # classifier believes they don't exist and denies the capability to users.
    from aiq_agent.common import get_all_tool_refs as _registry_refs

    registry_names = set(_registry_refs())
    non_registry_tools_info = [t for t in tools_info if t["name"] not in registry_names]

    async def _run(state: ChatResearcherState) -> dict[str, Any]:
        # Pass the narrowed list per request instead of mutating the shared
        # classifier instance: a mutation would leak one request's data-source
        # selection into every later request (and race between concurrent ones).
        request_tools_info = None
        if state.data_sources is not None:
            request_tools_info = format_data_source_tools(state.data_sources) + non_registry_tools_info
        return await classifier.run(state, tools_info=request_tools_info)

    yield FunctionInfo.from_fn(
        _run,
        description="Orchestration: intent classification, meta response, and depth routing.",
    )


########################################################
# Chat Deep Researcher Agent
########################################################
class ChatDeepResearcherConfig(FunctionBaseConfig, name="chat_deepresearcher_agent"):
    """Configuration for the chat deep researcher orchestrator agent."""

    enable_escalation: bool = Field(default=False, description="Enable escalation from shallow to deep research")
    max_history_tokens: int = Field(
        default=8000,
        description="Maximum number of tokens of chat history to keep before invoking the agent",
    )
    verbose: bool = Field(default=False, description="Enable verbose logging")
    enable_clarifier: bool = Field(default=False, description="Enable clarification of research queries")
    use_async_deep_research: bool = Field(
        default=False,
        description="Submit deep research as an async job instead of running inline",
    )
    checkpoint_db: str = Field(
        default="./checkpoints.db",
        description="SQLite database path or Postgres DSN for persistent checkpoints.",
    )
    card_generator_llm: LLMRef | None = Field(
        default=None,
        description="Optional LLM to use for structured response card generation. Defaults to nemotron_super_llm.",
    )
    memory_reflection_llm: LLMRef | None = Field(
        default=None,
        description=(
            "Optional LLM for the async post-answer memory-reflection stage. When set, after each "
            "answer is returned a background task reviews the turn against the project's existing "
            "memory and records any durable finding the in-turn `remember` tool missed. Unset "
            "disables reflection entirely (no extra LLM call)."
        ),
    )


@register_function(config_type=ChatDeepResearcherConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def chat_deepresearcher_agent(config: ChatDeepResearcherConfig, builder: Builder):
    """
    Chat deep researcher orchestrator agent.

    Coordinates intent classification, depth routing, and research agents
    to produce research results based on user queries.
    """
    import os
    import sys
    from pathlib import Path

    # Validate API keys early by checking the config file
    # This works for both nat run and interactive CLI
    config_file_path = None

    # Try to get config file path from environment (set by NAT framework)
    config_file_path = os.environ.get("NAT_CONFIG_FILE")

    # If not in env, try to extract from sys.argv (for nat run --config_file)
    if not config_file_path:
        try:
            if "--config_file" in sys.argv:
                idx = sys.argv.index("--config_file")
                if idx + 1 < len(sys.argv):
                    config_file_path = sys.argv[idx + 1]
        except (ValueError, IndexError):
            pass

    # Validate API keys early by checking the config file
    # Store error response to return in _run function if keys are missing
    api_key_error_response = None
    if config_file_path and Path(config_file_path).exists():
        try:
            import yaml

            async with aiofiles.open(config_file_path, encoding="utf-8") as f:
                raw = await f.read()
                config_dict = yaml.safe_load(raw)

            from aiq_agent.common.config_validation import validate_llm_configs

            is_valid, missing_keys = validate_llm_configs(config_dict)
            if not is_valid:
                error_msg = (
                    f"❌ ERROR: Missing Required API Keys\n\n"
                    f"Missing keys: {', '.join(missing_keys)}\n\n"
                    f"Cannot start workflow without required API keys.\n\n"
                    f"To fix this:\n"
                    f"  1. Set these keys in your .env file or environment variables\n"
                    f"  2. Restart the application"
                )
                logger.error("Missing %d required API key(s)", len(missing_keys))
                # Create the error response here to avoid duplication
                api_key_error_response = _create_chat_response(error_msg, response_id="api_key_error")
        except Exception as e:
            # If validation fails for other reasons (e.g., file can't be read), log but don't block
            logger.debug(f"Failed to validate API keys from config: {e}")

    from aiq_agent.common import filter_tools_by_sources

    from .agent import ChatResearcherAgent

    workflow_id = config.name or config.type
    intent_classifier_fn = await builder.get_function("intent_classifier")
    shallow_research_fn = await builder.get_function("shallow_research_agent")
    deep_research_fn = await builder.get_function("deep_research_agent")
    clarifier_fn = await builder.get_function("clarifier_agent") if config.enable_clarifier else None

    # Cards are emitted by the answering agent via the `emit_card` tool (see
    # aiq_agent.cards.register) and read from the conversation-scoped
    # CardRegistry after the turn — no separate card-generation LLM call.
    # card_generator_llm remains in the config schema for compatibility but is
    # no longer used on the sync chat path.

    # Get deep research tools for early validation
    deep_research_config = builder.get_function_config("deep_research_agent")
    if deep_research_config.tools:
        deep_tool_refs = deep_research_config.tools
    else:
        from aiq_agent.common import get_all_tool_refs

        deep_tool_refs = get_all_tool_refs()
    deep_research_tools = await builder.get_tools(tool_names=deep_tool_refs, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
    if deep_research_config.exclude_tools:
        excluded = set(deep_research_config.exclude_tools)
        deep_research_tools = [t for t in deep_research_tools if getattr(t, "name", "") not in excluded]

    # Create a validation function to check if deep research tools are available
    def validate_deep_research_tools(data_sources: list[str] | None) -> tuple[bool, str]:
        """
        Validate that at least one deep research tool is available.

        Returns:
            Tuple of (is_valid, error_message). If is_valid is False, error_message contains the reason.
        """
        from aiq_agent.common import format_tool_unavailability_error
        from aiq_agent.common import validate_tool_availability

        selected_tools = filter_tools_by_sources(deep_research_tools, data_sources)

        is_valid, _, unavailable_tools = validate_tool_availability(
            selected_tools, research_type="deep research", enable_logging=False
        )

        if not is_valid:
            error_msg = format_tool_unavailability_error("deep research", unavailable_tools)
            return False, error_msg

        return True, ""

    verbose = is_verbose(config.verbose)
    callbacks = [VerboseTraceCallback()] if verbose else []

    deep_research_job_submitter = None
    if config.use_async_deep_research:
        import os

        # Check if Dask scheduler is available
        scheduler_address = os.environ.get("NAT_DASK_SCHEDULER_ADDRESS")
        if scheduler_address:
            from aiq_agent.auth import get_current_principal
            from aiq_api.jobs.submit import submit_agent_job

            async def _submit_deep_job(state: ChatResearcherState) -> str:
                principal = get_current_principal()
                owner = principal.email if principal and principal.email else "anonymous"
                query = state.original_query
                if not query:
                    if not state.messages:
                        raise RuntimeError("Cannot submit deep research job without messages.")
                    from aiq_agent.common import get_latest_user_query

                    query = get_latest_user_query(state.messages)
                input_text = query if isinstance(query, str) else str(query)

                # Serialize available_documents for the Dask worker
                available_docs = None
                if state.available_documents:
                    available_docs = [doc.model_dump() for doc in state.available_documents]
                    logger.debug(
                        "Passing %d available documents to deep research job",
                        len(available_docs),
                    )

                return await submit_agent_job(
                    agent_type="deep_researcher",
                    input_text=input_text,
                    owner=owner,
                    available_documents=available_docs,
                    data_sources=state.data_sources,
                    collection_scope=state.collection_scope,
                    project_context=state.project_context,
                    model_overrides=get_model_overrides_from_context() or None,
                    # Structured fields (not prose-folded into input_text) so the
                    # worker sets them on DeepResearchAgentState and the deep
                    # prompts render their dedicated sections, same as the
                    # synchronous in-process deep research path.
                    user_info=state.user_info,
                    clarifier_result=state.clarifier_result,
                    # Deep-research reflection runs on the worker once the report
                    # exists (the sync post-answer stage skips deep jobs). Both
                    # values are read here while the request context is live.
                    memory_reflection_enabled=(
                        config.memory_reflection_llm is not None and get_memory_reflection_enabled_from_context()
                    ),
                    # Plain str (LLMRef is a str subclass) so it crosses the Dask
                    # pickle boundary without depending on the subclass.
                    memory_reflection_llm=(str(config.memory_reflection_llm) if config.memory_reflection_llm else None),
                )

            deep_research_job_submitter = _submit_deep_job
        else:
            logger.info(
                "use_async_deep_research is enabled but NAT_DASK_SCHEDULER_ADDRESS is not set. "
                "Falling back to synchronous deep research execution."
            )

    # Optional LLM for the async post-answer memory-reflection stage. Built once
    # at registration; None (unset config) disables reflection with zero cost.
    reflection_llm = None
    if config.memory_reflection_llm is not None:
        try:
            reflection_llm = await get_langchain_llm(builder, config.memory_reflection_llm)
        except Exception:
            logger.warning("Could not build memory_reflection_llm; reflection disabled", exc_info=True)

    checkpointer = await get_checkpointer(config.checkpoint_db)

    agent = ChatResearcherAgent(
        intent_classifier_fn=intent_classifier_fn.ainvoke,
        shallow_research_fn=shallow_research_fn.ainvoke,
        deep_research_fn=deep_research_fn.ainvoke,
        clarifier_fn=clarifier_fn.ainvoke if clarifier_fn else None,
        enable_clarifier=config.enable_clarifier,
        enable_escalation=config.enable_escalation,
        callbacks=callbacks,
        max_history_tokens=config.max_history_tokens,
        deep_research_job_submitter=deep_research_job_submitter,
        checkpointer=checkpointer,
        validate_deep_research_tools_fn=validate_deep_research_tools,
    )

    # Ingest-only context (ADR-0034 addendum). The WebSocket front end owns the
    # socket and this tier owns the graph, so the appender is published rather than
    # imported: a `context_only` frame lands in this conversation's checkpoint
    # without a turn, so the agent can see what a colleague wrote the next time it
    # IS addressed. Registered here because this is where the compiled graph (and
    # its checkpointer) exists.
    register_context_appender(agent.append_context_message)

    async def _run(
        query: object,
    ) -> Annotated[AsyncGenerator[ChatResponseChunk, None], Streaming(convert=_fold_chunks_to_response)]:
        import sys
        import uuid

        # Read the X-Grid-Collection-Scope header from NAT context, if present.
        # Prefer the shelf-bearing entries (ADR-0047) so the inventory can
        # group Büroarchiv / Projekt / session / Basiswissen instead of dumping
        # every filename into one unlabeled list.
        _collection_scope = None
        _scoped_collections = None
        try:
            from aiq_agent.knowledge.scoping import get_collection_scope_from_context
            from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

            _scoped_collections = get_scoped_collections_from_context()
            _collection_scope = get_collection_scope_from_context()
        except ImportError:
            pass

        # Compose the injected project context: the intake profile (frozen at the
        # handshake, fine) plus the core-memory digest. The digest header is
        # frozen for the connection's life, so memory written mid-session would
        # not reach the agent until a reconnect. Re-fetch a LIVE digest per turn
        # and fall back to the frozen header value only when the fetch fails.
        #
        # This and the available-documents aggregation below are two independent
        # blocking I/O paths that used to run strictly one after the other before
        # intent classification. They are now defined as coroutines and awaited
        # together via asyncio.gather (see below), so the digest fetch and the
        # per-collection document reads overlap. Each degrades independently:
        # a failure in one never affects the other.
        async def _load_project_context():
            """Live per-turn project context (profile + memory digest).

            Returns the 5-tuple consumed below. Fail-open: on any error the
            defaults are returned so the turn proceeds without a live digest.
            """
            _project_context = None
            # Values the async memory-reflection stage needs, captured while the
            # request context is still live (the task runs after this returns).
            _reflection_project_id = None
            _reflection_org_id = None
            _reflection_memory_digest = None
            _reflection_flag_enabled = False
            try:
                from aiq_agent.project_context import GridRequestContext
                from aiq_agent.project_context import compose_project_context

                # Parse the signed request-context envelope ONCE per turn: each
                # accessor helper otherwise re-reads the header and re-runs the
                # base64 + HMAC-SHA256 + JSON parse of the same payload (the
                # module docstring instructs calling from_context() once when
                # more than one field is needed).
                _ctx = GridRequestContext.from_context()
                _profile_context = _ctx.project_context
                _project_id = _ctx.project_id
                _org_id = _ctx.organization_id

                # Live per-turn digest; fall back to the connection-time header value.
                _memory_digest = _ctx.project_memory
                if _project_id or _org_id:
                    try:
                        from aiq_agent.knowledge.project_memory import fetch_memory_digest

                        _live_digest = await asyncio.to_thread(
                            fetch_memory_digest, project_id=_project_id, organization_id=_org_id
                        )
                        # A successful fetch is authoritative even when empty (memory
                        # may have been cleared); only a failure keeps the header value.
                        _memory_digest = _live_digest
                    except Exception:
                        logger.warning("Live memory digest fetch failed; using connection-time digest", exc_info=True)

                _project_context = compose_project_context(_profile_context, _memory_digest)

                if reflection_llm is not None:
                    _reflection_flag_enabled = _ctx.memory_reflection_enabled
                    _reflection_project_id = _project_id
                    _reflection_org_id = _org_id
                    # Reflect against the digest the agent actually saw this turn.
                    _reflection_memory_digest = _memory_digest
            except ImportError:
                pass
            return (
                _project_context,
                _reflection_project_id,
                _reflection_org_id,
                _reflection_memory_digest,
                _reflection_flag_enabled,
            )

        # Check if API keys are missing and return graceful error response
        if api_key_error_response:
            # Exit after error message when --input is provided
            if "--input" in sys.argv:
                import threading
                import time

                def exit_after_error():
                    time.sleep(0.2)
                    os._exit(1)

                threading.Thread(target=exit_after_error, daemon=False).start()

            # Error responses are short and fully known up front — deliver as a
            # single terminal chunk regardless of the streaming flag.
            for _chunk in _response_to_chunks(api_key_error_response, stream=False):
                yield _chunk
            return

        # For --input mode, use a fresh conversation_id to avoid loading old checkpoint state
        # This ensures each run starts with a clean conversation history
        if "--input" in sys.argv:
            nat_context_conversation_id = str(uuid.uuid4())
            logger.info("Using fresh conversation ID for --input mode: %s", nat_context_conversation_id)
        else:
            nat_context_conversation_id = Context.get().conversation_id
            if not nat_context_conversation_id:
                nat_context_conversation_id = str(uuid.uuid4())
                logger.info("No conversation-id header; generated thread ID: %s", nat_context_conversation_id)
            else:
                logger.info("Thread ID for checkpointing: %s", nat_context_conversation_id)

        from aiq_agent.auth import get_current_principal

        principal = get_current_principal()
        user_info_dict = None
        if principal:
            logger.debug("User authenticated")
            user_info_dict = {
                "name": principal.name,
                "email": principal.email,
            }

        # Decide whether to skip the clarifier for this request.
        # 1. Config (enable_clarifier=false) — operator disabled it entirely.
        # 2. aiq_api.auth.middleware ContextVar — covers X-AIQ-Mode: headless,
        #    anonymous callers, and unauthenticated internal callers.
        skip_clarifier = not config.enable_clarifier
        if not skip_clarifier:
            try:
                from aiq_api.auth.middleware import get_current_user as _get_mw_user

                if _get_mw_user().get("skip_clarifier"):
                    skip_clarifier = True
            except Exception:
                pass
        logger.info("skip_clarifier=%s", skip_clarifier)

        # Retrieval reads the turn's focus from the ContextVars this parse sets;
        # taking it from the same call is what also puts the subject in front of
        # the classifier and the answering model.
        query_text, data_sources, force_skills, _focus_file_name, _focus_shelf = extract_turn_inputs(query)
        logger.info("ChatDeepResearcherAgent: %s", query_text)
        logger.info("ChatDeepResearcherAgent: Data sources: %s", data_sources)

        # Fetch available documents with summaries from SQLite registry.
        # Aggregate across collections from the header scope, or fall back to
        # BOTH the base OIB corpus and the per-session collection
        # (conversation_id) so the agent sees uploads and the persistent corpus.
        # The registry is populated by backends during ingestion (backend-agnostic).
        async def _load_available_documents():
            """Aggregate document summaries across the in-scope collections.

            Returns a list of documents (or None when nothing is found).
            Fail-open: a total failure yields None; a single collection's
            failure yields empty for that collection, not a total failure.
            """
            available_documents = None
            try:
                from aiq_agent.common.source_kinds import Shelf
                from aiq_agent.knowledge import get_available_documents_async
                from aiq_agent.knowledge.scoping import ScopedCollection

                # Header-based collection scope takes precedence. Reuse the
                # shelf-bearing entries decoded at the top of the turn so each
                # inventory row can be stamped with its shelf.

                header_scope = _scoped_collections or _collection_scope
                if header_scope:
                    collections_to_check = header_scope
                else:
                    # Session collection (s_<conversation_id>), when present.
                    raw_conversation_id = Context.get().conversation_id if Context.get() else None
                    session_collection = None
                    if raw_conversation_id:
                        session_collection = (
                            raw_conversation_id if raw_conversation_id.startswith("s_") else f"s_{raw_conversation_id}"
                        )
                    # Base OIB corpus name, resolved from env with a sensible default.
                    base_collection = (
                        os.environ.get("COLLECTION_NAME") or os.environ.get("OIB_COLLECTION_NAME") or "oib_knowledge"
                    )
                    # Distinct collections to query, preserving order (base first).
                    # The fallback *builds* these layers, so the shelf is known
                    # structurally — not guessed from the name.
                    collections_to_check: list[ScopedCollection] = []
                    for coll, shelf in (
                        (base_collection, Shelf.BASE),
                        (session_collection, Shelf.SESSION),
                    ):
                        if coll and all(entry.collection != coll for entry in collections_to_check):
                            collections_to_check.append(ScopedCollection(coll, shelf))

                # Read every collection concurrently (instead of one round-trip
                # at a time) and merge deterministically; see the helper for the
                # order/dedup/fail-open contract.
                aggregated = await _aggregate_documents_across_collections(
                    collections_to_check, get_available_documents_async
                )

                scope_names = [
                    entry.collection if hasattr(entry, "collection") else entry for entry in collections_to_check
                ]
                if aggregated:
                    available_documents = aggregated
                    logger.info(
                        "Loaded %d document summaries across collections %s",
                        len(aggregated),
                        scope_names,
                    )
                else:
                    logger.info("No document summaries in DB for collections %s", scope_names)
            except Exception as e:
                logger.warning("Could not fetch available documents: %s", e)
            return available_documents

        # Say what is happening in the FIRST hole of the turn. Nothing at all
        # reached the client before the intent classifier's LLM call, so a turn
        # scoped to an archive or a project sat silent through every one of
        # these round-trips. Only emitted when one of the reader's OWN shelves
        # is in scope -- the base OIB corpus is read on every research turn,
        # and announcing a constant says nothing.
        try:
            from aiq_agent.common.turn_status import emit_documents_loading

            emit_documents_loading(
                [
                    str(shelf)
                    for entry in (_scoped_collections or ())
                    if (shelf := getattr(entry, "shelf", None)) is not None
                ]
            )
        except Exception:  # noqa: BLE001 — transparency must never take a turn down
            logger.debug("Document-loading status not emitted", exc_info=True)

        # Run the independent per-turn I/O paths concurrently: the live
        # memory-digest fetch, the available-documents aggregation, and the
        # session-registry hydration. None depends on the others, and each fails
        # open on its own (see the helpers), so gather cannot let one failure
        # lose the others' results. The registry hydration's blocking Dragonfly
        # GET (cold-cache, ~0.5s socket timeout) is offloaded via asyncio.to_thread
        # so it overlaps the gather instead of blocking the loop serially after it.
        (
            (
                _project_context,
                _reflection_project_id,
                _reflection_org_id,
                _reflection_memory_digest,
                _reflection_flag_enabled,
            ),
            available_documents,
            session_registry,
        ) = await asyncio.gather(
            _load_project_context(),
            _load_available_documents(),
            asyncio.to_thread(get_or_create_session_registry, nat_context_conversation_id),
        )
        # Set session-scoped source registry for citation verification across turns.
        # When no conversation ID is available, get_or_create_session_registry returns a
        # fresh per-request registry to prevent anonymous sessions from sharing state.
        # The hydrating read above ran in the gather; the ContextVar set stays inline.
        token = set_session_registry(session_registry)
        # Bind the conversation-scoped card registry so the `emit_card` tool can
        # push cards during the turn. Cleared here (registries are reused across
        # turns of the same conversation) so a card never leaks between turns.
        card_registry = get_or_create_card_registry(nat_context_conversation_id)
        card_registry.clear()
        card_token = set_card_registry(card_registry)
        try:
            state = ChatResearcherState(
                messages=[HumanMessage(content=query_text)],
                user_info=user_info_dict,
                data_sources=data_sources,
                force_skills=force_skills,
                available_documents=available_documents,
                collection_scope=_collection_scope,
                focus_file_name=_focus_file_name,
                focus_shelf=_focus_shelf,
                skip_clarifier=skip_clarifier,
                project_context=_project_context,
            )
            # Unified LLM cost capture + budget enforcement for the whole turn
            # (every agent/LLM call inside inherits the tracker via LangChain's
            # configure hook — see aiq_agent/common/cost_tracking.py). The
            # profiler wraps the same turn, capturing a node/LLM/tool span
            # timeline for the platform-owner profiler view (common/profiler.py).
            from aiq_agent.common.cost_tracking import BudgetExceededError
            from aiq_agent.common.cost_tracking import track_llm_costs
            from aiq_agent.common.profiler import track_agent_profile
            from aiq_agent.common.turn_admission import TurnAdmissionError
            from aiq_agent.common.turn_admission import admit_turn_async

            try:
                # Concurrency admission (ADR-0040 L3). A turn OCCUPIES capacity
                # for as long as it runs, so the slot is held around the run
                # itself — outside it, a per-minute rate limit would still admit
                # an unbounded number of simultaneous research runs at a steady
                # trickle. Interactive turns have their own pool, so background
                # deep research can never crowd them out.
                async with admit_turn_async(_admission_organization_id()):
                    with track_agent_profile(agent_name="chat_researcher"), track_llm_costs():
                        result = await agent.run(state, thread_id=nat_context_conversation_id)
            except TurnAdmissionError as admission_error:
                logger.warning("Turn refused by admission control: %s", admission_error)
                busy_response = _create_chat_response(
                    str(admission_error), response_id="turn_admission", model=workflow_id
                )
                # Same contract as every other refusal in the system: say WHEN to
                # come back, not just no. Without it the client has to guess, and
                # guessing is what turns a refusal into a retry storm.
                busy_response.retry_after_seconds = admission_error.retry_after_seconds
                for _chunk in _response_to_chunks(busy_response, stream=False):
                    yield _chunk
                return
            except BudgetExceededError as budget_error:
                logger.warning("Turn stopped by budget enforcement: %s", budget_error)
                budget_response = _create_chat_response(
                    str(budget_error), response_id="budget_exceeded", model=workflow_id
                )
                for _chunk in _response_to_chunks(budget_response, stream=False):
                    yield _chunk
                return
        finally:
            reset_session_registry(token)
            reset_card_registry(card_token)
            # Persist the turn's captured citation sources to the shared cache
            # (ADR-0020) so the conversation keeps prior-turn sources after a
            # restart or on another replica. Best-effort and fire-and-forget: it
            # must not sit between "answer ready" and "first streamed token".
            if nat_context_conversation_id:
                _schedule_registry_persist(nat_context_conversation_id)

        if isinstance(result, dict):
            messages = result.get("messages", [])
        else:
            messages = getattr(result, "messages", [])

        if messages:
            response_content = messages[-1].content
        else:
            response_content = "No response generated."

        # Cards come from the emit_card tool via the conversation-scoped
        # registry — the agent decides, in-context, when a card adds value.
        cards = card_registry.snapshot()
        deep_research_job_id = getattr(result, "deep_research_job_id", None) or (
            result.get("deep_research_job_id") if isinstance(result, dict) else None
        )
        # The model's guarded self-assessment of answer grounding (None on error,
        # escalation, and marker-absent turns → no chip renders).
        answer_confidence = getattr(result, "answer_confidence", None) or (
            result.get("answer_confidence") if isinstance(result, dict) else None
        )
        verified_sources = getattr(result, "verified_sources", None) or (
            result.get("verified_sources") if isinstance(result, dict) else None
        )

        # Transparency extras (WP-A): each surfaced only when applicable (never
        # null-spammed), riding the same terminal-chunk extras lift as the fields
        # above. See docs/architecture/backend-deep-dive.md.
        from .agent import derive_routing_decision

        depth_decision = _result_field(result, "depth_decision")
        routing_decision = derive_routing_decision(_result_field(result, "user_intent"), depth_decision)
        routing_reason = getattr(depth_decision, "raw_reasoning", None)
        escalation_reason = _result_field(result, "escalation_reason")
        answer_confidence_capped_reason = _result_field(result, "answer_confidence_capped_reason")
        answer_confidence_reason = _result_field(result, "answer_confidence_reason")
        citations_removed = _result_field(result, "citations_removed")
        research_truncated = _result_field(result, "research_truncated")
        job_admission_rejected = _result_field(result, "job_admission_rejected")
        retry_after_seconds = _result_field(result, "retry_after_seconds")
        skills_activated = _result_field(result, "skills_activated")

        # Exit after response when --input is provided
        if "--input" in sys.argv:
            import threading
            import time

            def exit_after_response():
                time.sleep(0.2)
                os._exit(0)

            threading.Thread(target=exit_after_response, daemon=False).start()

        response = _create_chat_response(response_content, response_id="research_response", model=workflow_id)
        if cards:
            logger.info("Attaching %d card(s) to ChatResponse", len(cards))
            response.cards = cards
        else:
            logger.info("No cards on this turn (cards=%r)", cards)
        if deep_research_job_id:
            response.deep_research_job_id = deep_research_job_id
        if answer_confidence:
            response.answer_confidence = answer_confidence
        if verified_sources:
            response.sources = verified_sources
        if routing_decision:
            response.routing_decision = routing_decision
        if routing_reason:
            response.routing_reason = routing_reason
        if escalation_reason:
            response.escalation_reason = escalation_reason
        if answer_confidence_capped_reason:
            response.answer_confidence_capped_reason = answer_confidence_capped_reason
        if answer_confidence_reason:
            response.answer_confidence_reason = answer_confidence_reason
        if citations_removed:
            response.citations_removed = citations_removed
        # Truthiness, not `is not None`: the field is True-or-absent by
        # construction, and an accidental False must stay off the wire rather
        # than reach a frontend that renders on presence.
        if research_truncated:
            response.research_truncated = True
        if job_admission_rejected:
            response.job_admission_rejected = True
            if retry_after_seconds is not None:
                response.retry_after_seconds = retry_after_seconds
        if skills_activated:
            response.skills_activated = skills_activated

        # Post-processing phase: kick off memory reflection AFTER the answer is
        # ready. Fire-and-forget — it runs on the event loop without delaying the
        # response. Gated so it only reflects on a substantive research answer:
        # deep-research job stubs carry no answer; meta/error turns and
        # insufficiency answers ("I don't have enough information …") have nothing
        # durable to record and would only invite spurious findings (audit gap).
        # Runtime on/off is decided by the BFF (`isMemoryReflectionEnabled`):
        # the `memory-reflection` WorkOS feature flag when flag enforcement is
        # on, otherwise `GRID_MEMORY_REFLECTION_ENABLED` (default ON) — forwarded
        # as a request header.
        if reflection_llm is not None and _reflection_flag_enabled and not deep_research_job_id:
            answer_text = response_content if isinstance(response_content, str) else str(response_content)
            if _reflection_answer_is_substantive(result, answer_text):
                from aiq_agent.agents.project_memory.reflection import schedule_memory_reflection
                from aiq_agent.common import AgentGroup
                from aiq_agent.common import apply_model_override
                from aiq_agent.common import apply_org_credential

                # Applied here — not inside the background task — because the
                # override header is only readable while the request context is
                # still live. The org's BYOK credential (ADR-0022) covers the
                # reflection call too — it is tenant traffic like any other.
                schedule_memory_reflection(
                    llm=apply_org_credential(apply_model_override(reflection_llm, AgentGroup.MEMORY_REFLECTION)),
                    query=query_text,
                    answer=answer_text,
                    project_id=_reflection_project_id,
                    organization_id=_reflection_org_id,
                    conversation_id=nat_context_conversation_id,
                    memory_digest=_reflection_memory_digest,
                )

        # Deliver the fully verified/sanitized answer as a progressive stream:
        # the already-final text is emitted as incremental deltas followed by a
        # terminal chunk carrying cards/sources (single-output consumers fold it
        # back to one ChatResponse via _fold_chunks_to_response).
        for _chunk in _response_to_chunks(response, stream=True):
            yield _chunk

    yield FunctionInfo.from_fn(_run, description="Chat deep researcher with intent routing and escalation.")
