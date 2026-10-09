"""The upload screen's rules: terms, the three detectors, and the reason it writes.

Pure functions, no job. The job half (that a match stops the file before any
model call) is ``test_upload_screening_ingestion.py``.
"""

from __future__ import annotations

import json

import pytest
from knowledge_layer.llamaindex import screening
from knowledge_layer.llamaindex.screening import QUARANTINED_PREFIX
from knowledge_layer.llamaindex.screening import Reason
from knowledge_layer.llamaindex.screening import ScreeningRules
from knowledge_layer.llamaindex.screening import ScreeningVerdict
from knowledge_layer.llamaindex.screening import quarantine_error
from knowledge_layer.llamaindex.screening import screen_pages

_IBAN_AT = "AT61 1904 3002 3457 3201"
_IBAN_AT_COMPACT = "AT611904300234573201"
_IBAN_DE = "DE89 3704 0044 0532 0130 00"


def _rules(terms=(), detectors=()) -> ScreeningRules:
    rules = ScreeningRules.build(terms, detectors)
    assert rules is not None
    return rules


def _kinds(text: str, rules: ScreeningRules) -> list[str]:
    return [reason.kind for reason in screen_pages([(1, text)], rules).reasons]


def _payload(error: str) -> dict:
    assert error.startswith(QUARANTINED_PREFIX)
    return json.loads(error[len(QUARANTINED_PREFIX) :])


# =============================================================================
# Rules from the job config
# =============================================================================


class TestFromConfig:
    @pytest.mark.parametrize(
        "raw", [None, {}, {"content_terms": [], "detectors": []}, {"content_terms": ["  ", "x"]}, {"detectors": None}]
    )
    def test_absent_or_empty_is_no_rules(self, raw):
        assert ScreeningRules.from_config(raw) is None

    @pytest.mark.parametrize(
        "raw", ["Gehalt", ["Gehalt"], {"content_terms": "Gehalt"}, {"content_terms": [1, 2]}, {"detectors": "iban"}]
    )
    def test_a_malformed_config_is_no_rules_and_a_warning(self, raw, caplog):
        assert ScreeningRules.from_config(raw) is None
        assert "Ignoring" in caplog.text

    def test_terms_are_kept_as_written_and_detectors_in_report_order(self):
        rules = ScreeningRules.from_config(
            {
                "content_terms": [" Gehaltsübersicht ", "GEHALTSUEBERSICHT", "Honorar"],
                "detectors": ["credit_card", "iban"],
            }
        )
        assert rules is not None
        # One folded form, one term: the first spelling stands.
        assert rules.terms == ("Gehaltsübersicht", "Honorar")
        assert rules.detectors == ("iban", "credit_card")

    def test_an_unknown_detector_is_dropped_with_a_warning(self, caplog):
        rules = ScreeningRules.from_config({"detectors": ["iban", "passport"]})
        assert rules is not None and rules.detectors == ("iban",)
        assert "passport" in caplog.text

    def test_at_most_two_hundred_terms(self):
        rules = ScreeningRules.from_config({"content_terms": [f"Begriff{n:03d}" for n in range(250)]})
        assert rules is not None and len(rules.terms) == screening.MAX_TERMS


# =============================================================================
# Terms
# =============================================================================


class TestTerms:
    @pytest.mark.parametrize(
        "text",
        [
            "Die Gehaltsübersicht 2025",
            "DIE GEHALTSÜBERSICHT",
            "die gehaltsuebersicht",
            "Gehaltsübersicht",  # decomposed ü, as some PDFs extract it
            "(Gehaltsübersicht)",
        ],
    )
    def test_case_and_umlaut_spellings_match(self, text):
        assert _kinds(text, _rules(["Gehaltsübersicht"])) == ["term"]

    def test_a_transliterated_term_matches_the_umlaut_spelling(self):
        assert _kinds("Gehaltsübersicht März", _rules(["Gehaltsuebersicht"])) == ["term"]

    def test_eszett_folds_to_ss_both_ways(self):
        assert _kinds("Musterstrasse 5", _rules(["Musterstraße"])) == ["term"]
        assert _kinds("Musterstraße 5", _rules(["Musterstrasse"])) == ["term"]

    @pytest.mark.parametrize("text", ["Honorarvereinbarung", "die Honorare", "Honorar:", "honorar"])
    def test_a_term_matches_at_a_word_start_and_may_run_on(self, text):
        assert _kinds(text, _rules(["Honorar"])) == ["term"]

    @pytest.mark.parametrize("text", ["Ehrenhonorar", "Pauschalhonorar", "2Honorar"])
    def test_a_term_inside_a_word_does_not_match(self, text):
        assert _kinds(text, _rules(["Honorar"])) == []

    def test_a_multi_word_term_matches_across_any_whitespace(self):
        rules = _rules(["streng vertraulich"])
        assert _kinds("STRENG   vertraulich", rules) == ["term"]
        assert _kinds("streng\nvertraulich", rules) == ["term"]
        assert _kinds("streng-vertraulich", rules) == []

    def test_a_term_is_a_literal_not_a_pattern(self):
        assert _kinds("Gehalt a.b", _rules(["a.b"])) == ["term"]
        assert _kinds("Gehalt axb", _rules(["a.b"])) == []

    def test_count_and_pages_per_term(self):
        rules = _rules(["Gehalt", "Lohn"])
        pages = [(n, "Gehalt und Gehalt") for n in range(1, 14)] + [(None, "Lohn")]

        verdict = screen_pages(pages, rules)

        gehalt, lohn = verdict.reasons
        assert (gehalt.term, gehalt.count, gehalt.pages) == ("Gehalt", 26, list(range(1, 11)))
        assert (lohn.term, lohn.count, lohn.pages) == ("Lohn", 1, [])
        assert gehalt.sample is None

    def test_clean_text_is_no_match(self):
        verdict = screen_pages([(1, "Brandschutzkonzept, Fluchtweglänge 40 m.")], _rules(["Gehalt"], ["iban"]))
        assert not verdict.matched and verdict.reasons == []


