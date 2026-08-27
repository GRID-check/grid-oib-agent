"""Platform-tunable retrieval settings (top_k, max_results, …).

The retrieval counts used to be build-time facts: YAML values in
``configs/config_oib_openrouter.yml`` or Python module constants, so tuning
recall/context-size trade-offs meant a commit and a redeploy. The platform
owner now edits them in Platform → Retrieval; they live in the BFF's
``platform_retrieval_settings`` table and reach the backend through the same
token-guarded internal channel as the model overrides
(``GET /api/internal/retrieval-settings``), TTL-cached and fail-open.

Resolution order per call:

  1. the platform owner's value for the key (if within catalog bounds)
  2. the build-time fallback the caller passes (YAML value / module constant)

Platform-only by design — no org layer, no per-request header. Fail-open by
design: a BFF outage must never take retrieval down, so every error path
returns the caller's fallback.
"""

import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

# In-process cache TTLs. Positive entries outlive a quick admin-edit check by
# at most a minute; failures are retried sooner so a BFF blip does not pin the
# fleet to build-time defaults for long.
_POSITIVE_TTL_SECONDS = 60.0
_NEGATIVE_TTL_SECONDS = 30.0
_REQUEST_TIMEOUT_SECONDS = 5.0

# The catalog bounds, mirrored from the BFF's single source of truth
# (frontends/ui/src/lib/retrieval-settings/catalog.ts, parity-tested via
# tests/fixtures/retrieval_settings_catalog.json). Bounds exist twice
# deliberately: the BFF validates on write, this module validates on read, so a
# stale/hand-edited row can never push retrieval out of a sane range.
_BOUNDS: dict[str, tuple[int, int]] = {
    "knowledge.top_k": (1, 50),
    "knowledge.max_chunks_per_document": (0, 10),
    # Percent, not a float, because this catalog is integer-only and the BFF mirrors
    # it. 0 disables the floor, which is the default: see the call site in
    # knowledge_layer.register.search for why a floor must be calibrated against the
    # embedding model actually deployed rather than shipped as a guess.
    "knowledge.relevance_floor_pct": (0, 90),
    "surface.chunk_top_k": (1, 100),
    "surface.max_files": (1, 4),
    "web.max_results": (1, 10),
    "web.advanced_max_results": (1, 10),
    "ris.max_results": (1, 50),
    "ris.page_size": (10, 100),
    "ris_catalog.max_matches": (1, 20),
    # Not a retrieval count: the platform-lessons control-group percentage.
    # Same shape (one bounded platform-wide integer through the same pull), so
    # it rides this catalog rather than growing a second one. 0 = measurement off.
    "lessons.holdout_pct": (0, 50),
}

# Keys whose valid values are a discrete set rather than every int in range
# (the RIS API only accepts these page sizes).
_ALLOWED_VALUES: dict[str, frozenset[int]] = {
    "ris.page_size": frozenset({10, 20, 50, 100}),
}


class _CacheEntry:
    __slots__ = ("expires_at", "settings")

    def __init__(self, settings: dict[str, int], ttl: float) -> None:
        self.settings = settings
        self.expires_at = time.monotonic() + ttl


_cache: _CacheEntry | None = None
_cache_lock = threading.Lock()


def reset_retrieval_settings_cache() -> None:
    """Test hook: clear the in-process resolution cache."""
    global _cache
    with _cache_lock:
        _cache = None


def sanitize_retrieval_settings(data: object) -> dict[str, int]:
    """Reduce an untrusted mapping to ``{known_key: in-bounds int}``."""
    if not isinstance(data, dict):
        logger.warning("Ignoring retrieval settings: expected JSON object, got %s", type(data).__name__)
        return {}
    settings: dict[str, int] = {}
    for key, value in data.items():
        bounds = _BOUNDS.get(key)
        if bounds is None:
            logger.debug("Dropping unknown retrieval setting %r", key)
            continue
        # bool is an int subclass; True/False are not counts.
        if isinstance(value, bool) or not isinstance(value, int):
            logger.warning("Dropping non-integer retrieval setting %r=%r", key, value)
            continue
        if value < bounds[0] or value > bounds[1]:
            logger.warning("Dropping out-of-bounds retrieval setting %r=%d (allowed %d..%d)", key, value, *bounds)
            continue
        allowed = _ALLOWED_VALUES.get(key)
        if allowed is not None and value not in allowed:
            logger.warning("Dropping retrieval setting %r=%d (allowed values %s)", key, value, sorted(allowed))
            continue
        settings[key] = value
    return settings


def _fetch_settings() -> dict[str, int]:
    """One HTTP round-trip to the BFF's internal retrieval-settings endpoint."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        # No internal-token trust channel — fall back to build-time defaults.
        return {}

    import httpx

    base_url = (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")
    response = httpx.get(
        f"{base_url}/api/internal/retrieval-settings",
        headers={"x-grid-internal-token": token},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return {}
    settings = payload.get("settings")
    return sanitize_retrieval_settings(settings) if settings else {}


def _resolve() -> dict[str, int]:
    """Cached resolution of the platform settings (shared hot path)."""
    global _cache
    now = time.monotonic()
    with _cache_lock:
        if _cache is not None and _cache.expires_at > now:
            return _cache.settings

    try:
        settings = _fetch_settings()
        ttl = _POSITIVE_TTL_SECONDS if settings else _NEGATIVE_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001 - fail open by design
        logger.warning("Retrieval-settings resolution failed: %s", type(exc).__name__)
        settings, ttl = {}, _NEGATIVE_TTL_SECONDS

    with _cache_lock:
        _cache = _CacheEntry(settings, ttl)
    return settings


def get_retrieval_setting(key: str, fallback: int) -> int:
    """The platform owner's value for ``key``, or ``fallback`` when unset.

    Never raises and never returns an out-of-bounds value: unknown keys log
    once and resolve to the fallback. Called per tool invocation; the TTL
    cache keeps the hot path free of network calls.
    """
    if key not in _BOUNDS:
        logger.warning("get_retrieval_setting: unknown key %r, using fallback %d", key, fallback)
        return fallback
    return _resolve().get(key, fallback)
