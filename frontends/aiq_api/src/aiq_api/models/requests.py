"""Request and response models for knowledge API endpoints."""

from typing import Any

from pydantic import BaseModel
from pydantic import Field


class CreateCollectionRequest(BaseModel):
    """Request body for creating a collection."""

    name: str = Field(..., description="Unique collection name")
    description: str | None = Field(None, description="Human-readable description")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Backend-specific metadata")


class DeleteFilesRequest(BaseModel):
    """Request body for batch file deletion."""

    file_ids: list[str] = Field(..., description="List of file IDs to delete")


class IngestRequest(BaseModel):
    """Request body for URL-based ingestion."""

    file_ref: str = Field(..., description="Presigned URL or file reference to download")
    collection: str = Field(..., description="Target collection name")
    document_id: str | None = Field(None, description="Optional document tracking ID")


class GenerateSummaryRequest(BaseModel):
    """Request body for AI project summary generation."""

    profile_text: str = Field(..., description="Human-readable project profile text (label: value lines)")
    locale: str = Field(
        default="de",
        description="UI locale ('de' or 'en') — the language the summary must be written in",
    )


class GenerateSummaryResponse(BaseModel):
    """Response for AI project summary generation."""

    summary: str = Field(..., description="One-sentence generated project summary (empty string on failure)")
    error: str | None = Field(
        default=None,
        description=(
            "Failure code when summary generation could not complete "
            "(e.g. llm_not_configured, llm_request_failed, llm_response_malformed); "
            "None on success"
        ),
    )


class ConsistencyCheckField(BaseModel):
    """A single intake answer passed to the consistency check (label + rendered value)."""

    field: str = Field(..., description="Human-readable question label (echoed back in findings)")
    value: str = Field(..., description="Human-readable rendering of the user's answer")


class ConsistencyCheckRequest(BaseModel):
    """Request body for the end-of-wizard FREE-TEXT consistency check.

    Only free-text answers are scrutinised by the LLM. Structured answers
    (selects/numbers/booleans) are checked deterministically on the client and
    are passed here purely as read-only context, so the model can judge whether
    the free text contradicts them. Skipped/unknown answers are omitted upstream.
    """

    free_text: list[ConsistencyCheckField] = Field(
        default_factory=list,
        description="Free-text answers to scrutinise (e.g. goal details, high-building details)",
    )
    structured: list[ConsistencyCheckField] = Field(
        default_factory=list,
        description="Structured answers as read-only context (never themselves flagged here)",
    )
    locale: str = Field(
        default="de",
        description="UI locale ('de' or 'en') — the language the user-facing explanations must be written in",
    )


class ConsistencyFinding(BaseModel):
    """One detected contradiction involving a free-text answer."""

    fields: list[str] = Field(
        default_factory=list,
        description="Labels of the answers involved in the contradiction (echoed from the request)",
    )
    severity: str = Field(..., description="'warning' (soft, worth a look) or 'inconsistency' (hard contradiction)")
    explanation: str = Field(..., description="User-facing explanation of the contradiction, in the request locale")


class ConsistencyCheckResponse(BaseModel):
    """Response for the intake consistency check.

    ``findings`` is an empty list when the answers are internally consistent,
    a populated list when contradictions were found, and ``None`` when the
    check could not run (see ``error``). Always HTTP 200 — the wizard fails
    open and never blocks saving on a check outage.
    """

    findings: list[ConsistencyFinding] | None = Field(
        default=None,
        description="Detected contradictions ([] = consistent); None when the check could not complete",
    )
    error: str | None = Field(
        default=None,
        description=(
            "Failure code when the check could not complete "
            "(llm_not_configured, llm_request_failed, llm_response_malformed); None on success"
        ),
    )


class UploadResponse(BaseModel):
    """Response for document upload (async operation)."""

    job_id: str = Field(..., description="Job ID for polling status")
    file_ids: list[str] = Field(default_factory=list, description="IDs of uploaded files")
    message: str | None = Field(None, description="Status message")


class OibSyncResponse(BaseModel):
    """Response for OIB sync endpoint."""

    status: str
    message: str
    files_added: int
    files_total: int


class OibUploadedMember(BaseModel):
    """One PDF queued from a ZIP bulk upload (or rejected during extraction)."""

    file_name: str = Field(..., description="Member PDF basename.")
    status: str = Field(..., description="'pending' (queued for ingestion) or 'rejected'.")
    doc_class: str | None = Field(None, description="Pre-filled doc_class guess for accepted members.")
    reason: str | None = Field(None, description="Why the member was rejected (rejected members only).")


class OibDocumentUploadResponse(BaseModel):
    """Response for a platform-admin upload into the OIB base corpus.

    Single-file uploads populate ``file_name``/``doc_class``; ZIP bulk uploads
    populate ``members``/``accepted``/``rejected``. Ingestion runs in the
    background, so ``status`` is ``'pending'`` on a successful accept — the
    caller polls ``/v1/oib/status`` for the terminal lifecycle.
    """

    status: str = Field(..., description="'pending', 'success', 'failed', or 'timeout'.")
    file_name: str | None = Field(None, description="Uploaded PDF basename (single-file uploads).")
    message: str
    doc_class: str | None = Field(None, description="Stored/guessed doc_class (single-file uploads).")
    kind: str = Field("file", description="'file' for a single PDF, 'zip' for a bulk ZIP upload.")
    accepted: int | None = Field(None, description="Members queued for ingestion (ZIP uploads).")
    rejected: int | None = Field(None, description="Members skipped/rejected during extraction (ZIP uploads).")
    members: list[OibUploadedMember] | None = Field(None, description="Per-member outcome (ZIP uploads).")


class OibDocumentDeleteResponse(BaseModel):
    """Response for removing an OIB base-corpus document.

    ``mode`` distinguishes how the document was removed: ``'deleted'`` for an
    admin upload (source file + registry + chunks physically removed), or
    ``'excluded'`` for a repo-shipped file (chunks dropped and the basename
    recorded in the persistent exclusion set so a sync never re-ingests it).
    """

    success: bool
    file_name: str
    mode: str = Field("deleted", description="'deleted' for an admin upload, 'excluded' for a repo-shipped file.")
