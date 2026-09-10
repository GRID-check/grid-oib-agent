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


#: The stored filing keys, as the card's own field names. Spelled here rather
#: than imported from ``draft_store`` so this module keeps its one-way import
#: (the store imports the card, never the other way round).
_FILED_FIELDS = {
    "grid_filed_document_id": "document_id",
    "grid_filed_version_id": "version_id",
    "grid_filed_state": "version_state",
}


def _filed_fields(filing: dict[str, str] | None) -> dict[str, str]:
    """The three filed fields, or nothing at all when any of them is missing."""
    if not filing:
        return {}
    fields = {name: filing[key] for key, name in _FILED_FIELDS.items() if filing.get(key)}
    return fields if len(fields) == len(_FILED_FIELDS) else {}


def emit_draft_card(
    *,
    path: str,
    content: str,
    version: int,
    filing: dict[str, str] | None = None,
    title: str | None = None,
) -> bool:
    """Put the draft in front of the reader; ``True`` when a card channel took it.

    Fail-open by construction: a turn with no bound card registry (a CLI run, a
    test) still writes the file and still answers. The write is the product;
    the card is how it is announced.

    ``filing`` is the draft store's record of the project document this path was
    filed as (:data:`~aiq_agent.tools.documents.draft_store.FILING_KEYS`). Passed
    through rather than looked up here, because the two callers know it for
    different reasons: a write or an edit carries forward what the store held,
    and ``file_draft`` carries what the BFF just answered. A card whose filing is
    incomplete is emitted UNFILED rather than half-filed — the model validator
    would refuse the mixed shape, and losing the buttons is better than losing
    the card.
    """
    registry = get_card_registry()
    if registry is None:
        return False
    card = {
        "type": "document_draft",
        "title": title or draft_title(path, content),
        "path": path,
        "bytes": len(content.encode("utf-8")),
        "version": version,
        **_filed_fields(filing),
    }
    try:
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
    except ValidationError:
        logger.exception("Failed to build document_draft card for %s", path)
        return False
    registry.add(validated)
    logger.info("Emitted document_draft card (path=%s version=%d)", path, version)
    return True
