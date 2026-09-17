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

import logging
from datetime import UTC
from datetime import datetime
from datetime import timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from . import payload_crypto

logger = logging.getLogger(__name__)

_queue_schema_initialized: set[str] = set()

# Claim states.
QUEUED = "queued"
CLAIMED = "claimed"

# Marker key on ``claim_next`` results whose stored payload could not be
# deserialized (corrupt ``enc:`` blob, undecryptable KEK rotation, forged
# plaintext under KEK). The row is already quarantined (deleted) when the
# marker is returned, so the worker must record the FAILURE verdict in
# ``job_info`` and move on — never hand the row to ``run_agent_job``.
POISON_CLAIM_MARKER = "poison"

# Transaction-level advisory lock so only ONE worker replica runs the
# exhausted-claim reap per cycle. Without it every worker ran the scan+delete on
# every poll tick, so DB load scaled with replica count, not job volume
# (scaling review phase-2, item 12). Distinct from the web-tier reaper/cleanup
# lock ids in routes/jobs.py. "AIQRXHS" in hex.
_PG_REAP_EXHAUSTED_LOCK_ID = 0x41495152_58485300


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
            # Only the QUEUED status constant is interpolated; job_id/payload are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                "INSERT INTO research_job_queue (job_id, payload, status, attempts) "
                f"VALUES (:job_id, :payload, '{QUEUED}', 0)"
            ),
            {"job_id": job_id, "payload": payload_crypto.serialize(payload)},
        )
        conn.commit()


def _quarantine_poison(conn: Connection, job_id: str, exc: Exception) -> dict[str, Any]:
    """Delete an undecryptable/unparsable queue row inside the open transaction.

    A poison payload is deterministic: retrying it after the stale window just
    kills the next claimant identically (attempts+1 each cycle until reap).
    Deleting it here means the row is never committed as CLAIMED, so no worker
    ever blocks on it and no replica ever dies on it. The caller returns the
    marker so the worker can record the FAILURE verdict in ``job_info`` (the
    durable record) plus a ``job.error`` event — the queue table itself holds
    no terminal state by design.

    Only the exception *type* is kept server-side in the marker detail; the
    raw stored blob is never echoed (it may carry a forged auth token).
    """
    logger.error(
        "Quarantining undecryptable queue payload for job %s (%s); row deleted, not claimed",
        job_id,
        type(exc).__name__,
        exc_info=True,
    )
    conn.execute(text("DELETE FROM research_job_queue WHERE job_id = :job_id"), {"job_id": job_id})
    conn.commit()
    return {
        "job_id": job_id,
        POISON_CLAIM_MARKER: True,
        "poison_error": f"{type(exc).__name__}: job payload undecryptable or unparsable",
    }


