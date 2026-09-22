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
    from .read_passage import ReadPassageConfig
    from .read_passage import read_passage
    from .register import KnowledgeRetrievalConfig
    from .register import knowledge_retrieval
    from .view_image import ViewKnowledgeImageToolConfig
    from .view_image import view_knowledge_image

    __all__ = [
        "KnowledgeRetrievalConfig",
        "knowledge_retrieval",
        "ReadPassageConfig",
        "read_passage",
        "ViewKnowledgeImageToolConfig",
        "view_knowledge_image",
    ]
except ImportError:
    # NAT not installed - skip function registration
    __all__ = []
