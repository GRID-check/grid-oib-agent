"""`PATCH /v1/collections/{c}/documents/{f}/folder-path` — moving ONE document.

The per-document half of ADR-0049, and it is not covered by the subtree mirror
beside it: that one rewrites a path PREFIX, and a document leaving `Brandschutz`
for `Statik` shares no prefix with where it was. Both exist, neither substitutes
for the other.

The BFF twin is `src/lib/documents/move-to-folder.spec.ts`, which asserts the
same `folder_path` body against the same URL.
"""

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import configure_summary_db
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_api.routes.documents import add_document_routes


@pytest.fixture
def summary_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'folder_path_one.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)
        yield db_url
        with DocumentMetadataStore._cache_lock:
            for cache in (
                DocumentMetadataStore._sync_engine_cache,
                DocumentMetadataStore._async_engine_cache,
            ):
                engine = cache.pop(db_url, (None, None))[0]
                if engine is None:
                    continue
                try:
                    disposed = engine.dispose()
                    if asyncio.iscoroutine(disposed):
                        asyncio.run(disposed)
                except (RuntimeError, OSError):
                    pass
        DocumentMetadataStore._tables_initialized.discard(db_url)


@pytest.fixture
def store(summary_db):
    return DocumentMetadataStore(summary_db)


@pytest.fixture
def app(summary_db):
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    set_active_ingestor(ingestor)
    app = FastAPI()
    router = APIRouter()
    add_document_routes(router)
    app.include_router(router)
    yield app
    clear_active_ingestor()


def _file(store: DocumentMetadataStore, name: str, folder: str | None) -> None:
    store.register("proj_abc", name, f"Summary of {name}")
    if folder:
        store.set_folder_path("proj_abc", name, folder)


async def _patch(app, file_name: str, body: dict):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.patch(f"/v1/collections/proj_abc/documents/{file_name}/folder-path", json=body)


@pytest.mark.asyncio
async def test_a_document_moves_between_unrelated_folders(app, store):
    # The case the subtree rewrite cannot express: no shared prefix.
    _file(store, "a.pdf", "Brandschutz/Fluchtwege")

    response = await _patch(app, "a.pdf", {"folder_path": "Statik"})

    assert response.status_code == 200
    assert response.json() == {
        "collection_name": "proj_abc",
        "file_name": "a.pdf",
        "folder_path": "Statik",
    }
    assert store.get_folder_path("proj_abc", "a.pdf") == "Statik"


@pytest.mark.asyncio
async def test_a_null_path_files_the_document_at_the_project_root(app, store):
    _file(store, "a.pdf", "Brandschutz")

    response = await _patch(app, "a.pdf", {"folder_path": None})

    assert response.status_code == 200
    assert response.json()["folder_path"] is None
    assert store.get_folder_path("proj_abc", "a.pdf") is None


@pytest.mark.asyncio
async def test_a_blank_path_means_the_root_too(app, store):
    _file(store, "a.pdf", "Brandschutz")

    response = await _patch(app, "a.pdf", {"folder_path": "   "})

    assert response.status_code == 200
    assert store.get_folder_path("proj_abc", "a.pdf") is None


@pytest.mark.asyncio
async def test_it_moves_only_the_named_document(app, store):
    _file(store, "a.pdf", "Brandschutz")
    _file(store, "b.pdf", "Brandschutz")

    await _patch(app, "a.pdf", {"folder_path": "Statik"})

    assert store.get_folder_path("proj_abc", "b.pdf") == "Brandschutz"


@pytest.mark.asyncio
async def test_a_document_with_no_summary_row_is_a_404(app, store):
    # The summary is the anchor, as it is for tags and the display title. The
    # BFF treats this as non-fatal: its own `documents.folder_id` is durable.
    response = await _patch(app, "never-summarised.pdf", {"folder_path": "Statik"})

    assert response.status_code == 404
