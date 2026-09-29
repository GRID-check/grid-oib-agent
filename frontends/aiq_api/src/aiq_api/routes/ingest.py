"""URL-based ingestion endpoint for documents stored in SeaweedFS."""

import asyncio
import hashlib
import io
import ipaddress
import logging
import os
import re
import socket
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import unquote
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter
from fastapi import BackgroundTasks
from fastapi import Depends
from fastapi import Header
from fastapi import HTTPException
from PIL import Image

from aiq_agent.knowledge.base import BaseIngestor

from ..models.requests import IngestRequest
from .collections import _require_ingestor

logger = logging.getLogger(__name__)


def add_ingest_routes(router: APIRouter):
    """Add URL-based ingestion routes to the FastAPI app."""

    @router.post(
        "/v1/ingest",
        status_code=202,
        tags=["ingestion"],
        summary="Ingest a file from a URL reference",
        description=(
            "Validates the presigned URL and submits an ingestion job that downloads"
            " the file when it runs. Nothing is downloaded inside the request."
        ),
        # Every status this handler actually raises. The download is the job's
        # (DeferredObjectDownload), so a missing object or an unreachable store
        # is a FAILED file with `original_download_failed`, never a status here.
        responses={
            400: {"description": "Invalid request: a URL off the object store, or a missing field"},
            500: {"description": "The job could not be submitted"},
        },
    )
    async def ingest_from_url(
        request: IngestRequest,
        background_tasks: BackgroundTasks,
        ingestor: BaseIngestor = Depends(_require_ingestor),
        x_grid_organization_id: str | None = Header(default=None),
    ) -> dict:
        """
        Validate the presigned URL and submit a job that downloads it.

        The BFF upload route writes the file to SeaweedFS and calls this endpoint
        with a presigned URL so the Python backend can ingest it into the
        knowledge index. ``folder_path`` (optional) is the materialised
        project-folder path the document is filed under; it is stamped onto the
        document's metadata row so surfacing and retrieval can see the filing.
        ``file_name`` (optional) is the document's identity inside the
        collection as the BFF knows it; without it the name is derived from the
        presigned URL's last path segment, which is the object key's basename.
        ``authored_by``/``approved_by``/``approved_at``/``producer`` (optional,
        all four together) are the provenance of a document Piloti wrote and a
        person released (ADR-0054); they are stamped onto every chunk and onto
        the document metadata row, and absent means "a human wrote this".
        ``x-grid-organization-id`` (forwarded by the BFF for
        per-project/Archiv uploads) is threaded into the job so the VLM used
        during ingestion resolves the org's BYOK credential and runtime model
        override — the ingest thread is detached from the request, so the org
        id must be captured here and carried in the job config.
        """
        if not request.file_ref or not request.collection:
            raise HTTPException(status_code=400, detail="file_ref and collection are required")
        _assert_request_urls(request)

        # Idempotent per document and object (see _dispatch_key): the BFF
        # retries once when its ten-second budget runs out, and a retry must
        # join the job the first attempt started, not start a second one. The
        # slot serialises the lookup and the submit of one key on this
        # replica, so two dispatches arriving together submit once.
        dispatch_key = _dispatch_key(request)
        async with _dispatch_slot(dispatch_key):
            existing = await _live_job(ingestor, dispatch_key)
            if existing:
                logger.info("Dispatch joined the live ingestion job %s", existing)
                return {"job_id": existing, "status": "pending", "document_id": request.document_id}
            job_id = await _submit(ingestor, request, _job_config(request, x_grid_organization_id, dispatch_key))
        _schedule_preview_thumbnail(background_tasks, request)
        return {"job_id": job_id, "status": "pending", "document_id": request.document_id}


async def _submit(ingestor: BaseIngestor, request: IngestRequest, config: dict) -> str:
    """Submit the job with the original as a deferred download; 500 when that fails.

    Nothing is downloaded here: the BFF aborts this request after ten seconds
    and asks once more, so a download inside it was a false "failed" for any
    file slower than that, and for a retry landing on another replica while
    the first was still downloading. See ``DeferredObjectDownload``.
    """
    original = DeferredObjectDownload(request.file_ref)
    try:
        job_id = await asyncio.to_thread(ingestor.submit_job, [original], request.collection, config=config)
    except Exception as error:
        # Class name, not `str(e)`: an arbitrary internal message is exactly
        # where a path, a DSN or a URL rides out to the client.
        logger.exception("Ingestion submit failed: %s", type(error).__name__)
        raise HTTPException(status_code=500, detail="Ingestion failed") from None
    logger.info("Submitted ingestion job %s for %s", job_id, config["original_filenames"][0])
    return job_id


