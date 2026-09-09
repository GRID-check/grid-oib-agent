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


def emit_memory_proposal_card(*, content: str, kind: str, confidence: str) -> bool:
    """Build and register a ``memory_proposal`` confirmation card.

    Returns ``True`` when the card was added to a bound conversation-scoped card
    registry, ``False`` when no card channel is available. Mirrors ``emit_card``'s
    ``None`` handling.
    """
    from aiq_agent.cards.models import grid_card_adapter
    from aiq_agent.cards.registry import get_card_registry

    registry = get_card_registry()
    if registry is None:
        return False

    card = {
        "type": "memory_proposal",
        "title": "Neue Erkenntnis merken",
        "content": content,
        "kind": kind,
        "confidence": confidence,
    }
    try:
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except Exception:
        logger.exception("Failed to build memory_proposal card")
        return False
    registry.add(validated)
    logger.info("Emitted memory_proposal card (kind=%s) for user-authorized memory write", kind)
    return True
