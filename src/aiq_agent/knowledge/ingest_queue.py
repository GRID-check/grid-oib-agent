"""The durable, fair claim queue for ingestion jobs.

An ingestion job lives here as a row, not in the memory of the replica that
accepted it, so a restart does not lose queued jobs, a replica can take work
from another, and ingestion scales apart from the chat tier. Whichever worker is
free claims the row, on any replica or in the dedicated ingest-worker tier
(``aiq_api.jobs.ingest_worker``), with ``FOR UPDATE SKIP LOCKED`` so no two claim
it, and a heartbeat so a crashed worker's job is claimed again (the research
queue's pattern, ``aiq_api.jobs.queue``).

THE CLAIM IS FAIR, ACROSS THE WHOLE FLEET. A free worker takes the next job of
the LANE (an organisation, or ``PLATFORM_LANE``) with the fewest jobs running
anywhere; among equals, the lane served longest ago (``ingest_lane_turns``);
then the oldest job. So one organisation's thousand-document reindex takes
every worker while it is alone, and the next organisation's upload takes the
next worker that frees up, whatever the backlog ahead of it. The optional
per-lane cap is hard: two claims racing past it both commit, then each checks
again under a per-lane advisory lock, and a claim that finds the lane already
holding its cap puts its job back (``_release_over_cap``).

The payload is opaque here: ``aiq_api.jobs.ingest_dispatch`` writes it
(encrypted, since it carries presigned URLs) and reads it back. This module
only stores, claims and forgets rows, in the same database as the status rows
(``ingest_status_store``), which reads this table to know that a PENDING job
whose accepting replica is gone is still waiting here, not lost.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime
from datetime import timedelta

from sqlalchemy import bindparam
from sqlalchemy import text

from .document_metadata_store import DocumentMetadataStore
from .ingest_scheduler import lane_of

logger = logging.getLogger(__name__)

QUEUED = "queued"
CLAIMED = "claimed"

TABLE = "ingest_job_queue"

_initialized: set[str] = set()

#: One replica reaps exhausted claims per cycle ("AIQINGRP" in hex).
_PG_REAP_LOCK_ID = 0x41495149_4E475250

#: Rows the SQLite claim ranks at once; SQLite backs single-process dev and tests.
_SQLITE_CANDIDATES = 500


@dataclass(frozen=True)
class Claim:
    job_id: str
    lane: str
    payload: str
    attempts: int


def db_url() -> str | None:
    """The database the queue lives in: the ingest status store's."""
    url = os.environ.get("AIQ_SUMMARY_DB") or os.environ.get("NAT_JOB_STORE_DB_URL")
    return url or None


def _is_postgres(url: str) -> bool:
    return url.startswith("postgres")


def _engine(url: str):
    return DocumentMetadataStore._get_or_create_sync_engine(url)


def ensure_table(url: str, conn=None) -> None:
    """Create the queue and the lane-turn tables once per process."""
    if url in _initialized:
        return
    ts = "TIMESTAMP WITH TIME ZONE" if _is_postgres(url) else "DATETIME"
    now = "NOW()" if _is_postgres(url) else "CURRENT_TIMESTAMP"
    statements = [
        f"CREATE TABLE IF NOT EXISTS {TABLE} ("
        "  job_id VARCHAR PRIMARY KEY,"
        "  lane VARCHAR NOT NULL,"
        "  payload TEXT NOT NULL,"
        f"  status VARCHAR NOT NULL DEFAULT '{QUEUED}',"
        "  claimed_by VARCHAR,"
        f"  claimed_at {ts},"
        f"  heartbeat_at {ts},"
        "  attempts INTEGER NOT NULL DEFAULT 0,"
        f"  created_at {ts} DEFAULT {now}"
        ")",
        f"CREATE INDEX IF NOT EXISTS ix_{TABLE}_status_created ON {TABLE} (status, created_at)",
        f"CREATE INDEX IF NOT EXISTS ix_{TABLE}_status_lane_created ON {TABLE} (status, lane, created_at)",
        f"CREATE INDEX IF NOT EXISTS ix_{TABLE}_lane_created ON {TABLE} (lane, created_at)",
        f"CREATE TABLE IF NOT EXISTS ingest_lane_turns (lane VARCHAR PRIMARY KEY, last_claimed_at {ts})",
    ]

    def _run(c) -> None:
        for statement in statements:
            # Table/column names and types are module constants; nothing is user input.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            c.execute(text(statement))

    if conn is not None:
        _run(conn)
    else:
        with _engine(url).connect() as own:
            _run(own)
            own.commit()
    _initialized.add(url)


