"""What a chat turn delivered, on the trace that produced it (ADR-0089).

A turn's root observation was the least useful row in Langfuse. Its name was
the workflow's config type (``chat_deepresearcher_agent``), and its output was
NAT's ``output_preview``: the first fifty streamed bodies, which are step
events and text deltas, not the answer. Everything an analyst slices by
(answered or refused, shallow or deep, the confidence, how many sources) lived
only in the ``TurnResult`` the socket persists, so none of it could be charted,
filtered or compared across prompt versions in Langfuse.

The terminal ``TurnResult`` is the one authoritative record of a turn (the
persisted row is built from it and nothing else), so the trace is filled from
the same object:

* :func:`outcome_attributes` maps it to trace metadata, low-cardinality tags,
  the root observation's output (the answer text) and a level. Pure.
* :func:`begin_turn_outcome` binds a per-turn box in the socket's ``_drive``,
  the context the root span's export task snapshots; :func:`record_turn_finished`
  and :func:`record_turn_error` fill it IN PLACE when the terminal is relayed.
  In place matters for the same reason as the prompt link's box: the workflow
  and its export tasks run in copies of this context, and only a mutation of
  the shared dict is visible from all of them.
* ``TurnOutcomeProcessor`` (in ``langfuse_trace_attributes``) stamps the box
  onto the root span when it is exported, which is after the terminal.

No new content category: the answer text is what ``output.value`` was meant to
carry, and the rest is labels and counts.
"""

from __future__ import annotations

import contextvars
import logging
from collections import Counter
from typing import Any

from aiq_agent.observability.trace_context import OBSERVATION_LEVEL_ATTRIBUTE
from aiq_agent.observability.trace_context import OBSERVATION_STATUS_MESSAGE_ATTRIBUTE

logger = logging.getLogger(__name__)

METADATA_PREFIX = "langfuse.trace.metadata."
TAGS_ATTRIBUTE = "langfuse.trace.tags"
OBSERVATION_OUTPUT_ATTRIBUTE = "langfuse.observation.output"

#: Bound on the answer text written as the root's output. Langfuse stores it in
#: ClickHouse per observation; a report-length answer is still well inside.
_MAX_OUTPUT_CHARS = 32_000

_TURN_OUTCOME: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar("grid_turn_outcome", default=None)


def begin_turn_outcome() -> contextvars.Token[dict[str, Any] | None]:
    """Bind an empty box for one turn; the terminal fills it, the root span reads it."""
    return _TURN_OUTCOME.set({})


def end_turn_outcome(token: contextvars.Token[dict[str, Any] | None]) -> None:
    """Unbind the turn's box, restoring whatever was bound before."""
    _TURN_OUTCOME.reset(token)


def current_turn_outcome() -> dict[str, Any] | None:
    """The attributes recorded for this turn, or None when no turn bound a box or none finished."""
    box = _TURN_OUTCOME.get()
    return dict(box) if box else None


def _fill(attributes: dict[str, Any]) -> None:
    box = _TURN_OUTCOME.get()
    if box is None:
        return
    box.clear()
    box.update(attributes)


def record_turn_finished(body: Any) -> None:
    """Remember a finished turn's outcome for its root span. Never raises."""
    try:
        _fill(outcome_attributes(outcome=body.outcome, result=body.result))
    except Exception:
        logger.debug("Failed to record the turn outcome for its trace", exc_info=True)


def record_turn_error(code: str, message: str | None = None) -> None:
    """Remember that a turn failed, so its root reads ERROR rather than a healthy span. Never raises."""
    try:
        _fill(error_attributes(code=code, message=message))
    except Exception:
        logger.debug("Failed to record the turn error for its trace", exc_info=True)


def _card_types(cards: list[Any]) -> list[str]:
    kinds = (getattr(keyed, "card", {}).get("type") for keyed in cards)
    return sorted({kind for kind in kinds if isinstance(kind, str) and kind})


