"""Tests for the URL-based ingest endpoint."""

from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi import HTTPException
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_api.routes.ingest import _assert_public_host_resolution
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


@pytest.mark.asyncio
async def test_ingest_rejects_non_object_store_thumbnail_url(app, mock_ingestor):
    """The thumbnail upload URL feeds httpx.put — an arbitrary-URL PUT is the
    same SSRF primitive as an arbitrary GET, so it passes the same two gates
    as file_ref BEFORE anything is fetched or stored. The check is fail-closed
    (a 400), not swallowed by the fail-open thumbnail path: a request naming a
    foreign upload target is malformed, and letting it into the job config
    would only move the unvalidated PUT into the detached ingest thread."""
    with patch("httpx.put") as mock_put:
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
                        "file_ref": "http://seaweedfs.test/bucket/key?X-Amz-Signature=abc",
                        "collection": "proj_test123",
                        "thumbnail_upload_url": "http://metadata.internal/latest/meta-data",
                    },
                )
        mock_put.assert_not_called()

    assert response.status_code == 400
    assert "thumbnail_upload_url" in response.json()["detail"]
    assert "object store" in response.json()["detail"]
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_accepts_object_store_host_resolving_private(app, mock_ingestor):
    """Regression: the object store lives INSIDE the network in compose and
    Kubernetes — its configured name resolves to a private address by design.
    Demanding public resolution for it rejected every legitimate presigned
    upload; allowlisted hosts must pass despite resolving private."""
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
                    "file_ref": "http://seaweedfs.test/bucket/key?X-Amz-Signature=abc",
                    "collection": "proj_test123",
                },
            )

    assert response.status_code == 202
    mock_ingestor.submit_job.assert_called_once()


@pytest.mark.asyncio
async def test_ingest_accepts_thumbnail_on_object_store_resolving_private(app, mock_ingestor):
    """Thumbnails are uploaded to the same store the download came from, so a
    private resolution for the allowlisted host must not fail the request
    either — the URL is accepted and still carried into the job config."""
    thumbnail_url = "http://seaweedfs.test/bucket/doc/thumb.jpg?X-Amz-Signature=abc"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.content = b"pdf bytes"
            mock_response.headers = {"content-type": "application/pdf"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            # The fast-path PUT is stubbed so the test never leaves the
            # process regardless of whether thumbnail generation gets far
            # enough to attempt it.
            with patch("httpx.put") as mock_put:
                put_response = MagicMock(spec=httpx.Response)
                put_response.status_code = 200
                put_response.raise_for_status = MagicMock()
                mock_put.return_value = put_response

                response = await client.post(
                    "/v1/ingest",
                    json={
                        "file_ref": "http://seaweedfs.test/bucket/doc/plan.pdf?X-Amz-Signature=abc",
                        "collection": "proj_test123",
                        "thumbnail_upload_url": thumbnail_url,
                    },
                )

    assert response.status_code == 202
    call_args = mock_ingestor.submit_job.call_args
    assert call_args[1]["config"]["thumbnail_upload_url"] == thumbnail_url


def test_public_resolution_rejects_foreign_private_host():
    """A genuinely foreign host answering with a private address is the
    DNS-rebinding shape this guard exists for — it must keep refusing with
    400 even though the route's allowlist would already have stopped it.
    (Unit pin of the guard's contract for any future caller.)"""
    with pytest.raises(HTTPException) as excinfo:
        _assert_public_host_resolution("http://rebind.attacker.test/latest/meta-data")
    assert excinfo.value.status_code == 400
    assert "non-public IP address" in excinfo.value.detail


def test_public_resolution_allows_allowlisted_private_host(monkeypatch):
    """Allowlisted hosts are trusted by strict name match against operator
    configuration, not by where DNS points — the public-resolution demand
    must not apply to them (the in-network store resolves private)."""
    monkeypatch.setenv("SEAWEED_PUBLIC_ENDPOINT", "http://seaweedfs.test")
    _assert_public_host_resolution("http://seaweedfs.test:8333/bucket/key")


@pytest.mark.asyncio
async def test_ingest_carries_document_id_into_job_config(app, mock_ingestor):
    """The pipeline stores extracted rasters under the document's prefix by
    asking the BFF for a slot per image; that call needs the document id, so
    it travels in the job config. A caller without one (the corpus sync) gets
    no key, and the pipeline keeps the captions only."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.content = b"%PDF-1.4"
            mock_response.headers = {"content-type": "application/pdf"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response

            with_id = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://seaweedfs.test/bucket/plan.pdf",
                    "collection": "proj_1",
                    "document_id": "4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
                },
            )
            assert with_id.status_code == 202
            assert mock_ingestor.submit_job.call_args[1]["config"]["document_id"] == (
                "4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f"
            )

            without_id = await client.post(
                "/v1/ingest",
                json={"file_ref": "http://seaweedfs.test/bucket/plan.pdf", "collection": "oib"},
            )
            assert without_id.status_code == 202
            assert "document_id" not in mock_ingestor.submit_job.call_args[1]["config"]


def _tiny_pdf_bytes() -> bytes:
    """A one-page blank PDF, built with the renderer the route itself uses."""
    import io

    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument.new()
    doc.new_page(200, 300)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


def _download(content: bytes, content_type: str) -> MagicMock:
    response = MagicMock(spec=httpx.Response)
    response.status_code = 200
    response.content = content
    response.headers = {"content-type": content_type}
    response.raise_for_status = MagicMock()
    return response


_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_THUMB_URL = "http://seaweedfs.test/bucket/doc/_thumb.jpg?X-Amz-Signature=put"
_PREVIEW_REF = "http://seaweedfs.test/bucket/doc/_render.pdf?X-Amz-Signature=get"


async def _post_with_rendition(app, file_ref: str, original: MagicMock, preview_ref: str = _PREVIEW_REF):
    """POST an ingest with a thumbnail slot and a rendition; returns (response, rendition GET mock, PUT mock)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with (
            patch("httpx.AsyncClient.get", return_value=original),
            patch("httpx.get", return_value=_download(_tiny_pdf_bytes(), "application/pdf")) as rendition_get,
            patch("httpx.put") as mock_put,
        ):
            mock_put.return_value = MagicMock(spec=httpx.Response, raise_for_status=MagicMock())
            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": file_ref,
                    "collection": "proj_test123",
                    "thumbnail_upload_url": _THUMB_URL,
                    "preview_ref": preview_ref,
                },
            )
    return response, rendition_get, mock_put


