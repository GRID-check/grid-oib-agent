"""NAT function for knowledge retrieval.

This function provides direct library access to the knowledge layer,
allowing agents to search ingested documents without an external API server.

The retriever is instantiated once and reused for all queries.
"""

import asyncio
import logging
import os
from typing import Literal

from pydantic import Field
from pydantic import model_validator

from nat.builder.builder import Builder
from nat.builder.context import Context
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)


# Type-safe backend selection - Pydantic validates at config load time
BackendType = Literal["llamaindex", "foundational_rag"]


class KnowledgeRetrievalConfig(FunctionBaseConfig, name="knowledge_retrieval"):
    """Configuration for knowledge retrieval function."""

    backend: BackendType = Field(default="llamaindex", description="Knowledge backend to use")
    collection_name: str = Field(default="default", description="Name of the collection/index to search")
    use_fixed_collection: bool = Field(
        default=False,
        description=(
            "When true, always search the configured collection_name and ignore the per-session "
            "conversation_id collection. Use for fixed, persistent corpora."
        ),
    )
    include_base_collection: bool = Field(
        default=False,
        description=(
            "Always include the configured base collection_name in the search set (e.g. the fixed OIB corpus)."
        ),
    )
    include_session_collection: bool = Field(
        default=True,
        description=(
            "Also search the per-session collection (Context.conversation_id) when available, "
            "so per-conversation uploads are searched."
        ),
    )
    project_collections: list[str] = Field(
        default_factory=list,
        description=(
            "Additional named persistent collections (e.g. project-scoped corpora) to always include in the search set."
        ),
    )
    top_k: int = Field(default=5, description="Number of results to return")
    exclude_file_names: list[str] = Field(
        default_factory=list,
        description=(
            "File names whose chunks are excluded from results of the base collection "
            "(e.g. OIB Änderungsdokumente and superseded editions). Applied as a "
            "metadata filter (file_name NOT IN ...) on the base collection only; "
            "session and project collections are never filtered."
        ),
    )
    # Summarization options (applies to all backends)
    generate_summary: bool = Field(
        default=False, description="Generate one-sentence summary for each ingested document"
    )
    summary_model: str | None = Field(
        default=None,
        description="Required when generate_summary=true: LLM reference from llms: section",
    )
    summary_db: str = Field(
        default="sqlite+aiosqlite:///./summaries.db",
        description="Database URL for document summaries (SQLite or PostgreSQL)",
    )
    # LlamaIndex-specific options
    chroma_dir: str = Field(
        default="/tmp/chroma_data", description="Directory for ChromaDB persistence (LlamaIndex only)"
    )
    # Foundational RAG (hosted RAG Blueprint) options
    rag_url: str = Field(default="http://localhost:8081/v1", description="RAG query server URL (foundational_rag only)")
    ingest_url: str = Field(
        default="http://localhost:8082/v1", description="RAG ingestion server URL (foundational_rag only)"
    )
    timeout: int = Field(default=120, description="Request timeout in seconds (foundational_rag only)")
    verify_ssl: bool = Field(
        default=True, description="Verify SSL certificates (foundational_rag only). Set false for self-signed certs."
    )

    @model_validator(mode="after")
    def validate_backend_config(self):
        """Validate and warn about unused backend-specific config options."""
        backend = self.backend.lower()

        # Validate summary configuration
        if self.generate_summary and not self.summary_model:
            raise ValueError(
                "generate_summary=true requires summary_model to be set. "
                "Configure summary_model to reference an LLM from the llms: section."
            )

        if backend == "llamaindex":
            # LlamaIndex uses chroma_dir, warn if RAG-specific options are set
            if self.rag_url != "http://localhost:8081/v1":
                logger.warning("rag_url is ignored for llamaindex backend")
            if self.ingest_url != "http://localhost:8082/v1":
                logger.warning("ingest_url is ignored for llamaindex backend")

        elif backend == "foundational_rag":
            # Foundational RAG uses rag_url/ingest_url, warn if others are set
            if self.chroma_dir != "/tmp/chroma_data":
                logger.warning("chroma_dir is ignored for foundational_rag backend")
            if not self.verify_ssl:
                logger.warning("SSL verification disabled for foundational_rag. Use only in trusted environments.")

        return self


