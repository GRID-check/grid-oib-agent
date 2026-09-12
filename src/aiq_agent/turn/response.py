"""The crossing from finished graph state to the wire response and to the
post-answer stages' facts.

State field name in, response attribute (or ``TurnFacts`` field) out. Kept as
module-level functions with a table rather than inline code in the workflow
because inline they could only be exercised by standing up the whole NAT
workflow — which is how ``skills_hidden`` could be set by
Piloti, declared by the frontend, and still never reach a reader, and how
``research_truncated`` rode the wire for months without the one stage gate
that needed it ever reading it.
"""

from __future__ import annotations

import dataclasses
import logging
from typing import TYPE_CHECKING

from aiq_agent.common import _create_chat_response
from aiq_agent.stages import TurnFacts
from nat.data_models.api_server import ChatResponse

if TYPE_CHECKING:
    from aiq_agent.agents.piloti.models import ConversationState

logger = logging.getLogger(__name__)

NO_RESPONSE_TEXT = "No response generated."

#: ``(state field, response attribute, state field it may only accompany)``.
#: The frontend renders every extra on PRESENCE, so a field is lifted only
#: when it holds a value — never null-spammed — and a dependent field only
#: alongside the one it qualifies: a retry hint means nothing without the
#: rejection it belongs to, and an empty mute list is the same fact as no
#: mute list.
RESPONSE_LIFTS: tuple[tuple[str, str, str | None], ...] = (
    ("deep_research_job_id", "deep_research_job_id", None),
    ("answer_confidence", "answer_confidence", None),
    ("verified_sources", "sources", None),
    ("read_sources", "read_sources", None),
    ("routing_decision", "routing_decision", None),
    ("escalation_reason", "escalation_reason", None),
    ("answer_confidence_capped_reason", "answer_confidence_capped_reason", None),
    ("answer_confidence_reason", "answer_confidence_reason", None),
    ("citations_removed", "citations_removed", None),
    ("research_truncated", "research_truncated", None),
    ("job_admission_rejected", "job_admission_rejected", None),
    ("retry_after_seconds", "retry_after_seconds", "job_admission_rejected"),
    ("skills_activated", "skills_activated", None),
    ("skills_hidden", "skills_hidden", "skills_activated"),
    ("answer_meta", "answer_meta", None),
)


def answer_text(state: ConversationState) -> str:
    """The delivered answer: the last message's content, as text."""
    if not state.messages:
        return NO_RESPONSE_TEXT
    content = state.messages[-1].content
    return content if isinstance(content, str) else str(content)


def apply_state_extras(response: ChatResponse, state: ConversationState) -> None:
    """Lift every present extra in :data:`RESPONSE_LIFTS` off ``state`` onto ``response``.

    Presence is TRUTHINESS, one rule for the whole table, which is what lets the table be
    data. It costs one case: a numeric extra of ``0`` does not reach the wire. Only
    ``retry_after_seconds`` is numeric, and both of its producers default to a non-zero
    value (``JobAdmissionError`` 30, ``TurnAdmissionError`` 15), so 0 is unreachable —
    pinned by ``test_a_retry_hint_is_never_zero_seconds`` so that a default someone
    lowers to 0 fails here rather than dropping the hint silently.
    """
    for field, attribute, requires in RESPONSE_LIFTS:
        value = getattr(state, field)
        if not value or (requires and not getattr(state, requires)):
            continue
        setattr(response, attribute, value)


def build_response(state: ConversationState, *, cards: list | None, workflow_id: str) -> ChatResponse:
    """The wire response for a finished turn: answer text, cards, and the extras."""
    response = _create_chat_response(answer_text(state), response_id="research_response", model=workflow_id)
    if cards:
        logger.info("Attaching %d card(s) to ChatResponse", len(cards))
        response.cards = cards
    apply_state_extras(response, state)
    return response


def emitted_card_types(cards: object) -> frozenset[str]:
    """Card types the model emitted in-turn, so a stage can decline to duplicate
    something the reader already has. Defensive about the card shape: a stage
    fact is never worth a failed turn."""
    types: set[str] = set()
    for card in cards or ():
        card_type = card.get("type") if isinstance(card, dict) else getattr(card, "type", None)
        if isinstance(card_type, str) and card_type:
            types.add(card_type)
    return frozenset(types)


def post_answer_turn_facts(
    request_facts: TurnFacts,
    *,
    state: ConversationState,
    response: ChatResponse,
    query_text: str,
    cards: object,
    remembered_this_turn: tuple[str, ...] = (),
) -> TurnFacts:
    """Complete the turn's :class:`TurnFacts` from the finished graph state.

    ``request_facts`` is the request-scoped half, captured while the request
    context was still live; this adds the turn-scoped half.
    """
    return dataclasses.replace(
        request_facts,
        query=query_text,
        answer=answer_text(state),
        routing_decision=getattr(response, "routing_decision", None),
        research_truncated=bool(state.research_truncated),
        deep_research_job_id=state.deep_research_job_id,
        emitted_card_types=emitted_card_types(cards),
        answer_confidence=state.answer_confidence,
        remembered_this_turn=remembered_this_turn,
    )
