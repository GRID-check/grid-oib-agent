"""The document facts half of the weekly vector reconcile: every live collection's facts copied again.

Module under test: ``aiq_api.routes.maintenance`` (``refresh_document_facts``
and its route). ``writes.refresh_facts`` never raises after a person's edit,
so a copy that failed leaves the old tags, Dokumentart or superseded mark on
the points, and the pre-filters that read them hide or show a document
wrongly. This sweep is what repairs that; ``writes.copy_facts`` itself is
pinned on a real Qdrant in ``sources/knowledge_layer/tests/test_qdrant_adapter.py``.
"""

from __future__ import annotations

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient
from knowledge_layer.qdrant import writes

from aiq_api.routes.maintenance import REFRESH_FACTS_MAX_COLLECTIONS
from aiq_api.routes.maintenance import add_maintenance_routes
from aiq_api.routes.maintenance import refresh_document_facts


@pytest.fixture
def copied(monkeypatch):
    """Each collection's file count, or the error its copy raises."""
    outcomes: dict[str, int | Exception] = {}
    calls: list[str] = []

    def copy_facts(scope: str) -> int:
        calls.append(scope)
        outcome = outcomes.get(scope, 0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(writes, "copy_facts", copy_facts)
    return outcomes, calls


@pytest.mark.asyncio
async def test_copies_every_collection_once_and_counts_the_files(copied):
    outcomes, calls = copied
    outcomes.update({"proj_a": 3, "proj_a_r0123456789ab": 1, "archiv_org_1": 2})

    result = await refresh_document_facts(["proj_a", "proj_a_r0123456789ab", "archiv_org_1", "proj_a"])

    assert calls == ["proj_a", "proj_a_r0123456789ab", "archiv_org_1"]
    assert result == {"status": "ok", "collections_scanned": 3, "files_refreshed": 6, "failures": []}


@pytest.mark.asyncio
async def test_one_failed_collection_is_reported_and_the_others_are_still_copied(copied):
    outcomes, calls = copied
    outcomes.update({"proj_a": RuntimeError("qdrant timed out"), "proj_b": 4})

    result = await refresh_document_facts(["proj_a", "proj_b"])

    assert calls == ["proj_a", "proj_b"]
    assert result["files_refreshed"] == 4
    assert result["failures"] == [{"collection": "proj_a", "error": "qdrant timed out"}]


def _app() -> FastAPI:
    app = FastAPI()
    router = APIRouter()
    add_maintenance_routes(router)
    app.include_router(router)
    return app


@pytest.mark.asyncio
async def test_the_route_is_guarded_by_the_internal_token_and_bounded(copied, monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    monkeypatch.setenv("APP_ENV", "production")
    path = "/v1/maintenance/refresh-document-facts"
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test") as client:
        anonymous = await client.post(path, json={"collections": ["proj_a"]})
        signed = await client.post(path, json={"collections": ["proj_a"]}, headers={"x-grid-internal-token": "s3cr3t"})
        too_many = await client.post(
            path,
            json={"collections": [f"proj_{n}" for n in range(REFRESH_FACTS_MAX_COLLECTIONS + 1)]},
            headers={"x-grid-internal-token": "s3cr3t"},
        )

    assert anonymous.status_code == 403
    assert signed.status_code == 200 and signed.json()["collections_scanned"] == 1
    assert too_many.status_code == 422