def _setup_backend(config: KnowledgeRetrievalConfig, summary_llm_obj=None) -> tuple[str, dict]:
    """
    Import the backend adapter and build its configuration.

    Importing the adapter module triggers the @register_retriever/@register_ingestor
    decorators, which register the adapter classes with the factory.

    Args:
        config: Knowledge retrieval configuration
        summary_llm_obj: Optional resolved LLM object for summarization

    Returns:
        Tuple of (backend_name, backend_config_dict)
    """
    backend = config.backend.lower()

    # Summary config: LLM object if resolved, else adapters use default NVIDIA model
    summary_config = {
        "generate_summary": config.generate_summary,
        "summary_llm": summary_llm_obj,
    }

    if backend == "llamaindex":
        import knowledge_layer.llamaindex.adapter  # noqa: F401

        os.environ.setdefault("AIQ_CHROMA_DIR", config.chroma_dir)
        backend_config = {
            "persist_dir": config.chroma_dir,
            **summary_config,
        }

    elif backend == "foundational_rag":
        import knowledge_layer.foundational_rag.adapter  # noqa: F401

        backend_config = {
            "rag_url": config.rag_url,
            "ingest_url": config.ingest_url,
            "timeout": config.timeout,
            "verify_ssl": config.verify_ssl,
            **summary_config,
        }

    else:
        raise ValueError(f"Unknown backend: {backend}. Use 'llamaindex' or 'foundational_rag'.")

    os.environ["KNOWLEDGE_RETRIEVER_BACKEND"] = backend
    os.environ["KNOWLEDGE_INGESTOR_BACKEND"] = backend

    return backend, backend_config


def _get_retriever(config: KnowledgeRetrievalConfig):
    """Get the retriever singleton from the factory."""
    from aiq_agent.knowledge.factory import get_retriever

    backend, backend_config = _setup_backend(config)
    retriever = get_retriever(backend, backend_config)
    logger.info("Initialized %s retriever", backend)
    return retriever


def _initialize_ingestor(config: KnowledgeRetrievalConfig, summary_llm_obj=None):
    """
    Initialize and activate the ingestor for the Knowledge API.

    Called during function registration to:
    1. Create the ingestor singleton via the factory
    2. Set it as the active ingestor for API routes to use

    Args:
        config: Knowledge retrieval configuration
        summary_llm_obj: Optional resolved LLM object for summarization
    """
    from aiq_agent.knowledge.factory import get_ingestor
    from aiq_agent.knowledge.factory import set_active_ingestor

    backend, backend_config = _setup_backend(config, summary_llm_obj)
    ingestor = get_ingestor(backend, backend_config)
    set_active_ingestor(ingestor)
    logger.info("Activated %s ingestor for Knowledge API", backend)
    return ingestor


_warned_legacy_fallback = False


def _normalize_session_collection_name(session_id: str | None) -> str | None:
    """Return the UI session collection name for a raw conversation ID."""
    if not session_id:
        return None
    from aiq_agent.knowledge.base import SESSION_COLLECTION_PREFIX

    if session_id.startswith(SESSION_COLLECTION_PREFIX):
        return session_id
    return f"{SESSION_COLLECTION_PREFIX}{session_id}"


def _resolve_base_collection(config: KnowledgeRetrievalConfig) -> str:
    """The base corpus collection for retrieval, country-profile-aware.

    Retrieval scope keys off the project country's ``CountryProfile.corpus_collection``
    rather than a hardcoded name — the RAG-side seam for country expansion. The
    country is read from the injected project context (``resolve_country``); an
    unknown country / missing profile falls back to the configured
    ``collection_name``.

    Behavior-neutral for Austria: its profile's ``corpus_collection`` IS the
    configured ``oib_knowledge``, so this returns the same name and never logs.
    A second country ships its own registry file naming its own corpus, and
    retrieval follows without a config change.

    Fail-open: any lookup problem keeps the configured ``collection_name``.
    """
    try:
        from aiq_agent.common.country_profile import DEFAULT_COUNTRY
        from aiq_agent.common.country_profile import get_country_profile
        from aiq_agent.common.norm_registry import resolve_country
        from aiq_agent.project_context import get_profile_context_from_context

        # Precedence: an EXPLICIT non-default config wins (test/bench/dev configs
        # pointing at e.g. `test_collection` must never be silently re-routed);
        # the profile only re-routes the default corpus, which is what a real
        # multi-country deployment runs on.
        default_profile = get_country_profile(DEFAULT_COUNTRY)
        default_corpus = default_profile.corpus_collection if default_profile else config.collection_name
        if config.collection_name != default_corpus:
            return config.collection_name
        country = resolve_country(get_profile_context_from_context())
        profile = get_country_profile(country)
        if profile is not None and profile.corpus_collection and profile.corpus_collection != config.collection_name:
            logger.debug(
                "Retrieval base collection from country profile '%s': %s (config collection_name: %s)",
                country,
                profile.corpus_collection,
                config.collection_name,
            )
            return profile.corpus_collection
    except Exception:  # noqa: BLE001 — profile routing must never break retrieval
        logger.debug("Country-profile base-collection resolution failed; using configured collection", exc_info=True)
    return config.collection_name


