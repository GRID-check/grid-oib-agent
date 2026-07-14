"""Tests for the free-text intake consistency-check endpoint."""

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

from aiq_api.routes.consistency_check import add_consistency_check_routes


@pytest.fixture
def app():
    """Create a FastAPI app with the consistency-check route registered."""
    app = FastAPI()
    router = APIRouter()
    add_consistency_check_routes(router)
    app.include_router(router)
    return app


@pytest.fixture(autouse=True)
def _configured_llm_key(monkeypatch):
    """Ensure an API key is resolved so the route does not short-circuit.

    Tests that assert the no-key path override this explicitly.
    """
    monkeypatch.setenv("CONSISTENCY_LLM_API_KEY", "test-key")


def _fake_async_client(post_mock):
    """Build a stand-in for ``httpx.AsyncClient`` whose ``.post`` is ``post_mock``.

    Mirrors ``test_generate_summary.py``: patching the class (not
    ``AsyncClient.post``) leaves the ASGI test client untouched while the
    route's own call-time ``httpx.AsyncClient()`` gets this fake.
    """
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = post_mock
    return MagicMock(return_value=client)


def _llm_response(content: str):
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": content}}]}
    return mock_response


# A free-text answer plus structured context it might contradict.
_FREE_TEXT = [{"field": "Tell Grid more", "value": "This is an eight-storey tower with a rooftop bar."}]
_STRUCTURED = [
    {"field": "Building class", "value": "GK1"},
    {"field": "Above-ground floors", "value": "2"},
]


def _body(**overrides):
    body = {"free_text": _FREE_TEXT, "structured": _STRUCTURED, "locale": "en"}
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_consistency_check_returns_findings(app):
    """A contradiction reported by the LLM is parsed into a structured finding."""
    content = json.dumps(
        {
            "findings": [
                {
                    "fields": ["Tell Grid more", "Above-ground floors"],
                    "severity": "inconsistency",
                    "explanation": "The note describes an eight-storey tower but the floor count says two.",
                }
            ]
        }
    )
    mock_post = AsyncMock(return_value=_llm_response(content))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    data = response.json()
    assert data["error"] is None
    assert len(data["findings"]) == 1
    finding = data["findings"][0]
    assert finding["severity"] == "inconsistency"
    assert finding["fields"] == ["Tell Grid more", "Above-ground floors"]
    assert "eight" in finding["explanation"]
    mock_post.assert_called_once()


@pytest.mark.asyncio
async def test_free_text_and_structured_are_sent_to_the_model(app):
    """The user turn carries the free text to scrutinise and the structured context."""
    captured: dict = {}

    async def _capture(url, json=None, headers=None):  # noqa: A002 - mirrors httpx kwarg
        captured["payload"] = json
        return _llm_response('{"findings": []}')

    mock_post = AsyncMock(side_effect=_capture)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    user_turn = captured["payload"]["messages"][1]["content"]
    # Free text is present and labelled as the thing to scrutinise.
    assert "Free-text answers" in user_turn
    assert "eight-storey tower" in user_turn
    # Structured answers are present but marked read-only context.
    assert "read-only context" in user_turn
    assert "Building class: GK1" in user_turn


@pytest.mark.asyncio
async def test_consistency_check_empty_findings_when_consistent(app):
    """An empty findings array from the LLM surfaces as consistent ([], no error)."""
    mock_post = AsyncMock(return_value=_llm_response(json.dumps({"findings": []})))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": [], "error": None}


@pytest.mark.asyncio
async def test_consistency_check_tolerates_code_fenced_json(app):
    """Findings wrapped in a ```json fence are still parsed."""
    inner = json.dumps(
        {"findings": [{"fields": ["Tell Grid more"], "severity": "warning", "explanation": "Double-check."}]}
    )
    mock_post = AsyncMock(return_value=_llm_response(f"```json\n{inner}\n```"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    data = response.json()
    assert data["error"] is None
    assert len(data["findings"]) == 1
    assert data["findings"][0]["severity"] == "warning"


@pytest.mark.asyncio
async def test_consistency_check_defaults_invalid_severity_and_skips_bad_findings(app):
    """Unknown severities fall back to 'warning'; entries without an explanation are dropped."""
    content = json.dumps(
        {
            "findings": [
                {"fields": ["A"], "severity": "critical", "explanation": "Odd but present."},
                {"fields": ["B"], "severity": "inconsistency"},  # no explanation -> skipped
                {"severity": "warning", "explanation": "   "},  # blank explanation -> skipped
            ]
        }
    )
    mock_post = AsyncMock(return_value=_llm_response(content))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    data = response.json()
    assert len(data["findings"]) == 1
    assert data["findings"][0]["severity"] == "warning"
    assert data["findings"][0]["fields"] == ["A"]


@pytest.mark.asyncio
async def test_consistency_check_no_free_text_short_circuits(app):
    """No free-text answers -> nothing to scrutinise, no LLM call."""
    mock_post = AsyncMock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post(
                "/v1/consistency-check", json={"free_text": [], "structured": _STRUCTURED}
            )

    assert response.status_code == 200
    assert response.json() == {"findings": [], "error": None}
    mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_consistency_check_malformed_json_returns_error_and_null_findings(app):
    """Unparseable model output -> llm_response_malformed with findings=None."""
    mock_post = AsyncMock(return_value=_llm_response("Sorry, I cannot help with that."))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_response_malformed"}


@pytest.mark.asyncio
async def test_consistency_check_unexpected_shape_returns_malformed(app):
    """A response missing choices -> llm_response_malformed with findings=None."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"unexpected": True}
    mock_post = AsyncMock(return_value=mock_response)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_response_malformed"}


@pytest.mark.asyncio
async def test_consistency_check_llm_failure_returns_error(app):
    """A network failure is swallowed and returns llm_request_failed / null findings."""
    mock_post = AsyncMock(side_effect=httpx.RequestError("Connection refused"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_request_failed"}


@pytest.mark.asyncio
async def test_consistency_check_upstream_error_returns_error(app):
    """A non-2xx from the provider is swallowed and returns llm_request_failed."""
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
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_request_failed"}


@pytest.mark.asyncio
async def test_consistency_check_no_api_key_returns_not_configured(app, monkeypatch):
    """With no resolvable API key the route short-circuits without any HTTP call."""
    monkeypatch.delenv("CONSISTENCY_LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    mock_post = AsyncMock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/consistency-check", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_not_configured"}
    mock_post.assert_not_called()