def enqueue(job_id: str, organization_id: str | None, payload: str) -> None:
    """Store a claimable job. Raises: the caller runs the job locally when this fails."""
    url = db_url()
    if not url:
        raise RuntimeError("no database for the ingest queue")
    ensure_table(url)
    with _engine(url).connect() as conn:
        conn.execute(
            # Only module constants are interpolated; every value is bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(f"INSERT INTO {TABLE} (job_id, lane, payload, status, attempts) VALUES (:id, :lane, :payload, :q, 0)"),
            {"id": job_id, "lane": lane_of(organization_id), "payload": payload, "q": QUEUED},
        )
        conn.commit()


#: Lanes ranked per claim. More than one, so a claim still succeeds while
#: racing claimers hold the top lane's next job; each costs one row lock
#: for the length of the claim.
_PG_LANES_PER_CLAIM = 4

_RUNNABLE = (
    "(q.status = :queued OR (q.status = :claimed AND q.attempts < :max_attempts "
    "AND q.heartbeat_at < NOW() - make_interval(secs => :stale)))"
)

# Two steps, so a claim never sorts the whole backlog: rank the LANES (one row
# per organisation with work), then take the oldest runnable job of the best
# few through the (lane, created_at) index. 100 000 queued jobs across 2 000
# organisations: ~165 ms per claim as one sort over every job, see the ADR.
_PG_CLAIM = f"""
WITH running AS (
    SELECT lane, COUNT(*) AS n FROM {TABLE}
    WHERE status = :claimed AND heartbeat_at >= NOW() - make_interval(secs => :stale)
    GROUP BY lane
),
lanes AS (
    SELECT w.lane, COALESCE(r.n, 0) AS n, t.last_claimed_at, w.oldest
    FROM (SELECT q.lane, MIN(q.created_at) AS oldest FROM {TABLE} q WHERE {_RUNNABLE} GROUP BY q.lane) w
    LEFT JOIN running r ON r.lane = w.lane
    LEFT JOIN ingest_lane_turns t ON t.lane = w.lane
    WHERE (:cap = 0 OR COALESCE(r.n, 0) < :cap)
    ORDER BY COALESCE(r.n, 0), t.last_claimed_at NULLS FIRST, w.oldest
    LIMIT {_PG_LANES_PER_CLAIM}
),
candidate AS (
    SELECT pick.job_id FROM lanes
    CROSS JOIN LATERAL (
        SELECT q.job_id FROM {TABLE} q
        WHERE q.lane = lanes.lane AND {_RUNNABLE}
        ORDER BY q.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    ) pick
    ORDER BY lanes.n, lanes.last_claimed_at NULLS FIRST, lanes.oldest
    LIMIT 1
),
claimed AS (
    UPDATE {TABLE} q
    SET status = :claimed, claimed_by = :worker, claimed_at = NOW(), heartbeat_at = NOW(),
        attempts = q.attempts + 1
    FROM candidate WHERE q.job_id = candidate.job_id
    RETURNING q.job_id, q.lane, q.payload, q.attempts, q.claimed_at
),
turn AS (
    INSERT INTO ingest_lane_turns (lane, last_claimed_at)
    SELECT lane, NOW() FROM claimed
    ON CONFLICT (lane) DO UPDATE SET last_claimed_at = EXCLUDED.last_claimed_at
)
SELECT job_id, lane, payload, attempts, claimed_at FROM claimed
"""


def claim_next(worker: str, *, stale_seconds: int, max_attempts: int, per_lane_cap: int = 0) -> Claim | None:
    """Claim the fairest runnable job (see the module docstring), or None."""
    url = db_url()
    if not url:
        return None
    ensure_table(url)
    params = {
        "worker": worker,
        "stale": stale_seconds,
        "max_attempts": max_attempts,
        "cap": max(0, per_lane_cap),
        "queued": QUEUED,
        "claimed": CLAIMED,
    }
    with _engine(url).connect() as conn:
        if _is_postgres(url):
            # The statement is a module constant; every value is bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            row = conn.execute(text(_PG_CLAIM), params).first()
        else:
            row = _claim_sqlite(conn, params)
        conn.commit()
        if row is None:
            return None
        if params["cap"] and _release_over_cap(conn, url, row, params):
            return None
    return Claim(job_id=row[0], lane=row[1], payload=row[2], attempts=row[3])


