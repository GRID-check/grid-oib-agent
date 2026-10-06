"""Tests for the URL-based ingest endpoint.

The request downloads nothing: it gates the URLs, looks the dispatch up, and
submits a job whose original is a ``DeferredObjectDownload``. The job's side
(running the download, failing the file when it cannot) is
``tests/knowledge_layer_tests/test_deferred_original.py``.
"""

import asyncio
import logging
import os
import threading
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
from aiq_api.routes.ingest import DeferredObjectDownload
from aiq_api.routes.ingest import _assert_public_host_resolution
from aiq_api.routes.ingest import add_ingest_routes

_SIGNED_REF = "http://seaweedfs.test/bucket/doc/plan.pdf?X-Amz-Signature=secret-original"


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


@pytest.fixture
def no_network():
    """Every way the route could fetch or upload, each failing the test when used."""
    with (
        patch("httpx.get", side_effect=AssertionError("GET inside the request")) as get,
        patch("httpx.AsyncClient.get", side_effect=AssertionError("GET inside the request")) as async_get,
        patch("httpx.put") as put,
    ):
        put.return_value = MagicMock(spec=httpx.Response, raise_for_status=MagicMock())
        yield {"get": get, "async_get": async_get, "put": put}


async def _post_json(app, body: dict) -> httpx.Response:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post("/v1/ingest", json=body)


async def _post(app, file_ref: str, collection: str = "proj_test123"):
    return await _post_json(app, {"file_ref": file_ref, "collection": collection})


def _download(content: bytes, content_type: str) -> MagicMock:
    response = MagicMock(spec=httpx.Response)
    response.status_code = 200
    response.content = content
    response.headers = {"content-type": content_type}
    response.raise_for_status = MagicMock()
    return response


def _failed_download(status: int) -> MagicMock:
    response = MagicMock(spec=httpx.Response)
    response.status_code = status
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        f"{status} for {_SIGNED_REF}", request=MagicMock(), response=MagicMock(status_code=status)
    )
    return response


# --- The request: validate, look up, submit; download nothing ---


@pytest.mark.asyncio
async def test_ingest_answers_202_without_downloading(app, mock_ingestor, no_network, caplog):
    """The BFF gives this request ten seconds and retries once: a download here
    turned any file slower than that into a false "failed". The original is
    handed to the job as a deferred download whose URL is in no repr and no
    log."""
    caplog.set_level(logging.DEBUG)
    response = await _post_json(
        app, {"file_ref": _SIGNED_REF, "collection": "proj_test123", "document_id": "doc-550e8400"}
    )

    assert response.status_code == 202
    assert response.json() == {"job_id": "job_test_123", "status": "pending", "document_id": "doc-550e8400"}
    no_network["get"].assert_not_called()
    no_network["async_get"].assert_not_called()

    args, kwargs = mock_ingestor.submit_job.call_args
    [original] = args[0]
    assert isinstance(original, DeferredObjectDownload)
    assert args[1] == "proj_test123"
    config = kwargs["config"]
    assert config["cleanup_files"] is True
    assert config["original_filenames"] == ["plan.pdf"]
    assert "secret-original" not in repr(args) + repr(config)
    assert all("secret-original" not in record.getMessage() for record in caplog.records)


@pytest.mark.asyncio
async def test_ingest_from_url_decodes_percent_encoded_filename(app, mock_ingestor, no_network):
    """The S3 presigner percent-encodes the storage key into the URL path, so a
    filename with a space or umlaut arrives encoded. The persisted chunk
    ``file_name`` metadata must be the DECODED name — deletion later matches
    chunks against the raw DB filename, and an encoded metadata name would
    orphan the vectors forever."""
    response = await _post(app, "http://seaweedfs.test/bucket/doc/abc/Z%C3%BCrich%20Plan.pdf?X-Amz-Signature=abc")

    assert response.status_code == 202
    assert mock_ingestor.submit_job.call_args[1]["config"]["original_filenames"] == ["Zürich Plan.pdf"]