def _job_config(request: IngestRequest, organization_id: str | None, dispatch_key: str | None) -> dict:
    """The job config this request carries; no URL in it survives a ``repr``."""
    config: dict = {
        # The job owns the files it is handed and deletes them; a file its
        # deferred download wrote is its own either way.
        "cleanup_files": True,
        # The BFF's own `documents.filename` when it stated one, and the
        # presigned URL's last path segment otherwise. Stating it is what
        # keeps the chunk `file_name` metadata equal to the join key every
        # chunk purge addresses: the URL segment is the OBJECT KEY's
        # basename, which the BFF sanitises (a slash becomes an underscore, a
        # 300-character name is cut), so the derived form can be a string no
        # purge ever asks for.
        "original_filenames": [request.file_name or _extract_filename(request.file_ref)],
    }
    if request.thumbnail_upload_url:
        # Gated in _assert_request_urls before anything was requested.
        config["thumbnail_upload_url"] = request.thumbnail_upload_url
    # What a retried dispatch of this document and object is matched against
    # (`BaseIngestor.find_live_job`).
    if dispatch_key:
        config["dispatch_key"] = dispatch_key
    # The folder this document was filed into, as the BFF's materialised path
    # (ADR-0049), stamped onto the metadata row: a folder is part of what the
    # agent must know about a document, not only of how the object is keyed.
    folder_path = (request.folder_path or "").strip()
    if folder_path:
        config["folder_path"] = folder_path
    # The org id, so the detached ingest thread resolves the tenant's BYOK
    # VLM credential and runtime model override.
    if organization_id:
        config["organization_id"] = organization_id
    # The document's id, so the pipeline can ask the BFF for a PUT slot per
    # raster it extracts (`knowledge_layer.llamaindex.image_store`). Without
    # it the captions are indexed and the rasters discarded, which is what
    # every caller that sends no id (the OIB corpus sync) gets.
    if request.document_id:
        config["document_id"] = request.document_id
    # Who wrote this document and who released it (ADR-0054); absent for
    # every human document, which is what the parser expects
    # (aiq_agent.common.provenance.parse_agent_provenance).
    config.update(_provenance_config(request))
    if request.extraction_ref:
        # Read the document from its PDF rendition (ADR-0071), downloaded by
        # the job like the original. Positional like original_filenames, whose
        # entry above stays the original's name, the identity every chunk
        # carries.
        config["extraction_paths"] = [DeferredObjectDownload(request.extraction_ref, suffix=".pdf")]
    return config


def _assert_request_urls(request: IngestRequest) -> None:
    """Every URL this request names passes both SSRF gates, before anything is requested.

    Nothing is fetched inside the request: ``file_ref`` and ``extraction_ref``
    are downloaded by the job, ``preview_ref`` by a background task, and
    ``thumbnail_upload_url`` feeds a PUT from both. So this gate is the only
    one those URLs meet, and an unvalidated URL on any of those paths is an
    arbitrary-destination server-side request forgery. Fail-closed for all of them: a request naming a non-object-store
    URL is malformed, not decorative.
    """
    _assert_fetchable_object_store_url(request.file_ref)
    for field in ("preview_ref", "extraction_ref", "thumbnail_upload_url"):
        value = getattr(request, field)
        if value:
            _assert_fetchable_object_store_url(value, field=field)


def _dispatch_key(request: IngestRequest) -> str | None:
    """What makes two dispatches the same one: the document and the object it names.

    Not the document alone: a re-upload keeps the document id and writes its
    bytes under a new key (ADR-0054), and must be indexed even while the
    previous version's job still runs. The object path is the presigned URL
    without its query, so the signature, which differs on every signing, is
    not part of it. Hashed, because the path names the tenant and the key is
    stored in the shared status table. None without a document id (the OIB
    corpus sync), which keeps that caller's behaviour.
    """
    if not request.document_id:
        return None
    path = urlparse(request.file_ref).path
    return hashlib.sha256(f"{request.document_id}\0{path}".encode()).hexdigest()


#: Dispatch keys with a request in the handler on this replica, and how many.
_dispatch_slots: dict[str, tuple[asyncio.Lock, int]] = {}