def _release_over_cap(conn, url: str, row, params: dict) -> bool:
    """Put a claim back when its lane already holds ``cap`` other live claims; whether it did.

    The claim query skips a lane at its cap, but two claims committing at once
    each saw the lane one under it. So every claim, once committed, checks again
    under a per-lane advisory lock, counting EVERY other live claim of the lane.
    The checks run one at a time and each claim commits before its own check, so
    the last check of a race sees all the others and the lane ends at most at
    its cap. A claim given back costs no attempt; the next free worker takes it.
    (Ranking by claim time would not do: a transaction's start time is not its
    commit order.)
    """
    job_id, lane = row[0], row[1]
    postgres = _is_postgres(url)
    if postgres:
        conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:lane))"), {"lane": f"ingest-cap:{lane}"})
        fresh = "heartbeat_at >= NOW() - make_interval(secs => :stale)"
    else:
        fresh = "heartbeat_at >= :threshold"
    threshold = (datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=params["stale"])).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    others = conn.execute(
        # `fresh` is a dialect-chosen literal, the rest module constants; values are bound.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(f"SELECT COUNT(*) FROM {TABLE} WHERE lane = :lane AND status = :claimed AND {fresh} AND job_id <> :id"),
        {"lane": lane, "claimed": CLAIMED, "stale": params["stale"], "threshold": threshold, "id": job_id},
    ).scalar()
    if int(others or 0) < params["cap"]:
        conn.commit()
        return False
    conn.execute(
        # Only module constants are interpolated; values are bound.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"UPDATE {TABLE} SET status = :queued, claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, "
            "attempts = attempts - 1 WHERE job_id = :id AND claimed_by = :worker"
        ),
        {"queued": QUEUED, "id": job_id, "worker": params["worker"]},
    )
    conn.commit()
    logger.info("Ingest lane %s was at its cap of %d; job %s goes back to the queue", lane, params["cap"], job_id)
    return True


def _claim_sqlite(conn, params: dict):
    """The same order as ``_PG_CLAIM``, ranked in Python. Single process only."""
    now = datetime.now(UTC).replace(tzinfo=None)
    threshold = (now - timedelta(seconds=params["stale"])).strftime("%Y-%m-%d %H:%M:%S")
    running = dict(
        conn.execute(
            # Only module constants are interpolated; values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(f"SELECT lane, COUNT(*) FROM {TABLE} WHERE status = :claimed AND heartbeat_at >= :t GROUP BY lane"),
            {"claimed": CLAIMED, "t": threshold},
        ).all()
    )
    turns = dict(conn.execute(text("SELECT lane, last_claimed_at FROM ingest_lane_turns")).all())
    rows = conn.execute(
        # Only module constants are interpolated; values are bound.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"SELECT job_id, lane, payload, attempts, created_at FROM {TABLE} "
            "WHERE status = :queued OR (status = :claimed AND attempts < :max_attempts AND heartbeat_at < :t) "
            f"ORDER BY created_at LIMIT {_SQLITE_CANDIDATES}"
        ),
        {**params, "t": threshold},
    ).all()
    cap = params["cap"]
    eligible = [r for r in rows if not cap or running.get(r[1], 0) < cap]
    if not eligible:
        return None
    best = min(eligible, key=lambda r: (running.get(r[1], 0), turns.get(r[1]) is not None, turns.get(r[1]) or "", r[4]))
    stamp = now.strftime("%Y-%m-%d %H:%M:%S.%f")
    conn.execute(
        # Only module constants are interpolated; values are bound.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(
            f"UPDATE {TABLE} SET status = :claimed, claimed_by = :worker, claimed_at = :now, "
            "heartbeat_at = :now, attempts = attempts + 1 WHERE job_id = :id"
        ),
        {"claimed": CLAIMED, "worker": params["worker"], "now": stamp, "id": best[0]},
    )
    conn.execute(
        text(
            "INSERT INTO ingest_lane_turns (lane, last_claimed_at) VALUES (:lane, :now) "
            "ON CONFLICT (lane) DO UPDATE SET last_claimed_at = excluded.last_claimed_at"
        ),
        {"lane": best[1], "now": stamp},
    )
    return (best[0], best[1], best[2], best[3] + 1, stamp)


