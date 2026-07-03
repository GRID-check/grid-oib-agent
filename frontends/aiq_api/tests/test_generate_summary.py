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

"""Tests for the AI project summary generation endpoint."""

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


@pytest.mark.asyncio
async def test_generate_summary_success(app):
    """Test successful summary generation from profile text."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.post") as mock_post:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.raise_for_status = MagicMock()
            mock_response.json.return_value = {
                "choices": [{"message": {"content": "A modern office renovation project."}}],
            }
            mock_post.return_value = mock_response

            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Project type: office renovation. Location: Vienna."},
            )

    assert response.status_code == 200
    data = response.json()
    assert data["summary"] == "A modern office renovation project."
    mock_post.assert_called_once()


@pytest.mark.asyncio
async def test_generate_summary_empty_profile_text(app):
    """Test that empty/whitespace profile_text short-circuits without calling the LLM."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.post") as mock_post:
            response = await client.post("/v1/generate-summary", json={"profile_text": "   "})

    assert response.status_code == 200
    assert response.json() == {"summary": ""}
    mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_generate_summary_missing_field(app):
    """Test that a missing profile_text field is a validation error."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/v1/generate-summary", json={})

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_generate_summary_llm_failure_returns_empty_summary(app):
    """Test that an LLM/network failure is swallowed and returns an empty summary (200)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.post") as mock_post:
            mock_post.side_effect = httpx.RequestError("Connection refused")

            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Project type: office renovation."},
            )

    assert response.status_code == 200
    assert response.json() == {"summary": ""}


@pytest.mark.asyncio
async def test_generate_summary_upstream_error_returns_empty_summary(app):
    """Test that a non-2xx response from the LLM provider is swallowed and returns an empty summary."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.post") as mock_post:
            error_response = MagicMock(spec=httpx.Response)
            error_response.status_code = 500
            error_response.raise_for_status.side_effect = httpx.HTTPStatusError(
                "500 Internal Server Error",
                request=MagicMock(),
                response=error_response,
            )
            mock_post.return_value = error_response

            response = await client.post(
                "/v1/generate-summary",
                json={"profile_text": "Project type: office renovation."},
            )

    assert response.status_code == 200
    assert response.json() == {"summary": ""}
