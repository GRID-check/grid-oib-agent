"""Incremental ingestion of OIB Richtlinien PDFs into the oib_knowledge collection.

Uses the canonical, blocking knowledge-layer ingestion path: each new or changed
PDF is uploaded via the ingestor and its file status is polled until it reaches a
terminal state. Only files that ingest successfully have their SHA-256 hash recorded
in the registry, so failures (or timeouts) are automatically retried on the next run.
"""

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

from aiq_agent.knowledge.factory import get_ingestor
from aiq_agent.knowledge.schema import FileStatus

logger = logging.getLogger(__name__)

OIB_DIR = Path(os.environ.get("OIB_DOCUMENTS_DIR", "data/oib"))
# Writable home for PDFs uploaded through the platform-admin UI. Kept separate
# from OIB_DIR because deployments bind-mount the repo corpus read-only; this
# directory lives on the persistent data volume instead.
OIB_UPLOADS_DIR = Path(os.environ.get("OIB_UPLOADS_DIR", "data/oib_uploads"))
REGISTRY_PATH = Path(os.environ.get("OIB_REGISTRY_PATH", "data/oib_registry.json"))
COLLECTION_NAME = os.environ.get("OIB_COLLECTION_NAME") or os.environ.get("COLLECTION_NAME") or "oib_knowledge"
CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")

# Polling configuration for blocking file-status checks.
_POLL_INTERVAL_SECONDS = 2.0
_POLL_TIMEOUT_SECONDS = 600.0
_PROGRESS_LOG_INTERVAL_SECONDS = 30.0


@dataclass
class _ActiveIngestion:
    pdf: Path
    current_hash: str
    file_id: str
    queue_position: int
    submitted_at: float
    last_status: FileStatus | None = None
    last_progress_logged_at: float = 0.0


