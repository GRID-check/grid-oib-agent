"""The per-conversation working directory, as a DeepAgents backend.

What this is
------------
``ls``/``read_file``/``write_file``/``edit_file`` over a LangGraph ``BaseStore``
namespaced by conversation. The tools themselves are stock DeepAgents
(:mod:`aiq_agent.tools.documents.tools`); this module is the storage half:
where the bytes live, what a path may be, how much a conversation may keep, and
the one correction the stock backend needs.

**The one correction is NFC.** ``Gebäudeklasse`` typed decomposed (``a`` + U+0308)
and the same word typed composed are different strings, so an ``edit_file``
whose ``old_string`` was typed by the model one way against a file written the
other way fails with ``String not found in file: 'Gebäudeklasse'`` — an error
that prints a string identical to the one in the file, so the model retries the
same bytes. Everything stored and everything matched against it is normalised
here, at the one seam both verbs pass through. The repo paid for this once
already in ``documentNameKey`` (``session-documents/service.ts``).

What this is NOT
----------------
A document. Nothing here creates a ``documents`` row, is indexed, or can be
cited; a draft becomes a project document only through the lifecycle API, which
a person gates. The working directory is the desk, not the file cabinet.

Storage
-------
``langgraph.store.postgres.AsyncPostgresStore`` on the Python service's own
checkpoint database (``AIQ_CHECKPOINT_DB``), sharing the pool the checkpointer
already opens. No table in ``grid_app``: the single-writer rule holds. A
non-Postgres DSN (the SQLite dev fallback) gets an ``InMemoryStore`` instead,
and says once that drafts do not survive a restart.
"""

from __future__ import annotations

import asyncio
import logging
import os
import unicodedata
from dataclasses import dataclass
from dataclasses import field

from deepagents.backends.protocol import EditResult
from deepagents.backends.protocol import WriteResult
from deepagents.backends.store import StoreBackend
from langgraph.store.base import BaseStore
from langgraph.store.base import Item

from aiq_agent.common import is_postgres_dsn

from .cards import emit_draft_card

logger = logging.getLogger(__name__)

#: The one directory the working directory has. German because the model writes
#: German documents and the path is shown to the reader on the draft card; one
#: root because a tree the model invents is a tree nobody else can find. Every
#: write and every edit is refused outside it, by the backend AND by a
#: ``FilesystemPermission`` on the tools (``tools.py``), so neither side is the
#: only thing standing between a draft and ``/etc``.
DRAFT_ROOT = "/entwuerfe/"

#: Byte ceiling for ONE conversation's working directory, across all its files.
#:
#: A page of German Markdown is roughly 3 KB, so a commissioned Aktenvermerk or
#: Protokoll is 3–15 KB and the longest thing a chat turn is asked for — a
#: Flächenaufstellung with a table per Geschoß — stays under 50 KB. Five such
#: documents, each revised a few times, is already an unusual conversation, so
#: 256 KB is about five times the honest worst case while still being small
#: enough that a model looping on ``write_file`` cannot grow the checkpoint
#: database on its own.
#:
#: It refuses rather than truncates: a silently shortened draft is a lie about
#: what was written, and the model cannot see the truncation to correct it.
MAX_DRAFT_BYTES = 256 * 1024

#: Version counter stamped on the stored item after every successful write or
#: edit. Not read by DeepAgents (it converts only ``content``/``encoding``/the
#: timestamps), so it rides along without changing what the tools see.
VERSION_KEY = "grid_draft_version"

