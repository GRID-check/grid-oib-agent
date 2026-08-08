"""Database URL utilities shared across the AI-Q blueprint."""

from __future__ import annotations

import re

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
