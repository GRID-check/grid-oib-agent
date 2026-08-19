"""Import-time registration of post-answer stages.

Same shape as NAT's ``@register_function`` that the whole agent tier already
uses: a stage module declares its :class:`~aiq_agent.stages.spec.StageSpec` at
module level and hands it to :func:`register_stage`, and importing the package
is what makes it exist. The single call site iterates
:func:`iter_stages` — it never names a stage, so adding one never touches it.
"""

from __future__ import annotations

import logging

from aiq_agent.stages.spec import StageSpec

logger = logging.getLogger(__name__)

_STAGES: dict[str, StageSpec] = {}


def register_stage(spec: StageSpec) -> StageSpec:
    """Register ``spec`` and return it, so a module can write
    ``MEMORY_REFLECTION = register_stage(StageSpec(...))``.

    A duplicate id raises: two stages under one id would share an idempotency
    key and overwrite each other's payload on the turn, which is a silent
    failure worth turning into an import-time one.
    """
    existing = _STAGES.get(spec.id)
    if existing is not None and existing is not spec:
        raise ValueError(f"a different stage is already registered under id {spec.id!r}")
    _STAGES[spec.id] = spec
    return spec


def iter_stages() -> tuple[StageSpec, ...]:
    """Every registered stage, in registration order."""
    return tuple(_STAGES.values())


def get_stage(stage_id: str) -> StageSpec | None:
    """The stage registered under ``stage_id``, or ``None``."""
    return _STAGES.get(stage_id)


def unregister_stage(stage_id: str) -> StageSpec | None:
    """Remove a registration. **Test-only** — production registration happens
    once, at import, and is never withdrawn."""
    return _STAGES.pop(stage_id, None)
