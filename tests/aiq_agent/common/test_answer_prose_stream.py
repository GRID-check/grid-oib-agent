"""The prose the reader sees while the final call is still writing."""

from __future__ import annotations

import json
import re

import pytest

from aiq_agent.common.answer_prose_stream import AnswerProseStream

PROSE = (
    "In GK 4 darf der Fluchtweg höchstens **40 m** lang sein [1], gemessen bis zum Treppenhaus [2, 3].\n\n"
    "[[card:1]]\n\n"
    "| Bauteil | Klasse |\n|---|---|\n| Wand | REI 60 [1] |\n\n"
    '```mermaid\nflowchart LR\n  A["Raum"] --> B["Treppe"]\n```\n\n'
    "Ein Zitat: „Fluchtwege müssen…“ und ein Emoji 🧯 sowie ein [Link](https://oib.or.at).\n\n"
    "**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.12\n- [2] oib-rl_2_ausgabe_mai_2023.pdf, p.13"
)
ENVELOPE = "```answer_json\n" + json.dumps({"answer": PROSE, "kind": "ruling", "cards": [{"type": "x"}]}) + "\n```"
# What may be shown: no markers, nothing from the sources heading on.
SHOWN = re.sub(r"[^\S\n]*\[\d+(?:\s*,\s*\d+)*\]|\[\[card:\d+\]\]", "", PROSE.split("**Quellen:**", maxsplit=1)[0])


def _stream(text: str, size: int) -> tuple[str, list[str]]:
    reader = AnswerProseStream()
    deltas = [reader.feed(text[i : i + size]) for i in range(0, len(text), size)]
    return "".join(deltas), [d for d in deltas if d]


@pytest.mark.parametrize("size", [1, 2, 3, 5, 8, 17, 64, 10_000])
def test_every_chunking_shows_the_prose_and_nothing_it_must_withhold(size):
    shown, deltas = _stream(ENVELOPE, size)
    assert shown.rstrip() == SHOWN.rstrip()
    for delta in deltas:
        assert "[1]" not in delta and "[[card" not in delta and "Quellen" not in delta


def test_a_bare_json_envelope_streams_too():
    shown, _ = _stream(json.dumps({"answer": "Hallo [1] Welt.", "kind": "ruling"}), 4)
    assert shown == "Hallo Welt."


def test_prose_outside_an_envelope_streams_nothing():
    # A tool round may open with a line of preamble; it is not the answer.
    shown, _ = _stream("Ich suche zuerst in der OIB-RL 2 nach der Fluchtweglänge.", 3)
    assert shown == ""


def test_an_envelope_that_does_not_lead_with_the_answer_streams_nothing():
    late = json.dumps({"kind": "ruling", "cards": [{"type": "table", "rows": ["x" * 500]}], "answer": "Spät."})
    assert _stream(late, 7)[0] == ""


def test_a_bracket_that_is_not_a_marker_is_shown_once_it_cannot_be_one():
    reader = AnswerProseStream()
    # Past the first 30 characters of the line, so only the bracket waits.
    line = "Die Anforderungen stehen im Bericht, siehe"
    assert reader.feed('{"answer": "' + line + " [") == line
    assert reader.feed("Anhang A]") == " [Anhang A]"


def test_a_heading_like_line_that_is_not_the_sources_heading_is_shown():
    shown, _ = _stream(json.dumps({"answer": "**Quellenlage**\nDünn.\n\nQuellen sind knapp.\n"}), 3)
    assert shown == "**Quellenlage**\nDünn.\n\nQuellen sind knapp.\n"


def test_an_escape_split_across_chunks_decodes_once():
    reader = AnswerProseStream()
    parts = ['{"answer": "A', "\\", "u00e4", "\\ud83e", "\\udde8", '\\n", "kind": "x"}']
    assert "".join(reader.feed(p) for p in parts) == "Aä🧨\n"