def _resolve_target_collections(
    config: KnowledgeRetrievalConfig, session_id: str | None, base_collection: str | None = None
) -> list[str]:
    """
    Build the ordered, de-duplicated set of collections to search.

    Layers (in order): base corpus, per-session collection, project collections.

    - When the ``X-Grid-Collection-Scope`` header is present via NAT context,
      it takes precedence and is returned directly regardless of legacy flags.
    - Legacy: when ``use_fixed_collection`` is True, only the base collection is
      searched (the session collection is ignored). This preserves
      backward-compatible pinned behavior.
    - Otherwise the search set is assembled from the enabled layers and
      de-duplicated while preserving order. If nothing is selected, fall back to
      the base collection.

    Args:
        config: Knowledge retrieval configuration.
        session_id: The resolved per-session collection name (conversation_id) or None.
        base_collection: The base corpus collection to use (country-profile-resolved
            by the caller). Defaults to ``config.collection_name`` when omitted.

    Returns:
        Ordered, de-duplicated list of collection names (never empty).
    """
    # Header-based collection scope takes precedence.
    try:
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context

        header_scope = get_collection_scope_from_context()
        if header_scope:
            return header_scope
    except ImportError:
        pass

    global _warned_legacy_fallback
    if not _warned_legacy_fallback:
        _warned_legacy_fallback = True
        logger.warning(
            "X-Grid-Collection-Scope header not present, falling back to legacy config-based collection resolution"
        )

    base = base_collection if base_collection is not None else config.collection_name

    if config.use_fixed_collection:
        # Legacy pinned behavior: base only, never the session collection.
        return [base]

    session_collection = _normalize_session_collection_name(session_id)

    targets: list[str] = []
    if config.include_base_collection and base:
        targets.append(base)
    if config.include_session_collection and session_collection:
        targets.append(session_collection)
    targets.extend(config.project_collections)

    # De-duplicate while preserving order.
    seen: set[str] = set()
    ordered: list[str] = []
    for name in targets:
        if name and name not in seen:
            seen.add(name)
            ordered.append(name)

    # Empty search set -> fall back to the base collection.
    if not ordered:
        return [base]
    return ordered


def _base_collection_filters(config: KnowledgeRetrievalConfig, caller_filters: dict | None) -> dict | None:
    """Base-collection metadata filter: configured file exclusions merged with caller filters.

    ``exclude_file_names`` becomes a ``file_name NOT IN [...]`` clause; the caller's
    optional ``filters`` dict is AND-ed with it. Applied to the base collection only
    (session/project collections are never filtered). Returns None when neither is set.
    """
    excluded = sorted(set(config.exclude_file_names))
    clauses: list[dict] = []
    if excluded:
        clauses.append({"file_name": {"$nin": excluded}})
    if caller_filters:
        clauses.append(caller_filters)

    if not clauses:
        return None
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def _merge_results(results, query: str, top_k: int, backend_name: str):
    """
    Merge per-collection retrieval results into a single scored result.

    Scores are comparable across collections (same embedding model, cosine [0,1]),
    so chunks from all successful layers are concatenated, sorted by score
    descending, and truncated to ``top_k``.

    Failed layers (``success=False``, e.g. a brand-new session whose collection
    does not exist yet) and raised exceptions are treated as empty contributions
    and skipped. This never raises.

    Args:
        results: List of RetrievalResult objects or Exceptions (from asyncio.gather).
        query: The original query string.
        top_k: Maximum number of merged chunks to return.
        backend_name: Fallback backend label if no successful result is available.

    Returns:
        A synthetic RetrievalResult with success=True and the merged top-k chunks.
    """
    from aiq_agent.knowledge.schema import RetrievalResult

    merged_chunks = []
    backend = backend_name
    for result in results:
        if isinstance(result, Exception):
            logger.debug("Knowledge layer raised, skipping: %s", result)
            continue
        if not getattr(result, "success", False):
            logger.debug(
                "Knowledge layer empty/failed, skipping: %s",
                getattr(result, "error_message", None),
            )
            continue
        if result.backend:
            backend = result.backend
        merged_chunks.extend(result.chunks)

    merged_chunks.sort(key=lambda chunk: chunk.score, reverse=True)
    merged_top_k = merged_chunks[:top_k]

    return RetrievalResult(success=True, chunks=merged_top_k, query=query, backend=backend)


