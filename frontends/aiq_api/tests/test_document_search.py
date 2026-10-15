"""Tests for the semantic document-search endpoint.

``POST /v1/collections/{collection}/search`` runs deterministic vector search
(no LLM) over one collection's embedded chunks via the cached retriever, then
aggregates the per-chunk hits into a document-centric result: one hit per file
(its max-score chunk), sorted by score descending, capped at ``top_k_files``.
"""

import base64
import hashlib
import hmac
import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.base import FUSED_SCORE_KEY
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


def _scope_headers(scope: list[str], secret: str | None = None) -> dict[str, str]:
    """Build the signed ``X-Grid-Request-Context`` envelope the BFF forwards.

    Mirrors ``buildGridRequestContextWireHeaders({ collectionScope }, secret)`` on
    the TS side: base64url(JSON) payload + hex HMAC-SHA256 signature over the raw
    JSON. When ``secret`` is None the sig header is omitted (dev/anonymous).
    """
    payload = json.dumps({"collectionScope": scope})
    header = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    headers = {"x-grid-request-context": header}
    if secret:
        headers["x-grid-request-context-sig"] = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return headers


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
async def test_search_snippet_length_is_the_requests_within_bounds(app):
    """The cross-project lookups ask for a longer passage; the bound still holds (ADR-0094)."""
    set_active_retriever(_make_retriever([_chunk("big.pdf", 0.8, "B" * 2000)]))

    async with _client(app) as client:
        longer = await client.post("/v1/collections/proj_a/search", json={"query": "q", "snippet_max_chars": 900})
        too_long = await client.post("/v1/collections/proj_a/search", json={"query": "q", "snippet_max_chars": 5000})

    assert longer.status_code == 200
    assert longer.json()["hits"][0]["snippet"] == "B" * 900 + "…"
    assert too_long.status_code == 422


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


# --- Collection-scope enforcement (PB-SYNTH-4, defense-in-depth) --------------


@pytest.mark.asyncio
async def test_search_in_scope_collection_allowed(app, monkeypatch):
    """A signed scope that CONTAINS the target collection is searched normally."""
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    set_active_retriever(_make_retriever([_chunk("plan.pdf", 0.9)]))

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/proj_a/search",
            json={"query": "q"},
            headers=_scope_headers(["oib_knowledge", "proj_a"], secret="s3cr3t"),
        )

    assert res.status_code == 200
    assert [h["file_name"] for h in res.json()["hits"]] == ["plan.pdf"]


@pytest.mark.asyncio
async def test_search_out_of_scope_collection_rejected_404(app, monkeypatch):
    """A signed scope that does NOT contain the target collection → 404.

    404 (not 403) so an out-of-scope / other-tenant collection is
    indistinguishable from a genuinely missing one — no cross-tenant oracle. The
    existence probe / retriever must never run.
    """
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    retriever = _make_retriever([_chunk("victim.pdf", 0.9)])
    set_active_retriever(retriever)

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/proj_victim/search",
            json={"query": "q"},
            headers=_scope_headers(["proj_a"], secret="s3cr3t"),
        )

    assert res.status_code == 404
    retriever.retrieve.assert_not_awaited()
    app.state.ingestor.get_collection.assert_not_called()


@pytest.mark.asyncio
async def test_search_forged_raw_scope_header_not_honored(app, monkeypatch):
    """An UNSIGNED raw X-Grid-Collection-Scope header cannot widen scope.

    Under REQUIRE_AUTH the raw, forgeable header alone is not a valid signed
    envelope, so it is ignored and the request is rejected 403.
    """
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    set_active_retriever(_make_retriever([_chunk("victim.pdf", 0.9)]))

    scope = base64.urlsafe_b64encode(json.dumps(["proj_victim"]).encode()).decode().rstrip("=")
    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/proj_victim/search",
            json={"query": "q"},
            headers={"x-grid-collection-scope": scope},
        )

    assert res.status_code == 403


@pytest.mark.asyncio
async def test_search_wrong_signature_rejected(app, monkeypatch):
    """An envelope signed with the WRONG secret is treated as absent → 403."""
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    set_active_retriever(_make_retriever([_chunk("plan.pdf", 0.9)]))

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/proj_a/search",
            json={"query": "q"},
            headers=_scope_headers(["proj_a"], secret="attacker-key"),
        )

    assert res.status_code == 403


