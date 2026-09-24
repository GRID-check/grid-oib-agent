"""Whether the terminal frame changed the text the reader had already read (ADR-0066)."""

from __future__ import annotations

import logging

from aiq_agent.agents.piloti.conversation_register import note_settled_replaced
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
