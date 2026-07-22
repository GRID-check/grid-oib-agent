"""Tests for the OIB base-corpus admin routes (Phase B).

Covers the non-blocking upload (explicit + guessed doc_class, invalid → 400),
safe ZIP extraction (happy path + zip-slip + non-pdf skip), and the reclassify
PATCH endpoint (updates / validates / 404). Uses a tmp-sqlite summary store and
a fake ``oib_sync.ingest_single`` so ingestion is fast and deterministic.
"""

import io
import tempfile
import time
import zipfile
from pathlib import Path

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent import oib_sync
from aiq_agent.knowledge.factory import configure_summary_db
from aiq_agent.knowledge.factory import register_summary
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.summary_store import SummaryStore
from aiq_api.routes.oib import add_oib_routes

_COLLECTION = "oib_knowledge"


@pytest.fixture
def summary_db():
    # ignore_cleanup_errors: the SQLite engine's connection (and its -wal/-shm
    # sidecar files) may not be released the instant the fixture tears down, so
    # rmtree can hit a transient "Directory not empty". Tolerate it rather than
    # let a teardown race fail an otherwise-passing test (seen flaky on py3.13).
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'oib.db'}"
        SummaryStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)
        yield db_url


@pytest.fixture
def store(summary_db):
    return SummaryStore(summary_db)


@pytest.fixture
def uploads_dir(tmp_path, monkeypatch):
    """Point the uploads dir at tmp and stub ingestion to register a row + SUCCESS."""
    up = tmp_path / "oib_uploads"
    monkeypatch.setattr(oib_sync, "OIB_UPLOADS_DIR", up)
    monkeypatch.setattr(oib_sync, "COLLECTION_NAME", _COLLECTION)

    def fake_ingest_single(pdf: Path):
        # Mimic the real ingest: it creates the summary row for the file.
        register_summary(_COLLECTION, pdf.name, f"summary of {pdf.name}")
        return FileStatus.SUCCESS

    monkeypatch.setattr(oib_sync, "ingest_single", fake_ingest_single)
    return up


@pytest.fixture
def app(summary_db, uploads_dir):
    app = FastAPI()
    router = APIRouter()
    add_oib_routes(router)
    app.include_router(router)
    return app


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _wait_for_doc_class(store, name, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        dc = store.get_doc_class(_COLLECTION, name)
        if dc is not None:
            return dc
        time.sleep(0.02)
    return store.get_doc_class(_COLLECTION, name)


def _pdf_bytes(marker: bytes = b"%PDF-1.4 fake") -> bytes:
    return marker


@pytest.mark.asyncio
async def test_upload_explicit_doc_class_persists(app, store, uploads_dir):
    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")},
            data={"doc_class": "oib_leitfaden"},
        )

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "pending"
    assert body["kind"] == "file"
    assert body["file_name"] == "plan.pdf"
    assert body["doc_class"] == "oib_leitfaden"
    # File persisted before the response.
    assert (uploads_dir / "plan.pdf").is_file()
    # Background job stamps the explicit class onto the summary row.
    assert _wait_for_doc_class(store, "plan.pdf") == "oib_leitfaden"


@pytest.mark.asyncio
async def test_upload_without_doc_class_uses_guess(app, store, uploads_dir):
    from aiq_agent.common.norm_registry import guess_doc_class

    name = "oib-rl_2_brandschutz.pdf"
    expected = guess_doc_class(name)

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": (name, _pdf_bytes(), "application/pdf")},
        )

    assert res.status_code == 200
    assert res.json()["doc_class"] == expected
    assert _wait_for_doc_class(store, name) == expected


@pytest.mark.asyncio
async def test_upload_invalid_doc_class_400(app, uploads_dir):
    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("plan.pdf", _pdf_bytes(), "application/pdf")},
            data={"doc_class": "not_a_real_class"},
        )

    assert res.status_code == 400
    # Nothing was persisted for the rejected upload.
    assert not (uploads_dir / "plan.pdf").exists()


def _build_zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buf.getvalue()


@pytest.mark.asyncio
async def test_zip_happy_path_and_skips(app, store, uploads_dir):
    content = _build_zip(
        {
            "a.pdf": _pdf_bytes(),
            "sub/b.pdf": _pdf_bytes(),  # nested but safe
            "notes.txt": b"ignore me",  # non-pdf skipped
        }
    )

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("bulk.zip", content, "application/zip")},
        )

    assert res.status_code == 200
    body = res.json()
    assert body["kind"] == "zip"
    assert body["status"] == "pending"
    assert body["accepted"] == 2
    assert body["rejected"] == 1
    accepted_names = {m["file_name"] for m in body["members"] if m["status"] == "pending"}
    assert accepted_names == {"a.pdf", "b.pdf"}
    rejected = [m for m in body["members"] if m["status"] == "rejected"]
    assert rejected[0]["file_name"] == "notes.txt"
    # Both PDFs land on disk by basename.
    assert (uploads_dir / "a.pdf").is_file()
    assert (uploads_dir / "b.pdf").is_file()
    assert _wait_for_doc_class(store, "a.pdf") is not None


