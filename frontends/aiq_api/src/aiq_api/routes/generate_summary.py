# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Project profile summary generation endpoint.

Calls an OpenAI-compatible chat completions endpoint to produce a concise
one-sentence project summary from the structured profile prompt view text
sent by the UI's ``/api/projects/[id]/generate-summary`` BFF route.
"""

import logging
import os

import httpx
from fastapi import APIRouter

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


def _llm_settings() -> tuple[str, str, str]:
    """Resolve the model/api_key/base_url for the summary LLM call.

    ``SUMMARY_LLM_*`` env vars take precedence, falling back to the generic
    ``LLM_*`` vars so a dedicated summarization model/provider can be
    configured independently of the main agent LLM if desired.
    """
    model = os.getenv("SUMMARY_LLM_MODEL", os.getenv("LLM_MODEL", "gpt-4o-mini"))
    api_key = os.getenv("SUMMARY_LLM_API_KEY", os.getenv("LLM_API_KEY", ""))
    base_url = os.getenv("SUMMARY_LLM_BASE_URL", os.getenv("LLM_BASE_URL", "https://api.openai.com/v1"))
    return model, api_key, base_url.rstrip("/")


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
    async def generate_summary(request: GenerateSummaryRequest) -> GenerateSummaryResponse:
        profile_text = request.profile_text.strip()
        if not profile_text:
            return GenerateSummaryResponse(summary="")

        model, api_key, base_url = _llm_settings()
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        payload = {
            "model": model,
            "temperature": 0.3,
            "max_tokens": 150,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": profile_text},
            ],
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()

            summary = data["choices"][0]["message"]["content"].strip()
            return GenerateSummaryResponse(summary=summary)
        except Exception:
            logger.exception("Failed to generate project summary")
            return GenerateSummaryResponse(summary="")
