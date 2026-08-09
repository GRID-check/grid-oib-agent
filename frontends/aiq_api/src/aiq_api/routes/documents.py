"""Document management endpoints."""

import logging
import os
import tempfile
from typing import Any

from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import UploadFile
from pydantic import BaseModel
from pydantic import Field

from aiq_agent.knowledge import get_available_documents_async
from aiq_agent.knowledge import update_document_tags
from aiq_agent.knowledge.base import BaseIngestor
from aiq_agent.knowledge.document_classification import ALLOWED_TAGS
from aiq_agent.knowledge.document_classification import MAX_TAGS
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import IngestionJobStatus

from ..models.requests import DeleteFilesRequest
from ..models.requests import UploadResponse
from .collections import _require_ingestor

logger = logging.getLogger(__name__)

# Upper bound on job ids per batch-status request (request validation).
BATCH_STATUS_MAX_IDS = 200


def _merge_summaries(files: list[FileInfo], summaries: list[AvailableDocument]) -> list[FileInfo]:
    """Attach persisted per-document summaries and tags onto the file list.

    DocumentMetadataStore (SQL, keyed by ``(collection, filename)``) is the source of
    truth for both the one-sentence summary and the controlled ingestion tags;
    ``list_files`` only knows what the vector store holds. The join key is the
    filename, unique within the summaries table, so a straight lookup is safe.
    A file without a stored summary/tags is left untouched; already-populated
    values are never overwritten.
    """
    if not summaries:
        return files
    doc_by_name = {doc.file_name: doc for doc in summaries}
    for file in files:
        doc = doc_by_name.get(file.file_name)
        if doc is None:
            continue
        if file.summary is None and doc.summary:
            file.summary = doc.summary
        if not file.tags and doc.tags:
            file.tags = doc.tags
    return files


