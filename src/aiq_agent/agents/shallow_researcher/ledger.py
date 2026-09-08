"""What leaves the turn on the wire, and what the citation-health ledger records.

The wire carries only the sources the model cited in THIS turn's answer
(never the cumulative session registry) plus this turn's measurements, each
on its own coarse ``kind``. The ledger row is one batch per turn that
consulted a source or measured the model; a direct reply has nothing to
cite, and counting it would inflate the clean rate.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from aiq_agent.agents.bim.measurement_sources import MeasurementSource
from aiq_agent.agents.bim.measurement_sources import measurement_sources_to_wire
from aiq_agent.common import citation_events
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import source_entry_to_wire
from aiq_agent.common.citation_verification import source_label
from aiq_agent.common.citation_verification import source_origin_token

from .answer_pipeline import CitedSource
from .answer_pipeline import FinalAnswer
from .markers import answer_confidence_capped_reason
from .models import ShallowResearchAgentState

logger = logging.getLogger(__name__)


def citations_removed_summary(removed_citations: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """Summarise ``verify_citations`` drops for the transparency wire.

    ``{"count": int, "reasons": [str, ...]}`` (reasons deduplicated in
    first-seen order, max 5) only when at least one citation was removed;
    otherwise ``None`` so the ``citations_removed`` field stays absent. The
    shape matches the chat researcher's ``_normalize_citations_removed``.
    """
    if not removed_citations:
        return None
    reasons: list[str] = []
    for entry in removed_citations:
        reason = str(entry.get("reason") or "unverifiable") if isinstance(entry, dict) else "unverifiable"
        if reason not in reasons:
            reasons.append(reason)
        if len(reasons) >= 5:
            break
    return {"count": len(removed_citations), "reasons": reasons}


def wire_sources(cited: Sequence[CitedSource]) -> list[dict[str, Any]]:
    """Wire-ready sources for the Belegt-durch chips / PDF open.

    Serialised per entry so a single malformed source cannot zero out the
    whole turn's chips: a bad entry is skipped with a warning, the rest render.
    """
    wire: list[dict[str, Any]] = []
    for source in cited:
        try:
            wire.append(source_entry_to_wire(source.entry, number=source.number))
        except Exception:  # noqa: BLE001 - one bad entry must not drop the turn's chips
            logger.warning(
                "Skipping source that failed wire serialization: %s",
                source.entry.url or source.entry.citation_key,
                exc_info=True,
            )
    return wire


def record_turn_ledger(
    final: FinalAnswer,
    *,
    turn_sources: Sequence[SourceEntry],
    wire: Sequence[dict[str, Any]],
    measurement_grounded: bool,
) -> None:
    """One citation-health row for this turn. Best-effort: ``record_turn`` never raises.

    ``source_count`` is THIS turn's retrieval, not the cumulative conversation
    registry: it is the denominator ``cited_count`` is measured against, and
    ``cited_count`` has always been per turn. Measurements are on the wire but
    not in either count; counting one there would report a cited source out
    of zero retrieved ones.
    """
    citation_events.record_turn(
        agent="shallow",
        source_count=len(turn_sources),
        cited_count=len(wire),
        removed_citations=list(final.removed_citations),
        unverified_quote_count=final.unverified_quote_count,
        grounded=final.citation_grounded,
        fallback_used=final.citation_fallback_used,
        confidence_capped_reason=answer_confidence_capped_reason(
            final.confidence_marker,
            final.citation_grounded,
            final.quotes_verified,
            measurement_grounded=measurement_grounded,
            normative_claim_uncited=final.normative_claim_uncited,
            citation_fallback_used=final.citation_fallback_used,
        ),
        source_origins=[source_origin_token(entry).strip("[]").lower() or None for entry in turn_sources],
        source_lanes=[source.get("lane") for source in wire],
        source_tools=[entry.tool_name or None for entry in turn_sources],
        # Source IDENTITIES (URL / document key), never answer prose. They turn
        # the platform export from "3 citations removed" into "these three
        # documents were cited but never retrieved".
        retrieved_source_labels=[label for label in map(source_label, turn_sources) if label],
        cited_source_labels=[label for label in ((s.get("citation_key") or s.get("url")) for s in wire) if label],
    )


def assemble_result(
    graph_result: dict[str, Any],
    final: FinalAnswer,
    *,
    turn_sources: Sequence[SourceEntry],
    turn_measurements: Sequence[MeasurementSource],
) -> ShallowResearchAgentState:
    """The graph's output plus every signal of the final answer, as the state the chat node reads.

    ``answer_measurement_grounded`` was written by the tools node (the only
    place that sees raw tool results) and is echoed, not recomputed, so both
    grounding signals reach the chat node by the same path.
    """
    measurement_grounded = bool(graph_result.get("answer_measurement_grounded", False))
    wire = wire_sources(final.cited)
    result: dict[str, Any] = {
        **graph_result,
        "messages": final.messages,
        "answer_citation_grounded": final.citation_grounded,
        "answer_measurement_grounded": measurement_grounded,
        "answer_normative_claim_uncited": final.normative_claim_uncited,
        "answer_citation_fallback_used": final.citation_fallback_used,
        "answer_quotes_verified": final.quotes_verified,
        "escalation_requested": final.escalation_requested,
        "answer_confidence_marker": final.confidence_marker,
        "answer_confidence_marker_reason": final.confidence_marker_reason,
        "answer_escalation_reason": final.escalation_reason,
        "source_lookup_attempted": final.source_lookup_attempted,
        "answer_meta": final.answer_meta,
        "verified_sources": (wire + measurement_sources_to_wire(list(turn_measurements))) or None,
    }
    summary = citations_removed_summary(final.removed_citations)
    if summary is not None:
        result["citations_removed"] = summary
    if final.answered and (final.source_lookup_attempted or measurement_grounded):
        record_turn_ledger(final, turn_sources=turn_sources, wire=wire, measurement_grounded=measurement_grounded)
    return ShallowResearchAgentState.model_validate(result)
