"""Control-marker detection for the shallow researcher's answer contract.

The shallow agent's prompt makes the model end research answers with two
control markers:

- ``[ESCALATE_TO_DEEP]`` — the model judged its own answer insufficient and
  asks to escalate to deep research.
- ``[CONFIDENCE:low|medium|high]`` — the model's self-assessment of how well the
  answer is grounded in its sources.

These helpers live in the shallow_researcher package (the layer that OWNS the
marker contract) so both the shallow agent (which now extracts + strips them
before emitting/returning content) and the chat orchestrator (which consumes the
resulting structured signals, with string-detection as a back-compat fallback)
can share one implementation without a circular import.
"""

from __future__ import annotations

import re
from typing import Any
from typing import Literal

ESCALATION_MARKER = "[ESCALATE_TO_DEEP]"

# The model ends every research answer with a self-assessment marker of the
# form ``[CONFIDENCE:low|medium|high]``. The value is bracketed and
# case-insensitive; the capture group is validated against the enum below so a
# malformed value ("certain", empty, …) is stripped from the text but yields no
# signal.
CONFIDENCE_MARKER_RE = re.compile(r"\[CONFIDENCE:\s*([^\]]*)\]", re.IGNORECASE)
_VALID_CONFIDENCE_VALUES = frozenset({"low", "medium", "high"})

ConfidenceLevel = Literal["low", "medium", "high"]


def detect_and_strip_escalation_marker(content: Any) -> tuple[Any, bool]:
    """Detect and remove the shallow-agent insufficiency marker from a message.

    If ``content`` is not a string it is returned unchanged with ``False``.
    Otherwise every literal occurrence of :data:`ESCALATION_MARKER` (matched
    leniently as a substring anywhere in the text) is removed, the resulting
    trailing whitespace is collapsed (including any dangling blank line the
    marker left behind), and ``(stripped, was_present)`` is returned.
    """
    if not isinstance(content, str):
        return content, False

    if ESCALATION_MARKER not in content:
        return content, False

    stripped = content.replace(ESCALATION_MARKER, "")
    # Collapse trailing whitespace and any blank line left where the marker sat.
    stripped = stripped.rstrip()
    return stripped, True


def detect_and_strip_confidence_marker(content: Any) -> tuple[Any, ConfidenceLevel | None]:
    """Detect and remove the model's self-assessed confidence marker.

    Mirrors :func:`detect_and_strip_escalation_marker`: fail-open and
    tail-tolerant. If ``content`` is not a string it is returned unchanged with
    ``None``. Otherwise EVERY ``[CONFIDENCE:...]`` marker (matched leniently as a
    substring, case-insensitive) is stripped so the user never sees it, and the
    parsed level is returned as ``(stripped, level)``:

    - ``level`` is the well-formed value ("low"/"medium"/"high") — the last one
      when several appear (the answer's final marker wins).
    - Absent marker, or a marker whose value is not one of the three, yields
      ``None`` (no signal). Malformed markers are still stripped from the text.

    Order-insensitive with respect to the escalation marker: each marker is
    detected and removed independently, so both may co-occur in any order.
    """
    if not isinstance(content, str):
        return content, None

    matches = list(CONFIDENCE_MARKER_RE.finditer(content))
    if not matches:
        return content, None

    level: ConfidenceLevel | None = None
    for match in matches:
        candidate = match.group(1).strip().lower()
        if candidate in _VALID_CONFIDENCE_VALUES:
            level = candidate  # type: ignore[assignment]

    stripped = CONFIDENCE_MARKER_RE.sub("", content).rstrip()
    return stripped, level
