"""Project profile summary generation endpoint.

Calls an OpenAI-compatible chat completions endpoint to produce a concise
one-sentence project summary from the structured profile prompt view text
sent by the UI's ``/api/projects/[id]/generate-summary`` BFF route.
"""

import logging
import os

import httpx
from fastapi import APIRouter
from fastapi import Header

from ..models.requests import GenerateSummaryRequest
from ..models.requests import GenerateSummaryResponse

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a project summarizer for an architectural design platform. "
    "Given the following structured project profile data, generate ONE concise "
    "sentence that describes the project. Focus on the main purpose, key "
    "characteristics, and primary goals. Write in a professional, natural tone. "
    "Do not use bullet points, lists, or markdown. Output only the summary sentence."
)


def _llm_settings(organization_id: str | None = None) -> tuple[str, str, str]:
    """Resolve the model/api_key/base_url for the summary LLM call.

    Goes through the shared credential resolver so this route reaches the org's
    BYOK credential like every other LLM call, then the same env chain as before:
    ``SUMMARY_LLM_*`` → generic ``LLM_*`` → the OpenRouter/OpenAI default used by
    ``config_oib_openrouter.yml`` (without which every summary silently degrades
    to ""). Model + base URL keep their two-level env fallback; the resolver adds
    BYOK (org key + base, model unchanged) and provider inference on top.
    Fail-open: a BYOK miss falls back to the env chain.
    """
    from aiq_agent.common.credential_resolution import resolve_llm_credential

    openrouter_key = os.getenv("OPENROUTER_API_KEY", "")
    default_model = "deepseek/deepseek-v4-flash" if openrouter_key else "gpt-4o-mini"
    default_base = "https://openrouter.ai/api/v1" if openrouter_key else "https://api.openai.com/v1"

    model = os.getenv("SUMMARY_LLM_MODEL", os.getenv("LLM_MODEL", default_model))
    base_url = os.getenv("SUMMARY_LLM_BASE_URL", os.getenv("LLM_BASE_URL", default_base))

    cred = resolve_llm_credential(
        primary_env="SUMMARY_LLM_API_KEY",
        fallback_envs=("LLM_API_KEY", "OPENROUTER_API_KEY"),
        default_base_url=base_url,
        default_model=model,
        organization_id=organization_id,
    )
    if not cred.api_key:
        logger.warning(
            "No API key for summary LLM (BYOK / SUMMARY_LLM_API_KEY / LLM_API_KEY / OPENROUTER_API_KEY)"
        )
    return cred.model, cred.api_key, cred.base_url


def add_generate_summary_routes(router: APIRouter) -> None:
    """Register the generate-summary endpoint."""

    @router.post(
        "/v1/generate-summary",
        response_model=GenerateSummaryResponse,
        tags=["projects"],
        summary="Generate an AI project summary from profile data",
        description=(
            "Calls an LLM to produce a concise one-sentence project summary "
            "from the structured profile prompt view text."
        ),
    )
    async def generate_summary(
        request: GenerateSummaryRequest,
        # Forwarded by the BFF (profile-service) so this route can reach the
        # org's BYOK LLM credential; absent for anonymous/direct callers.
        x_grid_organization_id: str | None = Header(default=None),
    ) -> GenerateSummaryResponse:
        profile_text = request.profile_text.strip()
        if not profile_text:
            return GenerateSummaryResponse(summary="")

        model, api_key, base_url = _llm_settings(x_grid_organization_id)
        if not api_key:
            # No credentials resolved — do not send a request that is guaranteed
            # to fail (401/403). Surface a diagnosable code instead.
            return GenerateSummaryResponse(summary="", error="llm_not_configured")

        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}

        # Mirrors consistency_check.py so both endpoints localise identically.
        language = "German" if request.locale.lower().startswith("de") else "English"
        user_content = f"Write the summary in {language}.\n\n{profile_text}"

        payload = {
            "model": model,
            "temperature": 0.3,
            "max_tokens": 150,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "Summary LLM returned an error status: %s (%s)",
                exc.response.status_code if exc.response is not None else "unknown",
                type(exc).__name__,
            )
            return GenerateSummaryResponse(summary="", error="llm_request_failed")
        except httpx.RequestError as exc:
            logger.warning("Summary LLM request failed: %s", type(exc).__name__)
            return GenerateSummaryResponse(summary="", error="llm_request_failed")
        except Exception:
            logger.exception("Unexpected error calling summary LLM")
            return GenerateSummaryResponse(summary="", error="llm_request_failed")

        try:
            summary = data["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, AttributeError, TypeError):
            logger.warning("Summary LLM response had an unexpected shape")
            return GenerateSummaryResponse(summary="", error="llm_response_malformed")

        return GenerateSummaryResponse(summary=summary)
