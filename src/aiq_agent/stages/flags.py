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

import logging

from aiq_agent.stages.registry import iter_stages

logger = logging.getLogger(__name__)

#: The flag slug the pre-stage `memoryReflectionEnabled` boolean stood for.
MEMORY_REFLECTION_FLAG_SLUG = "memory-reflection"


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
