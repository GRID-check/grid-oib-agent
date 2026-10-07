"""Per-turn context: who is asking, and what the agent must know before it answers.

The three fetches — the platform-lessons digest, the live prompt context
(or legacy project-memory digest), and the post-answer stage flags — share
nothing but the request context, so they run as one ``asyncio.gather``: on a
cold cache each was a round-trip on the time-to-first-token path, paid one
after the other.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from dataclasses import replace
from typing import Any

from aiq_agent.auth import get_current_principal
from aiq_agent.common.platform_lessons import get_platform_lessons_digest
from aiq_agent.knowledge.project_memory import fetch_memory_digest
from aiq_agent.knowledge.restricted_collections import restricted_collections_in
from aiq_agent.knowledge.restricted_use import current_restricted_use
from aiq_agent.project_context import GridRequestContext
from aiq_agent.project_context import compose_project_context
from aiq_agent.project_context import get_user_message_id_from_context
from aiq_agent.stages import TurnFacts
from aiq_agent.stages.flags import TurnFlags
from aiq_agent.stages.flags import resolve_turn_flags
from aiq_agent.turn.context_client import ContextBlocks
from aiq_agent.turn.context_client import fetch_turn_context

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TurnContext:
    """What one turn injects into the agent, plus the request-scoped stage facts."""

    #: The intake profile plus the memory digest, composed the way the prompts read it.
    project_context: str | None
    #: The bounded PLATFORM_LESSONS digest, or None (fail-open, TTL-cached).
    platform_lessons: str | None
    #: The office's standing instructions for this turn, read off the request
    #: header or authenticated BFF response and already bounded.
    #: Its own field rather than part of ``project_context``: the profile is the
    #: project's hard facts, this is how the office wants to be answered, and
    #: they are rendered under different framing for that reason.
    org_instructions: str | None
    #: The request-scoped half of the post-answer stages' facts, captured while
    #: the request context is live — the stage tasks run after it is gone.
    stage_facts: TurnFacts
    #: Whether this turn may OFFER a deep-research run. False withdraws the
    #: hand-off before it is proposed, so the reader is never shown a plan whose
    #: approval the job queue would refuse. True on every failure path: see
    #: :class:`aiq_agent.stages.flags.TurnFlags`.
    deep_research_allowed: bool = True
    #: Whether this turn may hand work over (`create_task`). Its own flag, see
    #: :class:`aiq_agent.stages.flags.TurnFlags`.
    tasks_allowed: bool = True
    #: The restricted-folder collections this turn may draw on (ADR-0080,
    #: ADR-0081): those of its VERIFIED scope that the asker and everyone the
    #: conversation is shared with may read now. Non-empty makes the turn
    #: :attr:`confined`.
    restricted_scope: tuple[str, ...] = ()
    #: The conversation already drew on a folder not every member may read
    #: (in an earlier turn, or this turn's memory or subject), as the BFF
    #: recorded it; or that could not be established.
    recorded_restricted: bool = False

    @property
    def confined(self) -> bool:
        """The turn may draw on, or the conversation already drew on, a restricted folder (ADR-0080, ADR-0081).

        Such a conversation may not commission a run, hand work over or propose
        a profile patch, because each is read by the whole project, so both
        flags above are False whenever this is True. The BFF refuses all three
        on its own; this keeps the model from offering them.
        """
        return bool(self.restricted_scope) or self.recorded_restricted


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


def signed_restricted_collections(request: GridRequestContext) -> list[str]:
    """The restricted-folder collections this turn may draw on (ADR-0080, ADR-0081).

    What the live digest may serve restricted memory for. The BFF puts them in a
    scope only for an interactive chat turn of a session cleared for them; of
    those, the turn keeps the ones it may draw on with the conversation's
    current audience (:func:`aiq_agent.knowledge.restricted_use.begin_restricted_use`).
    A scope read from the unsigned header fallback (no envelope) gets none,
    because nothing vouches for it.
    """
    if not request.envelope_header:
        return []
    use = current_restricted_use()
    signed = restricted_collections_in(request.collection_scope)
    return signed if use is None else [name for name in signed if use.allows(name)]


def settle_restriction(context: TurnContext, request: GridRequestContext) -> TurnContext:
    """``context`` with the turn's restriction as it stands after setup.

    Called once the setup gather is done, because two of its members can
    confine the conversation on their own: restricted memory served into the
    digest, and a subject document in a restricted folder, are each recorded by
    the BFF and noted on the bound use. Withdraws deep research and tasks from
    a confined turn; a conversation that drew on a restricted folder stays
    refused for both (the BFF refuses them too).
    """
    use = current_restricted_use()
    drawable = tuple(signed_restricted_collections(request))
    recorded = bool(use is not None and use.confined)
    if not drawable and not recorded:
        return context
    return replace(
        context,
        restricted_scope=drawable,
        recorded_restricted=recorded,
        deep_research_allowed=False,
        tasks_allowed=False,
    )


async def _live_memory_digest(
    request: GridRequestContext,
    query_text: str,
    *,
    fallback: str | None = None,
) -> str | None:
    """This turn's project-memory digest.

    The digest header is frozen for the connection's life, so memory written
    mid-session would not reach the agent until a reconnect: re-fetch a LIVE
    digest per turn. A successful fetch is authoritative even when empty
    (memory may have been cleared); only a failed fetch keeps ``fallback``, the
    connection-time digest.
    """
    if not (request.project_id or request.organization_id):
        return fallback
    try:
        return await asyncio.to_thread(
            fetch_memory_digest,
            project_id=request.project_id,
            organization_id=request.organization_id,
            query=query_text,
            user_id=request.user_id,
            restricted_collections=signed_restricted_collections(request),
        )
    except (RuntimeError, OSError, ValueError):
        # The documented failure modes of fetch_memory_digest: configuration,
        # transport, and an unparseable body. Degrade to the connection-time digest.
        logger.warning("Live memory digest fetch failed; using connection-time digest", exc_info=True)
        return fallback


async def _bff_context_blocks(request: GridRequestContext, query_text: str) -> ContextBlocks:
    """The compact-handshake blocks, with restricted memory when this turn may draw on it.

    ``fetch_turn_context`` serves open memory only. A turn whose verified scope
    carries restricted-folder collections (ADR-0080, ADR-0081) also asks the live
    digest endpoint, the one that admits the restricted notes' folders for the
    conversation, and takes its digest instead: it is a superset of the open one.
    Both run at once so the extra round-trip is not paid in sequence; when the
    live fetch fails the open digest stands.
    """
    if not signed_restricted_collections(request):
        return await asyncio.to_thread(fetch_turn_context, request, query=query_text)
    blocks, live_digest = await asyncio.gather(
        asyncio.to_thread(fetch_turn_context, request, query=query_text),
        _live_memory_digest(request, query_text, fallback=None),
    )
    return replace(blocks, project_memory=live_digest if live_digest is not None else blocks.project_memory)


async def _context_blocks(request: GridRequestContext, query_text: str) -> ContextBlocks:
    if request.context_transport == "bff":
        return await _bff_context_blocks(request, query_text)
    memory_digest = await _live_memory_digest(request, query_text, fallback=request.project_memory)
    return ContextBlocks(request.project_context, memory_digest, request.org_instructions)


async def _turn_flags(request: GridRequestContext, resolve_stages: bool) -> TurnFlags:
    """What this turn may do, decided per TURN, not per socket.

    The feature header is written once at the WS upgrade and frozen, so an
    operator switching something off never reached an already-open tab — the
    opposite of what a kill switch is for.

    The round-trip is now skipped only when there is NO ORGANIZATION to evaluate
    against. It used to be skipped whenever no stage had a model to run on,
    because the answer could then change nothing; that stopped being true when
    the same call started carrying whether deep research may be offered, which
    is per-org and decides something on every turn. Without an organization both
    answers are the permissive defaults anyway — the BFF resolves an absent
    tenant the same way — so nothing is bought by asking.
    """
    if not request.organization_id:
        return TurnFlags(enabled_stages=frozenset())
    flags = await resolve_turn_flags(
        organization_id=request.organization_id,
        memory_reflection_enabled=request.memory_reflection_enabled,
        project_id=request.project_id,
    )
    if resolve_stages:
        return flags
    # No stage has a model to run on, so the stage half of the answer decides
    # nothing; the deep-research half still does.
    return TurnFlags(
        enabled_stages=frozenset(),
        deep_research_allowed=flags.deep_research_allowed,
        tasks_allowed=flags.tasks_allowed,
    )


async def _platform_lessons(conversation_id: str | None) -> str | None:
    """The bounded fleet-wide lessons digest, or None.

    Platform-scoped, so fetched regardless of project/org context; the module
    TTL-caches, so the per-turn cost is ~zero between refreshes and the thread
    hop only exists for the cold fetch. Fails open: a digest that could not be
    read is one the prompts do without.
    """
    try:
        return await asyncio.to_thread(get_platform_lessons_digest, conversation_id)
    except Exception:  # noqa: BLE001 - an advisory digest must never cost the turn
        logger.warning("Platform-lessons digest fetch failed; continuing without", exc_info=True)
        return None


async def _load_turn_context(
    request: GridRequestContext,
    *,
    conversation_id: str | None,
    query_text: str,
    resolve_stages: bool,
) -> TurnContext:
    platform_lessons, blocks, turn_flags = await asyncio.gather(
        _platform_lessons(conversation_id),
        _context_blocks(request, query_text),
        _turn_flags(request, resolve_stages),
    )
    return TurnContext(
        project_context=compose_project_context(blocks.project_context, blocks.project_memory),
        platform_lessons=platform_lessons,
        org_instructions=blocks.org_instructions,
        # The restriction is settled after the whole setup gather
        # (`settle_restriction`): the digest and the subject can each confine.
        deep_research_allowed=turn_flags.deep_research_allowed,
        tasks_allowed=turn_flags.tasks_allowed,
        stage_facts=TurnFacts(
            conversation_id=conversation_id,
            ws_parent_id=get_user_message_id_from_context(),
            organization_id=request.organization_id,
            project_id=request.project_id,
            user_id=request.user_id,
            # Reflect against the digest the agent actually saw this turn.
            memory_digest=blocks.project_memory,
            bundesland=request.bundesland,
            enabled_stages=turn_flags.enabled_stages,
        ),
    )


async def load_turn_context(
    request: GridRequestContext,
    *,
    conversation_id: str | None,
    query_text: str,
    resolve_stages: bool,
) -> TurnContext:
    """Gather everything the turn injects that lives behind a round-trip.

    Legacy context is fail-open as a whole. Each branch above already degrades
    on its own, but the composition can still raise (an unexpected error out of
    a reader, or out of ``compose_project_context``), and this call is one member
    of the setup gather: a dead branch must cost the LIVE CONTEXT, never the turn and
    never its siblings. The empty context is what a turn with no project and no
    memory already runs on. Compact BFF context is required: any load failure
    must fail the turn rather than silently answer without authenticated policy.
    """
    try:
        return await _load_turn_context(
            request, conversation_id=conversation_id, query_text=query_text, resolve_stages=resolve_stages
        )
    except Exception:  # noqa: BLE001 - only legacy requests can answer without context
        if request.context_transport == "bff":
            raise
        logger.warning("Project-context load failed; continuing without live context", exc_info=True)
        # Fail-open for the context, never for the restriction, which
        # `settle_restriction` applies to this context like any other.
        return TurnContext(
            project_context=None,
            platform_lessons=None,
            org_instructions=None,
            stage_facts=TurnFacts(),
        )