@pytest.mark.asyncio
async def test_a_failed_submit_is_a_500_that_names_nothing(app, mock_ingestor, no_network):
    mock_ingestor.submit_job.side_effect = RuntimeError("pool gone at /var/lib/secret")
    response = await _post(app, _SIGNED_REF)
    assert response.status_code == 500
    assert response.json()["detail"] == "Ingestion failed"


@pytest.mark.asyncio
async def test_ingest_missing_fields(app, mock_ingestor):
    """Test ingest with missing required fields."""
    response = await _post_json(app, {"file_ref": "", "collection": "proj_test123"})
    assert response.status_code in (400, 422)
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_no_ingestor(app, mock_ingestor, no_network):
    """Test ingest when no ingestor is configured (503)."""
    clear_active_ingestor()
    response = await _post(app, "http://seaweedfs.test/bucket/doc.txt")
    assert response.status_code == 503
    assert "Knowledge API not configured" in response.json()["detail"]


@pytest.mark.asyncio
async def test_ingest_rejects_foreign_host(app, mock_ingestor):
    """A file_ref aimed at anything but the configured object store is a
    server-side request forgery — the route must refuse it with 400 before
    anything is submitted. The job would fetch it without asking again, so this
    gate is the only one the URL meets."""
    response = await _post(app, "http://metadata.internal/latest/meta-data")
    assert response.status_code == 400
    assert "object store" in response.json()["detail"]
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_rejects_non_http_scheme(app, mock_ingestor):
    """Only http(s) URLs are fetchable at all; anything else (file:, gopher:)
    is rejected before a job could even attempt it."""
    response = await _post(app, "file:///etc/passwd")
    assert response.status_code == 400
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_host_match_is_case_insensitive(app, mock_ingestor, no_network):
    """Hostnames are case-insensitive; a presigner must not break a valid
    file_ref just because it uppercased the host."""
    response = await _post(app, "http://SEAWEEDFS.TEST/bucket/key?X-Amz-Signature=abc")
    assert response.status_code == 202


@pytest.mark.asyncio
async def test_ingest_rejects_non_object_store_thumbnail_url(app, mock_ingestor, no_network):
    """The thumbnail upload URL feeds httpx.put — an arbitrary-URL PUT is the
    same SSRF primitive as an arbitrary GET, so it passes the same two gates
    as file_ref BEFORE anything is stored. The check is fail-closed (a 400),
    not swallowed by the fail-open thumbnail path: a request naming a foreign
    upload target is malformed, and letting it into the job config would only
    move the unvalidated PUT into the detached ingest thread."""
    response = await _post_json(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/key?X-Amz-Signature=abc",
            "collection": "proj_test123",
            "thumbnail_upload_url": "http://metadata.internal/latest/meta-data",
        },
    )
    no_network["put"].assert_not_called()
    assert response.status_code == 400
    assert "thumbnail_upload_url" in response.json()["detail"]
    assert "object store" in response.json()["detail"]
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_accepts_object_store_host_resolving_private(app, mock_ingestor, no_network):
    """Regression: the object store lives INSIDE the network in compose and
    Kubernetes — its configured name resolves to a private address by design.
    Demanding public resolution for it rejected every legitimate presigned
    upload; allowlisted hosts must pass despite resolving private."""
    response = await _post(app, "http://seaweedfs.test/bucket/key?X-Amz-Signature=abc")
    assert response.status_code == 202
    mock_ingestor.submit_job.assert_called_once()


