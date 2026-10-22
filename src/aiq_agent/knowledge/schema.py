"""
Universal Schema for Knowledge Layer.

This module defines the "Golden Record" - strict Pydantic models that all
adapters must output. This ensures agents always see a consistent format
whatever adapter produced them (the llamaindex backend, or a test fake).

Schema Rules (enforced by all adapters):
1. Five Pillars: content_type MUST be exactly "text", "table", "chart", "image", or "drawing"
2. Display Citation: display_citation MUST be populated with human-readable string
3. Visual Safety: content MUST NEVER be None (use empty string for visuals)
4. Data vs View: Raw data in structured_data, renderable image in image_url
5. Link Rot: image_url MUST be presigned URL, not internal S3 path
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import Field
from pydantic import SerializerFunctionWrapHandler
from pydantic import model_serializer
from pydantic import model_validator


class ContentType(StrEnum):
    """
    The Five Pillars - strict content categorization.

    All adapters MUST map their internal types to one of these five categories.
    The frontend relies on this for component switching.
    """

    TEXT = "text"
    TABLE = "table"
    CHART = "chart"
    IMAGE = "image"
    DRAWING = "drawing"


class Chunk(BaseModel):
    """
    The Atomic Unit of Knowledge (The 'Golden Record').

    This schema is what every adapter outputs (llamaindex, and the test fakes)
    so the Agent always sees a consistent format.
    """

    # --- 1. Core Data (The Agent Reads This) ---
    chunk_id: str = Field(..., description="Unique ID for citation tracking.")
    content: str = Field(
        ...,
        description="The main text. If this is a visual/table, this MUST be the summary or caption.",
    )
    score: float = Field(0.0, ge=0.0, le=1.0, description="Similarity score (0.0 to 1.0).")

    # --- 2. Strict Citation Contract (For UI Reliability) ---
    file_name: str = Field(..., description="Original filename (for example, 'Q3_Report.pdf').")
    page_number: int | None = Field(
        None,
        ge=1,
        description="The page number (1-based). None if not applicable (for example, JSON/TXT).",
    )
    display_citation: str = Field(
        ...,
        description="User-facing citation label. Adapters MUST populate this.",
    )

    # --- 3. The Four Pillars (Strictly Typed) ---
    content_type: ContentType = Field(
        ...,
        description="The semantic category of this chunk.",
    )
    content_subtype: str | None = Field(
        None,
        description="Granular subtype (for example, 'bar_chart', 'pie_chart').",
    )

    # --- 4. The 'Deep' Payload (Optional) ---
    structured_data: str | None = Field(
        None,
        description="Raw code/data representation for Code Interpreter analysis.",
    )

    # --- 5. Visual Assets (Optional) ---
    image_storage_uri: str | None = Field(
        None,
        description="Internal S3/SeaweedFS URI for system access.",
    )
    image_url: str | None = Field(
        None,
        description="Presigned HTTP URL for frontend display.",
    )

    # --- 6. Retrieval Provenance (Optional) ---
    # Rank fusion is scale-free, which is why these exist: session/project collections
    # sit in a worse cosine band than the professionally chunked base corpus, so a user's
    # own upload can never win on raw score. Its RANK inside its own collection is
    # comparable across collections even when its score is not.
    retrieval_rank: int | None = Field(
        None,
        ge=0,
        description=(
            "0-based rank of this chunk within the collection that produced it, after "
            "intra-collection fusion. None when the producing backend did not stamp one."
        ),
    )
    fusion_score: float | None = Field(
        None,
        description=(
            "Diagnostic reciprocal-rank-fusion score from the cross-collection merge. "
            "Never displayed to the user or the LLM; `score` remains the true similarity."
        ),
    )

    # --- 7. Extra Metadata ---
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Passthrough for extra backend-specific metadata.",
    )

    @model_validator(mode="before")
    @classmethod
    def ensure_content_string(cls, data: Any) -> Any:
        """Safety check: Ensure content is never None, even if backend returns None."""
        if isinstance(data, dict):
            if data.get("content") is None:
                data["content"] = ""
        return data


class RetrievalResult(BaseModel):
    """The container object returned by the retrieve_documents tool."""

    chunks: list[Chunk] = Field(default_factory=list)
    total_tokens: int = Field(0, ge=0, description="Estimated token count for context management.")
    query: str = Field(..., description="The original query that produced these results.")
    backend: str = Field(..., description="The backend that produced these results.")
    success: bool = Field(default=True, description="Whether retrieval succeeded.")
    error_message: str | None = Field(default=None, description="Error details if retrieval failed.")


class JobState(StrEnum):
    """Ingestion job states for async processing."""

    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    #: A person stopped the job before it finished (``claim_queue.CANCELLED``).
    #: Terminal, and neither a failure nor a success: nothing went wrong, but
    #: nothing was indexed either. A reader shows it as its own state.
    CANCELLED = "cancelled"


class FileStatus(StrEnum):
    """File processing status for UI tracking."""

    UPLOADING = "uploading"
    INGESTING = "ingesting"
    SUCCESS = "success"
    FAILED = "failed"


#: Namespace of ``stable_file_id``. Fixed for good: changing it renames every file.
_FILE_ID_NAMESPACE = uuid.UUID("6f1c0a52-3b7e-4d8a-9c41-5e2d7a90b3f6")


def stable_file_id(collection_name: str, file_name: str) -> str:
    """The id of a file: a function of where it lives and what it is called, nothing else.

    A file is identified by ``(collection, file name)`` everywhere else (its
    chunks, its summary row, a delete), so its id is too. Any process derives
    the same id without asking another, which is what lets the ``api`` process
    list a file the ``ingest-worker`` indexed, and delete it by the id it listed.
    A random id per call, or per ingest, could not be handed from one to the other.
    """
    return str(uuid.uuid5(_FILE_ID_NAMESPACE, f"{collection_name}\x00{file_name}"))


class CollectionInfo(BaseModel):
    """
    Metadata about a collection/index.

    Used by UI to display available sources/collections.
    """

    name: str = Field(..., description="Unique collection name.")
    description: str | None = Field(None, description="Human-readable description.")
    file_count: int = Field(0, ge=0, description="Number of files in this collection.")
    chunk_count: int = Field(0, ge=0, description="Total number of chunks/vectors.")
    created_at: datetime | None = Field(None, description="When the collection was created.")
    updated_at: datetime | None = Field(None, description="Last modification time.")
    backend: str = Field(..., description="Backend that manages this collection.")
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Backend-specific metadata (e.g., embedding model, vector dimensions).",
    )


class QuarantineReason(BaseModel):
    """One reason the upload screen held a file back (ADR-0086, ADR-0113).

    A term the office listed, or a detector (``iban``, ``at_svnr``,
    ``credit_card``); never a matched value. A detector's ``sample`` is masked
    before it gets here (``AT61 •••• •••• •••• 3201``). ``kind`` is open: a
    detector the job learns first reaches a reader as a kind it does not know,
    which it reads as ``other`` rather than failing the whole verdict.

    Serialised in one shape wherever it is dumped (the job status, the
    collection file list, the legacy ``quarantined:`` string): ``term`` and
    ``sample`` only when set, ``pages_truncated`` only when true. The BFF's
    ``verdictSchema`` (``frontends/ui/src/lib/upload-screening/quarantine.ts``)
    reads exactly that, and ``tests/fixtures/quarantine_verdict_cases.json``
    holds the two to it.
    """

    kind: str = Field(..., min_length=1, description="`term`, or the detector that matched.")
    term: str | None = Field(None, description="The office's term, as it wrote it; only for `kind == 'term'`.")
    count: int = Field(..., ge=0, description="How often it was found.")
    pages: list[int] = Field(default_factory=list, description="The pages it was found on, ascending, capped.")
    pages_truncated: bool = Field(False, description="`pages` is not every page it was found on.")
    sample: str | None = Field(None, description="A detector's MASKED sample; never the value.")

    @model_serializer(mode="wrap")
    def _compact(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data = handler(self)
        for key in ("term", "sample"):
            if data.get(key) is None:
                data.pop(key, None)
        if not data.get("pages_truncated"):
            data.pop("pages_truncated", None)
        return data


class QuarantineVerdict(BaseModel):
    """Why the upload screen held a file back, as data (ADR-0113).

    Built only by ``ScreeningVerdict.to_model`` in the knowledge layer's
    ``screening.py``, which bounds it: at most ten reasons, at most fifty pages
    a reason, and the whole within two thousand characters of JSON, cutting
    pages before reasons. ``omitted`` says how many reasons it left out, so a
    short list is never read as the whole one; it is serialised only when it is
    not zero, and ``checked`` always. ``after_transcription`` is serialised only
    when true.
    """

    reasons: list[QuarantineReason] = Field(default_factory=list)
    checked: Literal["full", "partial"] = Field(
        ..., description="`partial` when some of the file's content went unscreened (pages without a text layer)."
    )
    omitted: int = Field(0, ge=0, description="Reasons found and not listed.")
    after_transcription: bool = Field(
        False,
        description=(
            "The match was in the vision model's transcript of the file's scanned pages: the vision model saw "
            "those pages, and no later model call (summary, tags, embeddings) saw anything of the file."
        ),
    )

    @model_serializer(mode="wrap")
    def _compact(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data = handler(self)
        if not data.get("omitted"):
            data.pop("omitted", None)
        if not data.get("after_transcription"):
            data.pop("after_transcription", None)
        return data


class FileInfo(BaseModel):
    """
    Metadata about a file within a collection.

    Used by UI to display files and their processing status.
    """

    file_id: str = Field(..., description="Unique file identifier.")
    file_name: str = Field(..., description="Original filename.")
    collection_name: str = Field(..., description="Collection this file belongs to.")
    status: FileStatus = Field(default=FileStatus.UPLOADING, description="Current processing status.")
    file_size: int | None = Field(None, ge=0, description="File size in bytes.")
    chunk_count: int = Field(0, ge=0, description="Number of chunks created from this file.")
    uploaded_at: datetime | None = Field(None, description="When the file was uploaded.")
    ingested_at: datetime | None = Field(None, description="When ingestion completed.")
    expiration_date: datetime | None = Field(None, description="When the file will be auto-deleted.")
    error_message: str | None = Field(None, description="Error message if processing failed.")
    quarantine: QuarantineVerdict | None = Field(
        None,
        description=(
            "Why the upload screen held the file back (ADR-0086), when it did: the job's typed verdict "
            "(ADR-0113). Read this, never the `quarantined:` text `error_message` still carries for older readers."
        ),
    )
    summary: str | None = Field(None, description="One-sentence summary of the document content, if generated.")
    tags: list[str] | None = Field(
        None,
        description="Controlled ingestion-generated tags (document type + OIB discipline), if classified.",
    )
    folder_path: str | None = Field(
        None,
        description=(
            "Materialised folder path the document is filed under "
            "(e.g. 'Brandschutz/Fluchtwege'). None means the project root."
        ),
    )
    topics: list[str] | None = Field(
        None,
        description=(
            "Open topics (Themen) Piloti recognised in the document, or set by a person; "
            "free terms such as 'Attika', beside the controlled tags."
        ),
    )
    capture: dict[str, Any] | None = Field(
        None,
        description=(
            "What the camera wrote into a photo: captured_at (ISO 8601), latitude, longitude, camera; "
            "present keys only. Coordinates are for the BFF and the people who may open the file, "
            "never for a model."
        ),
    )
    superseded_by: str | None = Field(
        None,
        description=(
            "File name of the newer Fassung in this collection that a PERSON confirmed replaces this one. "
            "Piloti never sets it on its own."
        ),
    )
    supersedes: list[str] | None = Field(
        None,
        description="File names this document replaces by a person's confirmation (the reverse of superseded_by).",
    )
    revision_suggestion: dict[str, Any] | None = Field(
        None,
        description=(
            "Piloti's open suggestion that this document is a newer Fassung of another: of (the older file name), "
            "confidence (0..1), reason (German, short), basis ('title_block', 'name' or 'content'). "
            "Absent once dismissed."
        ),
    )
    revision_facts: dict[str, Any] | None = Field(
        None,
        description=(
            "What the title block (Plankopf) of the first drawing page that has one says, read during ingestion: "
            "document_number, revision (the Index as printed), revision_date (ISO), scale, title and the page "
            "they were read on; present keys only. Absent when no page has a legible title block."
        ),
    )
    change_summary: str | None = Field(
        None,
        description="German bullet lines on what changed against the Fassung it replaces (change_basis).",
    )
    change_basis: str | None = Field(
        None,
        description="File name the change_summary compared against (this file's own name: its previous upload).",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="File-specific metadata (e.g., page count, content types).",
    )


class FileProgress(BaseModel):
    """Progress tracking for individual files within an ingestion job."""

    file_id: str = Field(default="", description="Unique identifier for the file.")
    file_name: str = Field(..., description="Name of the file being processed.")
    status: FileStatus = Field(default=FileStatus.UPLOADING, description="Current processing status.")
    progress_percent: float = Field(0.0, ge=0.0, le=100.0, description="Processing progress (0-100).")
    error_message: str | None = Field(default=None, description="Error message if processing failed.")
    chunks_created: int = Field(0, ge=0, description="Number of chunks created from this file.")
    pages_failed: int = Field(
        0,
        ge=0,
        description="PDF pages that could not be read and are missing from the index (below the failure threshold).",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Extraction counts for this file that the chunk count does not show, e.g. "
            "`images_over_cap`: embedded images left unanalysed by AIQ_MAX_IMAGES_PER_DOCUMENT; "
            "`images_over_pixel_budget`: embedded images refused before decoding by "
            "AIQ_MAX_IMAGE_PIXELS; "
            "`pages_transcribed`, `pages_transcription_failed`, `pages_over_ocr_cap`, "
            "`pages_not_transcribed_no_vlm`: scanned or garbled PDF pages and what became of them; "
            "`drawing_pages_over_cap`: drawing pages past AIQ_MAX_RENDERED_PAGES; "
            "`pages_read_without_layout`: PDF pages over AIQ_PDF_PAGE_MAX_OBJECTS, whose text was "
            "read without tables or line styles."
        ),
    )
    screening: Literal["clean", "partial", "unchecked", "quarantined"] | None = Field(
        default=None,
        description=(
            "What the upload screen made of this file, when the job carried screening rules "
            "(null otherwise): `clean` (all its content was screened, nothing matched), "
            "`partial` (its text layer was clean, but some pages go to OCR or drawing analysis "
            "unscreened), `unchecked` (an image, or no local text at all), `quarantined` "
            "(a match; the file FAILED and `quarantine` says why)."
        ),
    )
    quarantine: QuarantineVerdict | None = Field(
        default=None,
        description=(
            "Why the upload screen held the file back, set with `screening == 'quarantined'` and null otherwise "
            "(ADR-0113). The typed verdict: reasons (kind, term, count, pages, pages_truncated, masked sample), "
            "`checked`, and `omitted`. `error_message` still carries the same verdict as `quarantined:{json}` "
            "for one release, for a BFF that predates this field; nothing new reads that string."
        ),
    )
    failure_category: str | None = Field(
        default=None,
        description=(
            "Why a FAILED file failed, as a machine category (`aiq_agent.knowledge.ingest_failures`): "
            "`transient` (interrupted, timed out, a download or upstream call failed: reading it again "
            "may work), `configuration` (the deployment lacks something, e.g. a vision model: reading it "
            "again works once that is configured), `deterministic` (the bytes themselves: empty, "
            "encrypted, unparseable, unreadable pages; the same reader fails the same way), "
            "`quarantined` (not a failure: the content check held the file), or `unknown`. "
            "Null while the file has not failed."
        ),
    )
    retryable: bool | None = Field(
        default=None,
        description=(
            "Whether reading the same bytes again with the same reader can succeed; follows "
            "`failure_category` (false for `deterministic` and `quarantined`). Null while the file "
            "has not failed."
        ),
    )


class IngestionJobStatus(BaseModel):
    """
    Status model for async ingestion jobs.

    This follows a polling pattern where the frontend submits a job and then
    polls this status endpoint every 2 seconds until completion.
    """

    job_id: str = Field(..., description="Unique identifier for this ingestion job.")
    status: JobState = Field(default=JobState.PENDING, description="Overall job status.")
    submitted_at: datetime = Field(..., description="When the job was submitted.")
    started_at: datetime | None = Field(None, description="When processing started.")
    completed_at: datetime | None = Field(None, description="When processing completed.")
    total_files: int = Field(0, ge=0, description="Total number of files to process.")
    processed_files: int = Field(0, ge=0, description="Number of files processed so far.")
    file_details: list[FileProgress] = Field(
        default_factory=list,
        description="Detailed progress for each file.",
    )
    collection_name: str = Field(..., description="Target collection/index name.")
    backend: str = Field(..., description="Ingestion backend used.")
    error_message: str | None = Field(None, description="Error message if job failed.")
    reader_version: str | None = Field(
        None,
        description=(
            "The extraction logic that read the files (`knowledge_layer.reader_version."
            "INGEST_READER_VERSION`), stamped when a worker starts the job. A file that failed "
            "`deterministic` under one reader may read under a newer one. Null until the job runs."
        ),
    )

    # Extra metadata for backend-specific info (e.g., milvus_uri, results_count)
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Backend-specific metadata. Contains db info for retrieval.",
    )

    @property
    def progress_percent(self) -> float:
        """Calculate progress percentage."""
        if self.total_files == 0:
            return 0.0
        return (self.processed_files / self.total_files) * 100.0

    @property
    def is_terminal(self) -> bool:
        """Check if job is in a terminal state (completed, failed or cancelled)."""
        return self.status in (JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED)

    @property
    def is_success(self) -> bool:
        """Check if job completed successfully (at least some files processed)."""
        return self.status == JobState.COMPLETED and self.processed_files > 0


class AvailableDocument(BaseModel):
    """One searchable document the agent may list in this turn.

    Identity is ``(collection, file_name)`` (ADR-0047): the same filename can
    sit on the Büroablage and in a project as two different documents. ``shelf``
    is where it sits (``office_shelf`` / ``project`` / ``session`` / ``base``) and is
    stamped at aggregation from the signed scope — never guessed back from the
    filename. Missing shelf is unknown, not ``base``.

    Attributes:
        file_name: The name of the uploaded file.
        summary: Optional one-sentence summary of the document content.
        tags: Optional controlled ingestion-generated tags (document type + OIB
            discipline).
        doc_class: Optional explicit per-document classification ("Dokumentart"),
            preferred over the filename guess for lane/kind placement.
        display_title: Optional user-facing document name shown on citation chips
            and in the base-corpus admin UI. When unset, callers fall back to the
            derived default (``guess_display_title``); the filename is never shown.
        folder_path: Optional materialised folder path the document is filed
            under, denormalised from the BFF's ``project_folders.path``
            (ADR-0049) — e.g. ``Brandschutz/Fluchtwege``. ``None`` means the
            project root (or a shelf that has no folders at all). It is a PATH,
            not an id: it reads as itself, and a prefix match gives the folder's
            whole subtree.
        topics: Optional open topics (Themen): the model's own confident terms,
            or a person's correction. Free text beside the controlled tags.
        capture: Optional facts a camera wrote into a photo: ``captured_at``
            (ISO 8601), ``latitude``, ``longitude``, ``camera``, present keys
            only. Coordinates ride along for the BFF, which shows them to the
            people who may open the file; they are never rendered to a model.
            Only ``captured_at`` (as a date) and ``camera`` may reach a prompt.
        superseded_by: Optional file name of the newer document in the SAME
            collection that a person confirmed replaces this one (a Fassung
            across different names; ADR-0054 covers the same name). Never set by
            a model.
        supersedes: Derived, never stored: the file names whose ``superseded_by``
            is this document.
        revision_suggestion: Optional open suggestion, as a dict: ``of`` (the
            older file name), ``confidence``, ``reason`` (German), ``basis``
            (``title_block`` | ``name`` | ``content``), ``dismissed``, and
            ``dismissed_of`` (every file a person refused as the older Fassung;
            ``dismissed`` says whether ``of`` is one). A suggestion is not a link.
        revision_facts: Optional title-block facts read from the first drawing
            page that has a title block: ``document_number``, ``revision`` (the
            Index as printed), ``revision_date`` (ISO), ``scale``, ``title``,
            ``page``; present keys only. Two documents with the same
            ``document_number`` are Fassungen of one another.
        change_summary: Optional German bullet lines: what changed against the
            Fassung named by ``change_basis``.
        change_basis: Optional file name ``change_summary`` compared against.
        page_count: Optional number of pages the file has, counted when it was ingested (a backfill
            fills the older rows). ``None`` for a file without pages, such as a text file, and for a row
            ingested before the count was kept: the listing says nothing rather than guess.
        mail_thread: Optional, on a filed E-Mail-Verlauf: ``latest_sent_at`` (the newest message's
            send time, RFC 3339 UTC), ``message_count`` and ``locale``
            (:mod:`~aiq_agent.knowledge.mail_facts`). Its date is the document's own date.
        mail_origin: Optional, on a file filed from a mail: the message it came with, ``sent_at``,
            ``received_at``, ``from_name``, ``from_domain``, ``signer_domain``, ``sender_trust``,
            ``thread_document_id`` and ``locale``. A display name and domains only, never an
            address. A reader names the sender's domain only as :func:`~aiq_agent.knowledge.
            mail_facts.mail_origin_label` does: the signing domain when it was verified, else
            „Domain nicht bestätigt“.
        added_at: Optional ``YYYY-MM-DD`` the document was first indexed under
            this name (the row's ``created_at``; a re-ingest keeps it). A
            string, not a datetime, because the row rides the checkpointed turn
            state and the prompt cache key.
        collection: The RAG collection this row was loaded from.
        shelf: Wire shelf (ADR-0047). Rendering-only labels live on
            ``SHELF_QUALIFIERS``; do not infer this from ``collection``.
    """

    file_name: str
    summary: str | None = None
    tags: list[str] | None = None
    doc_class: str | None = None
    display_title: str | None = None
    folder_path: str | None = None
    topics: list[str] | None = None
    capture: dict[str, Any] | None = None
    superseded_by: str | None = None
    supersedes: list[str] | None = None
    revision_suggestion: dict[str, Any] | None = None
    revision_facts: dict[str, Any] | None = None
    change_summary: str | None = None
    change_basis: str | None = None
    page_count: int | None = None
    mail_thread: dict[str, Any] | None = None
    mail_origin: dict[str, Any] | None = None
    added_at: str | None = None
    collection: str | None = None
    shelf: str | None = None
