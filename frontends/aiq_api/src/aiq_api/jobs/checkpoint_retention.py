"""Age-based retention for the interactive chat checkpoint store (P0 #1, chat).

LangGraph writes a full-state checkpoint per super-step, keyed by ``thread_id``
(the conversation id), into ``AIQ_CHECKPOINT_DB``. Unlike a deep-research run a
chat conversation has **no terminal event**, so nothing ever drops these rows —
they accumulate with every turn across every conversation forever
(``checkpoints``/``checkpoint_blobs``/``checkpoint_writes``). The deep path is
purged on completion (``worker._purge_deep_checkpoint``); the chat path needs an
**age reaper** instead.

We drop whole threads that have been idle longer than the retention window,
using the checkpoint's own ISO-8601 ``ts`` field (``Checkpoint.ts``) as the
last-activity signal — no schema change. LangGraph resumes only from a thread's
latest checkpoint, so an idle thread that returns after being reaped simply
starts a fresh conversation (the same semantics as the deep-run purge). One
replica does the work per cycle via a Postgres transaction-level advisory lock.
"""

from __future__ import annotations

import logging
from datetime import UTC
from datetime import datetime
from datetime import timedelta

logger = logging.getLogger(__name__)

_CHECKPOINT_TABLES = ("checkpoint_writes", "checkpoint_blobs", "checkpoints")

# Distinct advisory-lock id for the checkpoint reaper (its own DB, so it never
# collides with the jobs-DB locks in routes/jobs.py). "AIQCKPT" in hex.
_PG_CHECKPOINT_LOCK_ID = 0x41495143_4B505400


def _is_postgres(dsn: str) -> bool:
    return dsn.startswith("postgres")


def _cutoff_iso(retention_seconds: int, now: datetime | None = None) -> str:
    """ISO-8601 cutoff; threads whose newest ``ts`` is below this are stale.

    LangGraph stamps ``ts`` as ``datetime.now(UTC).isoformat()`` (UTC, ``+00:00``
    suffix), so a lexical ``<`` comparison against another UTC-isoformat string
    is chronological.
    """
    now = now or datetime.now(UTC)
    return (now - timedelta(seconds=retention_seconds)).isoformat()


def reap_idle_threads(dsn: str | None, retention_seconds: int, now: datetime | None = None) -> int:
    """Delete every checkpoint row for threads idle longer than the window.

    Returns the number of threads reaped. Best-effort and never raises: a
    retention sweep must never take down the request path.
    """
    if not dsn or retention_seconds <= 0:
        return 0
    try:
        from sqlalchemy import bindparam
        from sqlalchemy import inspect
        from sqlalchemy import text

        from .event_store import EventStore

        engine = EventStore._get_or_create_sync_engine(dsn)
        if not inspect(engine).has_table("checkpoints"):
            return 0

        is_pg = _is_postgres(dsn)
        # The last-activity timestamp lives inside the checkpoint payload.
        ts_expr = "checkpoint->>'ts'" if is_pg else "json_extract(checkpoint, '$.ts')"
        cutoff = _cutoff_iso(retention_seconds, now)

        with engine.connect() as conn:
            if is_pg:
                locked = conn.execute(
                    text("SELECT pg_try_advisory_xact_lock(:id)"), {"id": _PG_CHECKPOINT_LOCK_ID}
                ).scalar()
                if not locked:
                    return 0
            stale_ids = list(
                conn.execute(
                    # ts_expr is a dialect-chosen literal; the cutoff is bound.
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"SELECT thread_id FROM checkpoints GROUP BY thread_id HAVING MAX({ts_expr}) < :cutoff"),
                    {"cutoff": cutoff},
                ).scalars()
            )
            if not stale_ids:
                return 0
            for table in _CHECKPOINT_TABLES:
                # Fixed table names (LangGraph schema); thread ids are bound.
                conn.execute(
                    # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
                    text(f"DELETE FROM {table} WHERE thread_id IN :ids").bindparams(  # noqa: S608
                        bindparam("ids", expanding=True)
                    ),
                    {"ids": stale_ids},
                )
            conn.commit()
            logger.info(
                "Chat checkpoint reaper: dropped %d idle thread(s) (idle > %ds)",
                len(stale_ids),
                retention_seconds,
            )
            return len(stale_ids)
    except Exception:
        logger.warning("Chat checkpoint reaper cycle failed", exc_info=True)
        return 0
