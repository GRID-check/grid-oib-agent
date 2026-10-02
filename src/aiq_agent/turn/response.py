"""The crossing from finished graph state to the turn's result and to the
post-answer stages' facts.

State field in, :class:`~aiq_agent.common.wire_v2.TurnResult` field (or
``TurnFacts`` field) out. Kept as module-level functions rather than inline
code in the workflow because inline they could only be exercised by standing
up the whole NAT workflow — which is how ``skills_hidden`` could be set by
Piloti, declared by the frontend, and still never reach a reader, and how
``research_truncated`` rode the wire for months without the one stage gate
that needed it ever reading it. The result is a closed model: a field the
contract does not name cannot be set, and one it names cannot be forgotten
without its test reading back the default.
"""

from __future__ import annotations

import dataclasses
import uuid
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.canned_replies import NO_RESPONSE_TEXT
from aiq_agent.common.wire_v2 import KeyedCard
from aiq_agent.common.wire_v2 import QuoteStamp
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import RunHandoff
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.common.wire_v2 import card_key
from aiq_agent.memory.restriction import RestrictionEvidence
from aiq_agent.memory.restriction import restricted_digest_notes
from aiq_agent.memory.restriction import restriction_evidence
from aiq_agent.memory.shown_notes import ShownNotes
from aiq_agent.stages import TurnFacts

if TYPE_CHECKING:
    from aiq_agent.agents.piloti.models import ConversationState


def answer_message_id(conversation_id: str | None, turn_id: str | None) -> str:
    """The answer's id, stable per ``(conversation, turn)``: ``RUN_STARTED``, every text body and the persisted row.

    ``turn_id`` is the id of the user message that opened the turn. Deriving
    the id means an accidental double persist collides on the messages
    route's primary key (``onConflictDoNothing`` on ``messages.id``) and no-ops.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"grid:assistant:{conversation_id}:{turn_id or 'default'}"))


def answer_text(state: ConversationState) -> str:
    """The delivered answer: the last message's content, as text."""
    if not state.messages:
        return NO_RESPONSE_TEXT
    content = state.messages[-1].content
    return content if isinstance(content, str) else str(content)


def _run_handoff(state: ConversationState) -> RunHandoff | None:
    if state.run_id and state.run_message_id:
        return RunHandoff(run_id=state.run_id, run_message_id=state.run_message_id)
    return None


def build_result(state: ConversationState, cards: list[dict[str, Any]], message_id: str) -> TurnResult:
    """Everything the finished turn delivers, lifted off its final state.

    A retry hint travels only with the queue refusal it belongs to, and the
    hidden-skill list only with the skills it mutes.
    """
    skills_activated = list(state.skills_activated or [])
    return TurnResult(
        message_id=message_id,
        text=answer_text(state),
        cards=[KeyedCard(key=card_key(card), card=card) for card in cards],
        sources=list(state.verified_sources or []),
        read_sources=list(state.read_sources or []),
        answer_meta=state.answer_meta or None,
        answer_confidence=state.answer_confidence,
        answer_confidence_reason=state.answer_confidence_reason or None,
        answer_confidence_capped_reason=state.answer_confidence_capped_reason,
        routing_decision=state.routing_decision,
        escalation_reason=state.escalation_reason or None,
        citations_removed=state.citations_removed or None,
        research_truncated=bool(state.research_truncated),
        job_admission_rejected=bool(state.job_admission_rejected),
        retry_after_seconds=state.retry_after_seconds if state.job_admission_rejected else None,
        skills_activated=skills_activated,
        skills_hidden=list(state.skills_hidden or []) if skills_activated else [],
        retrieval_ledger=list(state.retrieval_ledger or []),
        quote_stamps=[QuoteStamp.model_validate(stamp) for stamp in state.quote_stamps or []],
        run=_run_handoff(state),
    )


def finished(result: TurnResult) -> RunFinishedBody:
    """The terminal body: a hand-off when the turn commissioned a run, a refusal when the queue said no."""
    if result.run is not None:
        return RunFinishedBody(outcome="handed_off", result=result)
    if result.job_admission_rejected:
        return RunFinishedBody(outcome="refused", result=result)
    return RunFinishedBody(outcome="answered", result=result)


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


def _source_collections(sources: object) -> list[str]:
    """The ``collection`` of each wire source dict; defensive about the shape."""
    collections: list[str] = []
    for source in sources or ():
        collection = source.get("collection") if isinstance(source, dict) else getattr(source, "collection", None)
        if isinstance(collection, str) and collection:
            collections.append(collection)
    return collections


def turn_restriction_evidence(
    state: ConversationState,
    *,
    registry_collections: tuple[str, ...] = (),
    listed_documents: tuple[Any, ...] = (),
    restricted_notes: tuple[str, ...] = (),
    earlier_notes: ShownNotes | None = None,
) -> RestrictionEvidence:
    """What the finished turn could have taken from restricted folders (ADR-0078).

    Read: what it cited and what it read without citing, plus the collections
    of the conversation's citation registry (``registry_collections``), whose
    passages sit in the history the turn answered from. Listed: every inventory
    row the turn could name (``listed_documents``, uncapped, as ``list_files``
    sees them), else the capped rows its prompt carried. Notes: restricted
    memory the prompt carried (``restricted_notes``) and that earlier turns
    of the conversation were shown (``earlier_notes``).
    """
    earlier = earlier_notes or ShownNotes()
    return restriction_evidence(
        state.collection_scope,
        source_collections=[
            *_source_collections(state.verified_sources),
            *_source_collections(state.read_sources),
            *registry_collections,
        ],
        listed_documents=listed_documents or state.available_documents or (),
        restricted_notes=restricted_notes,
        earlier_notes=earlier.notes,
        always=earlier.overflowed,
    )


def post_answer_turn_facts(
    request_facts: TurnFacts,
    *,
    state: ConversationState,
    query_text: str,
    cards: object,
    remembered_this_turn: tuple[str, ...] = (),
    registry_collections: tuple[str, ...] = (),
    listed_documents: tuple[Any, ...] = (),
    restricted_memory_writes: tuple[str, ...] = (),
    earlier_restricted_notes: ShownNotes | None = None,
) -> TurnFacts:
    """Complete the turn's :class:`TurnFacts` from the finished graph state.

    ``request_facts`` is the request-scoped half, captured while the request
    context was still live; this adds the turn-scoped half.
    """
    return dataclasses.replace(
        request_facts,
        query=query_text,
        answer=answer_text(state),
        routing_decision=state.routing_decision,
        research_truncated=bool(state.research_truncated),
        run_id=state.run_id,
        emitted_card_types=emitted_card_types(cards),
        answer_confidence=state.answer_confidence,
        remembered_this_turn=remembered_this_turn,
        restriction=turn_restriction_evidence(
            state,
            registry_collections=registry_collections,
            listed_documents=listed_documents,
            # The digest the agent was shown, and what the tool stored as
            # restricted this turn: restricted memory in the prompt.
            restricted_notes=(*restricted_digest_notes(request_facts.memory_digest), *restricted_memory_writes),
            earlier_notes=earlier_restricted_notes,
        ),
    )
