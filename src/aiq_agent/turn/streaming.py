"""A turn's wire bodies folded back into its text (chat wire v2 §b).

Two readers need the text rather than the events. ``nat run``, ``nat eval``
and single-shot HTTP take one value per call: :func:`fold_turn` is the
workflow's ``Streaming(convert=...)``, and returns ``RUN_FINISHED``'s text.
The chat socket needs the text so far when the asker presses Stop:
:class:`TurnTextFold` holds it, folded as the client folds the same events.
The workflow folds its own bodies too, to log when ``RUN_FINISHED`` replaced
the settled text (:func:`note_settled_replaced`, counted by the answer suite).
"""

# No `from __future__ import annotations` here: NAT resolves the converter's
# return annotation (``fold_turn`` -> str) to build the workflow's single
# output type, so it must already be an object, not a string.
import logging
import re

from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import EventBody
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import TextMessageContentBody

logger = logging.getLogger(__name__)

#: A citation marker the settle has not resolved yet: the streamed ``[N]``.
_PENDING_MARKER = re.compile(r"\s*\[\d+\]")


class TurnTextFold:
    """The answer's text so far: deltas append, a snapshot replaces, a retraction clears.

    ``settled`` is the last snapshot's text, the one the reader was left
    reading, or ``None`` once a retraction took it back.
    """

    def __init__(self) -> None:
        self.text = ""
        self.settled: str | None = None

    def add(self, body: EventBody) -> None:
        if isinstance(body, TextMessageContentBody):
            self.text += body.delta
        elif isinstance(body, StateSnapshotBody):
            self.text = self.settled = body.snapshot.text
        elif isinstance(body, AnswerRetractedBody):
            self.text, self.settled = "", None
        elif isinstance(body, RunFinishedBody):
            self.text = body.result.text

    def partial(self) -> str:
        """What a stopped turn keeps: the settled text, or the streamed prose with its pending ``[N]`` removed."""
        if self.settled is not None and self.text == self.settled:
            return self.text
        return _PENDING_MARKER.sub("", self.text)


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
