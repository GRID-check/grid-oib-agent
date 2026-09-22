"""The ``task_created`` card: how the reader learns work was handed over.

A system card pushed by the tool that created the row, exactly the way
``remember`` pushes ``memory_proposal`` and the working directory pushes
``document_draft``. The model cannot fabricate one — which is the point, since
the sentence this whole tool exists to stop is an answer CLAIMING delegated work
with nothing behind it.

Informational: the row exists by the time the card renders, so there is nothing
to accept. The card's job is to be the thing a reader can come back to.
"""

from __future__ import annotations

import logging
from typing import Any

from pydantic import ValidationError

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import get_card_registry

logger = logging.getLogger(__name__)


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def emit_task_card(body: dict[str, Any], *, goal: str, kind: str) -> bool:
    """Put the delegated task in front of the reader; ``True`` when a card took it.

    Fail-open by construction, like every other system card: a turn with no bound
    card registry (a CLI run, a test) still created the task and still answers.
    The ROW is the product; the card is how it is announced.

    Everything the card states about the task comes from the route's own answer —
    the id, the title, the deadline it actually stored — rather than from what
    this tier asked for, so a card can never describe a task the BFF declined to
    create the way the caller described it.
    """
    registry = get_card_registry()
    if registry is None:
        return False

    task_id = _text(body.get("taskId"))
    if not task_id:
        logger.warning("Task API answered without a task id; no card emitted")
        return False

    card = {
        "type": "task_created",
        "task_id": task_id,
        "kind": _text(body.get("kind")) or kind,
        "title": _text(body.get("title")) or goal,
        "goal": goal,
        "due_at": _text(body.get("dueAt")),
        "conversation_id": _text(body.get("conversationId")),
    }
    try:
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("Failed to build task_created card for %s", task_id)
        return False
    registry.add(validated)
    logger.info("Emitted task_created card (task=%s kind=%s)", task_id, card["kind"])
    return True
