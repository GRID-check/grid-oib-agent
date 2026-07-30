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
    thumbnail_upload_url: str | None = Field(None, description="Presigned URL for uploading a generated thumbnail")


class DocumentSearchRequest(BaseModel):
    """Request body for deterministic semantic document search within a collection."""

    query: str = Field(..., min_length=1, max_length=1000, description="Natural-language search query")
    top_k: int = Field(40, ge=1, le=100, description="Max chunks to retrieve before document-centric aggregation")
    top_k_files: int = Field(20, ge=1, le=100, description="Max documents to return after aggregation")


class DocumentSearchHit(BaseModel):
    """One document-centric search hit (a file's best-matching chunk)."""

    file_name: str = Field(..., description="Original filename of the matched document")
    score: float = Field(..., description="Similarity score (0.0 to 1.0) of the file's best-matching chunk")
    snippet: str = Field(..., description="Snippet (~300 chars) from the file's best-matching chunk")
    page_number: int | None = Field(None, description="Page number of the best-matching chunk (None if N/A)")
    collection: str = Field(..., description="Collection the document belongs to")


class DocumentSearchResponse(BaseModel):
    """Response for semantic document search: document-centric hits, best score first."""

    hits: list[DocumentSearchHit] = Field(
        default_factory=list, description="Matched documents (one per file), sorted by score descending"
    )


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


class ConversationTitleMessage(BaseModel):
    """One turn of the opening exchange used to name a conversation."""

    role: str = Field(..., description="'user' or 'assistant'")
    content: str = Field(..., description="Plain-text message content (no cards/markup)")


class GenerateConversationTitleRequest(BaseModel):
    """Request body for ChatGPT-style conversation naming + topic tagging.

    The UI sends the opening exchange (first user question and, when available,
    the assistant's answer). The LLM returns a short human title describing what
    the inquiry was about plus 0–3 OIB topic tags drawn from a fixed vocabulary.
    """

    messages: list[ConversationTitleMessage] = Field(
        default_factory=list,
        description="Opening exchange, oldest first (first user question + optional assistant answer)",
    )
    allowed_tags: list[str] = Field(
        default_factory=list,
        description="Closed vocabulary of topic tag keys the model may choose from",
    )
    locale: str = Field(
        default="de",
        description="UI locale ('de' or 'en') — the language the title must be written in",
    )


class GenerateConversationTitleResponse(BaseModel):
    """Response for conversation naming + tagging."""

    title: str = Field(..., description="Concise conversation title (empty string on failure)")
    tags: list[str] = Field(
        default_factory=list,
        description="Chosen topic tag keys (subset of allowed_tags; empty on failure or when none fit)",
    )
    error: str | None = Field(
        default=None,
        description=(
            "Failure code when naming could not complete "
            "(e.g. llm_not_configured, llm_request_failed, llm_response_malformed); "
            "None on success"
        ),
    )


class FeedbackDigestTopic(BaseModel):
    """Votes on one OIB topic tag, for the digest's per-topic reading."""

    topic: str = Field(..., description="Conversation topic tag key (e.g. 'brandschutz')")
    up: int = Field(0, ge=0, description="Helpful votes on conversations carrying this tag")
    down: int = Field(0, ge=0, description="Unhelpful votes on conversations carrying this tag")


class FeedbackDigestOrgShare(BaseModel):
    """One organization's vote counts, DELIBERATELY without its identifier.

    The digest needs to know whether a problem is spread across tenants or is
    one tenant's, which is a question about the shape of the distribution, not
    about who is in it. Sending the ids would put tenant identities in a
    third-party model's request log to buy a naming the reader already has: the
    per-organization table sits directly under the digest on the same screen.
    """

    up: int = Field(0, ge=0)
    down: int = Field(0, ge=0)


class FeedbackDigestSample(BaseModel):
    """One rated question, as the digest's only free-text evidence.

    The QUESTION only — never the answer. Naming themes needs what people asked;
    it does not need the generated text back, and answers are the long half.
    """

    verdict: str = Field(..., description="'up' or 'down'")
    reason: str | None = Field(None, description="Down-vote reason key, when the vote carried one")
    topics: list[str] = Field(default_factory=list, description="Topic tag keys of the conversation")
    question: str = Field(..., description="The user's question, truncated by the caller")


class FeedbackDigestRequest(BaseModel):
    """Request body for the plain-language answer-feedback digest.

    An aggregate plus a bounded sample of questions. Everything identifying —
    organization ids, user ids, conversation ids — is stripped by the caller;
    what arrives is counts and questions.
    """

    window_days: int = Field(30, ge=1, le=365, description="Days of history the aggregate covers")
    answers: int = Field(0, ge=0, description="Assistant answers produced in the window (the denominator)")
    up: int = Field(0, ge=0, description="Helpful votes")
    down: int = Field(0, ge=0, description="Unhelpful votes")
    voters: int = Field(0, ge=0, description="Distinct people who voted")
    down_voters: int = Field(0, ge=0, description="Distinct people behind the unhelpful votes")
    reasons: dict[str, int] = Field(
        default_factory=dict,
        description="Down-vote reason key → count",
    )
    topics: list[FeedbackDigestTopic] = Field(default_factory=list, description="Per-topic vote counts")
    organizations: list[FeedbackDigestOrgShare] = Field(
        default_factory=list,
        description="Per-organization vote counts, anonymised (see FeedbackDigestOrgShare)",
    )
    trend_delta_points: float | None = Field(
        None,
        description=(
            "Change in the helpful rate in percentage points, last third of the window "
            "against the first third. Positive = improving. None when too sparse to read."
        ),
    )
    samples: list[FeedbackDigestSample] = Field(
        default_factory=list,
        description="Bounded sample of rated questions, both directions",
    )
    locale: str = Field("de", description="UI locale ('de' or 'en') — the language the digest is written in")


class FeedbackDigestResponse(BaseModel):
    """The digest: a headline plus what is working and what is not.

    ``strengths`` and ``concerns`` are separate REQUIRED fields rather than one
    list of observations, because that is the whole point of the endpoint: a
    summary free to return only problems will return only problems, and the
    surface this backs was already too good at that.
    """

    headline: str = Field("", description="Two or three plain sentences summarising the window")
    strengths: list[str] = Field(default_factory=list, description="What the data says is working (0–3)")
    concerns: list[str] = Field(default_factory=list, description="What the data says needs attention (0–3)")
    recommendation: str | None = Field(
        None,
        description="One concrete next step, when the data supports one",
    )
    error: str | None = Field(
        default=None,
        description=(
            "Failure code when the digest could not be produced "
            "(llm_not_configured, llm_request_failed, llm_response_malformed); None on success"
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