@pytest.mark.asyncio
async def test_ingest_rejects_non_object_store_preview_ref(app, mock_ingestor):
    """preview_ref is fetched by the thumbnail fast path, so a URL off the
    object store is the same SSRF primitive as a foreign file_ref: 400, before
    anything is downloaded or submitted."""
    with patch("httpx.AsyncClient.get") as mock_get:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://seaweedfs.test/bucket/doc/brief.docx",
                    "collection": "proj_test123",
                    "preview_ref": "http://169.254.169.254/latest/meta-data",
                },
            )
    assert response.status_code == 400
    assert "preview_ref" in response.json()["detail"]
    mock_get.assert_not_called()
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_renders_office_thumbnail_from_preview_ref(app, mock_ingestor):
    """A .docx has no pages the fast path can draw, so the thumbnail comes from
    its PDF rendition (ADR-0070), in a background task once the response is
    out: the download is off the BFF's ten-second budget. The rendition is
    fetched without redirects and stays out of the job config."""
    response, rendition_get, mock_put = await _post_with_rendition(
        app, "http://seaweedfs.test/bucket/doc/brief.docx", _download(b"PK docx bytes", _DOCX)
    )

    assert response.status_code == 202
    rendition_get.assert_called_once()
    assert rendition_get.call_args[0][0] == _PREVIEW_REF
    assert rendition_get.call_args[1]["follow_redirects"] is False
    mock_put.assert_called_once()
    assert mock_put.call_args[0][0] == _THUMB_URL
    assert mock_put.call_args[1]["content"][:2] == b"\xff\xd8"  # a JPEG
    config = mock_ingestor.submit_job.call_args[1]["config"]
    # Drawn after the response (a background task), so the job is not told
    # it exists; the job has no fallback for a .docx original anyway.
    assert "thumbnail_pregenerated" not in config
    assert _PREVIEW_REF not in repr(config)
    assert mock_ingestor.submit_job.call_args[0][0][0].endswith(".docx")


@pytest.mark.asyncio
async def test_ingest_ignores_preview_ref_for_pdf_original(app, mock_ingestor):
    """A PDF original renders its own thumbnail; the rendition is never fetched."""
    response, rendition_get, mock_put = await _post_with_rendition(
        app, "http://seaweedfs.test/bucket/doc/plan.pdf", _download(_tiny_pdf_bytes(), "application/pdf")
    )

    assert response.status_code == 202
    rendition_get.assert_not_called()
    mock_put.assert_called_once()
    # Drawn after the response, so the job is not told it exists: the job's
    # own 400px render follows and replaces it.
    assert "thumbnail_pregenerated" not in mock_ingestor.submit_job.call_args[1]["config"]


