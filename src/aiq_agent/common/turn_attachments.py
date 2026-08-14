"""The files the user attached to the current chat session.

Twin of :mod:`aiq_agent.common.focus_file`, deliberately separate from it.
``focus_file_name`` is *viewing* state — the one file the composer bar or a
visible peek says the user is looking at, always fully ingested. A session
attachment is an *act*: there can be several, they persist for the session
rather than for as long as a bar is open, and any of them may still be
mid-ingest, which a focused file never is.

Set from the ``user_message`` payload's ``session_attachments`` array (see
``docs/api/websocket-protocol.md``) at the top of the turn, read later in the
turn by whatever needs to know what the user just handed the agent.

Nothing here raises. A malformed frame must cost the turn its attachment
signal, never the turn itself.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any
from typing import Literal

from pydantic import BaseModel

logger = logging.getLogger(__name__)

#: How far along ingestion is for an attached file, as the agent needs to read
#: it — NOT a mirror of the upload UI's status. ``available_documents`` is
#: written by the async ingest job and the composer does not gate send, so a
#: file the user just dropped is routinely absent from the inventory for
#: seconds. ``indexing`` is the client saying "this document exists and is the
#: subject of this turn even though your inventory does not list it yet".
AttachmentState = Literal["ready", "indexing"]

#: Fallback for an entry that states no readable state. ``ready`` rather than
#: ``indexing`` because it asks nothing of the backend: an unknown state must
#: not make a reader wait for something that may already be there. The effect of
#: guessing wrong is the pre-existing behaviour (the document is simply not
#: found yet), which is the direction a guess should fail in.
DEFAULT_ATTACHMENT_STATE: AttachmentState = "ready"

#: Upper bound on attachments honoured from one frame. The client caps at the
#: same number, but the backend must not trust it: an unbounded array is prompt
#: cost paid every turn, from a value the client controls.
MAX_TURN_ATTACHMENTS = 10


class SessionAttachment(BaseModel):
    """One file the user attached to this chat session.

    NOTE: this is a pydantic type carried in ``ChatResearcherState``, so it is
    registered in the checkpointer's strict msgpack allow-list
    (``aiq_agent/common/__init__.py``, ``_build_checkpointer_serde``). Removing
    it from that list breaks checkpoint restore for every conversation that ever
    had an attachment.
    """

    file_name: str
    state: AttachmentState = DEFAULT_ATTACHMENT_STATE


# A tuple, not a list: a ContextVar default is shared by every context that
# never sets one, and a shared mutable default is a cross-turn leak waiting to
# happen. The accessor hands out a fresh list.
_turn_attachments: ContextVar[tuple[SessionAttachment, ...]] = ContextVar(
    "grid_turn_attachments",
    default=(),
)


def set_turn_attachments(attachments: list[SessionAttachment] | None) -> None:
    """Set (or clear) the attachments for the current turn.

    Callers MUST clear this — pass ``None`` or ``[]`` — on every path that does
    not state attachments. The variable outlives a single turn within a
    connection, so a stale value would silently re-scope a later attachment-free
    turn to a document the user has stopped talking about.
    """
    _turn_attachments.set(tuple(attachments or ()))


def get_turn_attachments() -> list[SessionAttachment]:
    """The current turn's attachments; empty when the turn declared none."""
    return list(_turn_attachments.get())


def _parse_state(raw: Any) -> AttachmentState:
    """Narrow a wire value to an :data:`AttachmentState`, fail-open to the default."""
    if isinstance(raw, str) and raw.strip().lower() in ("ready", "indexing"):
        return raw.strip().lower()  # type: ignore[return-value]
    return DEFAULT_ATTACHMENT_STATE


def parse_turn_attachments(raw: Any) -> list[SessionAttachment]:
    """The ``session_attachments`` wire value → attachments. Never raises.

    Tolerant by design, and the tolerance is per ENTRY: an unreadable entry is
    skipped and the rest of the array is honoured. A bad frame costs the turn
    the entries it could not read, not the turn.

    Skipped: anything that is not an object, an object whose ``file_name`` is
    missing, not a string, or blank. Duplicated file names collapse to the first
    occurrence, and the result is capped at :data:`MAX_TURN_ATTACHMENTS`.
    """
    if not isinstance(raw, list):
        if raw is not None:
            logger.debug("session_attachments is not a list, ignoring: %r", type(raw))
        return []

    parsed: list[SessionAttachment] = []
    seen: set[str] = set()
    for entry in raw:
        if not isinstance(entry, dict):
            logger.debug("Skipping non-object session_attachments entry")
            continue
        file_name = entry.get("file_name")
        if not isinstance(file_name, str) or not file_name.strip():
            logger.debug("Skipping session_attachments entry with no usable file_name")
            continue
        name = file_name.strip()
        if name in seen:
            continue
        seen.add(name)
        try:
            parsed.append(SessionAttachment(file_name=name, state=_parse_state(entry.get("state"))))
        except Exception:  # pragma: no cover - construction cannot fail post-narrowing
            logger.debug("Skipping unconstructible session_attachments entry", exc_info=True)
            continue
        if len(parsed) >= MAX_TURN_ATTACHMENTS:
            break
    return parsed
