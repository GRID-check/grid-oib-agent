"""Tests for the cross-replica ingestion status store (Stage C).

Persisting ingestion status to Postgres lets a status poll routed to any replica
resolve — otherwise a replica that didn't accept the upload returns "not found".
Verified here on SQLite; production uses the shared Postgres.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
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


def _job_with_files(job_id: str, state: JobState, files: dict[str, FileStatus]) -> IngestionJobStatus:
    status = _status(job_id, state)
    status.file_details = [FileProgress(file_name=name, status=file_status) for name, file_status in files.items()]
    return status


class TestInFlightFiles:
    """What the chat turn waits on. This used to raise on the first job with
    per-file detail (it compared against ``FileStatus.COMPLETED``, which does
    not exist), and the caller's fail-open swallowed it, so the "still being
    read" warning never fired for exactly the uploads it was written for."""

    def test_lists_files_still_ingesting_in_a_running_job(self, sqlite_db):
        ingest_status_store.put(
            _job_with_files(
                "job-1",
                JobState.PROCESSING,
                {"plan.pdf": FileStatus.INGESTING, "done.pdf": FileStatus.SUCCESS, "bad.pdf": FileStatus.FAILED},
            )
        )

        assert ingest_status_store.in_flight_files(["s_test"]) == {"s_test": ["plan.pdf"]}

    def test_a_finished_job_is_not_in_flight(self, sqlite_db):
        ingest_status_store.put(_job_with_files("job-1", JobState.COMPLETED, {"plan.pdf": FileStatus.SUCCESS}))

        assert ingest_status_store.in_flight_files(["s_test"]) == {}

    def test_only_the_collections_asked_for(self, sqlite_db):
        ingest_status_store.put(_job_with_files("job-1", JobState.PROCESSING, {"plan.pdf": FileStatus.INGESTING}))

        assert ingest_status_store.in_flight_files(["s_other"]) == {}
        assert ingest_status_store.in_flight_files([]) == {}

    def test_no_db_is_empty(self, monkeypatch):
        monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
        monkeypatch.delenv("NAT_JOB_STORE_DB_URL", raising=False)
        assert ingest_status_store.in_flight_files(["s_test"]) == {}


# --- A live row is a claim its owner keeps making ---------------------------


def _age_heartbeat(url: str, job_id: str, *, legacy: bool = False) -> None:
    """Make a row look like its owner stopped beating (or, legacy, never beat)."""
    from sqlalchemy import create_engine
    from sqlalchemy import text

    engine = create_engine(url)
    with engine.begin() as conn:
        if legacy:
            conn.execute(
                text("UPDATE ingest_jobs SET heartbeat_at = NULL, owner = NULL, updated_at = :t WHERE job_id = :j"),
                {"t": "2000-01-01 00:00:00", "j": job_id},
            )
        else:
            conn.execute(
                text("UPDATE ingest_jobs SET heartbeat_at = :t WHERE job_id = :j"),
                {"t": "2000-01-01 00:00:00", "j": job_id},
            )
    engine.dispose()


def _with_file(job_id: str, state: JobState) -> IngestionJobStatus:
    return _job_with_files(job_id, state, {"plan.pdf": FileStatus.INGESTING})


