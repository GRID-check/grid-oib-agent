"""AIQ-owned claim queue for DB-claimed research workers (ADR-0021).

When ``GRID_JOB_EXECUTION=db`` the submit path persists a deep-research job as a
row here instead of dispatching it to a per-pod Dask cluster. Dedicated worker
containers claim rows with ``FOR UPDATE SKIP LOCKED`` (the proven purger
pattern, ``frontends/ui/purger/db.js``), run the job in-process, and heartbeat
the row so a crashed worker's job is reclaimed. This is what lets research
execution scale horizontally across worker replicas.

This table carries only *dispatch* metadata + the serialized ``run_agent_job``
payload. User-facing status stays in NAT's ``job_info`` (written by the runner)
and events stay in ``job_events`` — SSE streaming and admission counting are
unchanged.

Cancellation is handled entirely through ``job_info`` (the cancel route flips it
to INTERRUPTED, which the runner's ``CancellationMonitor`` honors) plus deleting
the queue row, so there is deliberately no ``cancel_requested`` column here.
"""

from __future__ import annotations

from datetime import UTC
from datetime import datetime
from datetime import timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from . import payload_crypto

_queue_schema_initialized: set[str] = set()

# Claim states.
QUEUED = "queued"
CLAIMED = "claimed"


def _is_postgres(db_url: str) -> bool:
    return db_url.startswith("postgres")


def _connection(db_url: str) -> Connection:
    from .event_store import EventStore

    return EventStore._get_or_create_sync_engine(db_url).connect()


def _table_sql(db_url: str) -> str:
    if _is_postgres(db_url):
        ts = "TIMESTAMP WITH TIME ZONE"
        default_now = "DEFAULT NOW()"
    else:
        ts = "DATETIME"
        default_now = "DEFAULT CURRENT_TIMESTAMP"
    return (
        "CREATE TABLE IF NOT EXISTS research_job_queue ("
        "  job_id VARCHAR PRIMARY KEY,"
        "  payload TEXT NOT NULL,"
        f"  status VARCHAR NOT NULL DEFAULT '{QUEUED}',"
        "  claimed_by VARCHAR,"
        f"  claimed_at {ts},"
        f"  heartbeat_at {ts},"
        "  attempts INTEGER NOT NULL DEFAULT 0,"
        f"  created_at {ts} {default_now}"
        ")"
    )


_INDEX_SQL = "CREATE INDEX IF NOT EXISTS idx_research_queue_status ON research_job_queue(status, created_at)"


def ensure_research_queue_table(db_url: str) -> None:
    with _connection(db_url) as conn:
        _ensure_schema(conn, db_url)
        conn.commit()


def _ensure_schema(conn: Connection, db_url: str) -> None:
    if db_url in _queue_schema_initialized:
        return
    conn.execute(text(_table_sql(db_url)))
    conn.execute(text(_INDEX_SQL))
    _queue_schema_initialized.add(db_url)


def enqueue(db_url: str, job_id: str, payload: dict[str, Any]) -> None:
    """Persist a claimable research job. Payload = ``run_agent_job`` kwargs."""
    with _connection(db_url) as conn:
        _ensure_schema(conn, db_url)
        conn.execute(
            text(
                "INSERT INTO research_job_queue (job_id, payload, status, attempts) "
                f"VALUES (:job_id, :payload, '{QUEUED}', 0)"
            ),
            {"job_id": job_id, "payload": payload_crypto.serialize(payload)},
        )
        conn.commit()


