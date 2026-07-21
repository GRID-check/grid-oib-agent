"""Semantic document-search endpoint.

Deterministic vector search over a single collection's already-embedded chunks
(NO LLM, no agent loop). The low-level structured retriever returns per-chunk
hits; this route aggregates them into a document-centric result — one hit per
file (its best-scoring chunk), sorted by score descending.
"""

import logging

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException

from aiq_agent.knowledge.base import BaseIngestor
from aiq_agent.knowledge.schema import Chunk

from ..models.requests import DocumentSearchHit
from ..models.requests import DocumentSearchRequest
from ..models.requests import DocumentSearchResponse
from .collections import _require_ingestor

logger = logging.getLogger(__name__)

# Max chars kept from a document's best-matching chunk as its snippet.
SNIPPET_MAX_CHARS = 300


def _snippet(content: str, limit: int = SNIPPET_MAX_CHARS) -> str:
    """Truncate chunk content to a short snippet, on a whitespace-trimmed boundary."""
    text = (content or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def _aggregate_hits(chunks: list[Chunk], collection_name: str, top_k_files: int) -> list[DocumentSearchHit]:
    """Group chunks by ``file_name`` and keep each file's max-score chunk.

    Within this one collection ``file_name`` uniquely identifies a document
    (v1), so a repeated filename is the same document — we keep its best-scoring
    chunk as the file's representative hit. Files are sorted by that max score
    descending and capped at ``top_k_files``.
    """
    best_by_file: dict[str, Chunk] = {}
    for chunk in chunks:
        existing = best_by_file.get(chunk.file_name)
        if existing is None or chunk.score > existing.score:
            best_by_file[chunk.file_name] = chunk

    hits = [
        DocumentSearchHit(
            file_name=chunk.file_name,
            score=chunk.score,
            snippet=_snippet(chunk.content),
            page_number=chunk.page_number,
            collection=chunk.metadata.get("collection", collection_name),
        )
        for chunk in best_by_file.values()
    ]
    hits.sort(key=lambda h: h.score, reverse=True)
    return hits[:top_k_files]


def add_document_search_routes(router: APIRouter):
    """Add semantic document-search routes to the FastAPI app."""

    @router.post(
        "/v1/collections/{collection_name}/search",
        response_model=DocumentSearchResponse,
        tags=["documents"],
        summary="Semantic document search within a collection",
    )
    async def search_documents(
        collection_name: str,
        request: DocumentSearchRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> DocumentSearchResponse:
        """Deterministic semantic search over one collection's embedded chunks.

        Retrieves the top ``top_k`` chunks for the query, then aggregates them
        into a document-centric result: one hit per file (its best-scoring
        chunk), sorted by score descending, capped at ``top_k_files``. No LLM or
        agent loop is involved.
        """
        # Verify collection exists (same 404 contract as the document routes).
        collection = ingestor.get_collection(collection_name)
        if collection is None:
            raise HTTPException(status_code=404, detail=f"Collection '{collection_name}' not found")

        try:
            from aiq_agent.knowledge.factory import get_active_retriever

            result = await get_active_retriever().retrieve(
                query=request.query,
                collection_name=collection_name,
                top_k=request.top_k,
                filters=None,
            )
            hits = _aggregate_hits(result.chunks, collection_name, request.top_k_files)
            return DocumentSearchResponse(hits=hits)
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Document search failed for collection '{collection_name}': {e}")
            raise HTTPException(status_code=500, detail=str(e))
