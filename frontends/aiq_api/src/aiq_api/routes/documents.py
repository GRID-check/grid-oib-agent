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
from aiq_agent.knowledge import rewrite_document_folder_paths
from aiq_agent.knowledge import set_document_display_title
from aiq_agent.knowledge import set_document_folder_path
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
    """Attach persisted per-document summaries, tags and folder onto the file list.

    DocumentMetadataStore (SQL, keyed by ``(collection, filename)``) is the source of
    truth for the one-sentence summary, the controlled ingestion tags and the
    ``folder_path`` the document is filed under (ADR-0049); ``list_files`` only
    knows what the vector store holds. The join key is the
    filename, unique within the summaries table, so a straight lookup is safe.
    A file without a stored summary/tags/folder is left untouched; already-populated
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
        if file.folder_path is None and doc.folder_path:
            file.folder_path = doc.folder_path
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

    class UpdateDisplayTitleRequest(BaseModel):
        display_title: str | None = Field(
            default=None,
            description="User-facing document name. Null or blank clears it, restoring the derived default.",
        )

    @router.patch(
        "/v1/collections/{collection_name}/documents/{file_name}/display-title",
        tags=["documents"],
        summary="Rename a document (user-facing display title)",
    )
    async def update_document_display_title_route(
        collection_name: str,
        file_name: str,
        request: UpdateDisplayTitleRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> dict[str, str | None]:
        """Set the user-facing ``display_title`` on one document's metadata row.

        The tenant-scoped twin of the base-corpus rename
        (``/v1/admin/oib/documents/{file_name}/display-title``): same factory
        seam, same store, same effect — retrieval prefers a stored
        ``display_title`` over the filename when it builds a citation chip, so a
        rename shows up there immediately and NOTHING is re-ingested. The
        document's ``file_name`` stays its identity; only the label moves.

        Follows the documents-router auth model: end-user access is enforced at
        the BFF, which resolves the caller's permission on the document before
        it addresses this route by collection.

        - A null or blank title clears the override, restoring the derived
          default (``guess_display_title``).
        - No metadata row for ``(collection, file_name)`` → 404. The summary is
          the anchor, as it is for tags: a document that was never summarized
          has nothing to carry a title. The BFF treats that as non-fatal — the
          rename it stores on its own row is the durable one.
        """
        new_title = (request.display_title or "").strip() or None

        updated = set_document_display_title(collection_name, file_name, new_title)
        if not updated:
            raise HTTPException(
                status_code=404,
                detail=f"No summary found for '{file_name}' in collection '{collection_name}'",
            )

        return {
            "collection_name": collection_name,
            "file_name": file_name,
            "display_title": new_title,
        }

    class UpdateFolderPathRequest(BaseModel):
        folder_path: str | None = Field(
            default=None,
            description=(
                "The document's new folder path, e.g. 'Brandschutz/Fluchtwege'. "
                "Null or blank files it at the project root."
            ),
        )

    @router.patch(
        "/v1/collections/{collection_name}/documents/{file_name}/folder-path",
        tags=["documents"],
        summary="Re-file ONE document into another folder",
    )
    async def update_document_folder_path_route(
        collection_name: str,
        file_name: str,
        request: UpdateFolderPathRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> dict[str, str | None]:
        """Set one document's ``folder_path`` — the per-document half of ADR-0049.

        The subtree mirror below moves a FOLDER and everything under it; this
        moves a DOCUMENT between folders that both already exist. Both are
        needed and neither substitutes for the other: a document leaving
        ``Brandschutz`` for ``Statik`` shares no path prefix with its former
        neighbours, so a prefix rewrite cannot express it.

        Same shape as the display-title mirror: UPDATE-only, nothing
        re-ingested, and the metadata row's summary is the anchor — a document
        that was never summarized has nothing to carry a folder, which is a 404
        the BFF treats as non-fatal because its own ``documents.folder_id`` is
        the durable record of where the file lives.

        Follows the documents-router auth model: end-user access is enforced at
        the BFF, which has already checked ``project:documents:write`` on the
        project that owns this collection.
        """
        new_path = (request.folder_path or "").strip() or None

        updated = set_document_folder_path(collection_name, file_name, new_path)
        if not updated:
            raise HTTPException(
                status_code=404,
                detail=f"No summary found for '{file_name}' in collection '{collection_name}'",
            )

        return {
            "collection_name": collection_name,
            "file_name": file_name,
            "folder_path": new_path,
        }

    class RewriteFolderPathRequest(BaseModel):
        from_path: str = Field(
            ...,
            min_length=1,
            description="The folder path as it was before the rename/move/delete, e.g. 'Brandschutz/Fluchtwege'.",
        )
        to_path: str | None = Field(
            default=None,
            description="The folder path it became. Null or blank re-files the subtree at the project root.",
        )

    @router.patch(
        "/v1/collections/{collection_name}/folder-paths",
        tags=["documents"],
        summary="Re-file every document under a folder path (rename / move / delete mirror)",
    )
    async def rewrite_folder_paths_route(
        collection_name: str,
        request: RewriteFolderPathRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> dict[str, Any]:
        """Mirror a project-folder rename, move or delete onto document metadata.

        The sibling of the display-title mirror
        (``PATCH .../documents/{f}/display-title``): same store, same
        no-re-ingest property, one call instead of one per document. The BFF's
        ``project_folders.path`` is MATERIALISED, so renaming or re-parenting a
        folder rewrites the whole subtree there in a single prefix replace; this
        endpoint is that same operation applied to the backend's
        ``document_metadata.folder_path``.

        - ``from_path`` matches the folder itself AND everything under
          ``from_path/`` — a folder called ``Plan`` never drags ``Plangrundlagen``
          along.
        - ``to_path`` null/blank re-files the subtree at the project root, which
          is what a folder DELETE does to its direct children.
        - Nothing filed under the path is not an error: ``{"updated": 0}``.

        Follows the documents-router auth model: end-user access is enforced at
        the BFF, which has already checked ``project:documents:write`` on the
        project that owns this collection before it addresses this route.
        """
        updated = rewrite_document_folder_paths(collection_name, request.from_path, request.to_path)
        return {
            "collection_name": collection_name,
            "from_path": request.from_path,
            "to_path": (request.to_path or "").strip() or None,
            "updated": updated,
        }

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
