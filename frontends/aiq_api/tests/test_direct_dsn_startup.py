"""A process on Postgres refuses to start without the direct DSNs it uses (ADR-0083).

Behind the transaction pooler a missing ``AIQ_LISTEN_DB_URL`` or ``AIQ_LOCK_DB_URL``
is not an error anywhere downstream, it is every SSE stream quietly polling or a
lock that is never taken. So each process that uses them checks once, at start:
the ``api`` role needs both (it serves the streams and takes locks); the ``chat`` role,
the research worker and the ingest worker only take locks. These tests drive each entry point with a
Postgres database and no direct DSN and expect the boot to fail naming the
variable, before anything else is built.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from aiq_api.jobs import ingest_worker
from aiq_api.jobs import worker as research_worker
from aiq_api.plugin import AIQAPIWorker
from aiq_api.roles import WebRole
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorker

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


def _web(role: WebRole) -> AIQAPIWorker:
    """A worker of this role, without NAT's front end: the check runs ahead of ``super().build_app()``."""
    web = AIQAPIWorker.__new__(AIQAPIWorker)
    web._role = role
    return web


def test_the_api_role_will_not_boot_without_either_direct_dsn():
    with pytest.raises(RuntimeError, match="AIQ_LOCK_DB_URL is not set; AIQ_LISTEN_DB_URL is not set"):
        _web(WebRole.API).build_app()


def test_the_api_role_needs_the_listen_dsn_even_with_the_lock_dsn(monkeypatch):
    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    with pytest.raises(RuntimeError, match="AIQ_LISTEN_DB_URL is not set"):
        _web(WebRole.API).build_app()


def test_the_chat_role_needs_the_lock_dsn_and_not_the_listen_dsn(monkeypatch):
    """It serves no job stream (its stream is the socket, over Dragonfly), but it does take locks."""
    with pytest.raises(RuntimeError, match=r"AIQ_LOCK_DB_URL is not set, but"):
        _web(WebRole.CHAT).build_app()

    monkeypatch.setenv("AIQ_LOCK_DB_URL", DIRECT)
    sentinel = RuntimeError("past the check")

    def reached(self):
        raise sentinel

    monkeypatch.setattr(FastApiFrontEndPluginWorker, "build_app", reached)
    with pytest.raises(RuntimeError, match="past the check"):
        _web(WebRole.CHAT).build_app()


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


def test_the_check_follows_the_role_and_runs_before_the_app_is_built():
    source = (Path(__file__).resolve().parents[1] / "src/aiq_api/plugin.py").read_text(encoding="utf-8")

    check = "require_direct_dsns(listen=self._role is WebRole.API)"
    assert check in source
    assert source.index(check) < source.index("app = super().build_app()")
