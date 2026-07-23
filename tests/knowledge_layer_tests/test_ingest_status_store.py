"""Tests for the cross-replica ingestion status store (Stage C).

Persisting ingestion status to Postgres lets a status poll routed to any replica
resolve — otherwise a replica that didn't accept the upload returns "not found".
Verified here on SQLite; production uses the shared Postgres.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState


def _status(job_id: str, state: JobState = JobState.PROCESSING) -> IngestionJobStatus:
    return IngestionJobStatus(
        job_id=job_id,
        status=state,
        submitted_at=datetime(2026, 7, 22, 12, 0, 0),
        total_files=1,
        processed_files=0,
        collection_name="s_test",
        backend="llamaindex",
    )


@pytest.fixture
def sqlite_db(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/jobs.db"
    monkeypatch.setenv("AIQ_SUMMARY_DB", url)
    yield url
    ingest_status_store._initialized.discard(url)


def test_noop_without_db(monkeypatch):
    monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
    monkeypatch.delenv("NAT_JOB_STORE_DB_URL", raising=False)
    # No DB configured: writes are no-ops and reads return None (adapter then
    # falls back to its in-process dict — single-node behaviour unchanged).
    ingest_status_store.put(_status("job-1"))
    assert ingest_status_store.get("job-1") is None


def test_put_get_roundtrip(sqlite_db):
    ingest_status_store.put(_status("job-1", JobState.PROCESSING))
    got = ingest_status_store.get("job-1")
    assert got is not None
    assert got.job_id == "job-1"
    assert got.status == JobState.PROCESSING
    assert got.collection_name == "s_test"


def test_put_upserts_latest_status(sqlite_db):
    ingest_status_store.put(_status("job-1", JobState.PROCESSING))
    ingest_status_store.put(_status("job-1", JobState.COMPLETED))
    got = ingest_status_store.get("job-1")
    assert got is not None and got.status == JobState.COMPLETED


def test_get_missing_returns_none(sqlite_db):
    assert ingest_status_store.get("nope") is None


def test_delete(sqlite_db):
    ingest_status_store.put(_status("job-1"))
    ingest_status_store.delete("job-1")
    assert ingest_status_store.get("job-1") is None
