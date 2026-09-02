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


#: Why a self-report was downgraded. Five causes, three of them about the second
#: kind of grounding (see :mod:`.grounding`):
#:
#: - ``ungrounded``             no verified citation, and nothing was measured.
#: - ``quote_unverified``       a quoted span matched no retrieved passage.
#: - ``normative_claim_uncited`` the answer WAS measurement-grounded, but it also
#:   talks about the law without a verified citation — the mixed case, reported
#:   rather than resolved silently in the measurement's favour.
#: - ``measurement_only``       measurement-grounded and purely descriptive, so
#:   "high" was reduced to "medium" instead of to "low".
#: - ``citation_fallback``      nothing the model cited survived verification and
#:   the grounding comes from the single-source fallback — a source the agent
#:   attached, possibly captured on an EARLIER turn of the conversation. It
#:   grounds the answer no further than a measurement does.
CappedReason = Literal[
    "ungrounded",
    "quote_unverified",
    "normative_claim_uncited",
    "measurement_only",
    "citation_fallback",
]

#: The ceiling measurement grounding can reach. Never "high": that level is
#: reserved for an answer verified against a retrieved passage, and a measurement
#: is grounding for the answer's NUMBERS, not for every sentence around them.
#: This is the structural half of the anti-laundering design — it holds even if
#: the normative-claim heuristic misses something.
MEASUREMENT_CONFIDENCE_CEILING: ConfidenceLevel = "medium"

_CONFIDENCE_ORDER: tuple[ConfidenceLevel, ...] = ("low", "medium", "high")


def _at_most(level: ConfidenceLevel, ceiling: ConfidenceLevel) -> ConfidenceLevel:
    """``level`` clamped down to ``ceiling`` — never raises a self-report."""
    return level if _CONFIDENCE_ORDER.index(level) <= _CONFIDENCE_ORDER.index(ceiling) else ceiling


def surface_answer_confidence(
    self_reported: ConfidenceLevel | None,
    citation_grounded: bool,
    quotes_verified: bool = True,
    *,
    measurement_grounded: bool = False,
    normative_claim_uncited: bool = False,
    citation_fallback_used: bool = False,
) -> ConfidenceLevel | None:
    """Apply the deterministic overconfidence guard to a self-reported level.

    Returns ``None`` when there is no self-assessment to surface. Otherwise the
    guard recognises TWO kinds of grounding and treats them differently.

    **Citation grounding** is unchanged and is the only route to "high": an
    answer grounded in a verified citation with every quoted span verified
    surfaces the model's own level verbatim.

    **Measurement grounding** (``measurement_grounded`` — this turn produced at
    least one ``declared``/``computed`` answer from the IFC model; see
    :mod:`.grounding`) is the second kind. An IFC measurement carries a
    provenance, a tolerance, a readable method and the GlobalIds it came from;
    it is reproducible, and it has no passage to quote. It lifts an answer off
    the "low" floor — but only as far as
    :data:`MEASUREMENT_CONFIDENCE_CEILING` ("medium"), and only when
    ``normative_claim_uncited`` is False.

    Everything else still caps at "low", and the order of the branches is the
    guard:

    - An unverified quote caps to "low" BEFORE measurement grounding is
      consulted. A measured number elsewhere in the answer must never rescue a
      fabricated quotation — that pattern is the entire reason this guard exists.
    - An answer that is measurement-grounded but ALSO makes an un-cited normative
      claim (``normative_claim_uncited``) caps to "low" exactly as today. The
      measurement grounds the measurement; it does not ground a statement about
      the Bauordnung, and there is no per-sentence confidence to split them with.

    **Fallback grounding** (``citation_fallback_used``) is the third case and it
    is deliberately NOT the first. The agent's single-source fallback appends
    one registry source when nothing the model cited survived verification — and
    the registry is cumulative across the conversation, so that source may have
    been retrieved two turns ago for a different question. Treated as citation
    grounding it laundered the whole answer: the normative brake never ran (it
    is gated on the absence of citation grounding), and a measured answer that
    also asserted „…erfüllt damit OIB 4" surfaced at the model's own "high" with
    an unrelated Bauordnung link attached. So a fallback citation buys exactly
    what a measurement buys — at most "medium", and nothing at all once the
    normative brake is up.
    """
    if self_reported is None:
        return None
    # A fallback flag without citation grounding describes nothing — the
    # fallback IS the grounding. Normalised here so a caller that only sets one
    # of the two cannot produce a cap nobody can explain.
    fallback_grounded = citation_grounded and citation_fallback_used
    if citation_grounded and quotes_verified and not fallback_grounded:
        return self_reported
    if not quotes_verified:
        # A quote that no passage backs verbatim is marked inline where it
        # stands; the answer around it may still rest on verified citations.
        # A grounded answer with one unverified quote is partial grounding
        # with a gap — "medium" by the reader's own definition of the levels —
        # not the "low" of an answer nothing supports. Without citation
        # grounding there is nothing under the quote, and it is "low".
        if citation_grounded and not fallback_grounded:
            return _at_most(self_reported, MEASUREMENT_CONFIDENCE_CEILING)
        return "low"
    if (measurement_grounded or fallback_grounded) and not normative_claim_uncited:
        return _at_most(self_reported, MEASUREMENT_CONFIDENCE_CEILING)
    return "low"


