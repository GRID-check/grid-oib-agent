# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""NAT register function for chat researcher agent."""

import asyncio
import logging
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
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import is_verbose
from aiq_agent.common.citation_verification import get_or_create_session_registry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.nat_converters import ensure_registered as _ensure_nat_converters_registered
from aiq_agent.observability.otel_header_redaction_exporter import (
    ensure_registered as _ensure_otel_redaction_registered,
)
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

from .models import ChatResearcherState
from .utils import _extract_query_and_sources

logger = logging.getLogger(__name__)

_ensure_otel_redaction_registered()
# Register a direct ChatResponse -> ChatResponseChunk converter so Grid cards
# (attached as an extra field on the response) survive NAT's CHAT_STREAM
# serialization instead of being dropped by the lossy indirect str conversion.
_ensure_nat_converters_registered()

# Canned error/empty answers that must never trigger a memory-reflection pass.
_REFLECTION_NON_ANSWERS = (
    "No response generated.",
    "An error occurred",
    "The search tools did not return any results",
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
    if intent in {"meta", "error"}:
        return False
    return True


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


@register_function(config_type=IntentClassifierConfig, framework_wrappers=[LLMFrameworkEnum.LANGCHAIN])
async def intent_classifier(config: IntentClassifierConfig, builder: Builder):
    """Combined orchestration: classifies intent, produces meta response, and routes depth in one node."""
    from .nodes import IntentClassifier

    llm = await builder.get_llm(config.llm, wrapper_type=LLMFrameworkEnum.LANGCHAIN)

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

    tools_info = [{"name": getattr(t, "name", str(t)), "description": getattr(t, "description", "")} for t in tools]
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
    max_history: int = Field(
        default=20, description="Maximum number of messages to keep in history before invoking the agent"
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
                logger.error("Missing required API keys: %s", ", ".join(missing_keys))
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
            reflection_llm = await builder.get_llm(
                config.memory_reflection_llm, wrapper_type=LLMFrameworkEnum.LANGCHAIN
            )
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
        max_history=config.max_history,
        deep_research_job_submitter=deep_research_job_submitter,
        checkpointer=checkpointer,
        validate_deep_research_tools_fn=validate_deep_research_tools,
    )

    async def _run(query: object) -> ChatResponse:
        import os
        import sys
        import uuid

        # Read the X-Grid-Collection-Scope header from NAT context, if present.
        _collection_scope = None
        try:
            from aiq_agent.knowledge.scoping import get_collection_scope_from_context

            _collection_scope = get_collection_scope_from_context()
        except ImportError:
            pass

        # Compose the injected project context: the intake profile (frozen at the
        # handshake, fine) plus the core-memory digest. The digest header is
        # frozen for the connection's life, so memory written mid-session would
        # not reach the agent until a reconnect. Re-fetch a LIVE digest per turn
        # and fall back to the frozen header value only when the fetch fails.
        _project_context = None
        # Values the async memory-reflection stage needs, captured while the
        # request context is still live (the task runs after this returns).
        _reflection_project_id = None
        _reflection_org_id = None
        _reflection_memory_digest = None
        _reflection_flag_enabled = False
        try:
            from aiq_agent.project_context import compose_project_context
            from aiq_agent.project_context import get_memory_digest_from_context
            from aiq_agent.project_context import get_memory_reflection_enabled_from_context
            from aiq_agent.project_context import get_organization_id_from_context
            from aiq_agent.project_context import get_profile_context_from_context
            from aiq_agent.project_context import get_project_id_from_context

            _profile_context = get_profile_context_from_context()
            _project_id = get_project_id_from_context()
            _org_id = get_organization_id_from_context()

            # Live per-turn digest; fall back to the connection-time header value.
            _memory_digest = get_memory_digest_from_context()
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
                _reflection_flag_enabled = get_memory_reflection_enabled_from_context()
                _reflection_project_id = _project_id
                _reflection_org_id = _org_id
                # Reflect against the digest the agent actually saw this turn.
                _reflection_memory_digest = _memory_digest
        except ImportError:
            pass

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

            return api_key_error_response

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

        query_text, data_sources = _extract_query_and_sources(query)
        logger.info("ChatDeepResearcherAgent: %s", query_text)
        logger.info("ChatDeepResearcherAgent: Data sources: %s", data_sources)

        # Fetch available documents with summaries from SQLite registry.
        # Aggregate across collections from the header scope, or fall back to
        # BOTH the base OIB corpus and the per-session collection
        # (conversation_id) so the agent sees uploads and the persistent corpus.
        # The registry is populated by backends during ingestion (backend-agnostic).
        available_documents = None
        try:
            from aiq_agent.knowledge import get_available_documents_async
            from aiq_agent.knowledge.scoping import get_collection_scope_from_context

            # Header-based collection scope takes precedence.
            header_scope = get_collection_scope_from_context()
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
                collections_to_check: list[str] = []
                for coll in (base_collection, session_collection):
                    if coll and coll not in collections_to_check:
                        collections_to_check.append(coll)

            aggregated = []
            seen_files: set[str] = set()
            for coll in collections_to_check:
                try:
                    docs = await get_available_documents_async(coll)
                except Exception as e:
                    logger.debug("No document summaries for collection %s: %s", coll, e)
                    continue
                for doc in docs or []:
                    if doc.file_name in seen_files:
                        continue
                    seen_files.add(doc.file_name)
                    aggregated.append(doc)

            if aggregated:
                available_documents = aggregated
                logger.info(
                    "Loaded %d document summaries across collections %s",
                    len(aggregated),
                    collections_to_check,
                )
            else:
                logger.info("No document summaries in DB for collections %s", collections_to_check)
        except Exception as e:
            logger.warning("Could not fetch available documents: %s", e)
        # Set session-scoped source registry for citation verification across turns.
        # When no conversation ID is available, get_or_create_session_registry returns a
        # fresh per-request registry to prevent anonymous sessions from sharing state.
        session_registry = get_or_create_session_registry(nat_context_conversation_id)
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
                available_documents=available_documents,
                collection_scope=_collection_scope,
                skip_clarifier=skip_clarifier,
                project_context=_project_context,
            )
            # Unified LLM cost capture + budget enforcement for the whole turn
            # (every agent/LLM call inside inherits the tracker via LangChain's
            # configure hook — see aiq_agent/common/cost_tracking.py).
            from aiq_agent.common.cost_tracking import BudgetExceededError
            from aiq_agent.common.cost_tracking import track_llm_costs

            try:
                with track_llm_costs():
                    result = await agent.run(state, thread_id=nat_context_conversation_id)
            except BudgetExceededError as budget_error:
                logger.warning("Turn stopped by budget enforcement: %s", budget_error)
                return _create_chat_response(str(budget_error), response_id="budget_exceeded", model=workflow_id)
        finally:
            reset_session_registry(token)
            reset_card_registry(card_token)
            # Persist the turn's captured citation sources to the shared cache
            # (ADR-0020) so the conversation keeps prior-turn sources after a
            # restart or on another replica. Best-effort, off the event loop.
            if nat_context_conversation_id:
                try:
                    from aiq_agent.common.citation_verification import persist_session_registry

                    await asyncio.to_thread(persist_session_registry, nat_context_conversation_id)
                except Exception:
                    logger.debug("Citation registry persistence failed (non-fatal)", exc_info=True)

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

        # Post-processing phase: kick off memory reflection AFTER the answer is
        # ready. Fire-and-forget — it runs on the event loop without delaying the
        # response. Gated so it only reflects on a substantive research answer:
        # deep-research job stubs carry no answer; meta/error turns and
        # insufficiency answers ("I don't have enough information …") have nothing
        # durable to record and would only invite spurious findings (audit gap).
        # Runtime on/off is the `memory-reflection` WorkOS feature flag (or the
        # MEMORY_REFLECTION_ENABLED env fallback), forwarded as a request header.
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

        return response

    yield FunctionInfo.from_fn(_run, description="Chat deep researcher with intent routing and escalation.")
