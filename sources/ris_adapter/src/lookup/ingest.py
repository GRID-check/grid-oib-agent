"""[5] The full text into the session collection.

Unchanged from ``ris_fetch_document``: same ``_safe_document_name``, same
per-session ingest marker, same best-effort contract (a lookup must succeed
even when ingestion cannot). It is what keeps a passage answer from costing the
conversation the rest of the law — ``read_passage`` reopens any other § of a
document that is in the session collection, and the „Bereits gelesen" digest
sees it.
"""

from __future__ import annotations

import asyncio
import logging

from ris_adapter.cache import cache_get_json
from ris_adapter.cache import cache_set_json
from ris_adapter.cache import ingested_marker_key
from ris_adapter.cache import ris_cache_ttl_seconds
from ris_adapter.lookup.fetch import FetchedDocument
from ris_adapter.register import _ingest_document_sync
from ris_adapter.register import _resolve_session_collection
from ris_adapter.register import _safe_document_name

logger = logging.getLogger(__name__)


async def ingest_documents(documents: list[FetchedDocument], enabled: bool) -> str | None:
    """Ingest every fetched document; return the first stored name, or ``None``.

    The name is what the model is told to reach for later, so the FIRST one is
    the one reported: with the cap at two documents, naming both would put a
    list in a sentence that exists to give the reader one handle.
    """
    if not enabled:
        return None
    names = [await ingest_one(fetched) for fetched in documents]
    return next((name for name in names if name), None)


async def ingest_one(fetched: FetchedDocument) -> str | None:
    """Ingest one fetched document once per session; returns its stored name."""
    document = fetched.document
    file_name = _safe_document_name(fetched.candidate.document_number or document.url, document.title)
    collection = _resolve_session_collection()
    marker = ingested_marker_key(collection, document.url) if collection else None
    if marker and await cache_get_json(marker):
        return file_name
    try:
        stored = await asyncio.to_thread(_ingest_document_sync, document.text, file_name, document.url)
    except Exception:  # noqa: BLE001 — fetching must succeed even when ingestion cannot
        logger.warning("ris_lookup: knowledge ingestion failed (non-fatal)", exc_info=True)
        return None
    if stored and marker:
        await cache_set_json(marker, True, ris_cache_ttl_seconds())
    return stored
