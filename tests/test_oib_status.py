import hashlib
import json
from datetime import UTC
from datetime import datetime
from pathlib import Path

from aiq_agent import oib_status
from aiq_agent import oib_sync
from aiq_agent.knowledge.schema import CollectionInfo
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.oib_status import OibFileState


class FakeIngestor:
    def __init__(self, collection: CollectionInfo | None, files: list[FileInfo] | None = None) -> None:
        self.collection = collection
        self.files = files or []

    def get_collection(self, _name: str) -> CollectionInfo | None:
        return self.collection

    def list_files(self, _name: str) -> list[FileInfo]:
        return self.files


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _write_pdf(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _collection(chunk_count: int = 10) -> CollectionInfo:
    return CollectionInfo(
        name="test_collection",
        chunk_count=chunk_count,
        backend="fake",
        updated_at=datetime(2026, 7, 1, tzinfo=UTC),
    )


def _file_info(name: str, chunk_count: int) -> FileInfo:
    return FileInfo(
        file_id=name,
        file_name=name,
        collection_name="test_collection",
        status=FileStatus.SUCCESS,
        chunk_count=chunk_count,
        ingested_at=datetime(2026, 6, 30, tzinfo=UTC),
    )


def _configure(monkeypatch, tmp_path: Path) -> Path:
    oib_dir = tmp_path / "oib"
    oib_dir.mkdir(parents=True, exist_ok=True)
    registry_path = tmp_path / "oib_registry.json"
    monkeypatch.setattr(oib_sync, "OIB_DIR", oib_dir)
    monkeypatch.setattr(oib_sync, "OIB_UPLOADS_DIR", tmp_path / "oib_uploads")
    monkeypatch.setattr(oib_sync, "REGISTRY_PATH", registry_path)
    monkeypatch.setattr(oib_sync, "EXCLUDED_PATH", tmp_path / "oib_excluded.json")
    monkeypatch.setattr(oib_sync, "COLLECTION_NAME", "test_collection")
    monkeypatch.setattr(oib_status, "_load_summaries", lambda _name: {})
    monkeypatch.setattr(oib_status, "_HASH_CACHE", {})
    return registry_path


def test_status_classifies_ingested_stale_and_pending(monkeypatch, tmp_path):
    registry_path = _configure(monkeypatch, tmp_path)
    oib_dir = tmp_path / "oib"
    _write_pdf(oib_dir / "ingested.pdf", b"v1")
    _write_pdf(oib_dir / "stale.pdf", b"v2-new")
    _write_pdf(oib_dir / "pending.pdf", b"v3")
    registry_path.write_text(
        json.dumps(
            {
                str(oib_dir / "ingested.pdf"): _sha256(b"v1"),
                str(oib_dir / "stale.pdf"): _sha256(b"v2-old"),
            }
        ),
        encoding="utf-8",
    )
    ingestor = FakeIngestor(
        _collection(chunk_count=12),
        files=[_file_info("ingested.pdf", 8), _file_info("stale.pdf", 4)],
    )

    status = oib_status.get_status(ingestor=ingestor)

    by_name = {f.file_name: f for f in status.files}
    assert status.collection_exists is True
    assert status.collection_name == "test_collection"
    assert by_name["ingested.pdf"].state == OibFileState.INGESTED
    assert by_name["ingested.pdf"].chunk_count == 8
    assert by_name["ingested.pdf"].current_sha256 == _sha256(b"v1")
    assert by_name["stale.pdf"].state == OibFileState.STALE
    assert by_name["pending.pdf"].state == OibFileState.PENDING
    assert by_name["pending.pdf"].ingested_sha256 is None
    assert status.summary.total_files == 3
    assert status.summary.ingested == 1
    assert status.summary.stale == 1
    assert status.summary.pending == 1
    assert status.summary.total_chunks == 12


def test_status_flags_removed_and_inconsistent_files(monkeypatch, tmp_path):
    registry_path = _configure(monkeypatch, tmp_path)
    oib_dir = tmp_path / "oib"
    _write_pdf(oib_dir / "no_chunks.pdf", b"x")
    registry_path.write_text(
        json.dumps(
            {
                str(oib_dir / "no_chunks.pdf"): _sha256(b"x"),
                str(oib_dir / "deleted.pdf"): _sha256(b"gone"),
            }
        ),
        encoding="utf-8",
    )
    # "orphan.pdf" only exists in the collection; "deleted.pdf" only in the registry.
    ingestor = FakeIngestor(_collection(), files=[_file_info("orphan.pdf", 5)])

    status = oib_status.get_status(ingestor=ingestor)

    by_name = {f.file_name: f for f in status.files}
    assert by_name["no_chunks.pdf"].state == OibFileState.INCONSISTENT
    assert by_name["orphan.pdf"].state == OibFileState.REMOVED
    assert by_name["orphan.pdf"].chunk_count == 5
    assert by_name["orphan.pdf"].size_bytes is None
    assert by_name["deleted.pdf"].state == OibFileState.REMOVED
    assert by_name["deleted.pdf"].ingested_sha256 == _sha256(b"gone")
    assert status.summary.removed == 2
    assert status.summary.inconsistent == 1


def test_status_before_first_sync_reports_everything_pending(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    _write_pdf(tmp_path / "oib" / "a.pdf", b"a")
    _write_pdf(tmp_path / "oib" / "b.pdf", b"b")
    ingestor = FakeIngestor(collection=None)

    status = oib_status.get_status(ingestor=ingestor)

    assert status.collection_exists is False
    assert status.summary.total_files == 2
    assert status.summary.pending == 2
    assert status.summary.total_chunks == 0
    assert all(f.state == OibFileState.PENDING for f in status.files)


def test_status_attaches_document_summaries(monkeypatch, tmp_path):
    registry_path = _configure(monkeypatch, tmp_path)
    oib_dir = tmp_path / "oib"
    _write_pdf(oib_dir / "a.pdf", b"a")
    registry_path.write_text(json.dumps({str(oib_dir / "a.pdf"): _sha256(b"a")}), encoding="utf-8")
    monkeypatch.setattr(oib_status, "_load_summaries", lambda _name: {"a.pdf": ("Brandschutz basics.", None)})
    ingestor = FakeIngestor(_collection(), files=[_file_info("a.pdf", 3)])

    status = oib_status.get_status(ingestor=ingestor)

    assert status.files[0].summary == "Brandschutz basics."


def test_status_files_are_sorted_by_name(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    _write_pdf(tmp_path / "oib" / "z.pdf", b"z")
    _write_pdf(tmp_path / "oib" / "a.pdf", b"a")
    ingestor = FakeIngestor(_collection(), files=[])

    status = oib_status.get_status(ingestor=ingestor)

    assert [f.file_name for f in status.files] == ["a.pdf", "z.pdf"]


def test_sourceless_deployment_reports_snapshot_not_removed(monkeypatch, tmp_path):
    """A seed-restored deployment (index + registry, no PDFs) is healthy, not broken."""
    registry_path = _configure(monkeypatch, tmp_path)
    registry_path.write_text(
        json.dumps({"data/oib/a.pdf": _sha256(b"a"), "data/oib/b.pdf": _sha256(b"b")}),
        encoding="utf-8",
    )
    ingestor = FakeIngestor(_collection(chunk_count=10), files=[_file_info("a.pdf", 6), _file_info("b.pdf", 4)])

    status = oib_status.get_status(ingestor=ingestor)

    assert status.summary.snapshot == 2
    assert status.summary.removed == 0
    by_name = {f.file_name: f for f in status.files}
    assert by_name["a.pdf"].state == OibFileState.SNAPSHOT
    assert by_name["a.pdf"].origin == oib_status.OibFileOrigin.INDEX_ONLY
    assert by_name["a.pdf"].chunk_count == 6
    # Registry-only entries with no chunks are still 'removed' even here.
    registry_path.write_text(
        json.dumps({"data/oib/ghost.pdf": _sha256(b"ghost")}),
        encoding="utf-8",
    )
    status = oib_status.get_status(ingestor=FakeIngestor(_collection(), files=[]))
    assert {f.state for f in status.files} == {OibFileState.REMOVED}


def test_uploaded_documents_get_uploaded_origin(monkeypatch, tmp_path):
    registry_path = _configure(monkeypatch, tmp_path)
    uploads = tmp_path / "oib_uploads"
    _write_pdf(uploads / "custom.pdf", b"custom")
    _write_pdf(tmp_path / "oib" / "shipped.pdf", b"shipped")
    registry_path.write_text(
        json.dumps(
            {
                str(uploads / "custom.pdf"): _sha256(b"custom"),
                str(tmp_path / "oib" / "shipped.pdf"): _sha256(b"shipped"),
            }
        ),
        encoding="utf-8",
    )
    ingestor = FakeIngestor(_collection(), files=[_file_info("custom.pdf", 3), _file_info("shipped.pdf", 2)])

    status = oib_status.get_status(ingestor=ingestor)

    by_name = {f.file_name: f for f in status.files}
    assert by_name["custom.pdf"].origin == oib_status.OibFileOrigin.UPLOADED
    assert by_name["custom.pdf"].state == OibFileState.INGESTED
    assert by_name["shipped.pdf"].origin == oib_status.OibFileOrigin.CORPUS


def test_status_omits_excluded_files(monkeypatch, tmp_path):
    """A repo file removed via exclusion disappears from the status view even if
    its source still sits on disk and lingering chunks/registry entries remain."""
    registry_path = _configure(monkeypatch, tmp_path)
    oib_dir = tmp_path / "oib"
    _write_pdf(oib_dir / "excluded.pdf", b"gone")
    _write_pdf(oib_dir / "kept.pdf", b"here")
    registry_path.write_text(
        json.dumps(
            {
                str(oib_dir / "excluded.pdf"): _sha256(b"gone"),
                str(oib_dir / "kept.pdf"): _sha256(b"here"),
            }
        ),
        encoding="utf-8",
    )
    # Simulate a lagging chunk cleanup: the collection still reports the excluded file.
    (tmp_path / "oib_excluded.json").write_text(json.dumps(["excluded.pdf"]), encoding="utf-8")
    ingestor = FakeIngestor(_collection(), files=[_file_info("excluded.pdf", 3), _file_info("kept.pdf", 2)])

    status = oib_status.get_status(ingestor=ingestor)

    names = {f.file_name for f in status.files}
    assert names == {"kept.pdf"}


def test_disk_file_matching_registry_hash_under_other_path_counts_ingested(monkeypatch, tmp_path):
    """Seed registries record build-machine paths; same content on disk still verifies."""
    registry_path = _configure(monkeypatch, tmp_path)
    _write_pdf(tmp_path / "oib" / "a.pdf", b"a")
    registry_path.write_text(json.dumps({"/build/checkout/data/oib/a.pdf": _sha256(b"a")}), encoding="utf-8")
    ingestor = FakeIngestor(_collection(), files=[_file_info("a.pdf", 5)])

    status = oib_status.get_status(ingestor=ingestor)

    assert status.files[0].state == OibFileState.INGESTED


def test_hash_cache_avoids_rehashing_unchanged_files(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    pdf = tmp_path / "oib" / "a.pdf"
    _write_pdf(pdf, b"a")
    calls = []
    real_hash = oib_sync._file_hash
    monkeypatch.setattr(oib_sync, "_file_hash", lambda p: calls.append(p) or real_hash(p))
    ingestor = FakeIngestor(_collection(), files=[])

    oib_status.get_status(ingestor=ingestor)
    oib_status.get_status(ingestor=ingestor)

    assert len(calls) == 1
