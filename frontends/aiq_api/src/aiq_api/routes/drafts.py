"""The working directory's doors: ``DELETE`` to sweep it, ``GET`` to read it.

A conversation's drafts are the one thing it owns that deleting the
conversation does not remove. Everything else is a row in ``grid_app`` and goes
with the parent; the working directory lives in the LangGraph store, under a
namespace keyed by conversation id (``draft_store.draft_namespace``), which the
BFF cannot reach — the Python tier is the only side that speaks to that store.

So the BFF's conversation deletion calls the ``DELETE`` door, and this calls the
store. Same treatment as the maintenance purge routes it sits beside:
internal-token only, never on the AuthMiddleware external-path allowlist, and
idempotent — a conversation whose drafts are already gone answers ``204``
exactly as one whose drafts went on this call, because a purger that has to
distinguish "deleted" from "was not there" would have to retry the second one
forever.

It refuses nothing else. There is no tenancy check here and there must not be
one: this tier is trusting about tenancy by design (ADR-0003, ADR-0007), the BFF
decided the caller may delete this conversation before it addressed the route,
and the namespace is the whole of the predicate.

The read doors
--------------
The unfiled draft card cannot preview what the model wrote without a way to
fetch the bytes into the browser — the model writes, the reader cannot open.
So the same namespace is also served read-only: ``GET
/v1/drafts/{conversation_id}`` lists one conversation's drafts as ``{path,
bytes, version}`` without content, and the same URL with ``?path=`` — or ``GET
/v1/drafts/{conversation_id}/{path...}`` — returns one draft as ``{path,
content, version}``, plus its ``filing`` record when the draft has been filed.

Read-only is literal: these routes call ``asearch``/``aget`` and nothing else,
so they cannot write the store, and they never touch ``grid_app``
(single-writer rule, ADR-0003). What they refuse:

- anything but the internal token, exactly as the ``DELETE`` door does;
- a conversation id that is not one namespace element (blank, ``..`` anywhere,
  a separator, over-long) — ``400``;
- a path outside the working directory or containing ``..`` — ``400``, decided
  by the SAME refusal the write verbs enforce (``draft_store.path_refusal``),
  so a read can never name a file a write could not have created;
- a single read past the drafts ceiling (256 KB per conversation) — ``413``
  rather than streaming unbounded bytes;
- a well-formed address the store has nothing under — ``404``, the same
  nothing-to-discard convention the ``DELETE`` door's callers already treat as
  success (most conversations never wrote a draft).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi import HTTPException
from fastapi import Query
from fastapi import Request
from fastapi import Response

from aiq_agent.tools.documents import draft_store
from aiq_agent.tools.documents.draft_store import MAX_DRAFT_BYTES
from aiq_agent.tools.documents.draft_store import VERSION_KEY
from aiq_agent.tools.documents.draft_store import delete_conversation_drafts
from aiq_agent.tools.documents.draft_store import draft_bytes
from aiq_agent.tools.documents.draft_store import draft_namespace
from aiq_agent.tools.documents.draft_store import filing_from_value
from aiq_agent.tools.documents.draft_store import path_refusal

from .internal_auth import _require_internal_token

logger = logging.getLogger(__name__)

#: Store rows read per page while listing a conversation's drafts. The 256 KB
#: ceiling bounds the real number far below this; the page size only decides how
#: many round trips an unusual conversation costs. Same role as the page size in
#: ``draft_store``; the value is local so the route does not import a private name.
_LIST_PAGE_SIZE = 100

#: A conversation id is an opaque BFF string, but here it becomes one element of
#: a store namespace, so it must BE one element: non-blank, no separators, no
#: ``..`` anywhere, and bounded, so a crafted id cannot widen the read beyond
#: its own namespace.
_MAX_CONVERSATION_ID_LENGTH = 200


def _checked_conversation_id(conversation_id: str) -> str:
    """Reject an id that is not one namespace element, before it reaches the store."""
    if (
        not conversation_id
        or not conversation_id.strip()
        or len(conversation_id) > _MAX_CONVERSATION_ID_LENGTH
        or conversation_id in (".", "..")
        or ".." in conversation_id
        or "/" in conversation_id
        or "\\" in conversation_id
    ):
        raise HTTPException(status_code=400, detail="Invalid conversation id")
    return conversation_id


def _checked_draft_path(path: str) -> str:
    """The one read path, normalised to the stored key shape (``/entwuerfe/….md``).

    The ``?path=`` spelling and the ``/{path...}`` suffix spelling meet here: a
    bare ``entwuerfe/…`` gains its leading slash, and then the SAME refusal the
    write verbs enforce decides — one definition of what the working directory
    may hold, kept in ``draft_store``.
    """
    candidate = path if path.startswith("/") else f"/{path}"
    if path_refusal(candidate) is not None:
        raise HTTPException(status_code=400, detail="Invalid draft path")
    return candidate


def _item_content(value: dict) -> str:
    """The stored text of one draft item, totalled the way the write guards total it."""
    raw = value.get("content")
    return "\n".join(raw) if isinstance(raw, list) else str(raw or "")


async def _list_drafts(conversation_id: str) -> list[dict]:
    """Every draft in one conversation's namespace: path, bytes, version. No content."""
    # Through the module, not a from-import: tests (and only tests) swap the
    # store behind this name, the same seam the delete door resolves through.
    store = await draft_store.get_draft_store()
    namespace = draft_namespace(conversation_id)
    entries: list[dict] = []
    offset = 0
    while True:
        page = await store.asearch(namespace, limit=_LIST_PAGE_SIZE, offset=offset)
        for item in page:
            text = _item_content(item.value)
            entries.append(
                {
                    "path": str(item.key),
                    "bytes": draft_bytes(text),
                    "version": int(item.value.get(VERSION_KEY) or 0),
                }
            )
        if len(page) < _LIST_PAGE_SIZE:
            break
        offset += _LIST_PAGE_SIZE
    entries.sort(key=lambda entry: str(entry["path"]))
    return entries