@pytest.mark.asyncio
async def test_ingest_draws_the_quick_thumbnail_after_submitting(app, mock_ingestor):
    """The BFF gives this request ten seconds; the thumbnail is not needed for
    the job id, so it is drawn by a background task once the job is in."""
    order: list[str] = []
    mock_ingestor.submit_job.side_effect = lambda *a, **k: order.append("submit") or "job_test_123"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with (
            patch("httpx.AsyncClient.get", return_value=_download(_tiny_pdf_bytes(), "application/pdf")),
            patch("httpx.put") as mock_put,
        ):
            mock_put.side_effect = lambda *a, **k: order.append("thumbnail") or MagicMock(raise_for_status=MagicMock())
            response = await client.post(
                "/v1/ingest",
                json={
                    "file_ref": "http://seaweedfs.test/bucket/doc/plan.pdf",
                    "collection": "proj_test123",
                    "thumbnail_upload_url": _THUMB_URL,
                },
            )
    assert response.status_code == 202
    assert order == ["submit", "thumbnail"]


def test_infer_suffix_office_types():
    """An office original whose presigned path has no extension keeps its
    type's extension rather than landing as `.bin`."""
    from aiq_api.routes.ingest import _infer_suffix

    url = "http://seaweedfs.test/bucket/doc/object"
    assert _infer_suffix("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url) == ".xlsx"
    assert _infer_suffix("application/vnd.ms-excel.sheet.macroEnabled.12", url) == ".xlsm"
    assert _infer_suffix("application/vnd.oasis.opendocument.text; charset=binary", url) == ".odt"
    assert _infer_suffix("text/rtf", url) == ".rtf"


def test_deferred_download_writes_a_temp_file_and_hides_its_url():
    """What the job calls: one GET without redirects, the bytes in a new temp
    file the caller owns; the URL appears in no repr."""
    import os

    from aiq_api.routes.ingest import DeferredObjectDownload

    deferred = DeferredObjectDownload(_PREVIEW_REF)
    assert "X-Amz-Signature" not in repr(deferred)
    assert "X-Amz-Signature" not in repr({"extraction_paths": [deferred]})
    with patch("httpx.get", return_value=_download(b"%PDF-1.4 rendition", "application/pdf")) as get:
        path = deferred()
    try:
        assert get.call_args[0][0] == _PREVIEW_REF
        assert get.call_args[1]["follow_redirects"] is False
        assert path.endswith(".pdf")
        with open(path, "rb") as handle:
            assert handle.read() == b"%PDF-1.4 rendition"
    finally:
        os.unlink(path)


def test_deferred_download_raises_on_a_failed_get():
    from aiq_api.routes.ingest import DeferredObjectDownload

    failed = MagicMock(spec=httpx.Response)
    failed.raise_for_status.side_effect = httpx.HTTPStatusError(
        "403", request=MagicMock(), response=MagicMock(status_code=403)
    )
    with patch("httpx.get", return_value=failed), pytest.raises(httpx.HTTPStatusError):
        DeferredObjectDownload(_PREVIEW_REF)()


# --- extraction_ref: extract a Word/presentation file from its PDF rendition (ADR-0071) ---

_EXTRACTION_REF = "http://seaweedfs.test/bucket/doc/_render.pdf?X-Amz-Signature=secret-extract"


def _downloads_by_url(responses: dict[str, MagicMock]):
    """An AsyncClient.get stand-in that answers per URL, recording each call."""
    calls: list[tuple[str, dict]] = []

    async def _get(url, **kwargs):
        calls.append((url, kwargs))
        return responses[url]

    return _get, calls


async def _post_ingest(app, body: dict, responses: dict[str, MagicMock]):
    get, calls = _downloads_by_url(responses)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get", side_effect=get), patch("httpx.get") as sync_get, patch("httpx.put") as put:
            put.return_value = MagicMock(spec=httpx.Response, raise_for_status=MagicMock())
            response = await client.post("/v1/ingest", json=body)
    return response, calls, sync_get, put


_ORIGINAL_REF = "http://seaweedfs.test/bucket/doc/Bericht.docx"


def _docx_body(**extra) -> dict:
    return {"file_ref": _ORIGINAL_REF, "collection": "proj_test123", "file_name": "Bericht.docx", **extra}


def _unlink_submitted_original(mock_ingestor) -> None:
    import os

    for path in mock_ingestor.submit_job.call_args[0][0]:
        if os.path.exists(path):
            os.unlink(path)


@pytest.mark.asyncio
async def test_ingest_rejects_non_object_store_extraction_ref(app, mock_ingestor):
    """extraction_ref is downloaded by the job, so it is gated like file_ref
    here: 400 before anything is fetched or submitted."""
    with patch("httpx.AsyncClient.get") as mock_get:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/v1/ingest", json=_docx_body(extraction_ref="http://169.254.169.254/latest/meta-data")
            )
    assert response.status_code == 400
    assert "extraction_ref" in response.json()["detail"]
    mock_get.assert_not_called()
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_defers_the_rendition_download_and_keeps_the_original_identity(app, mock_ingestor, caplog):
    """The request downloads only the original, then hands the job a deferred
    download of the rendition; the original is still the file submitted and
    its name is still the identity. The URL is in no config repr and no log."""
    import logging

    from aiq_api.routes.ingest import DeferredObjectDownload

    caplog.set_level(logging.DEBUG)
    response, calls, sync_get, _put = await _post_ingest(
        app, _docx_body(extraction_ref=_EXTRACTION_REF), {_ORIGINAL_REF: _download(b"PK docx bytes", _DOCX)}
    )

    assert response.status_code == 202
    assert [url for url, _ in calls] == [_ORIGINAL_REF]
    sync_get.assert_not_called()
    args, kwargs = mock_ingestor.submit_job.call_args
    config = kwargs["config"]
    try:
        assert args[0][0].endswith(".docx")
        assert config["original_filenames"] == ["Bericht.docx"]
        [deferred] = config["extraction_paths"]
        assert isinstance(deferred, DeferredObjectDownload)
        assert config["cleanup_files"] is True
        assert "secret-extract" not in repr(config)
        assert all("secret-extract" not in record.getMessage() for record in caplog.records)
    finally:
        _unlink_submitted_original(mock_ingestor)


