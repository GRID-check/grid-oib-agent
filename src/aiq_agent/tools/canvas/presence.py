"""Piloti's presence on a document, for one turn: where it pointed, so the turn can leave.

``point`` and ``highlight`` put Piloti's cursor and a labelled box in front of
everyone who has the document open. Both are ephemeral, and both must go when
the turn that made them is over, however it ends: a cursor left behind says
Piloti is still looking. So the tools note each document they appeared on
here, and the turn harness sends ONE ``leave`` per document once the answer is
out (``agents/piloti/conversation_register.py``). That call is presence, not
content: it writes nothing a person reads, which is why the harness may make it
on the model's behalf.

``leave_canvas`` is also the canvas's one call at the end of the turn in the
turn's own context, so it settles whether a thread question's answer may still
be posted into the thread when the model did not reply there
(:func:`aiq_agent.turn.annotation_reply.settle_thread_reply`): that verdict
reads the turn's restricted-use state, which only this context still holds.

Per-turn state in the ``ContextVar`` pattern (``src/aiq_agent/AGENTS.md``): a
mutable record bound before the graph runs, so the tool calls, which run in
copies of the turn's context, write into the one object the harness reads.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from aiq_agent import project_context
from aiq_agent.observability.retrieval_trace import emit_step_span
from aiq_agent.turn.annotation_reply import settle_thread_reply

from ..documents.filing import SignedEnvelope
from .client import LEAVE_TIMEOUT_SECONDS
from .client import CanvasRequestError
from .client import post_canvas

logger = logging.getLogger(__name__)

#: The key the conversation's subject is recorded under: no ``documentId`` was sent.
SUBJECT = ""


@dataclass
class CanvasPresence:
    """The documents (their ids, or :data:`SUBJECT`) this turn's Piloti appeared on."""

    documents: set[str] = field(default_factory=set)


_presence: contextvars.ContextVar[CanvasPresence | None] = contextvars.ContextVar("grid_canvas_presence", default=None)


def begin_canvas_presence() -> CanvasPresence:
    """Bind a fresh record for the turn and return it. Bound on every turn, so one never inherits the last."""
    presence = CanvasPresence()
    _presence.set(presence)
    return presence


def current_canvas_presence() -> CanvasPresence | None:
    return _presence.get()


def note_presence(document_id: str | None) -> None:
    """Piloti appeared on this document (None: the conversation's subject). Nothing outside a turn."""
    presence = _presence.get()
    if presence is not None:
        presence.documents.add(document_id or SUBJECT)


async def show_reading(
    target_body: dict[str, Any],
    document_id: str | None,
    signed: SignedEnvelope,
    page: int,
    region: list[float] | None,
) -> None:
    """Tell the room what Piloti reads, the page or the box on it. Never raises.

    Everyone in the document sees the box Piloti reads, the way people round a
    table follow a finger on the sheet. Presence, not content: it says where
    Piloti looks, never what it found, so no shared-write rule applies. A
    failure costs the glow, never the look; the turn's ``leave`` clears it.
    """
    payload: dict[str, Any] = {"op": "look", "page": page, **target_body}
    if region is not None and len(region) == 4:
        payload.update(zip(("x", "y", "w", "h"), (round(float(value), 4) for value in region), strict=True))
    try:
        await asyncio.to_thread(post_canvas, payload, signed, timeout=LEAVE_TIMEOUT_SECONDS)
        note_presence(document_id)
    except Exception as exc:  # noqa: BLE001 - presence never takes the look down
        logger.info("Showing what Piloti reads failed: %s", exc)


def _envelope() -> SignedEnvelope | None:
    header, signature = project_context.get_request_envelope_from_context()
    return SignedEnvelope(header=header, signature=signature) if header and signature else None


async def leave_canvas(presence: CanvasPresence | None) -> None:
    """Take Piloti's cursor and highlights off every document this turn appeared on. Never raises.

    First settles the thread reply's verdict, on every turn: it costs nothing
    and needs no presence.
    """
    settle_thread_reply()
    if presence is None or not presence.documents:
        return
    envelope = _envelope()
    if envelope is None:
        return
    for document in sorted(presence.documents):
        payload = {"op": "leave", **({"documentId": document} if document else {})}
        try:
            await asyncio.to_thread(post_canvas, payload, envelope, timeout=LEAVE_TIMEOUT_SECONDS)
            emit_step_span("canvas.leave", {"document": document or "subject"}, {"ok": True})
        except CanvasRequestError as exc:
            logger.info("Leaving the canvas of %s failed: %s", document or "the subject", exc)
            outcome = {"refused": exc.status or "unreachable"}
            emit_step_span("canvas.leave", {"document": document or "subject"}, outcome)
        except Exception:  # noqa: BLE001 - presence never takes the turn down
            logger.warning("Leaving the canvas failed", exc_info=True)
    presence.documents.clear()
