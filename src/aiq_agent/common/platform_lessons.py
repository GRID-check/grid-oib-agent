"""Platform lessons — the injected digest of user-reported failure patterns.

The product's own correction ratchet (docs/contributing/correction-ratchet.md
applied to the product itself: "human intervention is a failure signal"). The
BFF distills down-votes into anonymized, deduplicated lessons
(docs/architecture/platform-failure-learning.md); this module resolves the
bounded digest of ACTIVE lessons through the same token-guarded internal
channel as the retrieval settings (``GET /api/internal/platform-lessons/digest``),
TTL-cached and fail-open.

Platform-wide by design — no org layer and no per-request header: a lesson is
anonymized fleet knowledge, identical for every tenant. Fail-open by design: a
BFF outage must never take answering down, so every error path returns None
and the prompt simply renders no lessons block.
"""

import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

# In-process cache TTLs, same rationale as retrieval_settings: a curation
# change reaches the fleet within a minute; failures are retried sooner so a
# BFF blip does not suppress the lessons for long.
_POSITIVE_TTL_SECONDS = 60.0
_NEGATIVE_TTL_SECONDS = 30.0
_REQUEST_TIMEOUT_SECONDS = 3.0

# Hard ceiling on what this module will inject, whatever the BFF sent. The BFF
# bounds the digest to 1600 chars (lib/platform-lessons/service.ts); this is
# the read-side seatbelt, not the budget.
_MAX_DIGEST_CHARS = 2400

_EXPECTED_HEADER = "PLATFORM_LESSONS"


class _CacheEntry:
    __slots__ = ("digest", "expires_at")

    def __init__(self, digest: str | None, ttl: float) -> None:
        self.digest = digest
        self.expires_at = time.monotonic() + ttl


_cache: _CacheEntry | None = None
_cache_lock = threading.Lock()


def reset_platform_lessons_cache() -> None:
    """Test hook: clear the in-process resolution cache."""
    global _cache
    with _cache_lock:
        _cache = None


def sanitize_lessons_digest(value: object) -> str | None:
    """Reduce an untrusted payload to a bounded, well-formed digest or None."""
    if not isinstance(value, str):
        return None
    digest = value.strip()
    if not digest or not digest.startswith(_EXPECTED_HEADER):
        return None
    if len(digest) > _MAX_DIGEST_CHARS:
        digest = digest[:_MAX_DIGEST_CHARS]
    return digest


def _fetch_digest() -> str | None:
    """One HTTP round-trip to the BFF's internal platform-lessons endpoint."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        # No internal-token trust channel — no lessons, and no error.
        return None

    import httpx

    base_url = (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")
    response = httpx.get(
        f"{base_url}/api/internal/platform-lessons/digest",
        headers={"x-grid-internal-token": token},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return None
    return sanitize_lessons_digest(payload.get("digest"))


def get_platform_lessons_digest() -> str | None:
    """The active-lessons digest, or None when there is none to inject.

    Never raises. Called once per turn (register layer); the TTL cache keeps
    the per-turn cost at zero between refreshes. Blocking I/O — call it via
    ``asyncio.to_thread`` from async code, like ``fetch_memory_digest``.
    """
    global _cache
    now = time.monotonic()
    with _cache_lock:
        if _cache is not None and _cache.expires_at > now:
            return _cache.digest

    try:
        digest = _fetch_digest()
        ttl = _POSITIVE_TTL_SECONDS if digest else _NEGATIVE_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001 - fail open by design
        logger.warning("Platform-lessons resolution failed: %s", type(exc).__name__)
        digest, ttl = None, _NEGATIVE_TTL_SECONDS

    with _cache_lock:
        _cache = _CacheEntry(digest, ttl)
    return digest
