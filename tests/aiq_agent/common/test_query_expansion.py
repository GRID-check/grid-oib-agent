"""Tests for the cross-lingual query bridge.

The corpus is German; users ask in German and English. Measured on this corpus with
a multilingual retriever over Punkt-cut chunks, an English question scored MRR 0.293
against 0.678 for the same question in German — and prepending the corpus's own
German terms closed the gap to 0.674. This module is that bridge, so what these tests
pin is the shape of an augmentation that has to stay additive, deterministic, and
invisible to German.

All offline: no LLM, no network, no database.
"""

from __future__ import annotations

import pytest

from aiq_agent.common.query_expansion import augmented_query
from aiq_agent.common.query_expansion import detect_language
from aiq_agent.common.query_expansion import expansion_terms


@pytest.fixture(autouse=True)
def _fresh_vocabulary():
    """The glossary is parsed once per process; tests must not inherit each other's."""
    from aiq_agent.common.query_expansion import reset_vocabulary_cache

    reset_vocabulary_cache()
    yield
    reset_vocabulary_cache()


def test_an_english_question_gains_the_corpus_own_german_terms() -> None:
    augmented = augmented_query("What are the facade requirements for building class 4 and 5?")
    assert "Fassade" in augmented
    assert "Gebäudeklasse" in augmented


def test_the_users_own_words_are_never_replaced() -> None:
    """The glossary states the topic; the query carries the specifics.

    A Gebäudeklasse number, a dimension, a Bundesland — none of which the glossary
    can know — survive only because the augmentation is additive.
    """
    question = "What applies to smoke alarms in dwellings?"
    assert question in augmented_query(question)


def test_german_terms_lead_because_encoders_weight_early_tokens() -> None:
    augmented = augmented_query("What are the requirements for escape routes?")
    assert augmented.startswith("Fluchtweg")


def test_a_german_question_is_returned_untouched() -> None:
    """This must be a no-op for the language the corpus is already written in."""
    for question in ("Wie breit muss ein Fluchtweg sein?", "Welche Anforderungen gelten für Fassaden?"):
        assert augmented_query(question) == question


def test_an_english_question_the_glossary_does_not_know_is_unchanged() -> None:
    """No entry means no expansion — never a guess, and never worse than before."""
    question = "What is the quarterly revenue forecast?"
    assert augmented_query(question) == question


def test_the_longest_concept_wins_so_a_broader_one_cannot_shadow_it() -> None:
    """`building class` must not degrade to `class`, `external wall` not to `wall`."""
    terms = expansion_terms("What are the external wall requirements for building class 4?")
    assert "Außenwand" in terms
    assert "Gebäudeklasse" in terms


def test_a_hyphenated_compound_matches_the_spaced_glossary_form() -> None:
    """English writes these both ways, and a raw substring test matches only one.

    Measured: "How far may the most remote necessary building entrance be from the
    fire-brigade access road?" expanded to nothing at all and ranked its answer 119th.
    """
    assert "Feuerwehr" in expansion_terms("How far is the fire-brigade access road?")
    assert "U-Wert" in expansion_terms("What u-value applies to an external wall?")
    assert "barrierefrei" in expansion_terms("Is a step-free entrance required?")


def test_hyphenated_and_spaced_spellings_are_the_same_lookup() -> None:
    """So the glossary never has to enumerate both, and cannot drift between them."""
    assert expansion_terms("fire-brigade access") == expansion_terms("fire brigade access")


def test_the_terms_the_corpus_uses_for_sound_are_the_ones_offered() -> None:
    """`Luftschalldämmung` is the natural guess and occurs zero times in the corpus."""
    assert "Trittschall" in expansion_terms("What impact sound level is permitted?")
    assert "Luftschall" in expansion_terms("What airborne sound insulation is required?")
    assert "Luftschalldämmung" not in expansion_terms("What airborne sound insulation is required?")


def test_the_austrian_spelling_is_the_one_offered() -> None:
    """`Geschoß` occurs 779 times in the corpus against 21 for `Geschoss`."""
    assert "Geschoß" in expansion_terms("How many storeys are permitted?")


def test_language_detection_admits_when_it_does_not_know() -> None:
    """A guess here silently mis-routes a query; `unknown` is the honest answer."""
    assert detect_language("Fluchtweg") == "unknown"
    assert detect_language("") == "unknown"
    assert detect_language(None) == "unknown"


def test_a_german_character_settles_the_language_immediately() -> None:
    assert detect_language("Wie breit muss ein Fluchtweg für Gebäude sein?") == "de"


def test_expansion_is_deterministic() -> None:
    """It runs on the hot retrieval path; a varying query would vary the cache key."""
    question = "What are the fire compartment requirements?"
    assert augmented_query(question) == augmented_query(question)


def test_empty_and_missing_input_is_safe() -> None:
    for value in (None, "", "   "):
        assert augmented_query(value) in ("", value or "")
        assert expansion_terms(value) == []


def test_a_missing_glossary_disables_expansion_rather_than_retrieval(monkeypatch) -> None:
    """Expansion is an enhancement; retrieval is not. It must fail open."""
    from pathlib import Path

    from aiq_agent.common import query_expansion

    monkeypatch.setattr(query_expansion, "VOCABULARY_PATH", Path("/nonexistent/vocabulary.yml"))
    query_expansion.reset_vocabulary_cache()
    question = "What are the facade requirements?"
    assert augmented_query(question) == question
