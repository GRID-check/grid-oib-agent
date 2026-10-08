"""The „Ausmisten" proposal endpoint (ADR-0091): metadata in, candidates out, fail-soft."""

import json
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_api.routes.cleanup_proposal import add_cleanup_proposal_routes
from aiq_api.routes.cleanup_proposal import parse_candidates

DOCUMENTS = [
    {"id": "d1", "filename": "Einreichplan EG_v3.pdf", "folder_path": "Pläne/Einreichung", "summary": "Grundriss EG"},
    {"id": "d2", "filename": "Kopie von Einreichplan EG_v2.pdf", "folder_path": "Pläne/Einreichung"},
    {"id": "d3", "filename": "Bescheid MA37.pdf", "tags": ["Bescheid"]},
]


@pytest.fixture
def app():
    app = FastAPI()
    router = APIRouter()
    add_cleanup_proposal_routes(router)
    app.include_router(router)
    return app


@pytest.fixture(autouse=True)
def _configured_llm_key(monkeypatch):
    monkeypatch.setenv("SUMMARY_LLM_API_KEY", "test-key")


def _client_returning(content: str | None = None, error: Exception | None = None):
    response = MagicMock(spec=httpx.Response)
    response.status_code = 200
    response.raise_for_status = MagicMock()
    response.json.return_value = {"choices": [{"message": {"content": content}}]}
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(side_effect=error) if error else AsyncMock(return_value=response)
    return MagicMock(return_value=client), client.post


async def _propose(app, fake):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", fake):
            return await client.post("/v1/cleanup-proposal", json={"documents": DOCUMENTS, "locale": "de"})


@pytest.mark.asyncio
async def test_proposes_only_ids_it_was_given(app):
    answer = json.dumps(
        {
            "candidates": [
                {"id": "d2", "category": "working_copy", "reason": "Kopie einer neueren Fassung."},
                {"id": "invented", "category": "duplicate", "reason": "x"},
            ]
        }
    )
    fake, post = _client_returning(answer)
    response = await _propose(app, fake)
    assert response.status_code == 200
    body = response.json()
    assert [candidate["id"] for candidate in body["candidates"]] == ["d2"]
    assert body["error"] is None


@pytest.mark.asyncio
async def test_sends_metadata_and_no_content_field(app):
    fake, post = _client_returning(json.dumps({"candidates": []}))
    await _propose(app, fake)
    sent = post.call_args.kwargs["json"]["messages"][1]["content"]
    assert "Kopie von Einreichplan EG_v2.pdf" in sent
    assert "Pläne/Einreichung" in sent


@pytest.mark.asyncio
async def test_refuses_a_document_that_carries_more_than_its_metadata(app):
    fake, post = _client_returning(json.dumps({"candidates": []}))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", fake):
            response = await client.post(
                "/v1/cleanup-proposal",
                json={"documents": [{**DOCUMENTS[0], "text": "Volltext des Plans"}]},
            )
    assert response.status_code == 422
    post.assert_not_called()


@pytest.mark.asyncio
async def test_fails_soft_on_an_upstream_error(app):
    fake, _ = _client_returning(error=httpx.ConnectError("down"))
    body = (await _propose(app, fake)).json()
    assert body == {"candidates": [], "model": None, "error": "llm_request_failed"}


@pytest.mark.asyncio
async def test_fails_soft_on_an_answer_that_is_not_json(app):
    fake, _ = _client_returning("Ich würde d2 löschen.")
    body = (await _propose(app, fake)).json()
    assert body["error"] == "llm_response_malformed"


@pytest.mark.asyncio
async def test_says_when_no_model_is_configured(app, monkeypatch):
    for name in ("SUMMARY_LLM_API_KEY", "LLM_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    with patch("aiq_agent.common.credential_resolution.resolve_llm_credential") as resolve:
        resolve.return_value = MagicMock(api_key=None)
        fake, post = _client_returning("{}")
        body = (await _propose(app, fake)).json()
    assert body["error"] == "llm_not_configured"
    post.assert_not_called()


def test_parse_candidates_maps_unknown_categories_and_drops_duplicates():
    found = parse_candidates(
        '```json\n{"candidates": [{"id": "d1", "category": "junk", "reason": "alt"},'
        ' {"id": "d1", "category": "duplicate", "reason": "again"}, {"id": "d3", "reason": ""}]}\n```',
        {"d1", "d3"},
    )
    assert found is not None
    assert [(candidate.id, candidate.category) for candidate in found] == [("d1", "other")]
