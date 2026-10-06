"""One durable, fair claim queue, generic over its table (ADR-0078).

Background work that must outlive the process that accepted it is a row here:
claimed by whichever worker is free, on any replica or in a dedicated worker
tier, with ``FOR UPDATE SKIP LOCKED`` so no two claim it, and a heartbeat so a
crashed worker's job is claimed again. ``aiq_agent.knowledge.ingest_queue`` is
the first queue on it (ADR-0076); ``aiq_api.jobs.queue``, the research queue,
is the second. Each queue keeps its own table, payload and verdict; this module
owns the algorithm.

THE CLAIM IS FAIR, ACROSS THE WHOLE FLEET. A free worker takes the next job of
the LANE (an organisation, or a platform lane) with the fewest jobs running
anywhere; among equals, the lane served longest ago (the turns table); then the
job's priority (``interactive`` before ``bulk``); then the oldest. So one
organisation's thousand-document reindex takes every worker while it is alone,
and the next organisation's upload takes the next worker that frees up,
whatever the backlog ahead of it. PRIORITY decides inside a lane: an office's
single upload goes before its own reindex, and never before another office.

The optional per-lane cap is hard: two claims racing past it both commit, then
each checks again under a per-lane advisory lock, and a claim that finds the
lane already holding its cap puts its job back (``_release_over_cap``).

A claim that cannot finish is given back, not lost:

* ``release_claims`` requeues a worker's jobs WITHOUT consuming an attempt, for
  a drain that ran out of time.
* A claim whose heartbeat went stale is claimed again, up to ``max_attempts``
  times; ``reap_exhausted`` then moves it to ``status='dead'`` with a reason.
  A dead row is kept (the trace of what failed), counted, and never counted as
  work: it is not runnable, not running, and not in the autoscaler's depth.

Postgres ranks LANES in SQL (~43 ms p50 at 100 000 queued jobs across 2 000
lanes, ADR-0076); SQLite, which backs single-process dev and tests, ranks the
same order in Python.

Measured through the OpenTelemetry API only (``grid.queue.*``). The
``MeterProvider`` is wired in ``aiq_agent.observability.metrics``; without one
every instrument is a no-op.
"""

from __future__ import annotations

import logging
import threading
import time
import weakref
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime
from datetime import timedelta
from typing import Any

from opentelemetry import metrics
from opentelemetry.metrics import CallbackOptions
from opentelemetry.metrics import Observation
from sqlalchemy import bindparam
from sqlalchemy import inspect
from sqlalchemy import text

logger = logging.getLogger(__name__)

QUEUED = "queued"
CLAIMED = "claimed"
DEAD = "dead"

#: The statuses a row can have, for the depth gauge's zero fill.
STATUSES = (QUEUED, CLAIMED, DEAD)

#: Lower runs first. Stored as an integer so the order is an index order.
PRIORITY_INTERACTIVE = 0
PRIORITY_BULK = 1
PRIORITIES = {"interactive": PRIORITY_INTERACTIVE, "bulk": PRIORITY_BULK}
DEFAULT_PRIORITY = "interactive"

#: The lane of a row that names none: written before its table had lanes.
NO_LANE = ""

#: Why a row went dead, as stored in ``dead_reason``.
REASON_ATTEMPTS_EXHAUSTED = "attempts_exhausted"

#: Lanes ranked per claim. More than one, so a claim still succeeds while
#: racing claimers hold the top lane's next job; each costs one row lock
#: for the length of the claim.
_PG_LANES_PER_CLAIM = 4

_SQLITE_TIME = "%Y-%m-%d %H:%M:%S"


def priority_rank(name: str | None) -> int:
    """The stored rank of a priority name; ``interactive`` when none is named.

    Raises ``ValueError`` for a name that is not a priority: an unknown value
    must be refused where it enters, not silently ranked somewhere.
    """
    if name is None:
        return PRIORITY_INTERACTIVE
    try:
        return PRIORITIES[name]
    except KeyError:
        raise ValueError(f"unknown priority {name!r}; use one of {sorted(PRIORITIES)}") from None


