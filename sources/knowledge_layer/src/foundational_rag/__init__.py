"""
Foundational RAG adapter for deployed NVIDIA RAG Blueprint endpoints.

This adapter makes HTTP calls to a deployed NVIDIA RAG Blueprint server,
enabling the Knowledge Layer to work with remote ingestion and retrieval services.

Prerequisites:
    Deploy the NVIDIA RAG Blueprint first:
    https://github.com/NVIDIA-AI-Blueprints/rag/blob/main/docs/deploy-docker-self-hosted.md
"""

from .adapter import FoundationalRagIngestor
from .adapter import FoundationalRagRetriever

__all__ = ["FoundationalRagIngestor", "FoundationalRagRetriever"]