def _trace_lanes_json(chunks) -> str:
    """Machine-readable lane fan-out for the chat Herleitung UI.

    One JSON object under a ``## Trace-Lanes`` marker so the frontend can group
    hits by stratum (OIB / Projekt / Büroarchiv / …) without re-deriving
    ``lane_for_hit``. Fail-open: never break tool output for the LLM.
    """
    try:
        import json
        from collections import OrderedDict

        from aiq_agent.common.norm_registry import lane_for_hit

        lanes: OrderedDict[str, dict] = OrderedDict()
        for chunk in chunks:
            metadata = chunk.metadata or {}
            collection = metadata.get("collection")
            doc_class = metadata.get("doc_class")
            key, label = lane_for_hit(doc_class=doc_class, file_name=chunk.file_name, collection=collection)
            bucket = lanes.get(key)
            if bucket is None:
                bucket = {"key": key, "label": label, "hitCount": 0, "sources": []}
                lanes[key] = bucket
            bucket["hitCount"] += 1
            name = chunk.file_name or ""
            detail = f"p.{chunk.page_number}" if chunk.page_number and chunk.page_number > 0 else None
            # Deduplicate identical name+detail pairs inside a lane.
            sig = (name, detail or "")
            existing = {(s.get("name"), s.get("detail") or "") for s in bucket["sources"]}
            if name and sig not in existing:
                entry: dict[str, str] = {"name": name}
                if detail:
                    entry["detail"] = detail
                bucket["sources"].append(entry)
        return json.dumps({"lanes": list(lanes.values())}, ensure_ascii=False)
    except Exception:
        logger.exception("Failed to build Trace-Lanes summary; omitting UI block metadata")
        return '{"lanes":[]}'


def _format_results(retrieval_result, query: str) -> str:
    """
    Format retrieval results for LLM consumption.

    Returns a structured string that provides context for the agent.
    The format includes explicit citation fields so the LLM knows exactly
    what to use in its References section.
    """
    # Check for retrieval errors and surface them to the agent
    if not retrieval_result.success:
        error_msg = retrieval_result.error_message or "Unknown error"
        return f"Knowledge retrieval failed: {error_msg}\n\nQuery: '{query}'"

    if not retrieval_result.chunks:
        return f"No relevant documents found for query: '{query}'"

    lines = [f"Found {len(retrieval_result.chunks)} relevant document(s):\n"]

    for i, chunk in enumerate(retrieval_result.chunks, 1):
        # Build citation string: "filename, p.X" or just "filename"
        if chunk.page_number and chunk.page_number > 0:
            citation = f"{chunk.file_name}, p.{chunk.page_number}"
        else:
            citation = chunk.file_name

        # Header with source info
        lines.append(f"--- Result {i} ---")
        lines.append(f"Source: {chunk.file_name}")
        collection = (chunk.metadata or {}).get("collection")
        if collection:
            lines.append(f"Collection: {collection}")
        # Explicit per-document classification ("Dokumentart"). Emit the machine
        # doc_class key first (the citation parser reads it) followed by the
        # German label so the LLM is told the document's role in the norm
        # hierarchy. Only present when the chunk metadata carries a doc_class.
        doc_class = (chunk.metadata or {}).get("doc_class")
        if doc_class:
            from aiq_agent.knowledge.document_classification import DOCUMENT_CLASS_LABELS

            label = DOCUMENT_CLASS_LABELS.get(doc_class, doc_class)
            lines.append(f"Dokumentart: {doc_class} — {label}")
        if chunk.page_number and chunk.page_number > 0:
            lines.append(f"Page: {chunk.page_number}")
        lines.append(f"Citation: {citation}")
        lines.append(f"Content Type: {chunk.content_type.value}")
        lines.append(f"Relevance Score: {chunk.score:.2f}")
        lines.append("")

        # Content (truncate if very long)
        content = chunk.content
        if len(content) > 1500:
            content = content[:1500] + "... [truncated]"
        lines.append(content)
        lines.append("")

    # Fan-out summary for the Herleitung UI (after chunk bodies so the LLM
    # still sees citations first; parsers look for the marker explicitly).
    lines.append("## Trace-Lanes")
    lines.append(_trace_lanes_json(retrieval_result.chunks))
    lines.append("")

    return "\n".join(lines)


