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
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import CardBody
from aiq_agent.common.wire_v2 import CardRefusedBody
from aiq_agent.common.wire_v2 import EventBody
from aiq_agent.common.wire_v2 import KeyedCard
from aiq_agent.common.wire_v2 import MastheadBody
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import ShownAnswer
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import WireSource

logger = logging.getLogger(__name__)

# Every class below is ASCII and spelled out: whitespace is `` \t\n\r\f\v``, a
# digit is ``0-9``. Python's ``\s``, ``\d`` and ``str.strip()`` are Unicode-wide and
# JavaScript's differ from them (Python strips U+0085 and U+001C, ``trim`` strips
# U+FEFF; Python's ``\d`` matches a full-width digit), and any difference is a
# reload that shows other bytes than the reader stopped on. ``stopped-answer.ts``
# spells the same classes; ``stopped-cases.jsonl`` holds a case for each.

#: The whitespace the stop rule knows, for ``str.strip``: the ASCII set both languages agree on.
_STOP_WHITESPACE = " \t\n\r\f\v"
#: A citation marker the settle has not resolved yet: the streamed ``[N]``.
_PENDING_MARKER = re.compile(r"[ \t\n\r\f\v]*\[[0-9]+\]")
#: A card's place in the prose. A stopped turn carries no cards, so the place would never fill.
_CARD_MARKER = re.compile(r"[ \t\n\r\f\v]*\[\[card:[0-9]+\]\]")
#: A card's place, with its number, for a stopped turn that keeps the cards the reader saw.
_NUMBERED_CARD_MARKER = re.compile(r"[ \t\n\r\f\v]*\[\[card:([0-9]+)\]\]")
#: A marker the reader's cut left open at the very end (``[1``, ``[[card:``, ``[[card:1]``): half a
#: marker means nothing. The last one holds a ``]``, which the first alternative stops at.
#: ``\Z``, not ``$``: ``$`` also matches before a final newline, so ``[1\n`` read as a half marker
#: here and not in ``stopped-answer.ts``, whose ``$`` is the end of the text.
_OPEN_MARKER_TAIL = re.compile(r"[ \t\n\r\f\v]*(?:\[\[?[^\[\] \t\n\r\f\v]*|\[\[card:[0-9]+\])\Z")


@dataclass
class _Stretch:
    """The answer between two replacements: deltas append to it, a snapshot or a retraction ends it.

    Kept after it ends, because the reader may have been reading it when they
    pressed Stop: the frames that replaced it were still on their way to them.
    """

    text: str = ""
    #: The snapshot's text this stretch began with, whose ``[N]`` resolve to ``sources``; None for streamed prose.
    settled: str | None = None
    sources: list[WireSource] = field(default_factory=list)
    #: ``(seq, answer_meta)`` in order: the masthead as it stood at any seq of this stretch (None: none shown).
    mastheads: list[tuple[int, dict[str, Any] | None]] = field(default_factory=list)
    #: By index: ``(seq it arrived at, the card or None when refused)``. A snapshot keeps them; a retraction does not.
    cards: dict[int, tuple[int, KeyedCard | None]] = field(default_factory=dict)
    #: The seq of the body that replaced it; None while it is the answer.
    ended_at: int | None = None


@dataclass(frozen=True)
class StoppedAnswer:
    """What a stopped turn keeps: the answer as the reader had it, and nothing it would have to explain."""

    text: str
    sources: list[WireSource] = field(default_factory=list)
    answer_meta: dict[str, Any] | None = None
    cards: list[KeyedCard] = field(default_factory=list)