async def _read_draft(conversation_id: str, draft_path: str) -> dict:
    """One draft's content and version, plus its filing record when it has been filed."""
    store = await draft_store.get_draft_store()
    namespace = draft_namespace(conversation_id)
    item = await store.aget(namespace, draft_path)
    if item is None:
        raise HTTPException(status_code=404, detail="Draft not found")
    content = _item_content(item.value)
    if draft_bytes(content) > MAX_DRAFT_BYTES:
        # Unreachable through the write verbs, which refuse past the same
        # ceiling — answering 413 rather than streaming unbounded bytes.
        raise HTTPException(status_code=413, detail="Draft exceeds the readable size")
    answer: dict = {
        "path": draft_path,
        "content": content,
        "version": int(item.value.get(VERSION_KEY) or 0),
    }
    filing = filing_from_value(item.value)
    if filing:
        answer["filing"] = filing
    return answer


def add_draft_routes(router: APIRouter) -> None:
    """Add the internal working-directory cleanup and read routes to the FastAPI app."""

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

    @router.get(
        "/v1/drafts/{conversation_id}",
        tags=["drafts"],
        summary="List one conversation's drafts, or read one via ?path= (internal)",
    )
    async def list_drafts(
        conversation_id: str,
        request: Request,
        path: str | None = Query(default=None, description="Draft path to read, e.g. /entwuerfe/befund.md"),
    ) -> dict:
        _require_internal_token(request)
        _checked_conversation_id(conversation_id)
        draft_path = _checked_draft_path(path) if path is not None else None
        try:
            if draft_path is not None:
                return await _read_draft(conversation_id, draft_path)
            drafts = await _list_drafts(conversation_id)
        except HTTPException:
            raise
        except Exception:
            logger.exception("Failed to read the working directory of conversation %s", conversation_id)
            raise HTTPException(status_code=500, detail="Failed to read drafts")
        if not drafts:
            # The 404-means-nothing-to-discard convention, read-side: no rows
            # under this namespace means no conversation this tier ever wrote for.
            raise HTTPException(status_code=404, detail="No drafts for this conversation")
        return {"conversation_id": conversation_id, "drafts": drafts}

    @router.get(
        "/v1/drafts/{conversation_id}/{file_path:path}",
        tags=["drafts"],
        summary="Read one conversation's draft by path suffix (internal)",
    )
    async def read_draft(conversation_id: str, file_path: str, request: Request) -> dict:
        _require_internal_token(request)
        _checked_conversation_id(conversation_id)
        draft_path = _checked_draft_path(file_path)
        try:
            return await _read_draft(conversation_id, draft_path)
        except HTTPException:
            raise
        except Exception:
            logger.exception("Failed to read the working directory of conversation %s", conversation_id)
            raise HTTPException(status_code=500, detail="Failed to read drafts")
