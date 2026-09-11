"""The turn's document inventory: which collections it reads, what is in them,
and whether an upload is still being indexed.

Everything here is fail-open per collection and bounded in time: a missing
inventory costs the model a listing, a failed inventory must never cost the
reader an answer.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Iterable
from dataclasses import dataclass

from aiq_agent.common.profiler import profiled_span
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.turn_status import emit_documents_waiting
from aiq_agent.knowledge import get_available_documents_async
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.inventory import allocate_inventory_detailed
from aiq_agent.knowledge.inventory import set_inventory_drops
from aiq_agent.knowledge.inventory import set_norm_families
from aiq_agent.knowledge.inventory import stamp_document
from aiq_agent.knowledge.scoping import ScopedCollection
from aiq_agent.turn.admission import spanned

logger = logging.getLogger(__name__)

#: How long a turn holds for an upload still being indexed, in seconds.
#: Ingestion of one PDF is seconds; a large plan set is minutes, and a turn
#: that waits minutes is a hung chat. Twenty covers the common attachment and
#: lets the rest fall through to the "still being read" paragraph, which tells
#: the model to say so. Operators tune it with GRID_INGEST_WAIT_SECONDS.
INGEST_WAIT_SECONDS_DEFAULT = 20.0
INGEST_POLL_SECONDS = 1.0
AVAILABLE_DOCUMENTS_DEFAULT_LIMIT = 50

FetchOne = Callable[[str], Awaitable[list]]
ReadInFlight = Callable[[list[str]], dict[str, list[str]]]


def available_documents_limit() -> int:
    """Top-N cap for the per-turn ``available_documents`` prompt block.

    Every chat turn injects the full list into ~5 prompt templates, so per-turn
    LLM cost grew linearly with the corpus, paid even on chit-chat.
    ``GRID_AVAILABLE_DOCUMENTS_MAX`` (default 50) tunes it; 0/negative disables.
    """
    raw = os.environ.get("GRID_AVAILABLE_DOCUMENTS_MAX", "")
    try:
        return int(raw) if raw.strip() else AVAILABLE_DOCUMENTS_DEFAULT_LIMIT
    except ValueError:
        logger.warning(
            "GRID_AVAILABLE_DOCUMENTS_MAX=%r is not an integer; using %d", raw, AVAILABLE_DOCUMENTS_DEFAULT_LIMIT
        )
        return AVAILABLE_DOCUMENTS_DEFAULT_LIMIT


def ingest_wait_seconds() -> float:
    raw = os.environ.get("GRID_INGEST_WAIT_SECONDS")
    if raw is None or not raw.strip():
        return INGEST_WAIT_SECONDS_DEFAULT
    try:
        return max(0.0, float(raw))
    except ValueError:
        logger.warning("GRID_INGEST_WAIT_SECONDS=%r is not a number; using %s", raw, INGEST_WAIT_SECONDS_DEFAULT)
        return INGEST_WAIT_SECONDS_DEFAULT


def session_collection_name(conversation_id: str) -> str:
    return conversation_id if conversation_id.startswith("s_") else f"s_{conversation_id}"


def base_collection_name() -> str:
    return os.environ.get("COLLECTION_NAME") or os.environ.get("OIB_COLLECTION_NAME") or "oib_knowledge"


def fallback_scope(conversation_id: str | None) -> list[ScopedCollection]:
    """The collections a turn reads when the request states no scope: the base
    OIB corpus and this conversation's upload collection. The fallback BUILDS
    these layers, so each shelf is known structurally, never guessed from a name."""
    scope = [ScopedCollection(base_collection_name(), Shelf.BASE)]
    if not conversation_id:
        return scope
    session = session_collection_name(conversation_id)
    if session != scope[0].collection:
        scope.append(ScopedCollection(session, Shelf.SESSION))
    return scope


def resolve_scope(header_scope: list[ScopedCollection] | None, conversation_id: str | None) -> list[ScopedCollection]:
    """The signed header scope when it names anything, else the fallback."""
    return list(header_scope) if header_scope else fallback_scope(conversation_id)


def shelves_in_scope(scope: Iterable[ScopedCollection]) -> list[str]:
    """The shelves the scope states, for the pre-graph status line."""
    return [str(entry.shelf) for entry in scope if entry.shelf is not None]


def _base_families(docs: Iterable) -> list:
    """The Richtlinien-Familien the BASE shelf holds, derived from its filenames.

    Base shelf only: a project file called ``oib-rl_2.pdf`` is somebody's copy
    of a Richtlinie, not a member of the platform corpus, and counting it would
    tell the model a part exists that a search of the corpus cannot reach.
    """
    from aiq_agent.common.norm_registry import oib_families

    names = [
        getattr(doc, "file_name", "")
        for doc in docs
        if getattr(doc, "shelf", None) is Shelf.BASE and getattr(doc, "file_name", "")
    ]
    return oib_families(names)


async def aggregate_documents_across_collections(
    collections: Iterable[ScopedCollection],
    fetch_one: FetchOne,
    max_documents: int | None = None,
) -> list:
    """Concurrently load document summaries for each collection and merge them.

    Each row is stamped with the collection it came from and the shelf the scope
    stated. Identity is ``(collection, file_name)`` — the same filename on the
    Büroarchiv and in a project is two documents (ADR-0047). The cap keeps
    user-shelf files first so the OIB corpus cannot evict the archive;
    ``0``/negative disables it.

    Fail-open per collection: a ``fetch_one`` that raises contributes an empty
    list rather than failing the whole aggregation.
    """

    async def _guarded(entry: ScopedCollection):
        try:
            return entry, await fetch_one(entry.collection)
        except Exception as exc:  # noqa: BLE001 - one shelf's outage must not empty the others
            logger.warning("No document summaries for collection %s: %s", entry.collection, exc)
            return entry, []

    # gather preserves input order, so stamping still follows the scope order.
    per_collection = await asyncio.gather(*(_guarded(entry) for entry in collections))
    aggregated = [
        stamp_document(doc, collection=entry.collection, shelf=entry.shelf)
        for entry, docs in per_collection
        for doc in docs or []
    ]

    # BEFORE the cap. Which parts a Richtlinie has is derived from the base
    # shelf, and the cap drops base rows first — so a family list taken after
    # it would lose members on exactly the projects with the most files, and
    # an incomplete family list reads as a complete one.
    set_norm_families(_base_families(aggregated))

    limit = available_documents_limit() if max_documents is None else max_documents
    before = len(aggregated)
    aggregated, dropped = allocate_inventory_detailed(aggregated, limit)
    # Tell the MODEL, not only the operator: the contextvar is what puts
    # "and N more" into the rendered block, so the agent can say a listing is
    # incomplete instead of presenting a truncated shelf as the whole shelf.
    set_inventory_drops(dropped)
    if limit and limit > 0 and before > len(aggregated):
        logger.info("Capping available_documents from %d to %d (GRID_AVAILABLE_DOCUMENTS_MAX)", before, len(aggregated))
    return aggregated


async def load_available_documents(scope: list[ScopedCollection], fetch_one: FetchOne) -> list | None:
    """The scope's document summaries, or None when there are none."""
    aggregated = await aggregate_documents_across_collections(scope, fetch_one)
    names = [entry.collection for entry in scope]
    if not aggregated:
        logger.info("No document summaries in DB for collections %s", names)
        return None
    logger.info("Loaded %d document summaries across collections %s", len(aggregated), names)
    return aggregated