class TestInterruptedJobs:
    def test_a_fresh_live_row_stays_live(self, sqlite_db):
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        got = ingest_status_store.get("job-1")
        assert got is not None and got.status == JobState.PROCESSING

    @pytest.mark.parametrize("state", [JobState.PENDING, JobState.PROCESSING])
    def test_a_live_row_whose_owner_stopped_beating_reads_interrupted(self, sqlite_db, state):
        ingest_status_store.put(_with_file("job-1", state))
        _age_heartbeat(sqlite_db, "job-1")

        got = ingest_status_store.get("job-1")

        assert got is not None
        assert got.status == JobState.FAILED
        assert got.error_message.startswith("interrupted:")
        assert got.metadata["failure_reason"] == "interrupted"
        assert got.metadata["retryable"] is True
        assert got.file_details[0].status == FileStatus.FAILED
        # Stored that way, not only answered: the next reader sees the same.
        _age_heartbeat(sqlite_db, "job-1")
        again = ingest_status_store.get("job-1")
        assert again is not None and again.status == JobState.FAILED

    def test_a_finished_row_is_never_rewritten(self, sqlite_db):
        ingest_status_store.put(_with_file("job-1", JobState.COMPLETED))
        _age_heartbeat(sqlite_db, "job-1")
        got = ingest_status_store.get("job-1")
        assert got is not None and got.status == JobState.COMPLETED

    def test_a_legacy_row_ages_by_its_last_write(self, sqlite_db):
        # A replica that predates heartbeats writes neither column.
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        _age_heartbeat(sqlite_db, "job-1", legacy=True)
        got = ingest_status_store.get("job-1")
        assert got is not None and got.status == JobState.FAILED

    def test_heartbeat_keeps_this_processs_rows_alive(self, sqlite_db):
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        _age_heartbeat(sqlite_db, "job-1")
        ingest_status_store.heartbeat(["job-1"])
        got = ingest_status_store.get("job-1")
        assert got is not None and got.status == JobState.PROCESSING

    def test_heartbeat_does_not_revive_another_owners_row(self, sqlite_db, monkeypatch):
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        _age_heartbeat(sqlite_db, "job-1")
        monkeypatch.setattr(ingest_status_store, "OWNER", "another-process")
        ingest_status_store.heartbeat(["job-1"])
        got = ingest_status_store.get("job-1")
        assert got is not None and got.status == JobState.FAILED

    def test_startup_sweep_settles_stranded_rows_only(self, sqlite_db):
        ingest_status_store.put(_with_file("stranded", JobState.PROCESSING))
        ingest_status_store.put(_with_file("running", JobState.PROCESSING))
        ingest_status_store.put(_with_file("done", JobState.COMPLETED))
        _age_heartbeat(sqlite_db, "stranded")
        _age_heartbeat(sqlite_db, "done")

        assert ingest_status_store.fail_interrupted() == 1

        from sqlalchemy import create_engine
        from sqlalchemy import text

        engine = create_engine(sqlite_db)
        with engine.connect() as conn:
            raw = dict(conn.execute(text("SELECT job_id, status_json FROM ingest_jobs")).all())
        engine.dispose()
        assert IngestionJobStatus.model_validate_json(raw["stranded"]).status == JobState.FAILED
        assert IngestionJobStatus.model_validate_json(raw["running"]).status == JobState.PROCESSING
        assert IngestionJobStatus.model_validate_json(raw["done"]).status == JobState.COMPLETED

    def test_a_stranded_job_is_not_in_flight(self, sqlite_db):
        status = _with_file("job-1", JobState.PROCESSING)
        ingest_status_store.put(status)
        _age_heartbeat(sqlite_db, "job-1")
        assert ingest_status_store.in_flight_files(["s_test"]) == {}

    def test_the_migration_is_additive_over_an_existing_table(self, tmp_path, monkeypatch):
        from sqlalchemy import create_engine
        from sqlalchemy import text

        url = f"sqlite:///{tmp_path}/old.db"
        engine = create_engine(url)
        with engine.begin() as conn:
            conn.execute(
                text(
                    "CREATE TABLE ingest_jobs (job_id VARCHAR PRIMARY KEY, status_json TEXT NOT NULL,"
                    " updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
                )
            )
            conn.execute(
                text("INSERT INTO ingest_jobs (job_id, status_json) VALUES ('old', :j)"),
                {"j": _status("old", JobState.COMPLETED).model_dump_json()},
            )
        engine.dispose()
        monkeypatch.setenv("AIQ_SUMMARY_DB", url)
        try:
            got = ingest_status_store.get("old")
            assert got is not None and got.status == JobState.COMPLETED
            ingest_status_store.put(_with_file("new", JobState.PROCESSING))
            assert ingest_status_store.get("new").status == JobState.PROCESSING
        finally:
            ingest_status_store._initialized.discard(url)


class TestFindLive:
    def _keyed(self, job_id: str, state: JobState, key: str = "k1") -> IngestionJobStatus:
        status = _with_file(job_id, state)
        status.metadata["dispatch_key"] = key
        return status

    def test_finds_the_live_job_for_a_dispatch(self, sqlite_db):
        ingest_status_store.put(self._keyed("job-1", JobState.PENDING))
        got = ingest_status_store.find_live("k1")
        assert got is not None and got.job_id == "job-1"

    def test_a_finished_job_is_not_live(self, sqlite_db):
        ingest_status_store.put(self._keyed("job-1", JobState.COMPLETED))
        assert ingest_status_store.find_live("k1") is None

    def test_another_dispatch_is_not_this_one(self, sqlite_db):
        ingest_status_store.put(self._keyed("job-1", JobState.PENDING, key="k2"))
        assert ingest_status_store.find_live("k1") is None

    def test_a_stranded_job_is_settled_not_returned(self, sqlite_db):
        ingest_status_store.put(self._keyed("job-1", JobState.PROCESSING))
        _age_heartbeat(sqlite_db, "job-1")
        assert ingest_status_store.find_live("k1") is None
        assert ingest_status_store.get("job-1").status == JobState.FAILED

    def test_a_later_write_without_the_key_keeps_it(self, sqlite_db):
        ingest_status_store.put(self._keyed("job-1", JobState.PENDING))
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        assert ingest_status_store.find_live("k1").job_id == "job-1"


# --- Lost writes are reported, and a settle that lost the race says so -------


