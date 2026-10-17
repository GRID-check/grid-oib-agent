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

from aiq_agent.common.content_screen import screening_config_unusable

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

    @pytest.mark.parametrize("raw", [None, {}, {"content_terms": [], "detectors": []}, {"detectors": None}])
    def test_absent_or_empty_is_not_unusable(self, raw):
        assert not screening_config_unusable(raw)

    @pytest.mark.parametrize(
        "raw", ["Gehalt", ["Gehalt"], {"content_terms": "Gehalt"}, {"content_terms": [1]}, {"detectors": ["passport"]}]
    )
    def test_present_but_inapplicable_is_unusable(self, raw):
        assert screening_config_unusable(raw)

    def test_a_policy_with_one_rule_this_build_knows_is_usable(self):
        assert not screening_config_unusable({"detectors": ["iban", "passport"]})

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

    @pytest.mark.parametrize("text", ["Ehrenhonorar", "Pauschalhonorar"])
    def test_a_term_inside_a_word_does_not_match(self, text):
        assert _kinds(text, _rules(["Honorar"])) == []

    @pytest.mark.parametrize("text", ["2Honorar", "2024Honorar", "Pos.3Honorar"])
    def test_a_number_glued_to_a_term_is_a_label_not_a_compound(self, text):
        assert _kinds(text, _rules(["Honorar"])) == ["term"]

    @pytest.mark.parametrize("text", ["Gehalts-abrechnung", "Gehalts abrechnung", "Gehalts\u2011abrechnung"])
    def test_a_long_term_split_once_by_a_space_or_hyphen_matches(self, text):
        assert _kinds(text, _rules(["Gehaltsabrechnung"])) == ["term"]

    @pytest.mark.parametrize(
        "text",
        [
            "Ge-haltsabrechnung",  # a part shorter than three characters
            "Gehalts - abrechnung",  # a dash, not a hyphen
            "Gehalts-ab-rechnung",  # split twice
            "Hono rar",  # a term shorter than eight characters is never split
        ],
    )
    def test_a_split_that_is_not_one_term_does_not_match(self, text):
        assert _kinds(text, _rules(["Gehaltsabrechnung", "Honorar"])) == []

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
        # Every page, not the first ten: each is a place a reviewer opens the document at.
        assert (gehalt.term, gehalt.count, gehalt.pages) == ("Gehalt", 26, list(range(1, 14)))
        assert gehalt.pages_truncated is False
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
            "AT6119043002345732011",  # one character too many for AT
            "XX61 1904 3002 3457 3201",  # no registered country
        ],
    )
    def test_an_invalid_or_embedded_candidate_does_not(self, text):
        assert _kinds(text, _rules(detectors=["iban"])) == []

    @pytest.mark.parametrize(
        "text",
        [
            "XAT611904300234573201",  # a label stands against it: the country and the check digits decide
            "IBAN:AT611904300234573201BIC",  # and a letter may follow
            "AT61 1904 3002 34\u00ad57 3201",  # a soft hyphen inside it is not part of it
            "AT61 1904 3002 3457-\n3201",  # a hyphen at a line break is not part of it
        ],
    )
    def test_a_printed_iban_with_extraction_noise_matches(self, text):
        assert _kinds(text, _rules(detectors=["iban"])) == ["iban"]

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
            "411111111111",  # too short
        ],
    )
    def test_an_invalid_or_embedded_card_does_not(self, text):
        assert _kinds(text, _rules(detectors=["credit_card"])) == []

    @pytest.mark.parametrize(
        "text",
        [
            "Auftrag 12 4111 1111 1111 1111",  # a number before it in the same run is not part of it
            "Karte 1 4111 1111 1111 1111 12/27",  # nor is a position, or an expiry date after it
            "4111 11\u200b11 1111 1111",  # an invisible character inside a group
        ],
    )
    def test_a_card_next_to_other_numbers_matches(self, text):
        assert _kinds(text, _rules(detectors=["credit_card"])) == ["credit_card"]

    @pytest.mark.parametrize(
        "text",
        [
            "4111\t1111\t1111\t1111",  # table cells are not one number
            "5050 2798 6487 2514 6623 2488",  # a table of four-digit numbers gets no sliding window
        ],
    )
    def test_table_cells_are_not_a_card(self, text):
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

        assert "omitted" not in payload  # nothing was left out
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
        assert payload["omitted"] == 5  # a short list is never shown as the whole one

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
        assert payload["omitted"] == 10 - len(payload["reasons"])
        assert payload["checked"] == "full"

    def test_pages_are_cut_from_the_widest_reason_first_and_every_reason_stays(self):
        # Ten reasons on fifty pages each cannot all fit: pages give way before
        # any reason does, the widest first, and each cut reason says so.
        terms = [f"Begriff{n:02d}" + "x" * 30 for n in range(9)]
        reasons = [Reason(kind="term", term=term, count=50, pages=list(range(1, 51))) for term in terms]
        reasons.append(Reason(kind="iban", count=1, pages=[7], sample="AT61 •••• •••• •••• 3201"))
        whole = json.dumps({"reasons": [reason.as_json() for reason in reasons]}, ensure_ascii=False)
        assert len(whole) > screening.MAX_ERROR_CHARS  # the premise: it does not fit as it is
        error = quarantine_error(ScreeningVerdict(reasons=reasons))

        assert len(error) <= screening.MAX_ERROR_CHARS
        payload = _payload(error)
        assert [reason.get("term", reason["kind"]) for reason in payload["reasons"]] == [*terms, "iban"]
        for reason in payload["reasons"][:9]:
            assert reason["pages_truncated"] is True
            assert reason["pages"] == list(range(1, len(reason["pages"]) + 1))
            assert len(reason["pages"]) >= 1
        # The narrow reason was never the widest, so it keeps its page and no mark.
        assert payload["reasons"][9]["pages"] == [7]
        assert "pages_truncated" not in payload["reasons"][9]
        # Cut evenly: no reason lists more than one page beyond another.
        widths = [len(reason["pages"]) for reason in payload["reasons"][:9]]
        assert max(widths) - min(widths) <= 1

    def test_a_verdict_that_fits_keeps_every_page_and_no_mark(self):
        verdict = ScreeningVerdict(reasons=[Reason(kind="term", term="Gehalt", count=40, pages=list(range(1, 41)))])
        [reason] = _payload(quarantine_error(verdict))["reasons"]
        assert reason["pages"] == list(range(1, 41))
        assert "pages_truncated" not in reason

    def test_the_log_summary_names_kinds_and_counts_only(self):
        verdict = screen_pages([(1, f"Gehaltsabrechnung {_IBAN_AT}")], _rules(["Gehaltsabrechnung"], ["iban"]))
        assert screening.log_summary(verdict) == "term=1, iban=1"


