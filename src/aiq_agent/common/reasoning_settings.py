"""Platform-tunable reasoning effort ("thinking level") per agent group.

How hard a role thinks used to be a build-time fact: ``reasoning_effort`` in
``configs/config_oib_openrouter.yml``, so retuning the cost/quality trade-off
meant a commit and a redeploy. The platform owner now sets it per agent group
in Platform → Models; the values live in the BFF's
``platform_reasoning_efforts`` table and reach the backend through the same
token-guarded internal channel as the retrieval settings
(``GET /api/internal/reasoning-efforts``), TTL-cached and fail-open.

Resolution order per call:

  1. the platform owner's effort for the agent group (if a known level)
  2. the ``reasoning_effort`` the role's ``llms:`` entry was built with

Platform-only by design — no org layer, no per-request header. A tenant
choosing its own MODEL is a product feature; a tenant dialling its own
reasoning spend is not. Fail-open by design: a BFF outage must never take chat
down, so every error path leaves the YAML value in place.

The values are OpenRouter's UNIFIED vocabulary and are passed through verbatim
— OpenRouter maps a requested effort to the nearest level the effective model
supports, server-side, per model. That is what lets an effort chosen here
survive the group's model changing underneath it. See the NOTE in
``llm_factory`` and https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
"""

import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

# In-process cache TTLs, matching retrieval_settings: positive entries outlive
# a quick admin-edit check by at most a minute; failures are retried sooner so
# a BFF blip does not pin the fleet to build-time values for long.
_POSITIVE_TTL_SECONDS = 60.0
_NEGATIVE_TTL_SECONDS = 30.0
_REQUEST_TIMEOUT_SECONDS = 5.0

# The accepted levels, mirrored from the BFF's single source of truth
# (frontends/ui/src/lib/reasoning-settings/catalog.ts, parity-tested via
# tests/fixtures/reasoning_efforts_catalog.json). The vocabulary exists twice
# deliberately: the BFF validates on write, this module validates on read, so a
# stale or hand-edited row can never push a provider-native tier name (e.g.
# DeepSeek's "max", which OpenRouter rejects) into a request.
_EFFORTS: frozenset[str] = frozenset({"none", "minimal", "low", "medium", "high", "xhigh"})


class _CacheEntry:
    __slots__ = ("efforts", "expires_at")

    def __init__(self, efforts: dict[str, str], ttl: float) -> None:
        self.efforts = efforts
        self.expires_at = time.monotonic() + ttl


_cache: _CacheEntry | None = None
_cache_lock = threading.Lock()


def reset_reasoning_settings_cache() -> None:
    """Test hook: clear the in-process resolution cache."""
    global _cache
    with _cache_lock:
        _cache = None


def sanitize_reasoning_efforts(data: object) -> dict[str, str]:
    """Reduce an untrusted mapping to ``{known_group: known_effort}``."""
    from aiq_agent.common.model_overrides import AgentGroup

    if not isinstance(data, dict):
        logger.warning("Ignoring reasoning efforts: expected JSON object, got %s", type(data).__name__)
        return {}

    valid_groups = {group.value for group in AgentGroup}
    efforts: dict[str, str] = {}
    for group, effort in data.items():
        if group not in valid_groups:
            logger.debug("Dropping reasoning effort for unknown agent group %r", group)
            continue
        if not isinstance(effort, str) or effort not in _EFFORTS:
            logger.warning("Dropping invalid reasoning effort %r for agent group %r", effort, group)
            continue
        efforts[group] = effort
    return efforts


def _fetch_efforts() -> dict[str, str]:
    """One HTTP round-trip to the BFF's internal reasoning-efforts endpoint."""
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        # No internal-token trust channel — fall back to build-time values.
        return {}

    import httpx

    base_url = (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")
    response = httpx.get(
        f"{base_url}/api/internal/reasoning-efforts",
        headers={"x-grid-internal-token": token},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return {}
    efforts = payload.get("efforts")
    return sanitize_reasoning_efforts(efforts) if efforts else {}


def _resolve() -> dict[str, str]:
    """Cached resolution of the platform efforts (shared hot path)."""
    global _cache
    now = time.monotonic()
    with _cache_lock:
        if _cache is not None and _cache.expires_at > now:
            return _cache.efforts

    try:
        efforts = _fetch_efforts()
        ttl = _POSITIVE_TTL_SECONDS if efforts else _NEGATIVE_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001 - fail open by design
        logger.warning("Reasoning-effort resolution failed: %s", type(exc).__name__)
        efforts, ttl = {}, _NEGATIVE_TTL_SECONDS

    with _cache_lock:
        _cache = _CacheEntry(efforts, ttl)
    return efforts


def get_reasoning_effort(group: str) -> str | None:
    """The platform owner's effort for ``group``, or ``None`` when unset.

    ``None`` means "leave the role's configured value alone" — it is NOT the
    same as the level ``"none"``, which is an explicit instruction to disable
    reasoning. Never raises; the TTL cache keeps the hot path free of network
    calls.
    """
    return _resolve().get(group)
