"""OIB admin routes."""

import asyncio
import io
import logging
import os
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import Header
from fastapi import HTTPException
from fastapi import UploadFile
from fastapi import status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pydantic import Field

from aiq_agent.knowledge.document_classification import is_valid_doc_class
from aiq_agent.oib_status import OibKnowledgeStatus

from ..models.requests import OibDocumentDeleteResponse
from ..models.requests import OibDocumentUploadResponse
from ..models.requests import OibSyncResponse
from ..models.requests import OibUploadedMember

logger = logging.getLogger(__name__)

_ADMIN_TOKEN = os.environ.get("GRID_ADMIN_TOKEN")

# Upper bound for a single base-corpus PDF (the largest shipped OIB PDF is ~15 MB).
# Also the cap applied per member AND to the total extracted payload of a ZIP.
MAX_OIB_UPLOAD_BYTES = 100 * 1024 * 1024

# Content types / extensions that mark a bulk ZIP upload.
_ZIP_CONTENT_TYPES = frozenset({"application/zip", "application/x-zip-compressed", "application/x-zip"})


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


def _persist_upload(name: str, content: bytes) -> Path:
    """Write an uploaded PDF into the writable uploads dir and return its path.

    Write-then-ingest ordering: the file is durably on disk (under the persistent
    data volume) BEFORE the route responds, so an upload is never lost even if
    background ingestion is slow to start or the process restarts — the next
    ``sync()`` picks it up. A same-named upload overwrites the existing file
    (the admin's way to replace a document).
    """
    from aiq_agent import oib_sync

    oib_sync.OIB_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    target = oib_sync.OIB_UPLOADS_DIR / name
    target.write_bytes(content)
    # (Re)uploading a document is an explicit "I want this in the corpus", so lift
    # any persistent exclusion left behind by a prior delete of the same basename.
    # Without this, discover_pdfs() and the /v1/oib/status panel keep filtering the
    # freshly uploaded file out (it stays on the exclusion list), so the upload
    # succeeds and indexes but never reappears in the UI.
    oib_sync.unexclude_document(name)
    return target


def _ingest_and_classify(target: Path, doc_class: str) -> None:
    """Background job: ingest an already-persisted PDF, then persist its doc_class.

    Runs on the shared single-thread executor (serialized against full corpus
    syncs). Ingestion creates the summary row, so the ``doc_class`` UPDATE is
    applied only after a SUCCESS terminal state. Fully self-contained: it owns
    the same failed-file cleanup guarantee the blocking route had — a source that
    raises before reaching a terminal state is unlinked so no half-ingested file
    lingers (a terminal FAILED is left on disk for the next sync to retry).
    """
    from aiq_agent import oib_sync
    from aiq_agent.knowledge.factory import set_document_doc_class
    from aiq_agent.knowledge.schema import FileStatus

    name = target.name
    try:
        terminal = oib_sync.ingest_single(target)
    except Exception:
        target.unlink(missing_ok=True)
        logger.exception("Background ingestion crashed for %s; removed the source file", name)
        return

    if terminal == FileStatus.SUCCESS:
        try:
            updated = set_document_doc_class(oib_sync.COLLECTION_NAME, name, doc_class)
            if not updated:
                logger.warning("No summary row to stamp doc_class for %s after ingest", name)
        except Exception:
            logger.exception("Failed to persist doc_class=%s for %s after ingest", doc_class, name)
    elif terminal == FileStatus.FAILED:
        logger.error("Background ingestion of %s failed; it will be retried by the next sync", name)
    else:
        logger.error("Background ingestion of %s timed out; it will be retried by the next sync", name)


def _is_safe_zip_member(member_name: str, base_dir: Path) -> bool:
    """Reject zip-slip: absolute paths and members that escape ``base_dir``."""
    if not member_name or member_name.endswith("/"):
        return False  # directory entry
    if Path(member_name).is_absolute() or member_name.startswith(("/", "\\")):
        return False
    base_resolved = base_dir.resolve()
    try:
        target = (base_dir / member_name).resolve()
    except (OSError, ValueError):
        return False
    return target == base_resolved or base_resolved in target.parents