@pytest.mark.asyncio
async def test_search_require_auth_without_envelope_rejected_403(app, monkeypatch):
    """REQUIRE_AUTH=true + no signed scope at all → 403 (BFF always forwards one)."""
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    set_active_retriever(_make_retriever([_chunk("plan.pdf", 0.9)]))

    async with _client(app) as client:
        res = await client.post("/v1/collections/proj_a/search", json={"query": "q"})

    assert res.status_code == 403


@pytest.mark.asyncio
async def test_search_anonymous_mode_no_scope_allowed(app, monkeypatch):
    """Anonymous mode (REQUIRE_AUTH=false) enforces no tenant boundary."""
    monkeypatch.setenv("REQUIRE_AUTH", "false")
    set_active_retriever(_make_retriever([_chunk("plan.pdf", 0.9)]))

    async with _client(app) as client:
        res = await client.post("/v1/collections/proj_a/search", json={"query": "q"})

    assert res.status_code == 200
    assert [h["file_name"] for h in res.json()["hits"]] == ["plan.pdf"]


# --- One search across many collections (ADR-0094, ADR-0114) -----------------


def _grouped_retriever(groups: list[tuple[str, list[Chunk]]]) -> MagicMock:
    retriever = MagicMock()
    retriever.backend_name = "test"
    retriever.search_grouped = AsyncMock(return_value=groups)
    return retriever


def _ranked(file_name: str, cosine: float, fused: float, collection: str = "proj_a") -> Chunk:
    """A chunk as ``search_grouped`` returns it: its own cosine, and its score in the one fused ranking."""
    chunk = _chunk(file_name, cosine, collection=collection)
    chunk.metadata[FUSED_SCORE_KEY] = fused
    return chunk


@pytest.mark.asyncio
async def test_grouped_search_orders_documents_by_the_fused_ranking_not_the_scores(app):
    """Each document by its best fused chunk, whatever its cosine."""
    retriever = _grouped_retriever(
        [
            ("proj_b", [_ranked("b1.pdf", 0.40, 0.030, "proj_b"), _ranked("b1.pdf", 0.30, 0.020, "proj_b")]),
            ("proj_a", [_ranked("a1.pdf", 0.90, 0.025), _ranked("a2.pdf", 0.80, 0.015)]),
        ]
    )
    set_active_retriever(retriever)

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/search",
            json={"query": "Fluchttreppe", "collections": ["proj_a", "proj_b", "proj_a"], "files_per_group": 2},
        )

    assert res.status_code == 200
    assert [(h["collection"], h["file_name"]) for h in res.json()["hits"]] == [
        ("proj_b", "b1.pdf"),
        ("proj_a", "a1.pdf"),
        ("proj_a", "a2.pdf"),
    ]
    args = retriever.search_grouped.await_args
    assert args.args[1] == ["proj_a", "proj_b"]  # de-duplicated, order kept
    assert args.kwargs["group_size"] == 2 * 3
    # Only the superseded exclusion narrows a plain search (ADR-0099).
    assert args.kwargs["filters"] == {"superseded": {"$ne": True}} and args.kwargs["boost"] is None


@pytest.mark.asyncio
async def test_grouped_search_interleaves_documents_across_projects(app):
    """The best project's weak documents do not fill the page ahead of another project's strong one.

    The shape the real search produces: one project with one strong and many
    weak documents, many projects with one fairly strong document each.
    """
    best = [_ranked("strong.pdf", 0.95, 1 / 61, "proj_00")] + [
        _ranked(f"weak{n}.pdf", 0.60, 1 / (61 + 39 + n), "proj_00") for n in range(15)
    ]
    others = [(f"proj_{i:02d}", [_ranked(f"doc{i}.pdf", 0.85, 1 / (61 + i), f"proj_{i:02d}")]) for i in range(1, 40)]
    set_active_retriever(_grouped_retriever([("proj_00", best), *others]))

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/search",
            json={
                "query": "q",
                "collections": [f"proj_{i:02d}" for i in range(40)],
                "groups": 40,
                "files_per_group": 10,
            },
        )

    hits = res.json()["hits"]
    first_page = [(h["collection"], h["file_name"]) for h in hits[:10]]
    assert first_page[0] == ("proj_00", "strong.pdf")
    assert [collection for collection, _ in first_page[1:]] == [f"proj_{i:02d}" for i in range(1, 10)]
    # proj_00 still keeps its documents, at most files_per_group, after the others.
    assert sum(1 for h in hits if h["collection"] == "proj_00") == 10
    assert hits[-1]["collection"] == "proj_00"


