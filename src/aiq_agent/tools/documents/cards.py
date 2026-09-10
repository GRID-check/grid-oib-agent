"""The ``document_draft`` card: how the reader learns a draft was written.

The answer envelope carries no field for it. A written draft is a system card
pushed by the tool that wrote it, exactly the way ``remember`` pushes
``memory_proposal`` and ``surface_documents`` pushes ``document_grid``: the
model cannot fabricate one, and the card is addressable positionally like every
other card of the turn.
"""

from __future__ import annotations

import logging

from pydantic import ValidationError

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import get_card_registry

logger = logging.getLogger(__name__)

#: Room for the title read out of the document. The card sets it on one line
#: beside the path, so a heading someone wrote as a sentence is clipped rather
#: than allowed to wrap the card.
MAX_TITLE_CHARS = 120


def draft_title(path: str, content: str) -> str:
    """The document's own first heading, or its file name when it has none."""
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            heading = stripped.lstrip("#").strip()
            if heading:
                return heading[:MAX_TITLE_CHARS]
    return path.rsplit("/", 1)[-1]


def emit_draft_card(*, path: str, content: str, version: int) -> bool:
    """Put the draft in front of the reader; ``True`` when a card channel took it.

    Fail-open by construction: a turn with no bound card registry (a CLI run, a
    test) still writes the file and still answers. The write is the product;
    the card is how it is announced.
    """
    registry = get_card_registry()
    if registry is None:
        return False
    card = {
        "type": "document_draft",
        "title": draft_title(path, content),
        "path": path,
        "bytes": len(content.encode("utf-8")),
        "version": version,
    }
    try:
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("Failed to build document_draft card for %s", path)
        return False
    registry.add(validated)
    logger.info("Emitted document_draft card (path=%s version=%d)", path, version)
    return True
