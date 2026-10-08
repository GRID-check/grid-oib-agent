"""Handing a document's permit record to the BFF, which owns the tables.

``permit_records`` and ``permit_requirements`` live in the BFF's Postgres, which this
process never reads or writes (ADR-0055). The ingest pipeline and the backfill hand the
record over ``POST /api/internal/permit-records``, service-token guarded, the transport
``knowledge_layer/llamaindex/document_presence.py`` uses for ``document-exists``.

Fail-open the same way: no BFF configured, a timeout, a non-200 or an unreadable answer
is ``False`` and a WARNING, never an exception. A record that did not land costs the
permitting memory one document; it must not cost the ingest one.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aiq_agent.knowledge.permit_extraction import PermitRecord

logger = logging.getLogger(__name__)

_FRONTEND_INTERNAL_URL_ENV = "FRONTEND_INTERNAL_URL"
_INTERNAL_TOKEN_ENV = "GRID_INTERNAL_API_TOKEN"
_PERMIT_RECORDS_PATH = "/api/internal/permit-records"
# The BFF embeds the requirements before it answers (up to 60 of them), so this is
# longer than the presence check's 10 s.
_HTTP_TIMEOUT_SECONDS = 30.0


def store_permit_record(
    organization_id: str,
    document_id: str,
    collection: str,
    file_name: str,
    model: str,
    record: PermitRecord | None,
) -> bool:
    """Replace the document's permit record with ``record``, or delete it when ``None``.

    True when the BFF answered 200 and, for a record, said it stored it
    (``stored: true``; an unknown document answers ``stored: false``). Deleting
    answers True on any 200: there is nothing to confirm. Never raises.
    """
    base_url = os.environ.get(_FRONTEND_INTERNAL_URL_ENV, "").strip()
    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not base_url or not token:
        return False
    body = {
        "organizationId": organization_id,
        "documentId": document_id,
        "collection": collection,
        "fileName": file_name,
        "model": model,
        "record": record.to_wire() if record is not None else None,
    }
    try:
        import httpx

        # No redirect following (httpx's default): the token must not follow a 3xx elsewhere.
        response = httpx.post(
            f"{base_url.rstrip('/')}{_PERMIT_RECORDS_PATH}",
            json=body,
            headers={"x-grid-internal-token": token},
            timeout=_HTTP_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            logger.warning(
                "permit_records: the BFF refused the record for document %s (HTTP %d)",
                document_id,
                response.status_code,
            )
            return False
        if record is None:
            return True
        stored = response.json().get("stored")
    except Exception as e:  # noqa: BLE001 - fail-open: an unreachable BFF must not fail an ingest
        logger.warning("permit_records: could not store the record for document %s (%s)", document_id, type(e).__name__)
        return False
    if stored is not True:
        logger.warning("permit_records: the BFF did not store the record for document %s", document_id)
        return False
    return True
