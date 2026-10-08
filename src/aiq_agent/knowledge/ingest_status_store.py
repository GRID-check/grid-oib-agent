"""Shared, cross-replica store for ingestion job status.

Ingestion *executes* on the replica that accepted the upload (a bounded local
thread pool), but its status must be readable from ANY replica — otherwise a
``GET /v1/documents/{job_id}/status`` poll routed elsewhere 404s. This persists
each ``IngestionJobStatus`` (a Pydantic model → JSON) to Postgres so every
replica serves the same answer. It reuses the DocumentMetadataStore engine cache and the
summaries database (``AIQ_SUMMARY_DB``, falling back to ``NAT_JOB_STORE_DB_URL``).

Best-effort / fail-open: with no DB configured (local dev) every write is a
no-op and every read comes back empty. The adapter keeps the jobs of its own
process in memory to run them; nothing it keeps there answers another process.

THE FILES OF A COLLECTION ARE READ FROM HERE, NOT FROM THE PROCESS THAT RAN THEM.
A job row carries one ``file_details`` entry per file, and the row is the only
record of a file that failed or is still being read: it has no chunks in Chroma.
The ``api`` process lists, looks up and deletes files, the ``ingest-worker``
indexes them (ADR-0076, ADR-0082), so what a file's status is must be asked of
the store (``collection_jobs``) and a failed file's record removed from it
(``forget_file``). ``collection_name`` is a column for that reason.

A LIVE ROW IS A CLAIM SOMEBODY HAS TO KEEP MAKING. The job itself runs in one
process's thread pool, so a restart ends it without a word, and the row used to
say ``processing`` forever: the BFF showed the file as in progress and refused
its re-ingest as already running. Every row therefore carries the process that
wrote it (``owner``) and a ``heartbeat_at`` that process refreshes while the job
is live (``heartbeat``). A pending or processing row whose heartbeat is older
than ``STALE_AFTER_SECONDS`` has lost its owner, and is read as ``failed`` with
the stable, retryable reason ``interrupted`` (``get``, ``find_live``,
``fail_interrupted``). The job is not re-run on its own: what it needs to run
again (the downloaded temp file, a presigned URL that expires in minutes, the
job config) is not persisted, so the honest answer is a failure the reader can
retry.

THE OWNER, WHILE IT LIVES, IS RIGHT ABOUT ITS JOB. A stale heartbeat is
evidence of death, not proof: an owner cut off from the database for longer
than ``STALE_AFTER_SECONDS`` is still running, and another replica may settle
its row as interrupted meanwhile. When the owner writes again, its write wins
(``put`` is an unconditional upsert) and the row goes back to what the owner
knows: processing, or completed with its chunks indexed. The alternative, a
settled row the owner can no longer overwrite, is a lie about a live job: it
tells ``find_live`` nothing runs (so a retried dispatch starts a second job on
the same document) and reports ``failed`` for a file whose chunks are indexed.
The BFF may already have written ``failed`` from the settled row; it asks
about such an ``interrupted:`` failure again for 30 minutes after the row's
last write (``reconcile-status.ts``) and adopts a completed or live answer, and
a retry in the meantime dispatches again and finds the revived job through
``find_live`` while it runs. Settling clears ``owner`` so
the owner's ``heartbeat`` refreshes fewer rows than it asked for, which is how
the adapter learns to re-write its jobs within one beat rather than at its next
status change.

A JOB THE DURABLE QUEUE HOLDS IS WAITING, NOT LOST. A job queued in
``ingest_job_queue`` is written PENDING by the replica that accepted it and
then vouched for by nobody until a worker claims it, possibly long after that
replica is gone. While its queue row exists (queued, claimed, or waiting to be
claimed again) the row is never stale (``_stale_predicate``); the queue drops
the row when the job finishes or has failed every attempt, and only then can
the job read as interrupted.
"""

from __future__ import annotations

import logging
import os
import socket
import uuid
from collections.abc import Iterable
from datetime import UTC
from datetime import datetime

from sqlalchemy import bindparam
from sqlalchemy import inspect
from sqlalchemy import text

from aiq_agent.common.db_utils import ensure_schema

from . import ingest_queue
from .document_metadata_store import DocumentMetadataStore
from .schema import FileStatus
from .schema import IngestionJobStatus
from .schema import JobState

logger = logging.getLogger(__name__)

_initialized: set[str] = set()

