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