@pytest.mark.asyncio
async def test_ingest_accepts_thumbnail_on_object_store_resolving_private(app, mock_ingestor, no_network):
    """Thumbnails are uploaded to the same store the download comes from, so a
    private resolution for the allowlisted host must not fail the request
    either — the URL is accepted and carried into the job config."""
    thumbnail_url = "http://seaweedfs.test/bucket/doc/thumb.jpg?X-Amz-Signature=abc"
    response = await _post_json(
        app, {"file_ref": _SIGNED_REF, "collection": "proj_test123", "thumbnail_upload_url": thumbnail_url}
    )
    assert response.status_code == 202
    assert mock_ingestor.submit_job.call_args[1]["config"]["thumbnail_upload_url"] == thumbnail_url
    # A PDF's thumbnail is the job's, drawn from the bytes it downloads.
    no_network["put"].assert_not_called()


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
async def test_ingest_carries_document_id_into_job_config(app, mock_ingestor, no_network):
    """The pipeline stores extracted rasters under the document's prefix by
    asking the BFF for a slot per image; that call needs the document id, so
    it travels in the job config. A caller without one (the corpus sync) gets
    no key, and the pipeline keeps the captions only."""
    with_id = await _post_json(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/plan.pdf",
            "collection": "proj_1",
            "document_id": "4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
        },
    )
    assert with_id.status_code == 202
    assert mock_ingestor.submit_job.call_args[1]["config"]["document_id"] == "4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f"

    without_id = await _post(app, "http://seaweedfs.test/bucket/plan.pdf", collection="oib")
    assert without_id.status_code == 202
    assert "document_id" not in mock_ingestor.submit_job.call_args[1]["config"]


