"""
Knowledge Layer - Universal RAG interfaces and schemas.

This module defines the foundational abstractions for knowledge ingestion and retrieval.
All backend adapters (LlamaIndex, Foundational RAG, etc.) must implement these interfaces
and output data conforming to these schemas.

Architecture:
    src/aiq_agent/knowledge/      # Core abstractions
    ├── schema.py                # Data models (Chunk, RetrievalResult, etc.)
    ├── base.py                  # Abstract interfaces (BaseRetriever, BaseIngestor)
    └── factory.py               # Registry + factory pattern

    sources/knowledge_layer/src/ # Backend implementations
    ├── llamaindex/              # ChromaDB + NVIDIA embeddings
    ├── nvingest/                # Milvus + NV-Ingest pipeline
    └── foundational_rag/        # Hosted RAG Blueprint

Usage:
    from aiq_agent.knowledge import Chunk, BaseRetriever, get_retriever
"""

from .base import BaseIngestor
from .base import BaseRetriever
from .factory import clear_active_ingestor
from .factory import clear_active_retriever
from .factory import clear_all_summaries
from .factory import clear_collection_summaries
from .factory import configure_summary_db
from .factory import get_active_ingestor
from .factory import get_active_retriever
from .factory import get_available_documents
from .factory import get_available_documents_async
from .factory import get_document_display_title
from .factory import get_document_display_titles
from .factory import get_document_doc_class
from .factory import get_ingestor
from .factory import get_retriever
from .factory import list_summary_collections
from .factory import register_ingestor
from .factory import register_retriever
from .factory import register_summary
from .factory import set_active_ingestor
from .factory import set_active_retriever
from .factory import set_document_display_title
from .factory import set_document_doc_class
from .factory import unregister_summary
from .factory import update_document_tags
from .inventory import allocate_inventory
from .inventory import listing_intent_override
from .inventory import render_inventory_block
from .inventory import shelf_hint_from_query
from .schema import AvailableDocument
from .schema import Chunk
from .schema import ContentType
from .schema import FileProgress
from .schema import IngestionJobStatus
from .schema import JobState
from .schema import RetrievalResult

__all__ = [
    # Schema
    "AvailableDocument",
    "Chunk",
    "ContentType",
    "FileProgress",
    "IngestionJobStatus",
    "JobState",
    "RetrievalResult",
    # Base classes
    "BaseRetriever",
    "BaseIngestor",
    # Factory
    "get_retriever",
    "get_ingestor",
    "register_retriever",
    "register_ingestor",
    # Active ingestor (for Knowledge API)
    "get_active_ingestor",
    "set_active_ingestor",
    "clear_active_ingestor",
    # Active retriever (for Knowledge API — document search)
    "get_active_retriever",
    "set_active_retriever",
    "clear_active_retriever",
    # Summary Registry (SQLAlchemy-backed, backend-agnostic)
    "configure_summary_db",
    "register_summary",
    "unregister_summary",
    "update_document_tags",
    "set_document_doc_class",
    "get_document_doc_class",
    "set_document_display_title",
    "get_document_display_title",
    "get_document_display_titles",
    "list_summary_collections",
    "get_available_documents",
    "get_available_documents_async",
    "allocate_inventory",
    "listing_intent_override",
    "render_inventory_block",
    "shelf_hint_from_query",
    "clear_collection_summaries",
    "clear_all_summaries",
]
