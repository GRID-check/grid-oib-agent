# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Read-only status view of the OIB knowledge corpus.

Answers "what does the RAG know right now?" by merging the three sources of
truth that the ingestion pipeline maintains:

1. PDFs on disk under ``OIB_DIR`` (the desired corpus),
2. the ingest registry ``REGISTRY_PATH`` (SHA-256 of each successfully
   ingested file, written only on ``FileStatus.SUCCESS`` by ``oib_sync``),
3. the vector-store collection itself (chunk counts per file).

The merge yields one entry per known file with an explicit lifecycle status,
so the UI can show users exactly which documents ground the agent's answers
and which are still pending, changed on disk, or orphaned.
"""

import logging
import threading
from datetime import datetime
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel
from pydantic import Field

from aiq_agent import oib_sync
from aiq_agent.knowledge.schema import FileInfo

logger = logging.getLogger(__name__)


class OibFileState(StrEnum):
    """Lifecycle of a corpus file relative to what the RAG has indexed."""

    INGESTED = "ingested"
    """On disk, hash matches the registry, chunks present in the collection."""

    STALE = "stale"
    """On disk but changed since its last successful ingestion; the indexed
    content reflects the old version until the next sync run."""

    PENDING = "pending"
    """On disk but never successfully ingested; the RAG does not know it yet."""

    REMOVED = "removed"
    """Known to the collection (or registry) but the source file is gone from
    disk; indexed content may linger until the next cleanup."""

    INCONSISTENT = "inconsistent"
    """Registry records a successful ingest but the collection holds no chunks
    for the file (e.g. the vector store was wiped without the registry)."""


class OibFileEntry(BaseModel):
    """One corpus file as the RAG sees it."""

    file_name: str = Field(..., description="PDF filename (unique within the corpus).")
    state: OibFileState = Field(..., description="Lifecycle status relative to the index.")
    size_bytes: int | None = Field(None, description="Current size on disk; None when the file was removed.")
    chunk_count: int = Field(0, ge=0, description="Number of indexed chunks the RAG can retrieve.")
    ingested_sha256: str | None = Field(None, description="Hash recorded at the last successful ingestion.")
    current_sha256: str | None = Field(None, description="Hash of the file currently on disk.")
    ingested_at: datetime | None = Field(None, description="Completion time of the last ingestion, if tracked.")
    summary: str | None = Field(None, description="One-sentence document summary, if one was generated.")


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
    documents_dir: str
    collection_updated_at: datetime | None = None
    summary: OibStatusSummary
    files: list[OibFileEntry]


# Cache of content hashes keyed by path; invalidated by (size, mtime_ns) so a
# status request does not re-hash the whole corpus (~70 MB) every time.
_HASH_CACHE: dict[str, tuple[int, int, str]] = {}
_HASH_CACHE_LOCK = threading.Lock()


def _cached_file_hash(path: Path) -> str:
    stat = path.stat()
    key = str(path)
    with _HASH_CACHE_LOCK:
        cached = _HASH_CACHE.get(key)
        if cached is not None and cached[0] == stat.st_size and cached[1] == stat.st_mtime_ns:
            return cached[2]

    digest = oib_sync._file_hash(path)
    with _HASH_CACHE_LOCK:
        _HASH_CACHE[key] = (stat.st_size, stat.st_mtime_ns, digest)
    return digest


def _load_summaries(collection_name: str) -> dict[str, str]:
    """Best-effort lookup of generated one-sentence document summaries."""
    try:
        from aiq_agent.knowledge.factory import get_available_documents

        return {doc.file_name: doc.summary for doc in get_available_documents(collection_name) if doc.summary}
    except Exception as e:
        logger.debug("Document summaries unavailable for %s: %s", collection_name, e)
        return {}


def _list_collection_files(ingestor, collection_name: str) -> dict[str, FileInfo]:
    try:
        return {info.file_name: info for info in ingestor.list_files(collection_name)}
    except Exception as e:
        logger.warning("Could not list files in collection %s: %s", collection_name, e)
        return {}


def _classify_disk_file(
    pdf: Path,
    registry: dict[str, str],
    collection_files: dict[str, FileInfo],
) -> OibFileEntry:
    current_hash = _cached_file_hash(pdf)
    recorded_hash = registry.get(str(pdf))
    info = collection_files.get(pdf.name)
    chunk_count = info.chunk_count if info else 0

    if recorded_hash is None:
        state = OibFileState.PENDING
    elif recorded_hash != current_hash:
        state = OibFileState.STALE
    elif chunk_count == 0:
        state = OibFileState.INCONSISTENT
    else:
        state = OibFileState.INGESTED

    return OibFileEntry(
        file_name=pdf.name,
        state=state,
        size_bytes=pdf.stat().st_size,
        chunk_count=chunk_count,
        ingested_sha256=recorded_hash,
        current_sha256=current_hash,
        ingested_at=info.ingested_at if info else None,
    )


def get_status(ingestor=None) -> OibKnowledgeStatus:
    """Compute the merged corpus status. Blocking; call off the event loop.

    Args:
        ingestor: Optional ingestor override (used by tests). Defaults to the
            same LlamaIndex singleton that ``oib_sync`` ingests through, so the
            report reflects exactly the collection the agent retrieves from.
    """
    collection_name = oib_sync.COLLECTION_NAME
    oib_dir = oib_sync.OIB_DIR

    if ingestor is None:
        ingestor = oib_sync._get_oib_ingestor()

    registry = oib_sync._load_registry()
    disk_pdfs = sorted(p for p in oib_dir.rglob("*.pdf") if p.is_file()) if oib_dir.exists() else []

    collection_info = ingestor.get_collection(collection_name)
    collection_files = _list_collection_files(ingestor, collection_name) if collection_info else {}

    entries = [_classify_disk_file(pdf, registry, collection_files) for pdf in disk_pdfs]

    # Files the RAG (or registry) still knows about whose source is gone.
    disk_names = {pdf.name for pdf in disk_pdfs}
    disk_paths = {str(pdf) for pdf in disk_pdfs}
    removed_names = {name for name in collection_files if name not in disk_names}
    removed_names.update(
        Path(path).name for path in registry if path not in disk_paths and Path(path).name not in disk_names
    )
    for name in sorted(removed_names):
        info = collection_files.get(name)
        registry_hash = next((h for p, h in registry.items() if Path(p).name == name), None)
        entries.append(
            OibFileEntry(
                file_name=name,
                state=OibFileState.REMOVED,
                size_bytes=None,
                chunk_count=info.chunk_count if info else 0,
                ingested_sha256=registry_hash,
                current_sha256=None,
                ingested_at=info.ingested_at if info else None,
            )
        )

    summaries = _load_summaries(collection_name)
    for entry in entries:
        entry.summary = summaries.get(entry.file_name)

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
        documents_dir=str(oib_dir),
        collection_updated_at=collection_info.updated_at if collection_info else None,
        summary=counts,
        files=sorted(entries, key=lambda e: e.file_name),
    )
