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
from aiq_agent.turn.streaming import fold_turn


def _delta(text: str) -> TextMessageContentBody:
    return TextMessageContentBody(message_id="m1", delta=text)


def _snapshot(text: str) -> StateSnapshotBody:
    return StateSnapshotBody(snapshot=AnswerSnapshot(text=text))


def _terminal(text: str) -> RunFinishedBody:
    return RunFinishedBody(outcome="answered", result=TurnResult(message_id="m1", text=text))


RETRACTED = AnswerRetractedBody(value=EmptyValue())


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
