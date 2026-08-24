"""One-shot bootstrap of the chunk-text mirror from the existing Chroma store.

The German sparse (lexical) retrieval channel searches a Postgres/SQLite mirror
of the chunk text (``aiq_agent.knowledge.chunk_text_store``). Everything already
ingested predates that mirror, and OIB sync is hash-gated — a document already in
Chroma is never re-processed — so those chunks would never appear in the mirror
on their own and the lexical channel would stay blind to the whole existing
corpus. This script fills it in ONCE, from data we already hold.

No re-ingest, no re-embed, no LLM, no network: Chroma stores the raw chunk text
in ``documents`` and the llama-index node id in ``ids``, and that node id IS
``Chunk.chunk_id``. So the mirror row joins back to the vector store exactly, and
the bootstrap is a paged copy.

    python scripts/backfill_chunk_text.py --dry-run          # preview, writes nothing
    python scripts/backfill_chunk_text.py                    # every Chroma collection
    python scripts/backfill_chunk_text.py --collection oib_knowledge
    python scripts/backfill_chunk_text.py --force            # re-mirror already-mirrored collections

IDEMPOTENCE
-----------
A collection that already has mirror rows is SKIPPED unless ``--force``. Re-running
with ``--force`` is safe: the mirror's primary key is ``(collection, chunk_id)``
and ``upsert_many`` is an insert-or-replace, so a row is overwritten in place
rather than duplicated. Chunks deleted from Chroma since the last run are NOT
removed by this script — deletion is the ingestion path's job
(``delete_by_file``/``delete_collection``).

SOURCE
------
``collection.get(include=["documents", "metadatas"], limit=…, offset=…)``, paged
at :data:`DEFAULT_PAGE_SIZE` so a 100k-chunk collection never materialises in
memory. Per page: ``ids`` -> ``chunk_id``, ``documents`` -> ``body``,
``metadatas`` -> ``file_name``/``page_label``. A row with no id or empty text is
skipped (there is nothing to index), counted, and never aborts the page.

STORE ACCESS
------------
The mirror DB is taken from ``AIQ_SUMMARY_DB`` (the same env var the deployment
already sets for the knowledge database — the mirror deliberately adds NO new
one), overridable with ``--summary-db``. The Chroma directory is
``AIQ_CHROMA_DIR`` (default ``/tmp/chroma_data``), overridable with
``--chroma-dir``.

Writes are VERIFIED by rowcount: ``upsert_many`` returns the number of rows it
wrote, and any shortfall against the page it was handed is counted as failed.

EXIT CODES
----------
* ``0`` — success (nothing to do, or a completed run with no failures). A
  ``--dry-run`` always exits ``0`` regardless of preview problems (it writes
  nothing).
* ``1`` — a real (non-dry-run) run finished but at least one row failed to
  mirror (``stats.failed > 0``), so CI can flag a partial backfill.
* ``2`` — the Chroma store could not be opened at all (package missing,
  directory absent, client error). Nothing was read and nothing was written.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections.abc import Callable
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from aiq_agent.knowledge.chunk_text_store import ChunkTextRow

logger = logging.getLogger(__name__)

DEFAULT_SUMMARY_DB = os.environ.get("AIQ_SUMMARY_DB", "sqlite+aiosqlite:///./summaries.db")
DEFAULT_CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")

#: Chunks per Chroma page / per mirror INSERT batch.
DEFAULT_PAGE_SIZE = 500

# Type aliases for the injected seams (see "Per-collection logic" below).
#: (collection, limit, offset) -> raw Chroma ``get`` result, or None on failure.
PageFetcher = Callable[[str, int, int], "dict[str, Any] | None"]
#: (collection, rows) -> number of rows actually written.
UpsertFn = Callable[[str, list[ChunkTextRow]], int]
#: (collection) -> number of rows already mirrored.
CountFn = Callable[[str], int]


# =============================================================================
# Chroma access (the only I/O the script does besides the mirror writes)
# =============================================================================


def open_chroma(chroma_dir: str):
    """Open the Chroma client, or ``None`` when the store is unavailable.

    Unlike the tag backfill — which can fall back to stored summaries — Chroma is
    the ONLY source of chunk text, so an unopenable store is a hard stop (exit 2)
    rather than a degraded run.
    """
    try:
        import chromadb
    except ImportError:
        logger.error("chromadb is not installed; the chunk text mirror cannot be bootstrapped.")
        return None

    if not os.path.isdir(chroma_dir):
        logger.error("Chroma dir %s not found; nothing to mirror.", chroma_dir)
        return None

    try:
        return chromadb.PersistentClient(path=chroma_dir)
    except Exception as e:  # noqa: BLE001 — any client error is the same hard stop
        logger.error("Could not open Chroma at %s: %s", chroma_dir, e)
        return None


def list_chroma_collections(client) -> list[str]:
    """Every collection name in the Chroma store (empty on failure)."""
    try:
        collections = client.list_collections()
    except Exception as e:  # noqa: BLE001
        logger.error("Could not list Chroma collections: %s", e)
        return []
    names: list[str] = []
    for entry in collections:
        # chromadb >=0.6 returns plain names; older versions return objects.
        name = entry if isinstance(entry, str) else getattr(entry, "name", None)
        if name:
            names.append(name)
    return sorted(names)


def make_page_fetcher(client) -> PageFetcher:
    """Build a fail-soft paged reader over Chroma collections."""

    def fetch(collection: str, limit: int, offset: int) -> dict[str, Any] | None:
        try:
            handle = client.get_collection(name=collection)
        except Exception as e:  # noqa: BLE001
            logger.warning("[fail] collection %s not readable: %s", collection, e)
            return None
        try:
            return handle.get(include=["documents", "metadatas"], limit=limit, offset=offset)
        except Exception as e:  # noqa: BLE001
            logger.warning("[fail] %s page at offset %d not readable: %s", collection, offset, e)
            return None

    return fetch


# =============================================================================
# Per-collection logic (testable core — no Chroma, no DB, injected callables)
# =============================================================================


@dataclass
class BackfillStats:
    processed: int = 0
    mirrored: int = 0
    skipped: int = 0
    failed: int = 0


def rows_from_page(page: dict[str, Any] | None) -> tuple[list[ChunkTextRow], int]:
    """Convert one raw Chroma page into mirror rows.

    Returns ``(rows, skipped)``. Fail-soft per row: a chunk with no id or no text
    has nothing to index, so it is skipped and counted rather than raising —
    one malformed entry must never cost the page.
    """
    if not page:
        return [], 0
    ids = page.get("ids") or []
    documents = page.get("documents") or []
    metadatas = page.get("metadatas") or []

    rows: list[ChunkTextRow] = []
    skipped = 0
    for index, chunk_id in enumerate(ids):
        body = documents[index] if index < len(documents) else ""
        metadata = metadatas[index] if index < len(metadatas) and metadatas[index] else {}
        if not chunk_id or not (body or "").strip():
            skipped += 1
            continue
        rows.append(
            ChunkTextRow(
                chunk_id=str(chunk_id),
                body=body,
                file_name=str(metadata.get("file_name") or ""),
                page_label=str(metadata.get("page_label") or ""),
            )
        )
    return rows, skipped


def iter_pages(
    collection: str,
    fetch_page: PageFetcher,
    *,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> Iterator[list[ChunkTextRow] | None]:
    """Yield mirror-row pages for a collection; ``None`` for an unreadable page.

    Stops on the first short page (Chroma returned fewer ids than requested),
    which is the end of the collection.
    """
    offset = 0
    while True:
        page = fetch_page(collection, page_size, offset)
        if page is None:
            yield None
            return
        ids = page.get("ids") or []
        if not ids:
            return
        rows, skipped = rows_from_page(page)
        if skipped:
            logger.warning("[skip] %s: %d chunk(s) at offset %d had no id or no text", collection, skipped, offset)
        yield rows
        if len(ids) < page_size:
            return
        offset += page_size


def backfill_collection(
    collection: str,
    *,
    fetch_page: PageFetcher,
    upsert_fn: UpsertFn,
    count_fn: CountFn,
    page_size: int = DEFAULT_PAGE_SIZE,
    force: bool = False,
    dry_run: bool = False,
) -> BackfillStats:
    """Mirror one collection. Returns its own stats (the caller aggregates).

    Idempotent: a collection that already has mirror rows is skipped unless
    ``force``. In ``dry_run`` the pages are really read and the rows really
    built — the reported number is the true one — but nothing is written.
    """
    stats = BackfillStats()

    existing = count_fn(collection)
    if existing and not force:
        logger.info("[skip] %s already mirrored (%d row(s)); use --force to re-mirror", collection, existing)
        stats.skipped += existing
        return stats

    for rows in iter_pages(collection, fetch_page, page_size=page_size):
        if rows is None:
            # An unreadable page is a real failure, but the run continues with
            # the next collection rather than aborting the whole backfill.
            stats.failed += 1
            break
        if not rows:
            continue
        stats.processed += len(rows)
        if dry_run:
            stats.mirrored += len(rows)
            continue
        written = upsert_fn(collection, rows)
        stats.mirrored += written
        if written < len(rows):
            # Writes are verified by rowcount, not assumed from a clean return.
            stats.failed += len(rows) - written
            logger.warning("[fail] %s: wrote %d of %d row(s) in a page", collection, written, len(rows))

    verb = "would mirror" if dry_run else "mirrored"
    logger.info(
        "Collection %s: processed=%d %s=%d skipped=%d failed=%d",
        collection,
        stats.processed,
        verb,
        stats.mirrored,
        stats.skipped,
        stats.failed,
    )
    return stats


def run_backfill(
    *,
    collections: list[str],
    fetch_page: PageFetcher,
    upsert_fn: UpsertFn,
    count_fn: CountFn,
    page_size: int = DEFAULT_PAGE_SIZE,
    force: bool = False,
    dry_run: bool = False,
) -> BackfillStats:
    """Mirror every named collection, aggregating per-collection stats."""
    total = BackfillStats()
    for collection in collections:
        stats = backfill_collection(
            collection,
            fetch_page=fetch_page,
            upsert_fn=upsert_fn,
            count_fn=count_fn,
            page_size=page_size,
            force=force,
            dry_run=dry_run,
        )
        total.processed += stats.processed
        total.mirrored += stats.mirrored
        total.skipped += stats.skipped
        total.failed += stats.failed
    return total


# =============================================================================
# CLI
# =============================================================================


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--collection",
        default=None,
        help="Only mirror this collection (default: every collection in the Chroma store).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-mirror collections that already have rows (safe: upsert by chunk id).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read the chunks and report what would be mirrored, but write nothing.",
    )
    parser.add_argument(
        "--summary-db",
        default=DEFAULT_SUMMARY_DB,
        help="Knowledge DB URL for the mirror (default: $AIQ_SUMMARY_DB or sqlite+aiosqlite:///./summaries.db).",
    )
    parser.add_argument(
        "--chroma-dir",
        default=DEFAULT_CHROMA_DIR,
        help="Chroma persistence dir holding the chunk text (default: $AIQ_CHROMA_DIR).",
    )
    parser.add_argument(
        "--page-size",
        type=int,
        default=DEFAULT_PAGE_SIZE,
        help=f"Chunks per Chroma page / mirror batch (default: {DEFAULT_PAGE_SIZE}).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)-8s - %(name)s - %(message)s",
        stream=sys.stdout,
    )
    args = _parse_args(argv)

    from aiq_agent.knowledge.chunk_text_store import configure_chunk_text_store

    client = open_chroma(args.chroma_dir)
    if client is None:
        return 2

    collections = [args.collection] if args.collection else list_chroma_collections(client)
    if not collections:
        logger.info("No Chroma collections found. Nothing to do.")
        return 0
    logger.info("Mirroring chunk text for %d collection(s): %s", len(collections), ", ".join(collections))

    store = configure_chunk_text_store(args.summary_db)

    stats = run_backfill(
        collections=collections,
        fetch_page=make_page_fetcher(client),
        upsert_fn=store.upsert_many,
        count_fn=store.count,
        page_size=args.page_size,
        force=args.force,
        dry_run=args.dry_run,
    )

    verb = "would mirror" if args.dry_run else "mirrored"
    logger.info(
        "Backfill complete: processed=%d %s=%d skipped=%d failed=%d",
        stats.processed,
        verb,
        stats.mirrored,
        stats.skipped,
        stats.failed,
    )
    # Signal partial failure to the caller/CI. --dry-run writes nothing, so it
    # always reports success regardless of preview problems.
    if not args.dry_run and stats.failed > 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