def claim_next(db_url: str, worker_id: str, stale_seconds: int, max_attempts: int) -> dict[str, Any] | None:
    """Atomically claim one runnable job (queued, or stale-claimed for reclaim).

    Returns ``{"job_id", "payload", "attempts"}`` or None when nothing is
    runnable. On Postgres this is a single ``FOR UPDATE SKIP LOCKED`` CTE so N
    workers never double-claim. On SQLite (single-worker dev/test only) it is a
    SELECT-then-UPDATE; SQLite serializes writes but the read+write is not one
    atomic step, so it must not be relied on for real concurrency.
    """
    with _connection(db_url) as conn:
        _ensure_schema(conn, db_url)
        if _is_postgres(db_url):
            row = (
                conn.execute(
                    text(
                        "WITH claimable AS ("
                        "  SELECT job_id FROM research_job_queue"
                        f"  WHERE status = '{QUEUED}'"
                        f"    OR (status = '{CLAIMED}' AND attempts < :max_attempts"
                        "        AND heartbeat_at < NOW() - make_interval(secs => :stale))"
                        "  ORDER BY created_at"
                        "  FOR UPDATE SKIP LOCKED LIMIT 1"
                        ")"
                        "UPDATE research_job_queue q "
                        f"SET status = '{CLAIMED}', claimed_by = :worker, claimed_at = NOW(), "
                        "    heartbeat_at = NOW(), attempts = attempts + 1 "
                        "FROM claimable WHERE q.job_id = claimable.job_id "
                        "RETURNING q.job_id, q.payload, q.attempts"
                    ),
                    {"worker": worker_id, "stale": stale_seconds, "max_attempts": max_attempts},
                )
                .mappings()
                .first()
            )
            conn.commit()
        else:
            threshold = (datetime.now(UTC) - timedelta(seconds=stale_seconds)).strftime("%Y-%m-%d %H:%M:%S")
            found = (
                conn.execute(
                    text(
                        "SELECT job_id, payload, attempts FROM research_job_queue "
                        f"WHERE status = '{QUEUED}'"
                        f"  OR (status = '{CLAIMED}' AND attempts < :max_attempts AND heartbeat_at < :threshold)"
                        " ORDER BY created_at LIMIT 1"
                    ),
                    {"threshold": threshold, "max_attempts": max_attempts},
                )
                .mappings()
                .first()
            )
            if found is None:
                return None
            conn.execute(
                text(
                    f"UPDATE research_job_queue SET status = '{CLAIMED}', claimed_by = :worker, "
                    "claimed_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP, attempts = attempts + 1 "
                    "WHERE job_id = :job_id"
                ),
                {"worker": worker_id, "job_id": found["job_id"]},
            )
            conn.commit()
            row = {"job_id": found["job_id"], "payload": found["payload"], "attempts": found["attempts"] + 1}
        if row is None:
            return None
        return {
            "job_id": row["job_id"],
            "payload": payload_crypto.deserialize(row["payload"]),
            "attempts": row["attempts"],
        }


def heartbeat(db_url: str, job_id: str, worker_id: str) -> bool:
    """Refresh the claim's heartbeat. Returns False if we no longer own it
    (reclaimed by another worker / row deleted by cancel) so the worker can
    abort its run promptly and avoid duplicate execution."""
    now = "NOW()" if _is_postgres(db_url) else "CURRENT_TIMESTAMP"
    with _connection(db_url) as conn:
        _ensure_schema(conn, db_url)
        result = conn.execute(
            text(
                f"UPDATE research_job_queue SET heartbeat_at = {now} "
                f"WHERE job_id = :job_id AND claimed_by = :worker AND status = '{CLAIMED}'"
            ),
            {"job_id": job_id, "worker": worker_id},
        )
        conn.commit()
        return (result.rowcount or 0) > 0


def mark_done(db_url: str, job_id: str, worker_id: str | None = None) -> None:
    """Remove a finished job's queue row (terminal status lives in job_info).

    When ``worker_id`` is given the delete is guarded by ownership, so a stalled
    worker that lost its claim (and whose job another worker now owns) cannot
    delete the new owner's live row. The cancel route passes no worker_id — it
    intends to drop the row unconditionally.
    """
    sql = "DELETE FROM research_job_queue WHERE job_id = :job_id"
    params: dict[str, Any] = {"job_id": job_id}
    if worker_id is not None:
        sql += " AND claimed_by = :worker"
        params["worker"] = worker_id
    with _connection(db_url) as conn:
        _ensure_schema(conn, db_url)
        conn.execute(text(sql), params)
        conn.commit()


def reap_exhausted(db_url: str, stale_seconds: int, max_attempts: int) -> list[str]:
    """Delete claims that crashed and exhausted their retries; return their ids.

    Callers flip these to FAILURE in job_info (the durable record); the queue
    row is removed here so the table never accumulates dead rows.
    """
    if _is_postgres(db_url):
        stale_clause = "heartbeat_at < NOW() - make_interval(secs => :stale)"
        params: dict[str, Any] = {"stale": stale_seconds, "max_attempts": max_attempts}
    else:
        threshold = (datetime.now(UTC) - timedelta(seconds=stale_seconds)).strftime("%Y-%m-%d %H:%M:%S")
        stale_clause = "heartbeat_at < :threshold"
        params = {"threshold": threshold, "max_attempts": max_attempts}
    with _connection(db_url) as conn:
        _ensure_schema(conn, db_url)
        rows = (
            conn.execute(
                text(
                    "SELECT job_id FROM research_job_queue "
                    f"WHERE status = '{CLAIMED}' AND attempts >= :max_attempts AND {stale_clause}"
                ),
                params,
            )
            .scalars()
            .all()
        )
        for job_id in rows:
            conn.execute(text("DELETE FROM research_job_queue WHERE job_id = :job_id"), {"job_id": job_id})
        if rows:
            conn.commit()
        return list(rows)
