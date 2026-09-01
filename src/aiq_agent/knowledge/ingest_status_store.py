"""Shared, cross-replica store for ingestion job status.

Ingestion *executes* on the replica that accepted the upload (a bounded local
thread pool), but its status must be readable from ANY replica — otherwise a
``GET /v1/documents/{job_id}/status`` poll routed elsewhere 404s. This persists
each ``IngestionJobStatus`` (a Pydantic model → JSON) to Postgres so every
replica serves the same answer. It reuses the DocumentMetadataStore engine cache and the
summaries database (``AIQ_SUMMARY_DB``, falling back to ``NAT_JOB_STORE_DB_URL``).

Best-effort / fail-open: with no DB configured (local dev) every call is a
no-op and the adapter falls back to its in-process dict — single-node behaviour
is unchanged.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable

from sqlalchemy import text

from .document_metadata_store import DocumentMetadataStore
from .schema import FileStatus
from .schema import IngestionJobStatus
from .schema import JobState

logger = logging.getLogger(__name__)

_initialized: set[str] = set()


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
    with engine.connect() as conn:
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
        conn.commit()
    _initialized.add(url)


def put(status: IngestionJobStatus) -> None:
    """Upsert a job's status. Never raises — ingestion must not break on a DB blip."""
    url = _db_url()
    if not url:
        return
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        now = "NOW()" if _is_postgres(url) else "CURRENT_TIMESTAMP"
        with engine.connect() as conn:
            conn.execute(
                # now is a dialect-chosen literal; job_id/status_json are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    "INSERT INTO ingest_jobs (job_id, status_json, updated_at) "
                    f"VALUES (:job_id, :status_json, {now}) "
                    "ON CONFLICT (job_id) DO UPDATE SET "
                    f"status_json = EXCLUDED.status_json, updated_at = {now}"
                ),
                # warnings=False: the adapter deliberately stores completed_at as
                # an ISO string (bypassing Pydantic coercion); silence the
                # serializer notice — it round-trips back to a datetime on read.
                {"job_id": status.job_id, "status_json": status.model_dump_json(warnings=False)},
            )
            conn.commit()
    except Exception:
        logger.warning("Failed to persist ingest status for %s (continuing)", status.job_id, exc_info=True)


def get(job_id: str) -> IngestionJobStatus | None:
    """Return a persisted status from any replica, or None. Never raises."""
    url = _db_url()
    if not url:
        return None
    try:
        _ensure_table(url)
        engine = DocumentMetadataStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT status_json FROM ingest_jobs WHERE job_id = :job_id"),
                {"job_id": job_id},
            ).scalar()
        if row is None:
            return None
        return IngestionJobStatus.model_validate_json(row)
    except Exception:
        logger.warning("Failed to read ingest status for %s", job_id, exc_info=True)
        return None


#: How far back a job may have been touched and still count as "in flight".
#:
#: A crashed worker leaves a row at ``processing`` forever, and a prompt that
#: says "this file is still being read" about a job that died an hour ago is
#: worse than saying nothing: the reader waits for something that is not coming.
#: Ingestion of a large plan set is minutes, so fifteen is generous and still
#: excludes anything stuck.
_IN_FLIGHT_WINDOW_MINUTES = 15

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

    Bounded by ``_IN_FLIGHT_WINDOW_MINUTES`` and ``_IN_FLIGHT_SCAN_LIMIT``, and
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
        cutoff = (
            f"NOW() - INTERVAL '{_IN_FLIGHT_WINDOW_MINUTES} minutes'"
            if _is_postgres(url)
            else f"DATETIME('now', '-{_IN_FLIGHT_WINDOW_MINUTES} minutes')"
        )
        with engine.connect() as conn:
            rows = (
                conn.execute(
                    # cutoff is a dialect-chosen literal built from a module
                    # constant; nothing here is user input.
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        "SELECT status_json FROM ingest_jobs "
                        f"WHERE updated_at > {cutoff} "
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
        names = [
            detail.file_name
            for detail in status.file_details
            if detail.status not in (FileStatus.COMPLETED, FileStatus.FAILED) and detail.file_name
        ]
        # A job with no per-file detail yet is still a job in flight; the
        # collection alone is what the caller needs in that case.
        bucket = pending.setdefault(status.collection_name, [])
        for name in names:
            if name not in bucket:
                bucket.append(name)
    return pending


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
