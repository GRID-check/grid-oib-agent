"""Common utilities for the AI-Q blueprint."""

from __future__ import annotations

import asyncio
import datetime
import logging
import os

import aiosqlite
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from nat.data_models.api_server import ChatResponse
from nat.data_models.api_server import ChatResponseChoice
from nat.data_models.api_server import ChoiceMessage
from nat.data_models.api_server import Usage
from nat.data_models.api_server import UserMessageContentRoleType

from .budget_guard import BudgetGuardCallback
from .budget_guard import RunBudgetExceededError
from .budget_guard import create_budget_guard_callback
from .callbacks import VerboseTraceCallback
from .citation_verification import SourceRegistry
from .citation_verification import get_or_create_session_registry
from .citation_verification import get_session_registry
from .citation_verification import register_source_parser
from .citation_verification import reset_session_registry
from .citation_verification import sanitize_report
from .citation_verification import set_session_registry
from .citation_verification import verify_citations
from .data_source_registry import get_all_tool_refs
from .data_source_registry import get_source_id_for_tool
from .data_sources import DEFAULT_DATA_SOURCES
from .data_sources import DISABLED_SOURCES_HEADER
from .data_sources import all_mapped_tools_filtered_out
from .data_sources import extract_messages_and_sources
from .data_sources import filter_tools_by_sources
from .data_sources import format_data_source_tools
from .data_sources import get_disabled_sources_from_context
from .data_sources import parse_data_sources
from .data_sources import parse_disabled_sources
from .db_utils import redact_db_url
from .json_utils import extract_json
from .llm_credentials import OrgLLMCredential
from .llm_credentials import apply_org_credential
from .llm_credentials import get_org_llm_credential_from_context
from .llm_credentials import resolve_org_llm_credential
from .llm_factory import apply_openrouter_structured_defaults
from .llm_factory import get_langchain_llm
from .llm_factory import strict_json_response_format
from .llm_factory import strict_response_format
from .llm_provider import LLMProvider
from .llm_provider import LLMRole
from .message_utils import get_latest_user_query
from .model_overrides import MODEL_OVERRIDES_HEADER
from .model_overrides import AgentGroup
from .model_overrides import apply_model_override
from .model_overrides import apply_zdr_routing
from .model_overrides import get_model_overrides_from_context
from .model_overrides import get_zdr_only_from_context
from .model_overrides import is_reasoning_incompatible_error
from .model_overrides import parse_model_overrides
from .model_overrides import sanitize_model_overrides
from .nat_step_repair import SpanClosingProfilerHandler
from .prompt_utils import load_prompt
from .prompt_utils import render_prompt_template
from .tool_validation import format_tool_unavailability_error
from .tool_validation import format_user_facing_tool_error
from .tool_validation import validate_tool_availability

logger = logging.getLogger(__name__)

# Shared checkpointer caches
_checkpointers: dict[str, BaseCheckpointSaver] = {}
_postgres_pools: dict[str, AsyncConnectionPool] = {}
# Serializes checkpointer creation: connect/setup are awaits, so a bare
# check-then-act would let two concurrent callers both connect and leak the
# loser's connection when it is overwritten in the cache.
_checkpointer_lock = asyncio.Lock()

__all__ = [
    "DEFAULT_DATA_SOURCES",
    "DISABLED_SOURCES_HEADER",
    "AgentGroup",
    "BudgetGuardCallback",
    "LLMProvider",
    "MODEL_OVERRIDES_HEADER",
    "LLMRole",
    "OrgLLMCredential",
    "RunBudgetExceededError",
    "SourceRegistry",
    "SpanClosingProfilerHandler",
    "VerboseTraceCallback",
    "all_mapped_tools_filtered_out",
    "create_budget_guard_callback",
    "apply_model_override",
    "apply_zdr_routing",
    "get_zdr_only_from_context",
    "is_reasoning_incompatible_error",
    "apply_org_credential",
    "get_disabled_sources_from_context",
    "get_model_overrides_from_context",
    "get_org_llm_credential_from_context",
    "parse_disabled_sources",
    "resolve_org_llm_credential",
    "parse_model_overrides",
    "redact_db_url",
    "sanitize_model_overrides",
    "extract_json",
    "extract_messages_and_sources",
    "filter_tools_by_sources",
    "format_data_source_tools",
    "format_tool_unavailability_error",
    "format_user_facing_tool_error",
    "get_all_tool_refs",
    "get_checkpointer",
    "get_or_create_session_registry",
    "get_source_id_for_tool",
    "get_session_registry",
    "get_latest_user_query",
    "is_postgres_dsn",
    "load_prompt",
    "parse_data_sources",
    "register_source_parser",
    "render_prompt_template",
    "reset_session_registry",
    "sanitize_report",
    "set_session_registry",
    "validate_tool_availability",
    "apply_openrouter_structured_defaults",
    "get_langchain_llm",
    "strict_response_format",
    "strict_json_response_format",
    "verify_citations",
]


