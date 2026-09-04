"""Shared-cache facade for the RIS tools (the NAT/register layer).

Wraps the agent's fail-open Dragonfly/Redis cache (``aiq_agent.common.cache``,
ADR-0020) so RIS document fetches and live searches are cached across chat
turns, process restarts, and replicas. Previously every ``ris_fetch_document``
downloaded the full document and every ``ris_search`` hit the live API (plus the
planner LLM) again — real, repeated spend for identical requests.

Design:

- Kept out of ``client.py`` so the pure HTTP client stays free of agent imports.
- When the agent package (or its cache) is unavailable — the adapter used
  standalone — every operation is a safe no-op and the tools fall back to live
  fetches. Same graceful-degradation contract as ``register.py``'s catalog imports.
- Every operation is best-effort/fail-open: a cache error never breaks a tool,
  it just means a live fetch. RIS text is fully reconstructible, so the
  cache-only (never authoritative) contract of ADR-0020 fits exactly.
- The synchronous cache module is called via ``asyncio.to_thread`` so the tools'
  event loop is never blocked.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:  # a type import only — cache.py stays free of client.py at runtime
    from .client import RisClient
    from .client import RisDocument

logger = logging.getLogger(__name__)

try:
    from aiq_agent.common.cache import get_json as _get_json
    from aiq_agent.common.cache import set_json as _set_json

    _CACHE_AVAILABLE = True
except Exception:  # standalone adapter, or cache module unavailable
    _get_json = None  # type: ignore[assignment]
    _set_json = None  # type: ignore[assignment]
    _CACHE_AVAILABLE = False

_DEFAULT_TTL_DAYS = 7
_SECONDS_PER_DAY = 24 * 60 * 60


def ris_cache_ttl_seconds() -> int:
    """RIS cache TTL in seconds from ``GRID_RIS_CACHE_TTL_DAYS`` (default 7).

    Non-positive/invalid values fall back to the default, mirroring the other
    ``GRID_*`` knobs. A literal ``${...}`` placeholder counts as unset.
    """
    raw = os.environ.get("GRID_RIS_CACHE_TTL_DAYS", "").strip()
    if raw.startswith("${"):
        raw = ""
    try:
        days = int(raw)
    except (TypeError, ValueError):
        days = _DEFAULT_TTL_DAYS
    if days <= 0:
        days = _DEFAULT_TTL_DAYS
    return days * _SECONDS_PER_DAY


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def doc_cache_key(url: str) -> str:
    """Cache key for a fetched RIS document, keyed on its URL."""
    return f"ris:doc:{_digest(url)}"


def search_cache_key(payload: str) -> str:
    """Cache key for a live RIS search, keyed on its normalized input args."""
    return f"ris:search:{_digest(payload)}"


def ingested_marker_key(collection: str, url: str) -> str:
    """Per-session marker that a document was already ingested into a collection.

    Lets ``ris_fetch_document`` skip re-ingesting (re-patching) the same source
    on every back-and-forth turn — reference it once, then just point at it.
    """
    return f"ris:ingested:{collection}:{_digest(url)}"


async def cache_get_json(key: str) -> Any | None:
    """Best-effort shared-cache read; None on miss / unavailable / error."""
    if not _CACHE_AVAILABLE:
        return None
    try:
        return await asyncio.to_thread(_get_json, key)
    except Exception:
        logger.debug("RIS cache read failed for %s", key, exc_info=True)
        return None


async def cache_set_json(key: str, value: Any, ttl_seconds: int) -> None:
    """Best-effort shared-cache write; silently ignored on error."""
    if not _CACHE_AVAILABLE:
        return
    try:
        await asyncio.to_thread(_set_json, key, value, ttl_seconds)
    except Exception:
        logger.debug("RIS cache write failed for %s", key, exc_info=True)


async def fetch_document_cached(client: RisClient, url: str) -> RisDocument:
    """Fetch a RIS document, through the shared cache.

    THE READ-THROUGH LIVES HERE BECAUSE IT HAS TWO CALLERS. It used to be
    written inline in ``ris_fetch_document``, so when ``GET /v1/ris/document``
    was added — the reader that opens a citation in the app — it fetched live
    every time while its own docstring claimed the cache. A helper only one
    caller applies is a helper the next caller forgets; this is that class of
    defect, caught once.

    Fail-open in both directions: a cache miss, an unavailable cache or a read
    error all fall through to the live fetch, and a write failure is ignored.
    RIS text is fully reconstructible, which is the cache-only contract ADR-0020
    asks for.
    """
    from .client import RisDocument

    key = doc_cache_key(url)
    cached = await cache_get_json(key)
    if isinstance(cached, dict) and cached.get("text"):
        return RisDocument(
            url=cached.get("url", url),
            title=cached.get("title", ""),
            text=cached["text"],
        )

    document = await client.fetch_document_text(url)
    await cache_set_json(
        key,
        {"url": document.url, "title": document.title, "text": document.text},
        ris_cache_ttl_seconds(),
    )
    return document
