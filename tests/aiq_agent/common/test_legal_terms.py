"""Tests for aiq_agent.common.legal_terms.extract_exact_terms."""

from aiq_agent.common.legal_terms import extract_exact_terms


class TestParagraphReferences:
    def test_space_separated(self):
        assert extract_exact_terms("Was sagt § 3 zur Bauweise?") == ["§ 3"]

    def test_attached(self):
        assert extract_exact_terms("Was sagt §3 zur Bauweise?") == ["§ 3"]

    def test_trailing_punctuation(self):
        assert extract_exact_terms("Gemäß §3. gilt Folgendes") == ["§ 3"]
        assert extract_exact_terms("Gemäß § 5, gilt dies") == ["§ 5"]

    def test_dotted_number(self):
        assert extract_exact_terms("§ 12.1 OIB") == ["§ 12.1", "OIB"]

    def test_letter_suffix(self):
        assert extract_exact_terms("§ 3a") == ["§ 3a"]

    def test_multiple(self):
        assert extract_exact_terms("§ 3 und §4 vergleichen") == ["§ 3", "§ 4"]

    def test_lone_paragraph_sign_ignored(self):
        assert extract_exact_terms("Das § Symbol allein") == []

    def test_paragraph_without_digits_ignored(self):
        assert extract_exact_terms("§ Abs") == []


class TestOibRichtlinieReferences:
    def test_basic(self):
        assert extract_exact_terms("Was fordert OIB-Richtlinie 2?") == ["OIB-Richtlinie 2"]

    def test_case_insensitive(self):
        assert extract_exact_terms("oib-richtlinie 3 Treppen") == ["OIB-Richtlinie 3"]

    def test_without_number_falls_back_to_allcaps(self):
        # "OIB-Richtlinie" alone is not ALLCAPS (mixed case) and has no number.
        assert extract_exact_terms("die OIB-Richtlinie allgemein") == []

    def test_trailing_period_on_number(self):
        assert extract_exact_terms("Laut OIB-Richtlinie 4. sind") == ["OIB-Richtlinie 4"]


class TestQuotedPhrases:
    def test_double_quotes(self):
        assert extract_exact_terms('Suche nach "Fluchtweg Breite" im Dokument') == ["Fluchtweg Breite"]

    def test_german_quotes(self):
        assert extract_exact_terms("Der Begriff „Mindestabstand“ ist definiert") == ["Mindestabstand"]

    def test_single_quotes(self):
        assert extract_exact_terms("Der 'Brandschutzbehelf' gilt") == ["Brandschutzbehelf"]

    def test_unclosed_quote_ignored(self):
        assert extract_exact_terms('Ein "offenes Zitat') == []

    def test_empty_quotes_ignored(self):
        assert extract_exact_terms('Leer "" hier') == []


class TestAllcapsTokens:
    def test_basic(self):
        assert extract_exact_terms("Was ist die OIB?") == ["OIB"]

    def test_below_threshold_ignored(self):
        assert extract_exact_terms("AB und CD") == []

    def test_threshold_boundary(self):
        assert extract_exact_terms("ABC ab") == ["ABC"]

    def test_with_digits(self):
        assert extract_exact_terms("Die ÖNORM B1800 gilt") == ["ÖNORM", "B1800"]

    def test_mixed_case_ignored(self):
        assert extract_exact_terms("Richtlinie und Gesetz") == []

    def test_parenthesized(self):
        assert extract_exact_terms("Die (OIB) gilt") == ["OIB"]


class TestCaseInsensitiveIdentifiers:
    """Backlog item 13: casefold predicate — normalization, not vocabulary."""

    def test_bare_lowercase_matches_uppercase(self):
        assert extract_exact_terms("oib 2") == extract_exact_terms("OIB 2") == ["OIB"]

    def test_lowercase_in_sentence_matches_uppercase(self):
        lower = extract_exact_terms("was weißt du über die oib 2")
        upper = extract_exact_terms("was weißt du über die OIB 2")
        assert lower == upper == ["OIB"]

    def test_titlecase_acronym_with_number(self):
        assert extract_exact_terms("Oib 2") == ["OIB"]

    def test_lowercase_umlaut_acronym_with_number(self):
        assert extract_exact_terms("önorm 2") == ["ÖNORM"]

    def test_lowercase_code_with_digits(self):
        assert extract_exact_terms("b1800") == extract_exact_terms("B1800") == ["B1800"]

    def test_trailing_number_is_not_part_of_term(self):
        # The number is shape evidence, not term content: the parity basis.
        assert extract_exact_terms("OIB 2") == ["OIB"]

    def test_bare_lowercase_acronym_without_shape_stays_silent(self):
        # No identifier shape (no digits, no adjacent number) -> no term.
        # Vocabulary-free means bare "oib" is indistinguishable from prose;
        # only the citation shape unlocks the casefold.
        assert extract_exact_terms("was ist oib") == []

    def test_mixed_case_prose_without_shape_stays_silent(self):
        assert extract_exact_terms("Richtlinie und Gesetz") == []


class TestStopwordProbe:
    """Backlog item 13 ratchet: German function words must never leak into exact terms."""

    def test_sentence_probe_yields_zero_terms(self):
        assert extract_exact_terms("was weißt du über die und der") == []

    def test_bare_function_words_yield_zero_terms(self):
        for probe in ("die der und", "was über du", "der die das", "und oder aber"):
            assert extract_exact_terms(probe) == []


class TestOrderingDedupAndCap:
    def test_order_of_first_appearance(self):
        assert extract_exact_terms("ABC dann § 5 dann XYZ") == ["ABC", "§ 5", "XYZ"]

    def test_dedup(self):
        assert extract_exact_terms("§ 3 und nochmal § 3 und §3") == ["§ 3"]

    def test_default_cap_of_three(self):
        assert extract_exact_terms("ABC DEF GHI JKL") == ["ABC", "DEF", "GHI"]

    def test_custom_cap(self):
        assert extract_exact_terms("ABC DEF GHI JKL", max_terms=2) == ["ABC", "DEF"]
        assert extract_exact_terms("ABC DEF GHI JKL", max_terms=10) == ["ABC", "DEF", "GHI", "JKL"]

    def test_zero_and_negative_cap(self):
        assert extract_exact_terms("§ 3", max_terms=0) == []
        assert extract_exact_terms("§ 3", max_terms=-1) == []


class TestMixedQueries:
    def test_all_categories(self):
        query = 'Gemäß § 3 der OIB-Richtlinie 1 und "ausreichende Breite" der ÖNORM'
        assert extract_exact_terms(query) == ["§ 3", "OIB-Richtlinie 1", "ausreichende Breite"]

    def test_quoted_phrase_consumes_inner_terms(self):
        # Terms inside quotes belong to the phrase, not extracted separately.
        assert extract_exact_terms('"§ 3 OIB" suchen') == ["§ 3 OIB"]


class TestEmptyAndGarbage:
    def test_empty(self):
        assert extract_exact_terms("") == []

    def test_whitespace_only(self):
        assert extract_exact_terms("   \n\t  ") == []

    def test_punctuation_only(self):
        assert extract_exact_terms("... !!! ???") == []

    def test_plain_sentence(self):
        assert extract_exact_terms("Wie hoch darf ein Geländer sein?") == []