async def await_ingest_settling(
    scope_names: list[str],
    pending: dict[str, list[str]],
    *,
    read: ReadInFlight,
    timeout_seconds: float | None = None,
    poll_seconds: float = INGEST_POLL_SECONDS,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> dict[str, list[str]]:
    """Hold until the in-flight files in ``scope_names`` finish, or the deadline.

    ``read`` is ``ingest_status_store.in_flight_files`` (sync, never raises,
    run on a thread); a parameter so the loop can be driven by a test without
    a database. Emits one status line when the wait begins — the reader is
    told why the first byte is late — and returns whatever is STILL pending at
    the end: empty when everything finished, the remaining names otherwise.
    """
    if not pending:
        return pending
    budget = ingest_wait_seconds() if timeout_seconds is None else timeout_seconds
    if budget <= 0:
        return pending
    emit_documents_waiting(file_count=sum(len(names) for names in pending.values()))

    loop = asyncio.get_running_loop()
    deadline = loop.time() + budget
    current = pending
    while current and loop.time() < deadline:
        await sleep(min(poll_seconds, max(0.0, deadline - loop.time())))
        current = await asyncio.to_thread(read, scope_names)
    if current:
        logger.info(
            "Ingest wait expired after %.0fs with %d file(s) still pending", budget, sum(map(len, current.values()))
        )
    else:
        logger.info("Ingest wait cleared: the turn proceeds with the new file(s) indexed")
    return current


def in_flight_names(pending: dict[str, list[str]]) -> list[str]:
    """The pending filenames across collections, first occurrence wins."""
    names: list[str] = []
    for batch in pending.values():
        names.extend(name for name in batch if name not in names)
    return names


@dataclass(frozen=True)
class Inventory:
    """What the turn can read, and what it cannot read YET.

    The distinction matters: without ``in_flight_documents`` a just-attached
    plan looks exactly like a file that does not exist, and the answer omits
    it silently instead of saying it could not be read yet.
    """

    available_documents: list | None
    in_flight_documents: list[str] | None


async def load_inventory(
    scope: list[ScopedCollection],
    *,
    fetch_one: FetchOne | None = None,
    read_in_flight: ReadInFlight | None = None,
    timeout_seconds: float | None = None,
) -> Inventory:
    """The inventory for ``scope``, holding (bounded) for an upload still indexing.

    Fail-open: this is one member of the turn's setup gather, so an inventory
    that cannot be built costs the INVENTORY (the model answers without the
    file list, exactly as it does for a scope with no documents) and never the
    turn or its sibling branches. The per-collection reads already degrade on
    their own; this catches what is left — the in-flight read, and the wait.
    """
    try:
        return await _load_inventory(
            scope, fetch_one=fetch_one, read_in_flight=read_in_flight, timeout_seconds=timeout_seconds
        )
    except Exception:  # noqa: BLE001 - see above; an answer without the inventory beats no answer
        logger.warning("Document inventory load failed; continuing without one", exc_info=True)
        return Inventory(None, None)


async def _load_inventory(
    scope: list[ScopedCollection],
    *,
    fetch_one: FetchOne | None = None,
    read_in_flight: ReadInFlight | None = None,
    timeout_seconds: float | None = None,
) -> Inventory:
    """The in-flight read runs INSIDE the gather with the summaries read — it is
    independent of it and small, and gather already waits for the slowest
    member. Only the wait loop runs after. A file that settled while we waited
    was absent from the summaries table when the inventory was built, so the
    inventory is rebuilt once.
    """
    # Resolved at call time, not bound as defaults, so a test can patch the
    # module's reads without standing up a database.
    fetch_one = fetch_one or get_available_documents_async
    read_in_flight = read_in_flight or ingest_status_store.in_flight_files
    names = [entry.collection for entry in scope]
    documents, pending = await asyncio.gather(
        spanned("setup.available_documents", load_available_documents(scope, fetch_one)),
        spanned("setup.ingest_status", asyncio.to_thread(read_in_flight, names)),
    )
    if not pending:
        return Inventory(documents, None)
    # HOLD THE TURN. A file attached seconds ago is invisible to retrieval
    # until its job finishes, and an answer written without it is wrong in the
    # one way the reader cannot see. Its own span: the hold is a decision, and
    # the one setup cost that is minutes rather than milliseconds.
    with profiled_span("setup.ingest_wait"):
        settled = await await_ingest_settling(names, pending, read=read_in_flight, timeout_seconds=timeout_seconds)
        if settled != pending:
            documents = await load_available_documents(scope, fetch_one)
    return Inventory(documents, in_flight_names(settled) or None)
