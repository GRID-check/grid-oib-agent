"""Tests for the database URL and schema-creation utilities."""

from __future__ import annotations

from types import SimpleNamespace
from urllib.parse import urlparse

import pytest
from sqlalchemy import create_engine
from sqlalchemy import inspect
from sqlalchemy import text

from aiq_agent.common import redact_db_url
from aiq_agent.common.db_utils import ensure_schema
from aiq_agent.common.db_utils import lock_schema
from aiq_agent.common.db_utils import redact_db_url as redact_db_url_direct
from aiq_agent.common.db_utils import schema_lock_key


def test_postgres_password_redacted_but_metadata_retained():
    url = "postgresql://myuser:supersecret@db.example.com:5432/mydatabase"
    out = redact_db_url(url)
    assert "supersecret" not in out
    assert "myuser" in out
    assert urlparse(out).hostname == "db.example.com"
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


def test_schema_lock_key_is_a_stable_signed_64_bit_integer_per_name():
    key = schema_lock_key("ingest_jobs")

    assert key == schema_lock_key("ingest_jobs")
    assert key != schema_lock_key("ingest_job_queue")
    assert -(2**63) <= key < 2**63


def test_postgres_takes_the_transaction_scoped_lock_before_any_ddl():
    executed: list[tuple[str, dict]] = []
    conn = SimpleNamespace(
        dialect=SimpleNamespace(name="postgresql"),
        execute=lambda statement, params=None: executed.append((str(statement), params or {})),
    )

    lock_schema(conn, "ingest_jobs")

    [(statement, params)] = executed
    assert "pg_advisory_xact_lock" in statement
    assert "pg_advisory_lock(" not in statement
    assert params == {"key": schema_lock_key("ingest_jobs")}


def test_sqlite_runs_the_ddl_plainly_and_commits_it(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path}/ddl.db")

    ensure_schema(engine, "t", lambda conn: conn.execute(text("CREATE TABLE t (id INTEGER PRIMARY KEY)")))

    assert inspect(engine).has_table("t")


def test_an_error_in_the_ddl_propagates(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path}/ddl.db")

    with pytest.raises(Exception, match="syntax error"):
        ensure_schema(engine, "t", lambda conn: conn.execute(text("CREATE TABLE this is not sql")))