@pytest.mark.asyncio
async def test_zip_slip_member_rejected(app, uploads_dir):
    # zipfile.writestr won't normalize a traversal path, so it lands verbatim.
    content = _build_zip({"../escape.pdf": _pdf_bytes(), "ok.pdf": _pdf_bytes()})

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("bulk.zip", content, "application/zip")},
        )

    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] == 1
    assert body["rejected"] == 1
    rejected = [m for m in body["members"] if m["status"] == "rejected"][0]
    assert "unsafe" in rejected["reason"].lower()
    # The traversal target never escaped the uploads dir.
    assert not (uploads_dir.parent / "escape.pdf").exists()


@pytest.mark.asyncio
async def test_patch_doc_class_updates(app, store, uploads_dir):
    register_summary(_COLLECTION, "plan.pdf", "A plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/plan.pdf/doc-class",
            json={"doc_class": "gesetz"},
        )

    assert res.status_code == 200
    assert res.json() == {"file_name": "plan.pdf", "doc_class": "gesetz"}
    assert store.get_doc_class(_COLLECTION, "plan.pdf") == "gesetz"


@pytest.mark.asyncio
async def test_patch_invalid_doc_class_400(app, store, uploads_dir):
    register_summary(_COLLECTION, "plan.pdf", "A plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/plan.pdf/doc-class",
            json={"doc_class": "bogus"},
        )

    assert res.status_code == 400
    assert store.get_doc_class(_COLLECTION, "plan.pdf") is None


@pytest.mark.asyncio
async def test_patch_missing_row_404(app, uploads_dir):
    async with _client(app) as client:
        res = await client.patch(
            "/v1/admin/oib/documents/ghost.pdf/doc-class",
            json={"doc_class": "gesetz"},
        )

    assert res.status_code == 404


class _FakeDeleteIngestor:
    """Minimal ingestor for the delete/exclude path: records chunk deletions."""

    def __init__(self):
        self.deleted: list[str] = []

    def delete_file(self, name, _collection):
        self.deleted.append(name)
        return True

    def list_files(self, _collection):
        return []


@pytest.fixture
def delete_dirs(tmp_path, monkeypatch, uploads_dir):
    """Point the repo corpus + registry/exclusion files at tmp and stub the ingestor."""
    oib_dir = tmp_path / "oib"
    oib_dir.mkdir(parents=True, exist_ok=True)
    ingestor = _FakeDeleteIngestor()
    monkeypatch.setattr(oib_sync, "OIB_DIR", oib_dir)
    monkeypatch.setattr(oib_sync, "REGISTRY_PATH", tmp_path / "oib_registry.json")
    monkeypatch.setattr(oib_sync, "EXCLUDED_PATH", tmp_path / "oib_excluded.json")
    monkeypatch.setattr(oib_sync, "_get_oib_ingestor", lambda: ingestor)
    return oib_dir, ingestor


@pytest.mark.asyncio
async def test_delete_uploaded_document_returns_deleted(app, uploads_dir, delete_dirs):
    _oib_dir, ingestor = delete_dirs
    (uploads_dir).mkdir(parents=True, exist_ok=True)
    (uploads_dir / "custom.pdf").write_bytes(_pdf_bytes())

    async with _client(app) as client:
        res = await client.delete("/v1/admin/oib/documents/custom.pdf")

    assert res.status_code == 200
    body = res.json()
    assert body == {"success": True, "file_name": "custom.pdf", "mode": "deleted"}
    assert not (uploads_dir / "custom.pdf").exists()
    assert ingestor.deleted == ["custom.pdf"]


@pytest.mark.asyncio
async def test_delete_repo_document_excludes_it(app, uploads_dir, delete_dirs):
    oib_dir, ingestor = delete_dirs
    (oib_dir / "shipped.pdf").write_bytes(_pdf_bytes())

    async with _client(app) as client:
        res = await client.delete("/v1/admin/oib/documents/shipped.pdf")

    assert res.status_code == 200
    body = res.json()
    assert body == {"success": True, "file_name": "shipped.pdf", "mode": "excluded"}
    # Source file stays on disk (it lives in git) but is now excluded from discovery.
    assert (oib_dir / "shipped.pdf").exists()
    assert oib_sync._load_excluded() == {"shipped.pdf"}
    assert "shipped.pdf" not in {p.name for p in oib_sync.discover_pdfs()}
    assert ingestor.deleted == ["shipped.pdf"]


@pytest.mark.asyncio
async def test_delete_unknown_document_404(app, uploads_dir, delete_dirs):
    async with _client(app) as client:
        res = await client.delete("/v1/admin/oib/documents/ghost.pdf")

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_upload_clears_prior_exclusion(app, uploads_dir, delete_dirs):
    """Re-uploading a previously deleted corpus document lifts its exclusion, so
    discovery (and the status panel) surface it again instead of hiding it."""
    # Simulate a document that was removed earlier: it is on the exclusion list.
    oib_sync._save_excluded({"shipped.pdf"})
    assert "shipped.pdf" in oib_sync._load_excluded()

    async with _client(app) as client:
        res = await client.post(
            "/v1/admin/oib/documents",
            files={"file": ("shipped.pdf", _pdf_bytes(), "application/pdf")},
        )

    assert res.status_code == 200
    assert res.json()["status"] == "pending"
    # The upload persisted the file AND lifted the exclusion...
    assert (uploads_dir / "shipped.pdf").is_file()
    assert oib_sync._load_excluded() == set()
    # ...so discovery now finds it again.
    assert "shipped.pdf" in {p.name for p in oib_sync.discover_pdfs()}
