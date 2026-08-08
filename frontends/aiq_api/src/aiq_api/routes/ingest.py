"""URL-based ingestion endpoint for documents stored in SeaweedFS."""

import asyncio
import io
import logging
import os
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
        responses={
            400: {"description": "Invalid request"},
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
        knowledge index. ``x-grid-organization-id`` (forwarded by the BFF for
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
            async with httpx.AsyncClient() as client:
                response = await client.get(file_ref, follow_redirects=True)
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
                config["thumbnail_upload_url"] = request.thumbnail_upload_url
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


def _infer_suffix(content_type: str, url: str) -> str:
    """Infer file extension from content-type or URL path."""
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
        suffix = os.path.splitext(urlparse(url).path)[1] or ".bin"
    return suffix


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
