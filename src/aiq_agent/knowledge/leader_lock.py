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
  Fail-closed: when the election cannot be held (the lock database is
  unreachable, the query fails) nobody leads, the fault is logged at WARNING and
  the cycle is skipped. Every caller runs on a schedule, so the next tick tries
  again, where running unelected would be every replica running the cycle at
  once. With no Postgres at all (single-node dev, the tests) there is nobody to
  elect against and the process always leads; that is a configuration, not a
  fallback.
- :func:`leader_lock_async` is the same election for a caller on an event loop
  (the ghost-job reaper): the blocking connect and query run on a thread.
- :func:`keyed_lock` WAITS for one string key, in this process and, on
  Postgres, across every replica. The ingestor holds one per (collection,
  document name) while it replaces a document's previous version, so two jobs
  for the same name cannot both retire the same predecessor and keep both new
  versions. Also fail-closed: when the lock cannot be taken it RAISES, the
  ingest attempt fails and the claim queue retries it, rather than replacing a
  document unguarded across replicas.

:func:`require_direct_dsns` is the start-up check: a process that is configured
with Postgres refuses to boot without the direct DSNs it uses, so a missing one
is one failed boot and not a failure on every request.
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
#: The direct Postgres DSN the job SSE streams LISTEN on.
LISTEN_DB_ENV = "AIQ_LISTEN_DB_URL"

# Databases a process may be configured with. A process that has one of these on
# Postgres and no lock DSN is misconfigured, not single-node: see `require_direct_dsns`.
_DATABASE_ENVS = ("AIQ_SUMMARY_DB", "NAT_JOB_STORE_DB_URL")


def _postgres_configured() -> bool:
    return any((os.environ.get(name) or "").startswith("postgres") for name in _DATABASE_ENVS)


def require_direct_dsns(*, listen: bool) -> None:
    """Refuse to start a Postgres process that lacks the direct DSNs it uses.

    Call once at process start. ``listen`` is True for the process that serves the
    job SSE streams (the web tier) and False for the ones that only take locks
    (the research and ingest workers). With no Postgres database configured
    (single-node dev, the tests) there is nothing to check.

    Each DSN must be set and be a PostgreSQL URL. Without this a missing one
    surfaces late and per use: every SSE stream failing over to polling, or the
    first lock of the process raising, each looking like an ordinary runtime
    error and not like a deployment that was never given its direct DSN.
    """
    if not _postgres_configured():
        return
    needed = [LOCK_DB_ENV, *([LISTEN_DB_ENV] if listen else [])]
    problems = []
    for name in needed:
        value = os.environ.get(name)
        if not value:
            problems.append(f"{name} is not set")
        elif not value.startswith("postgres"):
            problems.append(f"{name} is not a PostgreSQL URL")
    if problems:
        raise RuntimeError(
            f"{'; '.join(problems)}, but this process uses Postgres. LISTEN/NOTIFY and session advisory locks need a "
            "direct (non-pooled) connection: set each to the primary's DSN, not the pooler's (ADR-0083)."
        )


def _lock_url() -> str | None:
    """The DSN session locks run on, or None when there is no Postgres to lock on.

    Raises when the process is configured with a Postgres database and no lock
    DSN (`require_direct_dsns` catches that at start; this is the same rule at the
    point of use). Quietly running unguarded there would be the fallback this
    module exists to rule out: two replicas electing themselves leader, two ingest
    jobs replacing the same document, and nothing in a log to say why.
    """
    url = os.environ.get(LOCK_DB_ENV)
    if url:
        return url if url.startswith("postgres") else None
    if _postgres_configured():
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

    Fail-closed: an error is ``(False, None)``, logged. The caller's schedule retries.
    """
    from sqlalchemy import text

    conn = None
    try:
        conn = _lock_engine(url).connect()
        won = bool(conn.execute(text("SELECT pg_try_advisory_lock(:id)"), {"id": lock_id}).scalar())
    except Exception:
        logger.warning("leader_lock(%s) acquisition failed; skipping this cycle", lock_id, exc_info=True)
        _close(conn)
        return False, None
    if not won:
        _close(conn)
        return False, None
    return True, conn


@contextlib.contextmanager
def leader_lock(lock_id: int):
    """Context manager yielding True if this process should run the work.

    Yields False when another replica holds the Postgres advisory lock, and also
    when the lock cannot be taken at all (logged at WARNING): nobody leads that
    cycle and the next tick tries again. Releases on exit. Never raises on a
    database fault; a process that has Postgres but no ``AIQ_LOCK_DB_URL`` is a
    configuration error and does raise.
    """
    url = _lock_url()
    if url is None:
        yield True
        return

    # Acquire before the `yield`, with the failure handling inside the helper,
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
# process has ingested, the same bound as oib_sync's per-file locks.
_PROCESS_LOCKS: dict[str, threading.Lock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()


def _process_lock(key: str) -> threading.Lock:
    with _PROCESS_LOCKS_GUARD:
        return _PROCESS_LOCKS.setdefault(key, threading.Lock())


def _acquire_keyed(key: str):
    """The connection holding ``key``'s advisory lock, or None when there is no Postgres to lock on.

    Raises when the lock cannot be taken: the caller must not proceed unguarded.
    """
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
        logger.warning("keyed_lock acquisition failed; not running unguarded across replicas", exc_info=True)
        _close(conn)
        raise
    return conn


@contextlib.contextmanager
def keyed_lock(key: str):
    """Hold ``key`` for the body: other threads here, and other replicas on Postgres, wait.

    Blocking, not a try-lock: the caller has work that must happen, only not at
    the same time as another holder's. The key is hashed to the advisory lock's
    32-bit half, so two different keys can share a lock and serialise needlessly,
    never the reverse. A replica that dies ends its session, and Postgres
    releases what it held.

    Fail-closed: with no Postgres (single-node dev, the tests) only the process
    lock holds, but with Postgres an unreachable lock database raises, logged, and
    the body does not run. The caller's attempt fails and is retried, which is
    cheaper than two replicas replacing the same document at once.
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