def _owner_beats_before_the_settle(monkeypatch, url: str) -> None:
    """The owner beats between a reader's SELECT and its settling UPDATE.

    Through its own engine, as the owner is another process: the store's
    SQLite pool holds one connection, and the reader has it.
    """
    from sqlalchemy import create_engine
    from sqlalchemy import text

    settle = ingest_status_store._settle_interrupted

    def beat_then_settle(conn, url_, status):
        engine = create_engine(url)
        with engine.begin() as owner:
            owner.execute(
                text("UPDATE ingest_jobs SET heartbeat_at = CURRENT_TIMESTAMP WHERE job_id = :j"),
                {"j": status.job_id},
            )
        engine.dispose()
        return settle(conn, url_, status)

    monkeypatch.setattr(ingest_status_store, "_settle_interrupted", beat_then_settle)


class TestWritesReportTheirOutcome:
    def test_put_says_whether_the_row_was_stored(self, sqlite_db, monkeypatch):
        assert ingest_status_store.put(_status("job-1")) is True

        def unreachable(url):
            raise ConnectionError("database unreachable")

        monkeypatch.setattr(ingest_status_store, "_ensure_table", unreachable)
        assert ingest_status_store.put(_status("job-1", JobState.COMPLETED)) is False

    def test_without_a_database_there_is_nothing_to_retry(self, monkeypatch):
        monkeypatch.delenv("AIQ_SUMMARY_DB", raising=False)
        monkeypatch.delenv("NAT_JOB_STORE_DB_URL", raising=False)
        assert ingest_status_store.put(_status("job-1")) is True
        assert ingest_status_store.heartbeat(["job-1"]) is None

    def test_heartbeat_counts_the_rows_it_refreshed(self, sqlite_db):
        ingest_status_store.put(_with_file("mine", JobState.PROCESSING))
        assert ingest_status_store.heartbeat(["mine", "never-written"]) == 1
        assert ingest_status_store.heartbeat([]) == 0

    def test_a_settled_row_is_not_the_owners_to_beat_any_more(self, sqlite_db):
        """Settling clears the owner, so the owner's heartbeat sees the row is gone."""
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        _age_heartbeat(sqlite_db, "job-1")
        assert ingest_status_store.get("job-1").status == JobState.FAILED

        assert ingest_status_store.heartbeat(["job-1"]) == 0


class TestTheSettleRace:
    def test_get_returns_the_row_the_owner_kept_alive(self, sqlite_db, monkeypatch):
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        _age_heartbeat(sqlite_db, "job-1")
        _owner_beats_before_the_settle(monkeypatch, sqlite_db)

        got = ingest_status_store.get("job-1")

        assert got is not None and got.status == JobState.PROCESSING
        assert ingest_status_store.heartbeat(["job-1"]) == 1, "the owner still holds the row"

    def test_the_sweep_counts_only_rows_it_settled(self, sqlite_db, monkeypatch):
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        _age_heartbeat(sqlite_db, "job-1")
        _owner_beats_before_the_settle(monkeypatch, sqlite_db)

        assert ingest_status_store.fail_interrupted() == 0
        assert ingest_status_store.get("job-1").status == JobState.PROCESSING

    def test_find_live_returns_the_job_that_beat_again(self, sqlite_db, monkeypatch):
        status = _with_file("job-1", JobState.PROCESSING)
        status.metadata = {"dispatch_key": "k1"}
        ingest_status_store.put(status)
        _age_heartbeat(sqlite_db, "job-1")
        _owner_beats_before_the_settle(monkeypatch, sqlite_db)

        found = ingest_status_store.find_live("k1")

        assert found is not None and found.job_id == "job-1" and found.status == JobState.PROCESSING


class TestTheOwnerIsRightAboutItsJob:
    """An owner cut off past the stale window is settled by another replica; its next write wins."""

    def test_the_owners_terminal_write_replaces_the_interrupted_failure(self, sqlite_db):
        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))
        _age_heartbeat(sqlite_db, "job-1")
        assert ingest_status_store.get("job-1").status == JobState.FAILED

        assert ingest_status_store.put(_with_file("job-1", JobState.COMPLETED)) is True

        got = ingest_status_store.get("job-1")
        assert got is not None and got.status == JobState.COMPLETED and got.error_message is None

    def test_the_owners_live_write_makes_the_job_findable_again(self, sqlite_db):
        """Otherwise a retried dispatch finds nothing live and starts a second job on the same file."""
        status = _with_file("job-1", JobState.PROCESSING)
        status.metadata = {"dispatch_key": "k1"}
        ingest_status_store.put(status)
        _age_heartbeat(sqlite_db, "job-1")
        assert ingest_status_store.find_live("k1") is None

        ingest_status_store.put(_with_file("job-1", JobState.PROCESSING))

        found = ingest_status_store.find_live("k1")
        assert found is not None and found.job_id == "job-1"
        assert ingest_status_store.heartbeat(["job-1"]) == 1
