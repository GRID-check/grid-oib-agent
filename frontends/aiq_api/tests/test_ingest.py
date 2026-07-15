"""Tests for the URL-based ingest endpoint."""

from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_api.routes.ingest import add_ingest_routes


@pytest.fixture
def mock_ingestor():
    """Create a mock ingestor for testing."""
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    ingestor.submit_job.return_value = "job_test_123"
    set_active_ingestor(ingestor)
    yield ingestor
    clear_active_ingestor()


@pytest.fixture
def app(mock_ingestor):
    """Create a FastAPI app with ingest routes registered."""
    app = FastAPI()
    router = APIRouter()
    add_ingest_routes(router)
    app.include_router(router)
    return app


@pytest.mark.asyncio
async def test_ingest_from_url_success(app, mock_ingestor):
    """Test successful ingestion from a presigned URL."""
    file_content = b"test file content"

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.content = file_content
            mock_response.headers = {"content-type": "application/pdf"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://minio.test/bucket/key?X-Amz-Signature=abc",
                    "collection": "proj_test123",
                    "document_id": "doc-550e8400",
                },
            )

    assert response.status_code == 202
    data = response.json()
    assert data["job_id"] == "job_test_123"
    assert data["status"] == "pending"
    assert data["document_id"] == "doc-550e8400"

    mock_ingestor.submit_job.assert_called_once()
    call_args = mock_ingestor.submit_job.call_args
    assert len(call_args[0][0]) == 1  # single file path
    # submit_job(file_paths, collection_name, config=...)
    assert call_args[0][1] == "proj_test123"  # collection name
    assert call_args[1]["config"]["cleanup_files"] is True
    assert call_args[1]["config"]["original_filenames"] == ["key"]


@pytest.mark.asyncio
async def test_ingest_from_url_download_failure(app, mock_ingestor):
    """Test ingest when the presigned URL download fails."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            error_response = MagicMock(spec=httpx.Response)
            error_response.status_code = 404
            error_response.raise_for_status.side_effect = httpx.HTTPStatusError(
                "404 Not Found",
                request=MagicMock(),
                response=error_response,
            )
            mock_get.return_value = error_response

            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://minio.test/bucket/missing.pdf",
                    "collection": "proj_test123",
                },
            )

    assert response.status_code == 400
    data = response.json()
    assert "detail" in data
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_from_url_network_error(app, mock_ingestor):
    """Test ingest when the backend is unreachable."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_get.side_effect = httpx.RequestError("Connection refused")

            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://minio.test/bucket/doc.pdf",
                    "collection": "proj_test123",
                },
            )

    assert response.status_code == 502
    data = response.json()
    assert "detail" in data
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_missing_fields(app, mock_ingestor):
    """Test ingest with missing required fields."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/v1/ingest",
            json={"file_ref": "", "collection": "proj_test123"},
        )

    assert response.status_code in (400, 422)
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_no_ingestor(app, mock_ingestor):
    """Test ingest when no ingestor is configured (503)."""
    clear_active_ingestor()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.content = b"test"
            mock_response.headers = {"content-type": "text/plain"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://minio.test/bucket/doc.txt",
                    "collection": "proj_test123",
                },
            )

    assert response.status_code == 503
    assert "Knowledge API not configured" in response.json()["detail"]
