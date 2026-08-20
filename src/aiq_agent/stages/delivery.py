"""The frame channel a ``delivery="frame"`` stage pushes its payload down.

``aiq_api`` owns the socket and ``aiq_agent`` owns the graph, so the channel is
**published, not imported** — the same inversion
``conversation_context.register_context_appender`` already uses in the opposite
direction. The front end registers a sink at start-up; this package calls it and
never learns what a WebSocket is.

A send that fails is an outcome (``failed``), never a raise: a stage may not
damage the answer, and the answer has in any case already been delivered by the
time a sink is called.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

#: ``(conversation_id, frame) -> delivered``. Returning ``False`` (no socket for
#: that conversation on any replica) is a normal, expected result.
StageFrameSink = Callable[[str, dict[str, Any]], Awaitable[bool]]

_sink: StageFrameSink | None = None


def register_stage_frame_sink(sink: StageFrameSink | None) -> None:
    """Publish the implementation that puts a stage frame on the wire.

    Called once by the front end at start-up. Passing ``None`` clears it, which
    is what a process with no socket (CLI, job worker) leaves in place: a
    ``frame`` stage there still runs and still records its outcome, it simply
    has nobody to tell.
    """
    global _sink
    _sink = sink


def get_stage_frame_sink() -> StageFrameSink | None:
    """The registered sink, or ``None`` when this process has no socket."""
    return _sink


async def deliver_stage_frame(conversation_id: str | None, frame: dict[str, Any]) -> bool:
    """Hand ``frame`` to the registered sink. Never raises."""
    sink = _sink
    if sink is None or not conversation_id:
        return False
    try:
        return bool(await sink(conversation_id, frame))
    except Exception:
        logger.warning("Stage frame delivery failed for conversation %s", conversation_id, exc_info=True)
        return False
