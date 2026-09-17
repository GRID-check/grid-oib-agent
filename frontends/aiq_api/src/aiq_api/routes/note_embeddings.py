"""Embeddings for SHORT NOTES — memory items and platform lessons.

The knowledge layer embeds documents; nothing embedded the other half of the
system's knowledge, so both note stores deduplicated and recalled lexically:
project memory by a 200-row Jaccard scan (memory-system-audit-2026-07 F2/F3)
and the lesson register by a rank-ordered window. Neither survives paraphrase —
"der Bauherr wünscht ein Flachdach" and "Flachdach ist gewünscht" score 0.0 —
which is exactly the case both stores exist to collapse.

This route is the seam that fixes it: the BFF owns the notes (single writer,
tenancy, RLS) and calls here for vectors, which it stores ALONGSIDE the row.
There is no second index and no sync job, deliberately — see
docs/architecture/semantic-notes.md. What the backend contributes is the one
thing it owns: the embedding model, resolved through exactly the same
env/credential chain the document pipeline uses, so notes and documents are
embedded by the same model or not at all.

**The fingerprint is the load-bearing return value.** A vector is only
comparable to vectors from the same model, and a model swap is a config change
away. Every response carries ``fingerprint``; the caller stores it next to the
vector and treats a mismatch as "not embedded yet" rather than comparing across
models — the same rule ``embed_fingerprint_mismatch`` enforces for Chroma
collections, applied to a column.

Never raises and never answers non-200: an unavailable embedder degrades both
callers to their lexical path, which is worse but correct.
"""

import logging

from fastapi import APIRouter
from fastapi import Request

from ..models.requests import NoteEmbeddingRequest
from ..models.requests import NoteEmbeddingResponse
from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)

#: Bounds re-applied here; a route that trusts its caller's bounds is one
#: refactor away from embedding a transcript.
_MAX_TEXTS = 64
_MAX_TEXT_CHARS = 2000


def _clip(value: str) -> str:
    flat = " ".join(value.split())
    return flat[:_MAX_TEXT_CHARS]


def add_note_embedding_routes(router: APIRouter) -> None:
    """Register the note-embedding endpoint."""

    @router.post(
        "/v1/note-embeddings",
        response_model=NoteEmbeddingResponse,
        tags=["platform"],
        summary="Embed short notes (memory items, platform lessons)",
        description=(
            "Batch-embeds short texts with the deployment's configured embedding model "
            "and returns the vectors plus the model fingerprint the caller must store "
            "alongside them."
        ),
    )
    async def note_embeddings(request: NoteEmbeddingRequest, http_request: Request) -> NoteEmbeddingResponse:
        """Embed up to 64 short texts, or say why it could not be done."""
        _require_internal_token(http_request)

        texts = [_clip(text) for text in request.texts[:_MAX_TEXTS] if text and text.strip()]
        if not texts:
            return NoteEmbeddingResponse(vectors=[], fingerprint="", dimensions=0)

        try:
            import asyncio

            from knowledge_layer.llamaindex.adapter import LlamaIndexRetrieverAdapter
            from knowledge_layer.llamaindex.adapter import _resolve_embed_api_key
            from knowledge_layer.llamaindex.adapter import embed_fingerprint

            model = LlamaIndexRetrieverAdapter.DEFAULT_EMBED_MODEL
            base_url = LlamaIndexRetrieverAdapter.DEFAULT_EMBED_BASE_URL
            api_key = _resolve_embed_api_key(base_url, model)
            if not api_key:
                logger.warning("No embeddings API key resolved; notes stay on the lexical path")
                return NoteEmbeddingResponse(vectors=[], fingerprint="", dimensions=0, error="embedder_not_configured")

            from llama_index.embeddings.nvidia import NVIDIAEmbedding

            embedder = NVIDIAEmbedding(base_url=base_url, model=model, api_key=api_key)
            # Synchronous HTTP inside; keep it off the event loop like the
            # retriever's own embed call does.
            vectors = await asyncio.to_thread(embedder.get_text_embedding_batch, texts)
        except ImportError:
            logger.warning("Embedding dependencies unavailable; notes stay on the lexical path")
            return NoteEmbeddingResponse(vectors=[], fingerprint="", dimensions=0, error="embedder_unavailable")
        except Exception:
            logger.exception("Note embedding failed")
            return NoteEmbeddingResponse(vectors=[], fingerprint="", dimensions=0, error="embedding_failed")

        if not vectors or not isinstance(vectors, list) or not vectors[0]:
            return NoteEmbeddingResponse(vectors=[], fingerprint="", dimensions=0, error="embedding_failed")

        return NoteEmbeddingResponse(
            vectors=[[float(value) for value in vector] for vector in vectors],
            fingerprint=embed_fingerprint(model, base_url),
            dimensions=len(vectors[0]),
        )