#: This process, as a row's ``owner``. The pid alone repeats across container
#: restarts (it is 1 in most of them), so a random suffix makes every boot new.
OWNER = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"

#: How often the owning process refreshes ``heartbeat_at`` on its live rows.
HEARTBEAT_INTERVAL_SECONDS = 30

#: A live row whose heartbeat is older than this has lost its owner. Four beats,
#: so one slow beat under load is not a death.
STALE_AFTER_SECONDS = 4 * HEARTBEAT_INTERVAL_SECONDS

#: A row written by a replica that predates heartbeats has none, and is still
#: being worked on while that replica runs (a rolling deploy). Only its
#: ``updated_at`` can age it, and a single file can go minutes between status
#: writes, so the old fifteen-minute in-flight window is the bound for it.
_LEGACY_STALE_AFTER_SECONDS = 15 * 60

#: The machine-readable reason, as the prefix of ``error_message`` (the same
#: ``reason: text`` shape as ``vlm_not_configured``) and in ``metadata``.
INTERRUPTED = "interrupted"
INTERRUPTED_MESSAGE = f"{INTERRUPTED}: ingestion stopped when the service restarted; retry to index this file"

#: Newest stale rows the startup sweep settles; older ones settle when read.
_SWEEP_LIMIT = 500

#: Columns added after the table first shipped. Nullable and without defaults,
#: so adding them never rewrites or rejects an existing row.
_ADDED_COLUMNS = {"owner": "VARCHAR", "dispatch_key": "VARCHAR", "collection_name": "VARCHAR"}


def _db_url() -> str | None:
    url = os.environ.get("AIQ_SUMMARY_DB") or os.environ.get("NAT_JOB_STORE_DB_URL")
    return url or None


def _is_postgres(url: str) -> bool:
    return url.startswith("postgres")


def _ensure_table(url: str) -> None:
    if url in _initialized:
        return
    engine = DocumentMetadataStore._get_or_create_sync_engine(url)
    ts = "TIMESTAMP WITH TIME ZONE DEFAULT NOW()" if _is_postgres(url) else "DATETIME DEFAULT CURRENT_TIMESTAMP"

    def create(conn) -> None:
        conn.execute(
            # ts is a dialect-chosen column-type literal; no user input.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                "CREATE TABLE IF NOT EXISTS ingest_jobs ("
                "  job_id VARCHAR PRIMARY KEY,"
                "  status_json TEXT NOT NULL,"
                f"  updated_at {ts}"
                ")"
            )
        )
        _add_missing_columns(conn, url)
        # `_stale_predicate` reads the queue table, so it must exist too.
        ingest_queue.ensure_table(url, conn)

    # The processes of a boot all reach this at once (see `lock_schema`).
    ensure_schema(engine, "ingest_jobs", create)
    ingest_queue.mark_ensured(url)
    _initialized.add(url)


def _add_missing_columns(conn, url: str) -> None:
    """Additive migration: owner, heartbeat_at, dispatch_key and collection_name, then their indexes."""
    heartbeat_type = "TIMESTAMP WITH TIME ZONE" if _is_postgres(url) else "DATETIME"
    columns = {**_ADDED_COLUMNS, "heartbeat_at": heartbeat_type}
    present = {column["name"] for column in inspect(conn).get_columns("ingest_jobs")}
    guard = "IF NOT EXISTS " if _is_postgres(url) else ""
    for name, column_type in columns.items():
        if name in present:
            continue
        # name/column_type come from the module constants above; no user input.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        conn.execute(text(f"ALTER TABLE ingest_jobs ADD COLUMN {guard}{name} {column_type}"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_ingest_jobs_dispatch_key ON ingest_jobs (dispatch_key)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_ingest_jobs_collection_name ON ingest_jobs (collection_name)"))


def _now(url: str) -> str:
    return "NOW()" if _is_postgres(url) else "CURRENT_TIMESTAMP"


def _ago(url: str, seconds: int) -> str:
    return f"NOW() - INTERVAL '{seconds} seconds'" if _is_postgres(url) else f"DATETIME('now', '-{seconds} seconds')"