@asynccontextmanager
async def _dispatch_slot(dispatch_key: str | None) -> AsyncIterator[None]:
    """Serialise the dispatches of one key on this replica; no-op without a key."""
    if dispatch_key is None:
        yield
        return
    lock, holders = _dispatch_slots.get(dispatch_key, (asyncio.Lock(), 0))
    _dispatch_slots[dispatch_key] = (lock, holders + 1)
    try:
        async with lock:
            yield
    finally:
        lock, holders = _dispatch_slots[dispatch_key]
        if holders <= 1:
            del _dispatch_slots[dispatch_key]
        else:
            _dispatch_slots[dispatch_key] = (lock, holders - 1)


async def _live_job(ingestor: BaseIngestor, dispatch_key: str | None) -> str | None:
    """The live job for this key, if the ingestor knows one. Never raises: a failed
    lookup is a dispatch that submits, which is what every dispatch did before."""
    if dispatch_key is None:
        return None
    try:
        found = await asyncio.to_thread(ingestor.find_live_job, dispatch_key)
    except Exception as error:  # noqa: BLE001 - the lookup is an optimisation of a submit
        logger.warning("Live-job lookup failed (submitting): %s", type(error).__name__)
        return None
    return found if isinstance(found, str) and found else None


class DeferredObjectDownload:
    """A gated object-store GET the ingest job runs when it reaches the file.

    Why deferred: the BFF aborts ``POST /v1/ingest`` after ten seconds, asks
    once more, and marks the row failed when that times out too, while this
    route may still go on to submit the job; everything slow between the
    request and the job id is a false failure waiting to happen. The original
    (``file_ref``) and its PDF rendition (``extraction_ref``, ADR-0071) are
    each up to tens of megabytes, so the route gates both URLs and hands the
    job this object instead of the bytes (``knowledge_layer.deferred_files``).

    The URL is a presigned GET, a bearer credential: it lives in a private slot
    and never in ``repr``, so a job config that is logged, printed or shown in
    a traceback carries ``<deferred object download>`` and nothing a reader
    could replay. Calling it downloads to a new temp file, which the caller
    then owns and deletes, and raises on any failure. Without a ``suffix`` the
    temp file's extension is inferred from the response's content type, as the
    job's parser dispatches by it.

    The job runs when the bounded ingest pool reaches it, which can be minutes
    after this request, so the BFF signs these URLs to outlive the queue
    (an hour, ``dispatchIngest``).
    """

    __slots__ = ("_suffix", "_url")

    def __init__(self, url: str, suffix: str | None = None) -> None:
        self._url = url
        self._suffix = suffix

    def __repr__(self) -> str:
        return "<deferred object download>"

    def __call__(self) -> str:
        # No redirects: a follow could land on a host outside the allowlist
        # (e.g. a cloud metadata endpoint), which would make the route's host
        # check a no-op. Presigned object-store GETs never redirect; a 3xx is
        # a failed download like any other.
        response = httpx.get(self._url, follow_redirects=False, timeout=_DOWNLOAD_TIMEOUT_SECONDS)
        response.raise_for_status()
        suffix = self._suffix or _infer_suffix(response.headers.get("content-type", ""), self._url)
        fd, path = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(response.content)
        except BaseException:
            os.unlink(path)
            raise
        # The size, never the URL: see the class docstring.
        logger.info("Downloaded %d bytes for ingestion", len(response.content))
        return path


#: Per phase (connect, each read), not for the whole body: a large original
#: streams for as long as bytes keep arriving.
_DOWNLOAD_TIMEOUT_SECONDS = 60.0


def _schedule_preview_thumbnail(background_tasks: BackgroundTasks, request: IngestRequest) -> None:
    """Draw the card thumbnail of an office original from ``preview_ref``, after the response.

    Everything else is drawn by the job, from the first bytes it has: a PDF or
    an image from itself, a Word or presentation file from the rendition it
    downloads for extraction (``extraction_ref``), so that PDF is not fetched
    twice. What is left is an office original indexed from its own bytes (a
    spreadsheet): the job cannot rasterise it, and its rendition is only ever
    the ``preview_ref`` the BFF sends for office originals. Fail-open: the
    thumbnail is decorative.
    """
    if not request.thumbnail_upload_url or not request.preview_ref or request.extraction_ref:
        return
    background_tasks.add_task(_generate_and_upload_thumbnail, request.thumbnail_upload_url, request.preview_ref)


