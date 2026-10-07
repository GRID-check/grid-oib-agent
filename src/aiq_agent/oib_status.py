"""Read-only status view of the OIB knowledge corpus.

Answers "what does the RAG know right now?" by merging the two sources of truth
that the ingestion pipeline maintains:

1. the ``oib_corpus_files`` table (the corpus: every file with the hash of its
   current bytes, the hash and chunk-format version the index was last built
   from, written by ``oib_sync`` only on ``FileStatus.SUCCESS``),
2. the vector-store collection itself (chunk counts per file).

The merge yields one entry per known file with an explicit lifecycle status,
so the UI can show users exactly which documents ground the agent's answers
and which are still pending, changed since they were indexed, or orphaned.
"""

import logging
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel
from pydantic import Field

from aiq_agent import corpus_store
from aiq_agent import oib_sync
from aiq_agent.knowledge.schema import FileInfo

logger = logging.getLogger(__name__)


class OibFileState(StrEnum):
    """Lifecycle of a corpus file relative to what the RAG has indexed."""

    INGESTED = "ingested"
    """In the corpus, the index was built from its current bytes, chunks present."""

    STALE = "stale"
    """In the corpus but changed (or the chunking pipeline changed) since its last
    successful ingestion; the indexed content reflects the old version until the
    next sync cycle."""

    PENDING = "pending"
    """In the corpus but never successfully ingested; the RAG does not know it yet."""

    REMOVED = "removed"
    """Indexed, but the corpus does not list it (chunks left by a half-finished
    delete or a restored vector store). Deleting the document clears them."""

    INCONSISTENT = "inconsistent"
    """The table records a successful ingest but the collection holds no chunks
    for the file (e.g. the vector store was wiped)."""


class OibFileEntry(BaseModel):
    """One corpus file as the RAG sees it."""

    file_name: str = Field(..., description="PDF filename (unique within the corpus).")
    state: OibFileState = Field(..., description="Lifecycle status relative to the index.")
    size_bytes: int | None = Field(
        None, description="Size of the stored file; None for an indexed file not in the corpus."
    )
    chunk_count: int = Field(0, ge=0, description="Number of indexed chunks the RAG can retrieve.")
    ingested_sha256: str | None = Field(None, description="Hash recorded at the last successful ingestion.")
    current_sha256: str | None = Field(None, description="Hash of the stored file.")
    ingested_at: datetime | None = Field(None, description="Completion time of the last ingestion, if tracked.")
    summary: str | None = Field(None, description="One-sentence document summary, if one was generated.")
    doc_class: str | None = Field(
        None, description="Explicit per-document classification ('Dokumentart'), if one was set/guessed."
    )
    doc_class_suggestion: str | None = Field(
        None,
        description=(
            "A Dokumentart the decision model read from the text when the file name gave no hint "
            "(ADR-0064, use 8). Offered to the platform owner; never applied on its own."
        ),
    )
    display_title: str | None = Field(
        None,
        description=(
            "Effective user-facing document name: the stored admin override, else the default derived "
            "from the OIB filename convention. None only for a document with neither (a non-OIB upload)."
        ),
    )


class OibStatusSummary(BaseModel):
    """Aggregate counts over all corpus files."""

    total_files: int = 0
    ingested: int = 0
    stale: int = 0
    pending: int = 0
    removed: int = 0
    inconsistent: int = 0
    total_chunks: int = Field(0, description="Total chunks in the collection (all files).")


class OibKnowledgeStatus(BaseModel):
    """Full transparency report for the OIB knowledge corpus."""

    collection_name: str
    collection_exists: bool
    collection_updated_at: datetime | None = None
    summary: OibStatusSummary
    files: list[OibFileEntry]


def _load_suggestions(collection_name: str, file_names: list[str]) -> dict[str, str]:
    """Best-effort batch read of the Dokumentart suggestions; empty on any store hiccup."""
    try:
        from aiq_agent.knowledge.factory import get_document_doc_class_suggestions

        return get_document_doc_class_suggestions(collection_name, file_names)
    except Exception as e:
        logger.debug("Dokumentart suggestions unavailable for %s: %s", collection_name, e)
        return {}


