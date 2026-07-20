"""URL-based ingestion endpoint for documents stored in MinIO."""

import logging
import os
import tempfile
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException

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
    ) -> dict:
        """
        Download file from presigned URL and submit for ingestion.

        The BFF upload route writes the file to MinIO and calls this endpoint
        with a presigned URL so the Python backend can ingest it into the
        knowledge index.
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

            logger.info(f"Downloaded {len(response.content)} bytes from {file_ref[:80]}...")

            config: dict = {
                "cleanup_files": True,
                "original_filenames": [_extract_filename(file_ref)],
            }
            if request.thumbnail_upload_url:
                config["thumbnail_upload_url"] = request.thumbnail_upload_url

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

        except httpx.HTTPStatusError as e:
            logger.error(f"Failed to download file from URL: {e}")
            raise HTTPException(status_code=400, detail=f"Failed to download file: {e}")
        except httpx.RequestError as e:
            logger.error(f"Network error downloading file: {e}")
            raise HTTPException(status_code=502, detail=f"Network error downloading file: {e}")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Ingestion failed: {e}")
            raise HTTPException(status_code=500, detail=str(e))
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
    """Extract filename from URL path."""
    path = urlparse(url).path
    filename = os.path.basename(path)
    if not filename or filename == "/":
        return "document"
    return filename
