"""Lazy resolution of the summary store DB URL (factory._get_summary_store).

When ``configure_summary_db()`` was never called in a process — e.g. an
ingestion thread/worker that didn't run the NAT registration — the store must
resolve its DB from the environment (``AIQ_SUMMARY_DB`` → ``NAT_JOB_STORE_DB_URL``)
rather than silently opening a local SQLite file that in a container often isn't
writable. Regression for OIB ingestion failing with
``sqlite3.OperationalError: unable to open database file``.
"""

from __future__ import annotations

import pytest

from aiq_agent.knowledge import factory


@pytest.fixture(autouse=True)
def _reset_summary_store(monkeypatch):
    """Force the lazy-init path and clear any process-wide store between tests."""
    monkeypatch.setattr(factory, "_summary_store", None)
    for var in ("AIQ_SUMMARY_DB", "NAT_JOB_STORE_DB_URL"):
        monkeypatch.delenv(var, raising=False)
    yield
    factory._summary_store = None


def test_lazy_init_prefers_aiq_summary_db(monkeypatch, tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'summary.db'}"
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    # A different NAT url must NOT win over the explicit AIQ_SUMMARY_DB.
    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", f"sqlite+aiosqlite:///{tmp_path / 'nat.db'}")

    store = factory._get_summary_store()

    assert store.db_url == url


def test_lazy_init_falls_back_to_nat_job_store(monkeypatch, tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'nat.db'}"
    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", url)

    store = factory._get_summary_store()

    assert store.db_url == url


def test_lazy_init_uses_default_only_when_no_env(monkeypatch, tmp_path):
    # No AIQ_SUMMARY_DB / NAT_JOB_STORE_DB_URL set (cleared by the fixture).
    # Run from a writable cwd so the SQLite default can actually open.
    monkeypatch.chdir(tmp_path)

    store = factory._get_summary_store()

    assert store.db_url == factory._DEFAULT_SUMMARY_DB


def test_configure_summary_db_is_not_overridden_by_env(monkeypatch, tmp_path):
    """An explicit configure_summary_db() wins — the env fallback only applies to
    the lazy cold-start path."""
    monkeypatch.setenv("AIQ_SUMMARY_DB", f"sqlite+aiosqlite:///{tmp_path / 'env.db'}")
    configured = f"sqlite+aiosqlite:///{tmp_path / 'configured.db'}"

    factory.configure_summary_db(configured)
    store = factory._get_summary_store()

    assert store.db_url == configured