class TestReasonPages:
    def test_a_reason_lists_every_page_it_was_found_on_up_to_the_cap(self):
        pages = [(page, "Gehaltsabrechnung") for page in range(1, screening.MAX_REASON_PAGES + 1)]
        [reason] = screen_pages(pages, _rules(["Gehaltsabrechnung"])).reasons
        assert reason.pages == list(range(1, screening.MAX_REASON_PAGES + 1))
        assert reason.pages_truncated is False

    def test_past_the_cap_it_lists_the_first_pages_and_says_the_list_is_cut(self):
        pages = [(page, f"IBAN {_IBAN_AT}") for page in range(screening.MAX_REASON_PAGES + 5, 0, -1)]
        [reason] = screen_pages(pages, _rules(detectors=["iban"])).reasons
        assert reason.pages == list(range(1, screening.MAX_REASON_PAGES + 1))
        assert reason.pages_truncated is True
        assert reason.count == screening.MAX_REASON_PAGES + 5
        assert reason.as_json()["pages_truncated"] is True

    def test_the_cap_holds_more_than_the_ten_pages_it_used_to(self):
        assert screening.MAX_REASON_PAGES >= 50


class TestDocumentPages:
    def test_a_numeric_page_label_is_the_page(self):
        class Doc:
            def __init__(self, label, text):
                self.metadata = {"page_label": label}
                self.text = text

        pages = screening.document_pages([Doc("3", "a"), Doc(4, "b"), Doc("Tabelle1", "c"), Doc(None, "d")])
        assert pages == [(3, "a"), (4, "b"), (None, "c"), (None, "d")]


# =============================================================================
# A match split across a page break
# =============================================================================


def _paged(*bodies: str, footer: str = "Seite {n} von {total}") -> list[tuple[int, str]]:
    total = len(bodies)
    return [(n, f"Projekt Wohnbau Nord\n{body}\n{footer.format(n=n, total=total)}") for n, body in enumerate(bodies, 1)]


class TestAcrossPages:
    def test_an_iban_split_by_a_page_footer_is_found_on_both_pages(self):
        stream = _paged("Bitte überweisen an DE89 3704 0044", "0532 0130 00 bis Monatsende.", "Danke.")
        verdict = screen_pages(stream, _rules(detectors=["iban"]), stream=stream)
        [reason] = verdict.reasons
        assert (reason.kind, reason.count, reason.pages) == ("iban", 1, [1, 2])

    def test_a_term_hyphenated_across_a_page_break_is_found(self):
        stream = _paged("Anbei die Gehalts-", "abrechnung für März.", "Ende.")
        verdict = screen_pages(stream, _rules(["Gehaltsabrechnung"]), stream=stream)
        assert [(reason.term, reason.pages) for reason in verdict.reasons] == [("Gehaltsabrechnung", [1, 2])]

    def test_a_match_inside_one_page_is_counted_once(self):
        stream = _paged(f"IBAN {_IBAN_AT}", "nichts", "nichts")
        [reason] = screen_pages(stream, _rules(detectors=["iban"]), stream=stream).reasons
        assert (reason.count, reason.pages) == (1, [1])

    def test_two_pages_join_without_furniture_to_go_by(self):
        # Fewer than three pages give no repetition, so nothing is taken for
        # furniture; a plain split across the break is still read whole.
        stream = [(1, "Konto DE89 3704 0044"), (2, "0532 0130 00")]
        [reason] = screen_pages(stream, _rules(detectors=["iban"]), stream=stream).reasons
        assert reason.pages == [1, 2]

    def test_without_a_stream_pages_are_screened_one_by_one(self):
        stream = _paged("Bitte überweisen an DE89 3704 0044", "0532 0130 00 bis Monatsende.", "Danke.")
        assert screen_pages(stream, _rules(detectors=["iban"])).reasons == []
