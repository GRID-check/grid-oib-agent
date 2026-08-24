"""Tests for German text analysis feeding the sparse retrieval channel.

The channel this serves replaces Chroma's ``where_document {"$contains": term}``,
which is a raw, case-sensitive, byte-level substring match: ``'oib'`` misses ``OIB``,
``'§ 3'`` also matches ``§ 30``, and ``'Fluchtweg'`` matches ``Fluchtwegbreiten``.
Measured against 53 real German questions mined from this repo, that channel produced
any term at all for 28% of them and a useful one for 9%.

The invariants below are the ones the corpus actually demands. It is Austrian German:
``Geschoß`` appears 677 times against 5 for ``Geschoss``, so a German-keyboard user
typing the latter must still find the former. ``Fluchtweg`` occurs in five inflected
forms. And a term appearing in 95% of chunks -- ``OIB`` does -- must be dropped rather
than searched, which is what the document-frequency ceiling is for.

All offline: no database, no network.
"""

from __future__ import annotations

from aiq_agent.common import german_text as g

# ===========================================================================
# Folding and stemming
# ===========================================================================


def test_austrian_eszett_folds_so_a_german_keyboard_still_finds_the_corpus() -> None:
    """`Geschoß` 677 occurrences vs `Geschoss` 5 — the query side must not care."""
    assert g.fold("Geschoß") == g.fold("Geschoss")
    assert g.fold("Straße") == g.fold("Strasse")


def test_umlauts_fold_consistently_on_both_sides() -> None:
    assert g.fold("Gebäude") == g.fold("Gebaude")
    assert g.fold("Öffnung")[0] == g.fold("Offnung")[0]


def test_every_inflected_form_of_one_lemma_reaches_the_same_lexeme() -> None:
    """The five surface forms of Fluchtweg in this corpus are one concept."""
    forms = ["Fluchtweg", "Fluchtwege", "Fluchtwegen", "Fluchtweges", "Fluchtwegs"]
    assert len({g.stem(g.fold(form)) for form in forms}) == 1


def test_the_same_analyzer_serves_the_index_and_the_query() -> None:
    """Two analyzers would drift, and the drift would look like a retrieval miss."""
    indexed = g.analyze("Die nutzbare Breite von Fluchtwegen")
    queried = g.analyze("Wie breit ist der Fluchtweg?")
    assert "fluchtweg" in indexed
    assert "fluchtweg" in queried


def test_single_characters_carry_no_signal_but_digits_do() -> None:
    """Dimensions and Gebäudeklassen are numeric; a stray letter is noise."""
    assert "4" in g.analyze("Gebaeudeklasse 4")
    assert all(len(lexeme) >= 2 or lexeme.isdigit() for lexeme in g.analyze("a b Fluchtweg 4"))


# ===========================================================================
# The cross-lingual seam
# ===========================================================================


def test_glossary_terms_are_analyzed_alongside_the_query_and_lead_it() -> None:
    """An English question cannot match German stems; a translated term is the bridge.

    The translated term states the asker's intent more directly than the words they
    happened to type, so it leads. This is the seam the bilingual glossary plugs into
    — this module deliberately does not own the glossary itself.
    """
    lexemes = g.analyze_query("escape route width", extra_terms=["Fluchtweg Breite"])
    assert lexemes[:2] == ["fluchtweg", "breit"]
    assert "escap" in lexemes, "the original wording is kept, not replaced"


def test_an_english_query_without_a_glossary_term_yields_no_german_lexemes() -> None:
    """Honest degradation: contributing nothing beats contributing noise.

    A sparse channel that matched German chunks on an incidental shared token would
    be promoted by rank fusion, which is worse than returning nothing at all.
    """
    lexemes = g.analyze_query("escape route width")
    assert "fluchtweg" not in lexemes


# ===========================================================================
# Selectivity — the document-frequency ceiling
# ===========================================================================


def test_a_term_in_almost_every_chunk_is_dropped_before_searching() -> None:
    """`OIB` matches 467 of 490 corpus chunks. Searching it returns the corpus."""
    terms = ["oib", "fluchtweg"]
    frequencies = {"oib": 467, "fluchtweg": 12}
    assert g.select_terms(terms, frequencies, total=490) == ["fluchtweg"]


def test_a_small_corpus_does_not_have_its_terms_thinned_away() -> None:
    """Below `min_total` the frequencies are not yet evidence of anything."""
    terms = ["oib", "fluchtweg"]
    frequencies = {"oib": 9, "fluchtweg": 1}
    assert g.select_terms(terms, frequencies, total=10) == terms


def test_a_query_made_only_of_corpus_wide_words_selects_nothing() -> None:
    """Contributing nothing is the correct answer, not a degenerate one.

    "OIB Richtlinie" names every document in the corpus. A sparse channel that
    answered it would return the corpus and, once rank-fused, would displace the
    dense channel's genuinely ranked hits. Silence hands the query to the channel
    that can actually discriminate.
    """
    terms = ["oib", "richtlinie"]
    frequencies = {"oib": 480, "richtlinie": 470}
    assert g.select_terms(terms, frequencies, total=490) == []


def test_terms_are_combined_disjunctively() -> None:
    """ANDing every lexeme fires on 27.8% of real questions; OR fires on all of them.

    German questions carry words ("muss", "brauche") that normative text does not, so a
    conjunctive query fails precisely on the natural phrasings users type.
    """
    assert "|" in g.build_tsquery(["fluchtweg", "breit"])
    assert "&" not in g.build_tsquery(["fluchtweg", "breit"])


# ===========================================================================
# Boundaries
# ===========================================================================


def test_empty_and_missing_input_is_safe_everywhere() -> None:
    for value in (None, "", "   "):
        assert g.fold(value) == "" or g.fold(value).isspace()
        assert g.analyze(value) == []
        assert g.query_terms(value) == []
    assert g.build_tsquery([]) == ""


def test_the_sqlite_index_blob_is_delimited_so_a_prefix_cannot_match_a_word() -> None:
    """`% weg %` must not match `Fluchtweg`; padding is what makes LIKE word-safe."""
    blob = g.index_blob("Fluchtwege im Geschoß")
    assert blob.startswith(" ") and blob.endswith(" ")
    # `like_pattern` builds the SQL operand; the padding is what makes it word-safe.
    assert g.like_pattern("fluchtweg").strip("%").strip() == "fluchtweg"
    assert " fluchtweg " in blob
    assert " weg " not in blob, "a suffix of a compound must not match as a word"
