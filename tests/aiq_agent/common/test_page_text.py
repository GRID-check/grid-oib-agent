"""Page furniture is found by repetition on most pages, digits read as one."""

from __future__ import annotations

from aiq_agent.common.page_text import furniture_key
from aiq_agent.common.page_text import running_furniture
from aiq_agent.common.page_text import without_furniture


def test_a_page_number_line_is_one_key_on_every_page():
    assert furniture_key("Seite 2 von 14") == furniture_key("seite 13 von 14") == "seite # von #"


def test_an_edge_line_on_most_pages_is_furniture():
    words = ["Abstand", "Brandschutz", "Dachform", "Erschliessung"]
    pages = [["Kopf", word, "Absatz", word.upper(), f"Seite {n} von 4"] for n, word in enumerate(words, 1)]
    assert running_furniture(pages) == {"kopf", "seite # von #"}


def test_a_line_on_too_few_pages_is_not():
    pages = [["Kopf", "a"], ["Kopf", "b"], ["anders", "c"], ["auch anders", "d"], ["nein", "e"]]
    assert running_furniture(pages) == set()


def test_fewer_than_three_pages_have_no_furniture():
    assert running_furniture([["Kopf", "a"], ["Kopf", "b"]]) == set()


def test_furniture_lines_are_left_out():
    assert without_furniture(["Kopf", "Text", "Seite 9 von 9"], {"kopf", "seite # von #"}) == ["Text"]
