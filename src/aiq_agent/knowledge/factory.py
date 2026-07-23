"""
Factory pattern for Knowledge Layer adapters.

This module provides a registry-based factory for creating retriever and
ingestor instances. New backends are registered using decorators and can
be instantiated by name at runtime.

Configuration:
    The default backend is configured via environment variables at startup:
    - KNOWLEDGE_RETRIEVER_BACKEND: Default retriever (e.g., "llamaindex")
    - KNOWLEDGE_INGESTOR_BACKEND: Default ingestor (e.g., "llamaindex")

    This ensures the backend is set up BEFORE any API calls are made.
    Users don't need to specify the backend in each request.
"""

import logging
import os
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.db_utils import redact_db_url

from .base import BaseIngestor
from .base import BaseRetriever
from .schema import FileStatus

if TYPE_CHECKING:
    from .schema import AvailableDocument
    from .summary_store import SummaryStore

logger = logging.getLogger(__name__)

# =============================================================================
# Default Backend Configuration (Set at Startup)
# =============================================================================
# These are read from environment variables at module load time.
# The API layer uses these defaults - users don't need to specify per-request.
#
# NOTE: Backend-specific configuration (milvus_uri, chroma_path, etc.) should
# be defined in each adapter, NOT here. The factory is backend-agnostic.

# @environment_variable KNOWLEDGE_RETRIEVER_BACKEND
# @category Knowledge Layer
# @type str
# @default llamaindex
# @required false
# Default retriever backend. Set at startup by knowledge_retrieval function.
DEFAULT_RETRIEVER_BACKEND = os.environ.get("KNOWLEDGE_RETRIEVER_BACKEND", "llamaindex")

# @environment_variable KNOWLEDGE_INGESTOR_BACKEND
# @category Knowledge Layer
# @type str
# @default llamaindex
# @required false
# Default ingestor backend. Set at startup by knowledge_retrieval function.
DEFAULT_INGESTOR_BACKEND = os.environ.get("KNOWLEDGE_INGESTOR_BACKEND", "llamaindex")

# =============================================================================
# Registry
# =============================================================================

# Registry for retriever adapters (class registry)
_RETRIEVER_REGISTRY: dict[str, type[BaseRetriever]] = {}

# Registry for ingestor adapters (class registry)
_INGESTOR_REGISTRY: dict[str, type[BaseIngestor]] = {}

# Singleton instances (cached for job state persistence)
_RETRIEVER_INSTANCES: dict[str, BaseRetriever] = {}
_INGESTOR_INSTANCES: dict[str, BaseIngestor] = {}

# Active ingestor for the Knowledge API (set by knowledge_retrieval function)
_ACTIVE_INGESTOR: BaseIngestor | None = None

# Active retriever for the Knowledge API (lazily built from the active ingestor's
# backend/config on first use — see get_active_retriever). Cached so a fresh
# process serving /v1/collections/{c}/search initializes the retriever once and
# reuses it (no per-request embed-client / Chroma re-init).
_ACTIVE_RETRIEVER: BaseRetriever | None = None
_active_retriever_lock = threading.Lock()


def register_retriever(name: str) -> Callable[[type[BaseRetriever]], type[BaseRetriever]]:
    """
    Decorator to register a retriever adapter.

    Usage:
        @register_retriever("llamaindex")
        class LlamaIndexRetriever(BaseRetriever):
            ...

    Args:
        name: The name to register this adapter under.

    Returns:
        Decorator function.
    """

    def decorator(cls: type[BaseRetriever]) -> type[BaseRetriever]:
        if name in _RETRIEVER_REGISTRY:
            logger.warning(f"Overwriting existing retriever adapter: {name}")
        _RETRIEVER_REGISTRY[name] = cls
        logger.debug(f"Registered retriever adapter: {name}")
        return cls

    return decorator


def register_ingestor(name: str) -> Callable[[type[BaseIngestor]], type[BaseIngestor]]:
    """
    Decorator to register an ingestor adapter.

    Usage:
        @register_ingestor("llamaindex")
        class LlamaIndexIngestor(BaseIngestor):
            ...

    Args:
        name: The name to register this adapter under.

    Returns:
        Decorator function.
    """

    def decorator(cls: type[BaseIngestor]) -> type[BaseIngestor]:
        if name in _INGESTOR_REGISTRY:
            logger.warning(f"Overwriting existing ingestor adapter: {name}")
        _INGESTOR_REGISTRY[name] = cls
        logger.debug(f"Registered ingestor adapter: {name}")
        return cls

    return decorator


