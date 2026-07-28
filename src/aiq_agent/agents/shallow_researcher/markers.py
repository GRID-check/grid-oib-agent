"""Control-marker detection for the shallow researcher's answer contract.

The shallow agent's prompt makes the model end research answers with two
control markers:

- ``[ESCALATE_TO_DEEP]`` — the model judged its own answer insufficient and
  asks to escalate to deep research.
- ``[CONFIDENCE:low|medium|high]`` (optionally ``[CONFIDENCE:low | Grund…]``)
  — the model's self-assessment of how well the answer is grounded in its
  sources, with an optional one-clause justification the UI surfaces so the
  reader can see WHY the level was chosen.

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
# form ``[CONFIDENCE:low|medium|high]``, optionally followed by ``| reason`` —
# a one-clause justification (in the answer's language) the UI shows so the
# reader understands WHY the level was chosen. The payload is bracketed and the
# level case-insensitive; the level token is validated against the enum below so
# a malformed value ("certain", empty, …) is stripped from the text but yields
# no signal. A reason is only meaningful with a valid level.
CONFIDENCE_MARKER_RE = re.compile(r"\[CONFIDENCE:\s*([^\]]*)\]", re.IGNORECASE)
_VALID_CONFIDENCE_VALUES = frozenset({"low", "medium", "high"})

# Hard bound on the surfaced justification: the prompt asks for one short
# clause, but a rambling model must not bloat the wire payload or the chip.
_CONFIDENCE_REASON_MAX_CHARS = 300

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


def _parse_confidence_payload(payload: str) -> tuple[ConfidenceLevel | None, str | None]:
    """Split a marker payload into its level and optional reason.

    The payload is everything between ``[CONFIDENCE:`` and ``]``: a level token,
    optionally followed by ``|`` and a one-clause justification
    (``"high | Direkt durch OIB-RL 2 belegt"``). The level is the text before
    the FIRST ``|`` (stripped, lowercased, enum-validated); the reason is the
    remainder, trimmed and capped at :data:`_CONFIDENCE_REASON_MAX_CHARS`. A
    payload without ``|`` yields no reason; a payload whose level token is not
    one of the three valid values yields ``(None, None)`` — an unknown level
    never invents a signal, and a reason without a valid level is meaningless.
    """
    level_token, _, raw_reason = payload.partition("|")
    candidate = level_token.strip().lower()
    if candidate not in _VALID_CONFIDENCE_VALUES:
        return None, None
    reason = raw_reason.strip()[:_CONFIDENCE_REASON_MAX_CHARS] or None
    return candidate, reason  # type: ignore[return-value]


def detect_and_strip_confidence_marker(content: Any) -> tuple[Any, ConfidenceLevel | None, str | None]:
    """Detect and remove the model's self-assessed confidence marker.

    Mirrors :func:`detect_and_strip_escalation_marker`: fail-open and
    tail-anchored. If ``content`` is not a string it is returned unchanged with
    ``(content, None, None)``. Only ``[CONFIDENCE:...]`` markers inside the TAIL
    REGION (the last :data:`_TAIL_REGION_LINES` non-empty lines, matched
    case-insensitively) are treated as signals and stripped so the user never
    sees them; a marker quoted earlier in the body is left intact and yields no
    signal. The parsed signal is returned as ``(stripped, level, reason)``:

    - ``level`` is the well-formed value ("low"/"medium"/"high") — the last
      valid one within the tail when several appear (the answer's final marker
      wins); ``reason`` is that marker's optional ``| …`` justification.
    - No tail marker, or a tail marker whose level is not one of the three,
      yields ``(stripped, None, None)`` (no signal). Malformed tail markers are
      still stripped.

    Order-insensitive with respect to the escalation marker: each marker is
    detected and removed independently, so both may co-occur in any order.
    """
    if not isinstance(content, str):
        return content, None, None

    tail_start = _tail_region_start(content)
    matches = [m for m in CONFIDENCE_MARKER_RE.finditer(content) if m.start() >= tail_start]
    if not matches:
        return content, None, None

    level: ConfidenceLevel | None = None
    reason: str | None = None
    for match in matches:
        candidate, candidate_reason = _parse_confidence_payload(match.group(1))
        if candidate is not None:
            level = candidate
            reason = candidate_reason

    stripped = _strip_matches(content, matches).rstrip()
    return stripped, level, reason


# ---------------------------------------------------------------------------
# Overconfidence guard
# ---------------------------------------------------------------------------
#
# Pure functions over a parsed ``[CONFIDENCE:…]`` level: the deterministic cap
# the platform applies to the model's self-assessment. They live here, beside
# the marker contract they interpret, so every consumer shares one
# implementation — the chat orchestrator (which surfaces the level) and the
# research agents (which record the cap as a citation-health event) alike.


def surface_answer_confidence(
    self_reported: ConfidenceLevel | None,
    citation_grounded: bool,
    quotes_verified: bool = True,
) -> ConfidenceLevel | None:
    """Apply the deterministic overconfidence guard to a self-reported level.

    Returns ``None`` when there is no self-assessment to surface. Otherwise caps
    the surfaced value at "low" whenever the answer is not grounded in a verified
    citation (empty registry or verification removed every citation) OR carries a
    quoted span that could not be verified against a retrieved passage
    (``quotes_verified`` is False — the weak model's "real section, fabricated
    quote" pattern). A self-reported "high"/"medium" in either case is
    untrustworthy and becomes "low"; a fully grounded answer with all quotes
    verified surfaces the model's own level verbatim.
    """
    if self_reported is None:
        return None
    if not citation_grounded or not quotes_verified:
        return "low"
    return self_reported


def answer_confidence_capped_reason(
    self_reported: ConfidenceLevel | None,
    citation_grounded: bool,
    quotes_verified: bool = True,
) -> Literal["ungrounded", "quote_unverified"] | None:
    """Why the surfaced confidence was capped, or ``None`` when no cap applied.

    Returns a reason only when a real downgrade happened: a self-reported
    "medium"/"high" that got capped to "low". ``"ungrounded"`` when the answer is
    not grounded in a verified citation (the more fundamental failure, so it wins
    when both apply); ``"quote_unverified"`` when the answer is grounded but
    carries a quoted span not verifiable against a retrieved passage. A missing
    self-report, an already-"low" self-report, or a fully-verified grounded
    answer is not a downgrade and yields ``None``.
    """
    if self_reported is None or self_reported == "low":
        return None
    if not citation_grounded:
        return "ungrounded"
    if not quotes_verified:
        return "quote_unverified"
    return None
