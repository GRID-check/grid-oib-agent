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

Calls an LLM to produce a concise one-sentence project summary
from the structured profile prompt view text.
"""

import logging
import os

from fastapi import APIRouter
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "You are a project summarizer for an architectural design platform. "
    "Given the following structured project profile data, generate ONE concise "
    "sentence that describes the project. Focus on the main purpose, key "
    "characteristics, and primary goals. Write in a professional, natural tone. "
    "Do not use bullet points, lists, or markdown. Output only the summary sentence."
)


class GenerateSummaryRequest(BaseModel):
    profile_text: str


class GenerateSummaryResponse(BaseModel):
    summary: str


def _get_summary_llm() -> ChatOpenAI:
    model = os.getenv("SUMMARY_LLM_MODEL", os.getenv("LLM_MODEL", "gpt-4o-mini"))
    api_key = os.getenv("SUMMARY_LLM_API_KEY", os.getenv("LLM_API_KEY", ""))
    base_url = os.getenv("SUMMARY_LLM_BASE_URL", os.getenv("LLM_BASE_URL", ""))
    kwargs: dict = {
        "model": model,
        "temperature": 0.3,
        "max_tokens": 150,
    }
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)


def add_generate_summary_routes(router: APIRouter) -> None:
    """Register the generate-summary endpoint."""

    @router.post(
        "/v1/generate-summary",
        response_model=GenerateSummaryResponse,
        tags=["projects"],
        summary="Generate an AI project summary from profile data",
    )
    async def generate_summary(request: GenerateSummaryRequest) -> GenerateSummaryResponse:
        if not request.profile_text.strip():
            return GenerateSummaryResponse(summary="")

        llm = _get_summary_llm()
        messages = [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content=request.profile_text),
        ]
        try:
            response = await llm.ainvoke(messages)
            summary = response.content.strip()
            return GenerateSummaryResponse(summary=summary)
        except Exception:
            logger.exception("Failed to generate project summary")
            return GenerateSummaryResponse(summary="")
