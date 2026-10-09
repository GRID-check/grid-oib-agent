"""A turn's wire bodies folded back into its text: NAT's single-output fold and the Stop partial."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aiq_agent.common.wire_v2 import WIRE_EVENT
from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import AnswerSnapshot
from aiq_agent.common.wire_v2 import CardBody
from aiq_agent.common.wire_v2 import CardValue
from aiq_agent.common.wire_v2 import EmptyValue
from aiq_agent.common.wire_v2 import MastheadBody
from aiq_agent.common.wire_v2 import MastheadValue
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import ShownAnswer
from aiq_agent.common.wire_v2 import StateSnapshotBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import TextMessageStartBody
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.common.wire_v2 import WireSource
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


def test_a_stopped_turn_keeps_no_card_place():
    """A cancelled turn carries no cards, so neither the settled nor the streamed text keeps a ``[[card:N]]``."""
    settled = TurnTextFold()
    settled.add(StateSnapshotBody(snapshot=AnswerSnapshot(text="Vorher.\n\n[[card:1]]\n\nNachher [1].")))
    assert settled.partial() == "Vorher.\n\nNachher [1]."
    streamed = TurnTextFold()
    streamed.add(TextMessageContentBody(message_id="m", delta="Vorher [2].\n\n[[card:1]]"))
    assert streamed.partial() == "Vorher."


def _card(index: int) -> CardBody:
    return CardBody(value=CardValue(index=index, key=f"k{index}", card={"type": "fact", "n": index}))


def _stamped(*bodies) -> TurnTextFold:
    """Folded with the seqs a wire would stamp them, from 1."""
    fold = TurnTextFold()
    for seq, body in enumerate(bodies, start=1):
        fold.add(body, seq)
    return fold


class TestStoppedWhereTheReaderWas:
    """``cancel_turn.shown``: the stopped answer is the text the asker had on screen, not what had arrived."""

    def test_the_text_is_cut_to_what_was_shown(self):
        fold = _stamped(_delta("Erster Satz. "), _delta("Zweiter Satz, das der Leser nie sah."))

        assert fold.stopped(ShownAnswer(seq=2, chars=len("Erster Satz."))).text == "Erster Satz."

    def test_text_that_arrived_after_the_press_is_not_kept(self):
        fold = _stamped(_delta("Gesehen."), _delta(" Unterwegs."))

        assert fold.stopped(ShownAnswer(seq=1, chars=8)).text == "Gesehen."

    def test_a_cut_streamed_text_drops_its_pending_markers(self):
        fold = _stamped(_delta("Nach § 87 [2] gilt. Danach [3] mehr."))

        assert fold.stopped(ShownAnswer(seq=1, chars=len("Nach § 87 [2] gilt."))).text == "Nach § 87 gilt."

    def test_a_marker_cut_in_half_is_dropped(self):
        assert _stamped(_delta("Die Breite [1")).stopped(ShownAnswer(seq=1, chars=12)).text == "Die Breite"
        assert _stamped(_delta("Vorher.\n\n[[card:")).stopped(ShownAnswer(seq=1, chars=15)).text == "Vorher."

    def test_the_reader_was_still_on_the_streamed_text_when_the_settle_replaced_it(self):
        """The snapshot was in flight at the press: the cut is of the text they were reading."""
        snapshot = AnswerSnapshot(text="Ganz neu formuliert [1].", sources=[WireSource(content="c", number=1)])
        fold = _stamped(_delta("Alt gestreamt [4] und weiter."), StateSnapshotBody(snapshot=snapshot))

        kept = fold.stopped(ShownAnswer(seq=1, chars=len("Alt gestreamt [4]")))

        assert (kept.text, kept.sources) == ("Alt gestreamt", [])

    def test_a_cut_of_the_settled_text_keeps_its_markers_and_sources(self):
        sources = [WireSource(content="c", number=1)]
        settled = StateSnapshotBody(snapshot=AnswerSnapshot(text="Belegt [1]. Noch ein Satz.", sources=sources))
        fold = _stamped(_delta("roh"), settled)

        kept = fold.stopped(ShownAnswer(seq=2, chars=len("Belegt [1].")))

        assert (kept.text, [s.number for s in kept.sources]) == ("Belegt [1].", [1])

    def test_characters_are_code_points_as_the_client_counts_them(self):
        fold = _stamped(_delta("Stiege 🏢 frei. Rest"))

        assert fold.stopped(ShownAnswer(seq=1, chars=len("Stiege 🏢 frei."))).text == "Stiege 🏢 frei."

    def test_nothing_shown_keeps_nothing(self):
        kept = _stamped(_delta("Schon da")).stopped(ShownAnswer(seq=1, chars=0))

        assert (kept.text, kept.sources, kept.cards) == ("", [], [])

    def test_the_cards_kept_are_those_that_arrived_and_whose_place_was_shown(self):
        fold = _stamped(
            _card(0),
            _delta("Vorher.\n\n[[card:1]]\n\nDazwischen.\n\n[[card:2]]"),
            _card(1),  # arrived after the press
        )

        kept = fold.stopped(ShownAnswer(seq=2, chars=len("Vorher.\n\n[[card:1]]\n\nDazwischen.\n\n[[card:2]]")))

        assert [card.key for card in kept.cards] == ["k0"]
        assert kept.text == "Vorher.\n\n[[card:1]]\n\nDazwischen."

    def test_a_card_whose_place_was_not_shown_is_not_kept(self):
        fold = _stamped(_card(0), _delta("Vorher.\n\n[[card:1]]"))

        kept = fold.stopped(ShownAnswer(seq=2, chars=len("Vorher.")))

        assert (kept.text, kept.cards) == ("Vorher.", [])

    def test_the_masthead_is_the_one_on_screen_at_the_press(self):
        meta = {"lede": "Kurz"}
        fold = _stamped(MastheadBody(value=MastheadValue(answer_meta=meta)), _delta("Text."))

        assert fold.stopped(ShownAnswer(seq=2, chars=5)).answer_meta == meta
        assert (
            _stamped(_delta("Text."), MastheadBody(value=MastheadValue(answer_meta=meta)))
            .stopped(ShownAnswer(seq=1, chars=5))
            .answer_meta
            is None
        )

    def test_a_retraction_takes_the_masthead_and_cards_back(self):
        meta = {"lede": "Kurz"}
        fold = _stamped(MastheadBody(value=MastheadValue(answer_meta=meta)), _card(0), _delta("Runde"), RETRACTED)

        kept = fold.stopped(ShownAnswer(seq=4, chars=0))

        assert (kept.answer_meta, kept.cards) == (None, [])

    def test_without_a_shown_position_the_settled_text_keeps_its_sources_past_a_card_place(self):
        """The card place is dropped, and that no longer reads as a text that differs from the settle."""
        sources = [WireSource(content="c", number=1)]
        text = "Vorher.\n\n[[card:1]]\n\nNachher [1]."
        kept = _stamped(StateSnapshotBody(snapshot=AnswerSnapshot(text=text, sources=sources))).stopped()

        assert (kept.text, [s.number for s in kept.sources], kept.cards) == ("Vorher.\n\nNachher [1].", [1], [])


STOPPED_CASES = Path(__file__).resolve().parents[3] / "shared" / "wire" / "v2" / "stopped-cases.jsonl"


def _stopped_cases() -> list[dict]:
    return [json.loads(line) for line in STOPPED_CASES.read_text(encoding="utf-8").splitlines() if line.strip()]


@pytest.mark.parametrize("case", _stopped_cases(), ids=lambda case: case["case"])
def test_the_stop_rule_the_client_and_the_bff_apply_too(case):
    """``stopped-cases.jsonl`` is read by ``stopped-answer.spec.ts`` as well: the two copies of the rule cannot drift.

    The server folds every frame it stamped, including those after the press;
    the cut is of what the reader had at ``shown.seq``.
    """
    fold = TurnTextFold()
    for seq, body in enumerate(case["events"], start=1):
        envelope = {"v": 2, "conversation_id": "c", "turn_id": "t", "seq": seq, "ts": 0}
        event = WIRE_EVENT.validate_python({**envelope, **body})
        fold.add(event, seq)

    kept = fold.stopped(ShownAnswer.model_validate(case["shown"]))

    expected = case["kept"]
    assert kept.text == expected["text"]
    assert [source.number for source in kept.sources] == expected["sources"]
    assert kept.answer_meta == expected["answer_meta"]
    assert [card.key for card in kept.cards] == expected["cards"]
