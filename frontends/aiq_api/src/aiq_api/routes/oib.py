"""OIB admin routes."""

import asyncio
import io
import logging
import os
import tarfile
import tempfile
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
from ..models.requests import OibReingestRequest
from ..models.requests import OibReingestResponse
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


def _require_admin_token_strict(x_admin_token: str | None = Header(default=None)):
    """The admin token, failing CLOSED when none is configured.

    ``_require_admin_token`` lets every request through on a deployment without
    ``GRID_ADMIN_TOKEN`` (local dev). An export hands the whole licensed corpus
    to whoever asks, so it never runs unguarded.
    """
    if not _ADMIN_TOKEN:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Corpus export disabled")
    _require_admin_token(x_admin_token)


def _corpus_tarball() -> Path:
    """Every PDF in the corpus, flat under its basename, as a .tar.gz in a temp file.

    The corpus table is the set the agent indexes, so a consumer that ingests
    this tarball indexes what production indexes. Each file is fetched into this
    replica's cache on the way if it is not there yet. PDFs are already
    compressed; level 1 spends no time on a gain that is not there.
    """
    from aiq_agent import corpus_store

    handle = tempfile.NamedTemporaryFile(prefix="oib-corpus-", suffix=".tar.gz", delete=False)
    handle.close()
    path = Path(handle.name)
    try:
        with tarfile.open(path, "w:gz", compresslevel=1) as archive:
            for name in sorted(corpus_store.list_files()):
                pdf = corpus_store.ensure_local(name)
                if pdf is not None:  # deleted since the listing
                    archive.add(pdf, arcname=name)
    except BaseException:
        # The response's cleanup is only attached once this returns; a failed
        # build would otherwise leave a partial copy of the corpus on disk.
        path.unlink(missing_ok=True)
        raise
    return path


class _TemporaryFileResponse(FileResponse):
    """A ``FileResponse`` that deletes its file however the response ends.

    A background task is not enough: Starlette answers a malformed or
    unsatisfiable ``Range`` (400, 416) and a client that disconnects mid-send
    without ever reaching it, and each would leave a copy of the corpus behind.
    """

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            Path(self.path).unlink(missing_ok=True)


def _run_ingestion():
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


def _store_upload(name: str, content: bytes, doc_class: str | None) -> None:
    """Store an uploaded PDF in the shared corpus and queue its ingestion (``oib_sync.store_and_request``).

    Write-then-ingest ordering: the file is durably stored BEFORE the route
    responds, so an upload is never lost even if ingestion is slow to start or the
    process restarts — the next sync cycle queues it if this call could not. A
    same-named upload replaces the existing file (the admin's way to replace a
    document). The ingestion is a job on the ingest queue, run by whoever claims
    it; nothing is ingested here. A store that refuses the object raises, and
    the route answers with an error rather than a pending job that would never
    find its file; so does a queue that cannot take the job.
    """
    from aiq_agent import oib_sync

    oib_sync.store_and_request(name, content, doc_class)


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


def _queue_reingest(names: list[str]) -> tuple[list[str], list[str]]:
    """``(queued, unknown)``: each known name made to need ingestion again, with a job queued for it."""
    from aiq_agent import oib_sync

    queued: list[str] = []
    unknown: list[str] = []
    for name in names:
        if not oib_sync.mark_for_reingest(name):
            unknown.append(name)
            continue
        oib_sync.request_ingestion(name)
        queued.append(name)
    return queued, unknown


def _remove_document(name: str) -> bool:
    from aiq_agent import oib_sync

    return oib_sync.remove_document(name)


def _resolve_corpus_pdf(file_name: str) -> Path | None:
    """The local path of a corpus PDF by name, fetched into this replica's cache if needed.

    Refuses any path component in the input; ``None`` when the corpus does not
    list the file. A listed file that cannot be fetched raises ``CorpusStoreError``.
    """
    from aiq_agent import corpus_store

    return corpus_store.ensure_local(file_name)


