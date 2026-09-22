"""The ``file_operation_proposal`` card: one card per verb, per turn.

Pushed by the four write-side tools the way ``remember`` pushes
``memory_proposal`` — the model cannot emit this type at all
(``SYSTEM_CARD_TYPES``), so a card that says „diese vier Dateien verschieben"
names four files the turn actually resolved.

## Why a second call EXTENDS the card instead of adding one

„Räum die Einreichunterlagen zusammen" is four moves. Four cards ask the same
question four times, and a reader who accepts three of them and forgets the
fourth has left the project half-tidied with nothing on screen saying so. One
card carrying four moves is one decision, applied in order, reporting per row
what happened.

The tools keep a one-operation signature — that is what the model can get
right — and the merge happens here: a call whose card is already open for the
SAME operation appends to it. A different operation opens its own card, because
a move and a rename are not one decision, and the cap
(``MAX_FILE_OPERATIONS``) is where a proposal stops being readable and starts
being a job.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import ValidationError

from aiq_agent.cards.models import MAX_FILE_OPERATIONS
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import get_card_registry

logger = logging.getLogger(__name__)

CARD_TYPE = "file_operation_proposal"


def _open_card(registry: Any, operation: str) -> dict[str, Any] | None:
    """The card this turn already opened for ``operation``, if it can take more.

    ``snapshot()`` is a SHALLOW copy, so the dicts it hands back are the ones
    the registry will deliver — which is what lets this extend a card in place
    rather than needing a mutation API the registry does not have. The
    extension is written back through :func:`_replace`, validated, so a merged
    card is exactly as checked as a fresh one.
    """
    for card in reversed(registry.snapshot()):
        if card.get("type") != CARD_TYPE:
            continue
        if card.get("operation") != operation:
            return None
        return card if len(card.get("operations") or []) < MAX_FILE_OPERATIONS else None
    return None


def _replace(target: dict[str, Any], card: dict[str, Any]) -> None:
    """Overwrite the registered dict in place, keeping its position in the array.

    Position is identity for a card: ``cardKey`` is ``type-index`` and the
    frontend resolves a persisted decision against it, so a merged card must
    stay where it was.
    """
    target.clear()
    target.update(card)


def propose_file_operation(*, operation: str, title: str, item: dict[str, Any], note: str | None = None) -> bool:
    """Put one proposed operation in front of the reader; ``True`` when a card took it.

    ``False`` means there is no card channel bound (a CLI run, an eval, the job
    worker) — the caller must then tell the model plainly that it could not
    propose anything, because a tool that silently swallows the proposal and
    reports success is a tool that makes the answer claim a change nobody was
    ever offered.
    """
    registry = get_card_registry()
    if registry is None:
        return False

    existing = _open_card(registry, operation)
    operations = [*(existing.get("operations") or []), item] if existing else [item]
    card = {
        "type": CARD_TYPE,
        # The title of a card that has grown is the LAST one written: it was
        # composed knowing how many rows there are, and „Vier Dateien
        # verschieben" is only true of the fourth call.
        "title": title,
        "operation": operation,
        "operations": operations,
        "note": note,
    }
    try:
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("Failed to build file_operation_proposal card (operation=%s)", operation)
        return False

    if existing is not None:
        _replace(existing, validated)
    else:
        registry.add(validated)
    logger.info("Proposed %s file operation (%d on the card)", operation, len(operations))
    return True
