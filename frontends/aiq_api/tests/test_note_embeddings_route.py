"""The note-embeddings route (`POST /v1/note-embeddings`) answers with vectors.

It is the only seam that embeds project memory and platform lessons, and it
fails open: any error is answered as "no embedder" and every caller falls back
to its lexical path, silently. It imported a class the knowledge layer never
had (`LlamaIndexRetrieverAdapter`), so every call took that fallback, no memory
item was ever embedded and every recall ran on tokens alone, while each layer
reported itself healthy. The cross-project decisions ranking found it (October
2026). These tests drive the route with the knowledge layer's own builders
patched to a fake model, so the import, the key chain and the fingerprint are
the real ones.
"""

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_api.routes.note_embeddings import add_note_embedding_routes

TOKEN = "note-embeddings-test-token"


class _FakeModel:
    def get_text_embedding_batch(self, texts: list[str]) -> list[list[float]]:
        return [[float(len(text)), 1.0] for text in texts]


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    app = FastAPI()
    router = APIRouter()
    add_note_embedding_routes(router)
    app.include_router(router)
    return app


async def _post(app: FastAPI, texts: list[str]) -> dict:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/v1/note-embeddings", json={"texts": texts}, headers={"x-grid-internal-token": TOKEN}
        )
    assert response.status_code == 200
    return response.json()


async def test_it_embeds_with_the_deployments_model_and_says_which(app, monkeypatch) -> None:
    from knowledge_layer.llamaindex import adapter

    monkeypatch.setattr(adapter, "_resolve_embed_api_key", lambda base_url, model: "key")
    monkeypatch.setattr(adapter, "make_embed_model", lambda **_: _FakeModel())

    body = await _post(app, ["Stiegenhaus in Stahlbeton", "Kapselung"])

    assert body.get("error") is None
    assert body["vectors"] == [[25.0, 1.0], [9.0, 1.0]]
    assert body["dimensions"] == 2
    assert body["fingerprint"] == adapter.embed_fingerprint(
        adapter.LlamaIndexRetriever.DEFAULT_EMBED_MODEL, adapter.LlamaIndexRetriever.DEFAULT_EMBED_BASE_URL
    )


async def test_without_a_key_it_says_so_rather_than_failing(app, monkeypatch) -> None:
    from knowledge_layer.llamaindex import adapter

    monkeypatch.setattr(adapter, "_resolve_embed_api_key", lambda base_url, model: "")

    body = await _post(app, ["Stiegenhaus"])

    assert body["vectors"] == [] and body["error"] == "embedder_not_configured"
