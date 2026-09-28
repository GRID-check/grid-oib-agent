"""Asking the BFF whether the document an ingest is indexing still exists.

A document can be deleted while its ingest runs, and the ingest cannot see it:
the BFF owns the ``documents`` row, and this process never reads the BFF's
Postgres (ADR-0055). Two windows let a deleted document end up indexed anyway:

- a delete on one replica during a same-name re-ingest on another.
  ``delete_file`` removes the chunks under the name it is given, and the
  ingest then inserts the rest of its own after the delete has run;
- a delete landing after the upload recorded its version and before or while
  the ingest dispatch runs (ADR-0054, correction 17). The dispatch indexes a
  document that no longer exists.

Both close in one place. Once a file is in the vector store, and before its
predecessor is retired, the ingestor asks the BFF whether the document it was
dispatched for is still there
(``GET /api/internal/document-exists``, service-token guarded, the transport
``image_store`` uses). On a definite "gone" it takes back out exactly the
chunks this attempt inserted and writes no metadata for it.

Only a definite answer counts. :func:`document_still_exists` returns ``None``
for everything else: no BFF configured, a timeout, a 5xx, a 404 from a BFF
that predates the route, a body it cannot read. The ingestor treats ``None``
as "exists", because a BFF that cannot be reached must never cost a live
document its chunks. What an unreachable BFF leaves behind is the window as it
was before this module, and the platform vector reconcile still sweeps it.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_FRONTEND_INTERNAL_URL_ENV = "FRONTEND_INTERNAL_URL"
_INTERNAL_TOKEN_ENV = "GRID_INTERNAL_API_TOKEN"
_EXISTS_PATH = "/api/internal/document-exists"
_HTTP_TIMEOUT_SECONDS = 10.0


def document_still_exists(document_id: str, collection: str, organization_id: str | None = None) -> bool | None:
    """True or False when the BFF answered, ``None`` when it could not say.

    The row is addressed the way the dispatch sent it: by ``document_id`` AND
    the collection it was dispatched for, so a document moved to another
    collection reads as gone from this one, which is true of its chunks here.
    """
    base_url = os.environ.get(_FRONTEND_INTERNAL_URL_ENV, "").strip()
    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not base_url or not token:
        return None
    params = {"documentId": document_id, "collection": collection}
    if organization_id:
        params["organizationId"] = organization_id
    try:
        import httpx

        response = httpx.get(
            f"{base_url.rstrip('/')}{_EXISTS_PATH}",
            params=params,
            headers={"x-grid-internal-token": token},
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            logger.warning(
                "document_presence: no answer for document %s (HTTP %d); treating it as present",
                document_id,
                response.status_code,
            )
            return None
        exists = response.json().get("exists")
    except Exception as e:  # noqa: BLE001 - fail-open: an unreachable BFF must not cost a document its chunks
        logger.warning(
            "document_presence: could not ask about document %s (%s); treating it as present",
            document_id,
            type(e).__name__,
        )
        return None
    if not isinstance(exists, bool):
        logger.warning("document_presence: unreadable answer for document %s; treating it as present", document_id)
        return None
    return exists