def add_oib_routes(router: APIRouter) -> None:
    # 2 workers for the admin's blocking calls (a sync cycle, a delete). Ingestion is not
    # here: it is a job on the ingest queue, claimed by the ingest workers. Overlapping calls
    # are safe because oib_sync serializes what must not interleave: a per-file lock, across
    # replicas, around queueing a job and deleting a file, and one sync cycle at a time.
    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="oib-sync-")

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
            result = await asyncio.get_event_loop().run_in_executor(executor, _run_ingestion)
            return OibSyncResponse(
                status="ok",
                message=(
                    f"OIB sync finished: {result.enqueued} file(s) queued for ingestion, "
                    f"{result.ingested_recorded} finished, {result.failed} failed, {result.total} total tracked"
                ),
                files_added=result.enqueued,
                files_total=result.total,
            )
        except Exception as e:
            logger.exception("OIB sync failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

    @router.get(
        "/v1/admin/oib/corpus.tar.gz",
        tags=["oib"],
        summary="Export the OIB base corpus as a .tar.gz of its PDFs",
    )
    async def export_oib_corpus(
        _: None = Depends(_require_admin_token_strict),
    ) -> FileResponse:
        """The corpus a CI run ingests (the answer-suite workflow), built on a
        worker thread into a temp file that is removed once the response ends."""
        path = await asyncio.to_thread(_corpus_tarball)
        return _TemporaryFileResponse(path, media_type="application/gzip", filename="oib-corpus.tar.gz")

    @router.get(
        "/v1/oib/status",
        response_model=OibKnowledgeStatus,
        tags=["oib"],
        summary="Report exactly which OIB documents the knowledge base has indexed",
    )
    async def get_oib_status() -> OibKnowledgeStatus:
        """Merged per-file view of the OIB corpus (corpus table vs. index).

        Read-only and unprivileged on purpose: it powers the user-facing
        knowledge-base transparency panel. Runs on a worker thread because it
        queries the database and the vector store.
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
        corpus does not list the file, 503 when it lists it but the object
        store cannot serve it right now.
        """
        from aiq_agent.corpus_store import CorpusStoreError

        try:
            path = await asyncio.to_thread(_resolve_corpus_pdf, file_name)
        except CorpusStoreError as e:
            logger.exception("Could not fetch %s for the PDF viewer", file_name)
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)) from e
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
        """Platform-admin upload. Stores the file(s) in the shared corpus (object
        store plus table row) and queues each file's ingestion on the durable ingest
        queue, where the ingest workers claim it — the route returns promptly (status
        ``pending``) and the UI tracks progress via ``/v1/oib/status``.
        Write-then-ingest ordering guarantees a file is durably stored before the
        response, so an upload is never lost.

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
            await asyncio.to_thread(_store_upload, name, content, resolved_class)
        except Exception as e:
            logger.exception("Failed to store or queue OIB upload %s", name)
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        return OibDocumentUploadResponse(
            status="pending",
            kind="file",
            file_name=name,
            doc_class=resolved_class,
            message=f"{name} accepted; ingestion queued (poll /v1/oib/status)",
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
                await asyncio.to_thread(_store_upload, base_name, data, member_class)
            except Exception:
                logger.exception("Failed to store or queue ZIP member %s", base_name)
                members.append(
                    OibUploadedMember(file_name=base_name, status="rejected", reason="could not store or queue it")
                )
                continue
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
            message=f"{accepted_count} PDF(s) accepted; ingestion queued. {rejected_count} rejected/skipped.",
        )

    @router.delete(
        "/v1/admin/oib/documents/{file_name}",
        response_model=OibDocumentDeleteResponse,
        tags=["oib"],
        summary="Delete a document from the OIB base corpus",
    )
    async def delete_oib_document(
        file_name: str,
        _: None = Depends(_require_admin_token),
    ) -> OibDocumentDeleteResponse:
        """Deletes a base-corpus document: its indexed chunks, summary registration,
        corpus row, stored object and this replica's cached copy. A name only the
        index still knows (chunks a half-finished delete left behind) is cleared
        the same way.
        """
        try:
            removed = await asyncio.get_event_loop().run_in_executor(executor, _remove_document, file_name)
        except Exception as e:
            logger.exception("OIB document delete failed")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        if not removed:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No base-corpus document with that name",
            )
        return OibDocumentDeleteResponse(success=True, file_name=file_name)

    @router.post(
        "/v1/admin/oib/reingest",
        response_model=OibReingestResponse,
        tags=["oib"],
        summary="Re-index selected base-corpus documents without touching the rest",
    )
    async def reingest_oib_documents(
        request: OibReingestRequest,
        _: None = Depends(_require_admin_token),
    ) -> OibReingestResponse:
        """Force a rebuild of specific documents' chunks.

        `sync()` is incremental and gates on the sha256 of the PDF bytes, so it is a no-op
        for a document whose file has not changed. That is the right default and the wrong
        behaviour after anything that changes how chunks are BUILT rather than what they
        are built from — a chunking change, an embedding-model change, a partially failed
        ingest. Until now the only remedy was a corpus-wide re-ingest of all 39 PDFs
        including VLM captioning.

        Queued, not awaited, exactly like an upload: each document is a job on the ingest
        queue, which takes up to ten minutes once a worker claims it. The caller polls
        `/v1/oib/status`, where a queued document reads PENDING until its chunks are rebuilt.

        Unknown names are REPORTED rather than failing the request — a selection of twenty
        documents should not be lost because one was deleted in another tab.
        """

        names = list(dict.fromkeys(request.file_names))
        try:
            queued, unknown = await asyncio.get_event_loop().run_in_executor(executor, _queue_reingest, names)
        except Exception as e:
            logger.exception("OIB re-ingest could not be queued")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        if not queued:
            return OibReingestResponse(
                status="noop",
                queued=[],
                unknown=unknown,
                message="No base-corpus document matched the requested names",
            )
        message = f"Re-ingest queued for {len(queued)} document(s)"
        if unknown:
            message += f"; {len(unknown)} unknown name(s) skipped"
        return OibReingestResponse(status="pending", queued=queued, unknown=unknown, message=message)

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
        from aiq_agent.knowledge.factory import set_document_doc_class_suggestion

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
        # A person has decided; the suggestion has nothing left to offer.
        try:
            await asyncio.to_thread(set_document_doc_class_suggestion, oib_sync.COLLECTION_NAME, name, None)
        except Exception:  # noqa: BLE001 — the class is set; a stale offer is cosmetic
            logger.warning("Could not clear the Dokumentart suggestion for %s", name)
        return {"file_name": name, "doc_class": request.doc_class}

    class UpdateDisplayTitleRequest(BaseModel):
        display_title: str | None = Field(
            default=None,
            description="User-facing document name. Empty/null clears the override so the derived default applies.",
        )

    @router.patch(
        "/v1/admin/oib/documents/{file_name}/display-title",
        tags=["oib"],
        summary="Rename an OIB base-corpus document (user-facing display title)",
    )
    async def update_oib_display_title(
        file_name: str,
        request: UpdateDisplayTitleRequest,
        _: None = Depends(_require_admin_token),
    ) -> dict[str, str | None]:
        """Set the user-facing ``display_title`` on a base-corpus document's row.

        Retrieval is store-authoritative for the display title (the knowledge
        layer prefers the stored value over the derived filename default), so a
        rename reflects on citation chips immediately with NO re-ingest. A null or
        blank value clears the override, restoring the derived default. 404s when
        no metadata row exists for the document (the summary is the anchor).
        """
        from aiq_agent import oib_sync
        from aiq_agent.knowledge.factory import set_document_display_title

        name = Path(file_name).name
        new_title = (request.display_title or "").strip() or None

        try:
            updated = await asyncio.to_thread(set_document_display_title, oib_sync.COLLECTION_NAME, name, new_title)
        except Exception as e:
            logger.exception("OIB display_title update failed for %s", name)
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)) from e

        if not updated:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No summary found for '{name}' in the base corpus",
            )
        return {"file_name": name, "display_title": new_title}