def _stale_predicate(url: str) -> str:
    """SQL: this row's owner has stopped vouching for it. Built from constants only."""
    return (
        f"(((heartbeat_at IS NOT NULL AND heartbeat_at < {_ago(url, STALE_AFTER_SECONDS)}) "
        f"OR (heartbeat_at IS NULL AND updated_at < {_ago(url, _LEGACY_STALE_AFTER_SECONDS)})) "
        # A dead row is the trace of a job the queue gave up on: it holds nothing.
        f"AND NOT EXISTS (SELECT 1 FROM {ingest_queue.TABLE} q "
        f"WHERE q.job_id = ingest_jobs.job_id AND q.status <> '{ingest_queue.DEAD}'))"
    )


def _is_live(status: IngestionJobStatus) -> bool:
    return status.status in (JobState.PENDING, JobState.PROCESSING)


def interrupted(status: IngestionJobStatus) -> IngestionJobStatus:
    """``status`` as the failure a lost owner leaves: every unfinished file failed, retryable."""
    failed = status.model_copy(deep=True)
    failed.status = JobState.FAILED
    failed.error_message = INTERRUPTED_MESSAGE
    # A naive-UTC ISO string, as the adapter stores it (see ``put``'s
    # serializer note and the adapter's retention pruning, which parses it).
    failed.completed_at = datetime.now(UTC).replace(tzinfo=None).isoformat()
    failed.metadata = {**failed.metadata, "failure_reason": INTERRUPTED, "retryable": True}
    for detail in failed.file_details:
        if detail.status in (FileStatus.SUCCESS, FileStatus.FAILED):
            continue
        detail.status = FileStatus.FAILED
        detail.error_message = INTERRUPTED_MESSAGE
    return failed


def _settle_interrupted(conn, url: str, status: IngestionJobStatus) -> IngestionJobStatus | None:
    """Write the interrupted failure, unless the owner beat again since it was read.

    The failure written, or None when the conditional update matched no row:
    the owner beat (or wrote) between the read and this update, so the row is
    live and the caller must read it again rather than report a failure that
    was never stored. ``owner`` is cleared so the owner, if it is alive after
    all, sees its heartbeat miss this row (see the module docstring).
    """
    failed = interrupted(status)
    result = conn.execute(
        # _now/_stale_predicate are dialect-chosen literals; values are bound.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"UPDATE ingest_jobs SET status_json = :status_json, updated_at = {_now(url)}, owner = NULL "
            f"WHERE job_id = :job_id AND {_stale_predicate(url)}"
        ),
        {"job_id": status.job_id, "status_json": failed.model_dump_json(warnings=False)},
    )
    conn.commit()
    if result.rowcount == 0:
        return None
    logger.warning("Ingest job %s lost its owner; recorded as %s", status.job_id, INTERRUPTED)
    return failed


def _read(conn, job_id: str) -> IngestionJobStatus | None:
    row = conn.execute(
        text("SELECT status_json FROM ingest_jobs WHERE job_id = :job_id"), {"job_id": job_id}
    ).scalar_one_or_none()
    return IngestionJobStatus.model_validate_json(row) if row is not None else None


def put(status: IngestionJobStatus) -> bool:
    """Upsert a job's status as this process's; whether it is stored. Never raises.

    Ingestion must not break on a DB blip, but the caller must know when a
    write was lost: a terminal status that never lands leaves the row live, and
    once its heartbeat ages another replica settles it as interrupted although
    the job finished. The adapter retries a failed write on its heartbeat.
    With no database configured there is nothing to store, which is success.

    Writing a row is vouching for it: ``owner`` becomes this process and
    ``heartbeat_at`` now, and the write wins over a row another replica settled
    as interrupted (see the module docstring). ``dispatch_key`` is read from
    ``status.metadata`` and kept when a later write does not carry it.
    """
    url = _db_url()
    if not url:
        return True
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        now = _now(url)
        with engine.connect() as conn:
            conn.execute(
                # now is a dialect-chosen literal; every value is bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    "INSERT INTO ingest_jobs "
                    "(job_id, status_json, updated_at, owner, heartbeat_at, dispatch_key, collection_name) "
                    f"VALUES (:job_id, :status_json, {now}, :owner, {now}, :dispatch_key, :collection_name) "
                    "ON CONFLICT (job_id) DO UPDATE SET "
                    f"status_json = EXCLUDED.status_json, updated_at = {now}, "
                    f"owner = EXCLUDED.owner, heartbeat_at = {now}, "
                    "dispatch_key = COALESCE(EXCLUDED.dispatch_key, ingest_jobs.dispatch_key), "
                    "collection_name = EXCLUDED.collection_name"
                ),
                # warnings=False: the adapter deliberately stores completed_at as
                # an ISO string (bypassing Pydantic coercion); silence the
                # serializer notice — it round-trips back to a datetime on read.
                {
                    "job_id": status.job_id,
                    "status_json": status.model_dump_json(warnings=False),
                    "owner": OWNER,
                    "dispatch_key": status.metadata.get("dispatch_key"),
                    "collection_name": status.collection_name,
                },
            )
            conn.commit()
    except Exception:
        logger.warning("Failed to persist ingest status for %s (will retry)", status.job_id, exc_info=True)
        return False
    return True


