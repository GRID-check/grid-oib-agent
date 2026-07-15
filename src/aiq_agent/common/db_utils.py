"""Database URL utilities shared across the AI-Q blueprint."""

from __future__ import annotations


def redact_db_url(url: str) -> str:
    """Render a database URL/DSN with any password removed.

    Safe for logging: the returned string preserves the user, host, port and
    database name but never the password. Falls back to a fixed sentinel when
    the value cannot be parsed as a SQLAlchemy URL (e.g. malformed input), so
    it is always safe to interpolate into log lines.
    """
    try:
        from sqlalchemy.engine.url import make_url

        return make_url(url).render_as_string(hide_password=True)
    except Exception:
        return "<unparseable-db-url>"