# @environment_variable AIQ_VERBOSE
# @category Debug
# @type bool
# @default false
# @required false
# Enable verbose logging output. Accepts true/1/yes or false/0/no.
def is_verbose(config_verbose: bool) -> bool:
    """Check if verbose mode is enabled via env var or config."""
    env_verbose = os.getenv("AIQ_VERBOSE", "").lower()
    if env_verbose in ("true", "1", "yes"):
        return True
    if env_verbose in ("false", "0", "no"):
        return False
    return config_verbose


def _create_chat_response(
    content: str,
    response_id: str = "conversational_response",
    model: str | None = None,
) -> ChatResponse:
    """Create a standardized ChatResponse object."""
    return ChatResponse(
        id=response_id,
        model=model or "unknown-model",
        choices=[
            ChatResponseChoice(
                index=0,
                message=ChoiceMessage(content=content, role=UserMessageContentRoleType.ASSISTANT),
                finish_reason="stop",
            )
        ],
        created=datetime.datetime.now(datetime.UTC),
        usage=Usage(),
    )


def is_postgres_dsn(value: str) -> bool:
    """Return True when the checkpoint DSN is a Postgres URL."""
    try:
        from urllib.parse import urlparse

        parsed = urlparse(value)
        return parsed.scheme in ("postgresql", "postgres")
    except ValueError:
        return value.startswith(("postgresql://", "postgres://"))


def _build_checkpointer_serde() -> JsonPlusSerializer:
    """Build the checkpointer serializer with an explicit msgpack allow-list.

    This flips the checkpointer from permissive to STRICT deserialization: only
    the listed pydantic state types may be reconstructed from a checkpoint. The
    list below is the complete set of custom pydantic types carried in
    ``ChatResearcherState`` (the shallow graph has no checkpointer). Any NEW
    pydantic state type MUST be added here or restore will break for it.
    """
    # Imported lazily to avoid a circular import: the agent state modules import
    # from ``aiq_agent.common`` at module load time.
    from aiq_agent.agents.chat_researcher.models.depth import DepthDecision
    from aiq_agent.agents.chat_researcher.models.intent import IntentResult
    from aiq_agent.agents.chat_researcher.models.result import ShallowResult
    from aiq_agent.knowledge.schema import AvailableDocument

    return JsonPlusSerializer(
        allowed_msgpack_modules=[IntentResult, DepthDecision, ShallowResult, AvailableDocument],
    )


async def get_checkpointer(checkpoint_db: str) -> BaseCheckpointSaver:
    """Return a shared checkpointer for the given database/DSN.

    This function caches checkpointers by database path/DSN to avoid
    creating multiple connections to the same database. It supports
    both SQLite (file path) and Postgres (DSN) backends.

    Args:
        checkpoint_db: SQLite database path or Postgres DSN.

    Returns:
        A configured and initialized checkpointer instance.
    """
    checkpointer = _checkpointers.get(checkpoint_db)
    if checkpointer is not None:
        return checkpointer

    async with _checkpointer_lock:
        # Re-check: another caller may have created it while we waited.
        checkpointer = _checkpointers.get(checkpoint_db)
        if checkpointer is not None:
            return checkpointer

        if is_postgres_dsn(checkpoint_db):
            pool = _postgres_pools.get(checkpoint_db)
            if pool is None:
                pool = AsyncConnectionPool(
                    conninfo=checkpoint_db,
                    min_size=1,
                    max_size=3,
                    kwargs={"autocommit": True, "row_factory": dict_row},
                )
                _postgres_pools[checkpoint_db] = pool
            checkpointer = AsyncPostgresSaver(pool, serde=_build_checkpointer_serde())
            await checkpointer.setup()
            logger.info("Postgres checkpointer initialized via async pool.")
        else:
            conn = await aiosqlite.connect(checkpoint_db)
            checkpointer = AsyncSqliteSaver(conn, serde=_build_checkpointer_serde())
            await checkpointer.setup()
            logger.info("SQLite checkpointer initialized: %s", checkpoint_db)

        _checkpointers[checkpoint_db] = checkpointer
        return checkpointer
