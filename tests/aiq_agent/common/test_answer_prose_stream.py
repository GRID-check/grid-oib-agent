"""The prose the reader sees while the final call is still writing."""

from __future__ import annotations

import json
import re

import pytest

from aiq_agent.common.answer_prose_stream import AnswerProseStream
from aiq_agent.common.citation_verification import expand_grouped_citations

PROSE = (
    "In GK 4 darf der Fluchtweg höchstens **40 m** lang sein [1], gemessen bis zum Treppenhaus [2, 3].\n\n"
    "[[card:1]]\n\n"
    "| Bauteil | Klasse |\n|---|---|\n| Wand | REI 60 [1] |\n\n"
    '```mermaid\nflowchart LR\n  A["Raum"] --> B["Treppe"]\n```\n\n'
    "Ein Zitat: „Fluchtwege müssen…“ und ein Emoji 🧯 sowie ein [Link](https://oib.or.at).\n\n"
    "**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12\n- [2] oib-rl_2_ausgabe_mai_2023.pdf, p.13"
)
ENVELOPE = "```answer_json\n" + json.dumps({"answer": PROSE, "kind": "ruling", "cards": [{"type": "x"}]}) + "\n```"
# What may be shown: the prose with its citation and card markers, nothing
# from the sources heading on; the sources are collected instead.
SHOWN = expand_grouped_citations(PROSE.split("**Quellen:**", maxsplit=1)[0])
SOURCES = "**Quellen:**" + PROSE.split("**Quellen:**", maxsplit=1)[1]


def _stream(text: str, size: int) -> tuple[str, list[str]]:
    reader = _reader(text, size)
    return reader.emitted, [d for d in reader.deltas if d]


def _reader(text: str, size: int) -> AnswerProseStream:
    reader = AnswerProseStream()
    reader.deltas = [reader.feed(text[i : i + size]) for i in range(0, len(text), size)]
    return reader


@pytest.mark.parametrize("size", [1, 2, 3, 5, 8, 17, 64, 10_000])
def test_every_chunking_shows_the_prose_and_nothing_it_must_withhold(size):
    reader = _reader(ENVELOPE, size)
    assert reader.emitted == SHOWN
    assert reader.sources_text.strip() == SOURCES.strip()
    assert reader.closed
    for delta in reader.deltas:
        assert "Quellen:" not in delta
        # A marker is shown whole or not at all: a card marker too, since the
        # reader holds its card's place from the moment it is written.
        assert not re.search(r"\[\d+(?:,\s*\d*)?$", delta)
        assert not re.search(r"\[\[(?:c(?:a(?:r(?:d(?::\d*\]?)?)?)?)?)?$", delta)
        assert delta.count("[[card:") == len(re.findall(r"\[\[card:\d+\]\]", delta))


def test_a_bare_json_envelope_streams_too():
    shown, _ = _stream(json.dumps({"answer": "Hallo [1] Welt.", "kind": "ruling"}), 4)
    assert shown == "Hallo [1] Welt."


def test_prose_outside_an_envelope_streams_nothing():
    # A tool round may open with a line of preamble; it is not the answer.
    shown, _ = _stream("Ich suche zuerst in der OIB-RL 2 nach der Fluchtweglänge.", 3)
    assert shown == ""


def test_an_envelope_that_puts_more_than_the_masthead_before_the_answer_streams_nothing():
    late = json.dumps({"kind": "ruling", "cards": [{"type": "table", "rows": ["x" * 2000]}], "answer": "Spät."})
    assert _stream(late, 7)[0] == ""


def test_a_bracket_that_is_not_a_marker_is_shown_once_it_cannot_be_one():
    reader = AnswerProseStream()
    # Past the first 30 characters of the line, so only the bracket waits.
    line = "Die Anforderungen stehen im Bericht, siehe"
    assert reader.feed('{"answer": "' + line + " [") == line + " "
    assert reader.feed("Anhang A]") == "[Anhang A]"