def _extract_zip_pdfs(content: bytes) -> tuple[list[tuple[str, bytes]], list[tuple[str, str]]]:
    """Safely extract member PDFs from a ZIP upload.

    Returns ``(accepted, rejected)`` where ``accepted`` is a list of
    ``(basename, bytes)`` and ``rejected`` is a list of ``(name, reason)``.
    Enforces zip-slip safety (absolute/escaping paths rejected), skips
    directories and non-``.pdf`` members, and caps both each member and the
    running total at :data:`MAX_OIB_UPLOAD_BYTES`. A ``base_dir`` is only used as
    the anchor for the resolved-path escape check; nothing is written there.
    """
    accepted: list[tuple[str, bytes]] = []
    rejected: list[tuple[str, str]] = []
    seen_names: set[str] = set()
    total_bytes = 0
    # A stable, non-existent anchor for the zip-slip resolved-path check.
    base_dir = Path(os.getcwd()) / "__oib_zip_extract__"

    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid ZIP archive: {exc}") from exc

    for member in archive.infolist():
        member_name = member.filename
        if member.is_dir() or member_name.endswith("/"):
            continue
        display = Path(member_name).name or member_name
        if not _is_safe_zip_member(member_name, base_dir):
            rejected.append((display, "unsafe path (absolute or escapes archive root)"))
            continue
        if not member_name.lower().endswith(".pdf"):
            rejected.append((display, "not a .pdf"))
            continue
        base_name = Path(member_name).name
        if base_name in seen_names:
            rejected.append((base_name, "duplicate member name"))
            continue
        if member.file_size == 0:
            rejected.append((base_name, "empty file"))
            continue
        if member.file_size > MAX_OIB_UPLOAD_BYTES:
            rejected.append((base_name, f"exceeds {MAX_OIB_UPLOAD_BYTES // (1024 * 1024)} MB per-file limit"))
            continue
        if total_bytes + member.file_size > MAX_OIB_UPLOAD_BYTES:
            rejected.append((base_name, f"total extracted size exceeds {MAX_OIB_UPLOAD_BYTES // (1024 * 1024)} MB"))
            continue
        try:
            data = archive.read(member)
        except Exception as exc:
            rejected.append((base_name, f"could not read member: {exc}"))
            continue
        seen_names.add(base_name)
        total_bytes += len(data)
        accepted.append((base_name, data))

    return accepted, rejected


