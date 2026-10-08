"""Ingestion of the base corpus into the oib_knowledge collection (ADR-0082).

The corpus is the ``oib_corpus_files`` table plus the objects it points at
(``aiq_agent.corpus_store``). A file needs ingestion when the index was not built
from its current bytes by the current chunking pipeline
(``FileRow.needs_ingestion``).

Ingestion is never run here. A file that needs it becomes ONE job on the durable
ingest queue (ADR-0076): the same queue ``POST /v1/ingest`` uses, in the platform
lane at ``bulk`` priority, claimed and run by the ingest workers (the only
process that claims), with the queue's attempts, dead rows, fairness and drain
behaviour. There is no in-process fallback: when the queue
cannot take the job, the call that wanted it raises.

The job's id is a function of the file's name, hash and chunk-format version, so
asking twice is asking once: a second cycle, or an upload racing a cycle, finds
the job there and queues nothing. The job downloads the object itself
(``corpus_store.CorpusObjectDownload``) and ingests it like any file: summary,
Dokumentart, display title and the replacement of the previous version are the
ingestor's own. What the worker does not do is write to the corpus table. A sync
cycle (and the status view) reads each file's job from the ingest status store and
records the outcome: ``mark_ingested`` for a job that finished, ``mark_failed``
for one that ran and gave up, which is how a file that cannot be ingested stops
being queued until its bytes change or an admin asks again.

Two callers drive it: an admin upload stores the file and queues its job at once
(:func:`store_and_request`), and :func:`sync` (the housekeeping route, and the
admin's "run it now") records what finished, then queues every file that still
needs a job.
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from dataclasses import replace
from enum import StrEnum

from aiq_agent import corpus_store
from aiq_agent.knowledge import ingest_queue
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.factory import get_ingestor
from aiq_agent.knowledge.factory import unregister_summary
from aiq_agent.knowledge.leader_lock import keyed_lock
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import JobState
from aiq_agent.turn import api_seam

logger = logging.getLogger(__name__)

COLLECTION_NAME = os.environ.get("OIB_COLLECTION_NAME") or os.environ.get("COLLECTION_NAME") or "oib_knowledge"
CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")

# One sync cycle at a time across replicas.
SYNC_LOCK_KEY = "oib-sync"

# Chunk-format version of the ingestion pipeline. Bump whenever chunking,
# embedding-relevant preprocessing, or chunk metadata changes shape: every file
# whose recorded version differs then needs ingestion (and, the version being part
# of its job id, a new job), and the next sync cycle re-ingests the full corpus, so
# stale-format chunks self-heal instead of persisting until a PDF happens to
# change. Stored per file in ``oib_corpus_files.chunk_format_version``.
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
    """What one sync cycle did.

    ``enqueued``: jobs it put on the ingest queue. ``ingested_recorded``: files whose
    finished job it recorded in the corpus table. ``failed``: files whose job gave up
    (they are not queued again until their bytes change or an admin re-indexes them).
    ``total``: files in the corpus.
    """

    enqueued: int
    ingested_recorded: int
    failed: int
    total: int


class JobProgress(StrEnum):
    """Where the ingest job for a file's current bytes is."""

    NONE = "none"
    """No job for these bytes and this pipeline version: one may be queued."""

    WAITING = "waiting"
    """Queued, or running its first moments: a worker has it or will."""

    RUNNING = "running"
    DONE = "done"
    """Finished and indexed; the cycle has yet to record it."""

    FAILED = "failed"
    """Ran and gave up (or lost every claim): not queued again until the bytes change or an admin asks."""


@dataclass(frozen=True)
class Settled:
    """The corpus rows after finished jobs were recorded, and where each unfinished file's job is."""

    rows: dict[str, corpus_store.FileRow]
    progress: dict[str, JobProgress]
    recorded: int


def job_id_for(row: corpus_store.FileRow) -> str:
    """The ingest job id of this file's current bytes under the current pipeline version.

    Deterministic, so the queue's own primary key is what keeps one job per
    (name, hash, version): the bytes changing or ``CHUNK_FORMAT_VERSION`` moving makes a
    new id, and nothing else does.
    """
    digest = hashlib.sha256(f"{row.file_name}\0{row.sha256}\0{CHUNK_FORMAT_VERSION}".encode()).hexdigest()
    return f"oib-{digest[:32]}"


