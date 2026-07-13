# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""OIB admin routes."""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aiq_agent.knowledge.schema import FileStatus

from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Header
from fastapi import HTTPException
from fastapi import UploadFile
from fastapi import status
from fastapi.responses import FileResponse

from aiq_agent.oib_status import OibKnowledgeStatus

from ..models.requests import OibDocumentDeleteResponse
from ..models.requests import OibDocumentUploadResponse
from ..models.requests import OibSyncResponse

logger = logging.getLogger(__name__)

_ADMIN_TOKEN = os.environ.get("GRID_ADMIN_TOKEN")

# Upper bound for a single base-corpus PDF (the largest shipped OIB PDF is ~15 MB).
MAX_OIB_UPLOAD_BYTES = 100 * 1024 * 1024


def _require_admin_token(x_admin_token: str | None = Header(default=None)):
    if not _ADMIN_TOKEN:
        return
    if x_admin_token != _ADMIN_TOKEN:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin token")


def _run_ingestion() -> tuple[int, int]:
    # Import here to avoid heavy imports at module load time.
    from aiq_agent.oib_sync import sync

    return sync()


def _compute_status():
    # Import here to avoid heavy imports at module load time.
    from aiq_agent.oib_status import get_status

    return get_status()


def _sanitize_pdf_name(raw: str | None) -> str:
    """Basename-only, PDF-only filename for a corpus upload (400 otherwise)."""
    name = Path(raw or "").name.strip()
    if not name or not name.lower().endswith(".pdf"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A .pdf file is required")
    return name


def _ingest_uploaded_pdf(name: str, content: bytes) -> "FileStatus | None":
    # Import here to avoid heavy imports at module load time.
    from aiq_agent import oib_sync

    oib_sync.OIB_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    target = oib_sync.OIB_UPLOADS_DIR / name
    target.write_bytes(content)
    try:
        return oib_sync.ingest_single(target)
    except Exception:
        # Leave no half-ingested source behind: the file only stays once it
        # reached a terminal ingest state (retried by the next sync if failed).
        target.unlink(missing_ok=True)
        raise


def _delete_uploaded_pdf(name: str) -> bool:
    from aiq_agent import oib_sync

    return oib_sync.remove_uploaded_document(name)


def _resolve_corpus_pdf(file_name: str) -> Path | None:
    """Locate a corpus PDF by basename (uploads take precedence over the repo
    corpus, mirroring discovery), refusing any path component in the input."""
    from aiq_agent import oib_sync

    name = Path(file_name).name
    if not name or name != file_name or not name.lower().endswith(".pdf"):
        return None
    upload = oib_sync.OIB_UPLOADS_DIR / name
    if upload.is_file():
        return upload
    if oib_sync.OIB_DIR.exists():
        # rglob because the repo corpus may organize PDFs in subdirectories.
        for candidate in oib_sync.OIB_DIR.rglob(name):
            if candidate.is_file():
                return candidate
    return None


def add_oib_routes(router: APIRouter) -> None:
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="oib-sync-")

    @router.post(
        "/v1/admin/oib/sync",
        response_model=OibSyncResponse,
        tags=["oib"],
        summary="Trigger incremental OIB PDF ingestion",
    )
    async def sync_oib_documents(
        _: None = Depends(_require_admin_token),
    ) -> OibSyncResponse:
        try:
            added, total = await asyncio.get_event_loop().run_in_executor(executor, _run_ingestion)
            return OibSyncResponse(
                status="ok",
                message=f"OIB sync triggered: {added} file(s) added/changed, {total} total tracked",
                files_added=added,
                files_total=total,
            )
        except Exception as e:
            logger.exception("OIB sync failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

    @router.get(
        "/v1/oib/status",
        response_model=OibKnowledgeStatus,
        tags=["oib"],
        summary="Report exactly which OIB documents the knowledge base has indexed",
    )
    async def get_oib_status() -> OibKnowledgeStatus:
        """Merged per-file view of the OIB corpus (disk vs. registry vs. index).

        Read-only and unprivileged on purpose: it powers the user-facing
        knowledge-base transparency panel. Runs on a worker thread because it
        hashes corpus files and queries the vector store.
        """
        try:
            return await asyncio.to_thread(_compute_status)
        except Exception as e:
            logger.exception("OIB status failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

    @router.get(
        "/v1/oib/documents/{file_name}",
        tags=["oib"],
        summary="Stream a source PDF of the OIB base corpus",
    )
    async def get_oib_document(file_name: str) -> FileResponse:
        """Serves the original PDF so the UI can show cited sources in a
        viewer. Read-only and unprivileged, like /v1/oib/status. 404s when the
        deployment ships no sources (pre-baked index seed).
        """
        path = await asyncio.to_thread(_resolve_corpus_pdf, file_name)
        if path is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source PDF not available")
        return FileResponse(
            path,
            media_type="application/pdf",
            filename=path.name,
            content_disposition_type="inline",
        )

    @router.post(
        "/v1/admin/oib/documents",
        response_model=OibDocumentUploadResponse,
        tags=["oib"],
        summary="Upload a PDF into the shared OIB base corpus and ingest it",
    )
    async def upload_oib_document(
        file: UploadFile = File(..., description="PDF to add to the base knowledge corpus"),
        _: None = Depends(_require_admin_token),
    ) -> OibDocumentUploadResponse:
        """Platform-admin upload: persists the PDF to the writable uploads dir,
        replaces any same-named document's chunks, and blocks until ingestion
        reaches a terminal state (so the registry reflects the outcome).

        Runs on the same single-thread executor as /v1/admin/oib/sync so admin
        ingestion work is serialized against full corpus syncs.
        """
        from aiq_agent.knowledge.schema import FileStatus

        name = _sanitize_pdf_name(file.filename)
        content = await file.read()
        if not content:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty")
        if len(content) > MAX_OIB_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File exceeds {MAX_OIB_UPLOAD_BYTES // (1024 * 1024)} MB limit",
            )

        try:
            terminal = await asyncio.get_event_loop().run_in_executor(executor, _ingest_uploaded_pdf, name, content)
        except HTTPException:
            raise
        except Exception as e:
            logger.exception("OIB document upload failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        if terminal == FileStatus.SUCCESS:
            return OibDocumentUploadResponse(
                status="success", file_name=name, message=f"{name} ingested into the base corpus"
            )
        if terminal == FileStatus.FAILED:
            return OibDocumentUploadResponse(
                status="failed", file_name=name, message=f"Ingestion of {name} failed; it will be retried by sync"
            )
        return OibDocumentUploadResponse(
            status="timeout", file_name=name, message=f"Ingestion of {name} is still running; check status later"
        )

    @router.delete(
        "/v1/admin/oib/documents/{file_name}",
        response_model=OibDocumentDeleteResponse,
        tags=["oib"],
        summary="Remove an uploaded PDF from the OIB base corpus",
    )
    async def delete_oib_document(
        file_name: str,
        _: None = Depends(_require_admin_token),
    ) -> OibDocumentDeleteResponse:
        """Deletes an admin-uploaded document (source file, registry entry, and
        indexed chunks). Repo-shipped corpus files cannot be deleted here.
        """
        try:
            removed = await asyncio.get_event_loop().run_in_executor(executor, _delete_uploaded_pdf, file_name)
        except Exception as e:
            logger.exception("OIB document delete failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        if not removed:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No uploaded document with that name (repo corpus files cannot be deleted)",
            )
        return OibDocumentDeleteResponse(success=True, file_name=Path(file_name).name)
