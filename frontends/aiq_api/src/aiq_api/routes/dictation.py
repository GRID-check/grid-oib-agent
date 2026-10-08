"""Voice dictation: one recorded utterance in, clean composer text out.

Backs the BFF's ``POST /api/dictation`` (``frontends/ui/src/lib/dictation``),
which authenticates the member, bounds the audio and rate-limits the call
before it reaches this route. Design and what is still unverified:
``docs/architecture/voice-dictation.md``.

**A dedicated transcription endpoint, not a chat model.** The audio goes to
``/audio/transcriptions``, which takes the browser's own containers (WebM, Ogg,
MP4/AAC), returns the duration and the cost, and cannot follow an instruction
spoken into the microphone the way a chat model given the audio could.
Fillers the model leaves in are removed afterwards by
:func:`._dictation_text.clean_transcript`, which does not depend on the model.

**The language is never fixed.** A sentence that mixes German and English must
come back exactly as spoken, so no ``language`` is sent. The member's UI
language chooses only the wording hint (:func:`wording_hint`), a sample of
clean, mixed-language text that the provider may use as a style prompt.

**The organization's credential, the platform's limiter.** The endpoint is
resolved by :func:`~aiq_agent.common.credential_resolution.resolve_llm_credential`,
so an organization's own key (BYOK) is used exactly as for every other call. On
the platform's key the body is pinned to zero data retention, because the
platform fixes the model (:func:`_credential`). Every attempt queues for a
provider slot (ADR-0081).

**Fail open, always 200.** Every failure is an ``error`` code the composer turns
into its inline error; the chat around it is untouched. The fallback model is
tried only when the primary attempt failed.

**Recorded, never billed.** A transcript's real cost lands on the ledger as
``activity = 'dictation'`` with its audio length. The BFF prices those rows at
nothing and keeps them out of the rollup the budgets read.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import math
import os
from dataclasses import dataclass
from dataclasses import replace
from typing import Any

import httpx
from fastapi import APIRouter
from fastapi import Header
from fastapi import Request

from aiq_agent.common import provider_limiter
from aiq_agent.common.cost_tracking import USAGE_ACTIVITY_DICTATION
from aiq_agent.common.cost_tracking import USAGE_ROLE_DICTATION
from aiq_agent.common.cost_tracking import GridCostTracker
from aiq_agent.common.cost_tracking import UsageEvent
from aiq_agent.common.credential_resolution import ResolvedCredential
from aiq_agent.common.credential_resolution import read_api_key_env
from aiq_agent.common.credential_resolution import resolve_llm_credential
from aiq_agent.common.openrouter import PLATFORM_FIXED
from aiq_agent.common.openrouter import limited_async_http_client
from aiq_agent.common.openrouter import targets_openrouter

from ..models.requests import MAX_DICTATION_AUDIO_BYTES
from ..models.requests import DictationRequest
from ..models.requests import DictationResponse
from ._dictation_text import clean_transcript
from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)

MODEL_ENV = "GRID_DICTATION_MODEL"
FALLBACK_MODEL_ENV = "GRID_DICTATION_FALLBACK_MODEL"
#: Chosen in a live test (2026-10-08, ten synthetic mixed German/English clips,
#: ``docs/architecture/voice-dictation.md``): Scribe kept every mixed sentence
#: as spoken; Whisper Turbo is a different provider, so the two fail apart.
#: Both have zero-data-retention endpoints, which the platform's pin requires;
#: ``openai/gpt-4o-transcribe`` has none and failed every pinned call.
DEFAULT_MODEL = "elevenlabs/scribe-v2"
DEFAULT_FALLBACK_MODEL = "openai/whisper-large-v3-turbo"
#: What an organization on its own OpenAI-compatible key is sent instead: the
#: models above are OpenRouter ids that mean nothing at ``api.openai.com``.
OWN_KEY_MODELS = ("gpt-4o-transcribe", "whisper-1")

_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
_OPENAI_BASE = "https://api.openai.com/v1"

#: One attempt's ceiling. Two attempts stay inside the BFF's 60 s timeout.
_ATTEMPT_TIMEOUT_SECONDS = 25.0

_MIME_TYPES = {"webm": "audio/webm", "ogg": "audio/ogg", "m4a": "audio/mp4"}

#: Style prompts: clean, punctuated, mixed-language sample text with no fillers.
#: A transcription prompt is text the model continues, not an instruction it
#: obeys. Whether OpenRouter forwards it (as ``provider.options``) is unverified.
_WORDING_HINTS = {
    "de": "Okay, wir prüfen das laut OIB-Richtlinie 2. The fire rating of the Stiegenhaus needs a review.",
    "en": "Okay, we check this against OIB-Richtlinie 2. Das Stiegenhaus braucht noch eine Prüfung.",
}
#: Providers whose options carry the prompt on OpenRouter's JSON path.
_PROMPT_PROVIDER_SLUGS = ("openai", "groq")


@dataclass(frozen=True)
class Transcription:
    """What one successful provider call returned."""

    text: str
    model: str
    audio_seconds: float | None
    cost_usd: float | None
    is_byok: bool | None
    generation_id: str | None
    input_tokens: int
    output_tokens: int


def dictation_models(base_url: str | None = None) -> tuple[str, ...]:
    """The primary model, then the fallback; an empty fallback env disables it.

    Off OpenRouter (an organization's own OpenAI-compatible key) it is
    :data:`OWN_KEY_MODELS`, that provider's own names.
    """
    if base_url is not None and not targets_openrouter(base_url):
        return OWN_KEY_MODELS
    primary = os.getenv(MODEL_ENV, "").strip() or DEFAULT_MODEL
    fallback = os.getenv(FALLBACK_MODEL_ENV, DEFAULT_FALLBACK_MODEL).strip()
    return (primary,) if not fallback or fallback == primary else (primary, fallback)


def wording_hint(locale: str | None) -> str:
    """The style prompt for the member's UI language (German unless it is English)."""
    return _WORDING_HINTS["en" if (locale or "").lower().startswith("en") else "de"]


def _credential(organization_id: str | None) -> ResolvedCredential:
    """The organization's endpoint: its own key when it has one, else the platform's.

    The platform fixes the dictation model, so on the platform's key the call is
    pinned to zero data retention like every platform-fixed model
    (``openrouter.PLATFORM_FIXED``), whatever the organization's setting. An
    organization on its own key follows its own policy, as every BYOK call does.
    """
    base_url = _OPENROUTER_BASE if read_api_key_env("OPENROUTER_API_KEY") else _OPENAI_BASE
    cred = resolve_llm_credential(
        primary_env="",
        default_base_url=base_url,
        default_model=dictation_models()[0],
        organization_id=organization_id,
    )
    return cred if cred.source == "byok" else replace(cred, data_policy=PLATFORM_FIXED)


async def _post_audio(
    client: httpx.AsyncClient, cred: ResolvedCredential, model: str, audio: bytes, audio_format: str, hint: str
) -> httpx.Response:
    """POST the audio in the shape the endpoint takes: JSON on OpenRouter, multipart elsewhere."""
    url = f"{cred.base_url}/audio/transcriptions"
    headers = {"Authorization": f"Bearer {cred.api_key}"}
    if targets_openrouter(cred.base_url):
        body = cred.request_body(
            {
                "model": model,
                "input_audio": {"data": base64.b64encode(audio).decode("ascii"), "format": audio_format},
                "temperature": 0,
                "provider": {"options": {slug: {"prompt": hint} for slug in _PROMPT_PROVIDER_SLUGS}},
            }
        )
        return await client.post(url, json=body, headers=headers)
    # An organization on its own OpenAI-compatible key: the provider's
    # multipart contract. Azure's deployment paths are not covered.
    form = cred.request_body({"model": model, "prompt": hint, "temperature": "0", "response_format": "json"})
    files = {"file": (f"dictation.{audio_format}", audio, _MIME_TYPES[audio_format])}
    return await client.post(url, data=form, files=files, headers=headers)


def _number(value: Any) -> float | None:
    """A finite, non-negative number, or None. ``bool`` is not a number here."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) and value >= 0 else None


def parse_transcription(data: Any, *, model: str, own_key: bool, generation_id: str | None) -> Transcription:
    """Read a transcription response. Raises ``ValueError`` when it carries no text field."""
    if not isinstance(data, dict) or not isinstance(data.get("text"), str):
        raise ValueError("transcription response has no text")
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    reported_byok = usage.get("is_byok")
    return Transcription(
        text=data["text"],
        model=model,
        audio_seconds=_number(usage.get("seconds")) or _number(data.get("duration")),
        cost_usd=_number(usage.get("cost")),
        # The organization's own key paid, whatever OpenRouter's flag says
        # about OpenRouter-level BYOK: the platform's cost excludes it.
        is_byok=True if own_key else (reported_byok if isinstance(reported_byok, bool) else None),
        generation_id=generation_id,
        input_tokens=int(_number(usage.get("input_tokens")) or 0),
        output_tokens=int(_number(usage.get("output_tokens")) or 0),
    )


async def _attempt(cred: ResolvedCredential, model: str, audio: bytes, audio_format: str, hint: str):
    """One model's attempt. ``None`` on any failure, logged with its cause."""
    try:
        async with limited_async_http_client(
            cls=provider_limiter.INTERACTIVE, timeout=_ATTEMPT_TIMEOUT_SECONDS
        ) as client:
            response = await _post_audio(client, cred, model, audio, audio_format, hint)
            response.raise_for_status()
            data = response.json()
        return parse_transcription(
            data,
            model=model,
            own_key=cred.source == "byok",
            generation_id=response.headers.get("x-generation-id"),
        )
    except httpx.HTTPStatusError as exc:
        logger.warning("Dictation model %s returned HTTP %s", model, exc.response.status_code)
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Dictation model %s failed: %s", model, type(exc).__name__)
    return None


async def transcribe(cred: ResolvedCredential, audio: bytes, audio_format: str, hint: str) -> Transcription | None:
    """The primary model's transcript, or the fallback's when the primary failed."""
    for model in dictation_models(cred.base_url):
        result = await _attempt(cred, model, audio, audio_format, hint)
        if result is not None:
            return result
    return None


def record_dictation_cost(
    organization_id: str | None, user_id: str | None, result: Transcription, duration_ms: int | None
) -> None:
    """Put the call's real cost and audio length on the ledger, in the background."""
    if not organization_id:
        return
    seconds = result.audio_seconds if result.audio_seconds is not None else (duration_ms or 0) / 1000
    tracker = GridCostTracker(organization_id=organization_id, user_id=user_id, activity=USAGE_ACTIVITY_DICTATION)
    tracker.record(
        UsageEvent(
            model=result.model,
            requested_model=result.model,
            generation_id=result.generation_id,
            prompt_tokens=result.input_tokens,
            completion_tokens=result.output_tokens,
            total_tokens=result.input_tokens + result.output_tokens,
            cached_tokens=0,
            reasoning_tokens=0,
            cost_usd=result.cost_usd or 0.0,
            cost_source="usage_field" if result.cost_usd is not None else "missing",
            is_byok=result.is_byok,
            role=USAGE_ROLE_DICTATION,
            audio_seconds=round(seconds, 2),
        )
    )
    tracker.flush(wait=False)


def _decode_audio(audio_base64: str) -> bytes | str:
    """The recording's bytes, or the error code for why there are none."""
    try:
        audio = base64.b64decode(audio_base64, validate=True)
    except (binascii.Error, ValueError):
        return "audio_invalid"
    if not audio:
        return "audio_invalid"
    return audio if len(audio) <= MAX_DICTATION_AUDIO_BYTES else "audio_too_large"


def add_dictation_routes(router: APIRouter) -> None:
    """Register the dictation endpoint."""

    @router.post(
        "/v1/dictation",
        response_model=DictationResponse,
        tags=["conversations"],
        summary="Transcribe one dictated utterance for the chat composer",
        description="Transcribes recorded audio without fixing its language and removes filler sounds.",
    )
    async def dictation(
        request: DictationRequest,
        http_request: Request,
        x_grid_organization_id: str | None = Header(default=None),
        x_grid_user_id: str | None = Header(default=None),
    ) -> DictationResponse:
        _require_internal_token(http_request)
        audio = _decode_audio(request.audio_base64)
        if isinstance(audio, str):
            return DictationResponse(error=audio)

        cred = await asyncio.to_thread(_credential, x_grid_organization_id)
        if not cred.api_key:
            return DictationResponse(error="transcription_not_configured")

        result = await transcribe(cred, audio, request.format, wording_hint(request.locale))
        if result is None:
            return DictationResponse(error="transcription_failed")

        record_dictation_cost(x_grid_organization_id, x_grid_user_id, result, request.duration_ms)
        return DictationResponse(
            text=clean_transcript(result.text), audio_seconds=result.audio_seconds, model=result.model
        )
