"""
Base adapter interfaces for the Knowledge Layer.

This module defines abstract base classes that all retrieval and ingestion
adapters must implement. The Adapter Pattern allows new backends to be added
without modifying core code.
"""

import logging
import threading
import time
from abc import ABC
from abc import abstractmethod
from collections.abc import Callable
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime
from datetime import timedelta
from typing import Any

from .schema import Chunk
from .schema import CollectionInfo
from .schema import FileInfo
from .schema import IngestionJobStatus
from .schema import RetrievalResult

logger = logging.getLogger(__name__)

# Prefix used for per-session (per-conversation) collections created by the UI,
# e.g. "s_<uuid>". Only collections with this prefix are subject to TTL reaping;
# base/project corpora (e.g. "oib_knowledge") are persistent and never auto-deleted.
SESSION_COLLECTION_PREFIX = "s_"

#: The order a structural fetch (:meth:`BaseRetriever.fetch`) can ask for: the
#: page a chunk starts on, as an integer, ``0`` when it has none. It is the
#: leading term of every document order a reader sorts by (``read_passage``'s
#: ``_punkt_sort_key`` starts with ``Chunk.page_number or 0``), so a fetch that
#: keeps the first N chunks in this order, and never splits a tie, hands that
#: reader exactly the chunks its own finer sort would have kept.
READING_ORDER = "reading_order"


def reading_order(page_label: Any) -> int:
    """A chunk's :data:`READING_ORDER` from its stored ``page_label``.

    The same parse the adapter's ``normalize`` makes for ``Chunk.page_number``
    (``int(page_label)``, nothing when that fails or is below 1, which a
    ``Chunk`` cannot carry), then ``or 0``. A worksheet name, a missing label
    and page 0 all read as 0.
    """
    try:
        page = int(page_label)
    except (TypeError, ValueError):
        return 0
    return page if page >= 1 else 0


def metadata_int(metadata: Mapping[str, Any] | None, key: str) -> int:
    """An integer chunk-metadata field, ``0`` when absent or not a number (an int, or the string a store hands back)."""
    raw = (metadata or {}).get(key)
    try:
        return int(str(raw).strip())
    except ValueError:
        return 0


def section_position(metadata: Mapping[str, Any] | None) -> tuple[int, int, int]:
    """Where a chunk sits inside its page by the structure its chunker stamped: section, first line, part.

    ``section_order`` and ``line_start`` place a tenant section („Geschoße“,
    „Zeilen 12-30“); the part is a table's row group or a long section's piece
    (``table_part``, else ``section_part``). ``(0, 0, 0)`` for a chunk with none
    of them, such as every chunk the ``SentenceSplitter`` cuts from a PDF page:
    those need their place in the file to be ordered (``chunk_ordinal`` in the
    Qdrant payload). ``read_passage`` sorts by the same terms.
    """
    part = metadata_int(metadata, "table_part") or metadata_int(metadata, "section_part")
    return (metadata_int(metadata, "section_order"), metadata_int(metadata, "line_start"), part)


#: ``Chunk.metadata`` key under which :meth:`BaseRetriever.search_grouped` puts
#: each chunk's score in the one fused ranking across every group. Comparable
#: across groups, unlike ``Chunk.score`` (the chunk's own cosine); the grouped
#: search route orders documents across projects by it.
FUSED_SCORE_KEY = "fused_score"


@dataclass
class PreparedIngestJob:
    """An ingestion job validated and recorded PENDING, not yet running anywhere.

    ``BaseIngestor.prepare_job`` makes one; whoever holds it decides where it
    runs: ``submit_prepared`` in this process's pool, or the durable queue for
    any worker that claims it (``aiq_api.jobs.ingest_queue``), which runs it
    with ``run_prepared``. ``file_paths`` are local paths or deferred downloads,
    as ``submit_job`` takes them.
    """

    job_id: str
    status: IngestionJobStatus
    file_paths: list[Any]
    collection_name: str
    config: dict[str, Any]

    @property
    def organization_id(self) -> str | None:
        """The organisation the job is scheduled for, when it has one."""
        value = self.config.get("organization_id")
        return value if isinstance(value, str) and value else None

    @property
    def priority(self) -> str:
        """``interactive`` (a person is waiting on this file) or ``bulk`` (a reindex, a rescan)."""
        return "bulk" if self.config.get("priority") == "bulk" else "interactive"


