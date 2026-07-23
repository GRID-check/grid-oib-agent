"""Best-effort Postgres session advisory lock for single-runner background work.

Lets a background loop that runs in every replica (e.g. the collection TTL
cleanup) elect a single runner per cycle, so N replicas don't redundantly race
the same work against the now-shared vector store. Fail-open: with no DB /
non-Postgres (single-node dev) it always grants leadership, and any error grants
it too — the guarded work is idempotent, so running it is never wrong, only
potentially redundant.
"""

from __future__ import annotations

import contextlib
import logging
import os

logger = logging.getLogger(__name__)


def _db_url() -> str | None:
    url = os.environ.get("AIQ_SUMMARY_DB") or os.environ.get("NAT_JOB_STORE_DB_URL")
    return url or None


@contextlib.contextmanager
def leader_lock(lock_id: int):
    """Context manager yielding True if this process should run the work.

    Yields False only when another replica currently holds the Postgres advisory
    lock. Releases on exit. Never raises.
    """
    url = _db_url()
    if not url or not url.startswith("postgres"):
        yield True
        return

    # Acquire in its own try (fail-open on any acquisition error) so the `yield`
    # is NEVER inside a try that also yields — a @contextmanager must yield
    # exactly once, and yielding inside `try/except Exception` would double-yield
    # if the guarded body raised (RuntimeError, and the lock would leak).
    conn = None
    acquired = False
    try:
        from sqlalchemy import text

        from .summary_store import SummaryStore

        conn = SummaryStore._get_or_create_sync_engine(url).connect()
        acquired = bool(conn.execute(text("SELECT pg_try_advisory_lock(:id)"), {"id": lock_id}).scalar())
    except Exception:
        logger.warning("leader_lock(%s) acquisition failed; running unguarded", lock_id, exc_info=True)
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()
            conn = None
        yield True  # fail-open: guarded work is idempotent
        return

    if not acquired:
        with contextlib.suppress(Exception):
            conn.close()
        yield False
        return

    try:
        yield True
    finally:
        from sqlalchemy import text

        try:
            conn.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": lock_id})
            conn.close()
        except Exception:
            # Unlock failed → session still holds the lock; a pooled close() would
            # keep it held. invalidate() drops the DBAPI connection so Postgres
            # ends the session and releases the lock.
            logger.warning("leader_lock(%s) unlock failed; invalidating connection", lock_id, exc_info=True)
            with contextlib.suppress(Exception):
                conn.invalidate()
