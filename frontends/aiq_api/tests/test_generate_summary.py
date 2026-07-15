"""Tests for the AI project summary generation endpoint."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_api.routes.generate_summary import add_generate_summary_routes


@pytest.fixture
def app():
    """Create a FastAPI app with the generate-summary route registered."""
    app = FastAPI()
    router = APIRouter()
    add_generate_summary_routes(router)
    app.include_router(router)
    return app


@pytest.fixture(autouse=True)
def _configured_llm_key(monkeypatch):
    """Ensure an API key is resolved so the route does not short-circuit.

    Tests that assert the no-key path override this explicitly.
    """
    monkeypatch.setenv("SUMMARY_LLM_API_KEY", "test-key")


def _fake_async_client(post_mock):
    """Build a stand-in for ``httpx.AsyncClient`` whose ``.post`` is ``post_mock``.

    Patching the class (rather than ``httpx.AsyncClient.post``) leaves the ASGI
    test client that drives the route untouched — the test client's name was
    bound at import time — while the route's own ``httpx.AsyncClient()``, resolved
    at call time, gets this fake with the desired post behaviour.
    """
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = post_mock
    return MagicMock(return_value=client)


@pytest.mark.asyncio
async def test_generate_summary_success(app):
    """Test successful summary generation from profile text."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {
        "choices": [{"message": {"content": "A modern office renovation project."}}],
    }
    mock_post = AsyncMock(return_value=mock_response)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Project type: office renovation. Location: Vienna."},
            )

    assert response.status_code == 200
    data = response.json()
    assert data["summary"] == "A modern office renovation project."
    assert data["error"] is None
    mock_post.assert_called_once()


@pytest.mark.asyncio
async def test_generate_summary_empty_profile_text(app):
    """Test that empty/whitespace profile_text short-circuits without calling the LLM."""
    mock_post = AsyncMock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-summary", json={"profile_text": "   "})

    assert response.status_code == 200
    assert response.json() == {"summary": "", "error": None}
    mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_generate_summary_defaults_to_german(app):
    """Without an explicit locale the summary is requested in German (UI default)."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": "Ein Projekt."}}]}
    mock_post = AsyncMock(return_value=mock_response)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Main use: Residential"},
            )

    assert response.status_code == 200
    payload = mock_post.call_args.kwargs["json"]
    user_content = payload["messages"][1]["content"]
    assert user_content.startswith("Write the summary in German.")
    assert "Main use: Residential" in user_content


@pytest.mark.asyncio
async def test_generate_summary_english_locale(app):
    """An 'en' locale asks for the summary in English."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": "A project."}}]}
    mock_post = AsyncMock(return_value=mock_response)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Main use: Residential", "locale": "en"},
            )

    assert response.status_code == 200
    payload = mock_post.call_args.kwargs["json"]
    assert payload["messages"][1]["content"].startswith("Write the summary in English.")


@pytest.mark.asyncio
async def test_generate_summary_missing_field(app):
    """Test that a missing profile_text field is a validation error."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/v1/generate-summary", json={})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_generate_summary_llm_failure_returns_empty_summary(app):
    """Test that an LLM/network failure is swallowed and returns an empty summary (200)."""
    mock_post = AsyncMock(side_effect=httpx.RequestError("Connection refused"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Project type: office renovation."},
            )

    assert response.status_code == 200
    assert response.json() == {"summary": "", "error": "llm_request_failed"}


@pytest.mark.asyncio
async def test_generate_summary_upstream_error_returns_empty_summary(app):
    """Test that a non-2xx response from the LLM provider is swallowed and returns an empty summary."""
    error_response = MagicMock(spec=httpx.Response)
    error_response.status_code = 500
    error_response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "500 Internal Server Error",
        request=MagicMock(),
        response=error_response,
    )
    mock_post = AsyncMock(return_value=error_response)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Project type: office renovation."},
            )

    assert response.status_code == 200
    assert response.json() == {"summary": "", "error": "llm_request_failed"}


@pytest.mark.asyncio
async def test_generate_summary_no_api_key_returns_not_configured(app, monkeypatch):
    """Test that with no resolvable API key the route short-circuits without any HTTP call."""
    monkeypatch.delenv("SUMMARY_LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    mock_post = AsyncMock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Project type: office renovation."},
            )

    assert response.status_code == 200
    assert response.json() == {"summary": "", "error": "llm_not_configured"}
    mock_post.assert_not_called()