def get_retriever(
    backend: str | None = None,
    config: dict[str, Any] | None = None,
) -> BaseRetriever:
    """
    Factory function to get a configured retriever adapter.

    Configuration Precedence (highest to lowest):
        1. Explicit ``backend`` parameter passed to this function
        2. KNOWLEDGE_RETRIEVER_BACKEND environment variable
        3. Default: "llamaindex"

    Args:
        backend: The backend name ('llamaindex' or 'foundational_rag').
                 If None, uses the environment variable or default.
        config: Backend-specific configuration. Passed directly to the adapter.
                Each adapter defines its own defaults internally.

    Returns:
        Configured retriever adapter instance.

    Raises:
        ValueError: If backend is not registered.

    Example:
        >>> retriever = get_retriever("llamaindex", {"persist_dir": "/data/chroma"})
        >>> result = await retriever.retrieve("What is RAG?", "my_collection")
    """
    # Use configured default if not specified
    backend = backend or DEFAULT_RETRIEVER_BACKEND

    if backend not in _RETRIEVER_REGISTRY:
        available = list(_RETRIEVER_REGISTRY.keys())
        raise ValueError(f"Unknown retriever backend: {backend}. Available backends: {available}")

    # Pass config directly to adapter - each adapter handles its own defaults
    adapter_cls = _RETRIEVER_REGISTRY[backend]
    return adapter_cls(config=config or {})


def get_ingestor(
    backend: str | None = None,
    config: dict[str, Any] | None = None,
) -> BaseIngestor:
    """
    Factory function to get a configured ingestor adapter.

    Uses singleton pattern to preserve job state across requests.

    Configuration Precedence (highest to lowest):
        1. Explicit ``backend`` parameter passed to this function
        2. KNOWLEDGE_INGESTOR_BACKEND environment variable
        3. Default: "llamaindex"

    Args:
        backend: The backend name ('llamaindex' or 'foundational_rag').
                 If None, uses the environment variable or default.
        config: Backend-specific configuration. Passed directly to the adapter.
                Each adapter defines its own defaults internally.
                Note: config is only used on first instantiation (singleton).

    Returns:
        Configured ingestor adapter instance (singleton per backend).

    Raises:
        ValueError: If backend is not registered.

    Example:
        >>> ingestor = get_ingestor("llamaindex", {"persist_dir": "/data/chroma"})
        >>> job_id = ingestor.submit_job(["/path/to/file.pdf"], "my_collection")
    """
    # Use configured default if not specified
    backend = backend or DEFAULT_INGESTOR_BACKEND

    if backend not in _INGESTOR_REGISTRY:
        available = list(_INGESTOR_REGISTRY.keys())
        raise ValueError(f"Unknown ingestor backend: {backend}. Available backends: {available}")

    # Return cached instance if available (singleton pattern for job persistence)
    if backend in _INGESTOR_INSTANCES:
        if config:
            logger.debug(f"Returning cached {backend} ingestor (config parameter ignored)")
        return _INGESTOR_INSTANCES[backend]

    # Pass config directly to adapter - each adapter handles its own defaults
    adapter_cls = _INGESTOR_REGISTRY[backend]
    instance = adapter_cls(config=config or {})

    # Cache the instance
    _INGESTOR_INSTANCES[backend] = instance
    logger.info(f"Created singleton ingestor instance for backend: {backend}")

    return instance


def list_retrievers() -> list[str]:
    """Return list of registered retriever backends."""
    return list(_RETRIEVER_REGISTRY.keys())


def list_ingestors() -> list[str]:
    """Return list of registered ingestor backends."""
    return list(_INGESTOR_REGISTRY.keys())


def set_active_ingestor(ingestor: BaseIngestor) -> None:
    """
    Set the active ingestor for the Knowledge API.

    Called by the knowledge_retrieval function during initialization to make
    the configured ingestor available to API routes.

    Args:
        ingestor: The ingestor instance to activate.
    """
    global _ACTIVE_INGESTOR
    _ACTIVE_INGESTOR = ingestor
    logger.info("Set active ingestor: %s", ingestor.backend_name)


def get_active_ingestor() -> BaseIngestor | None:
    """
    Get the active ingestor for the Knowledge API.

    Returns:
        The active BaseIngestor instance, or None if not configured.
    """
    return _ACTIVE_INGESTOR


