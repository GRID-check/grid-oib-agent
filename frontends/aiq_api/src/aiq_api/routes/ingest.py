"""URL-based ingestion endpoint for documents stored in SeaweedFS."""

import asyncio
import io
import ipaddress
import logging
import os
import re
import socket
import tempfile
from urllib.parse import unquote
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter
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
            "Downloads a file from the given presigned URL, saves it to a"
            " temporary location, and submits it to the knowledge ingestor."
        ),
        # Every status this handler actually raises. 502 was added when the
        # download failure was split by cause — a network error reaching the
        # object store is not the client's malformed request, and a caller that
        # retries on 502 but not on 400 needs the schema to say which it will
        # get.
        responses={
            400: {"description": "Invalid request, or the file could not be downloaded"},
            502: {"description": "Network error reaching the object store"},
            500: {"description": "Ingestion failed"},
        },
    )
    async def ingest_from_url(
        request: IngestRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
        x_grid_organization_id: str | None = Header(default=None),
    ) -> dict:
        """
        Download file from presigned URL and submit for ingestion.

        The BFF upload route writes the file to SeaweedFS and calls this endpoint
        with a presigned URL so the Python backend can ingest it into the
        knowledge index. ``folder_path`` (optional) is the materialised
        project-folder path the document is filed under; it is stamped onto the
        document's metadata row so surfacing and retrieval can see the filing.
        ``x-grid-organization-id`` (forwarded by the BFF for
        per-project/Archiv uploads) is threaded into the job so the VLM used
        during ingestion resolves the org's BYOK credential and runtime model
        override — the ingest thread is detached from the request, so the org
        id must be captured here and carried in the job config.
        """
        file_ref = request.file_ref
        collection = request.collection

        if not file_ref or not collection:
            raise HTTPException(status_code=400, detail="file_ref and collection are required")

        temp_path: str | None = None
        submitted = False
        try:
            _assert_object_store_url(file_ref)
            _assert_public_host_resolution(file_ref)

            async with httpx.AsyncClient() as client:
                # No redirects: a follow could land on a host outside the
                # allowlist (e.g. a cloud metadata endpoint), which would make
                # the host check above a no-op. Presigned object-store GETs
                # never redirect; a 3xx is a failed download like any other.
                response = await client.get(file_ref, follow_redirects=False)
                response.raise_for_status()

            suffix = _infer_suffix(response.headers.get("content-type", ""), file_ref)
            # NOTE: The temp file is NOT deleted here - the ingestion job owns
            # cleanup (cleanup_files=True) so the background thread can access it.
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(response.content)
                temp_path = tmp.name

            # NEVER log `file_ref`: it is a presigned S3 URL, i.e. a live bearer
            # credential to the object with no user, org or IP binding — anyone
            # holding the string can fetch the bytes until it expires. The old
            # `file_ref[:80]` truncation was not a control: the prefix length
            # varies with the org/project/document ids in the key, so whether the
            # signature survived the cut was luck, and the tenant path leaked in
            # full for short keys. Log the size and the document, never the URL.
            logger.info("Downloaded %d bytes for ingestion", len(response.content))

            config: dict = {
                "cleanup_files": True,
                "original_filenames": [_extract_filename(file_ref)],
            }
            if request.thumbnail_upload_url:
                # Same two gates as file_ref, BEFORE the value is used
                # anywhere: it feeds an httpx.put here (fast-path thumbnail)
                # and rides into the ingest job's config for a second PUT
                # there — an unvalidated URL on either path is an
                # arbitrary-destination server-side request forgery. Unlike
                # the thumbnail itself this check is fail-closed: a request
                # naming a non-object-store upload target is malformed, not
                # decorative.
                _assert_object_store_url(request.thumbnail_upload_url, field="thumbnail_upload_url")
                _assert_public_host_resolution(request.thumbnail_upload_url, field="thumbnail_upload_url")
                config["thumbnail_upload_url"] = request.thumbnail_upload_url
            # The folder this document was filed into, as the BFF's materialised
            # path (ADR-0049). Carried into the detached ingest thread so the
            # metadata row can be stamped with it — a folder is part of what the
            # agent must know about a document, not only of how the object is keyed.
            folder_path = (request.folder_path or "").strip()
            if folder_path:
                config["folder_path"] = folder_path
            # Carry the org id into the detached ingest thread so the VLM
            # resolves the tenant's BYOK credential + runtime model override.
            if x_grid_organization_id:
                config["organization_id"] = x_grid_organization_id

            # Fast thumbnail: generate a 200px JPEG before the job enters the
            # pool so the BFF polling sees it (near-)instantly. Fail-open —
            # a thumbnail is decorative and never blocks ingestion.
            if request.thumbnail_upload_url:
                try:
                    pregenerated = await asyncio.to_thread(
                        _generate_and_upload_thumbnail,
                        temp_path,
                        request.thumbnail_upload_url,
                    )
                    # Tell the ingest job the thumbnail already exists so it
                    # skips its own (redundant) fallback render + PUT. On
                    # failure the flag stays unset and the fallback still runs.
                    if pregenerated:
                        config["thumbnail_pregenerated"] = True
                except Exception as thumb_error:
                    # No `exc_info`: the traceback of a thumbnail PUT failure
                    # renders the presigned upload URL. The class name is what
                    # this line is actually for — a thumbnail is decorative and
                    # the failure is swallowed either way.
                    logger.warning(
                        "Pre-ingest thumbnail failed (swallowed): %s",
                        type(thumb_error).__name__,
                    )

            job_id = ingestor.submit_job(
                [temp_path],
                collection,
                config=config,
            )

            logger.info(f"Submitted ingestion job {job_id} for {_extract_filename(file_ref)}")
            submitted = True

            return {
                "job_id": job_id,
                "status": "pending",
                "document_id": request.document_id,
            }

        # `str(e)` on either httpx error embeds the REQUEST URL, which for
        # `file_ref` is a presigned S3 URL — a live bearer credential to the
        # object plus the tenant path. So these handlers log the status code and
        # the error CLASS, never the exception's own text, and the client gets a
        # fixed message rather than one built from it. The sink filter
        # (aiq_agent.common.log_redaction) would catch a slip here, but a leak
        # avoided at the call site never has to be caught.
        except httpx.HTTPStatusError as e:
            logger.error("Failed to download file for ingestion: HTTP %d", e.response.status_code)
            raise HTTPException(status_code=400, detail="Failed to download the file to ingest")
        except httpx.RequestError as e:
            logger.error("Network error downloading file for ingestion: %s", type(e).__name__)
            raise HTTPException(status_code=502, detail="Network error downloading the file to ingest")
        except HTTPException:
            raise
        except Exception as e:
            # Class name, not `str(e)`: an arbitrary internal message is exactly
            # where a path, a DSN or a URL rides out to the client.
            logger.exception("Ingestion failed: %s", type(e).__name__)
            raise HTTPException(status_code=500, detail="Ingestion failed")
        finally:
            # Once submit_job succeeds the ingestion job owns cleanup
            # (cleanup_files=True); until then the downloaded temp file is
            # ours, and leaving it behind on a failed submit leaks one file
            # per request until the disk fills (mirrors documents.py).
            if not submitted and temp_path:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass


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
        "image/png": ".png",
        "image/jpeg": ".jpg",
    }
    suffix = content_map.get(content_type.split(";", maxsplit=1)[0].strip(), "")
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


