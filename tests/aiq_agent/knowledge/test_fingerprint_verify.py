"""ADR-0064 use 12: a fingerprint value is suggested only when its quote states it."""

from __future__ import annotations

import pytest

from aiq_agent.common.decisions import Decision
from aiq_agent.knowledge import fingerprint_verify
from aiq_agent.knowledge.fingerprint_verify import verify_fingerprint
from aiq_agent.knowledge.project_experience import Evidence
from aiq_agent.knowledge.project_experience import FingerprintValue
from aiq_agent.knowledge.project_experience import VocabularyEntry
from aiq_agent.knowledge.project_experience import VocabularyOption

VOCABULARY = {
    "bundesland": VocabularyEntry(
        multiple=False,
        options=[VocabularyOption(token="wien", label="Wien"), VocabularyOption(token="tirol", label="Tirol")],
    ),
    "bauweise": VocabularyEntry(
        multiple=True,
        options=[
            VocabularyOption(token="holzbau", label="Holzbau"),
            VocabularyOption(token="stahlbeton", label="Stahlbeton"),
        ],
    ),
    "gebaeudeklasse": VocabularyEntry(multiple=False, options=[VocabularyOption(token="4", label="4")]),
}


def _value(key: str, value: str | list[str], quote: str) -> FingerprintValue:
    return FingerprintValue(
        key=key, value=value, evidence=[Evidence(fileName="Baubeschreibung.pdf", page="1", quote=quote)]
    )


def _answering(monkeypatch: pytest.MonkeyPatch, by_value: dict[str, float | None]) -> list[dict]:
    """Jev answering p(stated) by the value's label; None for a call that failed."""
    seen: list[dict] = []

    def decide(states, questions, **kwargs):
        seen.extend(states)
        return [
            None
            if by_value.get(state["value"]) is None
            else Decision(answers={"stated": {"type": "noul", "noul": by_value[state["value"]]}})
            for state in states
        ]

    monkeypatch.setattr("aiq_agent.common.decisions.decide_many_blocking", decide)
    return seen


def test_a_value_its_quote_does_not_state_is_not_suggested(monkeypatch):
    _answering(monkeypatch, {"Wien": 0.04})

    kept = verify_fingerprint([_value("bundesland", "wien", "Baubehörde Wien, MA 37, Gutachten für Baden")], VOCABULARY)

    assert kept == []


def test_a_multi_valued_value_keeps_the_tokens_its_quote_states(monkeypatch):
    _answering(monkeypatch, {"Holzbau": 0.92, "Stahlbeton": 0.05})

    [kept] = verify_fingerprint(
        [_value("bauweise", ["holzbau", "stahlbeton"], "Brettsperrholz-Wände und -Decken")], VOCABULARY
    )

    assert kept.value == ["holzbau"]


def test_the_state_is_the_fact_the_value_and_the_quotes_nothing_else(monkeypatch):
    seen = _answering(monkeypatch, {"Tirol": 0.9})

    verify_fingerprint([_value("bundesland", "tirol", "Bauplatz in Seefeld in Tirol")], VOCABULARY)

    assert seen == [
        {"fact": "Bundesland", "value": "Tirol", "quotes": ["Bauplatz in Seefeld in Tirol"], "language": "de"}
    ]


def test_the_building_class_is_left_to_the_pen_which_may_derive_it(monkeypatch):
    seen = _answering(monkeypatch, {})

    kept = verify_fingerprint([_value("gebaeudeklasse", "4", "Fluchtniveau 9,8 m, vier Geschoße")], VOCABULARY)

    assert seen == [] and kept[0].value == "4"


def test_a_decision_that_did_not_run_leaves_the_reading_as_it_was(monkeypatch):
    _answering(monkeypatch, {"Wien": None})
    value = _value("bundesland", "wien", "Wien 7, Neubaugasse")

    assert verify_fingerprint([value], VOCABULARY) == [value]


def test_a_failing_client_leaves_the_reading_as_it_was(monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("down")

    monkeypatch.setattr("aiq_agent.common.decisions.decide_many_blocking", broken)
    value = _value("bundesland", "wien", "Wien 7, Neubaugasse")

    assert verify_fingerprint([value], VOCABULARY) == [value]


def test_a_value_stated_only_through_what_a_reader_knows_is_kept(monkeypatch):
    """Measured: „Stadtgemeinde Mödling" scored 0.24 for Niederösterreich. Only a clear contradiction drops."""
    _answering(monkeypatch, {"Wien": 0.24})
    value = _value("bundesland", "wien", "Magistratsabteilung 37")

    assert verify_fingerprint([value], VOCABULARY) == [value]
    assert fingerprint_verify.STATED_THRESHOLD < 0.24