class TTLCleanupMixin:
    """
    Mixin that provides TTL-based collection cleanup.

    This mixin adds background thread-based cleanup of collections that haven't
    been updated within a configurable time period. Collections without an
    updated_at timestamp are skipped.

    Requires the class to implement:
        - list_collections() -> list[CollectionInfo]
        - delete_collection(name: str) -> bool
        - backend_name: str (for logging)

    Usage:
        class MyIngestor(TTLCleanupMixin, BaseIngestor):
            def __init__(self, config):
                super().__init__(config)
                # Start cleanup with 24-hour TTL, checking every hour
                self._start_ttl_cleanup_task(ttl_hours=24, interval_seconds=3600)
    """

    _ttl_hours: float
    _cleanup_interval_seconds: int

    def _start_ttl_cleanup_task(self, ttl_hours: float, interval_seconds: int) -> None:
        """
        Start the background thread for TTL-based collection cleanup.

        Args:
            ttl_hours: Hours before a collection is considered expired.
            interval_seconds: Seconds between cleanup runs.
        """
        self._ttl_hours = ttl_hours
        self._cleanup_interval_seconds = interval_seconds

        thread = threading.Thread(
            target=self._ttl_cleanup_loop,
            daemon=True,
            name=f"{self.backend_name}-ttl-cleanup",
        )
        thread.start()
        logger.info(
            f"Started collection TTL cleanup task for {self.backend_name} "
            f"(runs every {interval_seconds}s, TTL={ttl_hours}h)"
        )

    def _ttl_cleanup_loop(self) -> None:
        """Background loop that periodically cleans up expired collections."""
        while True:
            try:
                time.sleep(self._cleanup_interval_seconds)
                self._cleanup_expired_collections()
            except Exception as e:
                logger.error(f"TTL cleanup loop error for {self.backend_name}: {e}")

    # Distinct advisory lock id for the collection TTL cleanup ("AIQTTLCL").
    _TTL_CLEANUP_LOCK_ID = 0x41495154_544C434C

    def _cleanup_expired_collections(self) -> None:
        """Check all collections and delete those that have expired.

        Elects a single runner via a Postgres advisory lock so that, with the
        vector store now shared across replicas, N replicas don't race the same
        session-collection deletions each cycle. With no Postgres the process always leads;
        when the election cannot be held the cycle is skipped and the next tick retries.
        """
        from .leader_lock import leader_lock

        with leader_lock(self._TTL_CLEANUP_LOCK_ID) as is_leader:
            if not is_leader:
                logger.debug("TTL cleanup (%s): another replica holds the lock; skipping", self.backend_name)
                return
            self._run_cleanup_expired_collections()

    def _run_cleanup_expired_collections(self) -> None:
        try:
            collections = self.list_collections()
            logger.info(f"TTL cleanup ({self.backend_name}): checking {len(collections)} collections for expiration")
            now = datetime.now(UTC)
            ttl_threshold = now - timedelta(hours=self._ttl_hours)

            for collection in collections:
                # Only reap per-session collections (s_<uuid>). Base/project corpora
                # (e.g. "oib_knowledge") are persistent and must never be auto-deleted.
                if not collection.name.startswith(SESSION_COLLECTION_PREFIX):
                    logger.debug(
                        f"TTL cleanup ({self.backend_name}): skipping '{collection.name}' - "
                        f"not a session collection (no '{SESSION_COLLECTION_PREFIX}' prefix)"
                    )
                    continue

                if collection.updated_at is None:
                    logger.debug(f"TTL cleanup ({self.backend_name}): skipping '{collection.name}' - no timestamp")
                    continue

                # Ensure updated_at is timezone-aware for comparison
                updated_at = collection.updated_at
                if updated_at.tzinfo is None:
                    # Assume naive datetime is UTC
                    updated_at = updated_at.replace(tzinfo=UTC)

                logger.debug(
                    f"TTL cleanup ({self.backend_name}): '{collection.name}' "
                    f"updated_at={collection.updated_at}, threshold={ttl_threshold}, "
                    f"expired={updated_at < ttl_threshold}"
                )

                if updated_at < ttl_threshold:
                    logger.info(
                        f"Collection '{collection.name}' expired (last indexed: {collection.updated_at}), deleting..."
                    )
                    if self.delete_collection(collection.name):
                        logger.info(
                            f"TTL cleanup ({self.backend_name}): deleted expired collection '{collection.name}'"
                        )
                    else:
                        logger.warning(
                            f"TTL cleanup ({self.backend_name}): failed to delete collection '{collection.name}'"
                        )

        except Exception as e:
            logger.error(f"Failed to cleanup expired collections for {self.backend_name}: {e}")


