"""The proposal card: an org-memory write a person has to accept.

An organization note lands in every project's digest across the tenant, so the
BFF refuses an agent-authored one unless the ACTING user holds
``org:memory:write`` (ADR-0054, spec AG-8). The refusal is not a dead end: it
degrades into a ``memory_proposal`` card the user can accept from their own
authenticated session, which is what turns an ungranted permission into a
visible offer instead of a silent write (spec AG-9).

ADR-0055 gave that path a second caller. The reflection stage used to refuse
organization scope by construction because there was no write-time
authorization gate and no human review; ADR-0054 supplied the gate and this card
IS the review, so reflection may now propose firm-wide findings through the same
refusal. One implementation for both callers, in its own module, because a
second copy of "how an org write becomes an offer" is how the two would drift.

Returns a boolean rather than raising: a caller with no card channel bound must
be able to fall back to an honest error string, and a card that could not be
shown is never worth failing a turn over.
"""

import logging

logger = logging.getLogger(__name__)


def build_memory_proposal_card(*, content: str, kind: str, confidence: str) -> dict | None:
    """One validated ``memory_proposal`` card, or ``None`` when it will not build.

    The card itself, separated from where it is delivered, because it now has
    two destinations and only one definition may exist. The in-turn ``remember``
    tool pushes it into the turn's card registry (below); the post-answer
    reflection stage cannot — the registry is snapshotted and unbound before the
    stages run — so it puts the SAME card on its stage frame, where the client
    already has a renderer for it (``features/chat/lib/turn-memory.ts`` reads a
    `memory_proposal` card as one of the two things the "Piloti hat sich
    gemerkt" chip is made of).
    """
    from aiq_agent.cards.models import grid_card_adapter

    card = {
        "type": "memory_proposal",
        "title": "Neue Erkenntnis merken",
        "content": content,
        "kind": kind,
        "confidence": confidence,
    }
    try:
        return grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except Exception:
        logger.exception("Failed to build memory_proposal card")
        return None


def emit_memory_proposal_card(*, content: str, kind: str, confidence: str) -> bool:
    """Register a ``memory_proposal`` card on the TURN's card registry.

    Returns ``True`` when the card was added to a bound conversation-scoped card
    registry, ``False`` when no card channel is available. Mirrors ``emit_card``'s
    ``None`` handling.

    Only an IN-TURN caller can use this. A post-answer stage runs after
    ``_run``'s ``finally`` has snapshotted and unbound the registry, so it takes
    :func:`build_memory_proposal_card` and its own frame instead.
    """
    from aiq_agent.cards.registry import get_card_registry

    registry = get_card_registry()
    if registry is None:
        return False
    validated = build_memory_proposal_card(content=content, kind=kind, confidence=confidence)
    if validated is None:
        return False
    registry.add(validated)
    logger.info("Emitted memory_proposal card (kind=%s) for user-authorized memory write", kind)
    return True