# =============================================================================
# Detectors
# =============================================================================


class TestIban:
    @pytest.mark.parametrize(
        "text",
        [
            f"IBAN: {_IBAN_AT}",
            f"IBAN {_IBAN_AT_COMPACT}.",
            f"{_IBAN_DE} BIC COBADEFFXXX",
            "CH93 0076 2011 6238 5295 7",
            "GB29 NWBK 6016 1331 9268 19",
            f"{_IBAN_AT} EUR",  # a following group of letters is not part of it
            f"{_IBAN_AT} 12",  # nor a following short number: the country fixes the length
            "at61 1904 3002 3457 3201",  # typed in lower case
            "AT61-1904-3002-3457-3201",  # any whitespace run, or one hyphen or full stop, between groups
            "AT６１ 1904 3002 3457 3201",  # any decimal digit is read as its value
        ],
    )
    def test_a_checksum_valid_iban_matches(self, text):
        assert _kinds(text, _rules(detectors=["iban"])) == ["iban"]

    @pytest.mark.parametrize(
        "text",
        [
            "AT61 1904 3002 3457 3202",  # wrong check
            "AT62 1904 3002 3457 3201",  # wrong check digits
            "XAT611904300234573201",  # inside a longer token
            "AT6119043002345732011",  # one character too many for AT
            "XX61 1904 3002 3457 3201",  # no registered country
        ],
    )
    def test_an_invalid_or_embedded_candidate_does_not(self, text):
        assert _kinds(text, _rules(detectors=["iban"])) == []

    def test_the_sample_is_masked(self):
        [reason] = screen_pages([(3, f"IBAN {_IBAN_AT}")], _rules(detectors=["iban"])).reasons
        assert reason.sample == "AT61 •••• •••• •••• 3201"
        assert reason.pages == [3]

    def test_valid_iban_lengths(self):
        assert screening.valid_iban(_IBAN_AT_COMPACT)
        assert not screening.valid_iban(_IBAN_AT_COMPACT + "0")


class TestAustrianSocialSecurityNumber:
    @pytest.mark.parametrize(
        "text",
        [
            "SVNR 1237 010180",
            "SV-Nr.: 1237010180",
            "4568 311299",
            "7890 151370",
            "1237  010180",  # any run of whitespace
            "1237-010180",
            "1237/010180",
            "1237 01 01 80",
            "١٢٣٧ ٠١٠١٨٠",  # Arabic-Indic digits
        ],
    )
    def test_a_valid_number_matches(self, text):
        assert _kinds(text, _rules(detectors=["at_svnr"])) == ["at_svnr"]

    @pytest.mark.parametrize(
        "text",
        [
            "1238 010180",  # wrong check digit
            "4561 000180",  # day 00
            "4561 011680",  # month 16
            "1000 010180",  # the weighted sum gives 10: never issued
            "0123 010180",  # leading zero
            "91237010180",  # inside a longer digit run
            "1237 0101801",  # inside a longer digit run
            "1237 01 0180",  # the date is either joined or separated throughout
        ],
    )
    def test_an_invalid_or_embedded_number_does_not(self, text):
        assert _kinds(text, _rules(detectors=["at_svnr"])) == []

    def test_the_sample_keeps_the_last_two_digits_only(self):
        [reason] = screen_pages([(1, "1237 010180")], _rules(detectors=["at_svnr"])).reasons
        assert reason.sample == "•••• ••••80"