@pytest.mark.asyncio
async def test_ingest_books_its_spend_to_the_documents_project_and_uploader(app, mock_ingestor, no_network):
    """Project and uploader ride into the job config, where the job's cost tracker
    reads them (`_ingest_cost_scope`); without an organization nothing is booked,
    so neither is carried."""
    body = {
        "file_ref": "http://seaweedfs.test/bucket/plan.pdf",
        "collection": "proj_1",
        "project_id": "proj-1",
        "user_id": "user_1",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        booked = await client.post("/v1/ingest", json=body, headers={"x-grid-organization-id": "org_1"})
    assert booked.status_code == 202
    config = mock_ingestor.submit_job.call_args[1]["config"]
    assert (config["organization_id"], config["project_id"], config["user_id"]) == ("org_1", "proj-1", "user_1")

    anonymous = await _post_json(app, body)
    assert anonymous.status_code == 202
    config = mock_ingestor.submit_job.call_args[1]["config"]
    assert "project_id" not in config and "user_id" not in config


# --- DeferredObjectDownload: what the job runs ---


def test_deferred_download_writes_a_temp_file_and_hides_its_url():
    """One GET without redirects, the bytes in a new temp file the caller owns;
    the URL appears in no repr."""
    deferred = DeferredObjectDownload(_SIGNED_REF)
    assert "secret-original" not in repr(deferred)
    assert "secret-original" not in repr({"extraction_paths": [deferred]})
    with patch("httpx.get", return_value=_download(b"%PDF-1.4 original", "application/pdf")) as get:
        path = deferred()
    try:
        assert get.call_args[0][0] == _SIGNED_REF
        assert get.call_args[1]["follow_redirects"] is False
        assert path.endswith(".pdf")
        with open(path, "rb") as handle:
            assert handle.read() == b"%PDF-1.4 original"
    finally:
        os.unlink(path)


def test_deferred_download_takes_the_suffix_from_the_response():
    """The parser dispatches by the temp file's extension, and only the
    response knows the content type: an office original whose object path has
    no extension still lands as what it is."""
    docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    with patch("httpx.get", return_value=_download(b"PK", docx)):
        path = DeferredObjectDownload("http://seaweedfs.test/bucket/doc/object")()
    os.unlink(path)
    assert path.endswith(".docx")


def test_deferred_download_keeps_a_stated_suffix():
    """The rendition is a PDF whatever the store calls it."""
    with patch("httpx.get", return_value=_download(b"%PDF", "application/octet-stream")):
        path = DeferredObjectDownload("http://seaweedfs.test/bucket/doc/_render", suffix=".pdf")()
    os.unlink(path)
    assert path.endswith(".pdf")


def test_deferred_download_scrubs_a_hostile_url_suffix():
    """The URL-path extension is the fallback, and it lands in the temp
    filename: separators, traversal and length bombs are scrubbed to a plain
    short extension."""
    with patch("httpx.get", return_value=_download(b"bytes", "application/octet-stream")):
        path = DeferredObjectDownload("http://seaweedfs.test/bucket/a.pdf/../../etc/passwd")()
    os.unlink(path)
    basename = os.path.basename(path)
    assert basename.endswith(".bin")
    assert len(basename) < 20


@pytest.mark.parametrize("status", [403, 404, 302])
def test_deferred_download_raises_on_a_failed_get(status):
    """An expired signature, a missing object, and a redirect are all failed
    downloads; the job turns the raise into a failed file."""
    with patch("httpx.get", return_value=_failed_download(status)), pytest.raises(httpx.HTTPStatusError):
        DeferredObjectDownload(_SIGNED_REF)()


def test_deferred_download_logs_the_size_and_never_the_url(caplog):
    caplog.set_level(logging.DEBUG)
    with patch("httpx.get", return_value=_download(b"%PDF-1.4", "application/pdf")):
        path = DeferredObjectDownload(_SIGNED_REF)()
    os.unlink(path)
    assert any("8 bytes" in record.getMessage() for record in caplog.records)
    assert all("secret-original" not in record.getMessage() for record in caplog.records)


def test_infer_suffix_office_types():
    """An office original whose presigned path has no extension keeps its
    type's extension rather than landing as `.bin`."""
    from aiq_api.routes.ingest import _infer_suffix

    url = "http://seaweedfs.test/bucket/doc/object"
    assert _infer_suffix("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", url) == ".xlsx"
    assert _infer_suffix("application/vnd.ms-excel.sheet.macroEnabled.12", url) == ".xlsm"
    assert _infer_suffix("application/vnd.oasis.opendocument.text; charset=binary", url) == ".odt"
    assert _infer_suffix("text/rtf", url) == ".rtf"


# --- Renditions and thumbnails (ADR-0070/0071) ---


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


_THUMB_URL = "http://seaweedfs.test/bucket/doc/_thumb.jpg?X-Amz-Signature=put"
_PREVIEW_REF = "http://seaweedfs.test/bucket/doc/_render.pdf?X-Amz-Signature=get"
_EXTRACTION_REF = "http://seaweedfs.test/bucket/doc/_render.pdf?X-Amz-Signature=secret-extract"
_ORIGINAL_REF = "http://seaweedfs.test/bucket/doc/Bericht.docx"


def _office_body(**extra) -> dict:
    return {"file_ref": _ORIGINAL_REF, "collection": "proj_test123", "file_name": "Bericht.docx", **extra}


@pytest.mark.asyncio
async def test_ingest_rejects_non_object_store_preview_ref(app, mock_ingestor):
    """preview_ref is fetched by a background task, so a URL off the object
    store is the same SSRF primitive as a foreign file_ref: 400, before
    anything is submitted."""
    response = await _post_json(app, _office_body(preview_ref="http://169.254.169.254/latest/meta-data"))
    assert response.status_code == 400
    assert "preview_ref" in response.json()["detail"]
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_a_spreadsheet_thumbnail_is_drawn_from_preview_ref_after_submitting(app, mock_ingestor):
    """An office original indexed from its own bytes (a workbook) has a
    thumbnail only through its rendition, which the job never downloads; a
    background task draws it once the job is in. The rendition is fetched
    without redirects and stays out of the job config."""
    order: list[str] = []
    mock_ingestor.submit_job.side_effect = lambda *a, **k: order.append("submit") or "job_test_123"
    with (
        patch("httpx.get", return_value=_download(_tiny_pdf_bytes(), "application/pdf")) as rendition_get,
        patch("httpx.put") as put,
    ):
        put.side_effect = lambda *a, **k: order.append("thumbnail") or MagicMock(raise_for_status=MagicMock())
        response = await _post_json(
            app,
            {
                "file_ref": "http://seaweedfs.test/bucket/doc/Raumliste.xlsx",
                "collection": "proj_test123",
                "thumbnail_upload_url": _THUMB_URL,
                "preview_ref": _PREVIEW_REF,
            },
        )

    assert response.status_code == 202
    assert order == ["submit", "thumbnail"]
    assert rendition_get.call_args[0][0] == _PREVIEW_REF
    assert rendition_get.call_args[1]["follow_redirects"] is False
    assert put.call_args[0][0] == _THUMB_URL
    assert put.call_args[1]["content"][:2] == b"\xff\xd8"  # a JPEG
    assert _PREVIEW_REF not in repr(mock_ingestor.submit_job.call_args)


@pytest.mark.asyncio
async def test_ingest_rejects_non_object_store_extraction_ref(app, mock_ingestor):
    """extraction_ref is downloaded by the job, so it is gated like file_ref
    here: 400 before anything is submitted."""
    response = await _post_json(app, _office_body(extraction_ref="http://169.254.169.254/latest/meta-data"))
    assert response.status_code == 400
    assert "extraction_ref" in response.json()["detail"]
    mock_ingestor.submit_job.assert_not_called()


@pytest.mark.asyncio
async def test_ingest_defers_both_downloads_and_keeps_the_original_identity(app, mock_ingestor, no_network, caplog):
    """The original and its rendition are both the job's downloads; the name is
    still the original's. Neither URL is in a config repr or a log, and the
    job draws the thumbnail from the rendition it downloads anyway, so the
    request neither fetches preview_ref nor PUTs."""
    caplog.set_level(logging.DEBUG)
    response = await _post_json(
        app,
        _office_body(extraction_ref=_EXTRACTION_REF, preview_ref=_EXTRACTION_REF, thumbnail_upload_url=_THUMB_URL),
    )

    assert response.status_code == 202
    no_network["get"].assert_not_called()
    no_network["put"].assert_not_called()
    args, kwargs = mock_ingestor.submit_job.call_args
    config = kwargs["config"]
    assert isinstance(args[0][0], DeferredObjectDownload)
    assert config["original_filenames"] == ["Bericht.docx"]
    [deferred] = config["extraction_paths"]
    assert isinstance(deferred, DeferredObjectDownload)
    assert config["thumbnail_upload_url"] == _THUMB_URL
    assert "secret-extract" not in repr(config)
    assert all("secret-extract" not in record.getMessage() for record in caplog.records)


@pytest.mark.asyncio
async def test_ingest_without_extraction_ref_has_no_rendition_key(app, mock_ingestor, no_network):
    """Absent, no rendition key: extraction reads the original."""
    response = await _post_json(app, _office_body())
    assert response.status_code == 202
    assert "extraction_paths" not in mock_ingestor.submit_job.call_args[1]["config"]


# --- Idempotent dispatch: a retry joins the job the first attempt started ---


class _KeyedIngestor:
    """An ingestor whose jobs stay live, remembering what it submitted per key.

    Its jobs never run, so a deferred download it was handed is never called:
    a retry that joins one is what a retry landing during the job's download
    sees.
    """

    backend_name = "test"

    def __init__(self, submit_delay: threading.Event | None = None) -> None:
        self.submitted: list[tuple[list, dict]] = []
        self.submit_delay = submit_delay

    def submit_job(self, paths, collection, config=None):
        if self.submit_delay is not None:
            self.submit_delay.wait(timeout=5)
        self.submitted.append((paths, config or {}))
        return f"job-{len(self.submitted)}"

    def find_live_job(self, dispatch_key):
        for index, (_paths, config) in enumerate(self.submitted, start=1):
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
async def test_a_retry_during_the_jobs_download_joins_the_same_job(app, keyed_ingestor, no_network):
    """The retry the BFF sends (signed again, so the signature differs) while
    the first job is still downloading its original: the same job id, no
    second job, and nothing downloaded by either request."""
    first = await _post_json(app, _doc_body())
    retry = await _post_json(app, _doc_body("http://seaweedfs.test/bucket/doc/plan.pdf?X-Amz-Signature=two"))
    assert first.status_code == retry.status_code == 202
    assert first.json()["job_id"] == retry.json()["job_id"] == "job-1"
    assert len(keyed_ingestor.submitted) == 1
    no_network["get"].assert_not_called()
    no_network["async_get"].assert_not_called()


@pytest.mark.asyncio
async def test_a_new_version_of_the_same_document_is_submitted(app, keyed_ingestor, no_network):
    """A re-upload keeps the document id and writes a new object (ADR-0054):
    it must be indexed even while the old version's job is still live."""
    first = await _post_json(app, _doc_body())
    second = await _post_json(app, _doc_body("http://seaweedfs.test/bucket/doc/v2/w1/plan.pdf?X-Amz-Signature=x"))
    assert (first.json()["job_id"], second.json()["job_id"]) == ("job-1", "job-2")


@pytest.mark.asyncio
async def test_a_move_into_a_restricted_collection_does_not_join_the_open_collections_job(
    app, keyed_ingestor, no_network
):
    """A document moved across a folder restriction (ADR-0080) keeps its id and
    object and is dispatched again into the folder's collection. Joining the
    job still writing into the open collection would index nothing where the
    document now belongs."""
    first = await _post_json(app, _doc_body())
    moved = await _post_json(app, _doc_body(collection="proj_test123_r0123456789ab"))
    assert (first.json()["job_id"], moved.json()["job_id"]) == ("job-1", "job-2")
    assert len(keyed_ingestor.submitted) == 2


@pytest.mark.asyncio
async def test_concurrent_dispatches_of_one_document_submit_once(app, keyed_ingestor, no_network):
    """Two dispatches of one key arriving together on this replica: the second
    waits for the first's lookup and submit, then finds its job."""
    release = threading.Event()
    keyed_ingestor.submit_delay = release
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
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
async def test_without_a_document_id_every_dispatch_submits(app, keyed_ingestor, no_network):
    """The OIB corpus sync sends no document id; it keeps its behaviour."""
    body = {"file_ref": "http://seaweedfs.test/bucket/oib/rl1.pdf", "collection": "oib_knowledge"}
    await _post_json(app, body)
    await _post_json(app, body)
    assert len(keyed_ingestor.submitted) == 2
    assert "dispatch_key" not in keyed_ingestor.submitted[0][1]


def test_the_dispatch_key_is_a_digest_of_document_object_path_and_collection():
    from aiq_api.models.requests import IngestRequest
    from aiq_api.routes.ingest import _dispatch_key

    def key(file_ref: str, document_id: str | None = "doc-1", collection: str = "c") -> str | None:
        return _dispatch_key(IngestRequest(file_ref=file_ref, collection=collection, document_id=document_id))

    base = "http://seaweedfs.test/bucket/org/o1/doc/doc-1/Plan.pdf"
    assert key(base + "?X-Amz-Signature=a") == key(base + "?X-Amz-Signature=b")
    assert key(base) != key(base, document_id="doc-2")
    assert key(base) != key(base.replace("Plan", "Plan2"))
    assert key(base) != key(base, collection="c_r0123456789ab")
    assert key(base, document_id=None) is None
    # Nothing of the tenant path is stored in the clear.
    assert "org" not in key(base) and len(key(base)) == 64


@pytest.mark.asyncio
async def test_urls_are_gated_before_the_live_job_lookup(app, mock_ingestor):
    response = await _post_json(app, _doc_body(thumbnail_upload_url="http://metadata.internal/latest/meta-data"))
    assert response.status_code == 400
    mock_ingestor.find_live_job.assert_not_called()


@pytest.mark.asyncio
async def test_a_failing_lookup_still_submits(app, mock_ingestor, no_network):
    mock_ingestor.find_live_job.side_effect = RuntimeError("db down")
    response = await _post_json(app, _doc_body())
    assert response.status_code == 202
    assert response.json()["job_id"] == "job_test_123"
    assert len(mock_ingestor.submit_job.call_args[1]["config"]["dispatch_key"]) == 64
