"""Tests for database URL redaction utilities."""

from __future__ import annotations

from aiq_agent.common import redact_db_url
from aiq_agent.common.db_utils import redact_db_url as redact_db_url_direct


def test_postgres_password_redacted_but_metadata_retained():
    url = "postgresql://myuser:supersecret@db.example.com:5432/mydatabase"
    out = redact_db_url(url)
    assert "supersecret" not in out
    assert "myuser" in out
    assert "db.example.com" in out
    assert "5432" in out
    assert "mydatabase" in out


def test_postgres_async_driver_password_redacted():
    url = "postgresql+psycopg://admin:hunter2@localhost/jobs"
    out = redact_db_url(url)
    assert "hunter2" not in out
    assert "admin" in out
    assert "jobs" in out


def test_sqlite_path_no_crash():
    out = redact_db_url("sqlite:///./jobs.db")
    assert out == "sqlite:///./jobs.db"


def test_bare_path_passes_through_unchanged():
    # No credentials to scrub and unparseable as a SQLAlchemy URL → returned as-is.
    out = redact_db_url("summaries.db")
    assert out == "summaries.db"


def test_garbled_url_with_credentials_scrubs_password():
    # A DSN SQLAlchemy cannot parse (spaces in the scheme) still gets its
    # user:pass@ segment scrubbed by the regex fallback.
    out = redact_db_url("a b c://myuser:supersecret@host/db")
    assert "supersecret" not in out
    assert "://***@" in out


def test_export_matches_module():
    assert redact_db_url is redact_db_url_direct
