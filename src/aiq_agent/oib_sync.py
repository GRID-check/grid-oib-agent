"""Ingestion of the base corpus into the oib_knowledge collection (ADR-0082).

The corpus is the ``oib_corpus_files`` table plus the objects it points at
(``aiq_agent.corpus_store``). A file needs ingestion when the index was not built
from its current bytes by the current chunking pipeline
(``FileRow.needs_ingestion``); this module ingests those files through the
canonical, blocking knowledge-layer path, polls each file's status until it
reaches a terminal state, and only on SUCCESS records the hash and pipeline
version it was built from. A failure or a timeout records nothing, so the next
cycle retries it.

Two callers drive it: an admin upload queues :func:`ingest_single` for the file it
just stored, and :func:`sync` (the housekeeping route and the admin's "run it
now") ingests everything that still needs it. Any replica may run either, and
the cross-replica locks below keep one file from being ingested twice.
"""

import logging
import os
import time
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from aiq_agent import corpus_store
from aiq_agent.knowledge.factory import get_ingestor
from aiq_agent.knowledge.factory import unregister_summary
from aiq_agent.knowledge.leader_lock import keyed_lock
from aiq_agent.knowledge.schema import FileStatus

logger = logging.getLogger(__name__)

COLLECTION_NAME = os.environ.get("OIB_COLLECTION_NAME") or os.environ.get("COLLECTION_NAME") or "oib_knowledge"
CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")

# Polling configuration for blocking file-status checks.
_POLL_INTERVAL_SECONDS = 2.0
_POLL_TIMEOUT_SECONDS = 600.0

# One sync cycle at a time across every replica.
SYNC_LOCK_KEY = "oib-sync"

# Chunk-format version of the ingestion pipeline. Bump whenever chunking,
# embedding-relevant preprocessing, or chunk metadata changes shape: every file
# whose recorded version differs then needs ingestion, and the next sync cycle
# re-ingests the full corpus, so stale-format chunks self-heal instead of
# persisting until a PDF happens to change. Stored per file in
# ``oib_corpus_files.chunk_format_version``.
# 2: chunk metadata is no longer embedded wholesale. `file_size`, the ingest temp
#    path and render geometry are excluded from the embed rendering, so the literal
#    text sent to the embedding model changed for every chunk. Without this bump the
#    corpus would keep its diluted vectors indefinitely — the change detector gates on
#    the sha256 of the PDF bytes, and a preprocessing change alters no file hash — while
#    newly uploaded documents got clean ones, leaving two embedding conventions in one index.
# 3: Punkt-aware chunking. A document with a usable outline is now cut on its own
#    numbering rather than per page, so chunk boundaries, chunk count and the
#    metadata every chunk carries all change. Without this bump the corpus would
#    keep its page-cut chunks forever, for the same reason as 2.
#    Version 3 also covers the later correction to how the outline is chosen (a
#    best-chain search over all heading candidates, anchored on the document's own
#    contents page, in place of a greedy left-to-right scan). No separate version is
#    needed: 3 has not been ingested anywhere yet, and both changes land in the same
#    unreleased pass. Corpus effect, measured against the 946 Punkte the contents
#    pages of the twelve Punkt-structured Richtlinien list: 903 chunks with 44
#    missing, 1 spurious and 4 carrying another heading's title, becomes 946 with
#    none of the three.
# 4: captioned tables (``captioned_tables``) are read as tables: cut out of the
#    page text, which read them across their columns, and indexed as Markdown
#    chunks addressed ``punkt_id = "Tabelle N"``. Removing them also drops the 12
#    table rows version 3 accepted as Punkte (OIB-RL 2 13-15, OIB-RL 2.1 6.1-6.3,
#    and their Änderungen twins): 1645 Punkt ids become 1633, plus 104 table chunks.
CHUNK_FORMAT_VERSION = 4


@dataclass(frozen=True)
class SyncResult:
    """What one sync cycle did: files ingested, files that failed or timed out, files in the corpus."""

    ingested: int
    failed: int
    total: int


def _file_lock(name: str):
    """Serialise the corpus mutations of ONE document, in this process and across replicas.

    The collection keys chunks on the file name, so an ingest and a delete of
    one document, or two ingests of it, must not interleave: a delete landing
    while an ingest is still indexing would leave the file indexed after a
    "successful" removal. Different documents stay fully concurrent. The
    replacement itself is also serialised inside the ingestor (a different key),
    which this lock does not replace: what only this one covers is the upload,
    the poll and the recording of the hash, and a delete.
    """
    return keyed_lock(f"oib-file:{name}")


