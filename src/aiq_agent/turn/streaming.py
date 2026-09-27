"""A turn's wire bodies folded back into its text (chat wire v2 §b).

Two readers need the text rather than the events. ``nat run``, ``nat eval``
and single-shot HTTP take one value per call: :func:`fold_turn` is the
workflow's ``Streaming(convert=...)``, and returns ``RUN_FINISHED``'s text.
The workflow also logs when ``RUN_FINISHED`` replaced the settled text
(:func:`note_settled_replaced`, counted by the answer suite). The text so far
for a stopped turn is the socket's (``chat_socket.PartialAnswer``).
"""

# No `from __future__ import annotations` here: NAT resolves the converter's
# return annotation (``fold_turn`` -> str) to build the workflow's single
# output type, so it must already be an object, not a string.
import logging

from aiq_agent.common.wire_v2 import EventBody
from aiq_agent.common.wire_v2 import RunFinishedBody

logger = logging.getLogger(__name__)


def note_settled_replaced(settled: str | None, terminal: str) -> bool:
    """Log, and say, whether ``RUN_FINISHED``'s text differs from the settled snapshot.

    The reader has read the settled text by then (ADR-0066), so a difference is
    the answer changing under them: a repair adopted, a quote marked late, a
    card suppressed. Nothing else measures it; the answer suite counts the line.
    """
    if settled is None or terminal.rstrip() == settled.rstrip():
        return False
    logger.info(
        "Piloti: the terminal frame replaced the settled answer (%d -> %d chars)",
        len(settled),
        len(terminal),
    )
    return True


def fold_turn(bodies: list[EventBody]) -> str:
    """The finished turn's text, for a caller that takes one value (``nat run``, ``nat eval``, HTTP)."""
    for body in reversed(bodies):
        if isinstance(body, RunFinishedBody):
            return body.result.text
    raise ValueError("the turn's stream ended without RUN_FINISHED")