def claim_next(db_url: str, worker_id: str, stale_seconds: int, max_attempts: int) -> dict[str, Any] | None:
    """Atomically claim one runnable job (queued, or stale-claimed for reclaim).

    Returns ``{"job_id", "payload", "attempts"}``, a poison marker
    ``{"job_id", "poison": True, "poison_error": ...}`` (row already
    quarantined — record FAILURE, never execute), or None when nothing is
    runnable. On Postgres this is a single ``FOR UPDATE SKIP LOCKED`` CTE so N
    workers never double-claim. On SQLite (single-worker dev/test only) it is a
    SELECT-then-UPDATE; SQLite serializes writes but the read+write is not one
    atomic step, so it must not be relied on for real concurrency.

    Poison payloads never raise: deserialization happens *before* the claim
    commits (Postgres) or *before* the claim UPDATE (SQLite), and a failure
    quarantines the row in the same transaction. The worker loop therefore
    survives a corrupt ``enc:`` blob by construction, and the next claim in
    the same tick already sees the healthy row behind it.
    """
    with _connection(db_url) as conn:
        _ensure_schema(conn, db_url)
        if _is_postgres(db_url):
            row = (
                conn.execute(
                    # Only the QUEUED/CLAIMED status constants are interpolated; worker/stale/max_attempts are bound.
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
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
            if row is None:
                conn.commit()
                return None
            try:
                payload = payload_crypto.deserialize(row["payload"])
                if not isinstance(payload, dict):
                    raise ValueError(f"job payload decoded to {type(payload).__name__}, not a dict")
            except Exception as exc:
                # Deserialize-before-commit: the UPDATE above is still
                # uncommitted, so quarantining here never leaves a CLAIMED
                # poison row behind for the next replica to die on.
                return _quarantine_poison(conn, row["job_id"], exc)
            conn.commit()
            return {
                "job_id": row["job_id"],
                "payload": payload,
                "attempts": row["attempts"],
            }
        else:
            threshold = (datetime.now(UTC) - timedelta(seconds=stale_seconds)).strftime("%Y-%m-%d %H:%M:%S")
            found = (
                conn.execute(
                    # Only the QUEUED/CLAIMED status constants are interpolated; threshold/max_attempts are bound.
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
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
            try:
                payload = payload_crypto.deserialize(found["payload"])
                if not isinstance(payload, dict):
                    raise ValueError(f"job payload decoded to {type(payload).__name__}, not a dict")
            except Exception as exc:
                # Deserialize-before-claim: never promote a poison row to
                # CLAIMED. Quarantine it and return the marker; the worker
                # records FAILURE and its next claim sees the healthy row.
                return _quarantine_poison(conn, found["job_id"], exc)
            conn.execute(
                # Only the CLAIMED status constant is interpolated; worker/job_id are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE research_job_queue SET status = '{CLAIMED}', claimed_by = :worker, "
                    "claimed_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP, attempts = attempts + 1 "
                    "WHERE job_id = :job_id"
                ),
                {"worker": worker_id, "job_id": found["job_id"]},
            )
            conn.commit()
            return {"job_id": found["job_id"], "payload": payload, "attempts": found["attempts"] + 1}


def heartbeat(db_url: str, job_id: str, worker_id: str) -> bool:
    """Refresh the claim's heartbeat. Returns False if we no longer own it
    (reclaimed by another worker / row deleted by cancel) so the worker can
    abort its run promptly and avoid duplicate execution."""
    now = "NOW()" if _is_postgres(db_url) else "CURRENT_TIMESTAMP"
    with _connection(db_url) as conn:
        _ensure_schema(conn, db_url)
        result = conn.execute(
            # now/CLAIMED are dialect literal + status constant; job_id/worker are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"UPDATE research_job_queue SET heartbeat_at = {now} "
                f"WHERE job_id = :job_id AND claimed_by = :worker AND status = '{CLAIMED}'"
            ),
            {"job_id": job_id, "worker": worker_id},
        )
        conn.commit()
        return (result.rowcount or 0) > 0


def claim_owner(db_url: str, job_id: str) -> str | None:
    """The worker holding the live CLAIMED row for ``job_id``, or None.

    Read-only ownership probe for the runner's still-owner publish gate
    (deep-research hardening, item 10): a worker that lost its claim to another
    replica must publish nothing user-visible — no terminal status steal, no
    thread turn or notice — so the thread, the persisted report and the job
    status stay one coherent artefact, published by the winner alone.

    None is *indeterminate*, not "unowned": the row may be gone (the cancel
    route and mark_done delete it unconditionally on their paths), may still be
    QUEUED, or may be unreadable. Callers fall back to the job_info terminal
    verdict in that case and fail open. Never raises.
    """
    try:
        with _connection(db_url) as conn:
            _ensure_schema(conn, db_url)
            row = conn.execute(
                text("SELECT claimed_by FROM research_job_queue WHERE job_id = :job_id AND status = :claimed"),
                {"job_id": job_id, "claimed": CLAIMED},
            ).first()
    except Exception:
        logger.warning("Claim-ownership read failed for job %s (treating as indeterminate)", job_id, exc_info=True)
        return None
    if row is None:
        return None
    owner = row[0]
    return owner if isinstance(owner, str) and owner else None


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
        # Leader-elect per cycle: on Postgres a single replica holds the xact lock
        # and reaps; the rest skip the scan entirely (the lock auto-releases at
        # commit/close). SQLite (dev, single process) needs no lock.
        if _is_postgres(db_url):
            locked = conn.execute(
                text("SELECT pg_try_advisory_xact_lock(:id)"), {"id": _PG_REAP_EXHAUSTED_LOCK_ID}
            ).scalar()
            if not locked:
                return []
        rows = (
            conn.execute(
                # CLAIMED constant + dialect-chosen stale_clause literal; max_attempts/threshold are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
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