def _ensure_collection(ingestor) -> None:
    """Create the OIB collection if it does not already exist (idempotent)."""
    if ingestor.get_collection(COLLECTION_NAME) is not None:
        logger.info("Collection %s already exists", COLLECTION_NAME)
        return

    try:
        ingestor.create_collection(
            COLLECTION_NAME,
            description="Persistent OIB Richtlinien knowledge base.",
        )
        logger.info("Created collection %s", COLLECTION_NAME)
    except Exception as e:
        # The LlamaIndex adapter uses get_or_create_collection and will not raise on
        # an existing collection, but guard against backends that do. Only swallow the
        # error if the collection actually exists now.
        if ingestor.get_collection(COLLECTION_NAME) is None:
            raise
        logger.info("Collection %s already exists (create raised: %s)", COLLECTION_NAME, e)


def _collection_is_empty(ingestor) -> bool:
    """True when the OIB collection is missing or holds no vectors.

    Detects table/vector-store drift. The table says what was ingested, but the
    vectors live in Chroma, which can be reset or repointed (``AIQ_CHROMA_URL``
    at a fresh server) while the table still lists the whole corpus as ingested;
    the change detector would then find nothing to do and leave the collection
    empty forever.

    Returns ``False`` (the safe, non-destructive answer) if the store cannot be
    probed, so a transient Chroma hiccup never discards what the table knows.
    """
    try:
        info = ingestor.get_collection(COLLECTION_NAME)
    except Exception as exc:
        logger.debug("Could not probe collection %s: %s", COLLECTION_NAME, exc)
        return False
    if info is None:
        return True
    return getattr(info, "chunk_count", None) == 0 or getattr(info, "file_count", None) == 0


def _get_max_workers() -> int:
    raw_value = os.environ.get("OIB_SYNC_MAX_WORKERS", "4")
    try:
        max_workers = int(raw_value)
    except ValueError:
        logger.warning("Invalid OIB_SYNC_MAX_WORKERS=%r; using default 4", raw_value)
        return 4

    if max_workers < 1:
        logger.warning("OIB_SYNC_MAX_WORKERS must be at least 1; using 1 instead of %d", max_workers)
        return 1
    return max_workers


def _get_oib_ingestor():
    # Register the LlamaIndex backend lazily so tests can import this module
    # without importing the full NAT/LlamaIndex stack.
    import knowledge_layer.llamaindex.adapter  # noqa: F401

    # The extraction switches are the adapter's own (AIQ_EXTRACT_*, on unless
    # set to false): restating them here gave the corpus a second, off-by-default
    # reading of the same flags.
    return get_ingestor("llamaindex", {"persist_dir": CHROMA_DIR})


def _await_terminal(ingestor, file_id: str, name: str) -> FileStatus | None:
    """Poll ``file_id`` until it is SUCCESS or FAILED; ``None`` after the timeout."""
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        info = ingestor.get_file_status(file_id, COLLECTION_NAME)
        status = info.status if info else None
        if status == FileStatus.SUCCESS:
            logger.info("OIB ingestion succeeded: %s chunks=%s", name, info.chunk_count)
            return status
        if status == FileStatus.FAILED:
            logger.error("OIB ingestion failed: %s error=%s", name, info.error_message)
            return status
        time.sleep(_POLL_INTERVAL_SECONDS)
    logger.error("OIB ingestion timed out: %s", name)
    return None


def ingest_single(name: str) -> FileStatus | None:
    """Blocking ingest of one corpus file into the OIB collection, unless the index is already current.

    Returns the terminal FileStatus, or None on timeout. A file the index was
    already built from (same bytes, same pipeline version) returns SUCCESS
    without work: an upload's queued ingestion and a sync cycle can both reach
    the same file, and whichever takes the lock second finds it done. Raises
    ``LookupError`` when the table no longer lists the file (deleted since it
    was queued) and ``CorpusStoreError`` when it is listed but cannot be fetched.

    The previous version's chunks are replaced by the ingestor itself, once the
    new one is indexed, and kept when it is not, taking back out whatever part
    of the new version a failure had already inserted. There is deliberately no
    ``delete_file`` first: that deleted the chunks AND the metadata row before
    the new file was read, so a re-ingest that then failed left the document
    with nothing, and one that succeeded lost the Dokumentart the platform owner
    had set on the row.

    The hash is recorded for the bytes that were read (the row's), so a file
    replaced while this ran still needs ingestion afterwards.
    """
    with _file_lock(name):
        row = corpus_store.get_file(name)
        if row is None:
            raise LookupError(f"{name} is no longer in the base corpus")
        if not row.needs_ingestion(CHUNK_FORMAT_VERSION):
            return FileStatus.SUCCESS
        pdf = corpus_store.ensure_local(name)
        if pdf is None:
            raise LookupError(f"{name} is no longer in the base corpus")

        ingestor = _get_oib_ingestor()
        _ensure_collection(ingestor)
        file_info = ingestor.upload_file(str(pdf), COLLECTION_NAME)
        logger.info("Submitted OIB file %s size=%d file_id=%s", name, row.size_bytes, file_info.file_id)

        status = _await_terminal(ingestor, file_info.file_id, name)
        if status == FileStatus.SUCCESS:
            corpus_store.mark_ingested(name, row.sha256, CHUNK_FORMAT_VERSION)
        return status


