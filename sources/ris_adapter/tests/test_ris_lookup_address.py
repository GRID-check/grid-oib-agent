"""[1] The address stage: what the caller's words already say.

Pure text matching, and the cheapest stage in the tool — everything it reads
correctly is an LLM call the pipeline does not make. So it is tested on its
own, without a client, a catalog or a model.
"""

from __future__ import annotations

import pytest
from ris_adapter.lookup.address import LAND_FROM_ARGUMENT
from ris_adapter.lookup.address import LAND_FROM_INSTRUMENT
from ris_adapter.lookup.address import LAND_FROM_QUESTION
from ris_adapter.lookup.address import land_sentence
from ris_adapter.lookup.address import parse_address


class TestTheSection:
    def test_a_paragraph_in_the_instrument(self):
        address = parse_address("Was ist zu tun?", "§ 63 Abs 1 BO Wien", "")

        assert (address.kind, address.number, address.absatz) == ("§", "63", "1")
        assert address.has_section

    def test_a_paragraph_in_the_question_alone(self):
        address = parse_address("Was verlangt § 63 der Bauordnung?", "", "")

        assert (address.kind, address.number) == ("§", "63")

    def test_an_artikel_is_an_address_too(self):
        address = parse_address("Was steht in Artikel 5?", "", "")

        assert (address.kind, address.number) == ("Art", "5")

    def test_no_section_named_means_no_deterministic_path(self):
        address = parse_address("Welche Unterlagen braucht die Einreichung?", "Bauordnung für Wien", "")

        assert not address.has_section
        assert address.law == "Bauordnung für Wien"

    def test_the_law_name_survives_the_paragraph_being_cut_out_of_it(self):
        assert parse_address("?", "§ 63 Abs 1 Bauordnung für Wien", "").law == "Bauordnung für Wien"


class TestTheDirectAddress:
    def test_a_ris_url_is_an_address(self):
        url = "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006"

        address = parse_address("Was steht da?", url, "")

        assert address.url == url
        assert address.law == ""

    def test_a_url_on_the_ogd_host_is_the_public_one(self):
        """Cached search text states ogd URLs; they are an address, not a law's name."""
        address = parse_address("Was steht da?", "https://ogd.ris.bka.gv.at/Dokumente/x/y.html", "")

        assert address.url == "https://www.ris.bka.gv.at/Dokumente/x/y.html"
        assert address.law == ""

    def test_a_foreign_url_is_not_one(self):
        """This adapter fetches RIS and nothing else; a stray link is not an address."""
        address = parse_address("Was steht da?", "https://example.com/gesetz.html", "")

        assert address.url == ""

    def test_a_document_number_is_an_address(self):
        address = parse_address("Was steht da?", "NOR40217157", "")

        assert address.document_number == "NOR40217157"

    def test_a_case_law_document_number_is_one_too(self):
        assert parse_address("?", "JWT_2020130074_20210415J00", "").document_number == "JWT_2020130074_20210415J00"

    def test_a_named_law_is_not_mistaken_for_a_document_number(self):
        """ "Bauordnung" fits the shape of a document number letter for letter.

        Read as one, it becomes an address nothing can resolve: the catalog is
        skipped, the live search never runs, and the question misses with a law
        named in the arguments. Every RIS number carries a year-length run of
        digits; no law's short title does.
        """
        address = parse_address("Welche Stellplätze sind nötig? § 60", "Bauordnung", "")

        assert address.document_number == ""
        assert address.law == "Bauordnung"


class TestTheJurisdiction:
    """A wrong Bundesland is the commonest silent RIS failure, so both the
    value and its provenance travel."""

    def test_the_argument_wins_over_everything(self):
        address = parse_address("Bauordnung in Wien?", "BO Wien", "Tirol")

        assert address.bundesland == "Tirol"
        assert address.bundesland_source == LAND_FROM_ARGUMENT

    def test_the_instrument_wins_over_the_question(self):
        address = parse_address("Wie ist das in Wien?", "Tiroler Bauordnung", "")

        assert (address.bundesland, address.bundesland_source) == ("Tirol", LAND_FROM_INSTRUMENT)

    def test_the_question_is_read_when_nothing_else_names_one(self):
        address = parse_address("Was verlangt die Bauordnung in Salzburg?", "", "")

        assert (address.bundesland, address.bundesland_source) == ("Salzburg", LAND_FROM_QUESTION)

    def test_an_unresolved_land_says_so_rather_than_guessing(self):
        address = parse_address("Was verlangt die Bauordnung?", "", "")

        assert address.bundesland == ""
        assert "No Bundesland was resolved" in land_sentence(address)

    def test_a_resolved_land_names_where_it_came_from(self):
        sentence = land_sentence(parse_address("?", "", "Wien"))

        assert sentence == f"Assumed Bundesland: Wien (from {LAND_FROM_ARGUMENT})."


