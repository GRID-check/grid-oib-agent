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


def test_unparseable_returns_sentinel():
    out = redact_db_url("this is not a url at all")
    assert out == "<unparseable-db-url>"


def test_export_matches_module():
    assert redact_db_url is redact_db_url_direct
