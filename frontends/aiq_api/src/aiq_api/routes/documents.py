# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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
from aiq_agent.knowledge.base import BaseIngestor
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

    SummaryStore (SQL, keyed by ``(collection, filename)``) is the source of
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
            logger.error(f"Failed to delete files from {collection_name}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

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
            logger.error(f"Failed to get job status: {e}")
            raise HTTPException(status_code=500, detail=str(e))

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