def heartbeat(job_ids: Iterable[str]) -> int | None:
    """Refresh ``heartbeat_at`` on this process's rows for ``job_ids``; how many rows. Never raises.

    Fewer rows than ids means a row is not this process's any more (another
    replica settled it while this one could not beat) or was never written; the
    caller re-writes those jobs. None when nothing could be asked: no database,
    or the update failed.
    """
    ids = list(job_ids)
    url = _db_url()
    if not url:
        return None
    if not ids:
        return 0
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        # A constant statement: CURRENT_TIMESTAMP means the same on Postgres and
        # SQLite, so nothing here is composed; owner and ids are bound.
        statement = text(
            "UPDATE ingest_jobs SET heartbeat_at = CURRENT_TIMESTAMP WHERE owner = :owner AND job_id IN :ids"
        ).bindparams(bindparam("ids", expanding=True))
        with engine.connect() as conn:
            refreshed = conn.execute(statement, {"owner": OWNER, "ids": ids}).rowcount
            conn.commit()
    except Exception:
        logger.warning("Ingest heartbeat failed for %d job(s) (continuing)", len(ids), exc_info=True)
        return None
    return refreshed


def get(job_id: str) -> IngestionJobStatus | None:
    """Return a persisted status from any replica, or None. Never raises.

    A live row whose owner stopped beating comes back ``failed`` with reason
    ``interrupted``, and is stored that way. When the owner beat again between
    the read and the settling write, the row as it now stands comes back.
    """
    url = _db_url()
    if not url:
        return None
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            row = conn.execute(
                # The predicate is built from module constants; job_id is bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT status_json, {_stale_predicate(url)} AS stale FROM ingest_jobs WHERE job_id = :job_id"),
                {"job_id": job_id},
            ).first()
            return _as_read(conn, url, row[0], row[1]) if row is not None else None
    except Exception:
        logger.warning("Failed to read ingest status for %s", job_id, exc_info=True)
        return None


def _as_read(conn, url: str, status_json: str, stale: bool) -> IngestionJobStatus | None:
    """A stored row as a reader sees it: a live row whose owner is gone is settled as interrupted first.

    None only when the row vanished between the read and the settling write.
    """
    status = IngestionJobStatus.model_validate_json(status_json)
    if not (stale and _is_live(status)):
        return status
    return _settle_interrupted(conn, url, status) or _read(conn, status.job_id)


def find_live(dispatch_key: str) -> IngestionJobStatus | None:
    """The live job some replica holds for this dispatch, or None. Never raises.

    What makes ``POST /v1/ingest`` idempotent across replicas: a retried
    dispatch of the same object for the same document gets the job already
    running. A row whose owner is gone is settled as interrupted on the way and
    does not count.
    """
    url = _db_url()
    if not url or not dispatch_key:
        return None
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            rows = conn.execute(
                # The predicate is built from module constants; the key is bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"SELECT status_json, {_stale_predicate(url)} AS stale FROM ingest_jobs "
                    "WHERE dispatch_key = :key ORDER BY updated_at DESC LIMIT 5"
                ),
                {"key": dispatch_key},
            ).all()
            for status_json, stale in rows:
                status = IngestionJobStatus.model_validate_json(status_json)
                if not _is_live(status):
                    continue
                if not stale:
                    return status
                if _settle_interrupted(conn, url, status) is not None:
                    continue
                # The owner beat between the read and the settle: live after all.
                current = _read(conn, status.job_id)
                if current is not None and _is_live(current):
                    return current
    except Exception:
        logger.warning("Could not look up a live ingest job (continuing)", exc_info=True)
    return None