def _generate_and_upload_thumbnail(file_path: str, thumbnail_url: str) -> bool:
    """Render the first page of a PDF/image as a 200px JPEG and PUT it to the
    presigned SeaweedFS URL. Fail-open on any error (thumbnails are decorative).

    Called in the ingest request handler (before ``submit_job``) so the
    thumbnail is available near-instantly - before the file even enters the
    worker pool. Returns ``True`` when a thumbnail was uploaded so the caller
    can signal the ingest job to skip its redundant fallback render.
    """
    try:
        ext = os.path.splitext(file_path)[1].lower()
        thumbnail_bytes: bytes | None = None

        if ext == ".pdf":
            import pypdfium2 as pdfium

            doc = pdfium.PdfDocument(file_path)
            try:
                if len(doc) > 0:
                    page = doc[0]
                    try:
                        width_pt, height_pt = page.get_size()
                        longest_pt = max(width_pt, height_pt) or 1.0
                        scale = 200.0 / longest_pt
                        bitmap = page.render(scale=scale)
                        img = bitmap.to_pil().convert("RGB")
                        buf = io.BytesIO()
                        img.save(buf, format="JPEG", quality=80)
                        thumbnail_bytes = buf.getvalue()
                    finally:
                        page.close()
            finally:
                doc.close()
        elif ext in (".png", ".jpg", ".jpeg"):
            img = Image.open(file_path).convert("RGB")
            img.thumbnail((200, 200))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80)
            thumbnail_bytes = buf.getvalue()

        if thumbnail_bytes:
            resp = httpx.put(thumbnail_url, content=thumbnail_bytes)
            resp.raise_for_status()
            logger.info("Pre-ingest thumbnail uploaded (%d bytes)", len(thumbnail_bytes))
            return True
    except Exception as thumb_error:
        # See the sibling handler above: the traceback carries the presigned
        # upload URL, so this logs what failed and not how.
        logger.warning(
            "Pre-ingest thumbnail generation failed (swallowed): %s",
            type(thumb_error).__name__,
        )
    return False
