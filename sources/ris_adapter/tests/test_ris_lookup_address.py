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
