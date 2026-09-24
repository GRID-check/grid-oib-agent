"""A standfirst earns its place by saying what the opening does not.

Pinned on the three answers the September 2026 live census produced: every
summary restated the prose's first paragraph, directly above it. The prompt's
own consequence-summary („Danach ausschreiben …") must survive.
"""

from __future__ import annotations

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
