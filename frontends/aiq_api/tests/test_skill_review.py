"""Tests for the Agent Skill (SKILL.md) review endpoint."""

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

from aiq_api.routes.skill_review import MAX_FINDINGS
from aiq_api.routes.skill_review import MAX_FIX_CHARS
from aiq_api.routes.skill_review import MAX_MESSAGE_CHARS
from aiq_api.routes.skill_review import add_skill_review_routes


@pytest.fixture
def app():
    """Create a FastAPI app with the skill-review route registered."""
    app = FastAPI()
    router = APIRouter()
    add_skill_review_routes(router)
    app.include_router(router)
    return app


@pytest.fixture(autouse=True)
def _configured_llm_key(monkeypatch):
    """Ensure an API key is resolved so the route does not short-circuit.

    Tests that assert the no-key path override this explicitly.
    """
    monkeypatch.setenv("SKILL_REVIEW_LLM_API_KEY", "test-key")


def _fake_async_client(post_mock):
    """Build a stand-in for ``httpx.AsyncClient`` whose ``.post`` is ``post_mock``.

    Mirrors ``test_consistency_check.py``: patching the class (not
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


def _body(**overrides):
    body = {
        "name": "oib-checker",
        "description": "Prüft Projekte.",
        "body": "## Ablauf\n1. Lade das Profil.\n2. Vergleiche mit OIB 2.",
    }
    body.update(overrides)
    return body


@pytest.mark.asyncio
async def test_skill_review_returns_findings(app):
    """Findings reported by the LLM are parsed into structured entries."""
    content = json.dumps(
        {
            "findings": [
                {
                    "severity": "error",
                    "field": "description",
                    "message": "Die Beschreibung sagt nicht, WANN der Skill zu verwenden ist.",
                    "fix": "Ergänze: 'Verwende diesen Skill, wenn ...'",
                }
            ]
        }
    )
    mock_post = AsyncMock(return_value=_llm_response(content))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    data = response.json()
    assert data["error"] is None
    assert len(data["findings"]) == 1
    finding = data["findings"][0]
    assert finding["severity"] == "error"
    assert finding["field"] == "description"
    assert "WANN" in finding["message"]
    assert finding["fix"].startswith("Ergänze")
    mock_post.assert_called_once()


@pytest.mark.asyncio
async def test_skill_is_sent_to_the_model(app):
    """The user turn carries all three parts of the SKILL.md plus the language rule."""
    captured: dict = {}

    async def _capture(url, json=None, headers=None):  # noqa: A002 - mirrors httpx kwarg
        captured["payload"] = json
        return _llm_response('{"findings": []}')

    mock_post = AsyncMock(side_effect=_capture)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    user_turn = captured["payload"]["messages"][1]["content"]
    assert "oib-checker" in user_turn
    assert "Prüft Projekte." in user_turn
    assert "Vergleiche mit OIB 2." in user_turn
    # German-facing product: the reviewer must answer in the skill's language.
    assert "SAME LANGUAGE" in user_turn


@pytest.mark.asyncio
async def test_skill_review_empty_findings_when_skill_is_good(app):
    """An empty findings array surfaces as "nothing to change" ([], no error)."""
    mock_post = AsyncMock(return_value=_llm_response(json.dumps({"findings": []})))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": [], "error": None}


@pytest.mark.asyncio
async def test_unknown_severity_or_field_is_dropped_not_fatal(app):
    """A malformed entry loses only itself — the surrounding findings survive.

    Severity and field drive which control the editor highlights, so a value
    outside the vocabulary is dropped rather than coerced to a default that
    would point the author at the wrong part of their skill.
    """
    content = json.dumps(
        {
            "findings": [
                {"severity": "critical", "field": "name", "message": "Unknown severity.", "fix": "x"},
                {"severity": "warning", "field": "frontmatter", "message": "Unknown field.", "fix": "x"},
                {"severity": "warning", "field": "body", "message": "   ", "fix": "x"},  # blank message
                "not an object",
                {
                    "severity": "suggestion",
                    "field": "body",
                    "message": "Schritte konkretisieren.",
                    "fix": "Nummeriere.",
                },
            ]
        }
    )
    mock_post = AsyncMock(return_value=_llm_response(content))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    data = response.json()
    assert data["error"] is None
    assert len(data["findings"]) == 1
    assert data["findings"][0]["severity"] == "suggestion"
    assert data["findings"][0]["field"] == "body"


@pytest.mark.asyncio
async def test_missing_fix_becomes_empty_string(app):
    """A finding without a usable fix is still shown, with an empty fix."""
    content = json.dumps({"findings": [{"severity": "warning", "field": "name", "message": "Name ist zu allgemein."}]})
    mock_post = AsyncMock(return_value=_llm_response(content))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    data = response.json()
    assert len(data["findings"]) == 1
    assert data["findings"][0]["fix"] == ""


@pytest.mark.asyncio
async def test_findings_are_capped(app):
    """A reviewer that returns forty findings is nagging; the list is clamped."""
    content = json.dumps(
        {
            "findings": [
                {"severity": "suggestion", "field": "body", "message": f"Hinweis {index}", "fix": "Ändere etwas."}
                for index in range(40)
            ]
        }
    )
    mock_post = AsyncMock(return_value=_llm_response(content))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    data = response.json()
    assert len(data["findings"]) == MAX_FINDINGS


@pytest.mark.asyncio
async def test_long_message_and_fix_are_truncated(app):
    """One runaway generation cannot bloat a response the editor renders inline."""
    content = json.dumps(
        {"findings": [{"severity": "warning", "field": "body", "message": "a" * 5000, "fix": "b" * 5000}]}
    )
    mock_post = AsyncMock(return_value=_llm_response(content))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    finding = response.json()["findings"][0]
    assert len(finding["message"]) == MAX_MESSAGE_CHARS
    assert len(finding["fix"]) == MAX_FIX_CHARS


@pytest.mark.asyncio
async def test_empty_draft_short_circuits(app):
    """A blank form has nothing to review — no LLM call."""
    mock_post = AsyncMock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json={"name": "", "description": "", "body": "  "})

    assert response.status_code == 200
    assert response.json() == {"findings": [], "error": None}
    mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_skill_review_tolerates_code_fenced_json(app):
    """Findings wrapped in a ```json fence are still parsed."""
    inner = json.dumps(
        {"findings": [{"severity": "warning", "field": "description", "message": "Zu vage.", "fix": "Konkretisiere."}]}
    )
    mock_post = AsyncMock(return_value=_llm_response(f"```json\n{inner}\n```"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    data = response.json()
    assert data["error"] is None
    assert len(data["findings"]) == 1


@pytest.mark.asyncio
async def test_malformed_json_returns_error_and_null_findings(app):
    """Unparseable model output -> llm_response_malformed with findings=None."""
    mock_post = AsyncMock(return_value=_llm_response("Sorry, I cannot help with that."))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_response_malformed"}


@pytest.mark.asyncio
async def test_unexpected_shape_returns_malformed(app):
    """A response missing choices -> llm_response_malformed with findings=None."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"unexpected": True}
    mock_post = AsyncMock(return_value=mock_response)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_response_malformed"}


@pytest.mark.asyncio
async def test_transport_failure_returns_error(app):
    """A network failure is swallowed and returns llm_request_failed / null findings."""
    mock_post = AsyncMock(side_effect=httpx.RequestError("Connection refused"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_request_failed"}


@pytest.mark.asyncio
async def test_upstream_error_returns_error(app):
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
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_request_failed"}


@pytest.mark.asyncio
async def test_no_api_key_returns_not_configured(app, monkeypatch):
    """With no resolvable API key the route short-circuits without any HTTP call."""
    monkeypatch.delenv("SKILL_REVIEW_LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    mock_post = AsyncMock()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/skills/review", json=_body())

    assert response.status_code == 200
    assert response.json() == {"findings": None, "error": "llm_not_configured"}
    mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_byok_credential_from_request_body(app, monkeypatch):
    """The editor posts organization_id in the body, so BYOK works without the header."""
    from aiq_agent.common.llm_credentials import OrgLLMCredential

    monkeypatch.delenv("SKILL_REVIEW_LLM_API_KEY", raising=False)
    monkeypatch.setenv("OPENROUTER_API_KEY", "platform-key")

    byok = OrgLLMCredential(
        credential_id="cred-1",
        provider="openrouter",
        base_url="https://tenant.example.com/v1",
        api_key="sk-tenant",
        key_fingerprint="fp",
    )

    captured: dict = {}

    async def _capture(url, json=None, headers=None):  # noqa: A002 - mirrors httpx kwarg
        captured["url"] = url
        captured["headers"] = headers
        return _llm_response('{"findings": []}')

    mock_post = AsyncMock(side_effect=_capture)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("aiq_agent.common.llm_credentials.resolve_org_llm_credential", return_value=byok):
            with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
                response = await client.post("/v1/skills/review", json=_body(organization_id="org-1"))

    assert response.status_code == 200
    assert captured["url"] == "https://tenant.example.com/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer sk-tenant"


@pytest.mark.asyncio
async def test_env_fallback_when_byok_absent(app, monkeypatch):
    """With an org id but no BYOK credential, the route falls back to the env chain."""
    monkeypatch.setenv("SKILL_REVIEW_LLM_API_KEY", "env-key")

    captured: dict = {}

    async def _capture(url, json=None, headers=None):  # noqa: A002 - mirrors httpx kwarg
        captured["headers"] = headers
        return _llm_response('{"findings": []}')

    mock_post = AsyncMock(side_effect=_capture)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("aiq_agent.common.llm_credentials.resolve_org_llm_credential", return_value=None):
            with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
                response = await client.post(
                    "/v1/skills/review", json=_body(), headers={"x-grid-organization-id": "org-1"}
                )

    assert response.status_code == 200
    assert captured["headers"]["Authorization"] == "Bearer env-key"