def fail_interrupted() -> int:
    """Settle live rows whose owner is gone as ``interrupted``; how many. Never raises.

    Run once when an ingestor starts, so what a restart stranded is settled
    without waiting for someone to poll it. A row whose owner died moments
    before this restart is not stale yet; ``get`` settles it when it is read.
    """
    url = _db_url()
    if not url:
        return 0
    settled = 0
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            rows = (
                conn.execute(
                    # Built from module constants only; nothing here is user input.
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"SELECT status_json FROM ingest_jobs WHERE {_stale_predicate(url)} "
                        f"ORDER BY updated_at DESC LIMIT {_SWEEP_LIMIT}"
                    )
                )
                .scalars()
                .all()
            )
            live = [status for status in map(IngestionJobStatus.model_validate_json, rows) if _is_live(status)]
            # Counted only when the conditional update matched: a row whose
            # owner beat since the read was not settled.
            settled = sum(_settle_interrupted(conn, url, status) is not None for status in live)
    except Exception:
        logger.warning("Could not settle interrupted ingest jobs (continuing)", exc_info=True)
    return settled


#: A crashed worker used to leave a row at ``processing`` forever, and a prompt
#: that says "this file is still being read" about a job that died an hour ago
#: is worse than saying nothing: the reader waits for something that is not
#: coming. A row counts as in flight only while its owner vouches for it (see
#: ``_stale_predicate``); that replaced a fixed fifteen-minute window, which
#: also dropped a live job that spent longer than that on one large file.

#: Ceiling on rows read for one turn's question. This runs on the chat path.
_IN_FLIGHT_SCAN_LIMIT = 200


def in_flight_files(collections: Iterable[str]) -> dict[str, list[str]]:
    """Filenames still being ingested, per collection. Never raises.

    THE AGENT HAS TO KNOW A FILE IS COMING. Ingestion is asynchronous, and the
    per-turn inventory is built from the SUMMARIES table, which is written only
    when a job finishes — so a document uploaded seconds ago is invisible to the
    turn in exactly the way it is invisible to retrieval, and the model answers
    confidently without the one document the question is about.

    This is the missing half of that: not what has been read, but what is being
    read. Callers put it in the prompt so the answer can say so.

    Bounded by the owner's heartbeat and ``_IN_FLIGHT_SCAN_LIMIT``, and
    filtered in Python rather than in SQL because ``status_json`` is a text
    column and JSON predicates are not portable between the Postgres and SQLite
    backings this store supports.
    """
    wanted = {c for c in collections if c}
    if not wanted:
        return {}
    url = _db_url()
    if not url:
        return {}
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            rows = (
                conn.execute(
                    # The predicate is a dialect-chosen literal built from module
                    # constants; nothing here is user input.
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        "SELECT status_json FROM ingest_jobs "
                        f"WHERE NOT {_stale_predicate(url)} "
                        "ORDER BY updated_at DESC "
                        f"LIMIT {_IN_FLIGHT_SCAN_LIMIT}"
                    )
                )
                .scalars()
                .all()
            )
    except Exception:
        logger.warning("Could not read in-flight ingest jobs (continuing)", exc_info=True)
        return {}

    pending: dict[str, list[str]] = {}
    for row in rows:
        try:
            status = IngestionJobStatus.model_validate_json(row)
        except Exception:  # noqa: BLE001 - one unreadable row must not cost the rest
            continue
        if status.collection_name not in wanted:
            continue
        if status.status not in (JobState.PENDING, JobState.PROCESSING):
            continue
        # ``SUCCESS`` is the file-level terminal token (``JobState`` has
        # ``COMPLETED``; ``FileStatus`` does not). Comparing against the member
        # that did not exist raised on the first job that carried per-file
        # detail, the caller swallowed it, and the "still being read" warning
        # this function feeds never fired for exactly the uploads it was for.
        names = [
            detail.file_name
            for detail in status.file_details
            if detail.status not in (FileStatus.SUCCESS, FileStatus.FAILED) and detail.file_name
        ]
        # A job with no per-file detail yet is still a job in flight; the
        # collection alone is what the caller needs in that case.
        bucket = pending.setdefault(status.collection_name, [])
        for name in names:
            if name not in bucket:
                bucket.append(name)
    return pending


def _submitted(status: IngestionJobStatus) -> datetime:
    """When the job was submitted, as the naive UTC the adapter writes it (a zone is dropped, not converted)."""
    return status.submitted_at.replace(tzinfo=None)