#: Where a filed draft's project document is remembered, on the stored item and
#: beside the version counter.
#:
#: One conversation writing „Aktenvermerk" twice must land on ONE document with
#: two versions, so the second ``file_draft`` of a path has to know the document
#: the first one created. The BFF's own idempotency key (``{conversation}-{slug}``)
#: would answer "is this already filed" but not "which open version do I replace,
#: and against what content hash" — the ``update`` op needs both, and an
#: If-Match it had to guess would either clobber a reviewer's edit or fail.
#:
#: They live on the stored VALUE and therefore have to be re-stamped after every
#: write and edit: DeepAgents rebuilds the value from ``content``/``encoding``,
#: so a key not written back after the operation is gone (``AGENTS.md``). That
#: is what :meth:`DraftBackend._record` carries through, and what
#: :func:`usage_from_items` reads back out.
FILED_DOCUMENT_KEY = "grid_filed_document_id"
FILED_VERSION_KEY = "grid_filed_version_id"
FILED_HASH_KEY = "grid_filed_content_hash"
#: The editorial state the BFF last reported for that version. Stored rather than
#: re-fetched because the card the NEXT ``edit_file`` emits has to say whether the
#: draft is still submittable, and a card that had to make a round trip to find
#: out would be a card that renders late or wrong.
FILED_STATE_KEY = "grid_filed_state"

#: The four together, in the order a reader meets them.
FILING_KEYS = (FILED_DOCUMENT_KEY, FILED_VERSION_KEY, FILED_HASH_KEY, FILED_STATE_KEY)

#: Store rows read per page while totalling a conversation's bytes. The ceiling
#: above bounds the real number far below this; the page size only decides how
#: many round trips an unusual conversation costs.
_PAGE_SIZE = 100

_DSN_ENV = "AIQ_CHECKPOINT_DB"

_stores: dict[str, BaseStore] = {}
#: Serialises store creation: ``setup()`` is an await, so a bare check-then-act
#: would let two concurrent turns both run the DDL and leak the loser's store.
_store_lock = asyncio.Lock()


def draft_namespace(conversation_id: str) -> tuple[str, str, str]:
    """The store namespace holding one conversation's drafts."""
    return ("conversation", conversation_id, "drafts")


def normalize_draft_text(text: str) -> str:
    """NFC-normalise text on its way into or against the store. See the module docstring."""
    if not text:
        return text
    return unicodedata.normalize("NFC", text)


def draft_bytes(text: str) -> int:
    """Size of a draft as stored, in UTF-8 bytes."""
    return len(text.encode("utf-8"))


@dataclass(frozen=True)
class DraftUsage:
    """What the store already holds, as the guards need to see it."""

    #: Bytes across every file in this conversation's namespace.
    total_bytes: int
    #: Current content of the path being written, or ``None`` when it is new.
    content: str | None
    #: Times that path has been written or edited so far.
    version: int
    #: The project document this path was filed as, if it has been: the three
    #: :data:`FILING_KEYS` as stored. Empty when the draft has never been filed.
    filing: dict[str, str] = field(default_factory=dict)


def filing_from_value(value: dict) -> dict[str, str]:
    """The filing keys of one stored item, dropping anything unset or not a string."""
    return {key: value[key] for key in FILING_KEYS if isinstance(value.get(key), str) and value[key]}


def usage_from_items(items: list[Item], file_path: str) -> DraftUsage:
    """Total the namespace and pick out the target path's current state."""
    total = 0
    content: str | None = None
    version = 0
    filing: dict[str, str] = {}
    for item in items:
        raw = item.value.get("content")
        text = "\n".join(raw) if isinstance(raw, list) else str(raw or "")
        total += draft_bytes(text)
        if str(item.key) == file_path:
            content = text
            version = int(item.value.get(VERSION_KEY) or 0)
            filing = filing_from_value(item.value)
    return DraftUsage(total_bytes=total, content=content, version=version, filing=filing)


def path_refusal(file_path: str) -> str | None:
    """The model-facing refusal for a path outside the working directory, or ``None``."""
    if file_path.startswith(DRAFT_ROOT) and ".." not in file_path:
        return None
    return (
        f"Cannot write to {file_path} because this conversation's working directory only holds "
        f"files under {DRAFT_ROOT}. Write to {DRAFT_ROOT}<name>.md instead."
    )


def ceiling_refusal(projected_bytes: int, file_path: str) -> str | None:
    """The model-facing refusal for a write that would blow the ceiling, or ``None``."""
    if projected_bytes <= MAX_DRAFT_BYTES:
        return None
    return (
        f"Cannot write to {file_path} because this conversation's working directory would exceed its "
        f"limit of {MAX_DRAFT_BYTES // 1024} KB ({projected_bytes // 1024} KB after this change). "
        "Shorten the document, or edit the existing file instead of writing another copy."
    )


