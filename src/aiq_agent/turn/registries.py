"""The per-turn ContextVar registries, bound for exactly the life of one turn.

Four things a tool or prompt reaches through a ContextVar during the turn —
the citation registry, the card registry, the image-view budget and the
memory-write log — are bound here and unbound in one place, so no one of them
can outlive the turn or leak into the next.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from dataclasses import field

from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import get_or_create_card_registry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import persist_session_registry
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.image_view_budget import begin_image_view_budget
from aiq_agent.common.image_view_budget import end_image_view_budget
from aiq_agent.knowledge.project_memory import begin_turn_memory_log
from aiq_agent.knowledge.project_memory import end_turn_memory_log
from aiq_agent.knowledge.project_memory import turn_memory_writes

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


@asynccontextmanager
async def turn_registries(conversation_id: str, session_registry: SourceRegistry) -> AsyncIterator[TurnRegistries]:
    """Bind the four per-turn registries; unbind and persist on exit, however it exits."""
    cards = get_or_create_card_registry(conversation_id)
    cards.clear()
    registries = TurnRegistries(cards=cards)
    session_token = set_session_registry(session_registry)
    card_token = set_card_registry(cards)
    image_token = begin_image_view_budget()
    memory_token = begin_turn_memory_log()
    try:
        yield registries
    finally:
        registries.memory_writes = turn_memory_writes()
        end_turn_memory_log(memory_token)
        end_image_view_budget(image_token)
        reset_card_registry(card_token)
        reset_session_registry(session_token)
        schedule_registry_persist(conversation_id)


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