def _load_summaries(collection_name: str) -> dict[str, tuple[str | None, str | None, str | None]]:
    """Best-effort lookup of per-document (summary, doc_class, display_title).

    The document_metadata store is authoritative for all three fields; a store
    hiccup resolves to an empty map so status never fails on it. Keyed by
    filename. ``display_title`` is the stored override only — the caller layers
    the derived default on top so a document that was never explicitly seeded
    still shows an effective name.
    """
    try:
        from aiq_agent.knowledge.factory import get_available_documents

        return {
            doc.file_name: (doc.summary, doc.doc_class, doc.display_title)
            for doc in get_available_documents(collection_name)
        }
    except Exception as e:
        logger.debug("Document metadata unavailable for %s: %s", collection_name, e)
        return {}


def _list_collection_files(ingestor, collection_name: str) -> dict[str, FileInfo]:
    try:
        return {info.file_name: info for info in ingestor.list_files(collection_name)}
    except Exception as e:
        logger.warning("Could not list files in collection %s: %s", collection_name, e)
        return {}


def _state_of(row: corpus_store.FileRow, chunk_count: int) -> OibFileState:
    if row.ingested_sha256 is None:
        return OibFileState.PENDING
    if row.needs_ingestion(oib_sync.CHUNK_FORMAT_VERSION):
        return OibFileState.STALE
    return OibFileState.INGESTED if chunk_count > 0 else OibFileState.INCONSISTENT


def _entry_for_row(row: corpus_store.FileRow, info: FileInfo | None) -> OibFileEntry:
    chunk_count = info.chunk_count if info else 0
    return OibFileEntry(
        file_name=row.file_name,
        state=_state_of(row, chunk_count),
        size_bytes=row.size_bytes,
        chunk_count=chunk_count,
        ingested_sha256=row.ingested_sha256,
        current_sha256=row.sha256,
        ingested_at=info.ingested_at if info else None,
    )


def _entry_for_orphan(name: str, info: FileInfo) -> OibFileEntry:
    return OibFileEntry(
        file_name=name,
        state=OibFileState.REMOVED,
        chunk_count=info.chunk_count,
        ingested_at=info.ingested_at,
    )


def _with_metadata(entries: list[OibFileEntry], collection_name: str) -> None:
    from aiq_agent.common.norm_registry import guess_display_title

    summaries = _load_summaries(collection_name)
    suggestions = _load_suggestions(collection_name, [entry.file_name for entry in entries])
    for entry in entries:
        summary, doc_class, stored_title = summaries.get(entry.file_name, (None, None, None))
        entry.summary = summary
        entry.doc_class = doc_class
        entry.doc_class_suggestion = suggestions.get(entry.file_name)
        # Effective name: the admin override wins, else the derived default so the
        # admin UI always shows a real name (never a raw filename) to rename from.
        entry.display_title = stored_title or guess_display_title(entry.file_name)


def get_status(ingestor=None) -> OibKnowledgeStatus:
    """Compute the merged corpus status. Blocking; call off the event loop.

    Args:
        ingestor: Optional ingestor override (used by tests). Defaults to the
            same LlamaIndex singleton that ``oib_sync`` ingests through, so the
            report reflects exactly the collection the agent retrieves from.
    """
    collection_name = oib_sync.COLLECTION_NAME
    if ingestor is None:
        ingestor = oib_sync._get_oib_ingestor()

    rows = corpus_store.list_files()
    collection_info = ingestor.get_collection(collection_name)
    collection_files = _list_collection_files(ingestor, collection_name) if collection_info else {}

    entries = [_entry_for_row(row, collection_files.get(name)) for name, row in rows.items()]
    entries.extend(_entry_for_orphan(name, info) for name, info in collection_files.items() if name not in rows)
    _with_metadata(entries, collection_name)

    counts = OibStatusSummary(
        total_files=len(entries),
        ingested=sum(1 for e in entries if e.state == OibFileState.INGESTED),
        stale=sum(1 for e in entries if e.state == OibFileState.STALE),
        pending=sum(1 for e in entries if e.state == OibFileState.PENDING),
        removed=sum(1 for e in entries if e.state == OibFileState.REMOVED),
        inconsistent=sum(1 for e in entries if e.state == OibFileState.INCONSISTENT),
        total_chunks=collection_info.chunk_count if collection_info else 0,
    )

    return OibKnowledgeStatus(
        collection_name=collection_name,
        collection_exists=collection_info is not None,
        collection_updated_at=collection_info.updated_at if collection_info else None,
        summary=counts,
        files=sorted(entries, key=lambda e: e.file_name),
    )