@dataclass(frozen=True)
class Claim:
    job_id: str
    lane: str
    payload: str
    attempts: int
    priority: int = PRIORITY_INTERACTIVE


# ---------------------------------------------------------------- telemetry


class _Instruments:
    """The ``grid.queue.*`` instruments and the queues the gauges observe."""

    def __init__(self, meter: metrics.Meter) -> None:
        self._queues: weakref.WeakSet[ClaimQueue] = weakref.WeakSet()
        self.claim_latency = meter.create_histogram(
            "grid.queue.claim_latency_ms", unit="ms", description="Time one claim round trip took"
        )
        self.job_duration = meter.create_histogram(
            "grid.queue.job_duration_seconds", unit="s", description="Time a claimed job took to run"
        )
        self.dead = meter.create_counter("grid.queue.dead_total", description="Jobs moved to dead")
        meter.create_observable_gauge(
            "grid.queue.depth", callbacks=[self._observe_depth], description="Rows in the queue by status"
        )
        meter.create_observable_gauge(
            "grid.queue.oldest_age_seconds",
            callbacks=[self._observe_oldest],
            unit="s",
            description="Age of the oldest queued job",
        )

    def watch(self, queue: ClaimQueue) -> None:
        self._queues.add(queue)

    def _observe_depth(self, _options: CallbackOptions) -> list[Observation]:
        observations: list[Observation] = []
        for queue in list(self._queues):
            counts = queue.counts_or_none()
            if counts is None:
                continue
            for status in STATUSES:
                observations.append(Observation(counts.get(status, 0), {"queue": queue.name, "status": status}))
        return observations

    def _observe_oldest(self, _options: CallbackOptions) -> list[Observation]:
        observations: list[Observation] = []
        for queue in list(self._queues):
            age = queue.oldest_queued_age_or_none()
            if age is not None:
                observations.append(Observation(age, {"queue": queue.name}))
        return observations


_instruments: _Instruments | None = None
_instruments_lock = threading.Lock()


def instruments() -> _Instruments:
    """The process's instruments, created on first use against the global meter provider."""
    global _instruments
    with _instruments_lock:
        if _instruments is None:
            _instruments = _Instruments(metrics.get_meter("aiq_agent.claim_queue"))
        return _instruments


# -------------------------------------------------------------------- queue