def heartbeat(job_id: str, worker: str) -> bool:
    """Refresh a claim; False when it is not this worker's any more."""
    url = db_url()
    if not url:
        return False
    now = "NOW()" if _is_postgres(url) else "CURRENT_TIMESTAMP"
    with _engine(url).connect() as conn:
        result = conn.execute(
            # `now` is a dialect literal, the rest module constants; values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"UPDATE {TABLE} SET heartbeat_at = {now} "
                "WHERE job_id = :id AND claimed_by = :worker AND status = :claimed"
            ),
            {"id": job_id, "worker": worker, "claimed": CLAIMED},
        )
        conn.commit()
    return (result.rowcount or 0) > 0


def mark_done(job_id: str, worker: str | None = None) -> None:
    """Forget a finished job; with ``worker``, only while the claim is still its own."""
    url = db_url()
    if not url:
        return
    sql = f"DELETE FROM {TABLE} WHERE job_id = :id"
    params: dict = {"id": job_id}
    if worker is not None:
        sql += " AND claimed_by = :worker"
        params["worker"] = worker
    with _engine(url).connect() as conn:
        # Only module constants are interpolated; values are bound.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        conn.execute(text(sql), params)
        conn.commit()


def reap_exhausted(*, stale_seconds: int, max_attempts: int) -> list[str]:
    """Drop claims that died ``max_attempts`` times; their ids. One replica per cycle on Postgres.

    Their status rows are then no longer held by the queue, so the status store
    settles them ``failed: interrupted`` like any job whose owner is gone.
    """
    url = db_url()
    if not url:
        return []
    ensure_table(url)
    postgres = _is_postgres(url)
    if postgres:
        stale = "heartbeat_at < NOW() - make_interval(secs => :stale)"
        params: dict = {"stale": stale_seconds}
    else:
        stale = "heartbeat_at < :threshold"
        threshold = datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=stale_seconds)
        params = {"threshold": threshold.strftime("%Y-%m-%d %H:%M:%S")}
    params.update({"claimed": CLAIMED, "max_attempts": max_attempts})
    with _engine(url).connect() as conn:
        if (
            postgres
            and not conn.execute(text("SELECT pg_try_advisory_xact_lock(:id)"), {"id": _PG_REAP_LOCK_ID}).scalar()
        ):
            conn.commit()
            return []
        ids = (
            conn.execute(
                # `stale` is a dialect-chosen literal; values are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT job_id FROM {TABLE} WHERE status = :claimed AND attempts >= :max_attempts AND {stale}"),
                params,
            )
            .scalars()
            .all()
        )
        for job_id in ids:
            # Only module constants are interpolated; the id is bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            conn.execute(text(f"DELETE FROM {TABLE} WHERE job_id = :id"), {"id": job_id})
        conn.commit()
    if ids:
        logger.error("Dropped %d ingest job(s) that failed %d claims each", len(ids), max_attempts)
    return list(ids)


def depth() -> int:
    """Jobs waiting for a worker: what the ingest-worker tier scales on."""
    url = db_url()
    if not url:
        return 0
    ensure_table(url)
    with _engine(url).connect() as conn:
        # Only module constants are interpolated; the status is bound.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        return int(conn.execute(text(f"SELECT COUNT(*) FROM {TABLE} WHERE status = :q"), {"q": QUEUED}).scalar() or 0)


def ahead_in_lane(job_ids: list[str]) -> dict[str, int]:
    """For each job still waiting, how many of its own lane's jobs wait ahead of it.

    The lane's own count is the only order the queue promises: inside a lane
    jobs are claimed oldest first, across lanes the claim interleaves by the
    fewest running. So "3 ahead" is exact for an office's own uploads, and no
    other office's backlog is in it, because none stands between. A job not in
    the queue, or already claimed, has no entry.
    """
    url = db_url()
    if not url or not job_ids:
        return {}
    ensure_table(url)
    # Only module constants are interpolated; the ids and the status are bound.
    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    query = text(
        f"SELECT q.job_id, (SELECT COUNT(*) FROM {TABLE} o"
        "   WHERE o.status = :q AND o.lane = q.lane"
        "     AND (o.created_at < q.created_at"
        "          OR (o.created_at = q.created_at AND o.job_id < q.job_id))) AS ahead"
        f" FROM {TABLE} q WHERE q.status = :q AND q.job_id IN :ids"
    ).bindparams(bindparam("ids", expanding=True))
    with _engine(url).connect() as conn:
        rows = conn.execute(query, {"q": QUEUED, "ids": list(job_ids)}).all()
    return {str(job_id): int(ahead) for job_id, ahead in rows}
