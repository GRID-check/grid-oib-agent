"""A standfirst earns its place by saying what the opening does not.

Pinned on the three answers the September 2026 live census produced: every
summary restated the prose's first paragraph, directly above it. The prompt's
own consequence-summary („Danach ausschreiben …") must survive.
"""

from __future__ import annotations

import pytest

from aiq_agent.common.answer_envelope import AnswerMeta
from aiq_agent.common.answer_envelope import _summary_redundant
from aiq_agent.common.answer_envelope import gate_answer_meta

OIB2_PROSE = (
    "Die OIB-Richtlinie 2 ist das Regelwerk zum **Brandschutz bei Gebäuden**. Die Ausgabe Mai 2023 besteht "
    "aus einem allgemeinen Teil und drei Teilen für besondere Gebäudetypen oder Situationen [1].\n\n"
    "| Teil | Geltungsbereich | Fundstelle |\n|---|---|---|\n| OIB-RL 2 | Gebäude | [1] |\n\n"
    "Welche Ausgabe maßgeblich ist, hängt am Landesrecht."
)
OIB2_SUMMARY = (
    "Die OIB-RL 2 ordnet den Brandschutz für Gebäude in einen allgemeinen Teil und drei Sonderteile; "
    "die landesrechtlich maßgebliche Ausgabe hängt vom Bundesland ab."
)


def test_a_summary_restating_the_opening_is_dropped():
    assert _summary_redundant(OIB2_SUMMARY, OIB2_PROSE) == "restates_lede"


def test_a_two_sentence_reply_is_its_own_summary():
    prose = "Das Geländer muss **1,10 m** hoch sein [1]. Eine tiefe Brüstung darf das mindern [1]."
    assert _summary_redundant("Mindestens 1,10 m; Brüstung mindert.", prose) == "short_answer"


@pytest.mark.parametrize(
    "prose",
    [
        "Die Mindestbreite beträgt 1,20 m gem. Pkt. 2.1.2 [1].",
        "Ein Handlauf ist z. B. bei mehr als drei Stufen nötig [1]. Das gilt u. a. für Außenstiegen [2].",
        "Laut Abs. 3 lt. Nr. 4 bzw. Art. 2 genügt das [1]. Vgl. Tab. 1 [2].",
    ],
)
def test_an_abbreviation_ends_no_sentence(prose):
    assert _summary_redundant("Planen Sie die Stiege mit 1,20 m.", prose) == "short_answer"


def test_three_real_sentences_are_not_a_short_answer():
    prose = "Die Stiege ist 1,20 m breit [1]. Der Handlauf ist beidseitig [1]. Das Podest ist 1,20 m tief [2]."
    assert _summary_redundant("Planen Sie die Stiege danach.", prose) is None


def test_a_consequence_summary_survives():
    prose = (
        "Tragende Bauteile in GK 4 brauchen **REI 60**, im obersten Geschoß **R 30** [1].\n\n"
        "| Lage | Anforderung | Fundstelle |\n|---|---|---|\n| oberstes Geschoß | R 30 | [1] |"
    )
    summary = "Danach ausschreiben und den Nachweis in die Einreichunterlagen aufnehmen."
    assert _summary_redundant(summary, prose) is None


def test_the_gate_drops_it_from_the_wire_and_keeps_it_without_prose():
    meta = AnswerMeta(kind="walkthrough", summary=OIB2_SUMMARY)
    assert "summary" not in (gate_answer_meta(meta, prose_chars=len(OIB2_PROSE), prose=OIB2_PROSE) or {})
    # A caller with no prose to give (the deep writer) keeps the old behaviour.
    assert gate_answer_meta(meta, prose_chars=len(OIB2_PROSE))["summary"] == OIB2_SUMMARY


def test_an_envelope_without_its_opening_is_salvaged():
    """Seen live: the reply began with the prose and switched into JSON half way."""
    from aiq_agent.common.answer_envelope import extract_answer_envelope

    reply = (
        "In GK 5 brauchen tragende Wände **R 90** [1].\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\n"
        '**Quellen:**\n- [1] oib-rl_2_ausgabe_mai_2023.pdf, p.26", '
        '"kind":"ruling","verdict":{"value":"R 90","subject":"Tragende Wände GK 5",'
        '"reference":{"document":"OIB-Richtlinie 2","section":"Tabelle 1b"}}}\n```'
    )
    prose, meta = extract_answer_envelope(reply)
    assert prose.endswith("p.26") and '"kind"' not in prose
    assert "```mermaid\nflowchart TD\n  A --> B\n```" in prose
    assert meta is not None and meta.kind == "ruling" and meta.verdict.value == "R 90"


def test_prose_that_merely_quotes_json_is_left_alone():
    from aiq_agent.common.answer_envelope import extract_answer_envelope

    reply = 'Das Feld heißt so: "x", "kind": "y" – mehr nicht.'
    assert extract_answer_envelope(reply) == (reply, None)