def collection_jobs(collection_name: str, within_seconds: int) -> list[IngestionJobStatus]:
    """Every job of ``collection_name`` written in the last ``within_seconds``, oldest submission first.

    What a process that did not run the jobs reads to say which files of a
    collection failed or are still being read (see the module docstring). A
    live row whose owner is gone comes back settled as interrupted, as in
    ``get``. With no database configured nothing is stored and the answer is
    empty. A database error raises: a file listing built without these rows
    would omit the files nobody else can tell about, and say nothing of it.
    """
    url = _db_url()
    if not url:
        return []
    _ensure_table(url)
    engine = DocumentMetadataStore._get_or_create_sync_engine(url)
    with engine.connect() as conn:
        rows = conn.execute(
            # The predicate and the window are built from constants and an int;
            # the collection is bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"SELECT status_json, {_stale_predicate(url)} AS stale FROM ingest_jobs "
                f"WHERE collection_name = :collection_name AND updated_at > {_ago(url, int(within_seconds))}"
            ),
            {"collection_name": collection_name},
        ).all()
        seen = [_as_read(conn, url, status_json, stale) for status_json, stale in rows]
    return sorted((status for status in seen if status is not None), key=lambda s: (_submitted(s), s.job_id))


def forget_file(collection_name: str, file_name: str) -> int:
    """Remove ``file_name`` from the finished jobs of ``collection_name``; how many jobs named it.

    A file that failed has no chunks, so its job row is the only record of it
    and a delete has nothing else to remove. A job left with no file is deleted
    with its row. A job still running keeps its files: its worker owns that
    record, and a file deleted while it is read is the ingest's business
    (``document_presence``). Raises on a database error, so a delete that
    could not forget the file does not report that it did.
    """
    url = _db_url()
    if not url:
        return 0
    _ensure_table(url)
    engine = DocumentMetadataStore._get_or_create_sync_engine(url)
    forgotten = 0
    with engine.connect() as conn:
        rows = conn.execute(
            # The predicate is built from module constants; the collection is bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"SELECT status_json, {_stale_predicate(url)} AS stale FROM ingest_jobs "
                "WHERE collection_name = :collection_name"
            ),
            {"collection_name": collection_name},
        ).all()
        for status_json, stale in rows:
            status = _as_read(conn, url, status_json, stale)
            if status is None or _is_live(status):
                continue
            kept = [detail for detail in status.file_details if detail.file_name != file_name]
            if len(kept) == len(status.file_details):
                continue
            if kept:
                status.file_details = kept
                conn.execute(
                    text("UPDATE ingest_jobs SET status_json = :status_json WHERE job_id = :job_id"),
                    {"job_id": status.job_id, "status_json": status.model_dump_json(warnings=False)},
                )
            else:
                conn.execute(text("DELETE FROM ingest_jobs WHERE job_id = :job_id"), {"job_id": status.job_id})
            forgotten += 1
        conn.commit()
    return forgotten


def forget_collection(collection_name: str) -> None:
    """Remove every job row of a deleted collection (best-effort).

    A name that is used again would otherwise list the files of the collection
    that held it before.
    """
    url = _db_url()
    if not url:
        return
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            conn.execute(
                text("DELETE FROM ingest_jobs WHERE collection_name = :collection_name"),
                {"collection_name": collection_name},
            )
            conn.commit()
    except Exception:
        logger.warning("Failed to forget the ingest jobs of collection %s", collection_name, exc_info=True)


def prune_expired(older_than_seconds: int) -> int:
    """Delete rows nobody vouches for that were last written over ``older_than_seconds`` ago; how many. Never raises.

    What bounds the table, and how long a failed file stays listed: a finished
    job's row is its last record. A row a worker could still claim is never
    deleted (``_stale_predicate``).
    """
    url = _db_url()
    if not url:
        return 0
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            deleted = conn.execute(
                # Built from module constants and an int; nothing here is user input.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"DELETE FROM ingest_jobs WHERE updated_at < {_ago(url, int(older_than_seconds))} "
                    f"AND {_stale_predicate(url)}"
                )
            ).rowcount
            conn.commit()
    except Exception:
        logger.warning("Could not prune expired ingest jobs (continuing)", exc_info=True)
        return 0
    return deleted


def delete(job_id: str) -> None:
    """Remove a persisted status row (best-effort)."""
    url = _db_url()
    if not url:
        return
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            conn.execute(text("DELETE FROM ingest_jobs WHERE job_id = :job_id"), {"job_id": job_id})
            conn.commit()
    except Exception:
        logger.warning("Failed to delete ingest status for %s", job_id, exc_info=True)
