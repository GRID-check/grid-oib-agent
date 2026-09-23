"""NAT function for knowledge retrieval.

This function provides direct library access to the knowledge layer,
allowing agents to search ingested documents without an external API server.

The retriever is instantiated once and reused for all queries.
"""

import asyncio
import logging
import os
from contextlib import suppress
from dataclasses import dataclass
from typing import Any
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

# Substring identifying an embedding-fingerprint mismatch in a layer failure.
# Produced by ``embed_fingerprint_mismatch`` in the llamaindex adapter (which
# reports a same-dimension model swap as "embedding mismatch: ...") and
# preserved verbatim in ``RetrievalResult.error_message`` by ``_retrieve_sync``
# ("Retrieval failed: Collection '...' embedding mismatch: ..."). A mismatch
# means the stored and query vectors live in different spaces, so the affected
# collection contributed nothing — total base-corpus loss when it is the only
# layer. Unlike a missing session collection (routine, stays quiet) this is a
# configuration fault and must surface as degraded/error, never as a miss.
_EMBEDDING_MISMATCH_MARKER = "embedding mismatch"


def _is_embedding_mismatch(value: object) -> bool:
    """True when a layer failure reports a fingerprint mismatch, not a routine miss."""
    if isinstance(value, BaseException):
        value = str(value)
    return isinstance(value, str) and _EMBEDDING_MISMATCH_MARKER in value.lower()


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
    "when you already know the class or a title fragment. Pass `folder=` (the "
    "path the inventory prints after 'Ordner:', e.g. Brandschutz/Fluchtwege) "
    "when the user scoped the question to a folder — it also covers everything "
    "filed beneath that folder.\n"
    "WHEN NOT TO CALL — to put a file on screen (the user asked to SEE or "
    "BROWSE files, no legal question): that is `surface_documents`. After "
    "you cite a project or Büroarchiv file, do not also call "
    "`surface_documents`; the UI peeks the cited file. Live Austrian law "
    "(statutes, Bauordnungen) is the RIS tools, not this index. When you "
    "already know WHICH document you need, that is `read_passage` — with the "
    "Punkt or page when you have one, with the document alone when you do not "
    "(it then returns that document's scope and its outline). A lookup, not a "
    "second search.\n"
    "HOW TO QUERY — rewrite the user question into a search query (topic + "
    "jurisdiction + implied year). Prefer one precise call over a broad dump. "
    "If a conclusion names a document and a Punkt or page you have not opened, "
    "open it with `read_passage`; search again only when you still do not know "
    "WHICH document holds the answer. Empty results: change the query and "
    "try again; do not invent a citation around a gap you could still close. "
    "Never invent a `file_name`; take it from the inventory or the user. The "
    "OIB base corpus "
    "is not enumerated there — reach it by `doc_class` (e.g. `oib_richtlinie`) "
    "or by plain semantic search, never a guessed name. Do not pass a raw "
    "`filters` object unless you need `content_type`. "
    "A query that names a Richtlinie and nothing else ('OIB 2', "
    "'OIB-Richtlinie 2.1') returns every part of that Richtlinie the corpus "
    "holds, each with its Geltungsbereich and its Gliederung, so ask it that "
    "way when you want the whole Richtlinie.\n"
    "ALWAYS pass `conclusion=` — one sentence saying what you now know and what "
    "you still need, which is why you are making THIS call. Empty on your first "
    "call of the turn. It is the Herleitung checkpoint the reader sees above the "
    "fetch; it changes nothing about the search and never appears in `answer`.\n"
    "RETURNS — numbered passages with Source, Citation (copy this key "
    "verbatim), Dokumentart, Ordner (the folder the file is filed in, when it "
    "has one), page, and the passage. Cite only those keys. "
    "A hit whose Herkunft line says 'Piloti-Dokument' is office knowledge the "
    "office has approved, never a source for a normative value: cite it for "
    "what the office decided, not for what the OIB requires. "
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
            "Cross-encoder reranking provider (none|openrouter|jev). `jev` scores one decision-model "
            "noul per candidate (ADR-0064), an option to evaluate beside the cross-encoder. "
            "None falls back to the AIQ_RERANKER_PROVIDER environment default, which is "
            "'none'. When one resolves it becomes the primary reranker and rerank_llm "
            "becomes the fallback; a missing key or any provider error degrades to the judge."
        ),
    )
    reranker_model: str | None = Field(
        default=None,
        description="Cross-encoder model id (default cohere/rerank-v3.5, multilingual — a German corpus needs one).",
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
    requery_llm: str | None = Field(
        default=None,
        description=(
            "Optional LLM reference from llms: section that judges whether the fused "
            "candidate pool can answer the query and, when it cannot, proposes alternative "
            "formulations that are retrieved and fused into the same pool before reranking "
            "(the retrieval loop). Runs beside the reranker, so a sufficient pool costs no "
            "extra latency. Unset = one-shot retrieval. Fail-open: any judge error keeps "
            "the first pool."
        ),
    )
    requery_max_queries: int = Field(
        default=2,
        ge=1,
        le=4,
        description=(
            "Ceiling on alternative queries the judge may propose per search when "
            "requery_llm is set. Each is one retrieval per in-scope collection."
        ),
    )
    requery_decider: str = Field(
        default="llm",
        description=(
            "Who answers the judge's yes/no (llm|jev). `jev` asks the decision model one noul per "
            "passage of the head first (ADR-0064, ~300 ms, a fraction of a cent): a head it finds "
            "sufficient costs no judge call, and only an insufficient head runs requery_llm, for the "
            "phrasings. A decision that cannot run (no key, ZDR, breaker open) falls back to the judge."
        ),
    )
    decision_sufficiency_threshold: float = Field(
        default=0.55,
        ge=0.0,
        le=1.0,
        description=(
            "With requery_decider=jev: the head is sufficient when any passage's p(answers the question) "
            "reaches this. Lower = fewer requeries; the decision eval sweeps it."
        ),
    )
    hyde_enabled: bool = Field(
        default=False,
        description=(
            "HyDE-as-channel experiment (backlog item 14), default OFF. When true, a "
            "query with no exact identifier shape drafts a hypothetical norm-register "
            "passage that is retrieved and fused as one extra RRF channel beside the "
            "original query (which always stays in the mix and is what the reranker "
            "judges). The draft reuses the resolved rerank_llm handle — greedy, "
            "reasoning-free, already paid for — so enabling this adds no model "
            "plumbing and re-points no model. Draft failure/slowness degrades to the "
            "baseline silently. Ship as default behaviour only if the golden harness "
            "shows an overview lift with no exact-id/paraphrase regression."
        ),
    )
    hyde_timeout_seconds: float = Field(
        default=8.0,
        ge=1.0,
        le=30.0,
        description=(
            "Upper bound on the HyDE draft call. It runs beside the first retrieval "
            "fan-out, so a fast draft costs no latency; past this it reads as no "
            "draft and the search is the baseline."
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


#: The ``chunking`` value the base corpus uses for text that is not evidence.
#:
#: ``punkt_documents`` (``llamaindex/punkt_chunking.py``) cuts a Punkt-structured
#: Richtlinie into one chunk per numbered Punkt, tagged ``chunking: "punkt"``, and
#: emits everything outside that run -- the cover page and the Impressum -- as
#: per-page Documents tagged ``chunking: "page"``. Neither is citable: pdfplumber
#: returns the cover's display type as garble, and the Impressum is furniture. A
#: title-shaped query ("OIB-Richtlinie 2 Ausgabe Mai 2023") matched exactly those
#: two, so an overview question came back as four cover pages at page 1 and the
#: model learned nothing.
#:
#: The exclusion is a STORE filter rather than a post-retrieval drop because a
#: dropped hit still costs its candidate slot. It is ``$ne`` rather than a
#: whitelist of ``punkt`` on purpose: only Punkt-structured documents carry the
#: key at all -- Begriffsbestimmungen, Zitierte Normen, project uploads and office
#: files carry no ``chunking`` key -- and a whitelist would delete them from
#: search. Measured against the deployed store (chromadb 1.5.9, the version
#: ``deploy/`` pins): ``$ne`` KEEPS records that lack the key, so the keyless
#: majority of the corpus is untouched. ``tests/knowledge_layer_tests/
#: test_page_chunk_exclusion.py`` round-trips that through a real collection, so
#: a version bump that changed the semantics fails a test rather than emptying
#: the corpus silently.
#:
#: ``read_passage`` builds its own filters and is deliberately NOT subject to
#: this: naming page 1 of a Richtlinie is an explicit request, not a similarity hit.
_NON_EVIDENCE_CHUNKING = "page"


def _base_collection_filters(config: KnowledgeRetrievalConfig, caller_filters: dict | None) -> dict:
    """Base-collection metadata filter: the page-chunk exclusion, file exclusions, caller filters.

    Three clauses, AND-ed, applied to the base collection only (session/project
    collections are user content and are never filtered):

    1. ``chunking != "page"``, always. See :data:`_NON_EVIDENCE_CHUNKING`.
    2. ``exclude_file_names`` as a ``file_name NOT IN [...]`` clause, when configured.
    3. the caller's optional ``filters`` dict, when given.

    Never returns None: clause 1 holds for every base-corpus search.
    """
    clauses: list[dict] = [{"chunking": {"$ne": _NON_EVIDENCE_CHUNKING}}]
    excluded = sorted(set(config.exclude_file_names))
    if excluded:
        clauses.append({"file_name": {"$nin": excluded}})
    if caller_filters:
        clauses.append(caller_filters)

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
    result therefore contributes one RRF channel (in ``target_collections`` order, so
    the base corpus wins exact ties) and the merged order is the fused rank — scale-free
    by construction, so a session hit at rank 0 can outrank a corpus hit at rank 5.
    When the retrieval loop has fanned out, ``results`` also carries one result per
    (collection, alternative query), appended after the originals: a chunk that two
    formulations agree on is fused upward, one that only a paraphrase reached enters
    the pool, and the original query keeps the tie-break seat.

    Selection over that fused order is diversity-aware; see ``_apply_diversity_cap``. With
    a single collection and ``max_per_document=0`` this is identical to a plain top-k
    truncation of that collection's own order.

    ``chunk.score`` is never mutated: ``_format_results`` keeps displaying the true
    similarity. The fusion score is recorded on ``chunk.fusion_score`` for diagnostics.

    Failed layers (``success=False``, e.g. a brand-new session whose collection
    does not exist yet) and raised exceptions are treated as empty contributions
    and skipped — EXCEPT an embedding-fingerprint mismatch (see
    ``_EMBEDDING_MISMATCH_MARKER``), which is a configuration fault, not a miss:
    a wrong ``AIQ_EMBED_MODEL``/``AIQ_EMBED_BASE_URL`` silently drops the whole
    base corpus while the surviving layers still answer. A mismatch therefore
    rides along on the merged result instead of being skipped quietly: no
    surviving channel means ``success=False`` with the mismatch detail (an
    error the caller cannot mistake for "nothing matched"); surviving channels
    mean ``success=True`` with ``error_message`` set (a degraded signal — real
    chunks, but from an incomplete corpus). A missing collection stays routine:
    ``success=True`` with no ``error_message``. This never raises.

    Args:
        results: List of RetrievalResult objects or Exceptions (from asyncio.gather),
            in ``target_collections`` order.
        query: The original query string.
        top_k: Maximum number of merged chunks to return.
        backend_name: Fallback backend label if no successful result is available.
        max_per_document: Diversity cap per distinct document on the first pass.

    Returns:
        A synthetic RetrievalResult with the merged top-k chunks: ``success=False``
        when mismatches left no surviving channel, ``success=True`` with
        ``error_message`` set when mismatches dropped some channels but others
        survived (degraded), and a plain ``success=True`` otherwise.
    """
    from aiq_agent.knowledge.schema import RetrievalResult

    channels: list[list] = []
    backend = backend_name
    mismatch_errors: list[str] = []
    for result in results:
        if isinstance(result, Exception):
            if _is_embedding_mismatch(result):
                mismatch_errors.append(str(result)[:500])
                logger.error("Knowledge layer embedding mismatch, skipping: %s", result)
            else:
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
            if _is_embedding_mismatch(message):
                if message not in mismatch_errors:
                    mismatch_errors.append(message)
                logger.error("Knowledge layer embedding mismatch, skipping: %s", message)
            elif "not found" in message.lower():
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

    if mismatch_errors:
        # De-duplicated: the requery fan-out retries each collection per
        # alternative query, so one broken corpus reports once per query.
        unique = list(dict.fromkeys(mismatch_errors))
        detail = "; ".join(unique)
        if not channels:
            # Total loss: every layer dropped out on a fingerprint mismatch.
            # success=False so the caller renders a failure, never a miss.
            return RetrievalResult(success=False, chunks=[], query=query, backend=backend, error_message=detail)
        # Partial loss: the chunks below are real, but the corpus behind them is
        # incomplete. success=True carries them; error_message carries the
        # degraded signal `_format_results` renders as a WARNING banner.
        return RetrievalResult(
            success=True,
            chunks=merged_top_k,
            query=query,
            backend=backend,
            error_message=(
                f"Degraded retrieval: {len(unique)} collection(s) skipped "
                f"due to embedding mismatch ({detail}). Results cover only the "
                "remaining collections and are incomplete."
            ),
        )

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


async def _draft_hyde_text(hyde_llm_obj, query: str, *, enabled: bool, timeout_seconds: float) -> str | None:
    """Draft the HyDE probe passage for ``query``; ``None`` means baseline.

    The single seam between the search path and the draft model, so tests can
    pin "identifier-shaped query → no model call" and "slow model → baseline"
    without driving the whole search. Never raises: the gate, the import and
    the draft call all fail open to ``None``.
    """
    try:
        from aiq_agent.common.hyde import draft_passage
        from aiq_agent.common.hyde import should_draft
    except ImportError:
        return None
    if not should_draft(query, enabled=enabled and hyde_llm_obj is not None):
        return None
    return await draft_passage(hyde_llm_obj, query, timeout_seconds=timeout_seconds)


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
        # Fail-open, but never silent: with the store unreachable every hit
        # falls back to its chunk metadata, and that fallback looks exactly
        # like a correct answer from the outside.
        logger.warning(
            "document metadata store unavailable; %s falls back to chunk metadata", "doc_class", exc_info=True
        )
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
            logger.warning(
                "document metadata store read failed for collection %s; %s falls back to chunk metadata",
                collection,
                "doc_class",
                exc_info=True,
            )
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
        # Fail-open, but never silent: with the store unreachable every hit
        # falls back to its chunk metadata, and that fallback looks exactly
        # like a correct answer from the outside.
        logger.warning(
            "document metadata store unavailable; %s falls back to chunk metadata", "display_title", exc_info=True
        )
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
            logger.warning(
                "document metadata store read failed for collection %s; %s falls back to chunk metadata",
                collection,
                "display_title",
                exc_info=True,
            )
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


def _resolve_folder_paths(chunks) -> dict[tuple[str, str], str]:
    """Resolve the stored ``folder_path`` for each hit's document (batched).

    Mirrors :func:`_resolve_doc_classes` and :func:`_resolve_display_titles`: the
    document_metadata store is the source of truth for where a document is
    FILED, and the folder is deliberately NOT baked into the chunk vectors
    (ADR-0049) — a folder rename moves the path, and a value baked into every
    chunk would have to be rewritten chunk by chunk or go stale. Reading it here,
    once per collection, is what makes a rename take effect with no re-ingest.
    Fail-open: any store error yields an empty/partial map, which reads as
    "filed at the root".
    """
    resolved: dict[tuple[str, str], str] = {}
    try:
        from aiq_agent.knowledge.factory import get_document_folder_paths
    except Exception:
        # Fail-open, but never silent: with the store unreachable every hit
        # falls back to its chunk metadata, and that fallback looks exactly
        # like a correct answer from the outside.
        logger.warning(
            "document metadata store unavailable; %s falls back to chunk metadata", "folder_path", exc_info=True
        )
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
            stored_map = get_document_folder_paths(collection, file_names)
        except Exception:
            logger.warning(
                "document metadata store read failed for collection %s; %s falls back to chunk metadata",
                collection,
                "folder_path",
                exc_info=True,
            )
            stored_map = {}
        for file_name, stored in stored_map.items():
            if stored:
                resolved[(collection, file_name)] = stored
    return resolved


def _hit_folder_path(chunk, resolved: dict[tuple[str, str], str]) -> str | None:
    """Folder path for a single hit, or ``None`` when it sits at the root."""
    collection = (chunk.metadata or {}).get("collection")
    if collection and chunk.file_name:
        return resolved.get((collection, chunk.file_name))
    return None


def _folder_matches(stored: str | None, requested: str) -> bool:
    """True when a hit is filed in ``requested`` OR anywhere beneath it.

    The subtree is the point of a materialised path: asking for ``Brandschutz``
    must also return ``Brandschutz/Fluchtwege``, and must NOT return
    ``Brandschutzkonzepte`` — which is exactly what the ``/`` boundary below
    enforces. Comparison is case-insensitive because the agent retypes the
    folder name from the inventory, and slashes are trimmed so ``/Brandschutz/``
    and ``Brandschutz`` are the same request.
    """
    have = (stored or "").strip().strip("/").casefold()
    want = (requested or "").strip().strip("/").casefold()
    if not want:
        return True
    if not have:
        return False
    return have == want or have.startswith(f"{want}/")


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
    folder: str | None = None,
) -> list:
    """Narrow a merged candidate list by the agent-supplied filters.

    Filters run post-merge so they apply uniformly across every collection
    layer (base, session, project). ``doc_class`` uses the same store-authoritative
    resolution as the Dokumentart line (:func:`_hit_doc_class`), so a platform-owner
    reclassification takes effect without re-ingest. ``title_contains`` matches the
    raw file name OR the resolved display title, case-insensitively. ``file_name``
    matches the indexed name only — the agent already has a name. ``folder``
    keeps only documents filed in that project folder OR anywhere under it
    (ADR-0049), resolved from the same store for the same reason: a folder
    rename applies immediately, with nothing re-ingested.
    """
    resolved_classes = _resolve_doc_classes(chunks) if doc_class else {}
    resolved_titles = _resolve_display_titles(chunks) if title_contains else {}
    requested_folder = (folder or "").strip().strip("/") or None
    resolved_folders = _resolve_folder_paths(chunks) if requested_folder else {}
    needle = title_contains.casefold() if title_contains else None
    requested_name = (file_name or "").strip() or None
    kept = []
    for chunk in chunks:
        if doc_class and _hit_doc_class(chunk, resolved_classes) != doc_class:
            continue
        if requested_name and not _file_name_matches(chunk.file_name, requested_name):
            continue
        if requested_folder and not _folder_matches(_hit_folder_path(chunk, resolved_folders), requested_folder):
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
    folder: str | None = None,
) -> str:
    """Steer a miss toward a more specific next call, not a invented citation."""
    bits = [f"query={query!r}"]
    if file_name:
        bits.append(f"file_name={file_name!r}")
    if doc_class:
        bits.append(f"doc_class={doc_class!r}")
    if title_contains:
        bits.append(f"title_contains={title_contains!r}")
    if folder:
        bits.append(f"folder={folder!r}")
    return (
        "No passage matched " + ", ".join(bits) + ". "
        "Retry once with a shorter topic query"
        + (", a different `file_name` from the inventory" if file_name else ", or `file_name=` an exact inventory name")
        + ", or `title_contains=` a fragment. "
        + (
            f"Nothing is filed under {folder!r}, or nothing there matched — drop `folder=` "
            "to search the whole shelf, or take the exact folder from the inventory. "
            if folder
            else ""
        )
        + "Do not invent a citation. This tool does not open files — that is `surface_documents`."
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

    A source the publish path marked as agent-authored carries a
    ``provenance`` object (``authored_by``/``approved_by``/``approved_at``/
    ``producer``) and lands in its own lane, ``buero_piloti``. That lane is
    decided by the provenance BEFORE the shelf, so a published Piloti document
    filed on the project shelf keeps its author instead of joining
    Projektwissen.

    ``resolved`` is the store-authoritative doc_class map from
    :func:`_resolve_doc_classes` and ``resolved_titles`` the stored display-title
    map from :func:`_resolve_display_titles`; when omitted they are computed here
    so the function stays usable standalone.

    This is the CHUNK-facing entry point. It turns chunks into the same
    :class:`~aiq_agent.common.grounding_block.GroundingHit` records the header
    lines are rendered from and hands them to :func:`_trace_lanes_for_hits`, so
    a hit's shelf, Dokumentart and title are derived once (ADR-0061).
    """
    try:
        if resolved is None:
            resolved = _resolve_doc_classes(chunks)
        if resolved_titles is None:
            resolved_titles = _resolve_display_titles(chunks)
        hits = [
            _grounding_hit(
                chunk,
                resolved=resolved,
                resolved_titles=resolved_titles,
                # Neither reaches the fan-out: it names documents by raw
                # filename, so no citation key is built and no folder is read.
                resolved_folders={},
                ambiguous=set(),
            )
            for chunk in chunks
        ]
    except Exception:
        logger.exception("Failed to build Trace-Lanes summary; omitting UI block metadata")
        return '{"lanes":[]}'
    return _trace_lanes_for_hits(hits)


def _trace_lanes_for_hits(hits, opened_files: frozenset[str] = frozenset()) -> str:
    """The ``## Trace-Lanes`` fan-out for records that are already built.

    ``opened_files`` names the documents this result set OPENED rather than
    ranked (the members of a family overview); their hits are stamped as
    locator reads on the turn's ledger.

    Fail-open: never break tool output for the LLM. See :func:`_trace_lanes_json`
    for what the payload means and why each field is on it.
    """
    try:
        import json
        from collections import OrderedDict

        from aiq_agent.common.norm_registry import lane_for_knowledge_hit
        from aiq_agent.common.source_kinds import kind_for_lane

        lanes: OrderedDict[str, dict] = OrderedDict()
        for hit in hits:
            key, label = lane_for_knowledge_hit(
                doc_class=hit.doc_class,
                file_name=hit.file_name,
                collection=hit.collection,
                shelf=hit.shelf,
                authored_by=hit.authored_by,
            )
            bucket = lanes.setdefault(
                key,
                {"key": key, "label": label, "kind": kind_for_lane(key), "hitCount": 0, "sources": []},
            )
            bucket["hitCount"] += 1
            _append_lane_source(bucket, hit, opened_files)
        return json.dumps({"lanes": list(lanes.values())}, ensure_ascii=False)
    except Exception:
        logger.exception("Failed to build Trace-Lanes summary; omitting UI block metadata")
        return '{"lanes":[]}'


def _lane_detail(hit) -> str | None:
    """Where in the document this hit sits, as the Herleitung names it.

    The Punkt leads when the hit states one: a normative document is read by
    its numbering, and "Pkt. 3.5.2" is the locus the reader can act on, where
    "p.12" is where the printer happened to break the page. The page follows on
    the same line because the frontend takes the preview's page out of this
    string (``features/chat/lib/citations/build.ts``), and an entry that lost
    it would open the document at page 1. The two are separated by a SPACE:
    the Herleitung card joins several loci of one document with ", ", and a
    comma inside one locus would read as two.
    """
    page = f"p.{hit.page}" if hit.page is not None else ""
    if not hit.punkt:
        return page or None
    return f"Pkt. {hit.punkt} {page}".strip()


def _append_lane_source(bucket: dict, hit, opened_files: frozenset[str] = frozenset()) -> None:
    """Add one hit to its lane's source list, unless the lane already names it.

    A hit from a document in ``opened_files`` is stamped as a locator read,
    whatever tool rendered it: the family branch fetches each member the way
    ``read_passage(document=…)`` does, so the ledger must credit those
    documents as opened, or a later read of one of them is not a repeat.
    """
    from aiq_agent.common.provenance import provenance_metadata

    name = hit.file_name or ""
    detail = _lane_detail(hit)
    # Deduplicate identical name+detail pairs inside a lane.
    existing = {(source.get("name"), source.get("detail") or "") for source in bucket["sources"]}
    if not name or (name, detail or "") in existing:
        return
    entry: dict[str, Any] = {"name": name}
    if hit.display_title and hit.display_title != name:
        entry["title"] = hit.display_title
    if detail:
        entry["detail"] = detail
    if hit.shelf is not None:
        entry["shelf"] = str(hit.shelf)
    if hit.provenance is not None:
        # The KEYS, not the German sentence: the fan-out is data, and a
        # frontend that wants "freigegeben von …" should build it in the
        # reader's own locale from the approver and the ISO date rather than
        # parse it back out of prose.
        entry["provenance"] = provenance_metadata(hit.provenance)
    _stamp_and_capture_lane_source(entry, opened=name in opened_files)
    bucket["sources"].append(entry)


def _stamp_and_capture_lane_source(entry: dict, *, opened: bool = False) -> None:
    """Stamp the entry with its retrieval round and note it on the turn's ledger.

    The per-round ledger reads this, never the prose: the capture keeps every
    round's hits apart, while the turn_sources log dedups documents across
    rounds. A missing round stamp must not drop the hit.

    ``record_lane_hit`` builds its OWN record and stamps the producing tool on
    it from the scope the tool opened. That stamp stays in the capture: the
    ``entry`` below is the Trace-Lanes payload the model and the frontend read,
    and which tool fetched a passage is how a repeat is DERIVED, not something
    either of them is shown.
    """
    try:
        from contextlib import nullcontext

        from aiq_agent.common.turn_status import READ_PASSAGE_TOOL
        from aiq_agent.common.turn_status import current_retrieval_round
        from aiq_agent.common.turn_status import lane_tool_scope
        from aiq_agent.common.turn_status import record_lane_hit

        round_index = current_retrieval_round()
        if round_index is not None:
            entry["round"] = round_index
        # The producing tool is read off its scope, never passed (the rule in
        # ``record_lane_hit``); an opened document gets the locator's scope.
        with lane_tool_scope(READ_PASSAGE_TOOL) if opened else nullcontext():
            record_lane_hit(
                entry["name"],
                title=entry.get("title"),
                detail=entry.get("detail"),
                shelf=entry.get("shelf"),
            )
    except Exception:  # noqa: BLE001 (the fan-out survives a missing status module)
        logger.debug("Turn status unavailable; lane hit goes unstamped", exc_info=True)


def _hit_provenance(chunk):
    """The agent provenance stated in a hit's chunk metadata, or ``None``.

    The keys are stamped at ingest by the publish path and read back by
    ``aiq_agent.common.provenance``; a human-authored document has none, and
    every line below that depends on this is simply not emitted for it. Chunk
    metadata is the only carrier — unlike doc_class and the display title there
    is no store-resolved override, because authorship is decided once, at
    publish, and cannot be edited afterwards.
    """
    from aiq_agent.common.provenance import parse_agent_provenance

    return parse_agent_provenance(chunk.metadata or {})


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


def _citation_key_for(file_name: str, shelf, page: int | None, ambiguous: set[str]) -> str:
    """The key the model copies: ``"filename, p.X"``, or just ``"filename"``.

    It keeps the REAL filename, which is the document identity preview
    resolution and source dedup use; only the human ``Source:`` label is
    prettified. When the same filename arrived from two different shelves in
    this very result set the name alone no longer identifies a document, so it
    is qualified: ``Plan.pdf (Projektwissen), p.3``. The qualifier is
    rendering, not transport, and an unknown shelf gets none.
    """
    from aiq_agent.common.source_kinds import shelf_qualifier

    name = file_name
    qualifier = shelf_qualifier(shelf) if name and name.lower() in ambiguous else None
    if qualifier:
        name = f"{name} ({qualifier})"
    return f"{name}, p.{page}" if page is not None else name


def _stored_image_index(metadata: dict) -> int | None:
    """The index of a raster the ingest pipeline stored beside the document.

    ``None`` unless the chunk carries BOTH keys (``image_store.py``): the model
    reads the index off the rendered line and passes it to
    ``view_knowledge_image``, which then shows the embedded image itself rather
    than a render of the page around it, and an index with no stored key names
    nothing.
    """
    index = metadata.get("stored_image_index")
    if index is None or not metadata.get("image_key"):
        return None
    try:
        return int(index)
    except (TypeError, ValueError):
        logger.warning("Ignoring unreadable stored_image_index %r", index)
        return None


def _metadata_text(value: object) -> str | None:
    """A chunk-metadata value as the string a grounding block states, or ``None``."""
    return str(value) if value else None


def _grounding_hit(chunk, *, resolved, resolved_titles, resolved_folders, ambiguous: set[str]):
    """One retrieval chunk as the RECORD a grounding block is made of (ADR-0061).

    The single place a chunk becomes citable fields, so the header lines, the
    Trace-Lanes fan-out and the citation registry cannot disagree about a hit's
    shelf, Dokumentart or title. Three fields are resolved against the document
    metadata store rather than chunk metadata (``doc_class``, ``display_title``,
    ``folder_path``): the store is authoritative and a folder rename must take
    effect with no re-ingest (ADR-0049).
    """
    from aiq_agent.common.grounding_block import GroundingHit

    metadata = chunk.metadata or {}
    shelf = _chunk_shelf(chunk)
    page = chunk.page_number if chunk.page_number and chunk.page_number > 0 else None
    content = chunk.content
    truncated = len(content) > _CHUNK_TRUNCATE_CHARS
    return GroundingHit(
        citation_key=_citation_key_for(chunk.file_name, shelf, page, ambiguous),
        file_name=chunk.file_name,
        page=page,
        shelf=shelf,
        collection=_metadata_text(metadata.get("collection")),
        doc_class=_hit_doc_class(chunk, resolved),
        display_title=_hit_display_title(chunk, resolved_titles) or chunk.file_name,
        folder_path=_hit_folder_path(chunk, resolved_folders),
        punkt=_metadata_text(metadata.get("punkt_id")),
        score=chunk.score,
        content_type=chunk.content_type.value,
        provenance=_hit_provenance(chunk),
        stored_image_index=_stored_image_index(metadata),
        status_note=None,
        source_url=None,
        body=content[:_CHUNK_TRUNCATE_CHARS] if truncated else content,
        body_truncated=truncated,
    )


def _grounding_hits(chunks) -> tuple:
    """Every chunk of one result set as a record.

    The three store reads are batched once per result set (one query per
    in-scope collection), and which filenames are ambiguous is a property of
    the whole set, so both belong here rather than in the per-chunk builder.
    """
    resolved = _resolve_doc_classes(chunks)
    resolved_titles = _resolve_display_titles(chunks)
    resolved_folders = _resolve_folder_paths(chunks)
    ambiguous = _ambiguous_file_names(chunks)
    return tuple(
        _grounding_hit(
            chunk,
            resolved=resolved,
            resolved_titles=resolved_titles,
            resolved_folders=resolved_folders,
            ambiguous=ambiguous,
        )
        for chunk in chunks
    )


def _format_results(
    retrieval_result,
    query: str,
    notice: str = "",
    trailer: str = "",
    preamble_note: str = "",
    opened_files: frozenset[str] = frozenset(),
) -> str:
    """Build this result set's grounding hits and render them for the LLM.

    The layout itself lives in
    :func:`~aiq_agent.common.grounding_block.render_grounding_block`, which also
    files the records under the hash of the bytes it returns, so the citation
    registry reads fields rather than re-parsing this text (ADR-0061). That is
    why both decorations are rendered here and neither is glued on by the
    caller: a byte added after rendering changes the hash, and the reader would
    fall back to parsing the text. ``notice`` is what the model must read before
    the results (the requery widening, a family overview that could not be
    built) and goes ahead of everything; ``trailer`` is ``read_passage``'s
    ``## Gliederung`` index and follows the fan-out.

    ``preamble_note`` is what the CALL was, when that is more than a count: the
    family a family-shaped query resolved to, and where its parts sit in the
    results. It is a second preamble line, so a result set without one renders
    byte-for-byte as before.
    """
    # The two answers below carry no block, so they carry no hash to protect
    # either; there the trailer is simply appended, which keeps it stated
    # whichever answer this call has.
    tail = f"\n{trailer}" if trailer else ""

    # Check for retrieval errors and surface them to the agent
    # getattr: callers pass duck-typed result-likes (e.g. SimpleNamespace in
    # tests) that may not carry the optional error_message field.
    if not retrieval_result.success:
        error_msg = getattr(retrieval_result, "error_message", None) or "Unknown error"
        return f"Knowledge retrieval failed: {error_msg}\n\nQuery: '{query}'{tail}"

    # Degraded partial retrieval (e.g. the base corpus dropped out on an
    # embedding-fingerprint mismatch while other layers survived): the chunks
    # below are real, but they are NOT the full corpus. Without this banner the
    # LLM reads a partial answer as a complete one.
    degraded_detail = getattr(retrieval_result, "error_message", None)
    degraded_banner = notice + (f"WARNING: {degraded_detail}\n\n" if degraded_detail else "")

    if not retrieval_result.chunks:
        return f"{degraded_banner}No relevant documents found for query: '{query}'{tail}"

    from aiq_agent.common.grounding_block import GroundingBlock
    from aiq_agent.common.grounding_block import render_grounding_block

    hits = _grounding_hits(retrieval_result.chunks)
    preamble = f"Found {len(hits)} relevant document(s):"
    return render_grounding_block(
        GroundingBlock(
            preamble=f"{preamble}\n{preamble_note}" if preamble_note else preamble,
            degraded_banner=degraded_banner,
            hits=hits,
            # Fan-out summary for the Herleitung UI, from the same records the
            # header lines state.
            lanes=_trace_lanes_for_hits(hits, opened_files),
            trailer=trailer,
        )
    )


#: The one line the model reads when the overview raised. Without it a family
#: question answered by ranked passages is indistinguishable from an ordinary
#: two-document search, in the result and in the Herleitung built from it. It
#: names the way back rather than an instruction: the parts are still readable,
#: one call each.
_FAMILY_OVERVIEW_FAILED_NOTICE = (
    "Hinweis: der Überblick über die Teile der OIB-Richtlinie {key} konnte nicht erstellt werden; "
    "es folgen nur die gerankten Treffer, die Teile sind einzeln mit `read_passage(document=…)` "
    "zu öffnen.\n\n"
)


@dataclass(frozen=True, slots=True)
class _FamilyBranch:
    """What the family branch produced: an overview, or the fact that it broke.

    "This query names no family the corpus holds" and "the overview raised"
    both used to arrive as ``None``, so the tool result could not say which had
    happened, and neither could a trace of it.
    """

    overview: Any = None
    failed: bool = False


#: No family branch ran: an ordinary search, with nothing to say about one.
_NO_FAMILY_BRANCH = _FamilyBranch()

#: Ranked passages kept BESIDE a family overview. The overview already opens
#: every part at its Geltungsbereich and lists its Gliederung; the ranked
#: search around it is context, not the answer. Measured on „Was weißt du über
#: die OIB 2?" (2026-09-23, live): with the full sixteen, the block was 25.5k
#: characters (~7.4k tokens), half of it Leitfaden and Erläuterungen excerpts
#: that an overview answer never cites, re-sent on every later call of the turn.
_FAMILY_RANKED_HITS = 4


async def _family_branch(entries, family_key: str) -> _FamilyBranch:
    """The family branch, fail-open: a broken overview keeps the ordinary search.

    Imported here rather than at module scope because ``read_passage`` imports
    this module back; both directions are function-scoped, so neither package
    can be half-initialised by the other.
    """
    from .read_passage import FamilyUnreadable
    from .read_passage import family_overview

    try:
        return _FamilyBranch(overview=await family_overview(entries, family_key))
    except FamilyUnreadable as exc:
        logger.warning("Family overview skipped for Richtlinie %s: %s", family_key, exc)
        return _FamilyBranch(failed=True)
    except Exception:  # noqa: BLE001 — the ranked passages are always a valid answer
        logger.warning("Family overview skipped for Richtlinie %s", family_key, exc_info=True)
        return _FamilyBranch(failed=True)


def _without_chunks(chunks, exclude) -> list:
    """``chunks`` minus every chunk ``exclude`` already carries, by chunk id.

    A scope passage the search ALSO ranked is one passage, and rendering it
    twice would spend a result slot on a repeat and offer the model two
    citation keys for one text.
    """
    taken = {getattr(chunk, "chunk_id", None) for chunk in exclude}
    taken.discard(None)
    return [chunk for chunk in chunks if getattr(chunk, "chunk_id", None) not in taken]


def _normalized_query_for_span(text: str) -> str:
    """Latency-span form of a query: whitespace-folded, casefolded.

    Local (not imported) so the span path never depends on the judge module:
    tracing must stay up when the loop module cannot be imported. Mirrors
    ``knowledge_layer.requery._normalised``.
    """
    import re as _re

    try:
        return _re.sub(r"\s+", " ", str(text or "")).strip().casefold()
    except Exception:
        return ""


def _citation_key_for_span(chunk) -> str | None:
    """The citation key a returned chunk will be cited by, for the span.

    Mirrors ``_format_results`` without its shelf-qualification: the span
    needs a stable per-fetch key loop_eval can count (repeat_query,
    cross_turn, family_overlap), not the rendering. Prefers the stored
    display citation when the backend populated it. Never raises.
    """
    try:
        stored = getattr(chunk, "display_citation", None)
        if isinstance(stored, str) and stored.strip():
            return " ".join(stored.split())
        name = getattr(chunk, "file_name", None) or ""
        page = getattr(chunk, "page_number", None)
        if not name:
            return None
        if isinstance(page, int) and page > 0:
            return f"{name}, p.{page}"
        return str(name)
    except Exception:
        return None


def _current_span_round() -> int | None:
    """The retrieval round this fetch runs in, or ``None`` when unstamped.

    Fail-open: instrumentation never breaks the search.
    """
    try:
        from aiq_agent.common.turn_status import current_retrieval_round

        return current_retrieval_round()
    except Exception:
        return None


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

    # The retrieval loop's judge (fail-open the same way). Shares the reranker's
    # handle when the config names the same model, which is the reference setup.
    requery_llm_obj = None
    if config.requery_llm:
        if config.requery_llm == config.rerank_llm and rerank_llm_obj is not None:
            requery_llm_obj = rerank_llm_obj
        else:
            from aiq_agent.common import get_langchain_llm

            try:
                requery_llm_obj = await get_langchain_llm(_builder, config.requery_llm)
                logger.info("Resolved requery model: %s", config.requery_llm)
            except Exception as e:
                logger.warning(f"Could not resolve requery_llm '{config.requery_llm}', retrieval loop disabled: {e}")

    # Cross-encoder reranking, when configured. Primary when present; the LLM judge
    # above stays as the fallback. Returns None (never raises) for 'none', an unknown
    # provider, or a key that does not resolve. Built once at startup with no
    # organization in scope, which is why the KEY is no longer decided here: the
    # handle resolves its credential per search from the turn's organization, so
    # a BYOK org's reranks go out on its own key
    # (``cross_encoder.CrossEncoderReranker._credential_for_search``). The
    # platform key still has to resolve at startup, because a handle that could
    # never authenticate anything is one this returns None for.
    cross_encoder = None
    try:
        from knowledge_layer.cross_encoder import resolve_cross_encoder

        cross_encoder = resolve_cross_encoder(config.reranker_provider, model=config.reranker_model)
    except Exception as e:
        logger.warning(f"Cross-encoder reranker unavailable ({type(e).__name__}: {e}); using the LLM judge")

    # HyDE-as-channel (backlog item 14, experiment, default off): the draft
    # reuses the resolved rerank handle — temperature-0, reasoning-free, the
    # shape a hypothetical-passage probe wants — so this adds no model
    # plumbing and re-points no model. Without that handle the channel is
    # silently off, however the flag is set.
    hyde_armed = bool(config.hyde_enabled and rerank_llm_obj is not None)
    logger.info(
        "HyDE channel: %s",
        "armed (draft via rerank_llm)" if hyde_armed else "disabled",
    )

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
        folder: str | None = None,
        conclusion: str = "",
    ) -> str:
        """Read and cite passages from the ingested knowledge base.

        Args:
            query (str): The fact or passage you need, rewritten as a search
                query (topic + jurisdiction + implied year). Not the raw user
                message.
            conclusion (str): ONE sentence: what you now know and what you
                still need, which is why you are making this call. Empty on
                your first call of the turn, when you know nothing yet. It is
                the Herleitung checkpoint the reader sees above this fetch; it
                does not change what is searched and does not belong in your
                answer.
            file_name (str | None): Indexed file name to read (from the
                inventory or the user). Never invent a name. Base-corpus
                files are not listed in the inventory — filter those with
                `doc_class` instead.
            doc_class (str | None): Dokumentart key (e.g. "oib_richtlinie",
                "gesetz"). Store-authoritative; reclassifications apply
                without re-ingest.
            title_contains (str | None): Case-insensitive substring of the
                file name OR display title.
            folder (str | None): Project folder path to read within, exactly as
                the inventory prints it after "Ordner:" (e.g.
                "Brandschutz/Fluchtwege"). Includes everything filed beneath it,
                so "Brandschutz" also reads "Brandschutz/Fluchtwege". Never
                invent a folder.
            filters (dict | None): Rare. Metadata filter on the base
                collection only (e.g. {"content_type": "text"}). Session and
                project collections are never filtered.

        Returns:
            str: Numbered excerpts with a Citation key to copy verbatim.
        """
        # `conclusion` is deliberately unread HERE. It is a checkpoint channel,
        # not a retrieval parameter: the researcher's agent node reads it off
        # the tool CALL (`turn_status.emit_retrieval`) before this coroutine
        # runs, and it must not influence what is searched — a sentence that
        # changed the result would make the Herleitung a cause instead of a
        # record of one.
        query = (query or "").strip()
        file_name = (file_name or "").strip() or None
        title_contains = (title_contains or "").strip() or None
        folder = (folder or "").strip().strip("/") or None
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
        narrowed = bool(doc_class or title_contains or file_name or folder)
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
        # only weakly by embedding and not at all lexically. Measured on the golden
        # set, an English question scored MRR 0.276 against 0.605 for the same
        # question in German, and prepending the corpus's own German terms lifted it
        # to 0.502 -- about two thirds of the gap, mostly as recall (R@16 0.73 ->
        # 0.95), which is the part the reranker downstream can still use. A German
        # query is returned untouched, so this is a no-op for the language the corpus
        # is written in.
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

        # A query that names a Richtlinie and nothing else asks about the whole
        # FAMILY, and OIB 2 is four documents. Ranked passages answer that with
        # whichever two scored best, and the model cannot ask for the parts it
        # does not know exist, so this reads every member's scope and
        # Gliederung BESIDE the search and renders both in one block.
        # `file_name=` and `folder=` are the caller narrowing to one document,
        # which is the opposite request.
        from aiq_agent.common.norm_registry import family_query_number

        family_key = None if (file_name or folder) else family_query_number(query)
        family_task = asyncio.create_task(_family_branch(target_collections, family_key)) if family_key else None

        # Per-turn requery budget: one firing per turn. Reset per turn id when
        # the NAT context states one (user message id), falling back to the
        # executing-round stamp (round zero opens a new turn); unstamped
        # callers (tests, standalone) get a slot rather than inheriting a
        # spent cap. Fail-open when neither is visible.
        span_round = _current_span_round()
        try:
            from knowledge_layer.requery import reset_requery_slot_for_turn

            reset_requery_slot_for_turn(span_round)
        except Exception:
            logger.debug("Requery slot reset skipped", exc_info=True)

        async def _retrieve_collection(entry, search_query: str = retrieval_query):
            coll = entry.collection
            # File exclusions + caller filters apply to the base collection only;
            # session/project collections are user content and are never filtered.
            coll_filters = _base_collection_filters(config, filters) if coll == base_collection else None
            result = await retriever.retrieve(
                query=search_query, collection_name=coll, top_k=candidate_k, filters=coll_filters
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
            # The HyDE draft (when armed) is drafted BESIDE that fan-out, so a fast
            # draft costs no latency; a slow one reads as no draft (fail-open) and
            # the search below is exactly the baseline. return_exceptions=True also
            # covers the draft slot, so the probe can never break the search.
            gathered = await asyncio.gather(
                *(_retrieve_collection(entry) for entry in target_collections),
                _draft_hyde_text(
                    rerank_llm_obj,
                    query,
                    enabled=config.hyde_enabled,
                    timeout_seconds=config.hyde_timeout_seconds,
                ),
                return_exceptions=True,
            )
            *results, hyde_text = gathered
            if isinstance(hyde_text, Exception) or not hyde_text:
                hyde_text = None

            hyde_results: list = []
            if hyde_text:
                # One extra RRF channel per collection, APPENDED after the
                # original query's channels so the question as asked keeps the
                # tie-break seat (same convention as the requery widening
                # below). The draft goes through the SAME retrieve path — same
                # embedding model and fingerprint chain, same filters, same
                # hybrid boost — and is discarded right after: it never reaches
                # the reranker (which judges the original query) or the
                # formatted answer. Any fan-out failure keeps the first pool.
                try:
                    hyde_results = await asyncio.gather(
                        *(_retrieve_collection(entry, hyde_text) for entry in target_collections),
                        return_exceptions=True,
                    )
                    logger.info(
                        "HyDE channel widened the pool with a %d-char draft for %r",
                        len(hyde_text),
                        query[:60],
                    )
                except Exception:  # noqa: BLE001 - the first ranking is always a valid answer
                    logger.warning("HyDE fan-out failed; keeping the first pool", exc_info=True)
                    hyde_results = []

            # Merge by cross-collection rank fusion (scores are NOT comparable across
            # collections). `results` is in `target_collections` order, which is the
            # channel order the fusion breaks exact ties by.
            #
            # The per-document diversity cap is NOT applied here. This merge builds the
            # CANDIDATE pool (`candidate_k`, 60 under the reference config), and a cap
            # measured against that budget decides nothing: with one collection in scope
            # the pool is at most `candidate_k` long, the soft fill returns everything,
            # and the final trim to `top_k` below applied no cap at all -- one PDF could
            # fill all sixteen answer slots while the tool description promised five.
            # The cap belongs on the ANSWER budget, after the reranker has had the whole
            # pool to judge (rag-system-audit-2026-08 F16), so it is applied below.
            # HyDE channels ride along EMPTY by default and appended after the
            # originals when the probe fired, so the baseline order is untouched
            # unless the experiment added a real channel.
            merged = _merge_results(
                [*results, *hyde_results], query, candidate_k, retriever.backend_name, max_per_document=0
            )

            # Agentic narrowing, then trim to the effective top_k.
            # `file_name=` is a FILTER, not a preference: the agent named a
            # file, so other hits would be a silent bait-and-switch.
            def _narrowed(pool):
                if doc_class or title_contains or file_name or folder:
                    return _apply_agent_filters(
                        pool.chunks,
                        doc_class=doc_class,
                        title_contains=title_contains,
                        file_name=file_name,
                        folder=folder,
                    )
                return pool.chunks

            merged = merged.model_copy(update={"chunks": _narrowed(merged)})

            # Reranking: cross-encoder first when configured, LLM judge as the
            # fallback (fail-open: any error keeps the fused order).
            async def _reranked(chunks):
                if rerank_llm_obj is None and cross_encoder is None:
                    return chunks
                from knowledge_layer.rerank import rerank_chunks

                # Never trim below what the caller is about to ask for. `top_k` is
                # admin-tunable at runtime (up to 50) while `rerank_candidates` is a
                # build-time YAML value, so raising Platform -> Retrieval top_k above
                # rerank_candidates used to cap every search at rerank_candidates with
                # no error — the "must exceed top_k" invariant was documented in a
                # comment and enforced nowhere.
                rerank_top_n = max(effective_top_k, config.rerank_candidates)
                return await rerank_chunks(
                    rerank_llm_obj,
                    query,
                    chunks,
                    top_n=rerank_top_n,
                    cross_encoder=cross_encoder,
                )

            # The retrieval loop (rag-system-audit-2026-08 F13). The judge reads
            # the head of the fused pool BESIDE the reranker rather than before
            # it, so a pool that is sufficient — the common case — pays nothing
            # for having been judged. Only an insufficient verdict costs a second
            # round: the proposed formulations are retrieved from every collection
            # in scope, fused into the SAME RRF as new channels (a chunk two
            # queries agree on rises, one only a paraphrase found enters), and the
            # widened pool is reranked once more. Never raises: the judge fails
            # open to "sufficient", and a failed fan-out keeps the first ranking.
            #
            # Latency gate: the judge is skipped when the first pool already
            # answers (decisively strong scores, or a known-entity/family
            # lookup), and the turn fires at most ONCE no matter what the judge
            # says — on lookups the verdict manufactures the second round.
            requery_skipped_reason: str | None = None

            async def _judged(chunks):
                nonlocal requery_skipped_reason
                # A search pinned to one document is a precision lookup — the
                # caller knows where the passage is and wants that passage.
                # Paraphrasing it across every collection in scope is the
                # opposite of what was asked, and every document it drags in
                # lands in the Herleitung as "read".
                if requery_llm_obj is None or file_name:
                    if file_name:
                        requery_skipped_reason = "file_pinned"
                    return None
                try:
                    from knowledge_layer.requery import requery_already_fired
                    from knowledge_layer.requery import should_skip_judge

                    if family_key:
                        # An overview question is answered by the overview. The
                        # judge's own criterion counts a scope note and a
                        # Gliederung as NOT answering, so on this shape it said
                        # "insufficient" by construction and fanned out two more
                        # retrievals into a block that already held every part.
                        requery_skipped_reason = "family"
                        logger.info("Retrieval loop judge skipped (family) for %r", query[:60])
                        return None
                    if requery_already_fired():
                        requery_skipped_reason = "already_fired"
                        logger.info("Retrieval loop judge skipped (already_fired) for %r", query[:60])
                        return None
                    skip, reason = should_skip_judge(
                        query,
                        chunks,
                        file_name=file_name,
                        doc_class=doc_class,
                        title_contains=title_contains,
                        folder=folder,
                        embedding_model=getattr(retriever, "embed_model_name", None),
                    )
                    if skip:
                        requery_skipped_reason = reason
                        logger.info("Retrieval loop judge skipped (%s) for %r", reason, query[:60])
                        return None
                except Exception:
                    logger.debug("Requery gate failed open to the judge", exc_info=True)
                from knowledge_layer.requery import judge_sufficiency

                return await judge_sufficiency(
                    requery_llm_obj,
                    query,
                    chunks,
                    max_queries=config.requery_max_queries,
                    decider=config.requery_decider,
                    decision_threshold=config.decision_sufficiency_threshold,
                )

            reranked, verdict = await asyncio.gather(_reranked(merged.chunks), _judged(merged.chunks))
            requery_queries: list[str] = []
            requery_fired = False
            if verdict is not None and verdict.wants_requery:
                try:
                    from knowledge_layer.requery import claim_requery_slot

                    if not claim_requery_slot():
                        requery_skipped_reason = "already_fired"
                        logger.info(
                            "Retrieval loop requery suppressed (already_fired): "
                            "one firing per turn already spent, keeping the first pool"
                        )
                    else:
                        from aiq_agent.common.turn_status import emit_retrieval_requery

                        emit_retrieval_requery(query_count=len(verdict.queries))
                        extra = await asyncio.gather(
                            *(
                                _retrieve_collection(entry, alternative)
                                for alternative in verdict.queries
                                for entry in target_collections
                            ),
                            return_exceptions=True,
                        )
                        # The original query's channels stay first: RRF breaks exact
                        # ties by channel order, and the question as asked keeps the
                        # tie-break seat over any rewording of it.
                        widened = _merge_results(
                            [*results, *extra], query, candidate_k, retriever.backend_name, max_per_document=0
                        )
                        widened = widened.model_copy(update={"chunks": _narrowed(widened)})
                        reranked = await _reranked(widened.chunks)
                        merged = widened
                        requery_queries = list(verdict.queries)
                        requery_fired = True
                        logger.info(
                            "Retrieval loop widened the pool with %d alternative quer(y/ies) to %d candidate(s)",
                            len(requery_queries),
                            len(merged.chunks),
                        )
                except Exception:  # noqa: BLE001 - the first ranking is always a valid answer
                    logger.warning("Retrieval loop fan-out failed; keeping the first pool", exc_info=True)
            merged = merged.model_copy(update={"chunks": reranked})

            # Diversity cap on the ANSWER budget, in whatever order survived reranking
            # (or the fused order when no reranker is configured). Soft, as the tool
            # description promises: at most `max_chunks_per_document` per document
            # where possible, filled back from the deferred ranks when there are not
            # enough distinct documents. With the cap disabled this is the plain trim.
            pre_cap_count = len(merged.chunks)
            capped = _apply_diversity_cap(merged.chunks, effective_top_k, effective_max_per_document)
            dropped_by_cap = max(0, pre_cap_count - len(capped))
            merged = merged.model_copy(update={"chunks": capped})

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
            dropped_by_floor = 0
            if floor_pct > 0:
                floor = floor_pct / 100.0
                before_floor = len(merged.chunks)
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
                    dropped_by_floor = before_floor - len(kept)
                merged = merged.model_copy(update={"chunks": kept})

            # The family's members go in FRONT of the ranked passages, and after
            # the cap and the floor: they are addressed, not ranked, so neither
            # budget decides whether a part of the Richtlinie is shown. A
            # passage the search also found is one passage, not two.
            branch = await family_task if family_task is not None else _NO_FAMILY_BRANCH
            overview = branch.overview
            if not merged.success:
                # A fan-out that FAILED is reported as a failure. Decorating it
                # with an overview would render a complete-looking block over a
                # corpus that answered nothing.
                overview = None
            family_note = overview.preamble if overview is not None else ""
            if overview is not None:
                ranked = _without_chunks(merged.chunks, overview.chunks)[:_FAMILY_RANKED_HITS]
                merged = merged.model_copy(update={"chunks": [*overview.chunks, *ranked]})

            # The picking, as a first-class observation (ADR-0044): one
            # `retrieve.knowledge_search` span carrying query, collections,
            # budgets and the picked chunk ids/files/scores — metadata only,
            # never chunk text. Emitted BEFORE the empty-result return so a
            # search that found nothing is visible as its own fact rather
            # than indistinguishable from a turn that never searched.
            from aiq_agent.observability.retrieval_trace import build_retrieval_input
            from aiq_agent.observability.retrieval_trace import build_retrieval_output
            from aiq_agent.observability.retrieval_trace import emit_retrieval_span

            try:
                search_input = build_retrieval_input(
                    query=query,
                    retrieval_query=retrieval_query,
                    collections=target_collections,
                    candidate_k=candidate_k,
                    top_k=effective_top_k,
                    reranked=rerank_llm_obj is not None or cross_encoder is not None,
                    dropped_by_floor=dropped_by_floor,
                    requery_queries=requery_queries,
                )
                # Per-fetch latency instrumentation (additive only; no behavior
                # change — tracing must never break the search). These are the
                # fields loop_eval counts double-fetch rates off: which round
                # and tool fetched, the normalized query to spot repeat_query,
                # the locator args to spot locator_eligible, the returned
                # citation keys to spot cross_turn/family_overlap, and the
                # requery/cap/refusal flags to spot cap_retry/repair_fetch.
                # No usage/cost telemetry by design: counts and keys only.
                try:
                    search_input["round"] = span_round
                    search_input["tool"] = "knowledge_search"
                    search_input["normalized_query"] = _normalized_query_for_span(query)
                    if file_name:
                        search_input["file_name"] = file_name
                    if doc_class:
                        search_input["doc_class"] = doc_class
                    if title_contains:
                        search_input["title_contains"] = title_contains
                    if folder:
                        search_input["folder"] = folder
                    if requery_skipped_reason:
                        search_input["requery_skipped"] = requery_skipped_reason
                    search_input["requery_fired"] = bool(requery_fired)
                    if dropped_by_cap:
                        search_input["dropped_by_cap"] = dropped_by_cap
                    if not merged.chunks:
                        search_input["empty"] = True
                    if getattr(merged, "error_message", None):
                        search_input["degraded"] = True
                    if not getattr(merged, "success", True):
                        search_input["refused"] = True
                except Exception:
                    logger.debug("Retrieval span enrichment skipped", exc_info=True)
                picks = build_retrieval_output(chunks=merged.chunks)
                try:
                    keys = [_citation_key_for_span(chunk) for chunk in merged.chunks]
                    keys = [key for key in keys if key]
                    if keys:
                        picks["citation_keys"] = keys
                    punkt_ids = [(getattr(chunk, "metadata", None) or {}).get("punkt_id") for chunk in merged.chunks]
                    punkt_ids = [str(value) for value in punkt_ids if value]
                    if punkt_ids:
                        picks["punkt_ids"] = punkt_ids
                except Exception:
                    logger.debug("Retrieval picks enrichment skipped", exc_info=True)
                emit_retrieval_span(
                    tool_name="knowledge_search",
                    search_input=search_input,
                    picks=picks,
                )
            except Exception:  # noqa: BLE001 - tracing must never break the search path
                logger.debug("Retrieval pick span failed", exc_info=True)

            # The widening, said out loud to the model that asked for the search
            # (roadmap: "hidden loops the model does not own"). Empty for the
            # one-shot search every other turn runs, and carried on the
            # empty-result message too: a search that widened AND still found
            # nothing is the case where the model most needs to know that its
            # own formulation was already given a second chance.
            from knowledge_layer.requery import requery_notice

            notice = requery_notice(requery_queries)
            # The overview raised, and the passages below are what is left of
            # the family question. Said only where there ARE passages: an empty
            # or failed search already tells the model the stronger thing.
            if branch.failed and merged.chunks:
                notice += _FAMILY_OVERVIEW_FAILED_NOTICE.format(key=family_key)

            # After the floor, not before: the floor is the only thing that can empty a
            # non-empty result set, and this message is the vocabulary for saying so.
            # A failed or degraded merge is NOT a miss: total fingerprint loss comes
            # back as success=False, partial loss as error_message set — both must
            # reach `_format_results`, which renders the failure/warning, rather
            # than the retry-hint below, which would read as "nothing matched".
            from aiq_agent.common.turn_status import KNOWLEDGE_SEARCH_TOOL
            from aiq_agent.common.turn_status import lane_tool_scope

            if not merged.chunks:
                if not merged.success or getattr(merged, "error_message", None):
                    with lane_tool_scope(KNOWLEDGE_SEARCH_TOOL):
                        return notice + _format_results(merged, query)
                return notice + _empty_search_message(
                    query,
                    file_name=file_name,
                    doc_class=doc_class,
                    title_contains=title_contains,
                    folder=folder,
                )

            # Format for LLM. _format_results does the (now batched, 1-3 query)
            # doc_class resolution plus pure-CPU string building; run it off the
            # event loop so the synchronous DB round-trips never block the loop
            # (and stall other concurrent turns).
            #
            # The lane-tool scope is entered HERE, outside the await, not inside
            # `_format_results`: `asyncio.to_thread` copies the context when the
            # call is made, so a scope opened in the worker thread would be a
            # copy nobody reads back. The family branch renders through this
            # same call, so it is stamped with it.
            with lane_tool_scope(KNOWLEDGE_SEARCH_TOOL):
                formatted = await asyncio.to_thread(
                    _format_results,
                    merged,
                    query,
                    notice,
                    overview.trailer if overview is not None else "",
                    family_note,
                    overview.opened_files if overview is not None else frozenset(),
                )
            logger.info(f"Knowledge search returned {len(merged.chunks)} chunks")
            logger.debug(f"Formatted result for LLM:\n{formatted[:500]}...")
            return formatted

        except Exception as e:
            from aiq_agent.common.turn_status import FETCH_FAILED_MARKER

            logger.error(f"Knowledge search failed: {e}")
            # The marker is load-bearing, not decoration: the agent's
            # duplicate-fetch guard reads it to tell a failed call from a
            # fetched one, so the retry this sentence asks for is not
            # withheld as a repeat (`FETCH_FAILED_MARKER`).
            return (
                f"{FETCH_FAILED_MARKER} Knowledge search failed for query={query!r}. "
                "Retry once with the same query; if it fails again, say you "
                "could not search the knowledge base and do not invent a citation. "
                f"Technical detail: {e}"
            )
        finally:
            # An answer that returned before the family read was awaited leaves
            # a task holding a store fetch. Cancelling it here is what keeps the
            # concurrency free: nothing outlives the call it was started for.
            if family_task is not None and not family_task.done():
                family_task.cancel()

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
