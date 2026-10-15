"""Similar passages („Im Büro behandelt“): where else the office wrote something like this passage.

The person reading a passage in the document viewer asks for its neighbours
across the collections the BFF authorized: the project's other documents,
the office's other projects in reach, the Büroablage. Deterministic: a
nearest-neighbour query in Qdrant, no LLM (``knowledge_layer.qdrant.similar``).

Authorization is the searches' (``document_search._authorize_collection``):
every searched collection AND the source's own must be in the signed scope,
404 when one is not (an out-of-scope collection is indistinguishable from a
missing one), 403 under ``REQUIRE_AUTH`` without a signed scope at all. The
source collection is checked because the query reads the source point's
vector from it.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request

from aiq_agent.observability.direct_trace import observed_retrieval

from ..models.similar import SimilarDocument
from ..models.similar import SimilarPassage
from ..models.similar import SimilarPassagesRequest
from ..models.similar import SimilarPassagesResponse
from .document_search import _authorize_collection
from .document_search import _snippet

logger = logging.getLogger(__name__)

#: The trace this search files under, and the observation inside it.
TRACE_FEATURE = "similar-passages"
TRACE_STEP = "retrieve.similar_passages"
#: Picks recorded on the trace, at most.
TRACE_PICK_LIMIT = 50
#: The payload fields the query filters on (never their values): the scope, the
#: current Fassung, and the source document's exclusion.
FILTER_FIELDS = ["scope", "superseded", "file_name", "grid_document_id"]


def _response(result: Any, snippet_max_chars: int) -> SimilarPassagesResponse:
    return SimilarPassagesResponse(
        origin=result.origin,
        documents=[
            SimilarDocument(
                collection=document.scope,
                file_name=document.file_name,
                passages=[
                    SimilarPassage(
                        chunk_id=passage.chunk_id,
                        snippet=_snippet(passage.text, snippet_max_chars).removesuffix("…"),
                        page_number=passage.page,
                        score=max(0.0, min(1.0, passage.score)),
                    )
                    for passage in document.passages
                ],
            )
            for document in result.documents
        ],
    )


def _picks(response: SimilarPassagesResponse) -> dict[str, Any]:
    """The trace's output: which passages were handed back, by collection, file, page and score."""
    picked = [
        {
            "collection": document.collection,
            "file": document.file_name,
            "chunk_id": passage.chunk_id,
            "page": passage.page_number,
            "score": round(passage.score, 4),
        }
        for document in response.documents
        for passage in document.passages
    ]
    return {"origin": response.origin, "filter_fields": FILTER_FIELDS, "picked": picked[:TRACE_PICK_LIMIT]}


def _query(request: SimilarPassagesRequest, collections: list[str]) -> dict[str, Any]:
    """The trace's input: the ask as data. The passage text stays out (ADR-0089), its length does not."""
    return {
        "source": {
            "collection": request.source.collection,
            "file": request.source.file_name,
            "page": request.source.page,
            "kind": request.source.kind,
            "has_chunk_id": bool(request.source.chunk_id),
            "text_chars": len(request.source.text),
        },
        "collections": len(collections),
        "documents": request.documents,
        "passages_per_document": request.passages_per_document,
    }


def _search(request: SimilarPassagesRequest, collections: list[str]) -> Any:
    """Run the query on a worker thread's terms: the store and the embedder both block."""
    from knowledge_layer.qdrant.similar import PassageSource
    from knowledge_layer.qdrant.similar import find_similar
    from knowledge_layer.qdrant.store import get_store

    from aiq_agent.knowledge.factory import get_active_retriever

    retriever = get_active_retriever()
    source = PassageSource(
        scope=request.source.collection,
        file_name=request.source.file_name,
        text=request.source.text,
        page=request.source.page,
        chunk_id=request.source.chunk_id,
        cited=request.source.kind == "cited",
        document_id=request.source.document_id,
    )
    return find_similar(
        get_store(retriever.embedding_identity()),
        collections,
        source=source,
        embed=retriever.embed_query,
        documents=request.documents,
        per_document=request.passages_per_document,
    )


def add_similar_passages_routes(router: APIRouter):
    """Add the similar-passages route to the FastAPI app."""

    @router.post(
        "/v1/collections/similar",
        response_model=SimilarPassagesResponse,
        tags=["documents"],
        summary="Passages like one the reader is looking at, across the collections in scope",
    )
    async def similar_passages(request: SimilarPassagesRequest, http_request: Request) -> SimilarPassagesResponse:
        """The documents nearest to the source passage, grouped by document in ranking order.

        A stored chunk (named by ``chunk_id``, or a ``cited`` passage found in
        its file by its text) is searched with the vector the store holds; a
        ``selected`` passage, or a citation whose chunk is not found, is
        embedded once through the retriever's cached query path. The source
        document is never in the answer, nor is a superseded Fassung.

        400 for collections outside the office's (the legal corpus is no
        place to search for the office's experience), 409 where this backend
        embeds no queries, 503 when the store cannot answer.
        """
        collections = list(dict.fromkeys(request.collections))
        for collection in [request.source.collection, *collections]:
            _authorize_collection(http_request, collection)
        with observed_retrieval(TRACE_FEATURE, step=TRACE_STEP, query=_query(request, collections)) as trace:
            try:
                result = await asyncio.to_thread(_search, request, collections)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e)) from e
            except LookupError as e:
                raise HTTPException(status_code=404, detail=str(e)) from e
            except NotImplementedError as e:
                raise HTTPException(status_code=409, detail=str(e)) from e
            except Exception as e:
                logger.exception("Similar-passage search failed")
                raise HTTPException(status_code=503, detail="similar-passage search failed") from e
            response = _response(result, request.snippet_max_chars)
            trace.finish(
                _picks(response),
                {
                    "origin": response.origin,
                    "documents": len(response.documents),
                    "candidates": result.candidates,
                },
            )
        return response
