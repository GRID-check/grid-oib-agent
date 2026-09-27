"""Postgres session advisory locks for work that must not run twice at once.

Two shapes:

- :func:`leader_lock` lets a background loop that runs in every replica (e.g.
  the collection TTL cleanup) elect a single runner per cycle, so N replicas
  don't redundantly race the same work against the now-shared vector store.
  Fail-open: with no DB / non-Postgres (single-node dev) it always grants
  leadership, and any error grants it too — the guarded work is idempotent, so
  running it is never wrong, only potentially redundant.
- :func:`keyed_lock` WAITS for one string key, in this process and, on
  Postgres, across every replica. The ingestor holds one per (collection,
  document name) while it replaces a document's previous version, so two jobs
  for the same name cannot both retire the same predecessor and keep both new
  versions.
"""

from __future__ import annotations

import contextlib
import logging
import os
import threading

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

        from .document_metadata_store import DocumentMetadataStore

        conn = DocumentMetadataStore._get_or_create_sync_engine(url).connect()
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


# The namespace half of the two-int advisory key ("AIQR", re-ingest), so a
# keyed lock never collides with a leader_lock id or another feature's locks.
_KEYED_LOCK_NAMESPACE = 0x41495152

# One per key, for the life of the process: bounded by the document names this
# process has ingested, the same bound as oib_sync's per-basename locks.
_PROCESS_LOCKS: dict[str, threading.Lock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()
_lock_engines: dict[str, object] = {}


def _process_lock(key: str) -> threading.Lock:
    with _PROCESS_LOCKS_GUARD:
        return _PROCESS_LOCKS.setdefault(key, threading.Lock())


def _lock_engine(url: str):
    """An engine that never pools: closing a lock's connection ends its session.

    Kept apart from the metadata store's pool, because a lock is held for as
    long as a file takes to ingest, and every holder would otherwise pin one of
    the connections the same ingest needs to write its metadata row.
    """
    with _PROCESS_LOCKS_GUARD:
        engine = _lock_engines.get(url)
        if engine is None:
            from sqlalchemy import create_engine
            from sqlalchemy.pool import NullPool

            from aiq_agent.common.db_utils import normalize_db_url

            engine = create_engine(
                normalize_db_url(url, async_mode=False), poolclass=NullPool, isolation_level="AUTOCOMMIT"
            )
            _lock_engines[url] = engine
        return engine


def _acquire_advisory(key: str):
    """The connection holding ``key``'s advisory lock, or None (no Postgres, or it failed)."""
    url = _db_url()
    if not url or not url.startswith("postgres"):
        return None
    conn = None
    try:
        from sqlalchemy import text

        conn = _lock_engine(url).connect()
        conn.execute(
            text("SELECT pg_advisory_lock(:namespace, hashtext(:key))"),
            {"namespace": _KEYED_LOCK_NAMESPACE, "key": key},
        )
        return conn
    except Exception:
        logger.warning("keyed_lock acquisition failed; running unguarded across replicas", exc_info=True)
        if conn is not None:
            with contextlib.suppress(Exception):
                conn.close()
        return None


@contextlib.contextmanager
def keyed_lock(key: str):
    """Hold ``key`` for the body: other threads here, and other replicas on Postgres, wait.

    Blocking, not a try-lock: the caller has work that must happen, only not at
    the same time as another holder's. The key is hashed to the advisory lock's
    32-bit half, so two different keys can share a lock and serialise needlessly,
    never the reverse. A replica that dies ends its session, and Postgres
    releases what it held.

    Fail-open like :func:`leader_lock`: with no Postgres (single-node dev, the
    tests) only the process lock holds, and an unreachable database lets the
    body run unguarded across replicas, logged, rather than fail an upload.
    """
    with _process_lock(key):
        conn = _acquire_advisory(key)
        try:
            yield
        finally:
            if conn is not None:
                # NullPool: close() ends the session, which releases the lock
                # even when the explicit unlock fails.
                with contextlib.suppress(Exception):
                    from sqlalchemy import text

                    conn.execute(
                        text("SELECT pg_advisory_unlock(:namespace, hashtext(:key))"),
                        {"namespace": _KEYED_LOCK_NAMESPACE, "key": key},
                    )
                with contextlib.suppress(Exception):
                    conn.close()