def clear_active_ingestor() -> None:
    """Clear the active ingestor (for testing)."""
    global _ACTIVE_INGESTOR
    _ACTIVE_INGESTOR = None


def _retriever_config_from_ingestor(ingestor: BaseIngestor) -> dict[str, Any]:
    """Mirror the active ingestor's store + embedding config for the retriever.

    The retriever and ingestor MUST read the same Chroma persist directory and
    embed the same model, or search would query a different (empty) store than
    was ingested into. The ingestor exposes its resolved settings as attributes
    (``persist_dir``/``embed_base_url``/``embed_model_name``); we copy the ones
    that resolve into the retriever's config-key names. Read defensively via
    ``getattr`` so a backend that does not expose an attribute simply falls back
    to the retriever adapter's own default for that key.
    """
    attr_to_key = {
        "persist_dir": "persist_dir",
        "embed_base_url": "embed_base_url",
        "embed_model_name": "embed_model",
    }
    config: dict[str, Any] = {}
    for attr, key in attr_to_key.items():
        value = getattr(ingestor, attr, None)
        if value is not None:
            config[key] = value
    return config


def set_active_retriever(retriever: BaseRetriever) -> None:
    """
    Set the active retriever for the Knowledge API.

    Mirrors :func:`set_active_ingestor`. Optional wiring hook: callers that want
    to inject a pre-built retriever (e.g. tests, or explicit startup) can do so;
    otherwise :func:`get_active_retriever` builds one lazily from the active
    ingestor's config.

    Args:
        retriever: The retriever instance to activate.
    """
    global _ACTIVE_RETRIEVER
    _ACTIVE_RETRIEVER = retriever
    logger.info("Set active retriever: %s", retriever.backend_name)


def get_active_retriever() -> BaseRetriever:
    """
    Get (or lazily build) the cached retriever singleton for the Knowledge API.

    Mirrors the active-ingestor singleton. The first caller in a fresh process
    builds ONE retriever from the same backend + store/embedding config the
    active ingestor was created with (see :func:`_retriever_config_from_ingestor`),
    so both share the same Chroma persist directory and embedding model. The
    instance is cached and reused for every subsequent request — no per-request
    embed-client / Chroma re-init. (The adapter itself still lazy-initializes its
    heavy components on the first ``retrieve`` call.)

    If no active ingestor is set, falls back to the factory default backend/config
    (env-driven) so the retriever is still usable.

    Returns:
        The cached BaseRetriever instance.
    """
    global _ACTIVE_RETRIEVER
    if _ACTIVE_RETRIEVER is not None:
        return _ACTIVE_RETRIEVER

    with _active_retriever_lock:
        # Double-checked: another caller may have built it while we waited.
        if _ACTIVE_RETRIEVER is not None:
            return _ACTIVE_RETRIEVER

        ingestor = _ACTIVE_INGESTOR
        if ingestor is not None:
            backend: str | None = ingestor.backend_name
            config: dict[str, Any] | None = _retriever_config_from_ingestor(ingestor)
        else:
            # No configured ingestor — fall back to env-driven factory defaults.
            backend = None
            config = None

        _ACTIVE_RETRIEVER = get_retriever(backend, config)
        logger.info("Built active retriever: %s", _ACTIVE_RETRIEVER.backend_name)
        return _ACTIVE_RETRIEVER


def clear_active_retriever() -> None:
    """Clear the cached active retriever (for testing)."""
    global _ACTIVE_RETRIEVER
    _ACTIVE_RETRIEVER = None


# =============================================================================
# Summary Registry (SQLAlchemy-backed, Backend-Agnostic)
# =============================================================================
# Persistent storage for document summaries using configurable SQLite/PostgreSQL.
# Backends call register_summary() after ingestion; agents call
# get_available_documents() for prompt context.

_summary_store: "SummaryStore | None" = None
# Guards lazy init of _summary_store. The default-init path is now reachable
# from thread-pool workers (knowledge_search formats results via
# asyncio.to_thread), so double-check under this lock to prevent two concurrent
# cold-start callers each constructing a store/engine and one clobbering the
# other. Steady state re-checks without contention.
_summary_store_lock = threading.Lock()

# Default DB URL (used if configure_summary_db not called)
_DEFAULT_SUMMARY_DB = "sqlite+aiosqlite:///./summaries.db"