def write_refusal(usage: DraftUsage, file_path: str, content: str) -> str | None:
    """Why this ``write_file`` cannot happen, or ``None``."""
    refusal = path_refusal(file_path)
    if refusal is not None:
        return refusal
    projected = usage.total_bytes - draft_bytes(usage.content or "") + draft_bytes(content)
    return ceiling_refusal(projected, file_path)


def edit_refusal(
    usage: DraftUsage, file_path: str, old_string: str, new_string: str, *, replace_all: bool
) -> str | None:
    """Why this ``edit_file`` cannot happen, or ``None``.

    The growth is projected from the occurrence count rather than from the
    edited text, so the replacement itself — and every error DeepAgents already
    words for it (not found, not unique, the trailing-newline hint) — stays
    where it is.
    """
    refusal = path_refusal(file_path)
    if refusal is not None:
        return refusal
    if usage.content is None:
        return None
    occurrences = usage.content.count(old_string) if replace_all else 1
    growth = occurrences * (draft_bytes(new_string) - draft_bytes(old_string))
    return ceiling_refusal(usage.total_bytes + growth, file_path)


class DraftBackend(StoreBackend):
    """A ``StoreBackend`` pinned to one conversation, NFC-normalising and bounded.

    Four overrides, two of them the async twin of the other two, because the
    tools call whichever half the graph is running (Piloti is async;
    the sync path exists so the invariant does not depend on that staying true).
    """

    def __init__(self, *, store: BaseStore, conversation_id: str) -> None:
        super().__init__(store=store, namespace=lambda _runtime: draft_namespace(conversation_id))
        self.conversation_id = conversation_id

    # -- reading what is already there -----------------------------------------

    def _usage(self, file_path: str) -> DraftUsage:
        store = self._get_store()
        namespace = self._get_namespace()
        items = self._search_store_paginated(store, namespace, page_size=_PAGE_SIZE)
        return usage_from_items(items, file_path)

    async def _ausage(self, file_path: str) -> DraftUsage:
        store = self._get_store()
        namespace = self._get_namespace()
        items: list[Item] = []
        offset = 0
        while True:
            page = await store.asearch(namespace, limit=_PAGE_SIZE, offset=offset)
            items.extend(page)
            if len(page) < _PAGE_SIZE:
                break
            offset += _PAGE_SIZE
        return usage_from_items(items, file_path)

    # -- what a successful verb leaves behind ----------------------------------

    def _record(self, file_path: str, version: int, filing: dict[str, str]) -> None:
        """Stamp the new version on the stored item and put the draft card up.

        ``filing`` is re-stamped and not merely preserved: DeepAgents rebuilt the
        stored value from ``content``/``encoding`` a moment ago, so whatever the
        item carried before the write is already gone. Losing it would mean the
        next ``file_draft`` of an edited draft filed a SECOND document instead of
        a second version of the first.
        """
        store = self._get_store()
        namespace = self._get_namespace()
        item = store.get(namespace, file_path)
        if item is None:
            return
        value = {**item.value, VERSION_KEY: version, **filing}
        store.put(namespace, file_path, value)
        emit_draft_card(
            path=file_path,
            content=str(value.get("content") or ""),
            version=version,
            filing=filing,
        )

    async def _arecord(self, file_path: str, version: int, filing: dict[str, str]) -> None:
        store = self._get_store()
        namespace = self._get_namespace()
        item = await store.aget(namespace, file_path)
        if item is None:
            return
        value = {**item.value, VERSION_KEY: version, **filing}
        await store.aput(namespace, file_path, value)
        emit_draft_card(
            path=file_path,
            content=str(value.get("content") or ""),
            version=version,
            filing=filing,
        )

    # -- what the filing tool reads and writes ---------------------------------

    async def aread(self, file_path: str) -> DraftUsage:
        """This path's stored state: its content, its version and its filing.

        The one read `file_draft` needs, and deliberately the same
        :class:`DraftUsage` the write guards use rather than a second shape —
        both questions are "what does the store hold for this path".
        """
        return await self._ausage(file_path)

    async def arecord_filing(self, file_path: str, filing: dict[str, str]) -> None:
        """Remember which project document this path was filed as.

        Merged onto the stored value WITHOUT touching ``content``: filing does
        not change the draft, so the version counter does not move and no card is
        emitted from here — ``file_draft`` emits its own, which is the card that
        knows a document id.
        """
        store = self._get_store()
        namespace = self._get_namespace()
        item = await store.aget(namespace, file_path)
        if item is None:
            return
        await store.aput(namespace, file_path, {**item.value, **filing})

    # -- the two write verbs ---------------------------------------------------

    def write(self, file_path: str, content: str) -> WriteResult:
        text = normalize_draft_text(content)
        usage = self._usage(file_path)
        refusal = write_refusal(usage, file_path, text)
        if refusal is not None:
            return WriteResult(error=refusal)
        result = super().write(file_path, text)
        if result.error is None:
            self._record(file_path, usage.version + 1, usage.filing)
        return result

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        text = normalize_draft_text(content)
        usage = await self._ausage(file_path)
        refusal = write_refusal(usage, file_path, text)
        if refusal is not None:
            return WriteResult(error=refusal)
        result = await super().awrite(file_path, text)
        if result.error is None:
            await self._arecord(file_path, usage.version + 1, usage.filing)
        return result

    def edit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,  # noqa: FBT001, FBT002 - positional, to match the backend protocol
    ) -> EditResult:
        old_text = normalize_draft_text(old_string)
        new_text = normalize_draft_text(new_string)
        usage = self._usage(file_path)
        refusal = edit_refusal(usage, file_path, old_text, new_text, replace_all=replace_all)
        if refusal is not None:
            return EditResult(error=refusal)
        result = super().edit(file_path, old_text, new_text, replace_all)
        if result.error is None:
            self._record(file_path, usage.version + 1, usage.filing)
        return result

    async def aedit(
        self,
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,  # noqa: FBT001, FBT002 - positional, to match the backend protocol
    ) -> EditResult:
        old_text = normalize_draft_text(old_string)
        new_text = normalize_draft_text(new_string)
        usage = await self._ausage(file_path)
        refusal = edit_refusal(usage, file_path, old_text, new_text, replace_all=replace_all)
        if refusal is not None:
            return EditResult(error=refusal)
        result = await super().aedit(file_path, old_text, new_text, replace_all)
        if result.error is None:
            await self._arecord(file_path, usage.version + 1, usage.filing)
        return result