class BaseRetriever(ABC):
    """
    Abstract base class for retrieval adapters.

    All retrieval backends must implement this interface. The key responsibility
    is converting backend-specific results into the Universal Chunk schema.
    """

    def __init__(self, config: dict[str, Any] | None = None):
        """
        Initialize the retriever with configuration.

        Args:
            config: Backend-specific configuration dictionary.
        """
        self.config = config or {}

    @abstractmethod
    async def retrieve(
        self,
        query: str,
        collection_name: str,
        top_k: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> RetrievalResult:
        """
        Retrieve documents matching the query.

        Args:
            query: The search query string.
            collection_name: Target collection/index name.
            top_k: Maximum number of results to return.
            filters: Optional metadata filters.

        Returns:
            RetrievalResult containing normalized Chunks.
        """

    async def warm_query(self, query: str) -> None:
        """Prepare ``query`` for a search about to be made (its embedding). Optional; never raises."""
        return None

    async def search_grouped(
        self,
        query: str,
        collection_names: list[str],
        groups: int,
        group_size: int,
        filters: dict[str, Any] | None = None,
        boost: dict[str, Any] | None = None,
    ) -> list[tuple[str, list[Chunk]]]:
        """One ranking over many collections, grouped per collection, best group first.

        What cross-project search needs (ADR-0094, ADR-0114): every reachable
        project ranked in ONE query, so scores never have to be compared
        across separate indexes. Only a backend with a shared index can answer
        it; the default raises ``NotImplementedError``.

        ``filters`` (the grammar ``retrieve`` takes) narrow the search before
        ranking. ``boost`` (``{"facts": {...}, "weights": {...}}``: the current
        project's fingerprint and the BFF's similarity weights) lifts passages
        from projects like the current one. Every chunk carries its fused
        score as ``metadata[FUSED_SCORE_KEY]``.
        """
        raise NotImplementedError(f"{self.backend_name} cannot rank across collections in one query")

    def embed_query(self, text: str) -> list[float]:
        """The query vector the production embedder gives ``text``, through the retriever's own cache.

        For a caller that queries the store with a vector of its own: similar
        passages for a selected sentence. Blocking (one remote round trip on a
        cache miss). A backend that embeds no queries raises.
        """
        raise NotImplementedError(f"{self.backend_name} embeds no queries for a caller")

    def embedding_identity(self) -> dict[str, str]:
        """The embedder :meth:`embed_query` uses, as the store records it on a collection; empty when unknown."""
        return {}

    async def find_text(
        self,
        collection_name: str,
        pattern: str,
        filters: dict[str, Any] | None = None,
        limit: int = 500,
    ) -> list[Chunk] | None:
        """Every chunk whose text matches the regular expression ``pattern`` anywhere.

        Exhaustive, unranked and embedding-free: the answer to "which files say
        X", which a top-k similarity search cannot give. At most ``limit``
        chunks. ``None`` means the backend cannot do it, never "no match": a
        caller must be able to tell an empty result from an unsupported one.

        ``pattern`` is written in the subset Rust's ``regex`` and Python's
        ``re`` read alike (no lookaround, no backreference), because the
        caller re-checks every chunk with the same string. Case-insensitivity,
        spelling variants and word boundaries are the CALLER's, expressed in
        the pattern (``(?i)``, alternation, ``\\b``); a backend matches it as given.
        """
        return None

    async def fetch(
        self,
        collection_name: str,
        filters: dict[str, Any] | None,
        limit: int,
        order_by: str | None = None,
    ) -> list[Chunk] | None:
        """The chunks of ``collection_name`` that ``filters`` admits, read by filter alone.

        A structural read: no query, no embedding, no ranking. What a locator
        needs when the filter has already decided which chunks exist (a named
        Punkt, a page, a document's outline). Every returned chunk matches, so
        each carries score 1.0, as :meth:`find_text`'s do.

        At most ``limit`` chunks in the store's own order, or, with
        ``order_by=READING_ORDER``, the first ``limit`` in that order plus
        every chunk tied with the last of them: a tie is never split, so a
        caller that re-sorts by a finer key starting with :data:`READING_ORDER`
        keeps exactly what it would have kept from the whole set.

        ``None`` means the backend cannot read by filter, never "nothing
        matched": the caller then takes its old path (``retrieve``). A store
        error raises.
        """
        return None

    @abstractmethod
    def normalize(self, raw_result: Any) -> Chunk:
        """
        Convert a backend-specific result into a universal Chunk.

        This is the core of the Adapter Pattern - each backend must translate
        its native format to the Universal Schema.

        Args:
            raw_result: The raw result from the backend.

        Returns:
            A normalized Chunk object.
        """

    @property
    @abstractmethod
    def backend_name(self) -> str:
        """Return the name of this backend for logging/tracking."""

    async def health_check(self) -> bool:
        """
        Check if the backend is healthy and reachable.

        Returns:
            True if healthy, False otherwise.
        """
        return True  # NOSONAR


class BaseIngestor(ABC):
    """
    Abstract base class for ingestion adapters.

    All ingestion backends must implement this interface. Ingestion is
    inherently asynchronous - submit_job returns immediately with a job ID,
    and get_job_status is used for polling.
    """

    def __init__(self, config: dict[str, Any] | None = None):
        """
        Initialize the ingestor with configuration.

        Args:
            config: Backend-specific configuration dictionary.
        """
        self.config = config or {}

    @abstractmethod
    def submit_job(
        self,
        file_paths: list[str | Callable[[], str]],
        collection_name: str,
        config: dict[str, Any] | None = None,
    ) -> str:
        """
        Non-blocking job submission.

        This method should return immediately with a job ID. The actual
        processing happens asynchronously in the background.

        Args:
            file_paths: Files to ingest. An entry is a local path, or a
                zero-argument callable the job runs when it reaches the file,
                which downloads it and returns the local path; that file is the
                job's to delete. ``POST /v1/ingest`` hands over the latter so
                the request downloads nothing (``knowledge_layer.deferred_files``).
            collection_name: Target collection/index name.
            config: Optional ingestion configuration (chunking, extraction, and so on).

        Returns:
            job_id (str) immediately.
        """

    @abstractmethod
    def get_job_status(self, job_id: str) -> IngestionJobStatus:
        """
        Get the current status of an ingestion job.

        This is called by the polling loop to check progress.

        Args:
            job_id: The job ID returned from submit_job.

        Returns:
            IngestionJobStatus with current state.
        """

    #: Whether ``prepare_job``/``run_prepared``/``attach_job_source`` work, so a
    #: job can run in another process than the one that accepted it.
    supports_durable_jobs = False

    def prepare_job(
        self,
        file_paths: list[str | Callable[[], str]],
        collection_name: str,
        config: dict[str, Any] | None = None,
        job_id: str | None = None,
    ) -> "PreparedIngestJob":
        """Validate a job and record it PENDING without running it (see ``PreparedIngestJob``).

        ``job_id`` names the job when its caller needs the same id for the same work
        (the base corpus does); without it a fresh one is made.
        """
        raise NotImplementedError

    def submit_prepared(self, prepared: "PreparedIngestJob") -> None:
        """Queue a prepared job in this process."""
        raise NotImplementedError

    def run_prepared(self, prepared: "PreparedIngestJob", still_owner: Callable[[], bool] | None = None) -> None:
        """Run a prepared job on the calling thread; ``still_owner`` says whether its claim is still held."""
        raise NotImplementedError

    def attach_job_source(self, source: Callable[[], Callable[[], None] | None]) -> None:
        """Let this process's free workers claim jobs from ``source``."""
        raise NotImplementedError

    def detach_job_source(self) -> None:
        """Stop claiming from the attached source."""

    @property
    def busy_workers(self) -> int:
        """Workers running a job right now."""
        return 0

    def find_live_job(self, dispatch_key: str) -> str | None:
        """The id of a pending or processing job submitted under ``dispatch_key``, or None.

        ``dispatch_key`` rides in ``submit_job``'s config; ``POST /v1/ingest``
        asks this before submitting, so a retried dispatch joins the job already
        running instead of starting a second one. A backend that cannot answer
        says None, and the dispatch submits as it always did.
        """
        return None

    @property
    @abstractmethod
    def backend_name(self) -> str:
        """Return the name of this backend for logging/tracking."""

    # =========================================================================
    # Collection Management
    # =========================================================================

    @abstractmethod
    def create_collection(
        self,
        name: str,
        description: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CollectionInfo:
        """
        Create a new collection/index.

        Args:
            name: Unique collection name.
            description: Human-readable description.
            metadata: Backend-specific configuration.

        Returns:
            CollectionInfo with the created collection details.
        """

    @abstractmethod
    def delete_collection(self, name: str) -> bool:
        """
        Delete a collection and all its contents.

        Args:
            name: Collection name to delete.

        Returns:
            True if deleted successfully, False otherwise.
        """

    @abstractmethod
    def list_collections(self) -> list[CollectionInfo]:
        """
        List all available collections.

        Returns:
            List of CollectionInfo objects.
        """

    @abstractmethod
    def get_collection(self, name: str) -> CollectionInfo | None:
        """
        Get metadata for a specific collection.

        Args:
            name: Collection name.

        Returns:
            CollectionInfo if found, None when the store says the collection
            does not exist.

        Raises:
            Exception: when the store cannot answer (unreachable, timed out).
            That is not "missing", and a caller must not treat it as one.
        """

    # =========================================================================
    # File Management
    # =========================================================================

    @abstractmethod
    def upload_file(
        self,
        file_path: str,
        collection_name: str,
        metadata: dict[str, Any] | None = None,
    ) -> FileInfo:
        """
        Upload a file to a collection.

        This should handle the file upload and return immediately.
        Actual ingestion may happen asynchronously via submit_job.

        Args:
            file_path: Local path to the file.
            collection_name: Target collection.
            metadata: Optional file metadata.

        Returns:
            FileInfo with upload status.
        """

    @abstractmethod
    def delete_file(self, file_id: str, collection_name: str, *, permanent: bool = False) -> bool:
        """
        Delete a file and its chunks from a collection.

        Args:
            file_id: File identifier (can be filename or internal ID).
            collection_name: Collection containing the file.
            permanent: A delete nobody undoes. Without it the Fassung facts a
                person made on the file's metadata row are kept for the file's
                return (``DocumentMetadataStore.unregister``).

        Returns:
            True if deleted successfully, False otherwise.
        """

    def delete_files(
        self,
        file_ids: list[str],
        collection_name: str,
        *,
        permanent: bool = False,
    ) -> dict[str, Any]:
        """
        Delete multiple files from a collection (batch delete).

        Args:
            file_ids: List of file IDs to delete.
            collection_name: Collection containing the files.
            permanent: Passed to :meth:`delete_file` for each file.

        Returns:
            Dict with 'successful' (list), 'failed' (list), 'total_deleted' (int).
        """
        successful = []
        failed = []

        for file_id in file_ids:
            try:
                if self.delete_file(file_id, collection_name, permanent=permanent):
                    successful.append(file_id)
                else:
                    failed.append({"file_id": file_id, "error": "Not found or already deleted"})
            except Exception as e:
                failed.append({"file_id": file_id, "error": str(e)})

        return {
            "message": f"Deleted {len(successful)} of {len(file_ids)} files",
            "successful": successful,
            "failed": failed,
            "total_deleted": len(successful),
        }

    @abstractmethod
    def list_files(self, collection_name: str) -> list[FileInfo]:
        """
        List all files in a collection.

        Args:
            collection_name: Collection to list files from.

        Returns:
            List of FileInfo objects.
        """

    @abstractmethod
    def get_file_status(self, file_id: str, collection_name: str) -> FileInfo | None:
        """
        Get the current status of a file.

        Args:
            file_id: File identifier.
            collection_name: Collection containing the file.

        Returns:
            FileInfo if found, None otherwise.
        """

    # =========================================================================
    # Optional: Source Selection (for multi-collection queries)
    # =========================================================================

    def select_sources(self, source_names: list[str]) -> bool:
        """
        Select which collections/sources to use for retrieval.

        This is optional - backends that don't support multi-source
        queries can leave the default implementation.

        Args:
            source_names: List of collection names to activate.

        Returns:
            True if selection succeeded, False otherwise.
        """
        raise NotImplementedError(
            f"{self.backend_name} does not support source selection. Override this method if your backend supports it."
        )

    def get_selected_sources(self) -> list[str]:
        """
        Get the currently selected sources.

        Returns:
            List of selected collection names.
        """
        raise NotImplementedError(
            f"{self.backend_name} does not support source selection. Override this method if your backend supports it."
        )

    # =========================================================================
    # Optional: Document Summarization
    # =========================================================================

    def generate_summary(self, text_content: str, file_name: str) -> str | None:
        """
        Generate a short summary of the document content.

        Override in adapters to enable summarization. Default returns None.

        Args:
            text_content: Combined text from first and last chunks.
            file_name: Original filename for context.

        Returns:
            One-sentence summary or None if not implemented.
        """
        return None

    def get_document_visual_details(self, collection_name: str, file_name: str) -> list[dict[str, Any]]:
        """Per-page VLM descriptions of a document's visual chunks. Default: none."""
        return []

    async def health_check(self) -> bool:
        """
        Check if the backend is healthy and reachable.

        Returns:
            True if healthy, False otherwise.
        """
        return True  # NOSONAR
