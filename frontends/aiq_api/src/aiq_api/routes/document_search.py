"""Semantic document-search endpoint.

Deterministic vector search over a single collection's already-embedded chunks
(NO LLM, no agent loop). The low-level structured retriever returns per-chunk
hits; this route aggregates them into a document-centric result — one hit per
file (its best-scoring chunk), sorted by score descending.
"""

import logging
import os

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Request

from aiq_agent.knowledge.base import BaseIngestor
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.scoping import _normalize_collection_name
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from aiq_agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from aiq_agent.project_context import GridRequestContext

from ..models.requests import DocumentSearchHit
from ..models.requests import DocumentSearchRequest
from ..models.requests import DocumentSearchResponse
from .collections import _require_ingestor

logger = logging.getLogger(__name__)

# Max chars kept from a document's best-matching chunk as its snippet.
SNIPPET_MAX_CHARS = 300


def _require_auth() -> bool:
    """Whether the backend is running in WorkOS-authenticated mode (REQUIRE_AUTH=true).

    Same flag ``plugin.py`` / ``AuthMiddleware`` / the envelope-enforcement
    middleware read. In authenticated deployments the BFF is the only intended
    caller of this route and always forwards a signed collection scope, so a
    request that arrives with no scope is not a legitimate one; in anonymous
    mode (REQUIRE_AUTH=false) there is no tenant boundary to enforce.
    """
    return os.getenv("REQUIRE_AUTH", "false").lower() == "true"


def _verified_collection_scope(http_request: Request) -> list[str] | None:
    """Return the caller's collection scope from the SIGNED request-context envelope.

    Defense-in-depth for cross-tenant reads (PB-SYNTH-4). This route is a plain
    FastAPI route, not a NAT workflow endpoint, so NAT's ``Context.metadata.headers``
    is never populated for it (verified empirically) — ``get_collection_scope_from_context()``
    used by the chat retrieval path would always read ``None`` here. We therefore
    parse the caller's actual HTTP headers with the SAME verified-envelope parser
    that ``get_collection_scope_from_context()`` prefers under the hood
    (``GridRequestContext.from_envelope``), fed the request headers directly.

    Only the HMAC-signed ``X-Grid-Request-Context`` envelope is honored — never
    the raw, forgeable ``X-Grid-Collection-Scope`` header on its own — because
    collection names are guessable (``proj_<uuid>`` / ``archiv_<orgId>``), so an
    attacker who could set a raw scope header would read another tenant's corpus.
    When ``GRID_INTERNAL_API_TOKEN`` is unset (dev), ``from_envelope`` accepts the
    envelope on shape alone, mirroring the rest of the codebase's fail-open dev
    posture. Returns ``None`` when no valid signed envelope is present.
    """
    ctx = GridRequestContext.from_envelope(
        http_request.headers.get(REQUEST_CONTEXT_ENVELOPE_HEADER),
        http_request.headers.get(REQUEST_CONTEXT_ENVELOPE_SIG_HEADER),
        os.environ.get("GRID_INTERNAL_API_TOKEN"),
    )
    if ctx is None:
        return None
    return ctx.collection_scope


def _authorize_collection(http_request: Request, collection_name: str) -> None:
    """Reject a search whose target collection is outside the caller's signed scope.

    Mirrors the chat retrieval authorization boundary (``knowledge/scoping.py``):
    a turn may only read the collections the BFF signed into its request context.
    Enforcement matrix:

    - A valid signed scope is present → the target ``collection_name`` MUST be in
      it, else ``404`` (indistinguishable from a genuinely missing collection, so
      the route never confirms the existence of an out-of-scope/other-tenant
      collection).
    - No signed scope AND ``REQUIRE_AUTH=true`` → ``403``: an authenticated-mode
      deployment's only intended caller (the BFF) always forwards the signed
      scope, so its absence means the request did not come through the trusted
      path.
    - No signed scope AND anonymous mode (``REQUIRE_AUTH=false``) → allowed: there
      is no tenant boundary to enforce (parity with the pre-envelope behavior and
      the envelope-enforcement middleware, which also no-ops when auth is off).

    RESIDUAL TRUST BOUNDARY: this route is deliberately NOT on the
    ``GridContextEnvelopeMiddleware`` enforced-path allowlist (its BFF caller is a
    server-side service fetch carrying no WorkOS bearer token, so the middleware
    would classify it as non-jwt and never enforce). The check here is that
    allowlist's equivalent for this specific read route.
    """
    scope = _verified_collection_scope(http_request)
    if scope is not None:
        allowed = {_normalize_collection_name(name) for name in scope}
        if _normalize_collection_name(collection_name) not in allowed:
            # Same 404 as an unknown collection: never reveal that an out-of-scope
            # (possibly other-tenant) collection exists.
            raise HTTPException(status_code=404, detail=f"Collection '{collection_name}' not found")
    elif _require_auth():
        raise HTTPException(
            status_code=403,
            detail="missing or invalid X-Grid-Request-Context envelope",
        )


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
        http_request: Request,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> DocumentSearchResponse:
        """Deterministic semantic search over one collection's embedded chunks.

        Retrieves the top ``top_k`` chunks for the query, then aggregates them
        into a document-centric result: one hit per file (its best-scoring
        chunk), sorted by score descending, capped at ``top_k_files``. No LLM or
        agent loop is involved.
        """
        # Defense-in-depth (PB-SYNTH-4): only search collections the caller's
        # signed request-context scopes it to. Runs BEFORE the existence probe so
        # an out-of-scope collection is indistinguishable from a missing one.
        _authorize_collection(http_request, collection_name)

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