class TestAListOfParagraphs:
    """ "§§ 75 und 81 BO Wien" addresses both. Read as one § it kept § 75, left
    "und 81" in the law's name, and the agent spent a round asking for § 81."""

    def test_every_paragraph_of_a_list_is_addressed(self):
        address = parse_address("Wie hoch darf gebaut werden?", "§§ 75 und 81 Bauordnung für Wien", "")

        assert address.sections == ("75", "81")
        assert address.number == "75"
        assert address.law == "Bauordnung für Wien"

    def test_commas_and_repeated_signs_are_a_list_too(self):
        assert parse_address("x", "§§ 2, 3 Baupolizeigesetz Salzburg", "").sections == ("2", "3")
        assert parse_address("Was verlangen § 5 und § 7 der Bauordnung?", "", "").sections == ("5", "7")

    def test_a_short_range_is_expanded(self):
        assert parse_address("x", "§§ 63 bis 65 BO Wien", "").sections == ("63", "64", "65")

    def test_a_list_past_the_budget_reads_its_first_six_and_names_the_rest(self):
        # It used to fall back to the first § alone, silently: "§§ 3 bis 12"
        # came back as § 3, as if that were the answer.
        address = parse_address("x", "§§ 3 bis 12 BO Wien", "")

        assert address.sections == ("3", "4", "5", "6", "7", "8")
        assert address.unread == ("9", "10", "11", "12")
        assert address.law == "BO Wien"

    def test_a_range_from_a_lettered_paragraph_continues_after_it(self):
        assert parse_address("x", "§§ 7a bis 9 BO Wien", "").sections == ("7a", "8", "9")

    def test_an_absatz_list_leaves_nothing_in_the_laws_name(self):
        assert parse_address("x", "§ 5 Abs 2 und 3 BO Wien", "").law == "BO Wien"
        assert parse_address("x", "§ 81 Abs. 1 bis 3 BO Wien", "").law == "BO Wien"

    def test_a_list_of_artikel_is_a_list_too(self):
        address = parse_address("x", "Art. 5 und 7 B-VG", "")

        assert (address.kind, address.sections, address.law) == ("Art", ("5", "7"), "B-VG")

    def test_an_absatz_narrows_one_paragraph_never_a_list(self):
        single = parse_address("x", "§ 2 Abs. 5 Baupolizeigesetz", "")
        listed = parse_address("x", "§§ 2 und 3 Abs. 4 Baupolizeigesetz", "")

        assert (single.sections, single.absatz) == (("2",), "5")
        assert (listed.sections, listed.absatz) == (("2", "3"), "")


def test_a_list_shares_one_budget_and_one_named_paragraph_keeps_its_own():
    from ris_adapter.lookup.address import parse_address
    from ris_adapter.lookup.grammar import SECTION_MAX_CHARS
    from ris_adapter.lookup.passages import LIST_MAX_CHARS
    from ris_adapter.lookup.passages import _passage_limit

    one = parse_address("x", "§ 63 BO Wien", "")
    six = parse_address("x", "§§ 63 bis 68 BO Wien", "")

    assert _passage_limit(one, 2) == SECTION_MAX_CHARS
    assert _passage_limit(six, 6) * 6 <= LIST_MAX_CHARS


def test_a_range_past_the_old_span_names_every_paragraph_it_did_not_read():
    # Past 200 §§ a range used to keep only its two ends: §§ 3-299 were
    # dropped while the result claimed to name what it had not read.
    address = parse_address("x", "§§ 1 bis 300 BO Wien", "")

    assert address.sections == ("1", "2", "3", "4", "5", "6")
    assert address.unread[0] == "7" and address.unread[-1] == "300" and len(address.unread) == 294


def test_the_unread_line_says_bis_only_for_a_run():
    from ris_adapter.lookup.render import _unread_sentence

    address = parse_address("x", "§§ 1, 2, 3, 4, 5, 6, 9 und 12 BO Wien", "")

    assert "not read: § 9, § 12" in _unread_sentence(address)


