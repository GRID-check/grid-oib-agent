"""Tests for the conversation naming + topic tagging endpoint."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_api.routes.generate_conversation_title import add_generate_conversation_title_routes


@pytest.fixture
def app():
    """Create a FastAPI app with the generate-conversation-title route registered."""
    app = FastAPI()
    router = APIRouter()
    add_generate_conversation_title_routes(router)
    app.include_router(router)
    return app


@pytest.fixture(autouse=True)
def _configured_llm_key(monkeypatch):
    """Ensure an API key is resolved so the route does not short-circuit."""
    monkeypatch.setenv("SUMMARY_LLM_API_KEY", "test-key")


def _fake_async_client(post_mock):
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = post_mock
    return MagicMock(return_value=client)


def _title_response(content: str):
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": content}}]}
    return mock_response


_BODY = {
    "messages": [
        {"role": "user", "content": "Welche Brandschutzanforderungen gelten für Stiegenhäuser über 22 m?"},
        {"role": "assistant", "content": "Für Gebäude über 22 m gelten laut OIB 2 …"},
    ],
    "allowed_tags": ["brandschutz", "schallschutz", "statik"],
}


@pytest.mark.asyncio
async def test_success_returns_title_and_filtered_tags(app):
    """A clean JSON reply yields the title and only allowed tags (deduped, capped)."""
    mock_post = AsyncMock(
        return_value=_title_response(
            '{"title": "Brandschutz bei Stiegenhäusern", '
            '"tags": ["brandschutz", "brandschutz", "unknown-tag"]}'
        )
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Brandschutz bei Stiegenhäusern"
    # Deduped, and the out-of-vocabulary tag is dropped.
    assert data["tags"] == ["brandschutz"]
    assert data["error"] is None


@pytest.mark.asyncio
async def test_parses_json_wrapped_in_code_fence(app):
    """The model sometimes fences its JSON; the route recovers the object."""
    mock_post = AsyncMock(
        return_value=_title_response('```json\n{"title": "Schallschutz Wohnbau", "tags": ["schallschutz"]}\n```')
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    data = response.json()
    assert data["title"] == "Schallschutz Wohnbau"
    assert data["tags"] == ["schallschutz"]


@pytest.mark.asyncio
async def test_empty_messages_short_circuits(app):
    """No usable transcript → no LLM call."""
    mock_post = AsyncMock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post(
                "/v1/generate-conversation-title",
                json={"messages": [{"role": "user", "content": "   "}], "allowed_tags": ["brandschutz"]},
            )

    assert response.status_code == 200
    assert response.json() == {"title": "", "tags": [], "error": None}
    mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_malformed_json_returns_error_code(app):
    """A non-JSON reply is reported as llm_response_malformed, not a 500."""
    mock_post = AsyncMock(return_value=_title_response("Sorry, I cannot do that."))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.status_code == 200
    assert response.json() == {"title": "", "tags": [], "error": "llm_response_malformed"}


@pytest.mark.asyncio
async def test_llm_failure_is_swallowed(app):
    """Network failure degrades to an empty result with a diagnosable code."""
    mock_post = AsyncMock(side_effect=httpx.RequestError("Connection refused"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.status_code == 200
    assert response.json() == {"title": "", "tags": [], "error": "llm_request_failed"}


@pytest.mark.asyncio
async def test_no_api_key_returns_not_configured(app, monkeypatch):
    """No resolvable key → short-circuit before any HTTP call."""
    monkeypatch.delenv("SUMMARY_LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    mock_post = AsyncMock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.status_code == 200
    assert response.json() == {"title": "", "tags": [], "error": "llm_not_configured"}
    mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_title_written_in_english_for_en_locale(app):
    """An 'en' locale asks for the title in English."""
    mock_post = AsyncMock(return_value=_title_response('{"title": "Fire safety stairwells", "tags": []}'))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            await client.post(
                "/v1/generate-conversation-title",
                json={**_BODY, "locale": "en"},
            )

    payload = mock_post.call_args.kwargs["json"]
    assert "Write the title in English." in payload["messages"][1]["content"]
