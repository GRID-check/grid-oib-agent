"""Ingestion of the base corpus: what needs it, how it runs, what it records (ADR-0082, step A2).

The corpus is a real table (SQLite, or Postgres when ``GRID_TEST_CORPUS_DB`` is set) and a
fake bucket (``tests/object_corpus_fakes``); the vector store is a fake ingestor.
"""

from __future__ import annotations

import contextlib
import hashlib
import logging
import threading
from dataclasses import dataclass

import pytest

from aiq_agent import corpus_store
from aiq_agent import oib_sync
from aiq_agent.knowledge.schema import FileStatus
from tests.object_corpus_fakes import FakeBucket
from tests.object_corpus_fakes import install


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class FakeFileInfo:
    file_id: str
    file_name: str
    status: FileStatus
    chunk_count: int = 0
    error_message: str | None = None


@dataclass
class FakeCollection:
    chunk_count: int = 1
    file_count: int = 1


class FakeIngestor:
    """Uploads are held INGESTING until ``release_after_uploads`` have been made, then reach their terminal status."""

    def __init__(self, terminal: dict[str, FileStatus] | None = None, *, release_after_uploads: int = 1) -> None:
        self.terminal = terminal or {}
        self.release_after_uploads = release_after_uploads
        self.uploaded: list[str] = []
        self.deleted: list[str] = []
        self.indexed: set[str] = set()
        self.collection: FakeCollection | None = FakeCollection()
        self.max_active = 0
        self.gate: threading.Event | None = None
        self.fail_upload_of: set[str] = set()
        self.on_upload = None
        self._active: set[str] = set()
        self._names: dict[str, str] = {}
        self._lock = threading.Lock()

    def get_collection(self, _name: str):
        return self.collection

    def create_collection(self, name: str, description: str = "") -> None:
        self.collection = FakeCollection()

    def list_files(self, _collection: str):
        return [FakeFileInfo(file_id=n, file_name=n, status=FileStatus.SUCCESS) for n in sorted(self.indexed)]

    def upload_file(self, file_path: str, _collection: str) -> FakeFileInfo:
        name = file_path.rsplit("/", 1)[-1]
        if name in self.fail_upload_of:
            raise RuntimeError(f"cannot read {name}")
        with self._lock:
            file_id = f"file-{len(self.uploaded)}"
            self.uploaded.append(name)
            self._active.add(file_id)
            self._names[file_id] = name
            self.max_active = max(self.max_active, len(self._active))
        if self.on_upload is not None:
            self.on_upload(name)
        return FakeFileInfo(file_id=file_id, file_name=name, status=FileStatus.INGESTING)

    def get_file_status(self, file_id: str, _collection: str) -> FakeFileInfo:
        if self.gate is not None:
            self.gate.wait(timeout=10)
        name = self._names[file_id]
        with self._lock:
            held = len(self.uploaded) < self.release_after_uploads
        if held:
            return FakeFileInfo(file_id=file_id, file_name=name, status=FileStatus.INGESTING)
        status = self.terminal.get(name, FileStatus.SUCCESS)
        if status == FileStatus.INGESTING:
            return FakeFileInfo(file_id=file_id, file_name=name, status=status)
        with self._lock:
            self._active.discard(file_id)
        if status == FileStatus.SUCCESS:
            self.indexed.add(name)
        return FakeFileInfo(
            file_id=file_id,
            file_name=name,
            status=status,
            chunk_count=3 if status == FileStatus.SUCCESS else 0,
            error_message="boom" if status == FileStatus.FAILED else None,
        )

    def delete_file(self, name: str, _collection: str) -> bool:
        self.deleted.append(name)
        self.indexed.discard(name)
        return True


