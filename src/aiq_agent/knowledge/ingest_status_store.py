"""Shared, cross-replica store for ingestion job status.

Ingestion *executes* on the replica that accepted the upload (a bounded local
thread pool), but its status must be readable from ANY replica — otherwise a
``GET /v1/documents/{job_id}/status`` poll routed elsewhere 404s. This persists
each ``IngestionJobStatus`` (a Pydantic model → JSON) to Postgres so every
replica serves the same answer. It reuses the SummaryStore engine cache and the
summaries database (``AIQ_SUMMARY_DB``, falling back to ``NAT_JOB_STORE_DB_URL``).

Best-effort / fail-open: with no DB configured (local dev) every call is a
no-op and the adapter falls back to its in-process dict — single-node behaviour
is unchanged.
"""

from __future__ import annotations

import logging
import os

from sqlalchemy import text

from .schema import IngestionJobStatus
from .summary_store import SummaryStore

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
    engine = SummaryStore._get_or_create_sync_engine(url)
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
        engine = SummaryStore._get_or_create_sync_engine(url)
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
        engine = SummaryStore._get_or_create_sync_engine(url)
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


def delete(job_id: str) -> None:
    """Remove a persisted status row (best-effort)."""
    url = _db_url()
    if not url:
        return
    try:
        _ensure_table(url)
        engine = SummaryStore._get_or_create_sync_engine(url)
        with engine.connect() as conn:
            conn.execute(text("DELETE FROM ingest_jobs WHERE job_id = :job_id"), {"job_id": job_id})
            conn.commit()
    except Exception:
        logger.warning("Failed to delete ingest status for %s", job_id, exc_info=True)
