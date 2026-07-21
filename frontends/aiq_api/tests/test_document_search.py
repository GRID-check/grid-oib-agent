"""Tests for the semantic document-search endpoint.

``POST /v1/collections/{collection}/search`` runs deterministic vector search
(no LLM) over one collection's embedded chunks via the cached retriever, then
aggregates the per-chunk hits into a document-centric result: one hit per file
(its max-score chunk), sorted by score descending, capped at ``top_k_files``.
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import clear_active_retriever
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_agent.knowledge.factory import set_active_retriever
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_api.routes.document_search import add_document_search_routes


def _chunk(
    file_name: str,
    score: float,
    content: str = "some content",
    page: int | None = 1,
    collection: str = "proj_a",
) -> Chunk:
    """Build a minimal valid Chunk for a retrieval result."""
    return Chunk(
        chunk_id=f"{file_name}:{page}:{score}",
        content=content,
        score=score,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name} p.{page}",
        content_type="text",
        metadata={"collection": collection},
    )


def _make_retriever(chunks: list[Chunk]) -> MagicMock:
    """Retriever mock whose async retrieve() returns the given chunks."""
    retriever = MagicMock()
    retriever.backend_name = "test"
    retriever.retrieve = AsyncMock(return_value=RetrievalResult(chunks=chunks, query="q", backend="test", success=True))
    return retriever


@pytest.fixture
def app():
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    # Collection exists by default; individual tests override for the 404 case.
    ingestor.get_collection.return_value = MagicMock()
    set_active_ingestor(ingestor)

    app = FastAPI()
    router = APIRouter()
    add_document_search_routes(router)
    app.include_router(router)
    app.state.ingestor = ingestor
    yield app
    clear_active_ingestor()
    clear_active_retriever()


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_search_returns_document_centric_hits(app):
    set_active_retriever(
        _make_retriever(
            [
                _chunk("plan.pdf", 0.9, "Floor plan details"),
                _chunk("report.pdf", 0.7, "Structural report"),
            ]
        )
    )

    async with _client(app) as client:
        res = await client.post("/v1/collections/proj_a/search", json={"query": "fire safety"})

    assert res.status_code == 200
    hits = res.json()["hits"]
    assert [h["file_name"] for h in hits] == ["plan.pdf", "report.pdf"]
    assert hits[0]["score"] == 0.9
    assert hits[0]["collection"] == "proj_a"
    assert hits[0]["page_number"] == 1
    assert hits[0]["snippet"] == "Floor plan details"


@pytest.mark.asyncio
async def test_search_unknown_collection_404(app):
    app.state.ingestor.get_collection.return_value = None
    set_active_retriever(_make_retriever([]))

    async with _client(app) as client:
        res = await client.post("/v1/collections/ghost/search", json={"query": "anything"})

    assert res.status_code == 404


@pytest.mark.asyncio
async def test_search_empty_query_422(app):
    set_active_retriever(_make_retriever([]))

    async with _client(app) as client:
        res = await client.post("/v1/collections/proj_a/search", json={"query": ""})

    assert res.status_code == 422


@pytest.mark.asyncio
async def test_search_keeps_max_score_per_file_and_sorts_desc(app):
    # Same document appears in multiple chunks; a lower-scoring file ranks below.
    set_active_retriever(
        _make_retriever(
            [
                _chunk("plan.pdf", 0.4, "low-scoring chunk of plan", page=2),
                _chunk("report.pdf", 0.6, "report chunk"),
                _chunk("plan.pdf", 0.95, "best chunk of plan", page=5),
            ]
        )
    )

    async with _client(app) as client:
        res = await client.post("/v1/collections/proj_a/search", json={"query": "q"})

    assert res.status_code == 200
    hits = res.json()["hits"]
    # One hit per file, plan.pdf first (its max score 0.95 beats report's 0.6).
    assert [h["file_name"] for h in hits] == ["plan.pdf", "report.pdf"]
    assert hits[0]["score"] == 0.95
    # The kept plan.pdf hit is its best chunk (page + snippet from the 0.95 one).
    assert hits[0]["page_number"] == 5
    assert hits[0]["snippet"] == "best chunk of plan"


@pytest.mark.asyncio
async def test_search_snippet_truncated_to_300_chars(app):
    long_content = "A" * 500
    set_active_retriever(_make_retriever([_chunk("big.pdf", 0.8, long_content)]))

    async with _client(app) as client:
        res = await client.post("/v1/collections/proj_a/search", json={"query": "q"})

    assert res.status_code == 200
    snippet = res.json()["hits"][0]["snippet"]
    # 300 chars kept + a single ellipsis marker.
    assert snippet == "A" * 300 + "…"


@pytest.mark.asyncio
async def test_search_respects_top_k_files(app):
    set_active_retriever(_make_retriever([_chunk(f"doc{i}.pdf", 0.9 - i * 0.01) for i in range(10)]))

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/proj_a/search",
            json={"query": "q", "top_k_files": 3},
        )

    assert res.status_code == 200
    hits = res.json()["hits"]
    assert len(hits) == 3
    assert [h["file_name"] for h in hits] == ["doc0.pdf", "doc1.pdf", "doc2.pdf"]


@pytest.mark.asyncio
async def test_search_passes_top_k_to_retriever(app):
    retriever = _make_retriever([_chunk("plan.pdf", 0.9)])
    set_active_retriever(retriever)

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/proj_a/search",
            json={"query": "fire", "top_k": 55},
        )

    assert res.status_code == 200
    retriever.retrieve.assert_awaited_once()
    kwargs = retriever.retrieve.await_args.kwargs
    assert kwargs["query"] == "fire"
    assert kwargs["collection_name"] == "proj_a"
    assert kwargs["top_k"] == 55
    assert kwargs["filters"] is None


@pytest.mark.asyncio
async def test_search_503_when_no_ingestor(app):
    # Simulate an unconfigured Knowledge API: no active ingestor.
    clear_active_ingestor()
    set_active_retriever(_make_retriever([]))

    async with _client(app) as client:
        res = await client.post("/v1/collections/proj_a/search", json={"query": "q"})

    assert res.status_code == 503
