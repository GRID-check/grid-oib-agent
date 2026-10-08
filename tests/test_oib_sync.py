"""Ingestion of the base corpus: what needs it, which job carries it, what is recorded (ADR-0082, step A2).

The corpus is a real table and a fake bucket (``tests/object_corpus_fakes``); the ingest queue and the
ingest status store are the real ones, in the same database (SQLite, or Postgres when
``GRID_TEST_CORPUS_DB`` is set). The vector store is a fake ingestor that can only PREPARE a job: it
raises on anything that would ingest in this process. The ingest worker is played by
:func:`run_worker`, which claims what is queued, runs its download for real, and writes the outcome the
way the ingestor does.
"""

from __future__ import annotations

import contextlib
import hashlib
import inspect
import logging
import threading

import pytest

from aiq_agent import corpus_store
from aiq_agent import oib_sync
from aiq_agent.common import claim_queue
from aiq_agent.knowledge import ingest_queue
from aiq_agent.knowledge import ingest_status_store
from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.ingest_scheduler import PLATFORM_LANE
from aiq_api.jobs import ingest_dispatch
from tests.corpus_job_fakes import FakeIngestor
from tests.corpus_job_fakes import lose_the_workers_for as _lose_the_workers_for
from tests.corpus_job_fakes import run_worker
from tests.object_corpus_fakes import FakeBucket
from tests.object_corpus_fakes import install


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def bucket(monkeypatch, tmp_path) -> FakeBucket:
    monkeypatch.setattr(oib_sync, "COLLECTION_NAME", "test_collection")
    monkeypatch.delenv("GRID_INGEST_QUEUE", raising=False)
    monkeypatch.delenv("GRID_JOB_PAYLOAD_KEK", raising=False)
    return install(monkeypatch, tmp_path)


@pytest.fixture
def ingestor(monkeypatch, bucket) -> FakeIngestor:
    fake = FakeIngestor()
    monkeypatch.setattr(oib_sync, "_get_oib_ingestor", lambda: fake)
    return fake


@pytest.fixture
def summaries(monkeypatch) -> list[str]:
    unregistered: list[str] = []
    monkeypatch.setattr(oib_sync, "unregister_summary", lambda _collection, name: unregistered.append(name))
    return unregistered


def _row(name: str) -> corpus_store.FileRow:
    row = corpus_store.get_file(name)
    assert row is not None
    return row


def _queued() -> int:
    return ingest_queue.counts().get(ingest_queue.QUEUED, 0)


def _engine():
    return DocumentMetadataStore._get_or_create_sync_engine(ingest_queue.db_url())