def _file_lock(name: str):
    """Serialise the corpus mutations of ONE document, in this process and across replicas.

    Held to decide whether a job exists and to queue it (milliseconds, and across an
    upload's own store, which is the point: a cycle cannot queue the file between the
    upload's row and the upload's job), and for the whole of a delete. A running
    ingestion does not hold it: that is the worker's, and a delete cancels it.
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


def _get_oib_ingestor():
    """The ingestor this module prepares jobs with and reads the collection through. It runs nothing."""
    # Register the LlamaIndex backend lazily so tests can import this module
    # without importing the full NAT/LlamaIndex stack.
    import knowledge_layer.llamaindex.adapter  # noqa: F401

    return get_ingestor("llamaindex", {"persist_dir": CHROMA_DIR})


def _indexed_names(ingestor) -> set[str]:
    if ingestor.get_collection(COLLECTION_NAME) is None:
        return set()
    return {info.file_name for info in ingestor.list_files(COLLECTION_NAME)}


# ----------------------------------------------------------------------------
# Jobs: where they are, and what they leave in the corpus table
# ----------------------------------------------------------------------------


def progress_of(row: corpus_store.FileRow) -> JobProgress:
    """Where the job for ``row``'s current bytes is, read from the ingest status store.

    A job that finished is DONE only if its file reached SUCCESS. The status store settles a
    job whose queue row is dead (every claim lost) as failed, so a file that kills its workers
    ends up FAILED here without anything else knowing.
    """
    job_id = job_id_for(row)
    if row.failed_job_id == job_id:
        return JobProgress.FAILED
    status = ingest_status_store.get(job_id)
    if status is None:
        return JobProgress.NONE
    if status.status == JobState.PENDING:
        return JobProgress.WAITING
    if status.status == JobState.PROCESSING:
        return JobProgress.RUNNING
    done = status.status == JobState.COMPLETED and any(f.status == FileStatus.SUCCESS for f in status.file_details)
    return JobProgress.DONE if done else JobProgress.FAILED


def settle(rows: dict[str, corpus_store.FileRow]) -> Settled:
    """Record what finished: ``mark_ingested`` for a done job, ``mark_failed`` for one that gave up.

    The one place the corpus table learns the outcome of an ingestion, for a sync cycle and for
    the status view alike (both call it), so an upload's file reads as ingested as soon as its job
    is done instead of at the next cycle. Idempotent: a recorded file is current and not looked at.
    """
    settled: dict[str, corpus_store.FileRow] = {}
    progress: dict[str, JobProgress] = {}
    recorded = 0
    for name, row in rows.items():
        settled[name] = row
        if not row.needs_ingestion(CHUNK_FORMAT_VERSION):
            continue
        state = progress_of(row)
        if state == JobProgress.DONE:
            if corpus_store.mark_ingested(name, row.sha256, CHUNK_FORMAT_VERSION):
                settled[name] = replace(
                    row, ingested_sha256=row.sha256, chunk_format_version=CHUNK_FORMAT_VERSION, failed_job_id=None
                )
                recorded += 1
                continue
            state = JobProgress.WAITING  # the bytes changed under it; the next cycle looks again
        elif state == JobProgress.FAILED and row.failed_job_id != job_id_for(row):
            corpus_store.mark_failed(name, row.sha256, job_id_for(row))
            settled[name] = replace(row, failed_job_id=job_id_for(row))
        progress[name] = state
    return Settled(settled, progress, recorded)


def _drop_job(row: corpus_store.FileRow) -> None:
    """Forget the job for ``row``'s bytes (its status and its queue row), so its id can be used again."""
    job_id = job_id_for(row)
    ingest_status_store.delete(job_id)
    ingest_queue.mark_done(job_id)


def _request_locked(name: str, doc_class: str | None) -> bool:
    row = corpus_store.get_file(name)
    if row is None:
        raise LookupError(f"{name} is no longer in the base corpus")
    if not row.needs_ingestion(CHUNK_FORMAT_VERSION) or progress_of(row) != JobProgress.NONE:
        return False

    ingestor = _get_oib_ingestor()
    _ensure_collection(ingestor)
    # Bulk and in the platform lane (no organisation): a file nobody is waiting on this second
    # (an upload's admin polls the status, and waits behind no one's chat uploads either).
    config: dict = {"cleanup_files": True, "original_filenames": [name], "priority": "bulk"}
    if doc_class:
        config["doc_class"] = doc_class
    prepared = ingestor.prepare_job(
        [corpus_store.CorpusObjectDownload(row.storage_key, row.sha256)],
        COLLECTION_NAME,
        config,
        job_id=job_id_for(row),
    )
    try:
        queued = api_seam.enqueue_ingest_job(prepared)
    except Exception:
        # Not queued, so it must not read as a pending job nobody holds.
        ingest_status_store.delete(prepared.job_id)
        raise
    if queued:
        logger.info("Queued the ingestion of %s as job %s", name, prepared.job_id)
    return queued