@pytest.mark.asyncio
async def test_grouped_search_names_the_searched_collection_not_the_chunks_claim(app):
    chunk = _ranked("a.pdf", 0.9, 0.03, collection="proj_victim")  # metadata claims another collection
    set_active_retriever(_grouped_retriever([("proj_a", [chunk])]))

    async with _client(app) as client:
        res = await client.post("/v1/collections/search", json={"query": "q", "collections": ["proj_a"]})

    assert [h["collection"] for h in res.json()["hits"]] == ["proj_a"]


@pytest.mark.asyncio
async def test_grouped_search_hands_filters_and_boost_to_the_retriever_as_its_grammar(app):
    retriever = _grouped_retriever([])
    set_active_retriever(retriever)
    weights = {"bundesland": 4, "gebaeudeklasse": 3, "gebaeudeklasse_adjacent": 1, "bauweise": 2}

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/search",
            json={
                "query": "q",
                "collections": ["proj_a"],
                "filters": {
                    "document_types": ["Detail"],
                    "disciplines": ["Brandschutz", "Schallschutz"],
                    "project_facts": {"bauweise": ["holzbau"], "bundesland": "niederoesterreich"},
                    "project_status": ["closed"],
                },
                "boost": {"facts": {"bundesland": "wien", "gebaeudeklasse": [4]}, "weights": weights},
            },
        )

    assert res.status_code == 200
    kwargs = retriever.search_grouped.await_args.kwargs
    assert kwargs["filters"] == {
        "$and": [
            {"tags": {"$in": ["Detail"]}},
            {"tags": {"$in": ["Brandschutz", "Schallschutz"]}},
            {"project_facts.bundesland": {"$in": ["niederoesterreich"]}},
            {"project_facts.bauweise": {"$in": ["holzbau"]}},
            {"project_status": {"$in": ["closed"]}},
            {"superseded": {"$ne": True}},
        ]
    }
    assert kwargs["boost"]["facts"]["gebaeudeklasse"] == [4]
    assert kwargs["boost"]["weights"]["bundesland"] == 4 and kwargs["boost"]["weights"]["nutzung"] == 0


@pytest.mark.asyncio
async def test_grouped_search_refuses_an_unknown_filter_or_status(app):
    set_active_retriever(_grouped_retriever([]))
    async with _client(app) as client:
        unknown = await client.post(
            "/v1/collections/search", json={"query": "q", "collections": ["proj_a"], "filters": {"farbe": ["rot"]}}
        )
        status = await client.post(
            "/v1/collections/search",
            json={"query": "q", "collections": ["proj_a"], "filters": {"project_status": ["archived"]}},
        )
    assert unknown.status_code == 422 and status.status_code == 422


@pytest.mark.asyncio
async def test_grouped_search_rejects_any_collection_outside_the_signed_scope(app, monkeypatch):
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    retriever = _grouped_retriever([])
    set_active_retriever(retriever)

    async with _client(app) as client:
        res = await client.post(
            "/v1/collections/search",
            json={"query": "q", "collections": ["proj_a", "proj_victim"]},
            headers=_scope_headers(["proj_a"], secret="s3cr3t"),
        )

    assert res.status_code == 404
    retriever.search_grouped.assert_not_awaited()


@pytest.mark.asyncio
async def test_grouped_search_needs_a_signed_scope_under_auth(app, monkeypatch):
    monkeypatch.setenv("REQUIRE_AUTH", "true")
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "s3cr3t")
    set_active_retriever(_grouped_retriever([]))

    async with _client(app) as client:
        res = await client.post("/v1/collections/search", json={"query": "q", "collections": ["proj_a"]})

    assert res.status_code == 403


@pytest.mark.asyncio
async def test_a_failed_grouped_search_is_a_500_not_a_fallback_signal(app):
    """Qdrant is the only store: no 409 tells the BFF to search collection by collection any more."""
    retriever = MagicMock()
    retriever.backend_name = "test"
    retriever.search_grouped = AsyncMock(side_effect=NotImplementedError("cannot rank across collections"))
    set_active_retriever(retriever)

    async with _client(app) as client:
        res = await client.post("/v1/collections/search", json={"query": "q", "collections": ["proj_a"]})
        capability = await client.get("/v1/collections/search/capability")

    assert res.status_code == 500
    # The capability probe is gone; the path now names a collection called "search".
    assert capability.status_code in (404, 405)


@pytest.mark.asyncio
async def test_single_collection_search_is_not_shadowed_by_the_grouped_route(app):
    set_active_retriever(_make_retriever([_chunk("plan.pdf", 0.9)]))
    async with _client(app) as client:
        res = await client.post("/v1/collections/search/search", json={"query": "q"})
    assert res.status_code == 200