class TestCreditCard:
    @pytest.mark.parametrize(
        "text",
        [
            "Karte 4111 1111 1111 1111",
            "4111-1111-1111-1111",
            "5555555555554444",
            "Amex 3782 822463 10005",
            "4111.1111.1111.1111",
            "4111 1111 1111 1111 123",  # followed by its security code
        ],
    )
    def test_a_luhn_valid_card_matches(self, text):
        assert _kinds(text, _rules(detectors=["credit_card"])) == ["credit_card"]

    @pytest.mark.parametrize(
        "text",
        [
            "4111 1111 1111 1112",  # Luhn fails
            "1111 1111 1111 1117",  # no major network starts with 1
            "94111111111111111",  # inside a longer digit run
            "4111 1111 1111 1111 1111 1111",  # inside a longer separated run
            "Auftrag 12 4111 1111 1111 1111",  # a number before it in the same run
            "411111111111",  # too short
        ],
    )
    def test_an_invalid_or_embedded_card_does_not(self, text):
        assert _kinds(text, _rules(detectors=["credit_card"])) == []

    def test_an_iban_is_not_read_as_a_card(self):
        assert _kinds(_IBAN_AT_COMPACT, _rules(detectors=["credit_card"])) == []
        assert _kinds(_IBAN_AT, _rules(detectors=["credit_card"])) == []

    def test_the_sample_keeps_the_last_four_only(self):
        [reason] = screen_pages([(1, "4111 1111 1111 1111")], _rules(detectors=["credit_card"])).reasons
        assert reason.sample == "•••• 1111"


def test_a_detector_not_switched_on_is_not_run():
    assert _kinds(f"{_IBAN_AT} 1237 010180", _rules(["Gehalt"])) == []


# =============================================================================
# The reason a quarantined file carries
# =============================================================================


class TestQuarantineError:
    def test_the_shape_is_the_contract(self):
        rules = _rules(["Gehaltsabrechnung"], ["iban", "at_svnr", "credit_card"])
        text = f"Gehaltsabrechnung März, IBAN {_IBAN_AT}, SVNR 1237 010180, Karte 4111 1111 1111 1111"
        verdict = screen_pages([(2, text)], rules, checked="partial")

        payload = _payload(quarantine_error(verdict))

        assert payload == {
            "reasons": [
                {"kind": "term", "term": "Gehaltsabrechnung", "count": 1, "pages": [2]},
                {"kind": "iban", "count": 1, "pages": [2], "sample": "AT61 •••• •••• •••• 3201"},
                {"kind": "at_svnr", "count": 1, "pages": [2], "sample": "•••• ••••80"},
                {"kind": "credit_card", "count": 1, "pages": [2], "sample": "•••• 1111"},
            ],
            "checked": "partial",
        }

    def test_no_matched_value_is_ever_in_it(self):
        rules = _rules(detectors=["iban", "at_svnr", "credit_card"])
        text = f"{_IBAN_AT} / {_IBAN_AT_COMPACT} / {_IBAN_DE} / 1237 010180 / 4111 1111 1111 1111"
        error = quarantine_error(screen_pages([(1, text)], rules))

        for value in (_IBAN_AT, _IBAN_AT_COMPACT, _IBAN_DE, "DE89370400440532013000", "1237010180", "1237 010180"):
            assert value not in error
        for digits in ("4111111111111111", "4111 1111 1111 1111", "19043002", "3002 3457", "370400440532"):
            assert digits not in error

    def test_umlauts_are_written_as_they_are(self):
        verdict = screen_pages([(1, "Gehaltsübersicht")], _rules(["Gehaltsübersicht"]))
        assert '"term":"Gehaltsübersicht"' in quarantine_error(verdict)

    def test_at_most_ten_reasons(self):
        rules = _rules([f"Begriff{n:02d}" for n in range(15)])
        text = " ".join(f"Begriff{n:02d}" for n in range(15))
        payload = _payload(quarantine_error(screen_pages([(1, text)], rules)))
        assert len(payload["reasons"]) == screening.MAX_REASONS

    def test_ten_reasons_of_in_bounds_terms_fit_whole(self):
        terms = [f"{n:02d}" + "ä" * 78 for n in range(10)]
        verdict = ScreeningVerdict(
            reasons=[Reason(kind="term", term=term, count=999, pages=list(range(1, 11))) for term in terms]
        )
        assert len(_payload(quarantine_error(verdict))["reasons"]) == 10

    def test_it_fits_two_thousand_characters_and_stays_json(self):
        # Longer than any term the rules let through: the cap must hold anyway.
        long_terms = [f"{n:02d}" + "ä" * 298 for n in range(10)]
        verdict = ScreeningVerdict(
            reasons=[Reason(kind="term", term=term, count=999, pages=list(range(1, 11))) for term in long_terms]
        )

        error = quarantine_error(verdict)

        assert len(error) <= screening.MAX_ERROR_CHARS
        payload = _payload(error)
        assert 0 < len(payload["reasons"]) < 10
        assert payload["checked"] == "full"

    def test_the_log_summary_names_kinds_and_counts_only(self):
        verdict = screen_pages([(1, f"Gehaltsabrechnung {_IBAN_AT}")], _rules(["Gehaltsabrechnung"], ["iban"]))
        assert screening.log_summary(verdict) == "term=1, iban=1"


class TestDocumentPages:
    def test_a_numeric_page_label_is_the_page(self):
        class Doc:
            def __init__(self, label, text):
                self.metadata = {"page_label": label}
                self.text = text

        pages = screening.document_pages([Doc("3", "a"), Doc(4, "b"), Doc("Tabelle1", "c"), Doc(None, "d")])
        assert pages == [(3, "a"), (4, "b"), (None, "c"), (None, "d")]
