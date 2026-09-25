"""Whether the terminal frame changed the text the reader had already read (ADR-0066)."""

from __future__ import annotations

import asyncio
import logging

from aiq_agent.agents.piloti.conversation_register import _relay_live
from aiq_agent.agents.piloti.conversation_register import note_settled_replaced
from aiq_agent.turn.answer_stream import AnswerStreamSink
from aiq_agent.turn.answer_stream import Snapshot
from aiq_agent.turn.streaming import live_chunk


def test_a_terminal_that_repeats_the_settled_text_is_not_a_change(caplog):
    with caplog.at_level(logging.INFO):
        assert note_settled_replaced("R 90 [1].\n", [live_chunk("R 90 [1].")]) is False
    assert "replaced the settled answer" not in caplog.text


def test_a_terminal_that_differs_is_logged_for_the_suite_to_count(caplog):
    with caplog.at_level(logging.INFO):
        assert note_settled_replaced("R 90 [1].", [live_chunk("R 90 [1] [nicht wörtlich].")]) is True
    assert "terminal frame replaced the settled answer" in caplog.text


def test_nothing_settled_is_nothing_replaced():
    assert note_settled_replaced(None, [live_chunk("Antwort.")]) is False


async def _relayed(sink, answer) -> list:
    task = asyncio.create_task(answer())
    return [chunk async for chunk in _relay_live(sink, task)]


async def test_a_retraction_is_not_a_settled_answer_the_terminal_replaced(caplog):
    # A tool round settled its prose, then took it back; the answer streamed later
    # never settled. The terminal replaced nothing the reader was left reading.
    sink = AnswerStreamSink()

    async def answer():
        sink.put(Snapshot(content="Vorläufig [1].", sources=[]))
        sink.retract()
        return [live_chunk("Die eigentliche Antwort [1].")]

    with caplog.at_level(logging.INFO):
        await _relayed(sink, answer)
    assert "replaced the settled answer" not in caplog.text


async def test_an_abandoned_stream_leaves_the_answer_unwound_before_it_returns():
    sink = AnswerStreamSink()
    unwound = asyncio.Event()

    async def answer():
        sink.push("Erstes Wort ")
        try:
            await asyncio.sleep(3600)
        finally:
            unwound.set()

    task = asyncio.create_task(answer())
    relay = _relay_live(sink, task)
    await anext(relay)
    await relay.aclose()  # the consumer walked away
    assert task.cancelled()
    assert unwound.is_set()