@register_function(config_type=KnowledgeRetrievalConfig)
async def knowledge_retrieval(config: KnowledgeRetrievalConfig, _builder: Builder):
    """
    Knowledge retrieval function for searching ingested documents.

    This function provides semantic search over documents that have been
    previously ingested into the knowledge layer. It supports multiple
    backends (LlamaIndex, Foundational RAG) and returns formatted results
    suitable for LLM consumption.

    The retriever and ingestor are initialized once when the function is
    created and reused for all subsequent queries. The ingestor singleton
    is also made available to the Knowledge API routes via the factory.
    """
    # Resolve summary LLM if specified (enterprise approach)
    summary_llm_obj = None
    if config.summary_model and config.generate_summary:
        from aiq_agent.common import get_langchain_llm

        summary_llm_obj = await get_langchain_llm(_builder, config.summary_model)
        logger.info("Resolved summary model: %s", config.summary_model)

    # Initialize summary DB with configured URL
    from aiq_agent.knowledge.factory import configure_summary_db

    configure_summary_db(config.summary_db)

    # The admin-managed norm registry store shares the summary DB URL (one
    # knowledge database, no extra env var — see norm_store module docstring).
    # It seeds itself from the YAML registry and registers as norm_registry's
    # runtime source; fail-open, so a store error just keeps the YAML seed.
    from aiq_agent.knowledge.norm_store import configure_norm_store

    configure_norm_store(config.summary_db)

    retriever = _get_retriever(config)

    _initialize_ingestor(config, summary_llm_obj)

    collection = config.collection_name
    top_k = config.top_k

    logger.info(
        "Knowledge retrieval initialized: backend=%s, collection=%s, top_k=%d", config.backend, collection, top_k
    )

    async def search(query: str, filters: dict | None = None) -> str:
        """Search for documents relevant to the query.

        Args:
            query (str): Natural language query describing what information you need.
            filters (dict | None): Optional metadata filter applied to the base
                collection (e.g. {"content_type": "text"} or nested
                {"$and": [...]}/{"$or": [...]}). AND-ed with the configured
                exclude_file_names. Session/project collections are never filtered.

        Returns:
            str: Formatted string containing relevant document excerpts with citations.
        """
        # Resolve the per-session collection (UI uploads for this conversation).
        try:
            ctx = Context.get()
            session_collection = ctx.conversation_id if ctx else None
        except Exception:
            session_collection = None

        # Country-profile-resolved base corpus collection (behavior-neutral for
        # Austria; the seam that points retrieval at country #2's corpus).
        base_collection = _resolve_base_collection(config)

        # Build the ordered, de-duplicated layered search set.
        target_collections = _resolve_target_collections(config, session_collection, base_collection)

        logger.info(f"Knowledge search: query='{query[:100]}...' collections={target_collections}")

        async def _retrieve_collection(coll: str):
            # File exclusions + caller filters apply to the base collection only;
            # session/project collections are user content and are never filtered.
            coll_filters = _base_collection_filters(config, filters) if coll == base_collection else None
            result = await retriever.retrieve(query=query, collection_name=coll, top_k=top_k, filters=coll_filters)
            # Tag each chunk with its collection so the merge does not lose the
            # per-hit stratum — the trace UI's lane labels and source_lane read it.
            for chunk in getattr(result, "chunks", []) or []:
                chunk.metadata.setdefault("collection", coll)
            return result

        try:
            # Fan out across all layers concurrently; tolerate empty/missing layers.
            results = await asyncio.gather(
                *(_retrieve_collection(coll) for coll in target_collections),
                return_exceptions=True,
            )

            # Merge by score (comparable across collections) and truncate to top_k.
            merged = _merge_results(results, query, top_k, retriever.backend_name)

            # Format for LLM
            formatted = _format_results(merged, query)
            logger.info(f"Knowledge search returned {len(merged.chunks)} chunks")
            # Debug: Log what we're returning to the LLM
            logger.debug(f"Formatted result for LLM:\n{formatted[:500]}...")
            return formatted

        except Exception as e:
            logger.error(f"Knowledge search failed: {e}")
            return f"Error searching knowledge base: {str(e)}"

    # Yield the function info for NAT registration
    yield FunctionInfo.from_fn(
        search,
        description=(
            "Search the knowledge base for relevant documents. "
            "Use this to find information from ingested PDFs, documents, and other files. "
            f"Returns up to {top_k} relevant excerpts with citations."
        ),
    )
