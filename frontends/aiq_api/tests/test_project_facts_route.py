"""`PUT /v1/collections/{c}/project-facts`: authorized by the signed scope, a no-op where Qdrant is not written.

The write itself runs against a real Qdrant in ``test_grouped_search_on_qdrant.py``;
here the store is stood in for, so the refusals are checked without one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_api.routes.project_facts import add_project_facts_routes

BODY = {"facts": {"bundesland": "wien", "gebaeudeklasse": [4], "bauweise": ["holzbau"]}, "status": "closed"}


@pytest.fixture
def written(monkeypatch):
    """The store's write, recorded instead of sent."""
    from knowledge_layer.qdrant import retrieval

    calls: list[tuple[str, dict, str]] = []
    monkeypatch.setattr(
        retrieval, "set_project_facts", lambda scope, facts, status: calls.append((scope, facts, status)) or True
    )
    return calls


@pytest.fixture
def client():
    app = FastAPI()
    router = APIRouter()
    add_project_facts_routes(router)
    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _scope(scope: list[str], secret: str) -> dict[str, str]:
    payload = json.dumps({"collectionScope": scope})
    return {
        "x-grid-request-context": base64.urlsafe_b64encode(payload.encode()).decode().rstrip("="),
        "x-grid-request-context-sig": hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest(),
    }


@pytest.fixture
def signed(monkeypatch):
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    return lambda scope: _scope(scope, "s3cr3t")


async def test_writes_the_facts_of_a_collection_in_the_signed_scope(client, written, signed):
    async with client:
        res = await client.put(
            "/v1/collections/proj_a_r0123456789ab/project-facts",
            json=BODY,
            headers=signed(["proj_a", "proj_a_r0123456789ab"]),
        )
    assert res.status_code == 200 and res.json() == {"collection": "proj_a_r0123456789ab", "applied": True}
    [(scope, facts, status)] = written
    assert scope == "proj_a_r0123456789ab" and status == "closed"
    assert facts == {
        "bundesland": "wien",
        "gebaeudeklasse": [4],
        "bauweise": ["holzbau"],
        "nutzungen": [],
        "vorhabensart": [],
    }


async def test_a_collection_outside_the_signed_scope_is_not_found(client, written, signed):
    async with client:
        res = await client.put("/v1/collections/proj_victim/project-facts", json=BODY, headers=signed(["proj_a"]))
    assert res.status_code == 404 and written == []


async def test_no_signed_scope_under_auth_is_forbidden(client, written, signed):
    async with client:
        res = await client.put("/v1/collections/proj_a/project-facts", json=BODY)
    assert res.status_code == 403 and written == []


async def test_only_a_project_collection_carries_project_facts(client, written, signed):
    async with client:
        res = await client.put("/v1/collections/archiv_org1/project-facts", json=BODY, headers=signed(["archiv_org1"]))
    assert res.status_code == 400 and written == []


async def test_an_unknown_status_or_fact_is_refused(client, written, signed):
    async with client:
        status = await client.put(
            "/v1/collections/proj_a/project-facts", json={**BODY, "status": "archived"}, headers=signed(["proj_a"])
        )
        fact = await client.put(
            "/v1/collections/proj_a/project-facts",
            json={"facts": {"farbe": ["rot"]}, "status": "active"},
            headers=signed(["proj_a"]),
        )
    assert status.status_code == 422 and fact.status_code == 422 and written == []
