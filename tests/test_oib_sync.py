import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

from aiq_agent import oib_sync
from aiq_agent.knowledge.schema import FileStatus


@dataclass
class FakeFileInfo:
    file_id: str
    file_name: str
    status: FileStatus
    file_size: int = 0
    chunk_count: int = 0
    error_message: str | None = None


class FakeIngestor:
    def __init__(self, terminal_statuses: dict[str, FileStatus], *, release_after_uploads: int = 1) -> None:
        self.terminal_statuses = terminal_statuses
        self.release_after_uploads = release_after_uploads
        self.uploaded: list[str] = []
        self.deleted: list[str] = []
        self.max_active = 0
        self._active: set[str] = set()
        self._ids_by_name: dict[str, str] = {}

    def get_collection(self, _name: str):
        return object()

    def upload_file(self, file_path: str, _collection_name: str) -> FakeFileInfo:
        file_name = Path(file_path).name
        file_id = f"file-{len(self.uploaded)}"
        self.uploaded.append(file_name)
        self._active.add(file_id)
        self._ids_by_name[file_name] = file_id
        self.max_active = max(self.max_active, len(self._active))
        return FakeFileInfo(file_id=file_id, file_name=file_name, status=FileStatus.INGESTING)

    def get_file_status(self, file_id: str, _collection_name: str) -> FakeFileInfo:
        if len(self.uploaded) < self.release_after_uploads:
            return FakeFileInfo(file_id=file_id, file_name=file_id, status=FileStatus.INGESTING)

        file_name = next(name for name, known_id in self._ids_by_name.items() if known_id == file_id)
        status = self.terminal_statuses[file_name]
        if status in (FileStatus.SUCCESS, FileStatus.FAILED):
            self._active.discard(file_id)
        return FakeFileInfo(
            file_id=file_id,
            file_name=file_name,
            status=status,
            chunk_count=3 if status == FileStatus.SUCCESS else 0,
            error_message="boom" if status == FileStatus.FAILED else None,
        )

    def delete_file(self, file_id: str, _collection_name: str) -> bool:
        self.deleted.append(file_id)
        return True


