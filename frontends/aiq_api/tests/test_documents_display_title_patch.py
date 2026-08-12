"""Tests for the per-collection document rename endpoint.

``PATCH /v1/collections/{collection}/documents/{file}/display-title`` stores the
user-facing name beside the immutable file name, so retrieval can put the
renamed title on a citation chip with nothing re-ingested. It clears the
override on a null or blank title, 404s when the document has no metadata row,
and never touches the summary or the tags.
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
    """Point the factory's summary store at a fresh temp SQLite DB."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'display_title.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)
        yield db_url
        # Windows teardown: dispose the TTL-cached engines so the temp file is
        # not still locked when TemporaryDirectory cleans up (see the tags spec).
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


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _doc(store, collection, file_name):
    return {d.file_name: d for d in store.get_all(collection)}[file_name]


@pytest.mark.asyncio
async def test_patch_sets_display_title(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.", tags=["Grundriss"])

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/display-title",
            json={"display_title": "Einreichplan Erdgeschoss"},
        )

    assert res.status_code == 200
    assert res.json()["display_title"] == "Einreichplan Erdgeschoss"
    doc = _doc(store, "proj_a", "plan.pdf")
    assert doc.display_title == "Einreichplan Erdgeschoss"
    # The rename is a LABEL: the file name, the summary and the tags all stand.
    assert doc.file_name == "plan.pdf"
    assert doc.summary == "A floor plan."
    assert doc.tags == ["Grundriss"]


@pytest.mark.asyncio
async def test_patch_trims_and_blank_clears_the_override(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.")

    async with _client(app) as client:
        padded = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/display-title",
            json={"display_title": "  Einreichplan  "},
        )
        assert padded.json()["display_title"] == "Einreichplan"

        cleared = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/display-title",
            json={"display_title": "   "},
        )

    assert cleared.status_code == 200
    assert cleared.json()["display_title"] is None
    assert _doc(store, "proj_a", "plan.pdf").display_title is None


@pytest.mark.asyncio
async def test_patch_null_clears_the_override(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.")
    store.set_display_title("proj_a", "plan.pdf", "Einreichplan")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/display-title",
            json={"display_title": None},
        )

    assert res.status_code == 200
    assert _doc(store, "proj_a", "plan.pdf").display_title is None


@pytest.mark.asyncio
async def test_patch_unknown_document_404s(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/ghost.pdf/display-title",
            json={"display_title": "Anything"},
        )

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_patch_is_scoped_to_its_collection(app, store):
    """A rename in one project must not reach a same-named file in another."""
    store.register("proj_a", "plan.pdf", "Project A's plan.")
    store.register("proj_b", "plan.pdf", "Project B's plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/display-title",
            json={"display_title": "Einreichplan A"},
        )

    assert res.status_code == 200
    assert _doc(store, "proj_a", "plan.pdf").display_title == "Einreichplan A"
    assert _doc(store, "proj_b", "plan.pdf").display_title is None