@pytest.mark.asyncio
async def test_ingest_with_extraction_ref_draws_no_thumbnail_in_the_request(app, mock_ingestor):
    """preview_ref naming the same PDF is not a second download: the job draws
    the thumbnail from the rendition it downloads for extraction."""
    try:
        response, calls, sync_get, put = await _post_ingest(
            app,
            _docx_body(extraction_ref=_EXTRACTION_REF, preview_ref=_EXTRACTION_REF, thumbnail_upload_url=_THUMB_URL),
            {_ORIGINAL_REF: _download(b"PK docx bytes", _DOCX)},
        )
        assert response.status_code == 202
        assert len(calls) == 1
        sync_get.assert_not_called()
        put.assert_not_called()
        config = mock_ingestor.submit_job.call_args[1]["config"]
        assert "thumbnail_pregenerated" not in config
        assert config["thumbnail_upload_url"] == _THUMB_URL
    finally:
        _unlink_submitted_original(mock_ingestor)


@pytest.mark.asyncio
async def test_ingest_without_extraction_ref_is_unchanged(app, mock_ingestor):
    """Absent, one download and no rendition key: extraction reads the original."""
    try:
        response, calls, _sync_get, _put = await _post_ingest(
            app, _docx_body(), {_ORIGINAL_REF: _download(b"PK docx bytes", _DOCX)}
        )
        assert response.status_code == 202
        assert len(calls) == 1
        config = mock_ingestor.submit_job.call_args[1]["config"]
        assert "extraction_paths" not in config
    finally:
        _unlink_submitted_original(mock_ingestor)


# --- Idempotent dispatch: a retry joins the job the first attempt started ---


class _KeyedIngestor:
    """An ingestor that remembers what it submitted per dispatch key."""

    backend_name = "test"

    def __init__(self) -> None:
        self.submitted: list[dict] = []

    def submit_job(self, paths, collection, config=None):
        import os

        for path in paths:
            if os.path.exists(path):
                os.unlink(path)
        self.submitted.append(config or {})
        return f"job-{len(self.submitted)}"

    def find_live_job(self, dispatch_key):
        for index, config in enumerate(self.submitted, start=1):
            if config.get("dispatch_key") == dispatch_key:
                return f"job-{index}"
        return None


@pytest.fixture
def keyed_ingestor():
    ingestor = _KeyedIngestor()
    set_active_ingestor(ingestor)
    yield ingestor
    clear_active_ingestor()


def _doc_body(file_ref: str = "http://seaweedfs.test/bucket/doc/plan.pdf?X-Amz-Signature=one", **extra) -> dict:
    return {"file_ref": file_ref, "collection": "proj_test123", "document_id": "doc-1", **extra}


