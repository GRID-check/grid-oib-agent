"""The reader's cost grows with the reply, not with the reply squared.

``feed`` runs on the event loop once per token (``on_llm_new_token``), so work
that re-reads everything so far per token stalls every turn the worker serves
once an answer or a card grows long. Both bounds are ratios at four times the
text, where a linear reader pays about four and a quadratic one sixteen:

- the memory each ``feed`` allocates, counted exactly by ``tracemalloc``. It
  catches the copy: ``buffer += token`` on an attribute copies the whole
  buffer per token (CPython extends a string in place only for a local), and
  the copy is cheap enough per token that a timing ratio at these sizes sees
  it only as 4.4x where linear is 4, enough to trip CI now and then (8.1x on
  a runner) but never to fail locally.
- the time, as a ratio of two timings on the same machine, never a wall-clock
  budget. It catches a rescan that allocates nothing: a regex or ``find``
  over everything so far. The time is this thread's CPU time, not the wall
  clock: on a shared runner the wall clock also counts the stretches the
  thread waited for a core, which landed on the large reads more often than
  the small ones and gave 8.3x for a reader that measures 4.0.
"""

from __future__ import annotations

import json
import time
import tracemalloc

import pytest

from aiq_agent.common.answer_prose_stream import AnswerProseStream

_CHUNK = 4  # characters per token, about what a provider streams
_GROWTH = 4
#: Linear is ~4, quadratic ~16. Eight leaves room for timer noise either way.
_MAX_RATIO = 8.0
#: Allocation is counted, not timed, so needs no room for noise: linear
#: measures 3.5 to 3.9, the per-token copy 9.9 to 15.2.
_MAX_ALLOCATION_RATIO = 6.0


def _read(reply: str) -> float:
    """The CPU time one full read of ``reply`` takes, token by token."""
    reader = AnswerProseStream()
    started = time.thread_time()
    for i in range(0, len(reply), _CHUNK):
        reader.feed(reply[i : i + _CHUNK])
        reader.take_cards()
    return time.thread_time() - started


def _cost_ratio(small: str, large: str) -> float:
    """How much longer ``large`` takes than ``small``, each the fastest of seven reads, taken in turn."""
    smalls, larges = [], []
    for _ in range(7):
        smalls.append(_read(small))
        larges.append(_read(large))
    return min(larges) / min(smalls)


def _allocated(reply: str) -> int:
    """The bytes allocated while ``reply`` is read token by token: each feed's peak over what it started with."""
    started = not tracemalloc.is_tracing()
    if started:
        tracemalloc.start()
    reader, total = AnswerProseStream(), 0
    try:
        for i in range(0, len(reply), _CHUNK):
            before = tracemalloc.get_traced_memory()[0]
            tracemalloc.reset_peak()
            reader.feed(reply[i : i + _CHUNK])
            reader.take_cards()
            total += tracemalloc.get_traced_memory()[1] - before
    finally:
        if started:
            tracemalloc.stop()
    return total


def _long_prose(lines: int) -> str:
    prose = "Vorab [2, 3].\n" + "Der Fluchtweg ist höchstens 40 m lang [1], gemessen bis zur Treppe.\n" * lines
    return json.dumps({"kind": "direct", "answer": prose, "cards": []})


def _long_card(rows: int) -> str:
    card = {"type": "table", "rows": [["Wand {tragend}", 'REI 60 "geprüft" [1]']] * rows}
    return json.dumps({"kind": "direct", "answer": "Siehe [[card:1]].", "cards": [card]})


def _open_code_line(words: int) -> str:
    # One backtick opens a code span that closes only at the end of the line,
    # so the whole line is held while it is written.
    prose = "Vorab `" + "x = grid[1, 2] und so weiter " * words + "`\nEnde."
    return json.dumps({"kind": "direct", "answer": prose, "cards": []})


@pytest.mark.parametrize(
    ("build", "size"),
    [(_long_prose, 60), (_long_card, 80), (_open_code_line, 200)],
    ids=["prose", "card", "open-code-line"],
)
def test_reading_four_times_the_text_costs_about_four_times_as_much(build, size):
    ratio = _cost_ratio(build(size), build(size * _GROWTH))
    assert ratio < _MAX_RATIO, f"{ratio:.1f}x the time for {_GROWTH}x the text"


@pytest.mark.parametrize(
    ("build", "size"),
    [(_long_prose, 60), (_long_card, 80), (_open_code_line, 200)],
    ids=["prose", "card", "open-code-line"],
)
def test_reading_four_times_the_text_allocates_about_four_times_as_much(build, size):
    ratio = _allocated(build(size * _GROWTH)) / _allocated(build(size))
    assert ratio < _MAX_ALLOCATION_RATIO, f"{ratio:.1f}x the memory allocated for {_GROWTH}x the text"