def _remove_document(name: str) -> str | None:
    from aiq_agent import oib_sync

    return oib_sync.remove_document(name)


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

    def _is_zip_upload(upload: UploadFile) -> bool:
        content_type = (upload.content_type or "").split(";")[0].strip().lower()
        name = (upload.filename or "").lower()
        return content_type in _ZIP_CONTENT_TYPES or name.endswith(".zip")

    @router.post(
        "/v1/admin/oib/documents",
        response_model=OibDocumentUploadResponse,
        tags=["oib"],
        summary="Upload a PDF (or a ZIP of PDFs) into the shared OIB base corpus",
    )
    async def upload_oib_document(
        file: UploadFile = File(..., description="PDF, or a ZIP of PDFs, to add to the base knowledge corpus"),
        doc_class: str | None = Form(
            None,
            description="Optional explicit doc_class ('Dokumentart'). Omitted → guessed from the filename.",
        ),
        _: None = Depends(_require_admin_token),
    ) -> OibDocumentUploadResponse:
        """Platform-admin upload. Persists the file(s) to the writable uploads dir
        and kicks ingestion on the shared background executor WITHOUT blocking on
        the terminal state — the route returns promptly (status ``pending``) and
        the UI tracks progress via ``/v1/oib/status``. Write-then-ingest ordering
        guarantees a file is durably on disk before the response, so an upload is
        never lost.

        - A single PDF: ``doc_class`` is validated (400 if off-vocabulary) or
          guessed from the filename, and stamped onto the summary row once
          ingestion succeeds.
        - A ZIP (``application/zip`` or ``*.zip``): member PDFs are extracted
          safely (zip-slip rejected, non-PDFs skipped, per-member + total size
          capped), each queued for ingestion with a filename-guessed doc_class
          (bulk onboarding; per-file class is corrected later via PATCH).
        """
        from aiq_agent.common.norm_registry import guess_doc_class

        content = await file.read()
        if not content:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty")
        if len(content) > MAX_OIB_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File exceeds {MAX_OIB_UPLOAD_BYTES // (1024 * 1024)} MB limit",
            )

        if _is_zip_upload(file):
            return await _handle_zip_upload(content)

        # Single-PDF upload.
        name = _sanitize_pdf_name(file.filename)
        if doc_class is not None and not is_valid_doc_class(doc_class):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown doc_class '{doc_class}'",
            )
        resolved_class = doc_class if doc_class is not None else guess_doc_class(name)

        try:
            target = await asyncio.to_thread(_persist_upload, name, content)
        except Exception as e:
            logger.exception("Failed to persist OIB upload %s", name)
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        # Kick ingestion on the shared executor WITHOUT awaiting the terminal state.
        executor.submit(_ingest_and_classify, target, resolved_class)

        return OibDocumentUploadResponse(
            status="pending",
            kind="file",
            file_name=name,
            doc_class=resolved_class,
            message=f"{name} accepted; ingestion started (poll /v1/oib/status)",
        )

    async def _handle_zip_upload(content: bytes) -> OibDocumentUploadResponse:
        from aiq_agent.common.norm_registry import guess_doc_class

        accepted, rejected = await asyncio.to_thread(_extract_zip_pdfs, content)
        if not accepted and not rejected:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ZIP archive contained no PDF files",
            )

        members: list[OibUploadedMember] = []
        for base_name, data in accepted:
            member_class = guess_doc_class(base_name)
            try:
                target = await asyncio.to_thread(_persist_upload, base_name, data)
            except Exception:
                logger.exception("Failed to persist ZIP member %s", base_name)
                members.append(OibUploadedMember(file_name=base_name, status="rejected", reason="could not persist"))
                continue
            executor.submit(_ingest_and_classify, target, member_class)
            members.append(OibUploadedMember(file_name=base_name, status="pending", doc_class=member_class))

        for name, reason in rejected:
            members.append(OibUploadedMember(file_name=name, status="rejected", reason=reason))

        accepted_count = sum(1 for m in members if m.status == "pending")
        rejected_count = sum(1 for m in members if m.status == "rejected")
        return OibDocumentUploadResponse(
            status="pending",
            kind="zip",
            accepted=accepted_count,
            rejected=rejected_count,
            members=members,
            message=f"{accepted_count} PDF(s) accepted; ingestion started. {rejected_count} rejected/skipped.",
        )

    @router.delete(
        "/v1/admin/oib/documents/{file_name}",
        response_model=OibDocumentDeleteResponse,
        tags=["oib"],
        summary="Remove any document from the OIB base corpus",
    )
    async def delete_oib_document(
        file_name: str,
        _: None = Depends(_require_admin_token),
    ) -> OibDocumentDeleteResponse:
        """Removes a base-corpus document from what the RAG grounds on.

        - An admin-uploaded document is deleted outright (source file, registry
          entry and indexed chunks) → ``mode="deleted"``.
        - A repo-shipped document (which lives in git and cannot be physically
          deleted) is removed from the active corpus via a persistent exclusion:
          its chunks are dropped and a sync never re-ingests it → ``mode="excluded"``.
        """
        try:
            mode = await asyncio.get_event_loop().run_in_executor(executor, _remove_document, file_name)
        except Exception as e:
            logger.exception("OIB document delete failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        if mode is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No base-corpus document with that name",
            )
        return OibDocumentDeleteResponse(success=True, file_name=Path(file_name).name, mode=mode)

    class UpdateDocClassRequest(BaseModel):
        doc_class: str = Field(..., description="Explicit doc_class ('Dokumentart'); must be in the vocabulary.")

    @router.patch(
        "/v1/admin/oib/documents/{file_name}/doc-class",
        tags=["oib"],
        summary="Reclassify an OIB base-corpus document's Dokumentart",
    )
    async def update_oib_doc_class(
        file_name: str,
        request: UpdateDocClassRequest,
        _: None = Depends(_require_admin_token),
    ) -> dict[str, str]:
        """Set the explicit ``doc_class`` on a base-corpus document's summary row.

        Because retrieval is store-authoritative for ``doc_class`` (the resolver
        in ``knowledge_layer`` prefers the stored value over chunk metadata), this
        edit reflects immediately with NO re-ingest. Validates against the closed
        vocabulary (400 off-vocabulary) and 404s when no summary row exists for
        the document (the summary is the anchor; there is nothing to classify
        without one).
        """
        from aiq_agent import oib_sync
        from aiq_agent.knowledge.factory import set_document_doc_class

        name = Path(file_name).name
        if request.doc_class is None or not is_valid_doc_class(request.doc_class):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown doc_class '{request.doc_class}'",
            )

        try:
            updated = await asyncio.to_thread(set_document_doc_class, oib_sync.COLLECTION_NAME, name, request.doc_class)
        except Exception as e:
            logger.exception("OIB doc_class update failed for %s", name)
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        if not updated:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No summary found for '{name}' in the base corpus",
            )
        return {"file_name": name, "doc_class": request.doc_class}