@pytest.mark.asyncio
async def test_a_retried_dispatch_joins_the_live_job_without_downloading(app, keyed_ingestor):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get", return_value=_download(b"%PDF-1.4", "application/pdf")) as get:
            first = await client.post("/v1/ingest", json=_doc_body())
            # Signed again, so the signature differs: still the same dispatch.
            retry = await client.post(
                "/v1/ingest", json=_doc_body("http://seaweedfs.test/bucket/doc/plan.pdf?X-Amz-Signature=two")
            )
    assert first.status_code == retry.status_code == 202
    assert first.json()["job_id"] == retry.json()["job_id"] == "job-1"
    assert get.call_count == 1
    assert len(keyed_ingestor.submitted) == 1


@pytest.mark.asyncio
async def test_a_new_version_of_the_same_document_is_submitted(app, keyed_ingestor):
    """A re-upload keeps the document id and writes a new object (ADR-0054):
    it must be indexed even while the old version's job is still live."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get", return_value=_download(b"%PDF-1.4", "application/pdf")):
            first = await client.post("/v1/ingest", json=_doc_body())
            second = await client.post(
                "/v1/ingest", json=_doc_body("http://seaweedfs.test/bucket/doc/v2/w1/plan.pdf?X-Amz-Signature=x")
            )
    assert (first.json()["job_id"], second.json()["job_id"]) == ("job-1", "job-2")


@pytest.mark.asyncio
async def test_concurrent_dispatches_of_one_document_submit_once(app, keyed_ingestor):
    """The retry the BFF sends while the first attempt is still downloading
    waits for it on this replica, then finds its job."""
    import asyncio

    release = asyncio.Event()

    async def slow_download(*_args, **_kwargs):
        await release.wait()
        return _download(b"%PDF-1.4", "application/pdf")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get", side_effect=slow_download):
            first = asyncio.create_task(client.post("/v1/ingest", json=_doc_body()))
            second = asyncio.create_task(client.post("/v1/ingest", json=_doc_body()))
            await asyncio.sleep(0.05)
            release.set()
            responses = await asyncio.gather(first, second)
    assert [r.json()["job_id"] for r in responses] == ["job-1", "job-1"]
    assert len(keyed_ingestor.submitted) == 1

    from aiq_api.routes import ingest

    assert ingest._dispatch_slots == {}


@pytest.mark.asyncio
async def test_without_a_document_id_every_dispatch_submits(app, keyed_ingestor):
    """The OIB corpus sync sends no document id; it keeps its behaviour."""
    body = {"file_ref": "http://seaweedfs.test/bucket/oib/rl1.pdf", "collection": "oib_knowledge"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get", return_value=_download(b"%PDF-1.4", "application/pdf")):
            await client.post("/v1/ingest", json=body)
            await client.post("/v1/ingest", json=body)
    assert len(keyed_ingestor.submitted) == 2
    assert "dispatch_key" not in keyed_ingestor.submitted[0]


def test_the_dispatch_key_is_a_digest_of_document_and_object_path():
    from aiq_api.models.requests import IngestRequest
    from aiq_api.routes.ingest import _dispatch_key

    def key(file_ref: str, document_id: str | None = "doc-1") -> str | None:
        return _dispatch_key(IngestRequest(file_ref=file_ref, collection="c", document_id=document_id))

    base = "http://seaweedfs.test/bucket/org/o1/doc/doc-1/Plan.pdf"
    assert key(base + "?X-Amz-Signature=a") == key(base + "?X-Amz-Signature=b")
    assert key(base) != key(base, document_id="doc-2")
    assert key(base) != key(base.replace("Plan", "Plan2"))
    assert key(base, document_id=None) is None
    # Nothing of the tenant path is stored in the clear.
    assert "org" not in key(base) and len(key(base)) == 64


@pytest.mark.asyncio
async def test_urls_are_gated_before_the_live_job_lookup(app, mock_ingestor):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/v1/ingest", json=_doc_body(thumbnail_upload_url="http://metadata.internal/latest/meta-data")
        )
    assert response.status_code == 400
    mock_ingestor.find_live_job.assert_not_called()


@pytest.mark.asyncio
async def test_a_failing_lookup_still_submits(app, mock_ingestor):
    mock_ingestor.find_live_job.side_effect = RuntimeError("db down")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get", return_value=_download(b"%PDF-1.4", "application/pdf")):
            response = await client.post("/v1/ingest", json=_doc_body())
    assert response.status_code == 202
    assert response.json()["job_id"] == "job_test_123"
    config = mock_ingestor.submit_job.call_args[1]["config"]
    assert len(config["dispatch_key"]) == 64
    _unlink_submitted_original(mock_ingestor)
