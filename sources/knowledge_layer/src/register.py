"""NAT function for knowledge retrieval.

This function provides direct library access to the knowledge layer,
allowing agents to search ingested documents without an external API server.

The retriever is instantiated once and reused for all queries.
"""

import asyncio
import logging
import os
from contextlib import suppress
from typing import Literal

from pydantic import Field
from pydantic import model_validator

from nat.builder.builder import Builder
from nat.builder.context import Context
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

# Chunk content truncation. OIB tables routinely exceed 1500 chars and were cut
# mid-table, losing rows the LLM needs to quote. Set to 2500 to keep most table
# rows intact within one chunk. Value chosen as a named constant (#no-magic).
_CHUNK_TRUNCATE_CHARS = 2500

# Diversity-aware merge caps how many chunks per document are taken in the
# first pass before spreading to other documents. The cap is soft: with
# max_per_document=2 and top_k=8 the first pass covers >=4 documents, and the
# fill pass exceeds the cap rather than returning fewer than top_k chunks.
_MAX_CHUNKS_PER_DOC = 2

# Retrieval over-fetch factor applied when the caller narrows results with the
# agentic filters (doc_class / title_contains / file_name): post-merge
# filtering drops candidates, so each layer fetches 3x top_k to leave enough
# survivors.
_AGENT_FILTER_OVERFETCH = 3

