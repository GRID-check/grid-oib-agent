"""A process on Postgres refuses to start without the direct DSNs it uses (ADR-0083).

Behind the transaction pooler a missing ``AIQ_LISTEN_DB_URL`` or ``AIQ_LOCK_DB_URL``
is not an error anywhere downstream, it is every SSE stream quietly polling or a
lock that is never taken. So each process that uses them checks once, at start:
the web tier needs both (it serves the streams and takes locks), the research and
ingest workers only take locks. These tests drive each entry point with a
Postgres database and no direct DSN and expect the boot to fail naming the
variable, before anything else is built.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aiq_api.jobs import ingest_worker
from aiq_api.jobs import worker as research_worker

POOLED = "postgresql+psycopg://aiq:pw@grid-pg-pooler-rw:5432/aiq_jobs"  # pragma: allowlist secret
DIRECT = "postgresql://aiq:pw@grid-pg-rw:5432/aiq_jobs"  # pragma: allowlist secret


@pytest.fixture(autouse=True)
def _postgres_without_direct_dsns(monkeypatch):
    monkeypatch.setenv("AIQ_SUMMARY_DB", POOLED)
    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", POOLED)
    monkeypatch.delenv("AIQ_LOCK_DB_URL", raising=False)
    monkeypatch.delenv("AIQ_LISTEN_DB_URL", raising=False)


def test_the_research_worker_will_not_boot_without_the_lock_dsn():
    with pytest.raises(RuntimeError, match="AIQ_LOCK_DB_URL is not set"):
        research_worker.main()


def test_the_ingest_worker_will_not_boot_without_the_lock_dsn():
    with pytest.raises(RuntimeError, match="AIQ_LOCK_DB_URL is not set"):
        ingest_worker.main()


def test_the_web_tier_will_not_boot_without_either_direct_dsn():
    from aiq_api.plugin import AIQAPIWorker

    # The check runs ahead of `super().build_app()`, so no NAT front end is needed.
    web = AIQAPIWorker.__new__(AIQAPIWorker)
    with pytest.raises(RuntimeError, match="AIQ_LOCK_DB_URL is not set; AIQ_LISTEN_DB_URL is not set"):
        web.build_app()


def test_the_web_tier_needs_the_listen_dsn_even_with_the_lock_dsn(monkeypatch):
    from aiq_api.plugin import AIQAPIWorker

    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    web = AIQAPIWorker.__new__(AIQAPIWorker)
    with pytest.raises(RuntimeError, match="AIQ_LISTEN_DB_URL is not set"):
        web.build_app()


def test_the_workers_do_not_ask_for_the_listen_dsn(monkeypatch):
    """They never serve a stream: the lock DSN alone gets past the check."""
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    sentinel = RuntimeError("past the check")

    class Reached:
        def __init__(self):
            raise sentinel

    monkeypatch.setattr(research_worker, "ResearchWorker", Reached)
    with pytest.raises(RuntimeError, match="past the check"):
        research_worker.main()


def test_the_check_runs_before_the_app_is_built():
    source = (Path(__file__).resolve().parents[1] / "src/aiq_api/plugin.py").read_text(encoding="utf-8")

    assert "require_direct_dsns(listen=True)" in source
    assert source.index("require_direct_dsns(listen=True)") < source.index("app = super().build_app()")
