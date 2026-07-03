# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import logging
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
    monkeypatch.setattr(oib_sync, "REGISTRY_PATH", registry_path)
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