def configure_summary_db(db_url: str) -> None:
    """Initialize summary store with given DB URL."""
    global _summary_store
    from .summary_store import SummaryStore

    with _summary_store_lock:
        _summary_store = SummaryStore(db_url)
    logger.info("Summary store configured: %s", redact_db_url(db_url))


def _get_summary_store() -> "SummaryStore":
    """Get or create the summary store (lazy init with default)."""
    global _summary_store
    if _summary_store is None:
        from .summary_store import SummaryStore

        with _summary_store_lock:
            # Double-checked: another caller may have initialized it while we
            # waited for the lock.
            if _summary_store is None:
                # configure_summary_db() may not have run in this process (e.g. an
                # ingestion thread/worker that never executed the NAT registration
                # in sources/knowledge_layer/src/register.py). Resolve the DB from
                # the environment the same way ingest_status_store/leader_lock do,
                # instead of silently falling back to a local SQLite file that in a
                # container often isn't writable ("unable to open database file")
                # and, worse, would split summaries away from the real Postgres.
                db_url = (
                    os.environ.get("AIQ_SUMMARY_DB") or os.environ.get("NAT_JOB_STORE_DB_URL") or _DEFAULT_SUMMARY_DB
                )
                _summary_store = SummaryStore(db_url)
                logger.info("Summary store initialized (lazy env fallback): %s", redact_db_url(db_url))
    return _summary_store


def register_summary(
    collection: str,
    filename: str,
    summary: str | None,
    tags: list[str] | None = None,
) -> None:
    """Store a summary (and optional controlled tags) in the database.

    The ``summary`` column is NOT NULL, so a file with no summary is skipped
    entirely — tags ride along with the summary in a single upsert per file.
    """
    if not summary:
        return
    _get_summary_store().register(collection, filename, summary, tags)


def update_document_tags(collection: str, filename: str, tags: list[str] | None) -> bool:
    """Replace only the controlled tags of an existing summary row.

    The single factory seam behind BOTH the classify-only backfill script and
    the user-facing tag-edit endpoint. Never touches the summary; returns
    ``False`` when no summary row exists (callers 404). Tag-vocabulary
    validation is the caller's responsibility — the store persists whatever it
    is given, so every caller MUST validate against
    ``document_classification.ALLOWED_TAGS`` first.
    """
    return _get_summary_store().update_tags(collection, filename, tags)


def set_document_doc_class(collection: str, filename: str, doc_class: str | None) -> bool:
    """Set the explicit ``doc_class`` ("Dokumentart") on an existing summary row.

    UPDATE-only (never creates a row): returns ``False`` when no summary row
    exists for ``(collection, filename)``. The single factory seam behind the
    ingestion pre-fill and any future doc_class-edit endpoint.
    """
    return _get_summary_store().set_doc_class(collection, filename, doc_class)


def get_document_doc_class(collection: str, filename: str) -> str | None:
    """Return the stored explicit ``doc_class`` for a document, or ``None``."""
    return _get_summary_store().get_doc_class(collection, filename)


def get_document_doc_classes(collection: str, filenames: list[str]) -> dict[str, str]:
    """Return stored ``doc_class`` values for many documents in one query.

    Batched equivalent of :func:`get_document_doc_class`; only documents with a
    truthy stored ``doc_class`` appear in the map (same coercion).
    """
    return _get_summary_store().get_doc_classes_batch(collection, filenames)


def list_summary_collections() -> list[str]:
    """List every collection that has at least one persisted summary."""
    return _get_summary_store().list_collections()


def get_available_documents(collection: str) -> list["AvailableDocument"]:
    """Get documents with summaries (sync)."""
    return _get_summary_store().get_all(collection)


async def get_available_documents_async(collection: str) -> list["AvailableDocument"]:
    """Get documents with summaries (async)."""
    return await _get_summary_store().get_all_async(collection)


