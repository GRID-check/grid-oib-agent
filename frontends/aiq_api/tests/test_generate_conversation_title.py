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


def _title_response(content: str, finish_reason: str = "stop"):
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.raise_for_status = MagicMock()
    mock_response.json.return_value = {"choices": [{"message": {"content": content}, "finish_reason": finish_reason}]}
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
            '{"title": "Brandschutz bei Stiegenhäusern", "tags": ["brandschutz", "brandschutz", "unknown-tag"]}'
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
async def test_parses_json_in_unterminated_code_fence(app):
    """The token cap eats the CLOSING fence first. An opening fence with no
    closing one must still be stripped rather than read as "not fenced"."""
    mock_post = AsyncMock(
        return_value=_title_response('```json\n{"title": "Schallschutz Wohnbau", "tags": ["schallschutz"]}')
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.json()["title"] == "Schallschutz Wohnbau"


@pytest.mark.asyncio
async def test_parses_json_surrounded_by_prose(app):
    """Preamble AND a trailing sentence containing a brace. The old
    first-`{`-to-last-`}` slice swallowed the trailing text into the object and
    failed to decode it; the span must end at the object's own closing brace."""
    mock_post = AsyncMock(
        return_value=_title_response(
            "Sure! Here is the JSON you asked for:\n"
            '{"title": "Brandschutz Stiegenhaus", "tags": ["brandschutz"]}\n'
            "Hope that helps :}"
        )
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    data = response.json()
    assert data["title"] == "Brandschutz Stiegenhaus"
    assert data["tags"] == ["brandschutz"]
    assert data["error"] is None


@pytest.mark.asyncio
async def test_brace_inside_title_does_not_end_the_object(app):
    """A `}` inside a string value is data, not the end of the object."""
    mock_post = AsyncMock(
        return_value=_title_response('{"title": "Regel {OIB 2} für Stiegen", "tags": ["brandschutz"]}')
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    data = response.json()
    assert data["title"] == "Regel {OIB 2} für Stiegen"
    assert data["tags"] == ["brandschutz"]


@pytest.mark.asyncio
async def test_reply_truncated_mid_title_is_recovered(app):
    """THE issue-#233 regression: the completion cap cut the reply off mid-string.

    The JSON prefix was well-formed, so closing the string and the object
    recovers a usable (if clipped) name — a cosmetic title must not be reported
    as a failure because the model ran out of budget one word early."""
    mock_post = AsyncMock(
        return_value=_title_response('{"title": "Brandschutzanforderungen für Stiegen', finish_reason="length")
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    data = response.json()
    assert data["title"] == "Brandschutzanforderungen für Stiegen"
    assert data["tags"] == []
    assert data["error"] is None


@pytest.mark.asyncio
async def test_reply_truncated_mid_tag_list_is_recovered(app):
    """Same cut, landing inside the tag array — the title is still recoverable."""
    mock_post = AsyncMock(
        return_value=_title_response('{"title": "Brandschutz Stiegen", "tags": ["brandschutz", "sta', "length")
    )

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    data = response.json()
    assert data["title"] == "Brandschutz Stiegen"
    # "sta" was cut mid-word and is not in the allow-list, so it is dropped.
    assert data["tags"] == ["brandschutz"]
    assert data["error"] is None


@pytest.mark.asyncio
async def test_reply_truncated_after_a_trailing_comma_is_recovered(app):
    """A cut landing right after a comma leaves a dangling separator."""
    mock_post = AsyncMock(return_value=_title_response('{"title": "Brandschutz Stiegen", ', "length"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.json()["title"] == "Brandschutz Stiegen"


@pytest.mark.asyncio
async def test_bare_title_string_is_not_accepted_as_a_title(app):
    """The parser must stay honest: a reply with NO JSON object in it is a
    failure, not a title. Accepting the model's prose would happily name a chat
    "Es tut mir leid, das kann ich nicht" the first time it declines."""
    mock_post = AsyncMock(return_value=_title_response("Brandschutz bei Stiegenhäusern"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.json() == {"title": "", "tags": [], "error": "llm_response_malformed"}


@pytest.mark.asyncio
async def test_truncated_beyond_repair_is_still_reported(app):
    """A cut landing on a bare key cannot be closed into valid JSON. Nothing is
    invented to paper over it — the caller keeps its provisional title."""
    mock_post = AsyncMock(return_value=_title_response('{"title":', "length"))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.json() == {"title": "", "tags": [], "error": "llm_response_malformed"}


@pytest.mark.asyncio
async def test_request_constrains_the_endpoint_to_json(app):
    """Prevention half of the fix: the endpoint is asked for a JSON object, and
    the completion budget leaves room for whatever the model emits first."""
    mock_post = AsyncMock(return_value=_title_response('{"title": "Brandschutz", "tags": []}'))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            await client.post("/v1/generate-conversation-title", json=_BODY)

    payload = mock_post.call_args.kwargs["json"]
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["max_tokens"] >= 300


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
async def test_null_choices_returns_malformed_not_500(app):
    """An OpenAI-compatible 200 with `choices: null` (an OpenRouter failure mode)
    must degrade to an llm_response_malformed 200, not raise a 500. Indexing
    ``None[0]`` raises TypeError, which the handler must also catch."""
    null_choices = MagicMock(spec=httpx.Response)
    null_choices.status_code = 200
    null_choices.raise_for_status = MagicMock()
    null_choices.json.return_value = {"choices": None}
    mock_post = AsyncMock(return_value=null_choices)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_async_client(mock_post)):
            response = await client.post("/v1/generate-conversation-title", json=_BODY)

    assert response.status_code == 200
    assert response.json() == {"title": "", "tags": [], "error": "llm_response_malformed"}


@pytest.mark.asyncio
async def test_null_content_returns_malformed_not_500(app):
    """A 200 with ``message.content = null`` (a reasoning-only reply) must degrade
    to llm_response_malformed, not raise AttributeError on ``None.strip()`` → 500."""
    mock_post = AsyncMock(return_value=_title_response(None))

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
