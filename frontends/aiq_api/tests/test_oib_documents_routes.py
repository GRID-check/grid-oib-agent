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
    with tempfile.TemporaryDirectory() as tmpdir:
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
