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
import threading
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
# Persistent set of corpus basenames removed from the active corpus. Repo-shipped
# PDFs live in git and cannot be physically deleted, so "delete" for them means
# excluding them here: their chunks are dropped and discover_pdfs()/sync() skip
# them forever, so a sync never re-ingests a document an admin removed.
EXCLUDED_PATH = Path(os.environ.get("OIB_EXCLUDED_PATH", "data/oib_excluded.json"))
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
    # The per-basename lock held for this file's whole ingestion, released when
    # it reaches a terminal state (see ``_file_lock``).
    lock: "threading.Lock | None" = None


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
# 2: chunk metadata is no longer embedded wholesale. `file_size`, the ingest temp
#    path and render geometry are excluded from the embed rendering, so the literal
#    text sent to the embedding model changed for every chunk. Without this bump the
#    corpus would keep its diluted vectors indefinitely — sync() gates on the sha256
#    of the PDF bytes, and a preprocessing change alters no file hash — while newly
#    uploaded documents got clean ones, leaving two embedding conventions in one index.
# 3: Punkt-aware chunking. A document with a usable outline is now cut on its own
#    numbering rather than per page, so chunk boundaries, chunk count and the
#    metadata every chunk carries all change. Without this bump the corpus would
#    keep its page-cut chunks forever, for the same reason as 2.
#    Version 3 also covers the later correction to how the outline is chosen (a
#    best-chain search over all heading candidates, anchored on the document's own
#    contents page, in place of a greedy left-to-right scan). No separate version is
#    needed: 3 has not been ingested anywhere yet, and both changes land in the same
#    unreleased pass. Corpus effect, measured against the 946 Punkte the contents
#    pages of the twelve Punkt-structured Richtlinien list: 903 chunks with 44
#    missing, 1 spurious and 4 carrying another heading's title, becomes 946 with
#    none of the three.
CHUNK_FORMAT_VERSION = 3
_FORMAT_KEY = "__chunk_format_version__"


# Serialises registry read-modify-write sequences. ZIP admin uploads ingest
# members concurrently (the oib route's executor runs >1 thread) and a full
# sync() can overlap with them — without the lock, two threads can each load
# the registry, and the later save silently drops the other's new hash entry
# (lost hashes cause a wasteful re-ingest next sync, never corruption).
# Every write reloads the file INSIDE the lock and merges: the lock alone only
# serialises the saves, it does not stop a stale in-memory snapshot (sync()
# loads once, then runs for minutes) from clobbering a concurrent writer.
_REGISTRY_LOCK = threading.Lock()

# Same guarantee for the persisted exclusion set, which has its own file and is
# read-modify-written by exclude/unexclude/prune.
_EXCLUDED_LOCK = threading.Lock()

# Single-flight guard for sync(): two concurrent syncs would build their work
# lists from the same registry snapshot and ingest every changed file twice.
_SYNC_LOCK = threading.Lock()

# Per-basename locks. The collection keys chunks on the filename, so all corpus
# mutations for ONE document (delete chunks + upload, or delete + unlink) must
# not interleave: without this a delete can land between a concurrent ingest's
# delete and upload, leaving the file indexed after a "successful" removal, or
# two ingests of the same name can double-index it. Different documents stay
# fully concurrent, which is the point of the multi-worker executor.
_FILE_LOCKS: dict[str, threading.Lock] = {}
_FILE_LOCKS_GUARD = threading.Lock()


def _file_lock(name: str) -> threading.Lock:
    """The lock serialising corpus mutations for one document basename."""
    key = Path(name).name
    with _FILE_LOCKS_GUARD:
        return _FILE_LOCKS.setdefault(key, threading.Lock())


def _load_registry() -> dict[str, str]:
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {}