def _file_hash(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


# Chunk-format version of the ingestion pipeline. Bump whenever chunking,
# embedding-relevant preprocessing, or chunk metadata changes shape: the next
# sync() then discards all stored hashes ONCE and re-ingests the full corpus,
# so stale-format chunks self-heal automatically instead of persisting until
# a PDF happens to change. Stored under a reserved key in the sync registry.
CHUNK_FORMAT_VERSION = 1
_FORMAT_KEY = "__chunk_format_version__"


def _load_registry() -> dict[str, str]:
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {}


def _save_registry(registry: dict[str, str]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")


def _ensure_collection(ingestor) -> None:
    """Create the OIB collection if it does not already exist (idempotent)."""
    if ingestor.get_collection(COLLECTION_NAME) is not None:
        logger.info("Collection %s already exists", COLLECTION_NAME)
        return

    try:
        ingestor.create_collection(
            COLLECTION_NAME,
            description="Persistent OIB Richtlinien knowledge base.",
        )
        logger.info("Created collection %s", COLLECTION_NAME)
    except Exception as e:
        # The LlamaIndex adapter uses get_or_create_collection and will not raise on
        # an existing collection, but guard against backends that do. Only swallow the
        # error if the collection actually exists now.
        if ingestor.get_collection(COLLECTION_NAME) is None:
            raise
        logger.info("Collection %s already exists (create raised: %s)", COLLECTION_NAME, e)


def _get_max_workers() -> int:
    raw_value = os.environ.get("OIB_SYNC_MAX_WORKERS", "4")
    try:
        max_workers = int(raw_value)
    except ValueError:
        logger.warning("Invalid OIB_SYNC_MAX_WORKERS=%r; using default 4", raw_value)
        return 4

    if max_workers < 1:
        logger.warning("OIB_SYNC_MAX_WORKERS must be at least 1; using 1 instead of %d", max_workers)
        return 1
    return max_workers


def _status_label(status: FileStatus | None) -> str:
    return status.value if status is not None else "unknown"


def _get_oib_ingestor():
    # Register the LlamaIndex backend lazily so tests can import this module
    # without importing the full NAT/LlamaIndex stack.
    import knowledge_layer.llamaindex.adapter  # noqa: F401

    return get_ingestor(
        "llamaindex",
        {
            "persist_dir": CHROMA_DIR,
            "extract_tables": os.environ.get("AIQ_EXTRACT_TABLES", "false").lower() == "true",
            "extract_images": os.environ.get("AIQ_EXTRACT_IMAGES", "false").lower() == "true",
            "extract_charts": os.environ.get("AIQ_EXTRACT_CHARTS", "false").lower() == "true",
        },
    )


def discover_pdfs() -> list[Path]:
    """All corpus PDFs: the repo corpus plus platform-admin uploads.

    Deduplicated by basename — the collection keys chunks on the filename, so
    two same-named sources would double-index. Uploads win: uploading a file
    with an existing corpus name is how an admin replaces that document.
    """
    by_name: dict[str, Path] = {}
    for base in (OIB_DIR, OIB_UPLOADS_DIR):
        if not base.exists():
            continue
        for pdf in sorted(p for p in base.rglob("*.pdf") if p.is_file()):
            by_name[pdf.name] = pdf
    return sorted(by_name.values(), key=lambda p: p.name)


def ingest_single(pdf: Path) -> "FileStatus | None":
    """Blocking ingest of one PDF into the OIB collection.

    Same contract as sync(): existing chunks for the filename are replaced and
    the registry hash is recorded only on success. Returns the terminal
    FileStatus, or None on timeout.
    """
    current_hash = _file_hash(pdf)
    ingestor = _get_oib_ingestor()
    _ensure_collection(ingestor)

    try:
        ingestor.delete_file(pdf.name, COLLECTION_NAME)
    except Exception as exc:
        logger.warning("Could not delete existing chunks for %s before ingest: %s", pdf.name, exc)

    file_info = ingestor.upload_file(str(pdf), COLLECTION_NAME)
    logger.info("Submitted OIB upload %s size=%d file_id=%s", pdf.name, pdf.stat().st_size, file_info.file_id)

    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        info = ingestor.get_file_status(file_info.file_id, COLLECTION_NAME)
        status = info.status if info else None
        if status == FileStatus.SUCCESS:
            registry = _load_registry()
            registry[str(pdf)] = current_hash
            _save_registry(registry)
            logger.info("OIB upload ingested: %s chunks=%s", pdf.name, info.chunk_count if info else "unknown")
            return status
        if status == FileStatus.FAILED:
            logger.error(
                "OIB upload failed: %s error=%s", pdf.name, info.error_message if info else "missing file status"
            )
            return status
        time.sleep(_POLL_INTERVAL_SECONDS)

    logger.error("OIB upload timed out: %s", pdf.name)
    return None


def remove_uploaded_document(file_name: str) -> bool:
    """Remove a platform-admin-uploaded PDF from disk, registry, and index.

    Only files under OIB_UPLOADS_DIR are removable — the repo corpus is the
    deployment's read-only ground truth (and would be re-ingested by the next
    sync anyway). Returns False when no such uploaded file exists.
    """
    name = Path(file_name).name  # forbid path traversal
    path = OIB_UPLOADS_DIR / name
    if not path.is_file():
        return False

    ingestor = _get_oib_ingestor()
    try:
        ingestor.delete_file(name, COLLECTION_NAME)
    except Exception as exc:
        logger.warning("Could not delete chunks for %s: %s", name, exc)

    registry = _load_registry()
    if registry.pop(str(path), None) is not None:
        _save_registry(registry)

    try:
        from aiq_agent.knowledge.factory import unregister_summary

        unregister_summary(COLLECTION_NAME, name)
    except Exception as exc:
        logger.debug("Could not unregister summary for %s: %s", name, exc)

    path.unlink(missing_ok=True)
    logger.info("Removed uploaded OIB document %s", name)
    return True


def sync() -> tuple[int, int]:
    """Incrementally ingest new/changed OIB PDFs into the persistent collection.

    Returns:
        Tuple of (num_succeeded, num_total_tracked) where num_succeeded is the
        number of files that ingested successfully this run and num_total_tracked
        is the total number of OIB PDFs discovered on disk.
    """
    if not OIB_DIR.exists() and not OIB_UPLOADS_DIR.exists():
        raise FileNotFoundError(f"OIB directory not found: {OIB_DIR}")

    pdf_paths = discover_pdfs()
    if not pdf_paths:
        logger.warning("No PDF files found in %s", OIB_DIR)
        return 0, 0

    registry = _load_registry()
    if registry and registry.get(_FORMAT_KEY) != CHUNK_FORMAT_VERSION:
        logger.warning(
            "OIB sync: chunk format version changed (stored=%s, current=%s) — forcing one full re-ingest of the corpus",
            registry.get(_FORMAT_KEY),
            CHUNK_FORMAT_VERSION,
        )
        registry = {}
    registry.setdefault(_FORMAT_KEY, CHUNK_FORMAT_VERSION)
    _save_registry(registry)
    new_or_changed: list[tuple[Path, str]] = []
    max_workers = _get_max_workers()

    for pdf in pdf_paths:
        current_hash = _file_hash(pdf)
        if registry.get(str(pdf)) != current_hash:
            new_or_changed.append((pdf, current_hash))

    logger.info(
        "OIB sync discovery: total_pdfs=%d registry_entries=%d new_or_changed=%d skipped=%d "
        "max_workers=%d collection=%s chroma_dir=%s",
        len(pdf_paths),
        len(registry),
        len(new_or_changed),
        len(pdf_paths) - len(new_or_changed),
        max_workers,
        COLLECTION_NAME,
        CHROMA_DIR,
    )

    if not new_or_changed:
        logger.info("No new or changed OIB PDFs. Skipping ingestion.")
        return 0, len(pdf_paths)

    ingestor = _get_oib_ingestor()
    _ensure_collection(ingestor)

    succeeded = 0
    failed = 0
    timed_out = 0
    next_index = 0
    active: dict[str, _ActiveIngestion] = {}
    total_pending = len(new_or_changed)
    last_summary_logged_at = 0.0

    def submit_until_capacity() -> None:
        nonlocal next_index

        while next_index < total_pending and len(active) < max_workers:
            pdf, current_hash = new_or_changed[next_index]
            queue_position = next_index + 1

            if str(pdf) in registry:
                try:
                    ingestor.delete_file(pdf.name, COLLECTION_NAME)
                except Exception as exc:
                    logger.warning("Could not delete existing chunks for %s before reingest: %s", pdf.name, exc)

            file_info = ingestor.upload_file(str(pdf), COLLECTION_NAME)
            active[file_info.file_id] = _ActiveIngestion(
                pdf=pdf,
                current_hash=current_hash,
                file_id=file_info.file_id,
                queue_position=queue_position,
                submitted_at=time.monotonic(),
                last_status=file_info.status,
            )
            next_index += 1
            logger.info(
                "Submitted OIB PDF %d/%d: %s size=%d file_id=%s active=%d queued=%d",
                queue_position,
                total_pending,
                pdf.name,
                pdf.stat().st_size,
                file_info.file_id,
                len(active),
                total_pending - next_index,
            )

    def log_progress(now: float, *, force: bool = False) -> None:
        nonlocal last_summary_logged_at

        if not force and now - last_summary_logged_at < _PROGRESS_LOG_INTERVAL_SECONDS:
            return

        states = ", ".join(
            f"{item.pdf.name}={_status_label(item.last_status)}:{now - item.submitted_at:.0f}s"
            for item in active.values()
        )
        logger.info(
            "OIB sync progress: active=%d succeeded=%d failed=%d timed_out=%d queued=%d completed=%d/%d states=[%s]",
            len(active),
            succeeded,
            failed,
            timed_out,
            total_pending - next_index,
            succeeded + failed + timed_out,
            total_pending,
            states,
        )
        last_summary_logged_at = now

    submit_until_capacity()
    if active:
        log_progress(time.monotonic(), force=True)

    while active:
        now = time.monotonic()
        made_progress = False

        for file_id, item in list(active.items()):
            file_info = ingestor.get_file_status(file_id, COLLECTION_NAME)
            status = file_info.status if file_info else None

            if status != item.last_status:
                item.last_status = status
                made_progress = True

            elapsed = now - item.submitted_at
            if status == FileStatus.SUCCESS:
                registry[str(item.pdf)] = item.current_hash
                _save_registry(registry)
                succeeded += 1
                active.pop(file_id, None)
                made_progress = True
                logger.info(
                    "OIB ingestion succeeded: %s file_id=%s chunks=%s elapsed=%.1fs",
                    item.pdf.name,
                    file_id,
                    file_info.chunk_count if file_info else "unknown",
                    elapsed,
                )
            elif status == FileStatus.FAILED:
                failed += 1
                active.pop(file_id, None)
                made_progress = True
                logger.error(
                    "OIB ingestion failed: %s file_id=%s status=%s error=%s elapsed=%.1fs; "
                    "registry not updated, will retry next run",
                    item.pdf.name,
                    file_id,
                    _status_label(status),
                    file_info.error_message if file_info else "missing file status",
                    elapsed,
                )
            elif elapsed >= _POLL_TIMEOUT_SECONDS:
                timed_out += 1
                active.pop(file_id, None)
                made_progress = True
                logger.error(
                    "OIB ingestion timed out: %s file_id=%s elapsed=%.1fs last_status=%s; "
                    "registry not updated, will retry next run",
                    item.pdf.name,
                    file_id,
                    elapsed,
                    _status_label(status),
                )

        if made_progress:
            submit_until_capacity()
            if active:
                log_progress(time.monotonic(), force=True)
        elif active:
            log_progress(now)
            time.sleep(_POLL_INTERVAL_SECONDS)

    skipped = len(pdf_paths) - total_pending
    logger.info(
        "OIB sync complete: succeeded=%d failed=%d timed_out=%d skipped=%d new_or_changed=%d total_pdfs=%d",
        succeeded,
        failed,
        timed_out,
        skipped,
        total_pending,
        len(pdf_paths),
    )
    return succeeded, len(pdf_paths)
