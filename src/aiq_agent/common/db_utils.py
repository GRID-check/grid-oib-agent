"""Database URL and schema-creation utilities shared across the AI-Q blueprint."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from typing import Any

# Matches the ``scheme://user[:password]@`` credential segment of a URL/DSN so it
# can be scrubbed from values SQLAlchemy could not parse. Anchored on ``://`` and
# the ``@`` host separator; the userinfo run excludes ``/``, ``@`` and whitespace
# so it stops at the authority boundary and leaves bare paths untouched.
_CREDENTIAL_RE = re.compile(r"://[^/@\s]+@")


def redact_db_url(url: str) -> str:
    """Render a database URL/DSN with any password removed.

    Safe for logging: the returned string preserves the user, host, port and
    database name but never the password. When the value cannot be parsed as a
    SQLAlchemy URL (e.g. malformed input), it still scrubs any embedded
    ``scheme://user:pass@`` credentials with a regex and returns the scrubbed
    string — so a garbled DSN keeps its useful non-secret parts without leaking a
    password, and a bare path passes through unchanged. Always safe to
    interpolate into log lines.
    """
    try:
        from sqlalchemy.engine.url import make_url

        return make_url(url).render_as_string(hide_password=True)
    except Exception:
        return _CREDENTIAL_RE.sub("://***@", url)


def _translate_tls_param(url: str) -> str:
    """Rename asyncpg's ``ssl`` query parameter to libpq's ``sslmode``.

    DSN generators emit the TLS parameter under a driver-specific name
    (``ssl`` for asyncpg, ``sslmode`` for libpq/psycopg), and the query string
    survives a driver rewrite unchanged — psycopg3 then rejects the unknown
    ``ssl`` connection option at connect time. asyncpg additionally accepts
    ``true``/``false`` values, which libpq spells ``require``/``disable``.
    Passwords are percent-encoded inside URLs, so the literal ``?ssl=`` /
    ``&ssl=`` needles can only match in the query string.
    """
    out = url.replace("?ssl=", "?sslmode=").replace("&ssl=", "&sslmode=")
    return out.replace("sslmode=true", "sslmode=require").replace("sslmode=false", "sslmode=disable")


def normalize_db_url(db_url: str, async_mode: bool = True) -> str:
    """Normalize a database URL to consistent drivers.

    PostgreSQL uses psycopg (psycopg3) for both sync and async; any TLS query
    parameter is translated alongside the driver (see :func:`_translate_tls_param`).
    SQLite uses aiosqlite for async, the standard driver for sync. Anything else
    passes through unchanged.
    """
    if db_url.startswith("postgresql") or db_url.startswith("postgres"):
        base_url = db_url.replace("+asyncpg", "").replace("+psycopg2", "").replace("+psycopg", "")
        if not base_url.startswith("postgresql://"):
            base_url = base_url.replace("postgres://", "postgresql://")
        return _translate_tls_param(base_url.replace("postgresql://", "postgresql+psycopg://"))
    if db_url.startswith("sqlite"):
        base_url = db_url.replace("+aiosqlite", "")
        return base_url.replace("sqlite:///", "sqlite+aiosqlite:///") if async_mode else base_url
    return db_url


def schema_lock_key(name: str) -> int:
    """The signed 64-bit advisory-lock key for the schema object called ``name``.

    Derived from a hash, not from ``hash()`` or ``hashtext``, so every process
    and every release computes the same key for the same name.
    """
    digest = hashlib.sha256(f"grid-schema:{name}".encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


def lock_schema(conn, name: str) -> None:
    """Serialise the DDL that follows on ``conn`` against every other creator of ``name``.

    Call it before the first DDL statement of the transaction, on the connection
    that runs the DDL. ``CREATE TABLE IF NOT EXISTS`` is not safe under
    concurrency: two sessions that both find the table missing race on the
    ``pg_type`` catalog and the loser raises ``UniqueViolation`` (or
    ``DuplicateTable``). The lock makes the loser wait for the winner's commit,
    and its ``IF NOT EXISTS`` then sees the table. Replicas and roles start
    together, so this is the normal boot, not a corner case.

    The lock is TRANSACTION-scoped (``pg_advisory_xact_lock``): it is released
    by the commit or rollback of the transaction that took it, so it holds
    through a transaction pooler. A session lock does not (ADR-0083). The
    caller commits, and marks its "ensured" flag only after that.

    SQLite (single process: dev and tests) has no concurrent creator to guard
    against, so there the DDL runs as it is.
    """
    if conn.dialect.name != "postgresql":
        return
    from sqlalchemy import text

    conn.execute(text("SELECT pg_advisory_xact_lock(CAST(:key AS bigint))"), {"key": schema_lock_key(name)})


def ensure_schema(engine, name: str, ddl: Callable[[Any], None]) -> None:
    """Run ``ddl(conn)`` in one transaction that holds the lock for ``name``; commit when it returns.

    An exception from ``ddl`` rolls the transaction back and propagates: only
    the creation race is prevented here, never an error of the DDL itself.
    """
    with engine.begin() as conn:
        lock_schema(conn, name)
        ddl(conn)