class TestSync:
    def test_a_pending_file_becomes_one_queued_job_and_two_cycles_queue_one(self, ingestor):
        corpus_store.put("a.pdf", b"a")

        first = oib_sync.sync()
        second = oib_sync.sync()

        assert first == oib_sync.SyncResult(enqueued=1, ingested_recorded=0, failed=0, total=1)
        assert second == oib_sync.SyncResult(enqueued=0, ingested_recorded=0, failed=0, total=1)
        assert _queued() == 1
        assert len(ingestor.prepared) == 1

    def test_the_job_is_a_bulk_platform_lane_job_that_downloads_the_corpus_object(self, ingestor):
        row = corpus_store.put("a.pdf", b"alpha")
        oib_sync.sync()

        claim = ingest_queue.claim_next("worker-1", stale_seconds=180, max_attempts=3)

        assert claim is not None
        assert claim.job_id == oib_sync.job_id_for(row)
        assert claim.lane == PLATFORM_LANE
        assert claim.priority == claim_queue.priority_rank("bulk")
        job = ingest_dispatch.decode(claim.payload)
        assert job.collection_name == "test_collection"
        assert job.config["original_filenames"] == ["a.pdf"]
        assert job.config["priority"] == "bulk"
        assert job.config["cleanup_files"] is True
        assert "doc_class" not in job.config  # the ingestor guesses it
        (download,) = job.file_paths
        assert isinstance(download, corpus_store.CorpusObjectDownload)
        assert (download.storage_key, download.sha256) == ("base-corpus/a.pdf", _sha(b"alpha"))

    def test_the_worker_reads_the_object_itself_and_checks_its_hash(self, ingestor, bucket):
        corpus_store.put("a.pdf", b"alpha")
        oib_sync.sync()
        bucket.objects["base-corpus/a.pdf"] = b"replaced while the job waited"

        claim = ingest_queue.claim_next("worker-1", stale_seconds=180, max_attempts=3)
        download = ingest_dispatch.decode(claim.payload).file_paths[0]

        with pytest.raises(corpus_store.CorpusStoreError, match="does not match"):
            download()

    def test_nothing_is_ingested_in_this_process(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        corpus_store.put("b.pdf", b"b")

        oib_sync.sync()  # the fake raises on upload_file, submit_job, submit_prepared and run_prepared

        assert len(ingestor.prepared) == 2

    def test_the_module_has_no_in_process_ingestion_in_it(self):
        source = inspect.getsource(oib_sync)
        for forbidden in ("upload_file(", ".submit_job(", ".submit_prepared(", ".run_prepared(", "ThreadPoolExecutor"):
            assert forbidden not in source, f"oib_sync must not ingest in-process, but it uses {forbidden}"

    def test_a_job_that_succeeded_is_recorded_and_the_file_is_current(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker()

        result = oib_sync.sync()

        assert result == oib_sync.SyncResult(enqueued=0, ingested_recorded=1, failed=0, total=1)
        row = _row("a.pdf")
        assert row.ingested_sha256 == _sha(b"a")
        assert row.chunk_format_version == oib_sync.CHUNK_FORMAT_VERSION
        assert not row.needs_ingestion(oib_sync.CHUNK_FORMAT_VERSION)
        assert oib_sync.sync().ingested_recorded == 0
        assert _queued() == 0

    def test_a_job_still_waiting_is_not_queued_again_nor_recorded(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()

        result = oib_sync.sync()

        assert result.enqueued == 0 and result.ingested_recorded == 0
        assert _row("a.pdf").ingested_sha256 is None

    def test_a_job_that_ran_and_failed_is_failed_and_not_queued_again(self, ingestor):
        row = corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker(succeed=False)

        first = oib_sync.sync()
        second = oib_sync.sync()

        assert first == oib_sync.SyncResult(enqueued=0, ingested_recorded=0, failed=1, total=1)
        assert second.failed == 1 and second.enqueued == 0
        assert _row("a.pdf").failed_job_id == oib_sync.job_id_for(row)
        assert _queued() == 0

    def test_the_failure_outlives_the_status_row_that_reported_it(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker(succeed=False)
        oib_sync.sync()
        ingest_status_store.delete(
            oib_sync.job_id_for(_row("a.pdf"))
        )  # the ingestor prunes finished jobs after an hour

        result = oib_sync.sync()

        assert result.failed == 1 and result.enqueued == 0

    def test_a_dead_job_is_failed_and_not_queued_again(self, ingestor):
        row = corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        _lose_the_workers_for(oib_sync.job_id_for(row))

        first = oib_sync.sync()
        second = oib_sync.sync()

        assert first.failed == 1 and first.enqueued == 0
        assert second.failed == 1 and second.enqueued == 0
        assert _queued() == 0
        assert _row("a.pdf").failed_job_id == oib_sync.job_id_for(row)

    def test_new_bytes_after_a_failure_are_queued_again(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker(succeed=False)
        assert oib_sync.sync().failed == 1

        row = corpus_store.put("a.pdf", b"a, corrected")
        result = oib_sync.sync()

        assert result == oib_sync.SyncResult(enqueued=1, ingested_recorded=0, failed=0, total=1)
        assert oib_sync.job_id_for(row) in {p.job_id for p in ingestor.prepared}
        assert len({p.job_id for p in ingestor.prepared}) == 2

    def test_replaced_bytes_get_a_new_job(self, ingestor):
        corpus_store.put("a.pdf", b"v1")
        oib_sync.sync()
        run_worker()
        oib_sync.sync()

        corpus_store.put("a.pdf", b"version two")
        result = oib_sync.sync()

        assert result.enqueued == 1
        run_worker()
        assert oib_sync.sync().ingested_recorded == 1
        assert _row("a.pdf").ingested_sha256 == _sha(b"version two")

    def test_a_new_chunk_format_queues_a_new_job_for_every_file(self, ingestor, monkeypatch):
        corpus_store.put("a.pdf", b"a")
        corpus_store.put("b.pdf", b"b")
        oib_sync.sync()
        run_worker()
        oib_sync.sync()
        assert _queued() == 0

        monkeypatch.setattr(oib_sync, "CHUNK_FORMAT_VERSION", oib_sync.CHUNK_FORMAT_VERSION + 1)
        result = oib_sync.sync()

        assert result.enqueued == 2
        run_worker()
        oib_sync.sync()
        assert _row("a.pdf").chunk_format_version == oib_sync.CHUNK_FORMAT_VERSION

    def test_a_reset_vector_store_is_filled_again(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker()
        oib_sync.sync()
        ingestor.collection = None  # Chroma wiped or repointed; the table still says "ingested"

        result = oib_sync.sync()

        assert result.enqueued == 1
        assert _row("a.pdf").ingested_sha256 is None
        run_worker()
        assert oib_sync.sync().ingested_recorded == 1

    def test_a_vector_store_that_cannot_be_probed_does_not_discard_what_the_table_knows(self, ingestor, monkeypatch):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker()
        oib_sync.sync()

        def unreachable(_name):
            raise ConnectionError("chroma is down")

        monkeypatch.setattr(ingestor, "get_collection", unreachable)

        assert oib_sync.sync().enqueued == 0
        assert _row("a.pdf").ingested_sha256 == _sha(b"a")

    def test_an_empty_corpus_is_a_cycle_that_does_nothing(self, ingestor):
        assert oib_sync.sync() == oib_sync.SyncResult(enqueued=0, ingested_recorded=0, failed=0, total=0)
        assert ingestor.prepared == []

    def test_a_cycle_is_cheap_it_runs_no_download(self, ingestor, bucket):
        corpus_store.put("a.pdf", b"a")

        oib_sync.sync()

        assert bucket.downloads == []

    def test_the_cycle_logs_what_it_did(self, ingestor, caplog):
        corpus_store.put("a.pdf", b"a")

        with caplog.at_level(logging.INFO, logger="aiq_agent.oib_sync"):
            oib_sync.sync()

        assert "enqueued=1" in caplog.text


class TestNoInProcessFallback:
    def test_with_the_queue_switched_off_the_cycle_errors_and_leaves_nothing_pending(self, ingestor, monkeypatch):
        monkeypatch.setenv("GRID_INGEST_QUEUE", "off")
        row = corpus_store.put("a.pdf", b"a")

        with pytest.raises(ingest_dispatch.QueueUnavailable, match="ingest queue is off"):
            oib_sync.sync()

        assert ingest_status_store.get(oib_sync.job_id_for(row)) is None  # no pending job nobody holds
        assert _queued() == 0

    def test_an_ingestor_that_cannot_run_a_job_elsewhere_errors(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        original = ingestor.prepare_job

        def prepare_a_job_with_a_local_file(file_paths, collection_name, config=None, job_id=None):
            return original(["/tmp/a-local-path.pdf"], collection_name, config, job_id)

        ingestor.prepare_job = prepare_a_job_with_a_local_file

        with pytest.raises(ingest_dispatch.QueueUnavailable, match="cannot run in another process"):
            oib_sync.sync()

    def test_a_queue_that_cannot_be_written_errors(self, ingestor, monkeypatch):
        corpus_store.put("a.pdf", b"a")

        def refuse(*_args, **_kwargs):
            raise ConnectionError("database down")

        monkeypatch.setattr(ingest_queue, "enqueue", refuse)

        with pytest.raises(ingest_dispatch.QueueUnavailable, match="ConnectionError"):
            oib_sync.sync()

    def test_the_cycle_comes_back_after_the_queue_does(self, ingestor, monkeypatch):
        corpus_store.put("a.pdf", b"a")
        monkeypatch.setenv("GRID_INGEST_QUEUE", "off")
        with pytest.raises(ingest_dispatch.QueueUnavailable):
            oib_sync.sync()
        monkeypatch.delenv("GRID_INGEST_QUEUE")

        assert oib_sync.sync().enqueued == 1


class TestUpload:
    def test_an_upload_queues_its_job_at_once_with_the_admins_dokumentart(self, ingestor):
        queued = oib_sync.store_and_request("plan.pdf", b"%PDF plan", "oib_leitfaden")

        assert queued is True
        assert _row("plan.pdf").sha256 == _sha(b"%PDF plan")
        claim = ingest_queue.claim_next("worker-1", stale_seconds=180, max_attempts=3)
        assert ingest_dispatch.decode(claim.payload).config["doc_class"] == "oib_leitfaden"

    def test_a_cycle_after_an_upload_queues_nothing_more(self, ingestor):
        oib_sync.store_and_request("plan.pdf", b"%PDF plan")

        result = oib_sync.sync()

        assert result.enqueued == 0
        assert _queued() == 1

    def test_an_upload_after_a_cycle_queues_nothing_more(self, ingestor):
        corpus_store.put("plan.pdf", b"%PDF plan")
        oib_sync.sync()

        assert oib_sync.store_and_request("plan.pdf", b"%PDF plan") is False
        assert _queued() == 1

    def test_the_file_is_stored_and_its_job_queued_under_one_hold_of_the_lock(self, ingestor, monkeypatch):
        held: list[str] = []
        events: list[str] = []

        @contextlib.contextmanager
        def recording(key):
            held.append(key)
            events.append("lock")
            yield
            events.append("unlock")

        monkeypatch.setattr(oib_sync, "keyed_lock", recording)
        real_put = corpus_store.put
        monkeypatch.setattr(corpus_store, "put", lambda *a, **k: events.append("put") or real_put(*a, **k))

        oib_sync.store_and_request("plan.pdf", b"%PDF plan")

        assert held == ["oib-file:plan.pdf"]
        assert events == ["lock", "put", "unlock"]

    def test_a_store_that_refuses_the_file_lists_nothing_and_queues_nothing(self, ingestor, bucket):
        bucket.refuse_uploads = True

        with pytest.raises(corpus_store.CorpusStoreError):
            oib_sync.store_and_request("plan.pdf", b"%PDF plan")

        assert corpus_store.get_file("plan.pdf") is None
        assert ingestor.prepared == []

    def test_a_queue_that_is_down_leaves_the_file_stored_for_the_next_cycle(self, ingestor, monkeypatch):
        monkeypatch.setenv("GRID_INGEST_QUEUE", "off")
        with pytest.raises(ingest_dispatch.QueueUnavailable):
            oib_sync.store_and_request("plan.pdf", b"%PDF plan")
        monkeypatch.delenv("GRID_INGEST_QUEUE")

        assert corpus_store.get_file("plan.pdf") is not None
        assert oib_sync.sync().enqueued == 1

    def test_a_cycle_cannot_queue_the_file_between_its_row_and_its_job(self, ingestor, monkeypatch):
        """The cycle waits on the same per-file lock, so the upload's Dokumentart is never lost to it."""
        in_put = threading.Event()
        release = threading.Event()
        real_put = corpus_store.put

        def slow_put(name, data):
            row = real_put(name, data)
            in_put.set()
            release.wait(10)
            return row

        monkeypatch.setattr(corpus_store, "put", slow_put)
        upload = threading.Thread(
            target=oib_sync.store_and_request, args=("plan.pdf", b"%PDF plan", "gesetz"), daemon=True
        )
        upload.start()
        assert in_put.wait(10)
        cycle = threading.Thread(target=oib_sync.sync, daemon=True)
        cycle.start()
        cycle.join(0.3)
        assert cycle.is_alive()  # parked behind the upload's hold of the file
        release.set()
        upload.join(10)
        cycle.join(10)

        claim = ingest_queue.claim_next("worker-1", stale_seconds=180, max_attempts=3)
        assert ingest_dispatch.decode(claim.payload).config["doc_class"] == "gesetz"
        assert _queued() == 0


class TestRequestIngestion:
    def test_a_file_that_left_the_corpus_is_a_lookup_error(self, ingestor):
        with pytest.raises(LookupError, match="ghost.pdf"):
            oib_sync.request_ingestion("ghost.pdf")

    def test_a_file_the_index_was_built_from_is_not_queued(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker()
        oib_sync.sync()

        assert oib_sync.request_ingestion("a.pdf") is False


class TestStatusFromJobs:
    def test_a_finished_job_is_recorded_by_asking_not_only_by_the_cycle(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker()

        settled = oib_sync.settle(corpus_store.list_files())

        assert settled.recorded == 1
        assert not settled.rows["a.pdf"].needs_ingestion(oib_sync.CHUNK_FORMAT_VERSION)

    def test_progress_follows_the_job(self, ingestor):
        row = corpus_store.put("a.pdf", b"a")
        assert oib_sync.progress_of(row) == oib_sync.JobProgress.NONE
        oib_sync.sync()
        assert oib_sync.progress_of(row) == oib_sync.JobProgress.WAITING
        run_worker()
        assert oib_sync.progress_of(row) == oib_sync.JobProgress.DONE


class TestRemoveDocument:
    def test_deletes_chunks_summary_row_object_and_cached_copy(self, ingestor, bucket, summaries, tmp_path):
        corpus_store.put("custom.pdf", b"custom")
        ingestor.indexed.add("custom.pdf")

        assert oib_sync.remove_document("custom.pdf") is True

        assert ingestor.deleted == ["custom.pdf"]
        assert summaries == ["custom.pdf"]
        assert corpus_store.get_file("custom.pdf") is None
        assert bucket.objects == {}
        assert not (tmp_path / "cache" / "custom.pdf").exists()

    def test_cancels_the_job_queued_for_the_file(self, ingestor, summaries):
        row = corpus_store.put("custom.pdf", b"custom")
        oib_sync.sync()
        assert _queued() == 1

        oib_sync.remove_document("custom.pdf")

        assert _queued() == 0
        assert ingest_status_store.get(oib_sync.job_id_for(row)) is None
        assert oib_sync.sync().enqueued == 0

    def test_a_deleted_file_is_not_queued_by_the_next_cycle(self, ingestor, summaries):
        corpus_store.put("custom.pdf", b"custom")
        oib_sync.remove_document("custom.pdf")

        assert oib_sync.sync().total == 0
        assert ingestor.prepared == []

    def test_a_name_only_the_index_knows_is_cleared_too(self, ingestor, summaries):
        ingestor.indexed.add("leftover.pdf")

        assert oib_sync.remove_document("leftover.pdf") is True

        assert ingestor.deleted == ["leftover.pdf"]

    @pytest.mark.parametrize("name", ["nope.pdf", "../oib/shipped.pdf", "notes.txt", ""])
    def test_an_unknown_or_unsafe_name_is_false_and_touches_nothing(self, ingestor, bucket, summaries, name):
        assert oib_sync.remove_document(name) is False

        assert ingestor.deleted == [] and summaries == [] and bucket.deletes == []

    def test_a_failed_chunk_delete_keeps_the_document_listed_so_a_retry_finds_it(
        self, ingestor, bucket, summaries, monkeypatch
    ):
        corpus_store.put("custom.pdf", b"custom")

        def fail(_name, _collection):
            raise RuntimeError("chroma is down")

        monkeypatch.setattr(ingestor, "delete_file", fail)

        with pytest.raises(RuntimeError):
            oib_sync.remove_document("custom.pdf")

        assert corpus_store.get_file("custom.pdf") is not None
        assert bucket.objects

    def test_an_object_the_store_cannot_delete_is_an_error_after_the_chunks_are_gone(
        self, ingestor, summaries, monkeypatch
    ):
        corpus_store.put("custom.pdf", b"custom")

        def refuse(_name):
            raise corpus_store.CorpusStoreError("delete of custom.pdf from the object store was refused (HTTP 500)")

        monkeypatch.setattr(corpus_store, "_delete_object", refuse)

        with pytest.raises(corpus_store.CorpusStoreError):
            oib_sync.remove_document("custom.pdf")

        assert ingestor.deleted == ["custom.pdf"]
        assert corpus_store.get_file("custom.pdf") is None


class TestMarkForReingest:
    def test_a_finished_file_needs_a_new_job_with_the_same_id_after_it(self, ingestor):
        row = corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker()
        oib_sync.sync()

        assert oib_sync.mark_for_reingest("a.pdf") is True
        assert _row("a.pdf").ingested_sha256 is None
        assert oib_sync.request_ingestion("a.pdf") is True

        claim = ingest_queue.claim_next("worker-1", stale_seconds=180, max_attempts=3)
        assert claim.job_id == oib_sync.job_id_for(row)

    def test_a_failed_file_is_tried_again_when_an_admin_asks(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        run_worker(succeed=False)
        assert oib_sync.sync().failed == 1

        assert oib_sync.mark_for_reingest("a.pdf") is True
        result = oib_sync.sync()

        assert result.enqueued == 1 and result.failed == 0

    def test_a_dead_file_is_tried_again_when_an_admin_asks(self, ingestor):
        row = corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        _lose_the_workers_for(oib_sync.job_id_for(row))
        assert oib_sync.sync().failed == 1

        oib_sync.mark_for_reingest("a.pdf")

        assert oib_sync.sync().enqueued == 1

    def test_a_job_that_is_still_waiting_is_left_alone(self, ingestor):
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()

        oib_sync.mark_for_reingest("a.pdf")

        assert oib_sync.request_ingestion("a.pdf") is False
        assert _queued() == 1

    @pytest.mark.parametrize("name", ["ghost.pdf", "../a.pdf", "a.txt"])
    def test_a_name_that_is_not_in_the_corpus_is_false(self, ingestor, name):
        assert oib_sync.mark_for_reingest(name) is False


def test_the_job_id_is_a_function_of_name_hash_and_version(monkeypatch):
    row = corpus_store.FileRow("a.pdf", "base-corpus/a.pdf", _sha(b"a"), 1)
    same = corpus_store.FileRow("a.pdf", "base-corpus/a.pdf", _sha(b"a"), 1, ingested_sha256="x", failed_job_id="y")
    other_bytes = corpus_store.FileRow("a.pdf", "base-corpus/a.pdf", _sha(b"b"), 1)
    other_name = corpus_store.FileRow("b.pdf", "base-corpus/b.pdf", _sha(b"a"), 1)

    assert oib_sync.job_id_for(row) == oib_sync.job_id_for(same)
    assert len({oib_sync.job_id_for(r) for r in (row, other_bytes, other_name)}) == 3
    before = oib_sync.job_id_for(row)
    monkeypatch.setattr(oib_sync, "CHUNK_FORMAT_VERSION", oib_sync.CHUNK_FORMAT_VERSION + 1)
    assert oib_sync.job_id_for(row) != before
