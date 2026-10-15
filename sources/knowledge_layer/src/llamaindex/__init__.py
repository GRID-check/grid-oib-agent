"""
LlamaIndex Knowledge Adapter.

LlamaIndex readers and chunking, an OpenAI-compatible embedder, vectors in
Qdrant (ADR-0113). Supports multimodal extraction (text, tables, charts, images).
"""

from .adapter import LlamaIndexIngestor
from .adapter import LlamaIndexRetriever
from .adapter import resolve_vlm_api_key
from .adapter import vlm_configured

__all__ = [
    "LlamaIndexIngestor",
    "LlamaIndexRetriever",
    "resolve_vlm_api_key",
    "vlm_configured",
]