def _write_pdf(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _configure_sync(monkeypatch, tmp_path: Path, fake_ingestor: FakeIngestor, *, max_workers: str = "4") -> Path:
    oib_dir = tmp_path / "oib"
    registry_path = tmp_path / "oib_registry.json"
    monkeypatch.setattr(oib_sync, "OIB_DIR", oib_dir)
    monkeypatch.setattr(oib_sync, "OIB_UPLOADS_DIR", tmp_path / "oib_uploads")
    monkeypatch.setattr(oib_sync, "REGISTRY_PATH", registry_path)
    monkeypatch.setattr(oib_sync, "EXCLUDED_PATH", tmp_path / "oib_excluded.json")
    monkeypatch.setattr(oib_sync, "COLLECTION_NAME", "test_collection")
    monkeypatch.setattr(oib_sync, "CHROMA_DIR", str(tmp_path / "chroma"))
    monkeypatch.setattr(oib_sync, "_POLL_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(oib_sync, "_POLL_TIMEOUT_SECONDS", 30.0)
    monkeypatch.setattr(oib_sync, "_get_oib_ingestor", lambda: fake_ingestor)
    monkeypatch.setenv("OIB_SYNC_MAX_WORKERS", max_workers)
    return registry_path


def test_sync_submits_up_to_configured_worker_limit_and_updates_registry(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor(
        {
            "a.pdf": FileStatus.SUCCESS,
            "b.pdf": FileStatus.SUCCESS,
            "c.pdf": FileStatus.FAILED,
        },
        release_after_uploads=2,
    )
    registry_path = _configure_sync(monkeypatch, tmp_path, fake_ingestor, max_workers="2")
    _write_pdf(tmp_path / "oib" / "a.pdf", b"a")
    _write_pdf(tmp_path / "oib" / "b.pdf", b"b")
    _write_pdf(tmp_path / "oib" / "c.pdf", b"c")

    succeeded, total = oib_sync.sync()

    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    assert succeeded == 2
    assert total == 3
    assert fake_ingestor.max_active == 2
    assert fake_ingestor.uploaded == ["a.pdf", "b.pdf", "c.pdf"]
    assert str(tmp_path / "oib" / "a.pdf") in registry
    assert str(tmp_path / "oib" / "b.pdf") in registry
    assert str(tmp_path / "oib" / "c.pdf") not in registry


def test_sync_max_workers_one_keeps_sequential_submission(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor(
        {
            "a.pdf": FileStatus.SUCCESS,
            "b.pdf": FileStatus.SUCCESS,
        },
        release_after_uploads=1,
    )
    _configure_sync(monkeypatch, tmp_path, fake_ingestor, max_workers="1")
    _write_pdf(tmp_path / "oib" / "a.pdf", b"a")
    _write_pdf(tmp_path / "oib" / "b.pdf", b"b")

    succeeded, total = oib_sync.sync()

    assert succeeded == 2
    assert total == 2
    assert fake_ingestor.max_active == 1


def test_sync_logs_discovery_progress_and_outcomes(monkeypatch, tmp_path, caplog):
    fake_ingestor = FakeIngestor(
        {
            "a.pdf": FileStatus.SUCCESS,
            "b.pdf": FileStatus.FAILED,
        },
        release_after_uploads=2,
    )
    _configure_sync(monkeypatch, tmp_path, fake_ingestor, max_workers="2")
    _write_pdf(tmp_path / "oib" / "a.pdf", b"a")
    _write_pdf(tmp_path / "oib" / "b.pdf", b"b")

    with caplog.at_level(logging.INFO, logger="aiq_agent.oib_sync"):
        oib_sync.sync()

    assert "OIB sync discovery:" in caplog.text
    assert "Submitted OIB PDF" in caplog.text
    assert "OIB sync progress:" in caplog.text
    assert "OIB ingestion succeeded" in caplog.text
    assert "OIB ingestion failed" in caplog.text
    assert "OIB sync complete:" in caplog.text


@dataclass
class _CollectionInfoStub:
    """Minimal stand-in for CollectionInfo (only the fields sync() probes)."""

    chunk_count: int
    file_count: int


def test_sync_reingests_when_registry_full_but_collection_empty(monkeypatch, tmp_path):
    """Registry (data volume) says the PDF is ingested, but the vector store is a
    fresh/empty collection — e.g. after repointing at a new shared Chroma server.
    The registry is stale, so sync must re-ingest instead of skipping. Regression
    for the shared-Chroma migration leaving oib_knowledge empty."""
    fake_ingestor = FakeIngestor({"a.pdf": FileStatus.SUCCESS}, release_after_uploads=1)
    # Collection exists but is EMPTY (0 chunks) — the drifted-store signal.
    fake_ingestor.get_collection = lambda _name: _CollectionInfoStub(chunk_count=0, file_count=0)
    registry_path = _configure_sync(monkeypatch, tmp_path, fake_ingestor, max_workers="1")
    pdf = tmp_path / "oib" / "a.pdf"
    _write_pdf(pdf, b"a")
    # Pre-seed the registry with the file's CURRENT hash: without the self-heal,
    # the incremental diff would treat it as unchanged and skip it.
    registry_path.write_text(
        json.dumps({oib_sync._FORMAT_KEY: oib_sync.CHUNK_FORMAT_VERSION, str(pdf): oib_sync._file_hash(pdf)}),
        encoding="utf-8",
    )

    succeeded, total = oib_sync.sync()

    assert (succeeded, total) == (1, 1)
    assert fake_ingestor.uploaded == ["a.pdf"]  # re-ingested despite the matching hash


def test_sync_skips_when_registry_matches_and_collection_populated(monkeypatch, tmp_path):
    """The self-heal must NOT fire when the store already holds the corpus: a
    populated collection + matching registry hash still skips (no needless
    re-ingest, and no risk of wiping a good registry on a transient read)."""
    fake_ingestor = FakeIngestor({"a.pdf": FileStatus.SUCCESS}, release_after_uploads=1)
    fake_ingestor.get_collection = lambda _name: _CollectionInfoStub(chunk_count=42, file_count=1)
    registry_path = _configure_sync(monkeypatch, tmp_path, fake_ingestor, max_workers="1")
    pdf = tmp_path / "oib" / "a.pdf"
    _write_pdf(pdf, b"a")
    registry_path.write_text(
        json.dumps({oib_sync._FORMAT_KEY: oib_sync.CHUNK_FORMAT_VERSION, str(pdf): oib_sync._file_hash(pdf)}),
        encoding="utf-8",
    )

    succeeded, total = oib_sync.sync()

    assert (succeeded, total) == (0, 1)
    assert fake_ingestor.uploaded == []  # registry and store agree → nothing re-ingested


def test_discover_pdfs_dedupes_by_name_with_uploads_winning(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor({})
    _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    _write_pdf(tmp_path / "oib" / "a.pdf", b"repo")
    _write_pdf(tmp_path / "oib" / "b.pdf", b"repo-only")
    _write_pdf(tmp_path / "oib_uploads" / "a.pdf", b"uploaded-replacement")
    _write_pdf(tmp_path / "oib_uploads" / "c.pdf", b"upload-only")

    discovered = oib_sync.discover_pdfs()

    by_name = {p.name: p for p in discovered}
    assert sorted(by_name) == ["a.pdf", "b.pdf", "c.pdf"]
    assert by_name["a.pdf"] == tmp_path / "oib_uploads" / "a.pdf"


def test_ingest_single_success_updates_registry(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor({"new.pdf": FileStatus.SUCCESS})
    registry_path = _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    pdf = tmp_path / "oib_uploads" / "new.pdf"
    _write_pdf(pdf, b"fresh")

    result = oib_sync.ingest_single(pdf)

    assert result == FileStatus.SUCCESS
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    assert str(pdf) in registry
    assert fake_ingestor.uploaded == ["new.pdf"]
    # Existing chunks for the name are replaced before re-ingest.
    assert fake_ingestor.deleted == ["new.pdf"]


def test_ingest_single_failure_leaves_registry_untouched(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor({"bad.pdf": FileStatus.FAILED})
    registry_path = _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    pdf = tmp_path / "oib_uploads" / "bad.pdf"
    _write_pdf(pdf, b"broken")

    result = oib_sync.ingest_single(pdf)

    assert result == FileStatus.FAILED
    assert not registry_path.exists()


def test_remove_uploaded_document_deletes_disk_registry_and_chunks(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor({})
    registry_path = _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    pdf = tmp_path / "oib_uploads" / "custom.pdf"
    _write_pdf(pdf, b"x")
    registry_path.write_text(json.dumps({str(pdf): "hash"}), encoding="utf-8")

    assert oib_sync.remove_uploaded_document("custom.pdf") is True

    assert not pdf.exists()
    assert json.loads(registry_path.read_text(encoding="utf-8")) == {}
    assert fake_ingestor.deleted == ["custom.pdf"]
    # Repo-corpus files (or unknown names) are not removable.
    _write_pdf(tmp_path / "oib" / "shipped.pdf", b"y")
    assert oib_sync.remove_uploaded_document("shipped.pdf") is False
    assert oib_sync.remove_uploaded_document("../oib/shipped.pdf") is False


def test_exclude_document_skips_file_on_next_discover_and_sync(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor({"keep.pdf": FileStatus.SUCCESS})
    registry_path = _configure_sync(monkeypatch, tmp_path, fake_ingestor, max_workers="1")
    shipped = tmp_path / "oib" / "shipped.pdf"
    keep = tmp_path / "oib" / "keep.pdf"
    _write_pdf(shipped, b"shipped")
    _write_pdf(keep, b"keep")
    registry_path.write_text(json.dumps({str(shipped): "hash"}), encoding="utf-8")

    oib_sync.exclude_document("shipped.pdf")

    # Chunks deleted, registry entry dropped, basename recorded as excluded.
    assert fake_ingestor.deleted == ["shipped.pdf"]
    assert str(shipped) not in json.loads(registry_path.read_text(encoding="utf-8"))
    assert oib_sync._load_excluded() == {"shipped.pdf"}

    # Discovery no longer yields the excluded (still-on-disk) file.
    discovered = {p.name for p in oib_sync.discover_pdfs()}
    assert discovered == {"keep.pdf"}

    # A sync never re-ingests the excluded file.
    succeeded, total = oib_sync.sync()
    assert succeeded == 1
    assert total == 1
    assert fake_ingestor.uploaded == ["keep.pdf"]


def test_unexclude_document_restores_discovery(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor({})
    _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    shipped = tmp_path / "oib" / "shipped.pdf"
    _write_pdf(shipped, b"shipped")

    oib_sync.exclude_document("shipped.pdf")
    assert "shipped.pdf" not in {p.name for p in oib_sync.discover_pdfs()}

    assert oib_sync.unexclude_document("shipped.pdf") is True
    assert "shipped.pdf" in {p.name for p in oib_sync.discover_pdfs()}
    # Second call is a no-op.
    assert oib_sync.unexclude_document("shipped.pdf") is False


def test_uploaded_file_overrides_stale_exclusion(monkeypatch, tmp_path):
    """A physically present upload reappears even if its basename is excluded —
    the self-heal for corpora uploaded before the upload path lifted exclusions."""
    fake_ingestor = FakeIngestor({})
    _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    # Same basename exists both as a repo-shipped file and as an admin upload,
    # and is on the exclusion list from a prior delete.
    _write_pdf(tmp_path / "oib" / "shipped.pdf", b"repo")
    _write_pdf(tmp_path / "oib_uploads" / "shipped.pdf", b"upload")
    oib_sync._save_excluded({"shipped.pdf"})

    discovered = oib_sync.discover_pdfs()
    names = {p.name for p in discovered}
    # The upload overrides the exclusion → discovery surfaces it again...
    assert "shipped.pdf" in names
    # ...resolving to the upload copy, not the still-excluded repo copy.
    path = next(p for p in discovered if p.name == "shipped.pdf")
    assert path == tmp_path / "oib_uploads" / "shipped.pdf"


def test_excluded_repo_file_without_upload_stays_hidden(monkeypatch, tmp_path):
    """The override is upload-only: a repo-shipped file with no upload copy stays
    excluded, preserving delete semantics for the git-tracked corpus."""
    fake_ingestor = FakeIngestor({})
    _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    _write_pdf(tmp_path / "oib" / "shipped.pdf", b"repo")
    oib_sync._save_excluded({"shipped.pdf"})
    assert "shipped.pdf" not in {p.name for p in oib_sync.discover_pdfs()}


def test_prune_excluded_uploads_drops_only_present_uploads(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor({})
    _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    _write_pdf(tmp_path / "oib_uploads" / "a.pdf", b"a")
    # 'a.pdf' now exists as an upload; 'gone.pdf' does not.
    oib_sync._save_excluded({"a.pdf", "gone.pdf"})

    oib_sync._prune_excluded_uploads()

    # Only the name backed by a real upload is dropped; the other stays excluded.
    assert oib_sync._load_excluded() == {"gone.pdf"}


def test_remove_document_routes_uploaded_to_delete_and_repo_to_exclude(monkeypatch, tmp_path):
    fake_ingestor = FakeIngestor({})
    registry_path = _configure_sync(monkeypatch, tmp_path, fake_ingestor)
    uploaded = tmp_path / "oib_uploads" / "custom.pdf"
    shipped = tmp_path / "oib" / "shipped.pdf"
    _write_pdf(uploaded, b"custom")
    _write_pdf(shipped, b"shipped")
    registry_path.write_text(json.dumps({str(uploaded): "h1", str(shipped): "h2"}), encoding="utf-8")

    # Uploaded → physical delete.
    assert oib_sync.remove_document("custom.pdf") == "deleted"
    assert not uploaded.exists()
    assert oib_sync._load_excluded() == set()

    # Repo-shipped → exclusion (file stays on disk but drops out of the corpus).
    assert oib_sync.remove_document("shipped.pdf") == "excluded"
    assert shipped.exists()
    assert oib_sync._load_excluded() == {"shipped.pdf"}
    assert "shipped.pdf" not in {p.name for p in oib_sync.discover_pdfs()}

    # Unknown name and path traversal → no-op None.
    assert oib_sync.remove_document("nope.pdf") is None
    assert oib_sync.remove_document("../oib/shipped.pdf") is None


class TestChunkFormatVersionGate:
    """A chunk-format bump forces exactly one automatic full re-ingest."""

    def _setup(self, tmp_path, monkeypatch, registry: dict):
        import json

        from aiq_agent import oib_sync

        reg_path = tmp_path / "oib_registry.json"
        reg_path.write_text(json.dumps(registry), encoding="utf-8")
        monkeypatch.setattr(oib_sync, "REGISTRY_PATH", reg_path)
        return oib_sync, reg_path

    def test_missing_version_forces_full_reingest(self, tmp_path, monkeypatch):
        import json

        oib_sync, reg_path = self._setup(tmp_path, monkeypatch, {"/data/oib/a.pdf": "oldhash"})
        registry = oib_sync._load_registry()
        assert registry and registry.get(oib_sync._FORMAT_KEY) != oib_sync.CHUNK_FORMAT_VERSION
        # replicate the sync() gate
        registry = {} if registry.get(oib_sync._FORMAT_KEY) != oib_sync.CHUNK_FORMAT_VERSION else registry
        registry.setdefault(oib_sync._FORMAT_KEY, oib_sync.CHUNK_FORMAT_VERSION)
        oib_sync._save_registry(registry)
        stored = json.loads(reg_path.read_text())
        assert stored == {oib_sync._FORMAT_KEY: oib_sync.CHUNK_FORMAT_VERSION}  # hashes dropped -> all files re-ingest

    def test_stamped_registry_is_untouched(self, tmp_path, monkeypatch):
        from aiq_agent import oib_sync as osync

        registry_content = {"__chunk_format_version__": osync.CHUNK_FORMAT_VERSION, "/data/oib/a.pdf": "hash1"}
        oib_sync, _ = self._setup(tmp_path, monkeypatch, registry_content)
        registry = oib_sync._load_registry()
        assert registry.get(oib_sync._FORMAT_KEY) == oib_sync.CHUNK_FORMAT_VERSION
        assert registry["/data/oib/a.pdf"] == "hash1"  # hash-gating still skips unchanged files

    def test_status_ignores_reserved_key(self, tmp_path, monkeypatch):
        from aiq_agent import oib_status
        from aiq_agent import oib_sync as osync

        oib_sync, _ = self._setup(tmp_path, monkeypatch, {"__chunk_format_version__": osync.CHUNK_FORMAT_VERSION})
        monkeypatch.setattr(osync, "OIB_DIR", tmp_path / "none")
        monkeypatch.setattr(osync, "OIB_UPLOADS_DIR", tmp_path / "none2")

        class _NoopIngestor:
            def get_collection(self, name):
                return None

            def list_files(self, name):
                return []

        status = oib_status.get_status(ingestor=_NoopIngestor())
        assert all(e.file_name != "__chunk_format_version__" for e in status.files)


class TestConcurrentCorpusMutations:
    """The admin executor runs >1 worker, so a sync, an upload and a removal can
    overlap. These guard the serialization that keeps that safe: a single-flight
    sync, per-basename locks around every corpus mutation, and read-modify-write
    of the registry / exclusion set strictly inside their locks.
    """

    class _BlockingIngestor(FakeIngestor):
        """Parks every status poll until ``release`` is set."""

        def __init__(self, terminal_statuses, *, polled, release) -> None:
            super().__init__(terminal_statuses)
            self.polled = polled
            self.release = release

        def get_file_status(self, file_id: str, collection_name: str) -> FakeFileInfo:
            self.polled.set()
            assert self.release.wait(10)
            return super().get_file_status(file_id, collection_name)

    def test_ingest_single_holds_the_file_lock_until_the_terminal_state(self, monkeypatch, tmp_path):
        polled, release = threading.Event(), threading.Event()
        ingestor = self._BlockingIngestor({"busy.pdf": FileStatus.SUCCESS}, polled=polled, release=release)
        _configure_sync(monkeypatch, tmp_path, ingestor)
        pdf = tmp_path / "oib_uploads" / "busy.pdf"
        _write_pdf(pdf, b"busy")

        worker = threading.Thread(target=oib_sync.ingest_single, args=(pdf,), daemon=True)
        worker.start()
        try:
            assert polled.wait(10)
            # A concurrent removal/sync of the same basename blocks here instead
            # of interleaving with the delete → upload → poll cycle.
            assert oib_sync._file_lock("busy.pdf").acquire(blocking=False) is False
        finally:
            release.set()
        worker.join(10)

        assert not worker.is_alive()
        lock = oib_sync._file_lock("busy.pdf")
        assert lock.acquire(blocking=False) is True
        lock.release()

    def test_sync_is_single_flight(self, monkeypatch, tmp_path):
        polled, release = threading.Event(), threading.Event()
        ingestor = self._BlockingIngestor({"a.pdf": FileStatus.SUCCESS}, polled=polled, release=release)
        _configure_sync(monkeypatch, tmp_path, ingestor, max_workers="1")
        _write_pdf(tmp_path / "oib" / "a.pdf", b"a")

        results: list[tuple[int, int]] = []
        first = threading.Thread(target=lambda: results.append(oib_sync.sync()), daemon=True)
        first.start()
        second = None
        try:
            assert polled.wait(10)
            assert oib_sync._SYNC_LOCK.locked() is True
            second = threading.Thread(target=lambda: results.append(oib_sync.sync()), daemon=True)
            second.start()
            # The second sync waits for the first instead of ingesting the same
            # work list a second time.
            second.join(0.2)
            assert second.is_alive()
        finally:
            release.set()
        first.join(10)
        second.join(10)

        assert not first.is_alive() and not second.is_alive()
        assert ingestor.uploaded == ["a.pdf"]
        # First run ingested the file; the second found nothing new.
        assert results == [(1, 1), (0, 1)]
        assert oib_sync._file_lock("a.pdf").acquire(blocking=False) is True
        oib_sync._file_lock("a.pdf").release()

    def test_sync_merges_a_registry_hash_written_while_it_ran(self, monkeypatch, tmp_path):
        other_key = "/elsewhere/other.pdf"

        class _ConcurrentWriterIngestor(FakeIngestor):
            """Emulates another ingestion recording its hash mid-sync."""

            def get_file_status(self, file_id: str, collection_name: str) -> FakeFileInfo:
                info = super().get_file_status(file_id, collection_name)
                if info.status == FileStatus.SUCCESS:
                    with oib_sync._REGISTRY_LOCK:
                        registry = oib_sync._load_registry()
                        registry[other_key] = "other-hash"
                        oib_sync._save_registry(registry)
                return info

        ingestor = _ConcurrentWriterIngestor({"a.pdf": FileStatus.SUCCESS})
        registry_path = _configure_sync(monkeypatch, tmp_path, ingestor, max_workers="1")
        pdf = tmp_path / "oib" / "a.pdf"
        _write_pdf(pdf, b"a")

        assert oib_sync.sync() == (1, 1)

        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        # sync() reloads inside the lock, so its stale snapshot cannot clobber
        # the hash the concurrent ingestion recorded.
        assert registry[other_key] == "other-hash"
        assert str(pdf) in registry

    def test_exclusion_set_is_written_inside_its_lock(self, monkeypatch, tmp_path):
        _configure_sync(monkeypatch, tmp_path, FakeIngestor({}))
        _write_pdf(tmp_path / "oib" / "shipped.pdf", b"shipped")

        held: list[bool] = []
        real_save = oib_sync._save_excluded

        def spy(names: set[str]) -> None:
            held.append(oib_sync._EXCLUDED_LOCK.locked())
            real_save(names)

        monkeypatch.setattr(oib_sync, "_save_excluded", spy)

        oib_sync.exclude_document("shipped.pdf")
        assert oib_sync.unexclude_document("shipped.pdf") is True

        # Both read-modify-writes ran inside the critical section; outside it a
        # concurrent removal could drop the other's basename.
        assert held == [True, True]
