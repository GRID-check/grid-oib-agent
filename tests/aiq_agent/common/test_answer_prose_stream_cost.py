"""The reader's cost grows with the reply, not with the reply squared.

``feed`` runs on the event loop once per token (``on_llm_new_token``), so work
that re-reads everything so far per token stalls every turn the worker serves
once an answer or a card grows long. The bound is a ratio of two timings on
the same machine, never a wall-clock budget: four times the text must cost
about four times as much, where a quadratic reader pays sixteen.
"""

from __future__ import annotations

import json
import time

import pytest

from aiq_agent.common.answer_prose_stream import AnswerProseStream

_CHUNK = 4  # characters per token, about what a provider streams
_GROWTH = 4
#: Linear is ~4, quadratic ~16. Eight leaves room for timer noise either way.
_MAX_RATIO = 8.0


def _cost(reply: str) -> float:
    """The fastest of five full reads of ``reply``, token by token."""
    runs = []
    for _ in range(5):
        reader = AnswerProseStream()
        started = time.perf_counter()
        for i in range(0, len(reply), _CHUNK):
            reader.feed(reply[i : i + _CHUNK])
            reader.take_cards()
        runs.append(time.perf_counter() - started)
    return min(runs)


def _long_prose(lines: int) -> str:
    prose = "Vorab [2, 3].\n" + "Der Fluchtweg ist höchstens 40 m lang [1], gemessen bis zur Treppe.\n" * lines
    return json.dumps({"kind": "direct", "answer": prose, "cards": []})


def _long_card(rows: int) -> str:
    card = {"type": "table", "rows": [["Wand {tragend}", 'REI 60 "geprüft" [1]']] * rows}
    return json.dumps({"kind": "direct", "answer": "Siehe [[card:1]].", "cards": [card]})


@pytest.mark.parametrize(("build", "size"), [(_long_prose, 60), (_long_card, 80)], ids=["prose", "card"])
def test_reading_four_times_the_text_costs_about_four_times_as_much(build, size):
    small, large = build(size), build(size * _GROWTH)
    ratio = _cost(large) / _cost(small)
    assert ratio < _MAX_RATIO, f"{ratio:.1f}x the time for {_GROWTH}x the text"
