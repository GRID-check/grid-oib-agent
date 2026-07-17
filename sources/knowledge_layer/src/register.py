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

try:  # Norm registry (Phase 2): default norm filters for the base corpus
    from aiq_agent.common.norm_registry import default_norm_filters as _default_norm_filters
    from aiq_agent.common.norm_registry import load_registry as _load_norm_registry
    from aiq_agent.common.norm_registry import resolve_bundesland as _resolve_norm_bundesland
except Exception:  # pragma: no cover - registry is optional
    _default_norm_filters = None
    _load_norm_registry = None
    _resolve_norm_bundesland = None


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
            "Always include the configured base collection_name in the search set "
            "(e.g. the fixed OIB corpus)."
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
            "Additional named persistent collections (e.g. project-scoped corpora) to always "
            "include in the search set."
        ),
    )
    top_k: int = Field(default=5, description="Number of results to return")
    exclude_file_names: list[str] = Field(
        default_factory=list,
        description=(
            "File names whose chunks are excluded from results of the base collection "
            "(e.g. OIB Änderungsdokumente and superseded editions). Applied as a "
            "metadata filter (file_name NOT IN ...). Phase-0 default-exclusion "
            "mechanism; superseded by role/edition metadata filters once corpus "
            "chunks are stamped with doc metadata."
        ),
    )
    parent_expansion: bool = Field(
        default=True,
        description=(
            "When a base-corpus hit carries norm metadata (doc_id/edition/punkt), fetch the "
            "sibling chunks of the same Punkt and present the merged parent text instead of "
            "the isolated fragment. Base collection only."
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


def _default_corpus_resolver():
    """Norm-registry corpus resolver for the ingestor (fail-open when unavailable)."""
    try:
        from aiq_agent.knowledge.corpus import registry_corpus_resolver
    except Exception:
        return None
    return registry_corpus_resolver()


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
            "corpus_resolver": _default_corpus_resolver(),
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


def _resolve_target_collections(config: KnowledgeRetrievalConfig, session_id: str | None) -> list[str]:
    """
    Build the ordered, de-duplicated set of collections to search.

    Layers (in order): base corpus, per-session collection, project collections.

    - When the ``X-Grid-Collection-Scope`` header is present via NAT context,
      it takes precedence and is returned directly regardless of legacy flags.
    - Legacy: when ``use_fixed_collection`` is True, only the configured base
      ``collection_name`` is searched (the session collection is ignored). This
      preserves backward-compatible pinned behavior.
    - Otherwise the search set is assembled from the enabled layers and
      de-duplicated while preserving order. If nothing is selected, fall back to
      the base ``collection_name``.

    Args:
        config: Knowledge retrieval configuration.
        session_id: The resolved per-session collection name (conversation_id) or None.

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
            "X-Grid-Collection-Scope header not present, "
            "falling back to legacy config-based collection resolution"
        )

    if config.use_fixed_collection:
        # Legacy pinned behavior: base only, never the session collection.
        return [config.collection_name]

    session_collection = _normalize_session_collection_name(session_id)

    targets: list[str] = []
    if config.include_base_collection and config.collection_name:
        targets.append(config.collection_name)
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

    # Empty search set -> fall back to the configured base collection.
    if not ordered:
        return [config.collection_name]
    return ordered


_PARENT_EXPANSION_TOP_K = 50
_EXPANDED_TRUNCATION = 8000
_REGULAR_TRUNCATION = 1500


def _base_collection_filters(config: KnowledgeRetrievalConfig, caller_filters: dict | None) -> dict | None:
    """Merge Phase-0 file exclusions with the registry-derived default norm filter.

    Caller-supplied filters override the registry-derived default (spec §5.1);
    ``exclude_file_names`` is explicit operator config and always applies.
    Returns None when no clause applies. Never raises (registry load is fail-open).
    """
    excluded = sorted(set(config.exclude_file_names))
    clauses: list[dict] = []
    if excluded:
        clauses.append({"file_name": {"$nin": excluded}})

    effective = caller_filters
    if effective is None and _default_norm_filters is not None and _load_norm_registry is not None:
        try:
            bundesland = _resolve_norm_bundesland("") if _resolve_norm_bundesland else None
            effective = _default_norm_filters(_load_norm_registry(), bundesland)
        except Exception:
            logger.warning("Norm registry default filters unavailable; searching without them", exc_info=True)
    if effective:
        clauses.append(effective)

    if not clauses:
        return None
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


def _norm_parent_key(metadata: dict | None) -> tuple[str, str, str] | None:
    """Return the (doc_id, edition, punkt) parent key for a norm chunk, else None."""
    if not metadata:
        return None
    doc_id = metadata.get("doc_id")
    edition = metadata.get("edition")
    punkt = metadata.get("punkt")
    if doc_id and edition and punkt:
        return (doc_id, edition, punkt)
    return None


def _strip_known_prefix(text: str, metadata: dict) -> tuple[str, str]:
    """Split a corpus chunk into its deterministic context prefix and body."""
    prefix = (
        f"{metadata.get('doc_short')} - {metadata.get('doc_title')} "
        f"({metadata.get('edition_label')}), Pkt {metadata.get('punkt')}, {metadata.get('role')}\n"
    )
    if text.startswith(prefix):
        return prefix, text[len(prefix) :]
    return "", text


def _build_parent_content(siblings: list, max_chars: int = _EXPANDED_TRUNCATION) -> str:
    """Join sibling chunks of one Punkt in chunk_index order under a single context prefix."""
    ordered = sorted(siblings, key=lambda c: (getattr(c, "metadata", None) or {}).get("chunk_index", 0))
    prefix = ""
    bodies: list[str] = []
    for chunk in ordered:
        chunk_prefix, body = _strip_known_prefix(chunk.content or "", getattr(chunk, "metadata", None) or {})
        if chunk_prefix and not prefix:
            prefix = chunk_prefix
        if body:
            bodies.append(body)
    joined = prefix + "\n\n".join(bodies)
    if len(joined) > max_chars:
        return joined[:max_chars] + "… [truncated]"
    return joined


def _expand_norm_parents(chunks: list, siblings_by_key: dict, max_chars: int = _EXPANDED_TRUNCATION) -> list:
    """Collapse each norm-parent group to its highest-score member with joined sibling text.

    Chunks without a (doc_id, edition, punkt) key, or whose key has no fetched
    siblings, pass through untouched. Group representatives are marked with
    ``metadata['_expanded'] = True``.
    """
    groups: dict[tuple[str, str, str], list[int]] = {}
    for idx, chunk in enumerate(chunks):
        key = _norm_parent_key(getattr(chunk, "metadata", None))
        if key is not None and key in siblings_by_key:
            groups.setdefault(key, []).append(idx)
    if not groups:
        return chunks

    reps = {key: max(idxs, key=lambda i: chunks[i].score) for key, idxs in groups.items()}
    out = []
    for idx, chunk in enumerate(chunks):
        key = _norm_parent_key(getattr(chunk, "metadata", None))
        if key is None or key not in reps:
            out.append(chunk)
            continue
        if idx != reps[key]:
            continue
        content = _build_parent_content(siblings_by_key[key], max_chars=max_chars)
        out.append(chunk.model_copy(update={"content": content, "metadata": {**chunk.metadata, "_expanded": True}}))
    return out


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
        meta = chunk.metadata or {}

        # Build citation string: registry-derived "OIB-RL 2, Pkt 3.1.2, <edition>" for
        # norm chunks; "filename, p.X" or just "filename" otherwise.
        if meta.get("doc_short") and meta.get("punkt"):
            edition = meta.get("edition_label") or meta.get("edition") or ""
            citation = f"{meta['doc_short']}, Pkt {meta['punkt']}, {edition}".rstrip(", ")
        elif chunk.page_number and chunk.page_number > 0:
            citation = f"{chunk.file_name}, p.{chunk.page_number}"
        else:
            citation = chunk.file_name

        # Header with source info
        lines.append(f"--- Result {i} ---")
        lines.append(f"Source: {chunk.file_name}")
        if chunk.page_number and chunk.page_number > 0:
            lines.append(f"Page: {chunk.page_number}")
        lines.append(f"Citation: {citation}")
        if meta.get("rank") or meta.get("role"):
            stratum = " · ".join(str(p) for p in (meta.get("rank"), meta.get("role"), meta.get("edition_label")) if p)
            lines.append(f"Stratum: {stratum}")
        lines.append(f"Content Type: {chunk.content_type.value}")
        lines.append(f"Relevance Score: {chunk.score:.2f}")
        lines.append("")

        # Content (expanded parent chunks get the higher cap)
        cap = _EXPANDED_TRUNCATION if meta.get("_expanded") else _REGULAR_TRUNCATION
        content = chunk.content
        if len(content) > cap:
            content = content[:cap] + "... [truncated]"
        lines.append(content)
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
            filters (dict | None): Optional metadata filter for the base norm corpus
                (e.g. {"role": "normativ"} or nested {"$and": [...]}/{"$or": [...]}).
                Overrides the registry-derived default filter (which excludes
                role:diff and superseded editions); configured exclude_file_names
                still apply. Session/project collections are never filtered.

        Returns:
            str: Formatted string containing relevant document excerpts with citations.
        """
        # Resolve the per-session collection (UI uploads for this conversation).
        try:
            ctx = Context.get()
            session_collection = ctx.conversation_id if ctx else None
        except Exception:
            session_collection = None

        # Build the ordered, de-duplicated layered search set.
        target_collections = _resolve_target_collections(config, session_collection)

        logger.info(f"Knowledge search: query='{query[:100]}...' collections={target_collections}")

        async def _expand_base_result(result, coll: str):
            """Parent expansion (spec §5.2): merge hits of one Punkt into the full parent text."""
            if not getattr(result, "success", False) or not result.chunks:
                return result
            keys = {key for c in result.chunks if (key := _norm_parent_key(c.metadata))}
            if not keys:
                return result
            siblings_by_key = {}
            for doc_id, edition, punkt in keys:
                try:
                    sib = await retriever.retrieve(
                        query=query,
                        collection_name=coll,
                        top_k=_PARENT_EXPANSION_TOP_K,
                        filters={"doc_id": doc_id, "edition": edition, "punkt": punkt},
                    )
                except Exception:
                    logger.debug("Parent expansion fetch failed for %s/%s/%s", doc_id, edition, punkt)
                    continue
                if getattr(sib, "success", False) and sib.chunks:
                    siblings_by_key[(doc_id, edition, punkt)] = sib.chunks
            if not siblings_by_key:
                return result
            result.chunks = _expand_norm_parents(result.chunks, siblings_by_key)
            return result

        async def _retrieve_collection(coll: str):
            # Default norm filters + Phase-0 exclusions apply to the base corpus only;
            # session/project collections are user content.
            coll_filters = _base_collection_filters(config, filters) if coll == config.collection_name else None
            result = await retriever.retrieve(query=query, collection_name=coll, top_k=top_k, filters=coll_filters)
            if config.parent_expansion and coll == config.collection_name:
                result = await _expand_base_result(result, coll)
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
