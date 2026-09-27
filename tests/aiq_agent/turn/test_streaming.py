"""A turn's wire bodies folded back into its text: NAT's single-output fold and the Stop partial."""

from __future__ import annotations

import pytest

from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import AnswerSnapshot
from aiq_agent.common.wire_v2 import EmptyValue
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import TextMessageStartBody
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.turn.streaming import TurnTextFold
from aiq_agent.turn.streaming import fold_turn


def _delta(text: str) -> TextMessageContentBody:
    return TextMessageContentBody(message_id="m1", delta=text)


def _snapshot(text: str) -> StateSnapshotBody:
    return StateSnapshotBody(snapshot=AnswerSnapshot(text=text))


def _terminal(text: str) -> RunFinishedBody:
    return RunFinishedBody(outcome="answered", result=TurnResult(message_id="m1", text=text))


RETRACTED = AnswerRetractedBody(value=EmptyValue())


def _fold(*bodies) -> TurnTextFold:
    fold = TurnTextFold()
    for body in bodies:
        fold.add(body)
    return fold


class TestFoldTurn:
    def test_the_terminal_text_is_the_answer_not_the_deltas_before_it(self):
        bodies = [TextMessageStartBody(message_id="m1"), _delta("Vorläufig "), _terminal("Die Antwort [1].")]
        assert fold_turn(bodies) == "Die Antwort [1]."

    def test_an_empty_terminal_stays_empty(self):
        assert fold_turn([_delta("Vorläufig"), _terminal("")]) == ""

    def test_a_stream_without_its_terminal_is_an_error_not_a_guess(self):
        with pytest.raises(ValueError, match="RUN_FINISHED"):
            fold_turn([_delta("Vorläufig")])

    def test_the_return_annotation_is_an_object_nat_can_resolve(self):
        """NAT builds the workflow's single output type from it; a string annotation breaks `nat run`."""
        assert fold_turn.__annotations__["return"] is str


class TestTurnTextFold:
    def test_deltas_append(self):
        assert _fold(_delta("Ein "), _delta("Satz")).text == "Ein Satz"

    def test_a_snapshot_replaces_and_is_what_the_reader_was_left_reading(self):
        fold = _fold(_delta("Ein Satz [3]"), _snapshot("Ein Satz [1]."))
        assert fold.text == fold.settled == "Ein Satz [1]."

    def test_a_retraction_clears_the_text_and_the_settled_answer(self):
        fold = _fold(_delta("Runde"), _snapshot("Runde [1]."), RETRACTED)
        assert fold.text == "" and fold.settled is None

    def test_the_terminal_replaces(self):
        assert _fold(_delta("Ein"), _terminal("Die Antwort.")).text == "Die Antwort."

    def test_a_stopped_turn_keeps_its_settled_text_whole(self):
        assert _fold(_delta("Ein Satz [3]"), _snapshot("Ein Satz [1].")).partial() == "Ein Satz [1]."

    def test_a_stopped_turn_before_the_settle_drops_its_pending_markers(self):
        assert _fold(_delta("Die Brüstung ist 100 cm [2] hoch"), _delta(" [3].")).partial() == (
            "Die Brüstung ist 100 cm hoch."
        )