def request_ingestion(name: str, doc_class: str | None = None) -> bool:
    """Queue the ingest job for ``name`` unless the index is current or a job for these bytes exists.

    Whether this call queued one. Raises ``LookupError`` when the corpus does not list the file,
    and ``QueueUnavailable`` when the queue cannot take it; it never ingests here.
    ``doc_class`` is a Dokumentart an admin chose, carried on the job; without one the ingestor
    guesses it from the file name.
    """
    with _file_lock(name):
        return _request_locked(name, doc_class)


def store_and_request(name: str, data: bytes, doc_class: str | None = None) -> bool:
    """An admin upload: store the file, then queue its job, with no cycle able to come between.

    Raises ``CorpusStoreError`` if the object store refuses the file (nothing is listed then), and
    ``QueueUnavailable`` if the file is stored but its job could not be queued (the next cycle
    queues it).
    """
    with _file_lock(name):
        corpus_store.put(name, data)
        return _request_locked(name, doc_class)


# ----------------------------------------------------------------------------
# Delete, re-index
# ----------------------------------------------------------------------------


def remove_document(name: str) -> bool:
    """Delete a base-corpus document: its job, chunks, summary registration, row, object and cached copy.

    Returns False when neither the table nor the index knows the name (route
    -> 404). A name only the index knows, chunks left behind by a half-finished
    delete or a restored vector store, is removed the same way; the table and
    object steps are then no-ops. A job queued or running for the file is cancelled first:
    a worker that lost its claim stops before it writes.
    """
    if not corpus_store.is_valid_name(name):
        return False
    with _file_lock(name):
        ingestor = _get_oib_ingestor()
        row = corpus_store.get_file(name)
        if row is None and name not in _indexed_names(ingestor):
            return False

        if row is not None:
            _drop_job(row)
        # Chunks and summary first, the row last: a failure in between leaves the
        # document listed, so the admin sees it and a retry finds it.
        ingestor.delete_file(name, COLLECTION_NAME)
        unregister_summary(COLLECTION_NAME, name)
        corpus_store.remove(name)
    logger.info("Removed OIB document %s", name)
    return True


def mark_for_reingest(name: str) -> bool:
    """Make ``name`` need a new job: forget what the index was built from and what failed. False if not in the corpus.

    The file then reads as PENDING in ``oib_status``, which is the state the admin UI already
    polls on, and :func:`request_ingestion` queues a fresh job. The job for these bytes has the
    same id as before, so a finished or failed one is dropped first (its status and queue row);
    one still waiting or running is left alone, since it will do the work this asks for.
    """
    if not corpus_store.is_valid_name(name):
        return False
    row = corpus_store.get_file(name)
    if row is None:
        return False
    if progress_of(row) not in (JobProgress.WAITING, JobProgress.RUNNING):
        _drop_job(row)
    corpus_store.forget_ingested(name)
    return True


# ----------------------------------------------------------------------------
# The cycle
# ----------------------------------------------------------------------------


def _forget_everything_if_the_index_was_reset(rows: dict[str, corpus_store.FileRow]) -> dict[str, corpus_store.FileRow]:
    """The rows, after forgetting every ingested hash when the table claims files the index no longer holds."""
    if not any(row.ingested_sha256 for row in rows.values()) or not _collection_is_empty(_get_oib_ingestor()):
        return rows
    logger.warning(
        "OIB sync: the table lists ingested files but collection %s is empty/missing "
        "(vector store reset or repointed) — forcing a full re-ingest",
        COLLECTION_NAME,
    )
    for row in rows.values():
        if progress_of(row) not in (JobProgress.WAITING, JobProgress.RUNNING):
            _drop_job(row)
    corpus_store.forget_ingested()
    return corpus_store.list_files()


def sync() -> SyncResult:
    """One sync cycle: record the jobs that finished, then queue a job for every file that needs one.

    Cheap: it reads the table and the status store and writes queue rows, and runs no ingestion.
    Runs under the cross-replica ``oib-sync`` lock, so a second caller (the next scheduled cycle,
    an admin's "run it now") waits for the running one and then finds nothing to do. Raises when the
    queue cannot take a job, instead of ingesting here.
    """
    with keyed_lock(SYNC_LOCK_KEY):
        rows = _forget_everything_if_the_index_was_reset(corpus_store.list_files())
        settled = settle(rows)
        failed = sum(1 for state in settled.progress.values() if state == JobProgress.FAILED)
        enqueued = 0
        for name in sorted(n for n, state in settled.progress.items() if state == JobProgress.NONE):
            try:
                enqueued += request_ingestion(name)
            except LookupError:
                logger.info("%s left the corpus before its job was queued", name)
        result = SyncResult(
            enqueued=enqueued, ingested_recorded=settled.recorded, failed=failed, total=len(settled.rows)
        )
        logger.info("OIB sync: %s", result)
        return result
