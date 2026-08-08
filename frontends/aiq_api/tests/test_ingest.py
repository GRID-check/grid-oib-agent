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
def app(mock_ingestor, monkeypatch):
    """Create a FastAPI app with ingest routes registered.

    ``SEAWEED_PUBLIC_ENDPOINT`` is set to the test object-store host so the
    SSRF allowlist in ``ingest._object_store_hosts`` accepts the file_refs
    the tests hand the route — that allowlist is env-driven and would
    otherwise be empty here.
    """
    monkeypatch.setenv("SEAWEED_PUBLIC_ENDPOINT", "http://seaweedfs.test")
    monkeypatch.setenv("SEAWEED_ENDPOINT", "http://seaweedfs.test")
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
                    "file_ref": "http://seaweedfs.test/bucket/key?X-Amz-Signature=abc",
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
async def test_ingest_from_url_decodes_percent_encoded_filename(app, mock_ingestor):
    """The S3 presigner percent-encodes the storage key into the URL path, so a
    filename with a space or umlaut arrives encoded. The persisted chunk
    ``file_name`` metadata must be the DECODED name — deletion later matches
    chunks against the raw DB filename, and an encoded metadata name would
    orphan the vectors forever."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.content = b"pdf bytes"
            mock_response.headers = {"content-type": "application/pdf"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            response = await client.post(
                "/v1/ingest",
                json={
                    # storage key ".../doc/{id}/Zürich Plan.pdf" presigned
                    "file_ref": "http://seaweedfs.test/bucket/doc/abc/Z%C3%BCrich%20Plan.pdf?X-Amz-Signature=abc",
                    "collection": "proj_test123",
                },
            )

    assert response.status_code == 202
    call_args = mock_ingestor.submit_job.call_args
    assert call_args[1]["config"]["original_filenames"] == ["Zürich Plan.pdf"]


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
                    "file_ref": "http://seaweedfs.test/bucket/missing.pdf",
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
                    "file_ref": "http://seaweedfs.test/bucket/doc.pdf",
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
                    "file_ref": "http://seaweedfs.test/bucket/doc.txt",
                    "collection": "proj_test123",
                },
            )

    assert response.status_code == 503
    assert "Knowledge API not configured" in response.json()["detail"]


@pytest.mark.asyncio
async def test_ingest_rejects_foreign_host(app, mock_ingestor):
    """A file_ref aimed at anything but the configured object store is a
    server-side request forgery — the route must refuse it with 400 before
    any fetch happens. The allowlist is the object store's own endpoints,
    and a user-level token is enough to reach this route, so this is the
    whole point of the check."""
    with patch("httpx.AsyncClient.get") as mock_get:
        response = await _post(app, "http://metadata.internal/latest/meta-data")
        mock_get.assert_not_called()
    assert response.status_code == 400
    assert "object store" in response.json()["detail"]
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_rejects_non_http_scheme(app, mock_ingestor):
    """Only http(s) URLs are fetchable at all; anything else (file:, gopher:)
    is rejected before httpx could even attempt it."""
    with patch("httpx.AsyncClient.get") as mock_get:
        response = await _post(app, "file:///etc/passwd")
        mock_get.assert_not_called()
    assert response.status_code == 400
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_host_match_is_case_insensitive(app, mock_ingestor):
    """Hostnames are case-insensitive; a presigner must not break a valid
    file_ref just because it uppercased the host."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.content = b"test file content"
            mock_response.headers = {"content-type": "application/pdf"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://SEAWEEDFS.TEST/bucket/key?X-Amz-Signature=abc",
                    "collection": "proj_test123",
                },
            )
    assert response.status_code == 202


@pytest.mark.asyncio
async def test_ingest_suffix_scrubbed(app, mock_ingestor):
    """The URL-path extension lands in the temp filename; hostile segments
    (separators, traversal, length bombs) must be scrubbed to a plain
    short extension."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.content = b"pdf bytes"
            mock_response.headers = {"content-type": "application/octet-stream"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://seaweedfs.test/bucket/a.pdf/../../etc/passwd",
                    "collection": "proj_test123",
                },
            )

    assert response.status_code == 202
    call_args = mock_ingestor.submit_job.call_args
    temp_path = call_args[0][0][0]
    # The scrubbed suffix is a plain short extension: no separator and no
    # traversal survived into the temp filename (the temp dir prefix is the
    # OS's own, which is why only the basename is checked).
    basename = temp_path.split("\\")[-1].split("/")[-1]
    assert "/" not in basename
    assert "\\" not in basename
    assert basename.endswith(".bin")
    assert len(basename) < 20  # tmp-prefix + short suffix, no length bomb


async def _post(app, file_ref: str, collection: str = "proj_test123"):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(
            "/v1/ingest",
            json={"file_ref": file_ref, "collection": collection},
        )
