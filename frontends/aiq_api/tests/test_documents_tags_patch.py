"""Tests for the document tag-edit endpoint.

``PATCH /v1/collections/{collection}/documents/{file}/tags`` validates user
edits against the controlled ingestion vocabulary (``ALLOWED_TAGS``), 404s when
no summary row exists, and clears tags on an empty list — never touching the
one-sentence summary.
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
        db_url = f"sqlite:///{Path(tmpdir) / 'tags.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)
        yield db_url
        # Windows teardown: the store's TTL-cached engines keep their SQLite
        # connections open past this test, so the temp file stays locked and
        # TemporaryDirectory cleanup raises PermissionError (WinError 32).
        # Dispose the engines for this URL before the directory goes away.
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


@pytest.mark.asyncio
async def test_patch_valid_tags(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.", tags=["Grundriss"])

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/tags",
            json={"tags": ["Schnitt", "Brandschutz"]},
        )

    assert res.status_code == 200
    assert res.json()["tags"] == ["Schnitt", "Brandschutz"]
    docs = {d.file_name: d for d in store.get_all("proj_a")}
    assert docs["plan.pdf"].tags == ["Schnitt", "Brandschutz"]
    # Summary untouched.
    assert docs["plan.pdf"].summary == "A floor plan."


@pytest.mark.asyncio
async def test_patch_off_vocabulary_400_lists_values(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.", tags=["Grundriss"])

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/tags",
            json={"tags": ["Grundriss", "Feuerschutz", "MadeUp"]},
        )

    assert res.status_code == 400
    detail = res.json()["detail"]
    assert detail["invalid_tags"] == ["Feuerschutz", "MadeUp"]
    # The off-vocabulary edit did not mutate storage.
    docs = {d.file_name: d for d in store.get_all("proj_a")}
    assert docs["plan.pdf"].tags == ["Grundriss"]


@pytest.mark.asyncio
async def test_patch_empty_clears(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.", tags=["Grundriss"])

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/tags",
            json={"tags": []},
        )

    assert res.status_code == 200
    assert res.json()["tags"] == []
    docs = {d.file_name: d for d in store.get_all("proj_a")}
    assert docs["plan.pdf"].tags is None


@pytest.mark.asyncio
async def test_patch_missing_summary_row_404(app, store):
    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/ghost.pdf/tags",
            json={"tags": ["Grundriss"]},
        )

    assert res.status_code == 404
    assert store.get_all("proj_a") == []


@pytest.mark.asyncio
async def test_patch_too_many_tags_400(app, store):
    """More than MAX_TAGS (5) valid, in-vocabulary tags after dedup → 400.

    Mirrors the ingestion cap; the BFF zod already blocks this, so a normal user
    never reaches it, but the route enforces it defensively.
    """
    from aiq_agent.knowledge.document_classification import MAX_TAGS

    store.register("proj_a", "plan.pdf", "A floor plan.", tags=["Grundriss"])

    six_valid = ["Grundriss", "Schnitt", "Ansicht", "Brandschutz", "Schallschutz", "Bescheid"]
    assert len(six_valid) == MAX_TAGS + 1

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/tags",
            json={"tags": six_valid},
        )

    assert res.status_code == 400
    detail = res.json()["detail"]
    assert detail["max_tags"] == MAX_TAGS
    assert detail["tag_count"] == 6
    # Storage was not mutated by the rejected edit.
    docs = {d.file_name: d for d in store.get_all("proj_a")}
    assert docs["plan.pdf"].tags == ["Grundriss"]


@pytest.mark.asyncio
async def test_patch_deduplicates_valid_tags(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/tags",
            json={"tags": ["Grundriss", "Grundriss", "Schnitt"]},
        )

    assert res.status_code == 200
    assert res.json()["tags"] == ["Grundriss", "Schnitt"]
