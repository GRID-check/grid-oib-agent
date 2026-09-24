"""[1] The address stage: what the caller's words already say.

Pure text matching, and the cheapest stage in the tool — everything it reads
correctly is an LLM call the pipeline does not make. So it is tested on its
own, without a client, a catalog or a model.
"""

from __future__ import annotations

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

    def test_a_range_as_long_as_a_law_is_not_an_address(self):
        # Past the tool's passage budget a range is "read the law", which the
        # ranked path does better than six arbitrary §§.
        assert parse_address("x", "§§ 1 bis 90 BO Wien", "").sections == ("1",)

    def test_an_absatz_narrows_one_paragraph_never_a_list(self):
        single = parse_address("x", "§ 2 Abs. 5 Baupolizeigesetz", "")
        listed = parse_address("x", "§§ 2 und 3 Abs. 4 Baupolizeigesetz", "")

        assert (single.sections, single.absatz) == (("2",), "5")
        assert (listed.sections, listed.absatz) == (("2", "3"), "")
