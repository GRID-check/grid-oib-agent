"""What a BIM tool call tells Langfuse (ADR-0045 §Observability).

The SHAPE of the call, never the building: operation, outcome, a model
handle. Element names, property values and file names stay in ``output.value``
under the redaction policy that governs it.
"""

from __future__ import annotations

import hashlib
from typing import Any

from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

#: One tag for "this turn read a building model" — the filter an operator
#: reaches for first; the per-call detail goes in metadata.
FEATURE_TAG = "feature:ifc"


def record_ifc_call(op: str, outcome: str, **facts: Any) -> None:
    """Tag the trace and record one call's shape. ``None`` facts are dropped."""
    add_trace_tag(FEATURE_TAG)
    record_trace_metadata(ifc_op=op, ifc_outcome=outcome, **facts)


def model_handle(filename: Any) -> str | None:
    """A stable, non-reversible name for one model.

    An Austrian project file is named for the client and the site, which is
    tenant content; a digest still answers "the same model as that other turn".
    """
    if not isinstance(filename, str) or not filename:
        return None
    return hashlib.sha256(filename.encode("utf-8")).hexdigest()[:12]