def answer_confidence_capped_reason(
    self_reported: ConfidenceLevel | None,
    citation_grounded: bool,
    quotes_verified: bool = True,
    *,
    measurement_grounded: bool = False,
    normative_claim_uncited: bool = False,
    citation_fallback_used: bool = False,
) -> CappedReason | None:
    """Why the surfaced confidence was capped, or ``None`` when no cap applied.

    Derived from :func:`surface_answer_confidence` rather than re-deriving the
    branches, so the reason can never disagree with the level it explains: a
    reason is returned only when that function actually returned something lower
    than the self-report.

    Precedence, and why:

    - ``quote_unverified`` first whenever the answer had *some* grounding
      (citation or measurement) but a quoted span did not survive. The quote is
      why the answer sits at "low"; naming the grounding instead would read as
      though the measurement had helped.
    - ``normative_claim_uncited`` for the mixed case — measured numbers plus an
      un-cited claim about the law. The level is the same "low" this answer got
      before the change; the REASON is the change, because it is the only place
      the mixed case becomes visible to a reviewer or to the citation-health
      ledger.
    - ``measurement_only`` when a measured, purely descriptive answer had "high"
      reduced to "medium".
    - ``citation_fallback`` when the only citation grounding came from the
      agent's single-source fallback and there was no measurement — the source
      is real but the model never cited it, and it may predate this turn, so the
      cap has to say that rather than claim a measurement it does not have.
    - ``"ungrounded"`` otherwise — the original cause, unchanged: nothing
      verified and nothing measured.

    A missing self-report, an already-"low" self-report, or a fully-verified
    grounded answer is not a downgrade and yields ``None``.
    """
    if self_reported is None or self_reported == "low":
        return None
    surfaced = surface_answer_confidence(
        self_reported,
        citation_grounded,
        quotes_verified,
        measurement_grounded=measurement_grounded,
        normative_claim_uncited=normative_claim_uncited,
        citation_fallback_used=citation_fallback_used,
    )
    if surfaced == self_reported:
        return None
    if not quotes_verified and (citation_grounded or measurement_grounded):
        return "quote_unverified"
    fallback_grounded = citation_grounded and citation_fallback_used
    if not citation_grounded or fallback_grounded:
        # Fallback grounding is judged with the measurement, not with the
        # verified citation it is not: it lifts the same amount and is stopped
        # by the same brake.
        if (measurement_grounded or fallback_grounded) and normative_claim_uncited:
            return "normative_claim_uncited"
        if measurement_grounded:
            return "measurement_only"
        if fallback_grounded:
            return "citation_fallback"
        return "ungrounded"
    return "quote_unverified"