def _provenance_config(request: IngestRequest) -> dict[str, str]:
    """The provenance keys this request carries, empty fields dropped.

    The four names are spelled in ``aiq_agent.common.provenance`` and read back
    from chunk metadata by the same module; this route neither renames nor
    validates them, because a route that re-spells a metadata key is where the
    BFF and the parser silently stop agreeing. An ``authored_by`` that is not
    ``agent`` is dropped along with the rest: the one value the retrieval side
    acts on is that token, so anything else is an unmarked document and must not
    arrive carrying half a provenance.
    """
    from aiq_agent.common.provenance import AGENT_AUTHOR
    from aiq_agent.common.provenance import KEY_APPROVED_AT
    from aiq_agent.common.provenance import KEY_APPROVED_BY
    from aiq_agent.common.provenance import KEY_AUTHORED_BY
    from aiq_agent.common.provenance import KEY_PRODUCER
    from aiq_agent.common.provenance import is_agent_author

    if not is_agent_author(request.authored_by):
        return {}
    fields = {
        KEY_AUTHORED_BY: AGENT_AUTHOR,
        KEY_APPROVED_BY: (request.approved_by or "").strip(),
        KEY_APPROVED_AT: (request.approved_at or "").strip(),
        KEY_PRODUCER: (request.producer or "").strip(),
    }
    return {key: value for key, value in fields.items() if value}


def _assert_fetchable_object_store_url(url: str, field: str = "file_ref") -> None:
    """Both SSRF gates every URL this route requests must pass, in order."""
    _assert_object_store_url(url, field=field)
    _assert_public_host_resolution(url, field=field)


def _assert_public_host_resolution(url: str, field: str = "file_ref") -> None:
    """Ensure a URL host OUTSIDE the object-store allowlist resolves publicly.

    Hosts on the allowlist are exempt: the in-network object store
    (``SEAWEED_ENDPOINT=http://seaweedfs:8333`` in compose/Kubernetes)
    resolves to a private address by design, so demanding a public IP for it
    would reject every legitimate presigned upload in those deployments.
    Trust for those names comes from ``_assert_object_store_url``, which has
    already matched them strictly against operator configuration. Any other
    host must resolve public-only — a private/loopback/link-local answer is
    exactly the DNS-rebinding shape that would aim this route at internal
    services.
    """
    parsed = urlparse(url)
    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail=f"{field} must include a valid hostname")
    if host.casefold() in _object_store_hosts():
        return

    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail=f"{field} host could not be resolved") from exc

    for info in infos:
        ip_str = info[4][0]
        ip = ipaddress.ip_address(ip_str)
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise HTTPException(
                status_code=400,
                detail=f"{field} host resolves to a non-public IP address",
            )


def _object_store_hosts() -> frozenset[str]:
    """Hostnames the ingest endpoint may download from: the object store itself.

    ``file_ref`` is a presigned SeaweedFS URL, so a request that points
    anywhere else is a server-side request forgery. The store is reachable
    under up to two names — the in-network endpoint (``SEAWEED_ENDPOINT``,
    what the backend itself uses) and the browser-facing one the BFF signs
    presigned URLs against (``SEAWEED_PUBLIC_ENDPOINT``) — and both must be
    trusted. An attacker with a user-level token could otherwise call this
    route with a URL aimed at the Docker network's metadata service or any
    other internal host, and the fetch would happen with the backend's trust
    level. Strict host match, no substrings: ``evil-seaweedfs.com`` must not
    pass for ``seaweedfs.com``.
    """
    hosts: set[str] = set()
    for environment_variable in ("SEAWEED_ENDPOINT", "SEAWEED_PUBLIC_ENDPOINT"):
        endpoint = os.environ.get(environment_variable, "")
        host = urlparse(endpoint).hostname
        if host:
            hosts.add(host.casefold())
    return frozenset(hosts)


