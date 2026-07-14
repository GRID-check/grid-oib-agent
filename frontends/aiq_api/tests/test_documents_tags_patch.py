"""Tests for the document tag-edit endpoint.

``PATCH /v1/collections/{collection}/documents/{file}/tags`` validates user
edits against the controlled ingestion vocabulary (``ALLOWED_TAGS``), 404s when
no summary row exists, and clears tags on an empty list — never touching the
one-sentence summary.
"""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import configure_summary_db
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_agent.knowledge.summary_store import SummaryStore
from aiq_api.routes.documents import add_document_routes


@pytest.fixture
def summary_db():
    """Point the factory's summary store at a fresh temp SQLite DB."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'tags.db'}"
        SummaryStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)
        yield db_url


@pytest.fixture
def store(summary_db):
    return SummaryStore(summary_db)


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
async def test_patch_deduplicates_valid_tags(app, store):
    store.register("proj_a", "plan.pdf", "A floor plan.")

    async with _client(app) as client:
        res = await client.patch(
            "/v1/collections/proj_a/documents/plan.pdf/tags",
            json={"tags": ["Grundriss", "Grundriss", "Schnitt"]},
        )

    assert res.status_code == 200
    assert res.json()["tags"] == ["Grundriss", "Schnitt"]
