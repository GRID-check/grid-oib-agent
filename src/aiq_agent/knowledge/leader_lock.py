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

    conn = None
    try:
        from sqlalchemy import text

        from .summary_store import SummaryStore

        conn = SummaryStore._get_or_create_sync_engine(url).connect()
        got = conn.execute(text("SELECT pg_try_advisory_lock(:id)"), {"id": lock_id}).scalar()
        if not got:
            conn.close()
            conn = None
            yield False
            return
        yield True
    except Exception:
        logger.warning("leader_lock(%s) failed; running unguarded", lock_id, exc_info=True)
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()
            conn = None
        yield True
    finally:
        if conn is not None:
            try:
                from sqlalchemy import text

                conn.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": lock_id})
            except Exception:
                logger.warning("leader_lock(%s) unlock failed", lock_id, exc_info=True)
            finally:
                conn.close()
