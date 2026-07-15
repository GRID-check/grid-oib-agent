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
_ESCALATION_MARKER_RE = re.compile(re.escape(ESCALATION_MARKER))

# The model ends every research answer with a self-assessment marker of the
# form ``[CONFIDENCE:low|medium|high]``. The value is bracketed and
# case-insensitive; the capture group is validated against the enum below so a
# malformed value ("certain", empty, …) is stripped from the text but yields no
# signal.
CONFIDENCE_MARKER_RE = re.compile(r"\[CONFIDENCE:\s*([^\]]*)\]", re.IGNORECASE)
_VALID_CONFIDENCE_VALUES = frozenset({"low", "medium", "high"})

ConfidenceLevel = Literal["low", "medium", "high"]

# Control markers are only meaningful as answer *signals* when the model appends
# them at the very end of its reply (the prompt contract). A marker that appears
# earlier — e.g. quoted inside an explanation of the marker contract itself — is
# body text, not a signal, and must be left intact. We therefore only treat (and
# strip) marker occurrences that fall inside the TAIL REGION: the span covering
# the last N non-empty lines of the content.
_TAIL_REGION_LINES = 3


def _tail_region_start(content: str, lines: int = _TAIL_REGION_LINES) -> int:
    """Return the char offset where the tail region begins.

    The tail region is the contiguous span from the start of the earliest of the
    last ``lines`` non-empty lines through the end of ``content`` (any trailing
    or interspersed blank lines are included). A marker at or after this offset
    is a trailing signal; one before it is body text.
    """
    non_empty_seen = 0
    start = len(content)
    idx = len(content)
    for line in reversed(content.splitlines(keepends=True)):
        idx -= len(line)
        if line.strip():
            non_empty_seen += 1
            start = idx
            if non_empty_seen == lines:
                break
    return start


def _strip_matches(content: str, matches: list[re.Match[str]]) -> str:
    """Remove the given (non-overlapping, ascending) match spans from content."""
    pieces: list[str] = []
    cursor = 0
    for match in matches:
        pieces.append(content[cursor : match.start()])
        cursor = match.end()
    pieces.append(content[cursor:])
    return "".join(pieces)


def detect_and_strip_escalation_marker(content: Any) -> tuple[Any, bool]:
    """Detect and remove the shallow-agent insufficiency marker from a message.

    If ``content`` is not a string it is returned unchanged with ``False``.
    Only occurrences of :data:`ESCALATION_MARKER` inside the TAIL REGION (the
    last :data:`_TAIL_REGION_LINES` non-empty lines) count as a signal and are
    stripped; a marker quoted earlier in the body is left intact and produces no
    signal. When a tail occurrence is removed the resulting trailing whitespace
    (including any dangling blank line the marker left behind) is collapsed, and
    ``(stripped, was_present)`` is returned.
    """
    if not isinstance(content, str):
        return content, False

    tail_start = _tail_region_start(content)
    matches = [m for m in _ESCALATION_MARKER_RE.finditer(content) if m.start() >= tail_start]
    if not matches:
        return content, False

    # Collapse trailing whitespace and any blank line left where the marker sat.
    stripped = _strip_matches(content, matches).rstrip()
    return stripped, True


def detect_and_strip_confidence_marker(content: Any) -> tuple[Any, ConfidenceLevel | None]:
    """Detect and remove the model's self-assessed confidence marker.

    Mirrors :func:`detect_and_strip_escalation_marker`: fail-open and
    tail-anchored. If ``content`` is not a string it is returned unchanged with
    ``None``. Only ``[CONFIDENCE:...]`` markers inside the TAIL REGION (the last
    :data:`_TAIL_REGION_LINES` non-empty lines, matched case-insensitively) are
    treated as signals and stripped so the user never sees them; a marker quoted
    earlier in the body is left intact and yields no signal. The parsed level is
    returned as ``(stripped, level)``:

    - ``level`` is the well-formed value ("low"/"medium"/"high") — the last valid
      one within the tail when several appear (the answer's final marker wins).
    - No tail marker, or a tail marker whose value is not one of the three,
      yields ``None`` (no signal). Malformed tail markers are still stripped.

    Order-insensitive with respect to the escalation marker: each marker is
    detected and removed independently, so both may co-occur in any order.
    """
    if not isinstance(content, str):
        return content, None

    tail_start = _tail_region_start(content)
    matches = [m for m in CONFIDENCE_MARKER_RE.finditer(content) if m.start() >= tail_start]
    if not matches:
        return content, None

    level: ConfidenceLevel | None = None
    for match in matches:
        candidate = match.group(1).strip().lower()
        if candidate in _VALID_CONFIDENCE_VALUES:
            level = candidate  # type: ignore[assignment]

    stripped = _strip_matches(content, matches).rstrip()
    return stripped, level
