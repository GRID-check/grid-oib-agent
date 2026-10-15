"""Mirror a project's facts and status onto its points (design §4, "Mutable facts").

Postgres ``projects`` (profile, status) is the authority; the BFF owns it and
calls this whenever a project's fingerprint or lifecycle state changes, and
from its facts sync for every project. The points carry a copy so the
cross-project search can filter by a fact and lift similar projects inside
the one query (``knowledge_layer.qdrant.boost``).

A stale copy never widens access: who may read a point is the signed scope
and the scope filter alone. A fact on a point only ranks and narrows.
"""

import asyncio
import logging

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request

from ..models.requests import ProjectFactsResult
from ..models.requests import ProjectFactsUpdate
from .document_search import _authorize_collection

logger = logging.getLogger(__name__)

#: Every project collection, the project's own and each restricted folder's (``proj_<id>_r<12hex>``).
PROJECT_COLLECTION_PREFIX = "proj_"


def add_project_facts_routes(router: APIRouter):
    """Add the project-facts mirror route to the FastAPI app."""

    @router.put(
        "/v1/collections/{collection_name}/project-facts",
        response_model=ProjectFactsResult,
        tags=["collections"],
        summary="Mirror a project's facts and status onto every chunk of one of its collections",
    )
    async def put_project_facts(
        collection_name: str, request: ProjectFactsUpdate, http_request: Request
    ) -> ProjectFactsResult:
        """Overwrite ``project_facts`` and ``project_status`` on every point of the collection.

        Authorized like the searches: the collection must be in the request's
        signed scope (404 when not, 403 under auth without one). 400 for a
        collection that is not a project's. 409 when this process has no
        Qdrant store installed: the BFF reads that as "nothing to mirror
        here". Idempotent: the same body twice writes the same payload.
        """
        _authorize_collection(http_request, collection_name)
        if not collection_name.startswith(PROJECT_COLLECTION_PREFIX):
            raise HTTPException(status_code=400, detail="project facts belong to a project collection")
        try:
            from knowledge_layer.qdrant import retrieval
        except ImportError as e:  # the knowledge layer's store extra is not installed here
            raise HTTPException(status_code=409, detail="this deployment has no Qdrant store") from e
        try:
            # One set_payload over the whole scope: off the event loop, as the
            # store's other blocking calls are.
            applied = await asyncio.to_thread(
                retrieval.set_project_facts, collection_name, request.facts.model_dump(mode="json"), request.status
            )
        except Exception as e:
            logger.exception("Mirroring project facts onto %s failed", collection_name)
            raise HTTPException(status_code=502, detail="the vector store refused the project facts") from e
        return ProjectFactsResult(collection=collection_name, applied=applied)