class TurnTextFold:
    """The answer so far: deltas append, a snapshot replaces, a retraction clears.

    Folded in ``seq`` order, as the client folds the same events, so a
    position the client names (``ShownAnswer``: a seq and a length) means the
    same text here. ``settled`` is the last snapshot's text, the one the reader
    was left reading, or ``None`` once a retraction took it back.
    """

    def __init__(self) -> None:
        self._stretches: list[_Stretch] = [_Stretch()]
        self._seq = 0

    @property
    def text(self) -> str:
        return self._stretches[-1].text

    @property
    def settled(self) -> str | None:
        return self._stretches[-1].settled

    def add(self, body: EventBody, seq: int | None = None) -> None:
        """Fold ``body``, stamped ``seq`` (the next one when the caller stamps none)."""
        self._seq = self._seq + 1 if seq is None else seq
        current = self._stretches[-1]
        if isinstance(body, TextMessageContentBody):
            current.text += body.delta
        elif isinstance(body, StateSnapshotBody):
            snapshot = body.snapshot
            mastheads = [(self._seq, snapshot.answer_meta)]
            self._replace(
                _Stretch(snapshot.text, snapshot.text, list(snapshot.sources), mastheads, dict(current.cards))
            )
        elif isinstance(body, AnswerRetractedBody):
            self._replace(_Stretch(mastheads=[(self._seq, None)]))
        elif isinstance(body, MastheadBody):
            current.mastheads.append((self._seq, body.value.answer_meta))
        elif isinstance(body, CardBody):
            current.cards[body.value.index] = (self._seq, KeyedCard(key=body.value.key, card=body.value.card))
        elif isinstance(body, CardRefusedBody):
            current.cards[body.value.index] = (self._seq, None)
        elif isinstance(body, RunFinishedBody):
            current.text = body.result.text

    def _replace(self, stretch: _Stretch) -> None:
        self._stretches[-1].ended_at = self._seq
        self._stretches.append(stretch)

    def _stretch_at(self, seq: int) -> _Stretch:
        """The stretch a reader who had folded through ``seq`` was reading."""
        return next(s for s in self._stretches if s.ended_at is None or s.ended_at > seq)

    def partial(self) -> str:
        """What a stopped turn keeps when nobody said what was on screen: see :meth:`stopped`."""
        return self.stopped().text

    def stopped(self, shown: ShownAnswer | None = None) -> StoppedAnswer:
        """What a stopped turn keeps.

        With ``shown`` (the asker's Stop said what was on screen), the text is
        the first ``shown.chars`` characters of the stretch the asker was
        reading at ``shown.seq``, and the masthead and cards are those that had
        reached them by then, a card only where its ``[[card:N]]`` is in that
        text: what came after the press is dropped, as the client's fold drops
        it (``turn-fold.ts``, ``stoppedHere``). Without it, everything folded
        so far, and no cards: nothing says which the reader saw.

        Either way, a settled text keeps its ``[N]`` and its sources, and a
        streamed one drops its pending ``[N]``, whose sources never arrived.

        ``frontends/ui/src/features/chat/lib/stopped-answer.ts`` is the
        TypeScript copy of the rule, for the client's and the BFF's writes of
        the same row; ``shared/wire/v2/stopped-cases.jsonl`` holds both to it.
        """
        if shown is None:
            stretch, text = self._stretches[-1], self.text
        else:
            stretch = self._stretch_at(shown.seq)
            text = stretch.text[: shown.chars]
            if len(text) < len(stretch.text):
                text = _OPEN_MARKER_TAIL.sub("", text)
        resolved = stretch.settled is not None and stretch.settled.startswith(text)
        if not resolved:
            text = _PENDING_MARKER.sub("", text)
        sources = list(stretch.sources) if resolved and text.strip(_STOP_WHITESPACE) else []
        if shown is None:
            return StoppedAnswer(text=_CARD_MARKER.sub("", text).strip(_STOP_WHITESPACE), sources=sources)
        cards = _placed_cards(stretch, text, shown.seq)
        text = _NUMBERED_CARD_MARKER.sub(lambda m: m.group(0) if int(m.group(1)) <= len(cards) else "", text)
        mastheads = [meta for at, meta in stretch.mastheads if at <= shown.seq]
        return StoppedAnswer(
            text=text.strip(_STOP_WHITESPACE),
            sources=sources,
            answer_meta=mastheads[-1] if mastheads else None,
            cards=cards,
        )


def _placed_cards(stretch: _Stretch, text: str, seq: int) -> list[KeyedCard]:
    """The leading run of cards that had arrived by ``seq`` and whose place is in ``text``.

    A run, because ``[[card:N]]`` is the N-th card of the list: a gap (a card
    refused, not arrived or not placed) ends what can be kept.
    """
    placed = {int(number) for number in _NUMBERED_CARD_MARKER.findall(text)}
    cards: list[KeyedCard] = []
    for index in range(len(stretch.cards)):
        arrived_at, card = stretch.cards.get(index, (seq + 1, None))
        if card is None or arrived_at > seq or index + 1 not in placed:
            break
        cards.append(card)
    return cards


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
