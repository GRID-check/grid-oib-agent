"""``POST /v1/collections/search`` end to end on a real Qdrant: the route, the adapter, the store.

``test_document_search.py`` pins the route over a mocked retriever; this
checks that what the real stack hands the BFF has the shape those tests
assume: documents interleaved across projects in one fused order, the
searched collection on every hit, facts filtering and lifting inside the
query. Without ``AIQ_QDRANT_TEST_URL`` it skips locally and fails on CI.
"""

from __future__ import annotations

import math
import os
import random
import uuid

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_retriever
from aiq_agent.knowledge.factory import set_active_retriever
from aiq_api.routes.document_search import add_document_search_routes
from aiq_api.routes.project_facts import add_project_facts_routes

DIM = 8


def _unit(seed: str) -> list[float]:
    rng = random.Random(seed)
    vector = [rng.uniform(-1, 1) for _ in range(DIM)]
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector]


def _at(query: list[float], cosine: float, seed: str) -> list[float]:
    noise = _unit(seed)
    dot = sum(q * n for q, n in zip(query, noise, strict=True))
    orthogonal = [n - dot * q for q, n in zip(query, noise, strict=True)]
    norm = math.sqrt(sum(x * x for x in orthogonal))
    side = math.sqrt(1 - cosine * cosine)
    return [cosine * q + side * o / norm for q, o in zip(query, orthogonal, strict=True)]


QUERY = _unit("Fluchttreppe")


@pytest.fixture
def stack(monkeypatch):
    url = os.environ.get("AIQ_QDRANT_TEST_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("AIQ_QDRANT_TEST_URL is unset on CI: the Qdrant service container is missing")
        pytest.skip("AIQ_QDRANT_TEST_URL not set")
    from knowledge_layer.llamaindex.adapter import LlamaIndexRetriever
    from knowledge_layer.qdrant import schema
    from knowledge_layer.qdrant import store as store_module

    suffix = uuid.uuid4().hex[:8]
    monkeypatch.setitem(schema.ALIASES, schema.Physical.CORPUS, f"route_corpus_{suffix}")
    monkeypatch.setitem(schema.ALIASES, schema.Physical.OFFICE, f"route_office_{suffix}")
    monkeypatch.setenv("AIQ_QDRANT_URL", url)
    monkeypatch.delenv("REQUIRE_AUTH", raising=False)
    store_module.reset_store()
    retriever = LlamaIndexRetriever({"embed_model": "test-model", "embed_base_url": "https://test"})
    retriever._initialized = True
    retriever.hybrid_search = False
    monkeypatch.setattr(retriever, "_embed_query_cached", lambda query: QUERY)
    set_active_retriever(retriever)
    app = FastAPI()
    router = APIRouter()
    add_document_search_routes(router)
    add_project_facts_routes(router)
    app.include_router(router)
    store = store_module.get_store(retriever._identity())
    yield app, store
    clear_active_retriever()
    for physical in schema.Physical:
        name = schema.ALIASES[physical] + schema.FIRST_VERSION
        if store.client.collection_exists(name):
            store.client.delete_collection(name)
    store_module.reset_store()


def _put(store, scope: str, *files: tuple[str, float]) -> None:
    from knowledge_layer.qdrant.payload import ChunkRecord

    store.upsert(
        scope,
        [
            ChunkRecord(str(uuid.uuid4()), "", _at(QUERY, cosine, f"{scope}/{name}"), {"file_name": name})
            for name, cosine in files
        ],
    )


def _client(app) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_documents_interleave_across_projects_in_the_real_answer(stack):
    app, store = stack
    _put(store, "proj_00", ("strong.pdf", 0.95), *[(f"weak{n}.pdf", 0.60) for n in range(15)])
    for index in range(1, 40):
        _put(store, f"proj_{index:02d}", (f"doc{index}.pdf", 0.85))
    collections = [f"proj_{index:02d}" for index in range(40)]

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/search",
            json={"query": "Fluchttreppe", "collections": collections, "groups": 40, "files_per_group": 10},
        )

    assert res.status_code == 200
    hits = res.json()["hits"]
    first_page = [hit["collection"] for hit in hits[:10]]
    # The BFF keeps the order and cuts it to `limit` (10): one project must not fill it with weak documents.
    assert first_page[0] == "proj_00" and hits[0]["file_name"] == "strong.pdf"
    assert "proj_00" not in first_page[1:]
    assert len(set(first_page)) == 10
    assert {hit["collection"] for hit in hits} <= set(collections)


async def test_facts_put_then_filter_and_lift_through_the_routes(stack):
    app, store = stack
    _put(store, "proj_a", ("a.pdf", 0.80))
    _put(store, "proj_b", ("b.pdf", 0.70))

    async with _client(app) as client:
        for scope, facts in (
            ("proj_a", {"construction_method": ["stahlbeton"]}),
            ("proj_b", {"construction_method": ["holzbau"]}),
        ):
            put = await client.put(f"/v1/collections/{scope}/project-facts", json={"facts": facts, "status": "closed"})
            assert put.status_code == 200 and put.json() == {"collection": scope, "applied": True}
        filtered = await client.post(
            "/v1/collections/search",
            json={
                "query": "q",
                "collections": ["proj_a", "proj_b"],
                "filters": {"project_facts": {"construction_method": ["holzbau"]}},
            },
        )
        missing = await client.put("/v1/collections/proj_new/project-facts", json={"facts": {}, "status": "active"})

    assert [hit["collection"] for hit in filtered.json()["hits"]] == ["proj_b"]
    assert missing.json() == {"collection": "proj_new", "applied": False}


async def test_a_superseded_revision_stays_out_of_the_grouped_search(stack):
    """ADR-0099: search leaves a replaced Fassung out; the cross-project lookup would hand it to the model."""
    app, store = stack
    _put(store, "proj_a", ("plan_index_b.pdf", 0.90), ("plan_index_c.pdf", 0.80))
    _put(store, "proj_b", ("detail.pdf", 0.70))
    store.set_file_payloads("proj_a", {"plan_index_b.pdf": {"superseded": True}})

    async with _client(app) as client:
        plain = await client.post("/v1/collections/search", json={"query": "q", "collections": ["proj_a", "proj_b"]})
        tagged = await client.post(
            "/v1/collections/search",
            json={"query": "q", "collections": ["proj_a", "proj_b"], "filters": {"document_types": ["Plan"]}},
        )

    assert plain.status_code == 200
    assert [hit["file_name"] for hit in plain.json()["hits"]] == ["plan_index_c.pdf", "detail.pdf"]
    # Beside another filter too: none of these points carries the tag, so nothing is left.
    assert tagged.status_code == 200 and tagged.json()["hits"] == []