def add_document_routes(router: APIRouter):
    """Add document management routes to the FastAPI app."""

    @router.post(
        "/v1/collections/{collection_name}/documents",
        response_model=UploadResponse,
        status_code=202,
        tags=["documents"],
        summary="Upload documents to a collection",
    )
    async def upload_documents(
        collection_name: str,
        files: list[UploadFile] = File(..., description="Files to upload"),
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> UploadResponse:
        """
        Upload documents to a collection.

        Returns a job ID for polling the ingestion status.
        """
        if not files:
            raise HTTPException(status_code=400, detail="No files provided")

        # Verify collection exists
        collection = ingestor.get_collection(collection_name)
        if collection is None:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_name}' not found")

        temp_paths = []
        original_filenames = []
        try:
            # Save uploaded files to temp location
            # NOTE: Files are NOT deleted here - the ingestion job cleans them up
            # after processing to allow background thread to access them
            for file in files:
                original_filename = file.filename or "unknown"
                original_filenames.append(original_filename)
                suffix = f"_{original_filename}" if original_filename else ""
                with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                    content = await file.read()
                    tmp.write(content)
                    temp_paths.append(tmp.name)
                    logger.debug(f"Saved uploaded file to {tmp.name}")

            # Submit ingestion job (job will clean up temp files after processing)
            # Pass original filenames so file_details uses correct names
            job_id = ingestor.submit_job(
                temp_paths,
                collection_name,
                config={
                    "cleanup_files": True,
                    "original_filenames": original_filenames,
                },
            )

            # Get the job to extract file_ids for the response
            job_status = ingestor.get_job_status(job_id)
            file_ids = [fd.file_id for fd in job_status.file_details]

            logger.info(f"Submitted ingestion job {job_id} for {len(files)} file(s)")

            return UploadResponse(
                job_id=job_id,
                file_ids=file_ids,
                message=f"Ingestion job submitted for {len(files)} file(s)",
            )

        except HTTPException:
            # Clean up on HTTP errors (job not submitted)
            for path in temp_paths:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            raise
        except Exception as e:
            # Clean up on other errors (job not submitted)
            for path in temp_paths:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            logger.error(f"Failed to upload documents: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @router.get(
        "/v1/collections/{collection_name}/documents",
        response_model=list[FileInfo],
        tags=["documents"],
        summary="List documents in a collection",
    )
    async def list_documents(
        collection_name: str,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> list[FileInfo]:
        """List all documents in a collection."""
        # Verify collection exists
        collection = ingestor.get_collection(collection_name)
        if collection is None:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_name}' not found")

        try:
            files = ingestor.list_files(collection_name)
        except Exception as e:
            logger.error(f"Failed to list documents: {e}")
            raise HTTPException(status_code=500, detail=str(e))

        # Enrich with persisted per-document summaries (one SQL read). Fail-open:
        # a summary-store hiccup must never break the document listing, so the
        # files are returned without summaries rather than erroring the route.
        try:
            summaries = await get_available_documents_async(collection_name)
            _merge_summaries(files, summaries)
        except Exception as e:
            logger.warning(f"Failed to merge summaries for {collection_name}: {e}")

        return files

    @router.get(
        "/v1/collections/{collection_name}/documents/{file_name}/visual-details",
        tags=["documents"],
        summary="Per-page VLM descriptions of a document's visual chunks",
    )
    async def get_document_visual_details_route(
        collection_name: str,
        file_name: str,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> dict:
        """Return the rendered-drawing / image / chart descriptions ingestion
        produced for a document (the "detailed information" the summary is
        distilled from). Fail-open: returns an empty list when the backend does
        not support it or the document has no visual chunks."""
        getter = getattr(ingestor, "get_document_visual_details", None)
        if getter is None:
            return {"details": []}
        try:
            return {"details": getter(collection_name, file_name)}
        except Exception as e:
            logger.warning("Failed to fetch visual details for %s/%s: %s", collection_name, file_name, e)
            return {"details": []}

    class UpdateTagsRequest(BaseModel):
        tags: list[str] = Field(
            default_factory=list,
            description="Controlled document tags; must be a subset of the ingestion vocabulary.",
        )

    @router.patch(
        "/v1/collections/{collection_name}/documents/{file_name}/tags",
        tags=["documents"],
        summary="Replace a document's controlled tags",
    )
    async def update_document_tags_route(
        collection_name: str,
        file_name: str,
        request: UpdateTagsRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> dict[str, Any]:
        """Replace the controlled tags on a single document's summary row.

        Follows the documents-router auth model (end-user access is enforced at
        the BFF; this route only requires the knowledge API to be configured).
        The ingestion vocabulary (``ALLOWED_TAGS``) is the contract: a user edit
        can never introduce an off-vocabulary tag.

        - Tags outside ``ALLOWED_TAGS`` → 400 listing the offending values.
        - More than ``MAX_TAGS`` tags (after dedup) → 400 (the BFF zod already
          caps this, so a normal user never reaches it).
        - An empty list is allowed and clears the tags.
        - No summary row for ``(collection, file_name)`` → 404 (the summary is
          the anchor; there is nothing to tag without one).
        The summary itself is never modified.
        """
        # De-duplicate while preserving order so the response is stable.
        deduped: list[str] = []
        for tag in request.tags:
            if tag not in deduped:
                deduped.append(tag)

        offending = [tag for tag in deduped if tag not in ALLOWED_TAGS]
        if offending:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Tags outside the controlled vocabulary are not allowed",
                    "invalid_tags": offending,
                },
            )

        # Enforce the same per-document cap that ingestion applies (MAX_TAGS).
        # Reject rather than silently truncate so the caller's intent is explicit.
        if len(deduped) > MAX_TAGS:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": f"At most {MAX_TAGS} tags are allowed per document",
                    "max_tags": MAX_TAGS,
                    "tag_count": len(deduped),
                },
            )

        updated = update_document_tags(collection_name, file_name, deduped)
        if not updated:
            raise HTTPException(
                status_code=404,
                detail=f"No summary found for '{file_name}' in collection '{collection_name}'",
            )

        return {"collection_name": collection_name, "file_name": file_name, "tags": deduped}

    @router.delete(
        "/v1/collections/{collection_name}/documents",
        tags=["documents"],
        summary="Delete files from a collection",
    )
    async def delete_files(
        collection_name: str,
        request: DeleteFilesRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> dict[str, Any]:
        """Delete files from a collection by ID."""
        # Verify collection exists
        collection = ingestor.get_collection(collection_name)
        if collection is None:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_name}' not found")

        if not request.file_ids:
            return {
                "message": "No file IDs provided",
                "successful": [],
                "failed": [],
                "total_deleted": 0,
            }

        try:
            result = ingestor.delete_files(request.file_ids, collection_name)
            total_deleted = result.get("total_deleted", 0)
            failed = result.get("failed", [])

            if failed:
                result["message"] = "Some files could not be deleted"
            elif total_deleted == 0:
                result["message"] = "No matching files found"
            else:
                result["message"] = f"Successfully deleted {total_deleted} file(s)"

            return result
        except Exception as e:
            logger.error("Failed to delete files from collection %s: %s", collection_name, type(e).__name__)
            raise HTTPException(status_code=500, detail="Failed to delete files")

    @router.get(
        "/v1/documents/{job_id}/status",
        response_model=IngestionJobStatus,
        tags=["documents"],
        summary="Get ingestion job status",
    )
    async def get_job_status(
        job_id: str,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> IngestionJobStatus:
        """Get the status of an ingestion job."""
        try:
            status = ingestor.get_job_status(job_id)
            if status is None:
                raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

            return status
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Failed to get job status: %s", type(e).__name__)
            raise HTTPException(status_code=500, detail="Failed to get job status")

    class BatchStatusRequest(BaseModel):
        job_ids: list[str] = Field(default_factory=list, max_length=BATCH_STATUS_MAX_IDS)

    @router.post(
        "/v1/documents/status/batch",
        tags=["documents"],
        summary="Get ingestion job statuses in batch",
    )
    async def get_job_statuses_batch(
        request: BatchStatusRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> dict[str, Any]:
        """Batch variant of the per-job status endpoint.

        The BFF reconciles every in-flight document row on document-list
        reads; per-job round-trips made that read O(n) HTTP calls. Unknown
        or failing job ids map to null (the caller falls back to the
        collection file list), mirroring the single endpoint's 404.
        """
        statuses: dict[str, Any] = {}
        for job_id in request.job_ids:
            try:
                status = ingestor.get_job_status(job_id)
                statuses[job_id] = status.model_dump(mode="json") if status is not None else None
            except Exception:
                statuses[job_id] = None
        return {"statuses": statuses}