def _save_registry(registry: dict[str, str]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")


def _load_excluded() -> set[str]:
    """Basenames removed from the active corpus (persisted exclusion set)."""
    if EXCLUDED_PATH.exists():
        try:
            data = json.loads(EXCLUDED_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            logger.warning("Could not read exclusion file %s; treating as empty", EXCLUDED_PATH)
            return set()
        if isinstance(data, list):
            return {str(name) for name in data}
    return set()


def _save_excluded(names: set[str]) -> None:
    EXCLUDED_PATH.parent.mkdir(parents=True, exist_ok=True)
    EXCLUDED_PATH.write_text(json.dumps(sorted(names), indent=2), encoding="utf-8")


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


def _collection_is_empty(ingestor) -> bool:
    """True when the OIB collection is missing or holds no vectors.

    Detects registry/vector-store drift. The sync registry lives on the data
    volume, but the vectors live in Chroma — an embedded dir, or (shared mode) a
    SEPARATE Chroma-server volume. Those can diverge: classically, when the
    deployment is repointed at a fresh shared Chroma server (``AIQ_CHROMA_URL``)
    while the registry still lists the whole corpus as ingested. The collection
    is then empty even though the registry is full, and the incremental diff in
    ``sync()`` would skip everything and leave it empty forever.

    Returns ``False`` (the safe, non-destructive answer) if the store cannot be
    probed, so a transient Chroma hiccup never wipes a good registry.
    """
    try:
        info = ingestor.get_collection(COLLECTION_NAME)
    except Exception as exc:
        logger.debug("Could not probe collection %s: %s", COLLECTION_NAME, exc)
        return False
    if info is None:
        return True
    return getattr(info, "chunk_count", None) == 0 or getattr(info, "file_count", None) == 0


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

    Basenames in the persistent exclusion set are skipped for the repo corpus,
    so a repo-shipped file an admin removed is never re-ingested. A physically
    present admin UPLOAD, however, always wins: it is an explicit re-add, so it
    overrides a stale exclusion left over from a prior delete of the same
    basename. (This also self-heals corpora uploaded before the upload path
    learned to lift the exclusion itself — the files simply reappear.)
    """
    excluded = _load_excluded()
    by_name: dict[str, Path] = {}
    for base in (OIB_DIR, OIB_UPLOADS_DIR):
        if not base.exists():
            continue
        is_upload = base == OIB_UPLOADS_DIR
        for pdf in sorted(p for p in base.rglob("*.pdf") if p.is_file()):
            if pdf.name in excluded and not is_upload:
                continue
            by_name[pdf.name] = pdf
    return sorted(by_name.values(), key=lambda p: p.name)


def ingest_single(pdf: Path) -> "FileStatus | None":
    """Blocking ingest of one PDF into the OIB collection.

    Same contract as sync(): existing chunks for the filename are replaced and
    the registry hash is recorded only on success. Returns the terminal
    FileStatus, or None on timeout.

    Holds the document's per-basename lock for the whole delete → upload → poll
    cycle, so a concurrent removal or sync of the same filename cannot interleave
    with it (see ``_file_lock``).
    """
    current_hash = _file_hash(pdf)
    with _file_lock(pdf.name):
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
                with _REGISTRY_LOCK:
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

    # One lock for chunk delete + registry drop + unlink: a pending ingest of the
    # same basename must not finish inside those gaps and leave the document
    # indexed (or its hash recorded) after a "successful" removal.
    with _file_lock(name):
        ingestor = _get_oib_ingestor()
        try:
            ingestor.delete_file(name, COLLECTION_NAME)
        except Exception as exc:
            logger.warning("Could not delete chunks for %s: %s", name, exc)

        with _REGISTRY_LOCK:
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


def exclude_document(name: str) -> None:
    """Remove a repo-shipped corpus file from the ACTIVE corpus.

    Repo PDFs live in git and cannot be physically deleted, so removal means:
    drop the file's indexed chunks, drop its registry hash entries, drop its
    summary row, and record its basename in the persistent exclusion set so
    discover_pdfs()/sync() never re-ingest it. Idempotent.
    """
    base = Path(name).name  # forbid path traversal

    with _file_lock(base):
        ingestor = _get_oib_ingestor()
        try:
            ingestor.delete_file(base, COLLECTION_NAME)
        except Exception as exc:
            logger.warning("Could not delete chunks for excluded %s: %s", base, exc)

        with _REGISTRY_LOCK:
            registry = _load_registry()
            stale_keys = [key for key in registry if key != _FORMAT_KEY and Path(key).name == base]
            if stale_keys:
                for key in stale_keys:
                    registry.pop(key, None)
                _save_registry(registry)

        try:
            from aiq_agent.knowledge.factory import unregister_summary

            unregister_summary(COLLECTION_NAME, base)
        except Exception as exc:
            logger.debug("Could not unregister summary for %s: %s", base, exc)

        # Under the exclusion lock too: a concurrent removal of another document
        # would otherwise load the same set and drop this basename on save, and
        # the next sync would re-ingest the document an admin just removed.
        with _EXCLUDED_LOCK:
            excluded = _load_excluded()
            if base not in excluded:
                excluded.add(base)
                _save_excluded(excluded)
    logger.info("Excluded OIB corpus document %s from the active corpus", base)


def _prune_excluded_uploads() -> None:
    """Drop exclusion entries whose basename now exists as an admin upload.

    A physically present upload overrides its exclusion (see ``discover_pdfs``),
    so keeping the name in the persisted set is stale bookkeeping. Pruning it
    keeps the exclusion file honest and self-heals corpora uploaded before the
    upload path lifted exclusions itself. Idempotent; no-op when nothing changes.
    """
    if not OIB_UPLOADS_DIR.exists():
        return
    uploaded = {p.name for p in OIB_UPLOADS_DIR.rglob("*.pdf") if p.is_file()}
    with _EXCLUDED_LOCK:
        excluded = _load_excluded()
        if not excluded:
            return
        remaining = excluded - uploaded
        if remaining != excluded:
            _save_excluded(remaining)
            logger.info("Pruned %d stale exclusion(s) now present as uploads", len(excluded) - len(remaining))


def unexclude_document(name: str) -> bool:
    """Reverse an exclusion so the file is re-discovered (and re-ingested by the
    next sync). Returns False when the basename was not excluded."""
    base = Path(name).name
    with _EXCLUDED_LOCK:
        excluded = _load_excluded()
        if base not in excluded:
            return False
        excluded.discard(base)
        _save_excluded(excluded)
    logger.info("Re-included OIB corpus document %s into the active corpus", base)
    return True


def _is_corpus_document(base: str) -> bool:
    """True when ``base`` is a known corpus document (repo source on disk, a
    registry entry, or an indexed file) — i.e. something an admin can remove."""
    if OIB_DIR.exists():
        for candidate in OIB_DIR.rglob(base):
            if candidate.is_file():
                return True
    registry = _load_registry()
    if any(key != _FORMAT_KEY and Path(key).name == base for key in registry):
        return True
    try:
        ingestor = _get_oib_ingestor()
        return any(info.file_name == base for info in ingestor.list_files(COLLECTION_NAME))
    except Exception as exc:
        logger.debug("Could not list collection files while checking %s: %s", base, exc)
        return False


def remove_document(name: str) -> str | None:
    """Unified corpus removal for the admin UI.

    - An admin-uploaded PDF (under OIB_UPLOADS_DIR) is physically deleted from
      disk, registry and index → returns ``"deleted"``.
    - A repo-shipped / index-only corpus document is removed from the active
      corpus via a persistent exclusion (chunks dropped, never re-ingested) →
      returns ``"excluded"``.
    - Returns ``None`` when no such corpus document exists (route → 404).
    """
    base = Path(name).name
    if not base or base != name or not base.lower().endswith(".pdf"):
        return None

    if (OIB_UPLOADS_DIR / base).is_file():
        return "deleted" if remove_uploaded_document(base) else None

    if _is_corpus_document(base):
        exclude_document(base)
        return "excluded"

    return None


def mark_for_reingest(name: str) -> Path | None:
    """Resolve a corpus document for a forced re-ingest, and forget its indexed state.

    Returns the ``Path`` the caller should hand to :func:`ingest_single`, or ``None`` when
    no such corpus document exists (route → 404). Basename-only, ``.pdf``-only, and
    resolved through :func:`discover_pdfs`, so an excluded file cannot be revived this way
    and a path cannot traverse out of the corpus.

    Dropping the registry hash is NOT what makes the re-ingest happen -- ``ingest_single``
    deletes and re-uploads regardless of what the registry says. It is what makes the
    re-ingest *visible*: ``oib_status`` reports a file with no registry entry as PENDING,
    which is the state the admin UI already polls on. Without it a re-ingest of an
    already-ingested document would read as INGESTED for its whole duration and the
    progress panel would show a job that appeared to finish before it started.

    Every entry for the basename is dropped, not just the exact path, because the same
    document can be registered under both the repo corpus and the uploads directory and a
    single leftover hash would restore the INGESTED reading.

    If the ingestion then fails, the entry simply stays dropped: the file reads as PENDING
    and the next ``sync()`` picks it up, which is the same self-healing path a genuinely
    new file takes.
    """
    base = Path(name).name
    if not base or base != name or not base.lower().endswith(".pdf"):
        return None

    target = next((pdf for pdf in discover_pdfs() if pdf.name == base), None)
    if target is None:
        return None

    with _REGISTRY_LOCK:
        registry = _load_registry()
        stale_keys = [key for key in registry if key != _FORMAT_KEY and Path(key).name == base]
        if stale_keys:
            for key in stale_keys:
                registry.pop(key, None)
            _save_registry(registry)

    return target


def sync() -> tuple[int, int]:
    """Incrementally ingest new/changed OIB PDFs into the persistent collection.

    Single-flight: a second concurrent sync waits for the running one instead of
    ingesting the same work list twice (the admin route's executor has >1 worker,
    so a manual sync can land while one is already running).

    Returns:
        Tuple of (num_succeeded, num_total_tracked) where num_succeeded is the
        number of files that ingested successfully this run and num_total_tracked
        is the total number of OIB PDFs discovered on disk.
    """
    if not _SYNC_LOCK.acquire(blocking=False):
        logger.info("OIB sync already in progress; waiting for it to finish before syncing again")
        _SYNC_LOCK.acquire()
    try:
        return _sync_locked()
    finally:
        _SYNC_LOCK.release()


def _sync_locked() -> tuple[int, int]:
    if not OIB_DIR.exists() and not OIB_UPLOADS_DIR.exists():
        raise FileNotFoundError(f"OIB directory not found: {OIB_DIR}")

    # Self-heal any stale exclusions for files that now exist as uploads before
    # discovering, so the persisted set matches what discover_pdfs() surfaces.
    _prune_excluded_uploads()
    pdf_paths = discover_pdfs()
    if not pdf_paths:
        logger.warning("No PDF files found in %s", OIB_DIR)
        return 0, 0

    # Set when the stored chunk format is stale, and consulted at the delete-then-upload
    # step below. Emptying the registry is what triggers the re-ingest, and it is ALSO
    # what would make that re-ingest additive: the delete step is guarded by
    # `str(pdf) in registry`, which is false for every file once the registry is empty,
    # so each PDF's new chunks would be written alongside its old ones rather than
    # replacing them. The collection would end up holding both formats of all 39 PDFs,
    # both retrievable, both scored on the same scale and both rendering as a valid
    # citation, until somebody reset it by hand. This flag is the delete's other reason
    # to run. (The version gate has never fired before, so the bug has never executed.)
    format_changed = False
    with _REGISTRY_LOCK:
        registry = _load_registry()
        if registry and registry.get(_FORMAT_KEY) != CHUNK_FORMAT_VERSION:
            logger.warning(
                "OIB sync: chunk format version changed (stored=%s, current=%s) — "
                "forcing one full re-ingest of the corpus",
                registry.get(_FORMAT_KEY),
                CHUNK_FORMAT_VERSION,
            )
            registry = {}
            format_changed = True
        registry.setdefault(_FORMAT_KEY, CHUNK_FORMAT_VERSION)
        _save_registry(registry)

    # Reconcile the registry against the ACTUAL vector store. The registry (data
    # volume) and the vectors (embedded dir, or a shared Chroma-server volume)
    # live on different volumes and can drift apart — e.g. after repointing the
    # deployment at a fresh shared Chroma server while the registry still lists
    # the whole corpus as ingested. Without this, the diff below finds nothing
    # new and the collection stays empty forever ("No new or changed OIB PDFs").
    # If the registry claims ingested files but the collection is empty/missing,
    # the registry is stale: drop it (keeping the format stamp) to force a full
    # re-ingest. Guarded so a transient Chroma error never discards a good one.
    if any(key != _FORMAT_KEY for key in registry) and _collection_is_empty(_get_oib_ingestor()):
        logger.warning(
            "OIB sync: registry lists ingested files but collection %s is empty/missing "
            "(vector store reset or repointed) — forcing a full re-ingest",
            COLLECTION_NAME,
        )
        with _REGISTRY_LOCK:
            registry = {_FORMAT_KEY: CHUNK_FORMAT_VERSION}
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

            # Held until this file reaches a terminal state, so a concurrent
            # upload or removal of the same basename cannot interleave with the
            # delete → upload → poll cycle below (see _file_lock).
            lock = _file_lock(pdf.name)
            lock.acquire()
            try:
                # `format_changed` stands in for the registry entry the version reset
                # just discarded: the collection still holds this file's old-format
                # chunks even though the registry no longer says so. Deleting a file
                # that is not there is already tolerated, so the extra call on a fresh
                # collection costs one no-op per PDF, once.
                if format_changed or str(pdf) in registry:
                    try:
                        ingestor.delete_file(pdf.name, COLLECTION_NAME)
                    except Exception as exc:
                        logger.warning("Could not delete existing chunks for %s before reingest: %s", pdf.name, exc)

                file_info = ingestor.upload_file(str(pdf), COLLECTION_NAME)
            except BaseException:
                lock.release()
                raise
            active[file_info.file_id] = _ActiveIngestion(
                pdf=pdf,
                current_hash=current_hash,
                file_id=file_info.file_id,
                queue_position=queue_position,
                submitted_at=time.monotonic(),
                last_status=file_info.status,
                lock=lock,
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

    def complete(file_id: str) -> None:
        """Drop a finished item and release its per-basename lock."""
        item = active.pop(file_id, None)
        if item is not None and item.lock is not None:
            item.lock.release()

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

    try:
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
                    with _REGISTRY_LOCK:
                        # Reload: `registry` was loaded before this (minutes-long)
                        # run started, so saving it as-is would drop hashes another
                        # ingestion recorded in the meantime.
                        registry = _load_registry()
                        registry[str(item.pdf)] = item.current_hash
                        _save_registry(registry)
                    succeeded += 1
                    complete(file_id)
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
                    complete(file_id)
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
                    complete(file_id)
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

    finally:
        # A raise mid-flight (ingestor error, cancellation) must not leave a
        # basename locked for the process's lifetime.
        for item in active.values():
            if item.lock is not None:
                item.lock.release()
        active.clear()

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
