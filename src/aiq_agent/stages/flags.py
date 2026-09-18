"""What this turn is allowed to do: which stages run, and what may be offered.

The module started as the stage half alone and now carries one more thing, for
one reason: both are answered by the same internal endpoint, in the same
per-turn gather, under the same 1.5s budget. A second fetcher would buy a second
way to spend that budget and nothing else.

Which stages are switched on for this turn.

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
from dataclasses import dataclass

from aiq_agent.stages.registry import iter_stages

logger = logging.getLogger(__name__)

#: The flag slug the pre-stage `memoryReflectionEnabled` boolean stood for.
MEMORY_REFLECTION_FLAG_SLUG = "memory-reflection"

#: The flag slug gating deep research, mirrored from the BFF registry
#: (``frontends/ui/src/lib/authz/feature-flags.ts``). Named here for the log
#: line and the tests; nothing in this module branches on the string.
DEEP_RESEARCH_FLAG_SLUG = "deep-research"


@dataclass(frozen=True)
class TurnFlags:
    """The BFF's answer for one turn: which stages run, what may be offered."""

    enabled_stages: frozenset[str]
    #: Whether this tenant may be OFFERED a deep-research run at all. The job
    #: queue has its own gate on ``POST /api/jobs/async/submit``; this is the
    #: one the answering agent reads, so a tenant without the capability is
    #: never handed a plan whose approval button answers 403.
    #:
    #: Defaults to True, and the failure paths below keep it True on purpose:
    #: an unreachable BFF or an older one that does not send ``features`` must
    #: degrade to the behaviour that shipped before this field existed, not
    #: withdraw deep research from every tenant for as long as the blip lasts.
    #: Withdrawal is a decision somebody made in WorkOS; it is never the shape
    #: of a timeout.
    deep_research_allowed: bool = True

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


def fetch_turn_flags(*, organization_id: str | None) -> TurnFlags:
    """What this tenant's turn may do, read from the BFF for THIS turn.

    Raises on any configuration or transport problem so the caller can fall back
    to the connection-time value rather than silently disabling every stage —
    the same fail-open-to-the-frozen-value discipline ``fetch_memory_digest``
    uses. Blocking; call via ``asyncio.to_thread``.

    A body without ``features`` is an OLDER BFF, not a refusal: the field is
    read with a True default so a mixed deployment keeps the behaviour it had
    before deep research could be withdrawn at all.
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
    features = body.get("features")
    allowed = features.get("deepResearch") if isinstance(features, dict) else None
    return TurnFlags(
        enabled_stages=frozenset(item for item in enabled if isinstance(item, str) and item),
        # Only an explicit False withdraws it. Anything else — absent, null, a
        # string from a future schema — is the older-BFF case above.
        deep_research_allowed=allowed is not False,
    )


async def resolve_turn_flags(*, organization_id: str | None, memory_reflection_enabled: bool) -> TurnFlags:
    """This turn's flags, with the connection-time values as fallback.

    Fail-open to the frozen value rather than fail-closed to nothing: a BFF
    hiccup must degrade to the previous behaviour, not silently switch every
    stage off for as long as the blip lasts. The same reasoning keeps deep
    research allowed here — and it is not the last word on the job either way,
    since ``POST /api/jobs/async/submit`` re-checks the flag with the reader's
    own session.
    """
    try:
        return await asyncio.to_thread(fetch_turn_flags, organization_id=organization_id)
    except Exception:
        logger.warning("Live per-turn flags unavailable; using the connection-time value", exc_info=True)
        return TurnFlags(
            enabled_stages=legacy_enabled_stages(memory_reflection_enabled=memory_reflection_enabled),
            deep_research_allowed=True,
        )


def fetch_enabled_stages(*, organization_id: str | None) -> frozenset[str]:
    """The stages switched on for this tenant. See :func:`fetch_turn_flags`."""
    return fetch_turn_flags(organization_id=organization_id).enabled_stages


async def resolve_enabled_stages(*, organization_id: str | None, memory_reflection_enabled: bool) -> frozenset[str]:
    """The enabled stage set for THIS turn. See :func:`resolve_turn_flags`.

    Kept as the stage-only name the stage code and its tests read. It delegates
    rather than fetching: two fetchers against one endpoint would eventually
    disagree about what a missing field means.
    """
    flags = await resolve_turn_flags(
        organization_id=organization_id, memory_reflection_enabled=memory_reflection_enabled
    )
    return flags.enabled_stages