def reconcile_collection_summaries(ingestor: BaseIngestor, collection: str) -> int:
    """Backfill fallback summary rows for documents the vector index has but the summaries table doesn't.

    Structural backstop for "ingested ⇒ visible": ``available_documents`` (the
    per-turn prompt line agents rely on to know what's searchable) is sourced
    SOLELY from the summaries table, while search itself works off the vector
    index. If the primary summary path (LLM summary + tag classification, both
    fail-open) ever produces no row for a document that nonetheless ingested
    successfully, that document becomes silently unusable in chat even though
    it is fully searchable. This diffs the ingestor's indexed, successfully-
    ingested file names (``BaseIngestor.list_files``, part of every backend's
    interface) against the summaries table (``get_available_documents``) and
    registers a deterministic, LLM-free fallback summary for every gap.

    Backend-agnostic by design: only calls the required ``BaseIngestor``
    interface. Backends that can supply a representative text sample for a
    document expose an optional ``get_document_text_sample(collection,
    file_name) -> str | None`` method (duck-typed via ``getattr`` — deliberately
    not part of the abstract ``BaseIngestor`` interface, so this stays opt-in
    per backend); see ``LlamaIndexIngestor.get_document_text_sample`` for the
    reference implementation, which reads chunk text back out of Chroma. When a
    backend has no such method, or the sample comes back empty, the filename
    itself becomes the fallback summary — a row that exists beats no row at
    all.

    Intended to run at the end of every ingestion job (wired into
    ``LlamaIndexIngestor._run_ingestion``) so every caller — the Knowledge API,
    ``scripts/ingest_oib.py``'s ``oib_sync.sync()``, and any future caller —
    gets this backstop automatically.

    Args:
        ingestor: The backend ingestor to reconcile against.
        collection: Collection/index name to reconcile.

    Returns:
        The number of documents backfilled (0 when already consistent, or on
        any lookup failure — this never raises).
    """
    try:
        indexed_files = ingestor.list_files(collection)
    except Exception as e:
        logger.warning("Reconciliation: failed to list indexed files for %s: %s", collection, e)
        return 0

    indexed_names = {f.file_name for f in indexed_files if f.status == FileStatus.SUCCESS}
    if not indexed_names:
        return 0

    existing_names = {doc.file_name for doc in get_available_documents(collection)}
    missing_names = indexed_names - existing_names
    if not missing_names:
        return 0

    from .document_classification import fallback_summary_from_text

    sample_fn = getattr(ingestor, "get_document_text_sample", None)

    backfilled = 0
    for file_name in sorted(missing_names):
        text_sample = None
        if callable(sample_fn):
            try:
                text_sample = sample_fn(collection, file_name)
            except Exception as e:
                logger.warning("Reconciliation: failed to sample text for %s in %s: %s", file_name, collection, e)

        summary = fallback_summary_from_text(text_sample) if text_sample else None
        if not summary:
            # No usable text sample (no sampler on this backend, or the indexed
            # chunks came back empty) — fall back to the filename itself so a
            # row exists at all. Visibility beats a perfect summary here.
            summary = f"Indexed document: {file_name}"

        register_summary(collection, file_name, summary)
        backfilled += 1
        logger.warning(
            "Reconciliation: backfilled missing summary for %s in %s "
            "(primary summary path silently produced no row for an ingested document)",
            file_name,
            collection,
        )

    logger.warning(
        "Reconciliation: backfilled %d/%d document(s) missing summaries in %s",
        backfilled,
        len(indexed_names),
        collection,
    )
    return backfilled


def unregister_summary(collection: str, filename: str) -> None:
    """Delete a file's summary."""
    _get_summary_store().unregister(collection, filename)


def clear_collection_summaries(collection: str) -> None:
    """Delete all summaries in a collection."""
    _get_summary_store().clear_collection(collection)


def clear_all_summaries() -> None:
    """Delete all summaries."""
    _get_summary_store().clear_all()


def is_retriever_registered(name: str) -> bool:
    """Check if a retriever backend is registered."""
    return name in _RETRIEVER_REGISTRY


def is_ingestor_registered(name: str) -> bool:
    """Check if an ingestor backend is registered."""
    return name in _INGESTOR_REGISTRY


# =============================================================================
# Configuration Helpers
# =============================================================================


def get_default_retriever_backend() -> str:
    """Get the configured default retriever backend."""
    return DEFAULT_RETRIEVER_BACKEND


def get_default_ingestor_backend() -> str:
    """Get the configured default ingestor backend."""
    return DEFAULT_INGESTOR_BACKEND


def get_knowledge_layer_config() -> dict[str, Any]:
    """
    Get the complete knowledge layer configuration.

    Useful for debugging and displaying current setup.
    Note: Backend-specific config is defined in each adapter, not here.
    """
    return {
        "retriever": {
            "default_backend": DEFAULT_RETRIEVER_BACKEND,
            "available_backends": list(_RETRIEVER_REGISTRY.keys()),
        },
        "ingestor": {
            "default_backend": DEFAULT_INGESTOR_BACKEND,
            "available_backends": list(_INGESTOR_REGISTRY.keys()),
        },
    }