async def _build_store(dsn: str) -> BaseStore:
    """The store for one DSN: Postgres where there is one, memory where there is not."""
    if not is_postgres_dsn(dsn):
        logger.warning(
            "No Postgres checkpoint DSN (%s=%r): the chat working directory is in memory, "
            "so drafts do not survive a restart of this process.",
            _DSN_ENV,
            dsn,
        )
        from langgraph.store.memory import InMemoryStore

        return InMemoryStore()

    from langgraph.store.postgres import AsyncPostgresStore

    from aiq_agent.common import get_checkpoint_pool

    store = AsyncPostgresStore(get_checkpoint_pool(dsn))
    await store.setup()
    logger.info("Chat working directory on Postgres store (shared checkpoint pool).")
    return store


async def get_draft_store(dsn: str | None = None) -> BaseStore:
    """The process-wide store for the working directory, built at most once per DSN."""
    key = dsn if dsn is not None else os.environ.get(_DSN_ENV, "")
    store = _stores.get(key)
    if store is not None:
        return store
    async with _store_lock:
        store = _stores.get(key)
        if store is not None:
            return store
        store = await _build_store(key)
        _stores[key] = store
        return store


async def get_draft_backend(conversation_id: str, dsn: str | None = None) -> DraftBackend:
    """The working directory of ONE conversation, on the process-wide store."""
    return DraftBackend(store=await get_draft_store(dsn), conversation_id=conversation_id)


def reset_draft_stores() -> None:
    """Drop the per-process store cache. For tests; nothing in production calls it."""
    _stores.clear()
