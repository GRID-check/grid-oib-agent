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
        # `base` rides along with every subject shelf: a subject narrows which
        # DOCUMENTS a turn reads, and the building-code corpus is the reference
        # frame the answer is measured against, not a document shelf competing
        # with the subject. Without it, binding a plan and asking whether it
        # meets the escape-route requirement retrieved the plan and no OIB.
        ("session", "project", frozenset({"session", "base"})),
        ("project", None, frozenset({"project", "session", "base"})),
        ("archiv", None, frozenset({"archiv", "session", "base"})),
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
    assert get_turn_shelves() == frozenset({"session", "base"})
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
    # The server derives the set from the SHELF; the client's list is not
    # consulted, so naming `archiv` here changes nothing.
    assert get_turn_shelves() == frozenset({"session", "base"})
    set_focus()
    assert get_focused_file_name() is None
    assert get_focused_shelf() is None
    assert get_turn_shelves() is None


def test_a_subject_file_never_costs_the_turn_its_building_code():
    """The one invariant behind the shelf branches, stated once.

    A subject says which DOCUMENTS the turn is about. It is not a statement that
    the reader no longer wants the law applied — and this product exists to
    apply it. Only the explicit ``law`` preset subtracts everything else, because
    there the reader asked for the law alone.
    """
    for shelf in ("session", "project", "archiv"):
        shelves = shelves_for_turn(focus_shelf=shelf)
        assert shelves is not None
        assert "base" in shelves, shelf


def test_a_subject_still_narrows_the_document_shelves():
    """The narrowing #429 and #436 asked for is untouched."""
    # "Summarize this upload" does not walk the project or the Büroarchiv.
    assert shelves_for_turn(focus_shelf="session") == frozenset({"session", "base"})
    # A project question does not mix in Archiv hits.
    assert "archiv" not in shelves_for_turn(focus_shelf="project")
    # And the law-only chip still means the law only.
    assert shelves_for_turn(source_preset="law") == frozenset({"base"})
