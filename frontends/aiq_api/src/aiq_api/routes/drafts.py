"""The working directory's cleanup door: ``DELETE /v1/drafts/{conversation_id}``.

A conversation's drafts are the one thing it owns that deleting the
conversation does not remove. Everything else is a row in ``grid_app`` and goes
with the parent; the working directory lives in the LangGraph store, under a
namespace keyed by conversation id (``draft_store.draft_namespace``), which the
BFF cannot reach — the Python tier is the only side that speaks to that store.

So the BFF's conversation deletion calls this, and this calls the store. Same
treatment as the maintenance purge routes it sits beside: internal-token only,
never on the AuthMiddleware external-path allowlist, and idempotent — a
conversation whose drafts are already gone answers ``204`` exactly as one whose
drafts went on this call, because a purger that has to distinguish "deleted" from
"was not there" would have to retry the second one forever.

It refuses nothing else. There is no tenancy check here and there must not be
one: this tier is trusting about tenancy by design (ADR-0003, ADR-0007), the BFF
decided the caller may delete this conversation before it addressed the route,
and the namespace is the whole of the predicate.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Request
from fastapi import Response

from aiq_agent.tools.documents.draft_store import delete_conversation_drafts

from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)


def add_draft_routes(router: APIRouter) -> None:
    """Add the internal working-directory cleanup route to the FastAPI app."""

    @router.delete(
        "/v1/drafts/{conversation_id}",
        status_code=204,
        response_class=Response,
        tags=["drafts"],
        summary="Drop one conversation's working directory (internal)",
    )
    async def delete_drafts(conversation_id: str, request: Request) -> Response:
        _require_internal_token(request)
        try:
            await delete_conversation_drafts(conversation_id)
        except Exception:
            # Never swallowed: a store that cannot be swept leaves orphaned
            # bytes, and the caller is a purger that retries on a 5xx. The
            # conversation id is safe to log; the store's own error is not
            # forwarded to a caller that cannot act on it.
            logger.exception("Failed to drop the working directory of conversation %s", conversation_id)
            raise HTTPException(status_code=500, detail="Failed to delete drafts")
        return Response(status_code=204)
