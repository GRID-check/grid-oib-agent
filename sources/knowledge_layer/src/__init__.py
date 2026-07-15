"""
Knowledge Layer - Pluggable document ingestion and retrieval.

This package provides NAT tool registrations for knowledge retrieval that can be used
across multiple applications.

Available Backends:
- llamaindex: LlamaIndex + ChromaDB (lightweight, local)
- foundational_rag: Hosted NVIDIA RAG Blueprint (production, multi-user)

Note: NAT tool registrations require NAT to be installed.
The adapter modules can be used standalone without NAT.
"""

# Eagerly import NAT functions to trigger @register_function decorators
try:
    from .register import KnowledgeRetrievalConfig
    from .register import knowledge_retrieval

    __all__ = ["KnowledgeRetrievalConfig", "knowledge_retrieval"]
except ImportError:
    # NAT not installed - skip function registration
    __all__ = []
