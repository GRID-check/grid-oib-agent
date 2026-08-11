"""Process-wide handle to the active WorkflowBuilder.

Captured once at job-route registration so internal routes registered without a
builder (e.g. the skills submit route, wired next to the maintenance routes)
can reuse builder-dependent helpers such as
``routes.jobs._validate_data_sources_for_agent``.

Kept in its own tiny module — deliberately free of NAT/Dask imports — so a
consumer that only needs to *check whether* a builder exists does not pay the
cost of importing ``routes.jobs`` (which imports NAT at module load).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from nat.builder.workflow_builder import WorkflowBuilder

_active_builder: WorkflowBuilder | None = None


def set_active_builder(builder: WorkflowBuilder | None) -> None:
    """Record the builder for later reuse by builder-less internal routes."""
    global _active_builder
    _active_builder = builder


def get_active_builder() -> WorkflowBuilder | None:
    """Return the builder captured at job-route registration, or None."""
    return _active_builder
