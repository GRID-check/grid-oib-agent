"""A marker naming several sources is expanded before anything reads it."""

from __future__ import annotations

import json

import pytest

from aiq_agent.common.answer_prose_stream import AnswerProseStream
from aiq_agent.common.citation_verification import expand_grouped_citations


@pytest.mark.parametrize(
    ("text", "expanded"),
    [
        ("Teile [2–5].", "Teile [2][3][4][5]."),
        ("a [2, 3] b", "a [2][3] b"),
        ("[1-3, 7]", "[1][2][3][7]"),
        ("[3]", "[3]"),
        # Not citations, or not ranges a reader could mean: left as written.
        ("Jahr [1990–2020]", "Jahr [1990–2020]"),
        ("[5–2]", "[5–2]"),
        ("[1-40]", "[1-40]"),
        ("Liste [a, b]", "Liste [a, b]"),
    ],
)
def test_a_group_becomes_one_marker_per_source(text, expanded):
    assert expand_grouped_citations(text) == expanded


def test_the_stream_shows_a_range_as_its_single_markers():
    # Seen live (OIB-2 overview): "[2–5]" stayed literal text beside its
    # neighbours' pills, and none of its four sources was ever verified.
    reply = json.dumps({"answer": "Die Ausgabe gliedert sich in vier Teile [2–5]."})
    reader = AnswerProseStream()
    for i in range(0, len(reply), 3):
        reader.feed(reply[i : i + 3])
    assert reader.emitted == "Die Ausgabe gliedert sich in vier Teile [2][3][4][5]."
