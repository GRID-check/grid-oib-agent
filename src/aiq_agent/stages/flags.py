"""Which stages are switched on for this turn.

A stage's runtime gate is *flag ∧ capability*: the WorkOS flag (or its env
fallback) decides whether the tenant gets the stage at all, and the runner
decides separately whether a model is configured for it. This module owns the
first half.

The set is resolved **per turn**, not per connection. That is a deliberate
correction: the ``x-grid-feature-memory-reflection`` header is written once, at
the WebSocket upgrade, and is then frozen for the life of the socket — so an
operator reaching for the kill switch did not reach an already-open tab, which
is the opposite of what a kill switch is for. The resolution follows the pattern
the live memory digest already uses (``fetch_memory_digest``): ask the BFF at
the start of the turn, and fall back to the connection-time value only when the
call fails, so a BFF hiccup degrades to the previous behaviour rather than
silently disabling every stage.

Nothing here branches on a stage id: the legacy fallback is driven by the
``flag_slug`` a stage *declares*.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.parse
import urllib.request

from aiq_agent.stages.registry import iter_stages

logger = logging.getLogger(__name__)

#: The flag slug the pre-stage `memoryReflectionEnabled` boolean stood for.
MEMORY_REFLECTION_FLAG_SLUG = "memory-reflection"

#: The evaluation runs on the per-turn critical path, in the same gather as the
#: live memory-digest fetch, so a slow BFF must never stall the turn. On timeout
#: the caller keeps the connection-time value.
_TIMEOUT_SECONDS = 1.5


def stages_for_flag_slug(flag_slug: str) -> frozenset[str]:
    """Ids of the registered stages declaring ``flag_slug``."""
    return frozenset(spec.id for spec in iter_stages() if spec.flag_slug == flag_slug)


def legacy_enabled_stages(*, memory_reflection_enabled: bool) -> frozenset[str]:
    """The enabled set implied by the single connection-time boolean.

    Kept for one release so a mixed deployment — new backend, older BFF that
    only sends ``memoryReflectionEnabled`` — does not go dark.
    """
    if not memory_reflection_enabled:
        return frozenset()
    return stages_for_flag_slug(MEMORY_REFLECTION_FLAG_SLUG)


def _internal_base_url() -> str:
    url = os.environ.get("FRONTEND_INTERNAL_URL") or os.environ.get("FRONTEND_URL") or "http://frontend:3000"
    return url.rstrip("/")


def fetch_enabled_stages(*, organization_id: str | None) -> frozenset[str]:
    """The stages switched on for this tenant, read from the BFF for THIS turn.

    Raises on any configuration or transport problem so the caller can fall back
    to the connection-time value rather than silently disabling every stage —
    the same fail-open-to-the-frozen-value discipline ``fetch_memory_digest``
    uses. Blocking; call via ``asyncio.to_thread``.
    """
    token = os.environ.get("GRID_INTERNAL_API_TOKEN")
    if not token:
        raise RuntimeError("GRID_INTERNAL_API_TOKEN is not configured")

    query = urllib.parse.urlencode({"organizationId": organization_id} if organization_id else {})
    url = f"{_internal_base_url()}/api/internal/stages"
    request = urllib.request.Request(
        f"{url}?{query}" if query else url,
        headers={"X-Grid-Internal-Token": token},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:  # noqa: S310 - fixed internal URL
        body = json.loads(response.read().decode("utf-8"))
    enabled = body.get("enabled")
    if not isinstance(enabled, list):
        raise ValueError("the internal stages endpoint returned no 'enabled' list")
    return frozenset(item for item in enabled if isinstance(item, str) and item)


async def resolve_enabled_stages(*, organization_id: str | None, memory_reflection_enabled: bool) -> frozenset[str]:
    """The enabled set for THIS turn, with the connection-time value as fallback.

    Fail-open to the frozen value rather than fail-closed to nothing: a BFF
    hiccup must degrade to the previous behaviour, not silently switch every
    stage off for as long as the blip lasts.
    """
    try:
        return await asyncio.to_thread(fetch_enabled_stages, organization_id=organization_id)
    except Exception:
        logger.warning("Live post-answer stage flags unavailable; using the connection-time value", exc_info=True)
        return legacy_enabled_stages(memory_reflection_enabled=memory_reflection_enabled)
