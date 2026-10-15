"""Collection management endpoints.

The ingestor is synchronous (Qdrant, SQL), so every call goes through
``asyncio.to_thread``: see ``routes/documents.py`` for why.
"""

import asyncio
import logging

from fastapi import APIRouter
from fastapi import Depends
from fastapi import HTTPException

from aiq_agent.knowledge.base import BaseIngestor
from aiq_agent.knowledge.schema import CollectionInfo

from ..models.requests import CreateCollectionRequest

logger = logging.getLogger(__name__)


def _require_ingestor() -> BaseIngestor:
    from aiq_agent.knowledge.factory import get_active_ingestor

    ingestor = get_active_ingestor()
    if ingestor is None:
        raise HTTPException(status_code=503, detail="Knowledge API not configured")
    return ingestor


async def require_collection(ingestor: BaseIngestor, name: str) -> CollectionInfo:
    """The collection ``name``: 503 when the store cannot say; 404 when an ingestor says it does not exist.

    ``get_collection`` raises when the vector store cannot be reached. It used to
    answer None, the same as "missing", so a store outage read as a 404 on every
    document route and, in the OIB sync, as a wiped index (a full re-ingest of
    the corpus). The two answers mean different things to a caller: retry later,
    or the collection is gone. On Qdrant every name is a collection (a scope on
    the points, ADR-0114), so only an ingestor that keeps collections of its
    own answers None.
    """
    try:
        collection = await asyncio.to_thread(ingestor.get_collection, name)
    except Exception as e:
        logger.warning("Could not read collection '%s' from the vector store: %s", name, type(e).__name__)
        raise HTTPException(status_code=503, detail="Vector store unavailable") from e
    if collection is None:
        raise HTTPException(status_code=404, detail=f"Collection '{name}' not found")
    return collection


def add_collection_routes(router: APIRouter):
    """Add collection management routes to the FastAPI app."""

    @router.post(
        "/v1/collections",
        response_model=CollectionInfo,
        status_code=201,
        tags=["collections"],
        summary="Create a new collection",
    )
    async def create_collection(
        request: CreateCollectionRequest,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> CollectionInfo:
        """Create a new collection for storing documents."""
        try:
            return await asyncio.to_thread(
                ingestor.create_collection,
                name=request.name,
                description=request.description,
                metadata=request.metadata,
            )
        except Exception as e:
            logger.error(f"Failed to create collection '{request.name}': {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @router.get(
        "/v1/collections/{name}",
        response_model=CollectionInfo,
        tags=["collections"],
        summary="Get collection details",
    )
    async def get_collection(
        name: str,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> CollectionInfo:
        """Get details for a specific collection: 404 when it does not exist, 503 when the store cannot say."""
        return await require_collection(ingestor, name)

    @router.delete(
        "/v1/collections/{name}",
        tags=["collections"],
        summary="Delete a collection",
    )
    async def delete_collection(
        name: str,
        ingestor: BaseIngestor = Depends(_require_ingestor),
    ) -> dict:
        """Delete a collection and all its contents."""
        try:
            success = await asyncio.to_thread(ingestor.delete_collection, name)
            if not success:
                raise HTTPException(status_code=500, detail=f"Failed to delete collection '{name}'")
            return {"success": True, "collection": name}
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Failed to delete collection '{name}': {e}")
            raise HTTPException(status_code=500, detail=str(e))