# Agent-facing contract. Distinct from ``surface_documents`` (show a file).
# Anthropic: descriptions are the prompt — say when to call, when not to,
# how to name parameters, and what a miss means. Do not chain this tool
# with surface_documents; citations already peek the cited project file.
_KNOWLEDGE_SEARCH_DESCRIPTION = (
    "Read and cite passages from the ingested knowledge base (OIB corpus, "
    "this project's files, the Büroarchiv). This is the evidence tool — it "
    "returns quotable excerpts with a Citation key. It does not open a file "
    "in the UI.\n"
    "WHEN TO CALL — any question that needs a passage from a stored document. "
    "If the user named a file and asked what it says, pass `file_name=` that "
    "exact indexed name (from the inventory or the user). Narrow with "
    "`doc_class=` (Dokumentart key, e.g. oib_richtlinie) or `title_contains=` "
    "when you already know the class or a title fragment.\n"
    "WHEN NOT TO CALL — to put a file on screen (the user asked to SEE or "
    "BROWSE files, no legal question): that is `surface_documents`. After "
    "you cite a project or Büroarchiv file, do not also call "
    "`surface_documents`; the UI peeks the cited file. Live Austrian law "
    "(statutes, Bauordnungen) is the RIS tools, not this index.\n"
    "HOW TO QUERY — rewrite the user question into a search query (topic + "
    "jurisdiction + implied year). Prefer one precise call over a broad dump. "
    "At most 2 calls; change the query on the second. Never invent a "
    "`file_name`; take it from the inventory or the user. Do not pass a raw "
    "`filters` object unless you need `content_type`.\n"
    "RETURNS — numbered passages with Source, Citation (copy this key "
    "verbatim), Dokumentart, page, and the passage. Cite only those keys. "
    "An empty result tells you how to retry (narrower query, `file_name`, "
    "`title_contains`); it is not permission to invent a citation."
)

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
    max_chunks_per_document: int = Field(
        default=2,
        ge=0,
        description=(
            "Diversity cap: at most this many chunks from a single document are included before "
            "other documents get a slot; any remaining slots up to top_k are then filled with the "
            "highest-scoring chunks regardless of source. Prevents one high-scoring PDF from "
            "crowding out other documents on cross-cutting questions. 0 disables the cap."
        ),
    )
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
    hybrid_search: bool | None = Field(
        default=None,
        description=(
            "Enable lexical+vector hybrid retrieval on the LlamaIndex backend (exact-term "
            "Chroma $contains passes fused with vector results via reciprocal rank fusion). "
            "None = environment default AIQ_HYBRID_RETRIEVAL (on)."
        ),
    )
    rerank_llm: str | None = Field(
        default=None,
        description=(
            "Optional LLM reference from llms: section used to re-rank retrieved chunks "
            "against the query (LLM-judge reranking; fail-open to the original order)."
        ),
    )
    reranker_provider: str | None = Field(
        default=None,
        description=(
            "Cross-encoder reranking provider (none|openrouter|cohere|voyage|jina|nvidia). "
            "None falls back to the AIQ_RERANKER_PROVIDER environment default, which is "
            "'none'. When one resolves it becomes the primary reranker and rerank_llm "
            "becomes the fallback; a missing key or any provider error degrades to the judge."
        ),
    )
    reranker_model: str | None = Field(
        default=None,
        description="Cross-encoder model id. None uses the provider's multilingual default.",
    )
    rerank_candidates: int = Field(
        default=15,
        ge=1,
        description=(
            "How many candidate chunks to over-fetch and re-rank when rerank_llm is set. "
            "Reranking converts recall into precision, so this should exceed top_k by "
            "several times, not by a margin. Must be >= 1: zero used to be accepted and "
            "trimmed every search to nothing."
        ),
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
        backend_config: dict = {
            "persist_dir": config.chroma_dir,
            **summary_config,
        }
        if config.hybrid_search is not None:
            backend_config["hybrid_search"] = config.hybrid_search

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


def _resolve_scoped_collections(
    config: KnowledgeRetrievalConfig, session_id: str | None, base_collection: str | None = None
):
    """
    Build the ordered, de-duplicated set of collections to search, WITH shelves.

    Layers (in order): base corpus, per-session collection, project collections.

    - When the ``X-Grid-Collection-Scope`` header is present via NAT context,
      it takes precedence and is returned directly regardless of legacy flags.
      Its entries carry the shelf the BFF stated (ADR-0047); a legacy
      bare-string entry states none, and that is left UNKNOWN rather than
      guessed back from the collection id.
    - Legacy: when ``use_fixed_collection`` is True, only the base collection is
      searched (the session collection is ignored). This preserves
      backward-compatible pinned behavior.
    - Otherwise the search set is assembled from the enabled layers and
      de-duplicated while preserving order. If nothing is selected, fall back to
      the base collection.

    In the legacy path the shelf is not inferred either: this function BUILDS the
    layers, so it knows which is the base corpus, which is the session store and
    which are project stores, and simply states it.

    Args:
        config: Knowledge retrieval configuration.
        session_id: The resolved per-session collection name (conversation_id) or None.
        base_collection: The base corpus collection to use (country-profile-resolved
            by the caller). Defaults to ``config.collection_name`` when omitted.

    Returns:
        Ordered, de-duplicated list of ``ScopedCollection`` (never empty).
    """
    from aiq_agent.common.source_kinds import Shelf
    from aiq_agent.knowledge.scoping import ScopedCollection

    # Header-based collection scope takes precedence.
    try:
        from aiq_agent.knowledge.scoping import get_scoped_collections_from_context

        header_scope = get_scoped_collections_from_context()
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
        return [ScopedCollection(base, Shelf.BASE)]

    session_collection = _normalize_session_collection_name(session_id)

    targets: list[ScopedCollection] = []
    if config.include_base_collection and base:
        targets.append(ScopedCollection(base, Shelf.BASE))
    if config.include_session_collection and session_collection:
        targets.append(ScopedCollection(session_collection, Shelf.SESSION))
    targets.extend(ScopedCollection(name, Shelf.PROJECT) for name in config.project_collections)

    # De-duplicate while preserving order.
    seen: set[str] = set()
    ordered: list[ScopedCollection] = []
    for entry in targets:
        if entry.collection and entry.collection not in seen:
            seen.add(entry.collection)
            ordered.append(entry)

    # Empty search set -> fall back to the base collection.
    if not ordered:
        return [ScopedCollection(base, Shelf.BASE)]
    return ordered


def _shelf_name(entry) -> str | None:
    shelf = getattr(entry, "shelf", None)
    if shelf is None:
        return None
    return getattr(shelf, "value", None) or str(shelf)


def _restrict_scope_to_turn(entries):
    """Subtract corpora the composer did not ask for.

    The signed header is the authorization ceiling. Turn intent
    (``focus_shelf`` / ``source_preset``, mapped by ``shelves_for_turn``)
    may only drop entries from it, so a "summarize this upload" turn cannot
    be padded with Archiv hits (#429) and a Projektunterlagen chip cannot
    keep searching the Büroarchiv (#436).
    """
    try:
        from aiq_agent.common.focus_file import get_turn_shelves

        allowed = get_turn_shelves()
    except Exception:
        allowed = None
    if not allowed:
        return entries
    filtered = [entry for entry in entries if _shelf_name(entry) in allowed or _shelf_name(entry) is None]
    return filtered if filtered else entries


def _resolve_target_collections(
    config: KnowledgeRetrievalConfig, session_id: str | None, base_collection: str | None = None
) -> list[str]:
    """Names-only projection of :func:`_resolve_scoped_collections`.

    Returns:
        Ordered, de-duplicated list of collection names (never empty).
    """
    return [entry.collection for entry in _resolve_scoped_collections(config, session_id, base_collection)]


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


def _rank_channel(chunks) -> list:
    """Lay one collection's hits out so that list position IS the per-collection rank.

    ``fuse_with_ranks`` reads a chunk's rank from its position, while the adapter states
    a hit's rank in ``retrieval_rank`` (stamped after the intra-collection lexical
    fusion, so it is the collection's final order, not the raw vector order). Positions
    a stamped rank has vacated are padded with ``None``, which the fuser skips because it
    carries no ``chunk_id``: a collection whose rank 3 was dropped upstream keeps rank 4
    at rank 4 instead of silently promoting it.

    Chunks with no stamped rank (SimpleNamespace test doubles, the foundational_rag
    backend, anything predating the field) fall back to their position in the list, which
    is the order the retriever returned them in — so an unstamped layer behaves exactly
    as it did before the field existed.
    """
    by_rank: dict[int, object] = {}
    for position, chunk in enumerate(chunks):
        rank = getattr(chunk, "retrieval_rank", None)
        if not isinstance(rank, int) or isinstance(rank, bool) or rank < 0:
            rank = position
        # A duplicated or colliding rank must never evict a hit; push it to the next free
        # slot so both survive and their relative order is preserved.
        while rank in by_rank:
            rank += 1
        by_rank[rank] = chunk
    if not by_rank:
        return []
    return [by_rank.get(rank) for rank in range(max(by_rank) + 1)]


def _apply_diversity_cap(ordered, top_k: int, max_per_document: int) -> list:
    """Select ``top_k`` chunks from a ranked list, spreading across distinct documents.

    The cap is SOFT, which is what both the docstring it replaces and the LLM-facing tool
    description have always promised: at most ``max_per_document`` chunks per distinct
    document (keyed by collection + file_name) *where possible*, and the cap is exceeded
    rather than returning fewer than ``top_k`` chunks.

    The first pass is bounded at ``top_k`` selections. The previous inline version scanned
    the ENTIRE merged list, so ``selected`` was already longer than ``top_k`` under any
    production config and ``(selected + leftovers)[:top_k]`` reduced to ``selected[:top_k]``
    — the fill pass was unreachable and the quota was hard. Worse, appending the deferred
    chunks after every selected one meant a downstream ``[:top_k]`` trim saw a list whose
    head had been rebuilt out of low-ranked chunks: on a single-topic query it swapped
    seven on-topic hits for seven off-topic ones from other documents.

    The result is returned in rank order, i.e. as a subsequence of ``ordered``. Selection
    order was not monotone in the ranking key it was selected by, which is what made the
    downstream trim lossy.

    Args:
        ordered: Chunks in final rank order, best first.
        top_k: Maximum number of chunks to return.
        max_per_document: Per-document cap for the first pass; ``0`` disables diversity
            entirely, making this a plain top-k truncation.

    Returns:
        At most ``top_k`` chunks, in the same relative order as ``ordered``.
    """
    if max_per_document <= 0 or top_k <= 0:
        return list(ordered[:top_k])

    selected: list[int] = []
    deferred: list[int] = []
    per_doc: dict[tuple, int] = {}
    for index, chunk in enumerate(ordered):
        if len(selected) >= top_k:
            # Bounded first pass: once the slate is full, everything left is a fill
            # candidate. Nothing below this point is a cap decision.
            deferred.append(index)
            continue
        doc_key = ((getattr(chunk, "metadata", None) or {}).get("collection"), getattr(chunk, "file_name", None))
        if per_doc.get(doc_key, 0) < max_per_document:
            per_doc[doc_key] = per_doc.get(doc_key, 0) + 1
            selected.append(index)
        else:
            deferred.append(index)

    # Soft quota: when there are not enough distinct documents to fill the slate, the
    # chunks the cap deferred come back, best rank first.
    for index in deferred:
        if len(selected) >= top_k:
            break
        selected.append(index)

    return [ordered[index] for index in sorted(selected)]


def _merge_results(results, query: str, top_k: int, backend_name: str, max_per_document: int = _MAX_CHUNKS_PER_DOC):
    """
    Merge per-collection retrieval results into one ranked result by rank fusion.

    Chunks are NOT comparable by score across collections. ``Chunk.score`` is a true
    cosine similarity, but the professionally chunked base corpus sits in a systematically
    better distance band than a session or project collection, so a user's own uploaded
    PDF can never win on raw score and "layered retrieval" does not layer. Each surviving
    collection therefore contributes one RRF channel (in ``target_collections`` order, so
    the base corpus wins exact ties) and the merged order is the fused rank — scale-free
    by construction, so a session hit at rank 0 can outrank a corpus hit at rank 5.

    Selection over that fused order is diversity-aware; see ``_apply_diversity_cap``. With
    a single collection and ``max_per_document=0`` this is identical to a plain top-k
    truncation of that collection's own order.

    ``chunk.score`` is never mutated: ``_format_results`` keeps displaying the true
    similarity. The fusion score is recorded on ``chunk.fusion_score`` for diagnostics.

    Failed layers (``success=False``, e.g. a brand-new session whose collection
    does not exist yet) and raised exceptions are treated as empty contributions
    and skipped. This never raises.

    Args:
        results: List of RetrievalResult objects or Exceptions (from asyncio.gather),
            in ``target_collections`` order.
        query: The original query string.
        top_k: Maximum number of merged chunks to return.
        backend_name: Fallback backend label if no successful result is available.
        max_per_document: Diversity cap per distinct document on the first pass.

    Returns:
        A synthetic RetrievalResult with success=True and the merged top-k chunks.
    """
    from aiq_agent.knowledge.schema import RetrievalResult

    channels: list[list] = []
    backend = backend_name
    for result in results:
        if isinstance(result, Exception):
            logger.debug("Knowledge layer raised, skipping: %s", result)
            continue
        if not getattr(result, "success", False):
            # A missing collection is routine — every new conversation's session
            # collection does not exist until something is uploaded into it, so
            # logging that at WARNING would bury the signal under one line per turn.
            # Everything else is not routine: a corpus that dropped out because Chroma
            # was unreachable, a collection deleted and recreated, or a filter that
            # failed to translate all produced a confident answer built on an empty
            # knowledge layer with nothing above DEBUG to say so.
            message = getattr(result, "error_message", None) or ""
            if "not found" in message.lower():
                logger.debug("Knowledge layer absent, skipping: %s", message)
            else:
                logger.warning("Knowledge layer failed, skipping: %s", message)
            continue
        if result.backend:
            backend = result.backend
        # One channel per SURVIVING collection, in arrival order. Skipped layers must not
        # leave an empty channel behind: an empty channel is harmless to RRF but a
        # non-empty one from a later collection would shift into the tie-break seat.
        channels.append(_rank_channel(result.chunks))

    merged_chunks = []
    for chunk, _fused_rank, fused_score in _fuse_channels(channels):
        with suppress(Exception):
            # Diagnostic only. Never displayed; `score` stays the true cosine so the
            # "Relevance Score:" line keeps meaning what citation parsing expects.
            chunk.fusion_score = fused_score
        merged_chunks.append(chunk)

    try:
        from aiq_agent.common.focus_file import get_focused_file_name
        from aiq_agent.common.focus_file import get_focused_shelf

        focused = get_focused_file_name()
        focused_shelf = get_focused_shelf()
    except Exception:
        focused = None
        focused_shelf = None
    if focused:

        def _is_focus(chunk) -> bool:
            if (chunk.file_name or "") != focused:
                return False
            if not focused_shelf:
                return True
            return (chunk.metadata or {}).get("shelf") == focused_shelf

        matching = [chunk for chunk in merged_chunks if _is_focus(chunk)]
        # Matches are the turn. Filling the rest from Archiv/project is how
        # "summarize this PDF" grew a Büro plan (#429).
        merged_chunks = matching if matching else merged_chunks

    merged_top_k = _apply_diversity_cap(merged_chunks, top_k, max_per_document)

    return RetrievalResult(success=True, chunks=merged_top_k, query=query, backend=backend)


def _fuse_channels(channels: list[list]) -> list[tuple]:
    """Reciprocal-rank-fuse per-collection channels, failing open to concatenation.

    The fusion helper lives in the llamaindex package, so it is imported lazily and
    defensively: ``_merge_results`` is called on ``asyncio.gather(..., return_exceptions=True)``
    output and must never raise, and a deployment running the foundational_rag backend
    without the llamaindex extra must degrade to the (still collection-ordered)
    concatenation rather than losing the whole search.
    """
    try:
        from knowledge_layer.llamaindex.hybrid import fuse_with_ranks

        return fuse_with_ranks(channels)
    except Exception as exc:  # pragma: no cover - import/fusion failure is fail-open
        logger.warning("Cross-collection rank fusion unavailable, using collection order: %s", exc)
        flat = [chunk for channel in channels for chunk in channel if chunk is not None]
        return [(chunk, rank, 0.0) for rank, chunk in enumerate(flat)]


def _resolve_doc_classes(chunks) -> dict[tuple[str, str], str]:
    """Resolve the authoritative ``doc_class`` for each hit's document.

    The summary store is the source of truth for ``doc_class`` at retrieval time
    (see the Phase B design decision); chunk metadata is only a fallback for
    standalone deployments that ship no summary DB. This builds a
    ``(collection, file_name) -> stored doc_class`` map by looking each distinct
    document up once via the factory. Fail-open: any store error (or missing
    store) yields an empty/partial map and callers fall back to chunk metadata.
    """
    resolved: dict[tuple[str, str], str] = {}
    try:
        from aiq_agent.knowledge.factory import get_document_doc_classes
    except Exception:
        return resolved

    # Group the distinct documents by collection so each collection needs a
    # single batched query (there are only 1-3 in scope: base + session +
    # project) instead of one round-trip per hit.
    by_collection: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()
    for chunk in chunks:
        collection = (chunk.metadata or {}).get("collection")
        file_name = chunk.file_name
        if not collection or not file_name:
            continue
        key = (collection, file_name)
        if key in seen:
            continue
        seen.add(key)
        by_collection.setdefault(collection, []).append(file_name)

    for collection, file_names in by_collection.items():
        # Fail open per collection: one collection's error yields an empty map
        # for it (callers fall back to chunk metadata), never a total failure.
        try:
            stored_map = get_document_doc_classes(collection, file_names)
        except Exception:
            stored_map = {}
        for file_name, stored in stored_map.items():
            if stored:
                resolved[(collection, file_name)] = stored
    return resolved


def _hit_doc_class(chunk, resolved: dict[tuple[str, str], str]) -> str | None:
    """Authoritative ``doc_class`` for a single hit: stored value wins.

    Prefers the store-resolved value (:func:`_resolve_doc_classes`) over the
    ``doc_class`` stamped into chunk metadata at ingestion time, falling back to
    the chunk metadata when the store has no value for the document.
    """
    metadata = chunk.metadata or {}
    collection = metadata.get("collection")
    if collection and chunk.file_name:
        stored = resolved.get((collection, chunk.file_name))
        if stored:
            return stored
    return metadata.get("doc_class")


def _resolve_display_titles(chunks) -> dict[tuple[str, str], str]:
    """Resolve the stored ``display_title`` for each hit's document (batched).

    Mirrors :func:`_resolve_doc_classes`: the document_metadata store is the
    source of truth for the user-facing name. Builds a ``(collection, file_name)
    -> stored display_title`` map with one batched query per in-scope collection.
    Fail-open: any store error yields an empty/partial map and callers fall back
    to the derived default (:func:`~aiq_agent.common.norm_registry.guess_display_title`).
    """
    resolved: dict[tuple[str, str], str] = {}
    try:
        from aiq_agent.knowledge.factory import get_document_display_titles
    except Exception:
        return resolved

    by_collection: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()
    for chunk in chunks:
        collection = (chunk.metadata or {}).get("collection")
        file_name = chunk.file_name
        if not collection or not file_name:
            continue
        key = (collection, file_name)
        if key in seen:
            continue
        seen.add(key)
        by_collection.setdefault(collection, []).append(file_name)

    for collection, file_names in by_collection.items():
        try:
            stored_map = get_document_display_titles(collection, file_names)
        except Exception:
            stored_map = {}
        for file_name, stored in stored_map.items():
            if stored:
                resolved[(collection, file_name)] = stored
    return resolved


def _hit_display_title(chunk, resolved: dict[tuple[str, str], str]) -> str | None:
    """User-facing document name for a single hit: stored override wins.

    Precedence: the admin-editable stored ``display_title`` (source of truth) →
    the deterministic default derived from the OIB filename convention
    (:func:`~aiq_agent.common.norm_registry.guess_display_title`) → ``None`` for a
    document with neither (e.g. a project upload), where the caller keeps the raw
    filename because that IS the user-meaningful name for their own files.
    """
    metadata = chunk.metadata or {}
    collection = metadata.get("collection")
    if collection and chunk.file_name:
        stored = resolved.get((collection, chunk.file_name))
        if stored:
            return stored
    if chunk.file_name:
        try:
            from aiq_agent.common.norm_registry import guess_display_title

            return guess_display_title(chunk.file_name)
        except Exception:
            return None
    return None


def _file_name_matches(chunk_name: str | None, requested: str) -> bool:
    """True when a hit is the file the agent named.

    Exact (case-insensitive) first; then either name contains the other so
    ``Brandschutzplan.pdf`` matches ``Brandschutzplan_EG.pdf``. Display titles
    are ``title_contains``'s job — this is the indexed name.
    """
    have = (chunk_name or "").strip().casefold()
    want = (requested or "").strip().casefold()
    if not have or not want:
        return False
    return have == want or want in have or have in want


def _apply_agent_filters(
    chunks,
    doc_class: str | None,
    title_contains: str | None,
    file_name: str | None = None,
) -> list:
    """Narrow a merged candidate list by the agent-supplied filters.

    Filters run post-merge so they apply uniformly across every collection
    layer (base, session, project). ``doc_class`` uses the same store-authoritative
    resolution as the Dokumentart line (:func:`_hit_doc_class`), so a platform-owner
    reclassification takes effect without re-ingest. ``title_contains`` matches the
    raw file name OR the resolved display title, case-insensitively. ``file_name``
    matches the indexed name only — the agent already has a name.
    """
    resolved_classes = _resolve_doc_classes(chunks) if doc_class else {}
    resolved_titles = _resolve_display_titles(chunks) if title_contains else {}
    needle = title_contains.casefold() if title_contains else None
    requested_name = (file_name or "").strip() or None
    kept = []
    for chunk in chunks:
        if doc_class and _hit_doc_class(chunk, resolved_classes) != doc_class:
            continue
        if requested_name and not _file_name_matches(chunk.file_name, requested_name):
            continue
        if needle:
            haystacks = [chunk.file_name or ""]
            title = _hit_display_title(chunk, resolved_titles)
            if title:
                haystacks.append(title)
            if not any(needle in hay.casefold() for hay in haystacks):
                continue
        kept.append(chunk)
    return kept


def _empty_search_message(
    query: str,
    *,
    file_name: str | None = None,
    doc_class: str | None = None,
    title_contains: str | None = None,
) -> str:
    """Steer a miss toward a more specific next call, not a invented citation."""
    bits = [f"query={query!r}"]
    if file_name:
        bits.append(f"file_name={file_name!r}")
    if doc_class:
        bits.append(f"doc_class={doc_class!r}")
    if title_contains:
        bits.append(f"title_contains={title_contains!r}")
    return (
        "No passage matched " + ", ".join(bits) + ". "
        "Retry once with a shorter topic query"
        + (", a different `file_name` from the inventory" if file_name else ", or `file_name=` an exact inventory name")
        + ", or `title_contains=` a fragment. "
        "Do not invent a citation. This tool does not open files — that is `surface_documents`."
    )


def _trace_lanes_json(
    chunks,
    resolved: dict[tuple[str, str], str] | None = None,
    resolved_titles: dict[tuple[str, str], str] | None = None,
) -> str:
    """Machine-readable lane fan-out for the chat Herleitung UI.

    One JSON object under a ``## Trace-Lanes`` marker so the frontend can group
    hits by stratum (OIB / Projekt / Büroarchiv / …) without re-deriving
    ``lane_for_hit``. Fail-open: never break tool output for the LLM.

    Each lane carries BOTH classifications the consumer needs: the fine ``key``
    /``label`` from ``lane_for_hit`` (the authority sub-tier — OIB-Richtlinie vs.
    Rechtsquelle (RIS) vs. …) and the coarse ``kind`` from
    :func:`~aiq_agent.common.source_kinds.kind_for_lane` — the same taxonomy
    ``source_entry_to_wire`` puts on every citation (ADR-0026). Shipping ``kind``
    is what lets the Herleitung fan-out stop mirroring the lane→kind table on the
    frontend, so the fan-out and the "Belegt durch" chips cannot drift apart.

    Each source carries both identities: ``name`` is the raw filename (document
    identity — dedup, preview resolution) and ``title`` the user-facing display
    name, so the Herleitung fan-out shows "OIB-Richtlinie 2, Ausgabe Mai 2023"
    rather than ``oib-rl_2_ausgabe_mai_2023.pdf``. ``title`` is omitted when it
    would merely repeat the filename (project/Büroarchiv uploads, where the
    filename IS the user-meaningful name).

    ``resolved`` is the store-authoritative doc_class map from
    :func:`_resolve_doc_classes` and ``resolved_titles`` the stored display-title
    map from :func:`_resolve_display_titles`; when omitted they are computed here
    so the function stays usable standalone.
    """
    try:
        import json
        from collections import OrderedDict

        from aiq_agent.common.norm_registry import lane_for_knowledge_hit
        from aiq_agent.common.source_kinds import kind_for_lane

        if resolved is None:
            resolved = _resolve_doc_classes(chunks)
        if resolved_titles is None:
            resolved_titles = _resolve_display_titles(chunks)

        lanes: OrderedDict[str, dict] = OrderedDict()
        for chunk in chunks:
            metadata = chunk.metadata or {}
            collection = metadata.get("collection")
            doc_class = _hit_doc_class(chunk, resolved)
            key, label = lane_for_knowledge_hit(doc_class=doc_class, file_name=chunk.file_name, collection=collection)
            bucket = lanes.get(key)
            if bucket is None:
                bucket = {
                    "key": key,
                    "label": label,
                    "kind": kind_for_lane(key),
                    "hitCount": 0,
                    "sources": [],
                }
                lanes[key] = bucket
            bucket["hitCount"] += 1
            name = chunk.file_name or ""
            detail = f"p.{chunk.page_number}" if chunk.page_number and chunk.page_number > 0 else None
            # Deduplicate identical name+detail pairs inside a lane.
            sig = (name, detail or "")
            existing = {(s.get("name"), s.get("detail") or "") for s in bucket["sources"]}
            if name and sig not in existing:
                entry: dict[str, str] = {"name": name}
                title = _hit_display_title(chunk, resolved_titles)
                if title and title != name:
                    entry["title"] = title
                if detail:
                    entry["detail"] = detail
                bucket["sources"].append(entry)
        return json.dumps({"lanes": list(lanes.values())}, ensure_ascii=False)
    except Exception:
        logger.exception("Failed to build Trace-Lanes summary; omitting UI block metadata")
        return '{"lanes":[]}'


def _chunk_shelf(chunk):
    """The shelf a hit came from, as STATED in its metadata (ADR-0047).

    ``None`` when the producer stated none. It is not recovered from the
    collection id: an unknown shelf is unknown, and a citation for it stays
    unqualified rather than claiming a shelf the pipeline guessed.
    """
    from aiq_agent.common.source_kinds import parse_shelf

    return parse_shelf((chunk.metadata or {}).get("shelf"))


def _ambiguous_file_names(chunks) -> set[str]:
    """Filenames this result set holds on MORE THAN ONE shelf.

    A search fans out across the base corpus, the session collection and the
    project collections concurrently, so one result set can carry a project
    `Plan.pdf` and a Büroarchiv `Plan.pdf` — different documents that a bare
    filename cannot tell apart. Those names (and only those) get a shelf
    qualifier in their citation key, so the common case stays a plain filename.

    Shelf, not raw collection, is the grouping: it is all a citation key can
    express, so two collections on the same shelf are not a distinction the
    model could act on anyway.
    """
    shelves_by_name: dict[str, set] = {}
    for chunk in chunks:
        name = (chunk.file_name or "").strip()
        if not name:
            continue
        shelves_by_name.setdefault(name.lower(), set()).add(_chunk_shelf(chunk))
    return {name for name, shelves in shelves_by_name.items() if len(shelves) > 1}


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

    # Resolve the authoritative doc_class per document once (store wins over chunk
    # metadata) and reuse it for both the Dokumentart line and the Trace-Lanes
    # fan-out so the two never disagree.
    resolved = _resolve_doc_classes(retrieval_result.chunks)
    # Resolve the user-facing display title per document once (stored override →
    # derived default). This becomes the citation chip label so the answer never
    # surfaces a raw corpus filename like "oib-rl_2_ausgabe_mai_2023.pdf".
    resolved_titles = _resolve_display_titles(retrieval_result.chunks)
    # Names this result set holds on more than one shelf; only these are qualified.
    ambiguous = _ambiguous_file_names(retrieval_result.chunks)

    for i, chunk in enumerate(retrieval_result.chunks, 1):
        # Build citation string: "filename, p.X" or just "filename". The Citation
        # keeps the real filename — it is the document identity used for preview
        # resolution and source dedup; only the human Source label is prettified.
        # When the same filename arrived from two different shelves in this very
        # result set, the name alone no longer identifies a document, so it is
        # qualified: "Plan.pdf (Projektwissen), p.3".
        shelf = _chunk_shelf(chunk)
        name = chunk.file_name
        if name and name.lower() in ambiguous:
            from aiq_agent.common.source_kinds import shelf_qualifier

            # Rendering, not transport: the qualifier is how the shelf READS in a
            # key the model copies. An unknown shelf gets none (unattributed).
            qualifier = shelf_qualifier(shelf)
            if qualifier:
                name = f"{name} ({qualifier})"
        if chunk.page_number and chunk.page_number > 0:
            citation = f"{name}, p.{chunk.page_number}"
        else:
            citation = name

        # Header with source info. `Source:` carries the user-facing display name
        # (parsed into the citation chip's title); it falls back to the filename
        # for documents with no display title (project/Büroarchiv uploads).
        display_title = _hit_display_title(chunk, resolved_titles) or chunk.file_name

        lines.append(f"--- Result {i} ---")
        lines.append(f"Source: {display_title}")
        collection = (chunk.metadata or {}).get("collection")
        if collection:
            lines.append(f"Collection: {collection}")
        # The shelf travels as DATA (ADR-0047): the citation payload states it so
        # the source registry never re-derives it from the collection id. Omitted
        # when unknown — the reader must see the absence, not a default.
        if shelf is not None:
            lines.append(f"Shelf: {shelf}")
        # Explicit per-document classification ("Dokumentart"). Emit the machine
        # doc_class key first (the citation parser reads it) followed by the
        # German label so the LLM is told the document's role in the norm
        # hierarchy. The summary store is authoritative; chunk metadata is only a
        # fallback (standalone deploys with no summary DB).
        doc_class = _hit_doc_class(chunk, resolved)
        if doc_class:
            from aiq_agent.knowledge.document_classification import DOCUMENT_CLASS_LABELS

            label = DOCUMENT_CLASS_LABELS.get(doc_class, doc_class)
            lines.append(f"Dokumentart: {doc_class} — {label}")
        if chunk.page_number and chunk.page_number > 0:
            lines.append(f"Page: {chunk.page_number}")
        # The Punkt this excerpt belongs to, when the chunker established one. An
        # Austrian building-law answer cites a requirement number ("OIB-RL 2, Pkt.
        # 5.1.1"), and without this line the model has to read that number out of the
        # excerpt text. That works for a Punkt that starts its own chunk and fails
        # exactly where it matters: an over-long Punkt is split downstream by
        # SentenceSplitter, and its continuation chunks inherit `punkt_id` in metadata
        # while presenting to the model as anonymous prose with a page number. The
        # model then guesses a number, and the prompt tells it to produce one.
        #
        # Stating it is also what makes the chunker's verified `punkt_id` reachable by
        # anything downstream: until now it was computed, measured exactly against the
        # corpus's contents pages, and then dropped before the citation the user reads.
        punkt_id = (chunk.metadata or {}).get("punkt_id")
        if punkt_id:
            lines.append(f"Punkt: {punkt_id}")
        lines.append(f"Citation: {citation}")
        lines.append(f"Content Type: {chunk.content_type.value}")
        lines.append(f"Relevance Score: {chunk.score:.2f}")
        lines.append("")

        content = chunk.content
        if len(content) > _CHUNK_TRUNCATE_CHARS:
            content = content[:_CHUNK_TRUNCATE_CHARS] + "... [truncated]"
        lines.append(content)
        lines.append("")

    # Fan-out summary for the Herleitung UI (after chunk bodies so the LLM
    # still sees citations first; parsers look for the marker explicitly).
    lines.append("## Trace-Lanes")
    lines.append(_trace_lanes_json(retrieval_result.chunks, resolved, resolved_titles))
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

    # Resolve the LLM-judge reranker model (fail-open: search still works when
    # unset or unresolvable — rerank_chunks degrades to the original order).
    rerank_llm_obj = None
    if config.rerank_llm:
        from aiq_agent.common import get_langchain_llm

        try:
            rerank_llm_obj = await get_langchain_llm(_builder, config.rerank_llm)
            logger.info("Resolved rerank model: %s", config.rerank_llm)
        except Exception as e:
            logger.warning(f"Could not resolve rerank_llm '{config.rerank_llm}', reranking disabled: {e}")

    # Cross-encoder reranking, when configured. Primary when present; the LLM judge
    # above stays as the fallback. Returns None (never raises) for 'none', an unknown
    # provider, or a key that does not resolve.
    cross_encoder = None
    try:
        from knowledge_layer.cross_encoder import resolve_cross_encoder

        cross_encoder = resolve_cross_encoder(config.reranker_provider, model=config.reranker_model)
    except Exception as e:
        logger.warning(f"Cross-encoder reranker unavailable ({type(e).__name__}: {e}); using the LLM judge")

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
    max_per_document = config.max_chunks_per_document

    logger.info(
        "Knowledge retrieval initialized: backend=%s, collection=%s, top_k=%d", config.backend, collection, top_k
    )

    async def search(
        query: str,
        filters: dict | None = None,
        doc_class: str | None = None,
        title_contains: str | None = None,
        file_name: str | None = None,
    ) -> str:
        """Read and cite passages from the ingested knowledge base.

        Args:
            query (str): The fact or passage you need, rewritten as a search
                query (topic + jurisdiction + implied year). Not the raw user
                message.
            file_name (str | None): Indexed file name to read (from the
                inventory or the user). Never invent a name.
            doc_class (str | None): Dokumentart key (e.g. "oib_richtlinie",
                "gesetz"). Store-authoritative; reclassifications apply
                without re-ingest.
            title_contains (str | None): Case-insensitive substring of the
                file name OR display title.
            filters (dict | None): Rare. Metadata filter on the base
                collection only (e.g. {"content_type": "text"}). Session and
                project collections are never filtered.

        Returns:
            str: Numbered excerpts with a Citation key to copy verbatim.
        """
        query = (query or "").strip()
        file_name = (file_name or "").strip() or None
        title_contains = (title_contains or "").strip() or None
        if not query:
            return (
                "Provide a `query` that names the fact or passage you need "
                "(e.g. 'OIB-RL 2 Fluchtweglänge GK 4'). "
                "If you already have an indexed file name from the inventory, "
                "also pass `file_name=`."
            )
        if doc_class is not None:
            from aiq_agent.knowledge.document_classification import DOCUMENT_CLASSES
            from aiq_agent.knowledge.document_classification import is_valid_doc_class

            if not is_valid_doc_class(doc_class):
                valid = ", ".join(DOCUMENT_CLASSES)
                return (
                    f"Invalid doc_class {doc_class!r}. Valid values: {valid}. "
                    "Omit `doc_class` to search every Dokumentart."
                )

        # Platform-tunable counts (Platform → Retrieval), resolved per call so
        # an admin save takes effect without a redeploy; fail-open to the YAML
        # build-time values above.
        from aiq_agent.common.retrieval_settings import get_retrieval_setting

        effective_top_k = get_retrieval_setting("knowledge.top_k", top_k)
        effective_max_per_document = get_retrieval_setting("knowledge.max_chunks_per_document", max_per_document)

        # Over-fetch when agentic filters will drop candidates post-merge.
        narrowed = bool(doc_class or title_contains or file_name)
        candidate_k = effective_top_k * _AGENT_FILTER_OVERFETCH if narrowed else effective_top_k
        if rerank_llm_obj is not None or cross_encoder is not None:
            candidate_k = max(candidate_k, config.rerank_candidates)

        # Resolve the per-session collection (UI uploads for this conversation).
        try:
            ctx = Context.get()
            session_collection = ctx.conversation_id if ctx else None
        except Exception:
            session_collection = None

        # Country-profile-resolved base corpus collection (behavior-neutral for
        # Austria; the seam that points retrieval at country #2's corpus).
        base_collection = _resolve_base_collection(config)

        # Authorized set first, then subtract the shelves this turn did not
        # ask for. Resolve stays a ceiling; restriction is one call site.
        target_collections = _restrict_scope_to_turn(
            _resolve_scoped_collections(config, session_collection, base_collection)
        )

        # Cross-lingual bridge. The corpus is German; an English question reaches it
        # only weakly by embedding and not at all lexically. Measured on this corpus,
        # an English question scored MRR 0.293 against 0.678 for the same question in
        # German, and prepending the corpus's own German terms closed that to 0.674.
        # A German query is returned untouched, so this is a no-op for the language
        # the corpus is written in.
        #
        # ONLY the matching query is augmented. The reranker judges, and the grounding
        # block reports, the user's actual question -- the glossary states the topic,
        # not the intent, and a judge shown "Fassade Außenwand What are the facade…"
        # would be scoring a phrase nobody asked.
        from aiq_agent.common.query_expansion import augmented_query

        retrieval_query = augmented_query(query)
        if retrieval_query != query:
            logger.info("Query expanded for retrieval: %r -> %r", query[:60], retrieval_query[:80])

        logger.info(
            "Knowledge search: query='%s...' collections=%s",
            query[:100],
            [(entry.collection, entry.shelf) for entry in target_collections],
        )

        async def _retrieve_collection(entry):
            coll = entry.collection
            # File exclusions + caller filters apply to the base collection only;
            # session/project collections are user content and are never filtered.
            coll_filters = _base_collection_filters(config, filters) if coll == base_collection else None
            result = await retriever.retrieve(
                query=retrieval_query, collection_name=coll, top_k=candidate_k, filters=coll_filters
            )
            # Tag each chunk with its collection so the merge does not lose the
            # per-hit stratum — the trace UI's lane labels and source_lane read it.
            # The SHELF rides along explicitly (ADR-0047): this is the last point
            # at which it is known for free, and nothing downstream may recover
            # it from the collection id. An unstated shelf stays absent — absent
            # means unknown, and unknown renders unattributed.
            for chunk in getattr(result, "chunks", []) or []:
                chunk.metadata.setdefault("collection", coll)
                if entry.shelf is not None:
                    chunk.metadata.setdefault("shelf", str(entry.shelf))

            # Named retrieve: the agent's `file_name=` (explicit) or the
            # visible peek (`focus_file_name`) so similarity is not the only
            # path to that file. Explicit name wins when both are set.
            if coll != base_collection:
                try:
                    from aiq_agent.common.focus_file import get_focused_file_name

                    focused = file_name or get_focused_file_name()
                except Exception:
                    focused = file_name
                if focused:
                    try:
                        named = await retriever.retrieve(
                            query=query,
                            collection_name=coll,
                            top_k=candidate_k,
                            filters={"file_name": {"$eq": focused}},
                        )
                        for chunk in getattr(named, "chunks", []) or []:
                            chunk.metadata.setdefault("collection", coll)
                            if entry.shelf is not None:
                                chunk.metadata.setdefault("shelf", str(entry.shelf))
                        if getattr(named, "success", False) and named.chunks:
                            result = result.model_copy(
                                update={"chunks": list(named.chunks) + list(getattr(result, "chunks", []) or [])}
                            )
                    except Exception:
                        logger.debug("Named-file retrieve skipped for %s", coll, exc_info=True)
            return result

        try:
            # Fan out across all layers concurrently; tolerate empty/missing layers.
            results = await asyncio.gather(
                *(_retrieve_collection(entry) for entry in target_collections),
                return_exceptions=True,
            )

            # Merge by cross-collection rank fusion (scores are NOT comparable across
            # collections) with a per-document diversity cap so cross-cutting questions
            # span multiple documents. `results` is in `target_collections` order, which
            # is the channel order the fusion breaks exact ties by.
            merged = _merge_results(results, query, candidate_k, retriever.backend_name, effective_max_per_document)

            # Agentic narrowing, then trim to the effective top_k.
            # `file_name=` is a FILTER, not a preference: the agent named a
            # file, so other hits would be a silent bait-and-switch.
            if doc_class or title_contains or file_name:
                kept = _apply_agent_filters(
                    merged.chunks,
                    doc_class=doc_class,
                    title_contains=title_contains,
                    file_name=file_name,
                )
                merged = merged.model_copy(update={"chunks": kept})

            # Reranking: cross-encoder first when configured, LLM judge as the
            # fallback (fail-open: any error keeps the fused order).
            if rerank_llm_obj is not None or cross_encoder is not None:
                from knowledge_layer.rerank import rerank_chunks

                # Never trim below what the caller is about to ask for. `top_k` is
                # admin-tunable at runtime (up to 50) while `rerank_candidates` is a
                # build-time YAML value, so raising Platform -> Retrieval top_k above
                # rerank_candidates used to cap every search at rerank_candidates with
                # no error — the "must exceed top_k" invariant was documented in a
                # comment and enforced nowhere.
                rerank_top_n = max(effective_top_k, config.rerank_candidates)
                reranked = await rerank_chunks(
                    rerank_llm_obj,
                    query,
                    merged.chunks,
                    top_n=rerank_top_n,
                    cross_encoder=cross_encoder,
                )
                merged = merged.model_copy(update={"chunks": reranked})

            merged = merged.model_copy(update={"chunks": merged.chunks[:effective_top_k]})

            # Relevance floor. Without one, top_k is ALWAYS filled: a question this
            # corpus cannot answer still returns sixteen formatted excerpts with page
            # citations and a Dokumentart line asserting binding legal force, and the
            # grounding block has no vocabulary for "I retrieved nothing useful". In a
            # building-law product that is the highest-consequence failure available.
            #
            # DISABLED BY DEFAULT, and that is not timidity. A floor is a number on a
            # specific embedding model's cosine distribution, and this deployment's
            # model is a deploy-time choice -- the collection fingerprint records which
            # one wrote the vectors precisely because they are not interchangeable. A
            # value calibrated against one model silently over-filters under another,
            # which is exactly how MIN_SURFACE_SCORE spent its whole life as a no-op.
            # Calibrate with the retrieval-eval harness against the deployed model, then
            # set knowledge.relevance_floor_pct.
            #
            # And calibrate expecting to find no usable value. Measured on this corpus
            # with multilingual-e5-small over the 52-entry golden set, top-1 similarity
            # does NOT separate the two populations: answerable questions run 0.799 to
            # 0.933 and the six the corpus cannot answer run 0.795 to 0.865, overlapping
            # by 0.066. Refusing all six costs 21 of the 46 real questions; keeping 44 of
            # 46 still answers four of the six. The failures are Wiener Garagengesetz and
            # Bauordnung questions, and the corpus is full of neighbouring text about
            # Stellplätze and Grundgrenzen -- similarity measures that the corpus
            # discusses parking spaces, not that it answers Vienna's parking rule.
            # Whether that transfers to a stronger embedder is exactly what the harness
            # is for, but the shape of the result says abstention wants a judge that
            # reads the question against the text (the reranker's 0-10 rubric), not a
            # threshold on a distance.
            floor_pct = get_retrieval_setting("knowledge.relevance_floor_pct", 0)
            if floor_pct > 0:
                floor = floor_pct / 100.0
                kept = [chunk for chunk in merged.chunks if chunk.score >= floor]
                if len(kept) != len(merged.chunks):
                    best = max((chunk.score for chunk in merged.chunks), default=0.0)
                    logger.info(
                        "Relevance floor %.2f dropped %d/%d chunks (best score %.2f)",
                        floor,
                        len(merged.chunks) - len(kept),
                        len(merged.chunks),
                        best,
                    )
                merged = merged.model_copy(update={"chunks": kept})

            # After the floor, not before: the floor is the only thing that can empty a
            # non-empty result set, and this message is the vocabulary for saying so.
            if not merged.chunks:
                return _empty_search_message(
                    query,
                    file_name=file_name,
                    doc_class=doc_class,
                    title_contains=title_contains,
                )

            # Format for LLM. _format_results does the (now batched, 1-3 query)
            # doc_class resolution plus pure-CPU string building; run it off the
            # event loop so the synchronous DB round-trips never block the loop
            # (and stall other concurrent turns).
            formatted = await asyncio.to_thread(_format_results, merged, query)
            logger.info(f"Knowledge search returned {len(merged.chunks)} chunks")
            logger.debug(f"Formatted result for LLM:\n{formatted[:500]}...")
            return formatted

        except Exception as e:
            logger.error(f"Knowledge search failed: {e}")
            return (
                f"Knowledge search failed for query={query!r}. "
                "Retry once with the same query; if it fails again, say you "
                "could not search the knowledge base and do not invent a citation. "
                f"Technical detail: {e}"
            )

    # Yield the function info for NAT registration
    if max_per_document > 0:
        diversity_clause = (
            f"spread across multiple distinct documents (at most {max_per_document} per document "
            "where possible), so cross-cutting questions see every relevant Richtlinie."
        )
    else:
        diversity_clause = "ranked purely by relevance, with no per-document diversity cap."
    yield FunctionInfo.from_fn(
        search,
        description=(
            f"{_KNOWLEDGE_SEARCH_DESCRIPTION} "
            f"Returns up to {top_k} excerpts (platform-configurable), {diversity_clause}"
        ),
    )
