"""
LlamaIndex Knowledge Adapter.

Lightweight, no-deployment RAG using ChromaDB + NVIDIA embeddings.
Supports multimodal extraction (text, tables, charts, images).
"""

from .adapter import LlamaIndexIngestor
from .adapter import LlamaIndexRetriever
from .adapter import list_collections
from .adapter import resolve_vlm_api_key
from .adapter import vlm_configured

__all__ = [
    "LlamaIndexIngestor",
    "LlamaIndexRetriever",
    "list_collections",
    "resolve_vlm_api_key",
    "vlm_configured",
]
