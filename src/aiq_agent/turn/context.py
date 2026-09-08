"""Per-turn context: who is asking, and what the agent must know before it answers.

The three fetches — the platform-lessons digest, the live project-memory
digest, and the post-answer stage flags — share nothing but the request
context, so they run as one ``asyncio.gather``: on a cold cache each was a
round-trip on the time-to-first-token path, paid one after the other.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Any

from aiq_agent.auth import get_current_principal
from aiq_agent.common.platform_lessons import get_platform_lessons_digest
from aiq_agent.knowledge.project_memory import fetch_memory_digest
from aiq_agent.project_context import GridRequestContext
from aiq_agent.project_context import compose_project_context
from aiq_agent.project_context import get_user_message_id_from_context
from aiq_agent.stages import TurnFacts
from aiq_agent.stages.flags import resolve_enabled_stages

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TurnContext:
    """What one turn injects into the agent, plus the request-scoped stage facts."""

    #: The intake profile plus the memory digest, composed the way the prompts read it.
    project_context: str | None
    #: The bounded PLATFORM_LESSONS digest, or None (fail-open, TTL-cached).
    platform_lessons: str | None
    #: The request-scoped half of the post-answer stages' facts, captured while
    #: the request context is live — the stage tasks run after it is gone.
    stage_facts: TurnFacts


def thread_id_for_turn(conversation_id: str | None) -> str:
    """The checkpoint thread: the conversation id, or a fresh one when the
    request carries none (a single-shot call has no history to load)."""
    if conversation_id:
        logger.info("Thread ID for checkpointing: %s", conversation_id)
        return conversation_id
    generated = str(uuid.uuid4())
    logger.info("No conversation-id header; generated thread ID: %s", generated)
    return generated


def turn_identity(request: GridRequestContext, conversation_id: str | None) -> dict[str, str | None]:
    """Who the turn is for, in the shape the cost and profiler ledgers take.

    Handed to both explicitly: left to their defaults, each re-reads the
    signed envelope through the accessor helpers (base64 + HMAC-SHA256 + JSON,
    three more times per turn) to learn what the one parse already knows.
    """
    return {
        "organization_id": request.organization_id,
        "user_id": request.user_id,
        "project_id": request.project_id,
        "conversation_id": conversation_id,
    }


def user_info_from_principal() -> dict[str, Any] | None:
    """The authenticated caller as the prompts' ``user_info``, or None when anonymous."""
    principal = get_current_principal()
    if principal is None:
        return None
    return {"name": principal.name, "email": principal.email}


async def _live_memory_digest(request: GridRequestContext, query_text: str) -> str | None:
    """This turn's project-memory digest.

    The digest header is frozen for the connection's life, so memory written
    mid-session would not reach the agent until a reconnect: re-fetch a LIVE
    digest per turn. A successful fetch is authoritative even when empty
    (memory may have been cleared); only a failed fetch keeps the header value.
    """
    if not (request.project_id or request.organization_id):
        return request.project_memory
    try:
        return await asyncio.to_thread(
            fetch_memory_digest,
            project_id=request.project_id,
            organization_id=request.organization_id,
            query=query_text,
        )
    except (RuntimeError, OSError, ValueError):
        # The documented failure modes of fetch_memory_digest: configuration,
        # transport, and an unparseable body. Degrade to the connection-time digest.
        logger.warning("Live memory digest fetch failed; using connection-time digest", exc_info=True)
        return request.project_memory


async def _enabled_stages(request: GridRequestContext, resolve: bool) -> frozenset[str]:
    """Which post-answer stages are on, decided per TURN, not per socket.

    The feature header is written once at the WS upgrade and frozen, so an
    operator switching a stage off never reached an already-open tab — the
    opposite of what a kill switch is for. Skipped entirely when no stage has
    a model to run on: the flag would decide nothing, and a deployment that
    compiled the stages out must not pay a round-trip per turn for the privilege.
    """
    if not resolve:
        return frozenset()
    return await resolve_enabled_stages(
        organization_id=request.organization_id,
        memory_reflection_enabled=request.memory_reflection_enabled,
    )


async def load_turn_context(
    request: GridRequestContext,
    *,
    conversation_id: str | None,
    query_text: str,
    resolve_stages: bool,
) -> TurnContext:
    """Gather everything the turn injects that lives behind a round-trip."""
    platform_lessons, memory_digest, enabled_stages = await asyncio.gather(
        asyncio.to_thread(get_platform_lessons_digest, conversation_id),
        _live_memory_digest(request, query_text),
        _enabled_stages(request, resolve_stages),
    )
    return TurnContext(
        project_context=compose_project_context(request.project_context, memory_digest),
        platform_lessons=platform_lessons,
        stage_facts=TurnFacts(
            conversation_id=conversation_id,
            ws_parent_id=get_user_message_id_from_context(),
            organization_id=request.organization_id,
            project_id=request.project_id,
            user_id=request.user_id,
            # Reflect against the digest the agent actually saw this turn.
            memory_digest=memory_digest,
            bundesland=request.bundesland,
            enabled_stages=enabled_stages,
        ),
    )
