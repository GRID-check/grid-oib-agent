"""What the turn records about a lookup: the ledger and the span.

Two consumers, both of which already exist for ``knowledge_search`` and
neither of which could see RIS before:

* the per-round LEDGER (``turn_status.record_lane_hit``) — one entry per
  RETURNED passage, not per hit scanned. A RIS search used to capture twenty
  documents it never read, so the Herleitung drew twenty for a round that
  produced one;
* the ``retrieve.ris_lookup`` SPAN — the same fields ``knowledge_search``
  emits, because the loop eval's columns read the same spans for both tools.

Fail-open by contract: telemetry is worth strictly less than the answer it
describes and must never take a turn down.
"""

from __future__ import annotations

import logging
import re

from ris_adapter.lookup.address import Address
from ris_adapter.lookup.extract import MAX_PASSAGES
from ris_adapter.lookup.passages import Passage
from ris_adapter.lookup.trace import LookupTrace
from ris_adapter.register import _capture_lane_hits

logger = logging.getLogger(__name__)


def capture_passages(passages: list[Passage]) -> None:
    """One ledger entry per RETURNED passage: the document, titled, with its §."""
    _capture_lane_hits([(p.url, p.title or None, p.punkt_label or None) for p in passages])


def emit_lookup_span(question: str, address: Address, trace: LookupTrace, passages: list[Passage]) -> None:
    """One ``retrieve.ris_lookup`` observation, mirroring ``knowledge_search``."""
    try:
        from types import SimpleNamespace

        from aiq_agent.observability.retrieval_trace import build_retrieval_input
        from aiq_agent.observability.retrieval_trace import emit_retrieval_span

        search_input = build_retrieval_input(
            query=question,
            retrieval_query=trace.searched or None,
            collections=[SimpleNamespace(collection=p.collection, shelf="base") for p in passages],
            candidate_k=len(trace.candidates),
            top_k=MAX_PASSAGES,
            reranked=False,
            dropped_by_floor=0,
        )
        search_input.update(_span_context(question, address, trace, passages))
        emit_retrieval_span(tool_name="ris_lookup", search_input=search_input, picks=_span_picks(passages))
    except Exception:  # noqa: BLE001 — tracing must never break the lookup
        logger.debug("ris_lookup: retrieval span not emitted", exc_info=True)


def _span_context(question: str, address: Address, trace: LookupTrace, passages: list[Passage]) -> dict:
    """The half of the span that explains WHY these passages."""
    from aiq_agent.common.turn_status import current_retrieval_round

    context = {
        "round": current_retrieval_round(),
        "tool": "ris_lookup",
        "normalized_query": re.sub(r"\s+", " ", question or "").strip().casefold(),
        "documents_fetched": len(trace.fetched),
        # Whether this call cost an extractor LLM call at all: a named § does not.
        "deterministic": address.has_section,
    }
    if address.bundesland:
        context["bundesland"] = address.bundesland
        context["bundesland_source"] = address.bundesland_source
    if trace.application:
        context["application"] = trace.application
    if not passages:
        context["empty"] = True
    return context


def _span_picks(passages: list[Passage]) -> dict:
    """The picks themselves — citation keys and § ids, never passage text."""
    picks: dict = {
        "picked": [{"file": p.citation, "score": round(p.score, 4), "collection": p.collection} for p in passages]
    }
    keys = [p.citation for p in passages if p.citation]
    if keys:
        picks["citation_keys"] = keys
    punkt_ids = [p.punkt_label for p in passages if p.punkt_label]
    if punkt_ids:
        picks["punkt_ids"] = punkt_ids
    return picks