def _assert_object_store_url(url: str, field: str = "file_ref") -> None:
    """Reject a URL that is not an http(s) URL to the object store."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail=f"{field} must be an http(s) object-store URL")
    if not parsed.hostname or parsed.hostname.casefold() not in _object_store_hosts():
        raise HTTPException(status_code=400, detail=f"{field} must point at the configured object store")


def _infer_suffix(content_type: str, url: str) -> str:
    """Infer file extension from content-type or URL path.

    The suffix lands directly in the temp filename the ingestion job writes
    (``NamedTemporaryFile(suffix=...)``), so it must be a plain extension and
    nothing else. Two defences: it is derived from a fixed map when possible,
    and the URL-path fallback is scrubbed to ``[a-zA-Z0-9.]`` with a length
    cap — a hostile path segment (``.pdf/../../etc``, ``.exe%2f..``) can no
    longer smuggle separators or traversal into the temp path.
    """
    content_map = {
        "application/pdf": ".pdf",
        "text/plain": ".txt",
        "text/markdown": ".md",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
        # The rest of the office family the BFF renders to PDF (ADR-0070,
        # OFFICE_RENDITION_CONTENT_TYPES in the UI's preview-types.ts), each
        # with the one extension its type names. Without them an office file
        # whose presigned path has no extension would land as `.bin`, and the
        # parser dispatches by that suffix.
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
        "application/vnd.ms-word.document.macroenabled.12": ".docm",
        "application/msword": ".doc",
        "application/vnd.ms-excel.sheet.macroenabled.12": ".xlsm",
        "application/vnd.ms-excel": ".xls",
        "application/vnd.ms-powerpoint.presentation.macroenabled.12": ".pptm",
        "application/vnd.ms-powerpoint": ".ppt",
        "application/vnd.oasis.opendocument.text": ".odt",
        "application/vnd.oasis.opendocument.spreadsheet": ".ods",
        "application/vnd.oasis.opendocument.presentation": ".odp",
        "application/rtf": ".rtf",
        "text/rtf": ".rtf",
        "image/png": ".png",
        "image/jpeg": ".jpg",
    }
    # MIME types are case-insensitive, and the macro-enabled ones are commonly
    # sent as `...macroEnabled.12`.
    suffix = content_map.get(content_type.split(";", maxsplit=1)[0].strip().lower(), "")
    if not suffix:
        suffix = re.sub(r"[^a-zA-Z0-9.]", "", os.path.splitext(urlparse(url).path)[1])[:16]
    return suffix or ".bin"


def _extract_filename(url: str) -> str:
    """Extract the real filename from a (presigned) URL path.

    The path segment is percent-encoded by the S3 presigner (a storage key
    ``.../doc/{id}/Zürich Plan.pdf`` becomes ``.../Z%C3%BCrich%20Plan.pdf``),
    so the basename must be URL-decoded. This value is persisted as the chunk
    ``file_name`` metadata, and deletion matches chunks by that exact string
    against the raw DB filename. Skipping the decode stored the encoded form,
    so any document whose name contained a space or non-ASCII character (common
    in the German OIB corpus) could never have its vectors deleted.
    """
    path = urlparse(url).path
    filename = unquote(os.path.basename(path))
    if not filename or filename == "/":
        return "document"
    return filename


def _generate_and_upload_thumbnail(thumbnail_url: str, preview_ref: str) -> bool:
    """Render a 200px JPEG of the PDF rendition and PUT it to the presigned URL.

    Fail-open on any error (thumbnails are decorative). Returns ``True`` when
    one was uploaded.
    """
    try:
        thumbnail_bytes = _render_rendition_thumbnail(preview_ref)
        if not thumbnail_bytes:
            return False
        resp = httpx.put(thumbnail_url, content=thumbnail_bytes)
        resp.raise_for_status()
        logger.info("Preview thumbnail uploaded (%d bytes)", len(thumbnail_bytes))
        return True
    except Exception as thumb_error:
        # The class only: the traceback carries the presigned upload URL (or
        # the rendition's GET URL).
        logger.warning("Preview thumbnail generation failed (swallowed): %s", type(thumb_error).__name__)
    return False


def _render_rendition_thumbnail(preview_ref: str) -> bytes | None:
    """Download the PDF rendition to a temp file, render its first page, delete it.

    ``preview_ref`` passed the object-store gates in the handler. No redirects,
    for the reason ``DeferredObjectDownload`` gives. The URL is never logged;
    an ``HTTPStatusError`` here propagates to the caller, which logs only its
    class name.
    """
    response = httpx.get(preview_ref, follow_redirects=False, timeout=30.0)
    response.raise_for_status()
    fd, pdf_path = tempfile.mkstemp(suffix=".pdf")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(response.content)
        return _render_pdf_thumbnail(pdf_path)
    finally:
        os.unlink(pdf_path)


def _render_pdf_thumbnail(pdf_path: str) -> bytes | None:
    """First page of a PDF as a 200px (longest side) JPEG; ``None`` for an empty PDF."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_path)
    try:
        if len(doc) == 0:
            return None
        page = doc[0]
        try:
            width_pt, height_pt = page.get_size()
            scale = 200.0 / (max(width_pt, height_pt) or 1.0)
            img = page.render(scale=scale).to_pil().convert("RGB")
        finally:
            page.close()
    finally:
        doc.close()
    return _jpeg_bytes(img)


def _jpeg_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    return buf.getvalue()