def _quote_counts(stamps: list[Any]) -> dict[str, int]:
    return dict(Counter(getattr(stamp, "status", None) for stamp in stamps if getattr(stamp, "status", None)))


def _level_for(outcome: str) -> str:
    """Cancelled is the asker's Stop: worth seeing, not a fault. Everything else that finished is DEFAULT."""
    return "WARNING" if outcome == "cancelled" else "DEFAULT"


def outcome_metadata(*, outcome: str, result: Any) -> dict[str, Any]:
    """The analyst-facing facts of one finished turn, absent values omitted."""
    removed = getattr(result, "citations_removed", None)
    quotes = _quote_counts(list(getattr(result, "quote_stamps", None) or []))
    facts: dict[str, Any] = {
        "turn_outcome": outcome,
        "answer_route": getattr(result, "routing_decision", None),
        "answer_confidence": getattr(result, "answer_confidence", None),
        "answer_confidence_capped": getattr(result, "answer_confidence_capped_reason", None),
        "answer_sources": len(getattr(result, "sources", None) or []),
        "answer_cards": len(getattr(result, "cards", None) or []),
        "answer_card_types": _card_types(list(getattr(result, "cards", None) or [])) or None,
        "answer_chars": len(getattr(result, "text", "") or ""),
        "citations_removed": removed.count if removed is not None else 0,
        "quotes_verbatim": quotes.get("verbatim"),
        "quotes_not_found": quotes.get("not_found"),
        "research_truncated": True if getattr(result, "research_truncated", False) else None,
        "skills_activated": list(getattr(result, "skills_activated", None) or []) or None,
        "reasoning_effort": getattr(result, "reasoning_effort", None),
        "handed_off_to_run": True if getattr(result, "run", None) is not None else None,
    }
    return {key: value for key, value in facts.items() if value is not None}


def outcome_tags(metadata: dict[str, Any]) -> list[str]:
    """Low-cardinality tags, the trace list's fast filter. Never ids, never free text."""
    tags = [f"outcome:{metadata['turn_outcome']}"]
    for key, prefix in (
        ("answer_route", "route"),
        ("answer_confidence", "confidence"),
        ("answer_confidence_capped", "capped"),
    ):
        if metadata.get(key):
            tags.append(f"{prefix}:{metadata[key]}")
    if metadata.get("citations_removed"):
        tags.append("citations-removed")
    if metadata.get("quotes_not_found"):
        tags.append("quote-not-found")
    if metadata.get("research_truncated"):
        tags.append("research-truncated")
    if metadata.get("handed_off_to_run"):
        tags.append("handed-off")
    return tags


def outcome_attributes(*, outcome: str, result: Any) -> dict[str, Any]:
    """Every attribute the root span of a finished turn gains. Pure."""
    metadata = outcome_metadata(outcome=outcome, result=result)
    attributes: dict[str, Any] = {f"{METADATA_PREFIX}{key}": value for key, value in metadata.items()}
    attributes[TAGS_ATTRIBUTE] = outcome_tags(metadata)
    attributes[OBSERVATION_LEVEL_ATTRIBUTE] = _level_for(outcome)
    text = getattr(result, "text", "") or ""
    if text.strip():
        attributes[OBSERVATION_OUTPUT_ATTRIBUTE] = text[:_MAX_OUTPUT_CHARS]
    return attributes


def error_attributes(*, code: str, message: str | None = None) -> dict[str, Any]:
    """The root span of a failed turn: ERROR, with the wire's code as its status. Pure."""
    attributes: dict[str, Any] = {
        f"{METADATA_PREFIX}turn_outcome": "error",
        f"{METADATA_PREFIX}error_code": code,
        TAGS_ATTRIBUTE: ["outcome:error", f"error:{code}"],
        OBSERVATION_LEVEL_ATTRIBUTE: "ERROR",
    }
    if message:
        attributes[OBSERVATION_STATUS_MESSAGE_ATTRIBUTE] = message[:500]
    return attributes