class TestTheListReaderAgainstPracticeInputs:
    """Inputs a list parser built from one regex got wrong (code review, 2026-09-25)."""

    def test_the_list_starts_at_the_first_paragraph_named(self):
        # A later list is a reference, not the address: § 3 was dropped for §§ 75, 81.
        assert parse_address("Gilt § 3 BO auch für §§ 75 und 81?", "", "").sections == ("3",)
        address = parse_address("x", "§ 3 BO Wien, siehe §§ 75 und 81", "")
        assert (address.sections, address.law) == (("3",), "BO Wien")

    @pytest.mark.parametrize(
        "instrument",
        ["§ 3 BO Wien, siehe §§ 75 und 81", "§ 3 BO Wien, vgl. § 75", "§ 3 BO Wien (s. § 75)", "§ 3 BO Wien vgl § 7"],
    )
    def test_the_word_that_introduced_a_reference_is_not_part_of_the_law(self, instrument):
        # The law name is the live RIS search's title: "BO Wien, siehe" finds nothing.
        assert parse_address("x", instrument, "").law == "BO Wien"

    def test_an_absatz_between_two_paragraphs_does_not_end_the_list(self):
        address = parse_address("x", "§ 5 Abs 2 und § 7 BO Wien", "")
        assert (address.sections, address.absatz, address.law) == (("5", "7"), "", "BO Wien")

    def test_every_qualifier_of_a_paragraph_is_read_before_the_next_one(self):
        # One qualifier per item ended the list at "Z 2" and dropped § 7 into the law's name.
        cases = {
            "§ 5 Abs 1 Z 2 und § 7 BO Wien": (("5", "7"), "BO Wien"),
            "§ 5 Abs 2 lit. a und § 7": (("5", "7"), ""),
            "§ 63 Abs. 1 lit. b BO für Wien": (("63",), "BO für Wien"),
            # A second item of the same qualifier, lettered or signed again, is not the law.
            "§ 5 lit. b und c BO Wien": (("5",), "BO Wien"),
            "§ 5 lit. a, b BO Wien": (("5",), "BO Wien"),
            "§ 5 Z 4 und Z 6 BO Wien": (("5",), "BO Wien"),
            "§ 5 Abs 2 und Abs 3 BO Wien": (("5",), "BO Wien"),
            "§ 63 Abs. 1 lit. b und c Bauordnung für Wien": (("63",), "Bauordnung für Wien"),
            "§ 5 lit. b und § 7 BO Wien": (("5", "7"), "BO Wien"),
        }
        for instrument, expected in cases.items():
            address = parse_address("x", instrument, "")
            assert (address.sections, address.law) == expected, instrument

    def test_an_ordinal_or_a_year_after_a_comma_is_not_a_paragraph(self):
        assert parse_address("x", "§ 8, 2. Satz BO", "").sections == ("8",)
        assert parse_address("x", "§ 8, 2. Satz BO", "").law == "BO"
        assert parse_address("x", "§ 5, 1996 K-BO", "").sections == ("5",)

    def test_a_lettered_range_names_the_letters_between(self):
        assert parse_address("x", "§ 5a-5c BO", "").sections == ("5a", "5b", "5c")
        assert parse_address("x", "§ 5a bis 5c BO", "").sections == ("5a", "5b", "5c")

    def test_a_range_that_does_not_ascend_adds_nothing(self):
        assert parse_address("x", "§ 12 bis 3 BO", "").sections == ("12",)
        assert parse_address("x", "§ 20 bis 18a BO", "").sections == ("20",)

    def test_a_dash_before_the_law_is_not_part_of_its_name(self):
        assert parse_address("x", "§ 5 - Bautechnikgesetz 2015", "").law == "Bautechnikgesetz 2015"


def test_the_address_budget_is_the_passage_budget():
    from ris_adapter.lookup.address import MAX_ADDRESSED_SECTIONS
    from ris_adapter.lookup.extract import MAX_PASSAGES

    assert MAX_ADDRESSED_SECTIONS == MAX_PASSAGES


def test_one_surviving_paragraph_of_a_list_gets_no_more_than_a_named_one():
    from ris_adapter.lookup.grammar import SECTION_MAX_CHARS
    from ris_adapter.lookup.passages import _passage_limit

    assert _passage_limit(parse_address("x", "§§ 63 bis 68 BO Wien", ""), 1) == SECTION_MAX_CHARS


def test_a_list_across_two_documents_shares_one_budget():
    """The list budget is per call: one § in one law and five in another stay inside it."""
    from ris_adapter.client import RisDocument
    from ris_adapter.lookup.candidates import Candidate
    from ris_adapter.lookup.extract import Selection
    from ris_adapter.lookup.fetch import FetchedDocument
    from ris_adapter.lookup.grammar import Section
    from ris_adapter.lookup.passages import LIST_MAX_CHARS
    from ris_adapter.lookup.passages import build_passages

    body = "\n".join(f"({n}) " + "x" * 2000 for n in range(1, 11))

    def selection(title: str, numbers: range) -> Selection:
        document = RisDocument(url=f"https://www.ris.bka.gv.at/{title}", title=title, text=body)
        picks = tuple((Section(kind="§", number=str(n), heading="", body=body), "") for n in numbers)
        return Selection(fetched=FetchedDocument(candidate=Candidate(title=title), document=document), picks=picks)

    address = parse_address("x", "§§ 1 bis 6 BO", "")
    passages = build_passages([selection("A", range(1, 2)), selection("B", range(2, 7))], address)

    assert len(passages) == 6
    assert sum(len(passage.body) for passage in passages) <= LIST_MAX_CHARS
