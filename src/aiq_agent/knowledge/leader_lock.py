"""Postgres session advisory locks for work that must not run twice at once.

Every session-scoped advisory lock in the backend is taken here, on one engine
built from ``AIQ_LOCK_DB_URL`` and nowhere else (ADR-0083). A session lock lives
as long as the server connection that took it. Behind a transaction pooler
that connection is not the client's: the lock is acquired on whichever server
connection PgBouncer hands over, "released" on another, and the first stays
locked until the pooler recycles it. Nothing raises, and the work the lock
guarded simply stops running. ``AIQ_LOCK_DB_URL`` is therefore the direct
(non-pooled) DSN, and the engine behind it never pools either, so closing a
lock's connection ends its session.

Transaction-scoped locks (``pg_advisory_xact_lock``) and ``FOR UPDATE SKIP
LOCKED`` are fine through the pooler and stay on the caller's own connection.

Three shapes:

- :func:`leader_lock` lets a background loop that runs in every replica (e.g.
  the collection TTL cleanup) elect a single runner per cycle, so N replicas
  don't redundantly race the same work against the now-shared vector store.
  Fail-open: with no Postgres (single-node dev, the tests) it always grants
  leadership, and any error grants it too — the guarded work is idempotent, so
  running it is never wrong, only potentially redundant.
- :func:`leader_lock_async` is the same election for a caller on an event loop
  (the ghost-job reaper): the blocking connect and query run on a thread.
- :func:`keyed_lock` WAITS for one string key, in this process and, on
  Postgres, across every replica. The ingestor holds one per (collection,
  document name) while it replaces a document's previous version, so two jobs
  for the same name cannot both retire the same predecessor and keep both new
  versions.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import threading

logger = logging.getLogger(__name__)

#: The direct Postgres DSN every session lock is taken on.
LOCK_DB_ENV = "AIQ_LOCK_DB_URL"

# Databases a process may be configured with. A process that has one of these on
# Postgres and no lock DSN is misconfigured, not single-node: see `_lock_url`.
_DATABASE_ENVS = ("AIQ_SUMMARY_DB", "NAT_JOB_STORE_DB_URL")


def _lock_url() -> str | None:
    """The DSN session locks run on, or None when there is no Postgres to lock on.

    Raises when the process is configured with a Postgres database and no lock
    DSN. Quietly running unguarded there would be the fallback this module exists
    to rule out: two replicas electing themselves leader, two ingest jobs
    replacing the same document, and nothing in a log to say why.
    """
    url = os.environ.get(LOCK_DB_ENV)
    if url:
        return url if url.startswith("postgres") else None
    if any((os.environ.get(name) or "").startswith("postgres") for name in _DATABASE_ENVS):
        raise RuntimeError(
            f"{LOCK_DB_ENV} is not set, but this process uses Postgres. Session advisory locks need a direct "
            "(non-pooled) connection: set it to the primary's DSN, not the pooler's."
        )
    return None


# One engine per URL for the life of the process; the URLs are fixed by the environment.
_lock_engines: dict[str, object] = {}
_LOCK_ENGINES_GUARD = threading.Lock()


def _lock_engine(url: str):
    """An engine that never pools: closing a lock's connection ends its session.

    Kept apart from every other engine, because a lock is held for as long as the
    work it guards takes, and every holder would otherwise pin one of the
    connections the same work needs for its own writes.
    """
    with _LOCK_ENGINES_GUARD:
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


def _close(conn) -> None:
    """End the lock's session. On a never-pooled engine that releases whatever it held."""
    if conn is None:
        return
    with contextlib.suppress(Exception):
        conn.close()


def _release(conn, unlock_sql: str, params: dict) -> None:
    """Unlock, then end the session; the close releases the lock even when the unlock fails."""
    from sqlalchemy import text

    try:
        conn.execute(text(unlock_sql), params)
    except Exception:
        logger.warning("advisory unlock failed; ending the session releases the lock", exc_info=True)
    _close(conn)


def _try_leader(url: str, lock_id: int):
    """``(granted, connection)``: the connection holding the lock when it was won, else None.

    Fail-open: an error is ``(True, None)``, logged. The guarded work is idempotent.
    """
    from sqlalchemy import text

    conn = None
    try:
        conn = _lock_engine(url).connect()
        won = bool(conn.execute(text("SELECT pg_try_advisory_lock(:id)"), {"id": lock_id}).scalar())
    except Exception:
        logger.warning("leader_lock(%s) acquisition failed; running unguarded", lock_id, exc_info=True)
        _close(conn)
        return True, None
    if not won:
        _close(conn)
        return False, None
    return True, conn


@contextlib.contextmanager
def leader_lock(lock_id: int):
    """Context manager yielding True if this process should run the work.

    Yields False only when another replica currently holds the Postgres advisory
    lock. Releases on exit. Never raises on a database fault; a process that has
    Postgres but no ``AIQ_LOCK_DB_URL`` is a configuration error and does raise.
    """
    url = _lock_url()
    if url is None:
        yield True
        return

    # Acquire before the `yield`, with the fail-open handling inside the helper,
    # so the body is never inside a try that also catches: a @contextmanager must
    # yield exactly once.
    granted, conn = _try_leader(url, lock_id)
    try:
        yield granted
    finally:
        if conn is not None:
            _release(conn, "SELECT pg_advisory_unlock(:id)", {"id": lock_id})


@contextlib.asynccontextmanager
async def leader_lock_async(lock_id: int):
    """:func:`leader_lock` for an event loop: connect, lock and unlock run on a thread."""
    election = leader_lock(lock_id)
    granted = await asyncio.to_thread(election.__enter__)
    try:
        yield granted
    finally:
        await asyncio.to_thread(election.__exit__, None, None, None)


# The namespace half of the two-int advisory key ("AIQR", re-ingest), so a
# keyed lock never collides with a leader_lock id or another feature's locks.
_KEYED_LOCK_NAMESPACE = 0x41495152

# One per key, for the life of the process: bounded by the document names this
# process has ingested, the same bound as oib_sync's per-basename locks.
_PROCESS_LOCKS: dict[str, threading.Lock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()


def _process_lock(key: str) -> threading.Lock:
    with _PROCESS_LOCKS_GUARD:
        return _PROCESS_LOCKS.setdefault(key, threading.Lock())


def _acquire_keyed(key: str):
    """The connection holding ``key``'s advisory lock, or None (no Postgres, or it failed)."""
    url = _lock_url()
    if url is None:
        return None
    from sqlalchemy import text

    conn = None
    try:
        conn = _lock_engine(url).connect()
        conn.execute(
            text("SELECT pg_advisory_lock(:namespace, hashtext(:key))"),
            {"namespace": _KEYED_LOCK_NAMESPACE, "key": key},
        )
    except Exception:
        logger.warning("keyed_lock acquisition failed; running unguarded across replicas", exc_info=True)
        _close(conn)
        return None
    return conn


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
        conn = _acquire_keyed(key)
        try:
            yield
        finally:
            if conn is not None:
                _release(
                    conn,
                    "SELECT pg_advisory_unlock(:namespace, hashtext(:key))",
                    {"namespace": _KEYED_LOCK_NAMESPACE, "key": key},
                )