class ClaimQueue:
    """The claim algorithm over one table (see the module docstring).

    ``db_url`` says where the table lives right now (None: no database, every
    call is a no-op). ``engine_for`` turns the URL into a SQLAlchemy engine.
    ``reap_lock_id`` serialises the reaper across replicas on Postgres.
    """

    def __init__(
        self,
        *,
        name: str,
        table: str,
        turns_table: str,
        db_url: Callable[[], str | None],
        engine_for: Callable[[str], Any],
        reap_lock_id: int,
    ) -> None:
        self.name = name
        self.table = table
        self.turns_table = turns_table
        self._db_url = db_url
        self._engine_for = engine_for
        self._reap_lock_id = reap_lock_id
        #: URLs whose table is known to exist and be current (tests clear it).
        self.initialized: set[str] = set()
        self._claim_sql = self._build_pg_claim()

    # ----------------------------------------------------------------- schema

    def ensure_table(self, url: str, conn=None) -> None:
        """Create the queue and its lane-turn table, and bring an older table up to date; idempotent.

        With ``conn`` the DDL runs in the caller's transaction, and the caller
        calls :meth:`mark_ensured` once that has committed: marking the URL
        before then would let another thread query a table it cannot see yet,
        and keep a table whose commit failed marked as present until restart.
        """
        if url in self.initialized:
            return
        if conn is not None:
            self._ensure_on(conn, url)
            return
        with self._engine_for(url).connect() as own:
            self._ensure_on(own, url)
            own.commit()
        self.mark_ensured(url)

    def mark_ensured(self, url: str) -> None:
        """The DDL for ``url`` has committed: later calls skip it."""
        self.initialized.add(url)

    def _ensure_on(self, conn, url: str) -> None:
        postgres = _is_postgres(url)
        ts = "TIMESTAMP WITH TIME ZONE" if postgres else "DATETIME"
        now = "NOW()" if postgres else "CURRENT_TIMESTAMP"
        t = self.table
        if postgres:
            # Replicas start together; concurrent CREATE INDEX IF NOT EXISTS can still collide.
            conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": f"claim-queue-ddl:{t}"})
        statements = [
            f"CREATE TABLE IF NOT EXISTS {t} ("
            "  job_id VARCHAR PRIMARY KEY,"
            f"  lane VARCHAR NOT NULL DEFAULT '{NO_LANE}',"
            "  payload TEXT NOT NULL,"
            f"  status VARCHAR NOT NULL DEFAULT '{QUEUED}',"
            "  claimed_by VARCHAR,"
            f"  claimed_at {ts},"
            f"  heartbeat_at {ts},"
            "  attempts INTEGER NOT NULL DEFAULT 0,"
            f"  priority INTEGER NOT NULL DEFAULT {PRIORITY_INTERACTIVE},"
            f"  dead_at {ts},"
            "  dead_reason TEXT,"
            f"  created_at {ts} DEFAULT {now}"
            ")",
            f"CREATE TABLE IF NOT EXISTS {self.turns_table} (lane VARCHAR PRIMARY KEY, last_claimed_at {ts})",
        ]
        for statement in statements:
            _execute_constant(conn, statement)
        self._add_missing_columns(conn, ts)
        for statement in (
            f"CREATE INDEX IF NOT EXISTS ix_{t}_status_created ON {t} (status, created_at)",
            f"CREATE INDEX IF NOT EXISTS ix_{t}_status_lane_created ON {t} (status, lane, created_at)",
            f"CREATE INDEX IF NOT EXISTS ix_{t}_lane_priority_created ON {t} (lane, priority, created_at)",
            # Superseded by the priority index above; a second index is write cost for no read.
            f"DROP INDEX IF EXISTS ix_{t}_lane_created",
        ):
            _execute_constant(conn, statement)

    def _add_missing_columns(self, conn, ts: str) -> None:
        """Additive upgrade of a table created before lanes, priority and dead rows existed.

        A row that predates its lane is in ``NO_LANE``, one lane of its own that
        drains like any other; the default also keeps a replica still on the old
        code, which inserts no lane, able to enqueue during a rolling deploy.
        """
        wanted = {
            "lane": f"VARCHAR NOT NULL DEFAULT '{NO_LANE}'",
            "priority": f"INTEGER NOT NULL DEFAULT {PRIORITY_INTERACTIVE}",
            "dead_at": ts,
            "dead_reason": "TEXT",
        }
        present = {column["name"] for column in inspect(conn).get_columns(self.table)}
        guard = "IF NOT EXISTS " if "WITH TIME ZONE" in ts else ""
        for column, definition in wanted.items():
            if column not in present:
                _execute_constant(conn, f"ALTER TABLE {self.table} ADD COLUMN {guard}{column} {definition}")

    # ----------------------------------------------------------------- intake

    def enqueue(self, job_id: str, lane: str, payload: str, priority: str | None = None) -> None:
        """Store a claimable job. Raises: the caller runs the job locally when this fails."""
        url = self._db_url()
        if not url:
            raise RuntimeError(f"no database for the {self.name} queue")
        rank = priority_rank(priority)
        self.ensure_table(url)
        with self._engine_for(url).connect() as conn:
            conn.execute(
                # Only module constants are interpolated; every value is bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"INSERT INTO {self.table} (job_id, lane, payload, status, attempts, priority) "
                    "VALUES (:id, :lane, :payload, :q, 0, :priority)"
                ),
                {"id": job_id, "lane": lane, "payload": payload, "q": QUEUED, "priority": rank},
            )
            conn.commit()

    # ------------------------------------------------------------------ claim

    def _runnable(self) -> str:
        return (
            "(q.status = :queued OR (q.status = :claimed AND q.attempts < :max_attempts "
            "AND q.heartbeat_at < NOW() - make_interval(secs => :stale)))"
        )

    def _build_pg_claim(self) -> str:
        """Two steps, so a claim never sorts the whole backlog.

        Rank the LANES (one row per lane with work), then take the best job of
        the best few lanes through the (lane, priority, created_at) index.
        100 000 queued jobs across 2 000 lanes: ~165 ms per claim as one sort
        over every job, ~43 ms ranked this way (ADR-0076).
        """
        t, turns, runnable = self.table, self.turns_table, self._runnable()
        return f"""
WITH running AS (
    SELECT lane, COUNT(*) AS n FROM {t}
    WHERE status = :claimed AND heartbeat_at >= NOW() - make_interval(secs => :stale)
    GROUP BY lane
),
lanes AS (
    SELECT w.lane, COALESCE(r.n, 0) AS n, t.last_claimed_at, w.oldest
    FROM (SELECT q.lane, MIN(q.created_at) AS oldest FROM {t} q WHERE {runnable} GROUP BY q.lane) w
    LEFT JOIN running r ON r.lane = w.lane
    LEFT JOIN {turns} t ON t.lane = w.lane
    WHERE (:cap = 0 OR COALESCE(r.n, 0) < :cap)
    ORDER BY COALESCE(r.n, 0), t.last_claimed_at NULLS FIRST, w.oldest
    LIMIT {_PG_LANES_PER_CLAIM}
),
candidate AS (
    SELECT pick.job_id FROM lanes
    CROSS JOIN LATERAL (
        SELECT q.job_id, q.priority, q.created_at FROM {t} q
        WHERE q.lane = lanes.lane AND {runnable}
        ORDER BY q.priority, q.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
    ) pick
    ORDER BY lanes.n, lanes.last_claimed_at NULLS FIRST, pick.priority, pick.created_at
    LIMIT 1
),
claimed AS (
    UPDATE {t} q
    SET status = :claimed, claimed_by = :worker, claimed_at = NOW(), heartbeat_at = NOW(),
        attempts = q.attempts + 1
    FROM candidate WHERE q.job_id = candidate.job_id
    RETURNING q.job_id, q.lane, q.payload, q.attempts, q.priority
),
turn AS (
    INSERT INTO {turns} (lane, last_claimed_at)
    SELECT lane, NOW() FROM claimed
    ON CONFLICT (lane) DO UPDATE SET last_claimed_at = EXCLUDED.last_claimed_at
)
SELECT job_id, lane, payload, attempts, priority FROM claimed
"""

    def claim_next(self, worker: str, *, stale_seconds: int, max_attempts: int, per_lane_cap: int = 0) -> Claim | None:
        """Claim the fairest runnable job (see the module docstring), or None."""
        url = self._db_url()
        if not url:
            return None
        self.ensure_table(url)
        params = {
            "worker": worker,
            "stale": stale_seconds,
            "max_attempts": max_attempts,
            "cap": max(0, per_lane_cap),
            "queued": QUEUED,
            "claimed": CLAIMED,
        }
        started = time.monotonic()
        with self._engine_for(url).connect() as conn:
            if _is_postgres(url):
                # The statement is built from module constants; every value is bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                row = conn.execute(text(self._claim_sql), params).first()
            else:
                row = self._claim_sqlite(conn, params)
            conn.commit()
            instruments().claim_latency.record((time.monotonic() - started) * 1000, {"queue": self.name})
            if row is None:
                return None
            if params["cap"] and self._release_over_cap(conn, url, row, params):
                return None
        return Claim(job_id=row[0], lane=row[1], payload=row[2], attempts=row[3], priority=row[4])

    def _release_over_cap(self, conn, url: str, row, params: dict) -> bool:
        """Put a claim back when its lane already holds ``cap`` other live claims; whether it did.

        The claim query skips a lane at its cap, but two claims committing at once
        each saw the lane one under it. So every claim, once committed, checks again
        under a per-lane advisory lock, counting EVERY other live claim of the lane.
        The checks run one at a time and each claim commits before its own check, so
        the last check of a race sees all the others and the lane ends at most at
        its cap. A claim given back costs no attempt; the next free worker takes it.
        (Ranking by claim time instead let three of a cap of two through: a
        transaction's start time is not its commit order.)
        """
        job_id, lane = row[0], row[1]
        if _is_postgres(url):
            conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:lane))"), {"lane": f"{self.table}-cap:{lane}"})
            fresh = "heartbeat_at >= NOW() - make_interval(secs => :stale)"
        else:
            fresh = "heartbeat_at >= :threshold"
        others = conn.execute(
            # `fresh` is a dialect-chosen literal, the rest module constants; values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"SELECT COUNT(*) FROM {self.table} "
                f"WHERE lane = :lane AND status = :claimed AND {fresh} AND job_id <> :id"
            ),
            {
                "lane": lane,
                "claimed": CLAIMED,
                "stale": params["stale"],
                "threshold": _sqlite_threshold(params["stale"]),
                "id": job_id,
            },
        ).scalar()
        if int(others or 0) < params["cap"]:
            conn.commit()
            return False
        conn.execute(
            # Only module constants are interpolated; values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"UPDATE {self.table} SET status = :queued, claimed_by = NULL, claimed_at = NULL, "
                "heartbeat_at = NULL, attempts = attempts - 1 WHERE job_id = :id AND claimed_by = :worker"
            ),
            {"queued": QUEUED, "id": job_id, "worker": params["worker"]},
        )
        conn.commit()
        logger.info(
            "%s lane %s was at its cap of %d; job %s goes back to the queue", self.name, lane, params["cap"], job_id
        )
        return True

    def _claim_sqlite(self, conn, params: dict):
        """The same order as the Postgres claim, ranked in Python. Single process only."""
        now = datetime.now(UTC).replace(tzinfo=None)
        threshold = _sqlite_threshold(params["stale"])
        t = self.table
        running = dict(
            conn.execute(
                # Only module constants are interpolated; values are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT lane, COUNT(*) FROM {t} WHERE status = :claimed AND heartbeat_at >= :t GROUP BY lane"),
                {"claimed": CLAIMED, "t": threshold},
            ).all()
        )
        turns = dict(
            conn.execute(
                # Only module constants are interpolated.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT lane, last_claimed_at FROM {self.turns_table}")
            ).all()
        )
        rows = conn.execute(
            # Only module constants are interpolated; values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                "SELECT job_id, lane, payload, attempts, priority, created_at FROM ("
                "  SELECT job_id, lane, payload, attempts, priority, created_at, "
                "         ROW_NUMBER() OVER (PARTITION BY lane ORDER BY priority, created_at, job_id) AS rn "
                f"  FROM {t} "
                "  WHERE status = :queued OR (status = :claimed AND attempts < :max_attempts AND heartbeat_at < :t)"
                ") WHERE rn = 1"
            ),
            {**params, "t": threshold},
        ).all()
        cap = params["cap"]
        eligible = [r for r in rows if not cap or running.get(r[1], 0) < cap]
        if not eligible:
            return None
        best = min(
            eligible,
            key=lambda r: (running.get(r[1], 0), turns.get(r[1]) is not None, turns.get(r[1]) or "", r[4], r[5], r[0]),
        )
        stamp = now.strftime("%Y-%m-%d %H:%M:%S.%f")
        conn.execute(
            # Only module constants are interpolated; values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"UPDATE {t} SET status = :claimed, claimed_by = :worker, claimed_at = :now, "
                "heartbeat_at = :now, attempts = attempts + 1 WHERE job_id = :id"
            ),
            {"claimed": CLAIMED, "worker": params["worker"], "now": stamp, "id": best[0]},
        )
        conn.execute(
            # Only module constants are interpolated; values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            text(
                f"INSERT INTO {self.turns_table} (lane, last_claimed_at) VALUES (:lane, :now) "
                "ON CONFLICT (lane) DO UPDATE SET last_claimed_at = excluded.last_claimed_at"
            ),
            {"lane": best[1], "now": stamp},
        )
        return (best[0], best[1], best[2], best[3] + 1, best[4])

    # -------------------------------------------------------------- lifecycle

    def heartbeat(self, job_id: str, worker: str) -> bool:
        """Refresh a claim; False when it is not this worker's any more."""
        url = self._db_url()
        if not url:
            return False
        now = "NOW()" if _is_postgres(url) else "CURRENT_TIMESTAMP"
        with self._engine_for(url).connect() as conn:
            result = conn.execute(
                # `now` is a dialect literal, the rest module constants; values are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {self.table} SET heartbeat_at = {now} "
                    "WHERE job_id = :id AND claimed_by = :worker AND status = :claimed"
                ),
                {"id": job_id, "worker": worker, "claimed": CLAIMED},
            )
            conn.commit()
        return (result.rowcount or 0) > 0

    def mark_done(self, job_id: str, worker: str | None = None) -> None:
        """Forget a finished job; with ``worker``, only while the claim is still its own."""
        url = self._db_url()
        if not url:
            return
        sql = f"DELETE FROM {self.table} WHERE job_id = :id"
        params: dict = {"id": job_id}
        if worker is not None:
            sql += " AND claimed_by = :worker"
            params["worker"] = worker
        with self._engine_for(url).connect() as conn:
            # Only module constants are interpolated; values are bound.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            conn.execute(text(sql), params)
            conn.commit()

    def release_claims(self, job_ids: list[str], worker: str) -> int:
        """Put this worker's claimed jobs back in the queue WITHOUT spending an attempt; how many.

        For a drain that ran out of time: the claim did not fail, the worker
        left, so another worker may take the job at once instead of after the
        stale window, and the job keeps the attempts it has. A job keeps its
        place in line (``created_at`` is untouched). A claim that is no longer
        the worker's own is left alone.
        """
        url = self._db_url()
        if not url or not job_ids:
            return 0
        self.ensure_table(url)
        with self._engine_for(url).connect() as conn:
            result = conn.execute(
                # Only module constants are interpolated; the ids and values are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {self.table} SET status = :queued, claimed_by = NULL, claimed_at = NULL, "
                    "heartbeat_at = NULL, attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END "
                    "WHERE job_id IN :ids AND claimed_by = :worker AND status = :claimed"
                ).bindparams(bindparam("ids", expanding=True)),
                {"queued": QUEUED, "claimed": CLAIMED, "worker": worker, "ids": list(job_ids)},
            )
            conn.commit()
        released = result.rowcount or 0
        if released:
            logger.info("%s: %d claim(s) of %s released without an attempt", self.name, released, worker)
        return released

    def mark_dead(self, job_id: str, reason: str) -> bool:
        """Retire a job that must not run again, keeping the row; whether a live row was retired.

        The payload is blanked: it can carry presigned URLs and a dead row is
        kept for the trace of what failed, not to run.
        """
        url = self._db_url()
        if not url:
            return False
        self.ensure_table(url)
        now = "NOW()" if _is_postgres(url) else "CURRENT_TIMESTAMP"
        with self._engine_for(url).connect() as conn:
            result = conn.execute(
                # `now` is a dialect literal, the rest module constants; values are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(
                    f"UPDATE {self.table} SET status = :dead, dead_at = {now}, dead_reason = :reason, payload = '' "
                    "WHERE job_id = :id AND status <> :dead"
                ),
                {"dead": DEAD, "reason": reason, "id": job_id},
            )
            conn.commit()
        retired = (result.rowcount or 0) > 0
        if retired:
            instruments().dead.add(1, {"queue": self.name})
        return retired

    def reap_exhausted(self, *, stale_seconds: int, max_attempts: int) -> list[str]:
        """Move claims that died ``max_attempts`` times to dead; their ids. One replica per cycle on Postgres."""
        url = self._db_url()
        if not url:
            return []
        self.ensure_table(url)
        postgres = _is_postgres(url)
        stale = "heartbeat_at < NOW() - make_interval(secs => :stale)" if postgres else "heartbeat_at < :threshold"
        now = "NOW()" if postgres else "CURRENT_TIMESTAMP"
        params = {
            "stale": stale_seconds,
            "threshold": _sqlite_threshold(stale_seconds),
            "claimed": CLAIMED,
            "dead": DEAD,
            "reason": REASON_ATTEMPTS_EXHAUSTED,
            "max_attempts": max_attempts,
        }
        with self._engine_for(url).connect() as conn:
            if (
                postgres
                and not conn.execute(text("SELECT pg_try_advisory_xact_lock(:id)"), {"id": self._reap_lock_id}).scalar()
            ):
                conn.commit()
                return []
            ids = list(
                conn.execute(
                    # `stale` and `now` are dialect-chosen literals; values are bound.
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(
                        f"UPDATE {self.table} SET status = :dead, dead_at = {now}, dead_reason = :reason, "
                        "payload = '' "
                        f"WHERE status = :claimed AND attempts >= :max_attempts AND {stale} RETURNING job_id"
                    ),
                    params,
                ).scalars()
            )
            conn.commit()
        if ids:
            instruments().dead.add(len(ids), {"queue": self.name})
            logger.error("%s: %d job(s) failed %d claims each and are dead", self.name, len(ids), max_attempts)
        return ids

    def purge_dead(self, *, older_than_seconds: int) -> int:
        """Delete dead rows older than the retention; how many. A dead row is a trace, not a record."""
        url = self._db_url()
        if not url:
            return 0
        self.ensure_table(url)
        if _is_postgres(url):
            cutoff = "dead_at < NOW() - make_interval(secs => :age)"
            params: dict = {"age": older_than_seconds, "dead": DEAD}
        else:
            cutoff = "dead_at < :threshold"
            params = {"threshold": _sqlite_threshold(older_than_seconds), "dead": DEAD}
        with self._engine_for(url).connect() as conn:
            result = conn.execute(
                # `cutoff` is a dialect-chosen literal; values are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"DELETE FROM {self.table} WHERE status = :dead AND {cutoff}"),
                params,
            )
            conn.commit()
        return result.rowcount or 0

    # ------------------------------------------------------------ inspection

    def counts(self) -> dict[str, int]:
        """Rows by status (a status with none is 0): what the depth gauge and the tests read."""
        url = self._db_url()
        counts = dict.fromkeys(STATUSES, 0)
        if not url:
            return counts
        self.ensure_table(url)
        with self._engine_for(url).connect() as conn:
            # Only module constants are interpolated.
            # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
            rows = conn.execute(text(f"SELECT status, COUNT(*) FROM {self.table} GROUP BY status")).all()
        counts.update({str(status): int(n) for status, n in rows})
        return counts

    def queued_in_lane(self, lane: str) -> int:
        """Jobs of one lane still waiting for a worker: the bound admission checks."""
        url = self._db_url()
        if not url:
            return 0
        self.ensure_table(url)
        with self._engine_for(url).connect() as conn:
            waiting = conn.execute(
                # Only module constants are interpolated; the lane and the status are bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT COUNT(*) FROM {self.table} WHERE lane = :lane AND status = :q"),
                {"lane": lane, "q": QUEUED},
            ).scalar()
        return int(waiting or 0)

    def oldest_queued_age(self) -> float:
        """Seconds the longest-waiting queued job has waited; 0 when nothing waits."""
        url = self._db_url()
        if not url:
            return 0.0
        self.ensure_table(url)
        if _is_postgres(url):
            age = "EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))"
        else:
            age = "(julianday('now') - julianday(MIN(created_at))) * 86400.0"
        with self._engine_for(url).connect() as conn:
            value = conn.execute(
                # `age` is a dialect-chosen literal; the status is bound.
                # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                text(f"SELECT {age} FROM {self.table} WHERE status = :q"),
                {"q": QUEUED},
            ).scalar()
        return max(0.0, float(value or 0))

    def counts_or_none(self) -> dict[str, int] | None:
        """``counts`` for a gauge callback: a database that cannot answer is no observation, not an error."""
        try:
            return self.counts()
        except Exception:  # noqa: BLE001 - a metrics callback must never raise into the SDK
            logger.warning("%s: counting queue rows for the depth gauge failed", self.name, exc_info=True)
            return None

    def oldest_queued_age_or_none(self) -> float | None:
        try:
            return self.oldest_queued_age()
        except Exception:  # noqa: BLE001 - as above
            logger.warning("%s: reading the oldest queued age failed", self.name, exc_info=True)
            return None

    def ahead_in_lane(self, job_ids: list[str]) -> dict[str, int]:
        """For each job still waiting, how many of its own lane's jobs wait ahead of it.

        The lane's own count is the only order the queue promises: inside a lane
        jobs are claimed by priority, then oldest first, and across lanes the claim
        interleaves by the fewest running. So "3 ahead" is exact for an office's own
        uploads, and no other office's backlog is in it, because none stands
        between. A job not in the queue, or already claimed, has no entry.
        """
        url = self._db_url()
        if not url or not job_ids:
            return {}
        self.ensure_table(url)
        t = self.table
        # Only module constants are interpolated; the ids and the status are bound.
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        query = text(
            f"SELECT q.job_id, (SELECT COUNT(*) FROM {t} o"
            "   WHERE o.status = :q AND o.lane = q.lane"
            "     AND (o.priority < q.priority"
            "          OR (o.priority = q.priority AND (o.created_at < q.created_at"
            "              OR (o.created_at = q.created_at AND o.job_id < q.job_id))))) AS ahead"
            f" FROM {t} q WHERE q.status = :q AND q.job_id IN :ids"
        ).bindparams(bindparam("ids", expanding=True))
        with self._engine_for(url).connect() as conn:
            rows = conn.execute(query, {"q": QUEUED, "ids": list(job_ids)}).all()
        return {str(job_id): int(ahead) for job_id, ahead in rows}

    # ---------------------------------------------------------------- metrics

    def observe(self) -> None:
        """Report this queue's depth and oldest age from this process (call where workers claim)."""
        instruments().watch(self)

    def record_duration(self, seconds: float, kind: str) -> None:
        """Record how long a claimed job of ``kind`` ran."""
        instruments().job_duration.record(max(0.0, seconds), {"queue": self.name, "kind": kind})


# ------------------------------------------------------------------ helpers


def _is_postgres(url: str) -> bool:
    return url.startswith("postgres")


def _sqlite_threshold(seconds: int) -> str:
    """The naive-UTC timestamp ``seconds`` ago, as SQLite stores a heartbeat."""
    return (datetime.now(UTC).replace(tzinfo=None) - timedelta(seconds=seconds)).strftime(_SQLITE_TIME)


def _execute_constant(conn, statement: str) -> None:
    """Run DDL built from module constants and dialect literals; nothing here is user input."""
    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
    conn.execute(text(statement))
