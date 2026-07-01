# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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

    targets: list[str] = []
    if config.include_base_collection and config.collection_name:
        targets.append(config.collection_name)
    if config.include_session_collection and session_id:
        targets.append(session_id)
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
        # Build citation string: "filename, p.X" or just "filename"
        if chunk.page_number and chunk.page_number > 0:
            citation = f"{chunk.file_name}, p.{chunk.page_number}"
        else:
            citation = chunk.file_name

        # Header with source info
        lines.append(f"--- Result {i} ---")
        lines.append(f"Source: {chunk.file_name}")
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
        from nat.builder.framework_enum import LLMFrameworkEnum

        summary_llm_obj = await _builder.get_llm(config.summary_model, wrapper_type=LLMFrameworkEnum.LANGCHAIN)
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

    async def search(query: str) -> str:
        """Search for documents relevant to the query.

        Args:
            query (str): Natural language query describing what information you need.

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

        try:
            # Fan out across all layers concurrently; tolerate empty/missing layers.
            results = await asyncio.gather(
                *(
                    retriever.retrieve(query=query, collection_name=coll, top_k=top_k)
                    for coll in target_collections
                ),
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
