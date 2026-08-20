"""`PATCH /v1/collections/{c}/folder-paths` — the folder rename/move/delete mirror.

The sibling of the display-title mirror, and it exists for the same reason: the
backend stores a denormalised copy of something the BFF owns, so every change to
the original has to be replayed. The difference is arity — a display title
belongs to one document, a folder path belongs to a whole subtree — which is why
this is one prefix rewrite rather than one call per file.

The BFF twin is `folder-service.mirror.spec.ts`, which asserts the same
`from_path` / `to_path` body against the same URL.
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
        db_url = f"sqlite:///{Path(tmpdir) / 'folder_paths.db'}"
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


async def _patch(app, body: dict):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.patch("/v1/collections/proj_abc/folder-paths", json=body)


@pytest.mark.asyncio
async def test_a_rename_re_files_the_folder_and_its_subtree(app, store):
    _file(store, "a.pdf", "Brandschutz")
    _file(store, "b.pdf", "Brandschutz/Fluchtwege")

    response = await _patch(app, {"from_path": "Brandschutz", "to_path": "Feuer"})

    assert response.status_code == 200
    assert response.json() == {
        "collection_name": "proj_abc",
        "from_path": "Brandschutz",
        "to_path": "Feuer",
        "updated": 2,
    }
    assert store.get_folder_path("proj_abc", "a.pdf") == "Feuer"
    assert store.get_folder_path("proj_abc", "b.pdf") == "Feuer/Fluchtwege"


@pytest.mark.asyncio
async def test_a_null_target_re_files_the_subtree_at_the_project_root(app, store):
    # What a folder DELETE does to its direct children — the label goes, the
    # work stays.
    _file(store, "a.pdf", "Brandschutz")
    _file(store, "b.pdf", "Brandschutz/EG")

    response = await _patch(app, {"from_path": "Brandschutz", "to_path": None})

    assert response.status_code == 200
    assert response.json()["updated"] == 2
    assert response.json()["to_path"] is None
    assert store.get_folder_path("proj_abc", "a.pdf") is None
    assert store.get_folder_path("proj_abc", "b.pdf") == "EG"


@pytest.mark.asyncio
async def test_a_folder_nothing_is_filed_under_is_not_an_error(app, store):
    _file(store, "a.pdf", "Brandschutz")

    response = await _patch(app, {"from_path": "Statik", "to_path": "Tragwerk"})

    assert response.status_code == 200
    assert response.json()["updated"] == 0
    assert store.get_folder_path("proj_abc", "a.pdf") == "Brandschutz"


@pytest.mark.asyncio
async def test_an_empty_from_path_is_rejected(app):
    # Without a source prefix the request means "re-file everything", which is
    # never what a folder operation asks for.
    response = await _patch(app, {"from_path": "", "to_path": "Feuer"})
    assert response.status_code == 422
