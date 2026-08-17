"""Turn-level retrieval intent: shelves_for_turn is the one mapping."""

import pytest

from aiq_agent.common.focus_file import get_focused_file_name
from aiq_agent.common.focus_file import get_focused_shelf
from aiq_agent.common.focus_file import get_turn_shelves
from aiq_agent.common.focus_file import set_focus
from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.common.focus_file import shelves_for_turn


@pytest.mark.parametrize(
    ("focus_shelf", "source_preset", "expected"),
    [
        ("session", "project", frozenset({"session"})),
        ("project", None, frozenset({"project", "session"})),
        ("archiv", None, frozenset({"archiv", "session"})),
        (None, "project", frozenset({"project", "session", "base"})),
        (None, "office", frozenset({"archiv", "session", "base"})),
        (None, "law", frozenset({"base"})),
        (None, None, None),
        ("bogus", "nope", None),
    ],
)
def test_shelves_for_turn(focus_shelf, source_preset, expected):
    assert shelves_for_turn(focus_shelf=focus_shelf, source_preset=source_preset) == expected


def test_set_turn_intent_from_file_shelf():
    set_turn_intent(file_name="Protokoll.pdf", shelf="session", source_preset="project")
    assert get_focused_file_name() == "Protokoll.pdf"
    assert get_focused_shelf() == "session"
    assert get_turn_shelves() == frozenset({"session"})
    set_turn_intent()
    assert get_focused_file_name() is None
    assert get_focused_shelf() is None
    assert get_turn_shelves() is None


def test_set_turn_intent_from_preset():
    set_turn_intent(source_preset="law")
    assert get_focused_file_name() is None
    assert get_turn_shelves() == frozenset({"base"})
    set_turn_intent()
    assert get_turn_shelves() is None


def test_set_focus_ignores_client_include_shelves():
    set_focus(file_name="Protokoll.pdf", shelf="session", include_shelves=["archiv", "base"])
    assert get_focused_file_name() == "Protokoll.pdf"
    assert get_focused_shelf() == "session"
    assert get_turn_shelves() == frozenset({"session"})
    set_focus()
    assert get_focused_file_name() is None
    assert get_focused_shelf() is None
    assert get_turn_shelves() is None