def remove_document(name: str) -> bool:
    """Delete a base-corpus document: its chunks, summary registration, row, object and cached copy.

    Returns False when neither the table nor the index knows the name (route
    -> 404). A name only the index knows, chunks left behind by a half-finished
    delete or a restored vector store, is removed the same way; the table and
    object steps are then no-ops.
    """
    if not corpus_store.is_valid_name(name):
        return False
    with _file_lock(name):
        ingestor = _get_oib_ingestor()
        if corpus_store.get_file(name) is None and name not in _indexed_names(ingestor):
            return False

        # Chunks and summary first, the row last: a failure in between leaves the
        # document listed, so the admin sees it and a retry finds it.
        ingestor.delete_file(name, COLLECTION_NAME)
        unregister_summary(COLLECTION_NAME, name)
        corpus_store.remove(name)
    logger.info("Removed OIB document %s", name)
    return True


def _indexed_names(ingestor) -> set[str]:
    if ingestor.get_collection(COLLECTION_NAME) is None:
        return set()
    return {info.file_name for info in ingestor.list_files(COLLECTION_NAME)}


def mark_for_reingest(name: str) -> bool:
    """Forget what the index was built from for ``name``, so it needs ingestion again. False if not in the corpus.

    :func:`ingest_single` re-uploads and the ingestor replaces the old version
    whatever the table says; what this makes happen is that the re-ingest is
    *visible*: ``oib_status`` reports a file with no recorded hash as PENDING,
    which is the state the admin UI already polls on. Without it a re-ingest of
    an already-ingested document would read as INGESTED for its whole duration
    and the progress panel would show a job that appeared to finish before it
    started. It is also what makes ``ingest_single`` do the work at all, since
    the file would otherwise be current.

    If the ingestion then fails, the hash simply stays forgotten: the file reads
    as PENDING and the next sync cycle picks it up, the same self-healing path a
    genuinely new file takes.
    """
    if not corpus_store.is_valid_name(name) or corpus_store.get_file(name) is None:
        return False
    corpus_store.forget_ingested(name)
    return True


def _forget_ingested_if_the_index_was_reset(rows: dict[str, corpus_store.FileRow]) -> dict[str, corpus_store.FileRow]:
    """The rows, after forgetting every ingested hash when the table claims files the index no longer holds."""
    if not any(row.ingested_sha256 for row in rows.values()) or not _collection_is_empty(_get_oib_ingestor()):
        return rows
    logger.warning(
        "OIB sync: the table lists ingested files but collection %s is empty/missing "
        "(vector store reset or repointed) — forcing a full re-ingest",
        COLLECTION_NAME,
    )
    corpus_store.forget_ingested()
    return corpus_store.list_files()


def _ingest_all(names: Iterable[str]) -> int:
    """Ingest ``names`` on a small pool; the number that succeeded. A raise is one file's failure, not the cycle's."""

    def one(name: str) -> bool:
        try:
            return ingest_single(name) == FileStatus.SUCCESS
        except Exception:
            logger.exception("OIB ingestion of %s crashed; it will be retried by the next cycle", name)
            return False

    with ThreadPoolExecutor(max_workers=_get_max_workers(), thread_name_prefix="oib-ingest-") as pool:
        return sum(pool.map(one, names))


def sync() -> SyncResult:
    """One sync cycle: ingest every corpus file that needs it.

    Runs under the cross-replica ``oib-sync`` lock, so a second caller (the
    next scheduled cycle, an admin's "run it now") waits for the running cycle
    and then finds nothing left to do.
    """
    with keyed_lock(SYNC_LOCK_KEY):
        rows = _forget_ingested_if_the_index_was_reset(corpus_store.list_files())
        pending = sorted(name for name, row in rows.items() if row.needs_ingestion(CHUNK_FORMAT_VERSION))
        logger.info("OIB sync: total=%d needing_ingestion=%d collection=%s", len(rows), len(pending), COLLECTION_NAME)
        if not pending:
            return SyncResult(ingested=0, failed=0, total=len(rows))
        ingested = _ingest_all(pending)
        logger.info("OIB sync complete: succeeded=%d failed=%d total=%d", ingested, len(pending) - ingested, len(rows))
        return SyncResult(ingested=ingested, failed=len(pending) - ingested, total=len(rows))
