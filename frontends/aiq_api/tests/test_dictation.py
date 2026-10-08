"""Voice dictation: the transcript cleanup and the ``/v1/dictation`` route.

The provider is a ``httpx.MockTransport``, so these tests pin what is sent
(no fixed language, the data policy, the fallback order) and what is booked.
What a real model does with mixed German and English audio is not something a
unit test can say; ``docs/architecture/voice-dictation.md`` lists it as open.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.common.credential_resolution import ResolvedCredential
from aiq_agent.common.openrouter import NO_RETENTION_LIMITS
from aiq_agent.common.openrouter import ZERO_DATA_RETENTION
from aiq_api.routes import dictation as route
from aiq_api.routes._dictation_text import clean_transcript

TOKEN = "test-internal-token"
AUDIO = b"\x1aE\xdf\xa3 fake webm bytes"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Äh, wir müssen das prüfen.", "Wir müssen das prüfen."),
        ("Das ist, äh, wichtig.", "Das ist wichtig."),
        ("Ich glaube, ähm, dass die OIB-Richtlinie 2 gilt.", "Ich glaube, dass die OIB-Richtlinie 2 gilt."),
        ("Um, I think the fire rating, uh, needs a check.", "I think the fire rating needs a check."),
        ("And, um, the Stiegenhaus needs, erm, a review.", "And the Stiegenhaus needs a review."),
        ("Ummm, let's go.", "Let's go."),
        ("Ja. Äh, gut.", "Ja. Gut."),
        ("Das passt, äh.", "Das passt."),
        ("Ich, äh, äh, weiß nicht.", "Ich weiß nicht."),
    ],
)
def test_fillers_are_removed(raw: str, expected: str):
    assert clean_transcript(raw) == expected


@pytest.mark.parametrize(
    "kept",
    [
        # "um" is a German preposition, with and without a comma after it.
        "Es geht um die Fluchtwege.",
        "Wir treffen uns um, sagen wir, acht Uhr.",
        # "eh", "er" and "mhm" are words.
        "Das ist eh schon klar, er kommt.",
        "Mhm, genau.",
        # Mixed languages pass through untouched.
        "Bitte prüf den Fire Safety Report für das Stiegenhaus.",
    ],
)
def test_words_that_look_like_fillers_stay(kept: str):
    assert clean_transcript(kept) == kept


@pytest.mark.parametrize(
    "silence", ["", "   ", "Äh... ähm.", "Untertitel im Auftrag des ZDF für funk, 2017", "[pause]", "(laughs) [MUSIC]"]
)
def test_silence_and_hallucinated_credits_insert_nothing(silence: str):
    assert clean_transcript(silence) == ""


def test_audio_event_tags_go_and_a_dictated_aside_stays():
    # Scribe writes "[pause]" over room noise (live test, 2026-10-08).
    assert clean_transcript("Bitte prüf [pause] das Stiegenhaus.") == "Bitte prüf das Stiegenhaus."
    assert clean_transcript("Prüf das Gutachten (Statik) und OIB [2].") == "Prüf das Gutachten (Statik) und OIB [2]."


def test_an_own_openai_key_is_sent_that_providers_own_model_names():
    assert route.dictation_models("https://api.openai.com/v1") == route.OWN_KEY_MODELS
    assert route.dictation_models("https://openrouter.ai/api/v1")[0] == route.DEFAULT_MODEL


def test_the_ui_language_picks_the_hint_and_never_a_fixed_language():
    assert route.wording_hint("en-GB") != route.wording_hint("de")
    assert route.wording_hint(None) == route.wording_hint("de")


def test_models_are_configurable_and_the_fallback_can_be_switched_off(monkeypatch):
    monkeypatch.setenv(route.MODEL_ENV, "vendor/primary")
    monkeypatch.setenv(route.FALLBACK_MODEL_ENV, "vendor/fallback")
    assert route.dictation_models() == ("vendor/primary", "vendor/fallback")
    monkeypatch.setenv(route.FALLBACK_MODEL_ENV, "")
    assert route.dictation_models() == ("vendor/primary",)


def test_the_platforms_key_is_always_pinned_and_an_own_key_follows_its_organization(monkeypatch):
    resolved: dict[str, ResolvedCredential] = {}
    monkeypatch.setattr(route, "resolve_llm_credential", lambda **_kwargs: resolved["cred"])

    resolved["cred"] = _credential(source="env", policy=NO_RETENTION_LIMITS)
    assert route._credential("org_1").data_policy == ZERO_DATA_RETENTION

    resolved["cred"] = _credential(source="byok", policy=NO_RETENTION_LIMITS)
    assert route._credential("org_1").data_policy == NO_RETENTION_LIMITS


# -- the route ----------------------------------------------------------------


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.delenv(route.MODEL_ENV, raising=False)
    monkeypatch.delenv(route.FALLBACK_MODEL_ENV, raising=False)
    application = FastAPI()
    router = APIRouter()
    route.add_dictation_routes(router)
    application.include_router(router)
    return application


def _credential(base_url: str = "https://openrouter.ai/api/v1", *, source: str = "env", policy=NO_RETENTION_LIMITS):
    return ResolvedCredential(api_key="sk-test", base_url=base_url, model="unused", source=source, data_policy=policy)


@pytest.fixture
def provider(monkeypatch):
    """Route every provider call to ``provider.reply``; record each request."""

    class Provider:
        requests: list[httpx.Request] = []
        replies: list[httpx.Response] = []
        credential = _credential()

    def handler(request: httpx.Request) -> httpx.Response:
        Provider.requests.append(request)
        return Provider.replies.pop(0)

    def client(**kwargs):
        kwargs.pop("cls", None)
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kwargs)

    Provider.requests = []
    Provider.replies = []
    monkeypatch.setattr(route, "limited_async_http_client", client)
    monkeypatch.setattr(route, "_credential", lambda _org: Provider.credential)
    booked: list[dict] = []
    monkeypatch.setattr("aiq_agent.common.cost_tracking._post_usage_events", booked.append)
    Provider.booked = booked
    return Provider


def _ok(text: str, **usage) -> httpx.Response:
    return httpx.Response(200, json={"text": text, "usage": usage}, headers={"x-generation-id": "gen-1"})


async def _post(app, body: dict | None = None, headers: dict | None = None) -> httpx.Response:
    payload = {"audio_base64": base64.b64encode(AUDIO).decode(), "format": "webm", "duration_ms": 4200, "locale": "de"}
    payload.update(body or {})
    sent_headers = {"x-grid-internal-token": TOKEN, "x-grid-organization-id": "org_1", "x-grid-user-id": "user_1"}
    sent_headers.update(headers or {})
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post("/v1/dictation", json=payload, headers=sent_headers)


async def _drain_ledger():
    # The cost is flushed on the tracker's background executor.
    from aiq_agent.common import cost_tracking

    cost_tracking._flush_executor.submit(lambda: None).result(timeout=5)


@pytest.mark.asyncio
async def test_a_transcript_comes_back_clean_and_its_cost_is_booked_as_dictation(app, provider):
    provider.replies = [_ok("Äh, prüf bitte das Stiegenhaus, the fire rating.", seconds=4.1, cost=0.0007)]

    response = await _post(app)

    assert response.status_code == 200
    assert response.json() == {
        "text": "Prüf bitte das Stiegenhaus, the fire rating.",
        "audio_seconds": 4.1,
        "model": route.DEFAULT_MODEL,
        "error": None,
    }
    sent = json.loads(provider.requests[0].content)
    assert provider.requests[0].url.path.endswith("/audio/transcriptions")
    assert sent["input_audio"] == {"data": base64.b64encode(AUDIO).decode(), "format": "webm"}
    assert "language" not in sent, "a fixed language would translate the other half of a mixed sentence"
    assert sent["provider"]["options"]["openai"]["prompt"] == route.wording_hint("de")

    await _drain_ledger()
    [batch] = provider.booked
    assert batch["activity"] == "dictation"
    assert batch["organizationId"] == "org_1"
    assert batch["userId"] == "user_1"
    [event] = batch["events"]
    assert event["role"] == "dictation"
    assert event["costUsd"] == 0.0007
    assert event["costSource"] == "usage_field"
    assert event["audioSeconds"] == 4.1


@pytest.mark.asyncio
async def test_the_organizations_data_policy_rides_on_the_body(app, provider):
    provider.credential = _credential(policy=ZERO_DATA_RETENTION)
    provider.replies = [_ok("Hallo.")]

    await _post(app)

    routing = json.loads(provider.requests[0].content)["provider"]
    assert routing["zdr"] is True
    assert routing["data_collection"] == "deny"
    assert "options" in routing


@pytest.mark.asyncio
async def test_the_fallback_is_tried_only_after_the_primary_failed(app, provider):
    provider.replies = [httpx.Response(503, json={"error": "busy"}), _ok("Fallback text.")]

    response = await _post(app)

    assert response.json()["text"] == "Fallback text."
    assert response.json()["model"] == route.DEFAULT_FALLBACK_MODEL
    models = [json.loads(r.content)["model"] for r in provider.requests]
    assert models == [route.DEFAULT_MODEL, route.DEFAULT_FALLBACK_MODEL]


@pytest.mark.asyncio
async def test_a_working_primary_never_reaches_the_fallback(app, provider):
    provider.replies = [_ok("Primary.")]
    await _post(app)
    assert len(provider.requests) == 1


@pytest.mark.asyncio
async def test_both_models_failing_is_an_error_code_not_a_crash(app, provider):
    provider.replies = [httpx.Response(500), httpx.Response(200, json={"no": "text"})]

    response = await _post(app)

    assert response.status_code == 200
    assert response.json()["error"] == "transcription_failed"
    assert response.json()["text"] == ""
    await _drain_ledger()
    assert provider.booked == []


@pytest.mark.asyncio
async def test_silence_returns_empty_text_without_an_error(app, provider):
    provider.replies = [_ok("", seconds=2.0)]
    response = await _post(app)
    assert response.json()["text"] == ""
    assert response.json()["error"] is None


@pytest.mark.asyncio
async def test_an_own_openai_key_gets_the_multipart_contract(app, provider):
    provider.credential = _credential("https://api.openai.com/v1", source="byok")
    provider.replies = [_ok("Own key.")]

    response = await _post(app, {"format": "m4a"})

    assert response.json()["text"] == "Own key."
    request = provider.requests[0]
    assert request.headers["content-type"].startswith("multipart/form-data")
    body = request.content.decode("latin-1")
    assert f'name="model"\r\n\r\n{route.OWN_KEY_MODELS[0]}' in body
    assert "audio/mp4" in body
    assert 'name="language"' not in body
    await _drain_ledger()
    [event] = provider.booked[0]["events"]
    assert event["isByok"] is True
    assert event["costSource"] == "missing"
    assert event["audioSeconds"] == 4.2, "the browser's measurement stands in when the provider reports none"


@pytest.mark.asyncio
async def test_no_credential_says_so(app, provider):
    provider.credential = ResolvedCredential(
        api_key="", base_url="https://openrouter.ai/api/v1", model="x", source="none"
    )
    response = await _post(app)
    assert response.json()["error"] == "transcription_not_configured"
    assert provider.requests == []


@pytest.mark.asyncio
async def test_audio_that_is_not_base64_is_refused_before_any_provider_call(app, provider):
    response = await _post(app, {"audio_base64": "not base64 at all!"})
    assert response.json()["error"] == "audio_invalid"
    assert provider.requests == []


@pytest.mark.asyncio
async def test_the_internal_token_is_required(app, provider):
    response = await _post(app, headers={"x-grid-internal-token": "wrong"})
    assert response.status_code == 403
    assert provider.requests == []
