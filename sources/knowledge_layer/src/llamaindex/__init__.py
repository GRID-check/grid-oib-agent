"""
LlamaIndex Knowledge Adapter.

Lightweight, no-deployment RAG using ChromaDB + NVIDIA embeddings.
Supports multimodal extraction (text, tables, charts, images).
"""

from .adapter import LlamaIndexIngestor
from .adapter import LlamaIndexRetriever
from .adapter import list_collections

__all__ = ["LlamaIndexIngestor", "LlamaIndexRetriever", "list_collections"]
