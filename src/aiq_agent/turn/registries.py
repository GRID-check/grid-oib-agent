"""The per-turn ContextVar registries, bound for exactly the life of one turn.

Five things a tool or prompt reaches through a ContextVar during the turn —
the citation registry, the card registry, the image-view budget, the
memory-write log and the restricted notes earlier turns were shown — are bound
here and unbound in one place, so no one of them can outlive the turn or leak
into the next.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from collections.abc import Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from dataclasses import field

from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import get_or_create_card_registry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import get_or_create_session_registry
from aiq_agent.common.citation_verification import persist_session_registry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.image_view_budget import begin_image_view_budget
from aiq_agent.common.image_view_budget import end_image_view_budget
from aiq_agent.knowledge.project_memory import begin_turn_memory_log
from aiq_agent.knowledge.project_memory import end_turn_memory_log
from aiq_agent.knowledge.project_memory import turn_memory_writes
from aiq_agent.knowledge.project_memory import turn_restricted_memory_writes
from aiq_agent.memory.restriction import restricted_digest_notes
from aiq_agent.memory.shown_notes import ShownNotes
from aiq_agent.memory.shown_notes import bind_shown_notes
from aiq_agent.memory.shown_notes import load_shown_notes
from aiq_agent.memory.shown_notes import merged
from aiq_agent.memory.shown_notes import schedule_shown_notes_persist
from aiq_agent.memory.shown_notes import unbind_shown_notes

logger = logging.getLogger(__name__)


@dataclass
class TurnRegistries:
    """The registries bound for this turn, and what they recorded once it ended."""

    #: The conversation's card registry, cleared at turn start so a card never
    #: leaks between turns; ``snapshot()`` after the turn is the turn's cards.
    cards: CardRegistry
    #: What the ``remember`` tool wrote DURING the turn. Filled when the
    #: context exits — the log is unbound at that moment.
    memory_writes: tuple[str, ...] = field(default_factory=tuple)
    #: The part of ``memory_writes`` stored as restricted memory (ADR-0080).
    restricted_memory_writes: tuple[str, ...] = field(default_factory=tuple)
    #: The retrieval collections of every source the conversation's citation
    #: registry holds once the turn ended — this turn's and the earlier ones,
    #: whose passages are in the history. Read by the memory restriction
    #: decision (ADR-0080). Filled when the context exits.
    source_collections: tuple[str, ...] = field(default_factory=tuple)
    #: The restricted memory EARLIER turns of the conversation were shown, with
    #: their collections (ADR-0080, ``memory/shown_notes.py``). Read by the
    #: memory restriction decision; bound for the ``remember`` tool as well.
    shown_notes: ShownNotes = field(default_factory=ShownNotes)


async def load_session_registry(conversation_id: str | None) -> SourceRegistry:
    """Hydrate the conversation's citation registry off the event loop, fail-open.

    The hydrating read is a blocking cache round-trip (a cold-cache socket
    timeout on Dragonfly), so it rides a thread. On ANY failure a fresh
    registry is returned: the turn keeps its citations isolated rather than
    dying without an answer, and the failure cannot lose the other setup
    branches it is gathered with.
    """
    try:
        return await asyncio.to_thread(get_or_create_session_registry, conversation_id)
    except Exception:  # noqa: BLE001 - a cold cache must not cost the turn its answer
        logger.warning("Session registry hydration failed; using a fresh registry", exc_info=True)
        return SourceRegistry()


async def load_turn_shown_notes(conversation_id: str | None) -> ShownNotes:
    """The restricted notes earlier turns were shown, off the event loop; empty on any failure."""
    try:
        return await asyncio.to_thread(load_shown_notes, conversation_id)
    except Exception:  # noqa: BLE001 - a cold cache must not cost the turn its answer
        logger.warning("Loading the restricted notes shown earlier failed; starting from none", exc_info=True)
        return ShownNotes()


def _registry_collections(registry: SourceRegistry) -> tuple[str, ...]:
    """The distinct collections of a citation registry's sources; empty on any fault."""
    try:
        return tuple(dict.fromkeys(source.collection for source in registry.all_sources() if source.collection))
    except Exception:  # noqa: BLE001 - a stage fact is never worth a failed turn
        logger.warning("Could not read the citation registry's collections", exc_info=True)
        return ()


@asynccontextmanager
async def turn_registries(
    conversation_id: str,
    session_registry: SourceRegistry,
    *,
    memory_digest: str | None = None,
    shown_notes: ShownNotes | None = None,
    restricted_scope: Sequence[str] = (),
) -> AsyncIterator[TurnRegistries]:
    """Bind the five per-turn registries; unbind and persist on exit, however it exits.

    ``memory_digest`` is the memory digest the agent is shown this turn; the
    memory log keeps it for the ``remember`` tool (ADR-0080). ``shown_notes`` is
    what earlier turns were shown of restricted memory, and
    ``restricted_scope`` the restricted collections of this turn's signed
    scope: on exit this turn's restricted lines and restricted writes are added
    to the record under them, so a later turn still counts them as evidence.
    """
    earlier = shown_notes or ShownNotes()
    cards = get_or_create_card_registry(conversation_id)
    cards.clear()
    registries = TurnRegistries(cards=cards, shown_notes=earlier)
    session_token = set_session_registry(session_registry)
    card_token = set_card_registry(cards)
    image_token = begin_image_view_budget()
    memory_token = begin_turn_memory_log(memory_digest)
    shown_token = bind_shown_notes(earlier)
    try:
        yield registries
    finally:
        registries.memory_writes = turn_memory_writes()
        registries.restricted_memory_writes = turn_restricted_memory_writes()
        registries.source_collections = _registry_collections(session_registry)
        unbind_shown_notes(shown_token)
        end_turn_memory_log(memory_token)
        end_image_view_budget(image_token)
        reset_card_registry(card_token)
        reset_session_registry(session_token)
        schedule_registry_persist(conversation_id)
        shown_now = [*restricted_digest_notes(memory_digest), *registries.restricted_memory_writes]
        if shown_now and restricted_scope:
            schedule_shown_notes_persist(conversation_id, merged(earlier, shown_now, restricted_scope))


# Strong references to in-flight persistence tasks so the event loop cannot
# garbage-collect them mid-run. Entries discard themselves on completion.
_persist_tasks: set[asyncio.Task] = set()


async def _persist(conversation_id: str) -> None:
    try:
        await asyncio.to_thread(persist_session_registry, conversation_id)
    except Exception:  # noqa: BLE001 - a background write; there is nobody left to raise to
        logger.warning("Citation registry persistence failed for %s", conversation_id, exc_info=True)


def schedule_registry_persist(conversation_id: str) -> None:
    """Persist the turn's citation registry to the shared cache off the TTFT path.

    Best-effort (ADR-0020 cross-replica/restart source recovery): nothing
    downstream reads its result, so it must not sit between "answer ready"
    and the first streamed token.
    """
    task = asyncio.get_running_loop().create_task(_persist(conversation_id))
    _persist_tasks.add(task)
    task.add_done_callback(_persist_tasks.discard)


def pending_persist_tasks() -> frozenset[asyncio.Task]:
    """The persistence tasks still running (for tests and shutdown)."""
    return frozenset(_persist_tasks)