@pytest.fixture
def bucket(monkeypatch, tmp_path) -> FakeBucket:
    monkeypatch.setattr(oib_sync, "COLLECTION_NAME", "test_collection")
    monkeypatch.setattr(oib_sync, "_POLL_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(oib_sync, "_POLL_TIMEOUT_SECONDS", 30.0)
    monkeypatch.setenv("OIB_SYNC_MAX_WORKERS", "4")
    return install(monkeypatch, tmp_path)


@pytest.fixture
def summaries(monkeypatch) -> list[str]:
    unregistered: list[str] = []
    monkeypatch.setattr(oib_sync, "unregister_summary", lambda _collection, name: unregistered.append(name))
    return unregistered


def _ingestor(monkeypatch, **kwargs) -> FakeIngestor:
    ingestor = FakeIngestor(**kwargs)
    monkeypatch.setattr(oib_sync, "_get_oib_ingestor", lambda: ingestor)
    return ingestor


def _row(name: str) -> corpus_store.FileRow:
    row = corpus_store.get_file(name)
    assert row is not None
    return row


class TestSync:
    def test_ingests_what_needs_it_and_records_a_hash_only_for_what_succeeded(self, bucket, monkeypatch):
        ingestor = _ingestor(
            monkeypatch,
            terminal={"a.pdf": FileStatus.SUCCESS, "b.pdf": FileStatus.SUCCESS, "c.pdf": FileStatus.FAILED},
            release_after_uploads=2,
        )
        for name in ("a.pdf", "b.pdf", "c.pdf"):
            corpus_store.put(name, name.encode())

        result = oib_sync.sync()

        assert result == oib_sync.SyncResult(ingested=2, failed=1, total=3)
        assert sorted(ingestor.uploaded) == ["a.pdf", "b.pdf", "c.pdf"]
        for name in ("a.pdf", "b.pdf"):
            assert _row(name).ingested_sha256 == _sha(name.encode())
            assert _row(name).chunk_format_version == oib_sync.CHUNK_FORMAT_VERSION
        assert _row("c.pdf").ingested_sha256 is None  # retried by the next cycle

    def test_a_file_that_is_current_is_not_ingested_again(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()

        result = oib_sync.sync()

        assert result == oib_sync.SyncResult(ingested=0, failed=0, total=1)
        assert ingestor.uploaded == ["a.pdf"]

    def test_a_failed_file_is_retried_by_the_next_cycle(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch, terminal={"a.pdf": FileStatus.FAILED})
        corpus_store.put("a.pdf", b"a")
        assert oib_sync.sync().failed == 1

        ingestor.terminal["a.pdf"] = FileStatus.SUCCESS
        result = oib_sync.sync()

        assert result.ingested == 1
        assert ingestor.uploaded == ["a.pdf", "a.pdf"]

    def test_a_replaced_file_is_ingested_again(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"v1")
        oib_sync.sync()

        corpus_store.put("a.pdf", b"version two")
        result = oib_sync.sync()

        assert result.ingested == 1
        assert ingestor.uploaded == ["a.pdf", "a.pdf"]
        assert _row("a.pdf").ingested_sha256 == _sha(b"version two")

    def test_a_new_chunk_format_reingests_the_whole_corpus_through_the_same_rule(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")
        corpus_store.put("b.pdf", b"b")
        oib_sync.sync()
        assert len(ingestor.uploaded) == 2

        monkeypatch.setattr(oib_sync, "CHUNK_FORMAT_VERSION", oib_sync.CHUNK_FORMAT_VERSION + 1)
        result = oib_sync.sync()

        assert result.ingested == 2
        assert len(ingestor.uploaded) == 4
        assert _row("a.pdf").chunk_format_version == oib_sync.CHUNK_FORMAT_VERSION

    def test_a_reset_vector_store_is_filled_again(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()
        ingestor.collection = None  # Chroma wiped or repointed; the table still says "ingested"

        result = oib_sync.sync()

        assert result.ingested == 1
        assert ingestor.uploaded == ["a.pdf", "a.pdf"]

    def test_a_vector_store_that_cannot_be_probed_does_not_discard_what_the_table_knows(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")
        oib_sync.sync()

        def unreachable(_name):
            raise ConnectionError("chroma is down")

        monkeypatch.setattr(ingestor, "get_collection", unreachable)

        assert oib_sync.sync().ingested == 0
        assert _row("a.pdf").ingested_sha256 == _sha(b"a")

    def test_an_empty_corpus_is_a_cycle_that_does_nothing(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)

        assert oib_sync.sync() == oib_sync.SyncResult(ingested=0, failed=0, total=0)
        assert ingestor.uploaded == []

    def test_the_worker_limit_bounds_concurrent_ingestions(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch, release_after_uploads=2)
        monkeypatch.setenv("OIB_SYNC_MAX_WORKERS", "2")
        for name in ("a.pdf", "b.pdf", "c.pdf"):
            corpus_store.put(name, name.encode())

        assert oib_sync.sync().ingested == 3

        assert ingestor.max_active == 2

    def test_one_worker_ingests_one_file_at_a_time(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        monkeypatch.setenv("OIB_SYNC_MAX_WORKERS", "1")
        for name in ("a.pdf", "b.pdf"):
            corpus_store.put(name, name.encode())

        assert oib_sync.sync().ingested == 2

        assert ingestor.max_active == 1

    def test_a_file_that_raises_fails_alone(self, bucket, monkeypatch, caplog):
        ingestor = _ingestor(monkeypatch)
        ingestor.fail_upload_of = {"b.pdf"}
        for name in ("a.pdf", "b.pdf", "c.pdf"):
            corpus_store.put(name, name.encode())

        with caplog.at_level(logging.ERROR, logger="aiq_agent.oib_sync"):
            result = oib_sync.sync()

        assert result == oib_sync.SyncResult(ingested=2, failed=1, total=3)
        assert _row("b.pdf").ingested_sha256 is None
        assert "b.pdf" in caplog.text

    def test_the_cycle_logs_what_it_found_and_what_it_did(self, bucket, monkeypatch, caplog):
        _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")

        with caplog.at_level(logging.INFO, logger="aiq_agent.oib_sync"):
            oib_sync.sync()

        assert "total=1 needing_ingestion=1" in caplog.text
        assert "succeeded=1 failed=0 total=1" in caplog.text

    def test_a_file_fetched_from_the_object_store_is_what_gets_ingested(self, bucket, monkeypatch, tmp_path):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"alpha")
        (tmp_path / "cache" / "a.pdf").unlink()  # this replica never held it
        seen: dict[str, bytes] = {}
        ingestor.on_upload = lambda name: seen.update({name: (tmp_path / "cache" / name).read_bytes()})

        oib_sync.sync()

        assert seen == {"a.pdf": b"alpha"}
        assert bucket.downloads == ["base-corpus/a.pdf"]


class TestLocks:
    def test_a_sync_cycle_holds_the_cross_replica_lock(self, bucket, monkeypatch):
        _ingestor(monkeypatch)
        held: list[str] = []

        @contextlib.contextmanager
        def recording(key):
            held.append(key)
            yield

        monkeypatch.setattr(oib_sync, "keyed_lock", recording)
        corpus_store.put("a.pdf", b"a")

        oib_sync.sync()

        assert held == ["oib-sync", "oib-file:a.pdf"]

    def test_a_second_cycle_waits_for_the_running_one_and_finds_nothing_to_do(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        ingestor.gate = threading.Event()
        corpus_store.put("a.pdf", b"a")
        results: list[oib_sync.SyncResult] = []
        first = threading.Thread(target=lambda: results.append(oib_sync.sync()), daemon=True)
        first.start()
        while not ingestor.uploaded:
            first.join(0.01)
        second = threading.Thread(target=lambda: results.append(oib_sync.sync()), daemon=True)
        second.start()
        second.join(0.2)
        assert second.is_alive()  # parked behind the first cycle

        ingestor.gate.set()
        first.join(10)
        second.join(10)

        assert sorted(r.ingested for r in results) == [0, 1]
        assert ingestor.uploaded == ["a.pdf"]

    def test_two_ingestions_of_one_file_run_one_after_the_other_and_the_second_finds_it_done(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        ingestor.gate = threading.Event()
        corpus_store.put("a.pdf", b"a")
        statuses: list[FileStatus | None] = []
        threads = [threading.Thread(target=lambda: statuses.append(oib_sync.ingest_single("a.pdf")), daemon=True)]
        threads[0].start()
        while not ingestor.uploaded:
            threads[0].join(0.01)
        threads.append(threading.Thread(target=lambda: statuses.append(oib_sync.ingest_single("a.pdf")), daemon=True))
        threads[1].start()

        ingestor.gate.set()
        for thread in threads:
            thread.join(10)

        assert statuses == [FileStatus.SUCCESS, FileStatus.SUCCESS]
        assert ingestor.uploaded == ["a.pdf"]

    def test_a_delete_waits_for_a_running_ingestion_of_the_same_file(self, bucket, monkeypatch, summaries):
        ingestor = _ingestor(monkeypatch)
        ingestor.gate = threading.Event()
        corpus_store.put("a.pdf", b"a")
        ingesting = threading.Thread(target=oib_sync.ingest_single, args=("a.pdf",), daemon=True)
        ingesting.start()
        while not ingestor.uploaded:
            ingesting.join(0.01)
        removed: list[bool] = []
        deleting = threading.Thread(target=lambda: removed.append(oib_sync.remove_document("a.pdf")), daemon=True)
        deleting.start()
        deleting.join(0.2)
        assert deleting.is_alive()  # the ingestion still holds the file

        ingestor.gate.set()
        ingesting.join(10)
        deleting.join(10)

        assert removed == [True]
        assert corpus_store.get_file("a.pdf") is None


class TestIngestSingle:
    def test_success_records_the_hash_and_the_pipeline_version(self, bucket, monkeypatch):
        _ingestor(monkeypatch)
        corpus_store.put("new.pdf", b"new")

        assert oib_sync.ingest_single("new.pdf") == FileStatus.SUCCESS

        assert _row("new.pdf").ingested_sha256 == _sha(b"new")
        assert _row("new.pdf").chunk_format_version == oib_sync.CHUNK_FORMAT_VERSION

    def test_a_file_the_index_was_built_from_is_not_uploaded_again(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")
        oib_sync.ingest_single("a.pdf")

        assert oib_sync.ingest_single("a.pdf") == FileStatus.SUCCESS

        assert ingestor.uploaded == ["a.pdf"]

    def test_a_failure_records_nothing(self, bucket, monkeypatch):
        _ingestor(monkeypatch, terminal={"bad.pdf": FileStatus.FAILED})
        corpus_store.put("bad.pdf", b"bad")

        assert oib_sync.ingest_single("bad.pdf") == FileStatus.FAILED

        assert _row("bad.pdf").ingested_sha256 is None

    def test_a_timeout_is_none_and_records_nothing(self, bucket, monkeypatch):
        _ingestor(monkeypatch, terminal={"slow.pdf": FileStatus.INGESTING})
        monkeypatch.setattr(oib_sync, "_POLL_TIMEOUT_SECONDS", 0.05)
        corpus_store.put("slow.pdf", b"slow")

        assert oib_sync.ingest_single("slow.pdf") is None

        assert _row("slow.pdf").ingested_sha256 is None

    def test_a_file_replaced_while_it_ingested_still_needs_ingestion(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"v1")
        ingestor.on_upload = lambda name: corpus_store.put(name, b"version two")

        assert oib_sync.ingest_single("a.pdf") == FileStatus.SUCCESS

        row = _row("a.pdf")
        assert row.sha256 == _sha(b"version two")
        assert row.ingested_sha256 is None
        assert row.needs_ingestion(oib_sync.CHUNK_FORMAT_VERSION)

    def test_a_file_that_left_the_corpus_is_a_lookup_error(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)

        with pytest.raises(LookupError, match="ghost.pdf"):
            oib_sync.ingest_single("ghost.pdf")

        assert ingestor.uploaded == []

    def test_a_listed_file_that_cannot_be_fetched_is_a_store_error(self, bucket, monkeypatch, tmp_path):
        _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")
        (tmp_path / "cache" / "a.pdf").unlink()
        bucket.objects.clear()

        with pytest.raises(corpus_store.CorpusStoreError):
            oib_sync.ingest_single("a.pdf")


class TestRemoveDocument:
    def test_deletes_chunks_summary_row_object_and_cached_copy(self, bucket, monkeypatch, summaries, tmp_path):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("custom.pdf", b"custom")
        oib_sync.ingest_single("custom.pdf")

        assert oib_sync.remove_document("custom.pdf") is True

        assert ingestor.deleted == ["custom.pdf"]
        assert summaries == ["custom.pdf"]
        assert corpus_store.get_file("custom.pdf") is None
        assert bucket.objects == {}
        assert not (tmp_path / "cache" / "custom.pdf").exists()
        assert "custom.pdf" not in ingestor.indexed

    def test_a_deleted_file_is_not_ingested_by_the_next_cycle(self, bucket, monkeypatch, summaries):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("custom.pdf", b"custom")
        oib_sync.remove_document("custom.pdf")

        assert oib_sync.sync().total == 0
        assert ingestor.uploaded == []

    def test_a_name_only_the_index_knows_is_cleared_too(self, bucket, monkeypatch, summaries):
        ingestor = _ingestor(monkeypatch)
        ingestor.indexed.add("leftover.pdf")

        assert oib_sync.remove_document("leftover.pdf") is True

        assert ingestor.deleted == ["leftover.pdf"]
        assert "leftover.pdf" not in ingestor.indexed

    @pytest.mark.parametrize("name", ["nope.pdf", "../oib/shipped.pdf", "notes.txt", ""])
    def test_an_unknown_or_unsafe_name_is_false_and_touches_nothing(self, bucket, monkeypatch, summaries, name):
        ingestor = _ingestor(monkeypatch)

        assert oib_sync.remove_document(name) is False

        assert ingestor.deleted == [] and summaries == [] and bucket.deletes == []

    def test_a_failed_chunk_delete_keeps_the_document_listed_so_a_retry_finds_it(self, bucket, monkeypatch, summaries):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("custom.pdf", b"custom")

        def fail(_name, _collection):
            raise RuntimeError("chroma is down")

        monkeypatch.setattr(ingestor, "delete_file", fail)

        with pytest.raises(RuntimeError):
            oib_sync.remove_document("custom.pdf")

        assert corpus_store.get_file("custom.pdf") is not None
        assert bucket.objects  # the object is still there

    def test_an_object_the_store_cannot_delete_is_an_error_after_the_chunks_are_gone(
        self, bucket, monkeypatch, summaries
    ):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("custom.pdf", b"custom")

        def refuse(_name):
            raise corpus_store.CorpusStoreError("delete of custom.pdf from the object store was refused (HTTP 500)")

        monkeypatch.setattr(corpus_store, "_delete_object", refuse)

        with pytest.raises(corpus_store.CorpusStoreError):
            oib_sync.remove_document("custom.pdf")

        assert ingestor.deleted == ["custom.pdf"]
        assert corpus_store.get_file("custom.pdf") is None


class TestMarkForReingest:
    def test_forgets_what_the_index_was_built_from_so_the_file_reads_as_pending(self, bucket, monkeypatch):
        _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")
        oib_sync.ingest_single("a.pdf")

        assert oib_sync.mark_for_reingest("a.pdf") is True

        assert _row("a.pdf").ingested_sha256 is None

    def test_the_file_is_then_ingested_again(self, bucket, monkeypatch):
        ingestor = _ingestor(monkeypatch)
        corpus_store.put("a.pdf", b"a")
        oib_sync.ingest_single("a.pdf")
        oib_sync.mark_for_reingest("a.pdf")

        assert oib_sync.ingest_single("a.pdf") == FileStatus.SUCCESS

        assert ingestor.uploaded == ["a.pdf", "a.pdf"]

    @pytest.mark.parametrize("name", ["ghost.pdf", "../a.pdf", "a.txt"])
    def test_a_name_that_is_not_in_the_corpus_is_false(self, bucket, monkeypatch, name):
        _ingestor(monkeypatch)

        assert oib_sync.mark_for_reingest(name) is False


class TestWorkerSetting:
    @pytest.mark.parametrize(("raw", "expected"), [("3", 3), ("0", 1), ("-2", 1), ("many", 4)])
    def test_the_worker_count_is_clamped_and_falls_back(self, monkeypatch, raw, expected):
        monkeypatch.setenv("OIB_SYNC_MAX_WORKERS", raw)
        assert oib_sync._get_max_workers() == expected