def test_a_heading_like_line_that_is_not_the_sources_heading_is_shown():
    shown, _ = _stream(json.dumps({"answer": "**Quellenlage**\nDünn.\n\nQuellen sind knapp.\n"}), 3)
    assert shown == "**Quellenlage**\nDünn.\n\nQuellen sind knapp.\n"


@pytest.mark.parametrize("size", [1, 5, 10_000])
def test_an_answer_key_padded_with_whitespace_is_found_at_any_chunking(size):
    reply = '{"kind": "direct",\n    "answer"   \n' + " " * 30 + ':    "Hallo Welt."}'
    shown, _ = _stream(reply, size)
    assert shown == "Hallo Welt."


def test_an_escape_split_across_chunks_decodes_once():
    reader = AnswerProseStream()
    parts = ['{"answer": "A', "\\", "u00e4", "\\ud83e", "\\udde8", '\\n", "kind": "x"}']
    assert "".join(reader.feed(p) for p in parts) == "Aä🧨\n"


def test_the_masthead_before_the_answer_is_read_as_soon_as_the_answer_begins():
    reply = "```answer_json\n" + json.dumps(
        {
            "kind": "ruling",
            "topic": "Zweiter Fluchtweg",
            "verdict": {"value": "REI 60", "subject": "Wände"},
            "answer": "Text.",
        }
    )
    reader = AnswerProseStream()
    before, after = reply[: reply.index('"answer"')], reply[reply.index('"answer"') :]
    for i in range(0, len(before), 5):
        reader.feed(before[i : i + 5])
    assert reader.masthead is None  # not before the answer key
    for i in range(0, len(after), 5):
        reader.feed(after[i : i + 5])
    assert reader.masthead == {
        "kind": "ruling",
        "topic": "Zweiter Fluchtweg",
        "verdict": {"value": "REI 60", "subject": "Wände"},
    }


@pytest.mark.parametrize("size", [1, 3, 17])
def test_each_card_is_read_as_soon_as_its_object_closes(size):
    cards = [{"type": "table", "rows": [["a", "b {x}"]]}, {"type": "surface", "text": '"quoted" } und [1]'}]
    reply = "```answer_json\n" + json.dumps({"kind": "walkthrough", "answer": "Text.", "cards": cards}) + "\n```"
    reader = AnswerProseStream()
    seen: list[tuple[int, str]] = []
    for i in range(0, len(reply), size):
        reader.feed(reply[i : i + size])
        seen.extend((i, card["type"]) for card in reader.take_cards())
    assert [kind for _, kind in seen] == ["table", "surface"]
    # The first card went out before the second was written.
    assert seen[0][0] < reply.index('"surface"')


@pytest.mark.parametrize("size", [1, 2, 3, 7, 10_000])
@pytest.mark.parametrize(
    ("raw_answer", "shown"),
    [
        # Not JSON mode: a path the model forgot to escape.
        ("Pfad C:\\user\\daten und weiter.", "Pfad C:\\user\\daten und weiter."),
        # A lone high surrogate, then text.
        ("Fluchtweg \\ud83d frei.", "Fluchtweg \\ud83d frei."),
        # A high surrogate whose next escape is not its partner: the ä survives.
        ("A\\ud83d\\u00e4B", "A\\ud83däB"),
        ("A\\ude00B", "A\\ude00B"),
        ("Rest \\u", "Rest \\u"),
        ("Emoji \\ud83e\\uddef ok", "Emoji 🧯 ok"),
    ],
)
def test_an_escape_that_is_not_json_is_shown_as_written_and_the_prose_closes(raw_answer, shown, size):
    envelope = '{"kind":"direct","answer":"' + raw_answer + '","cards":[{"type":"x"}]}'
    reader = _reader(envelope, size)
    assert reader.closed
    assert reader.emitted == shown
    assert reader.take_cards() == [{"type": "x"}]
