"""The consolidated-text paragraph grammar, on its own.

Everything the tool cuts out of a law goes through these four functions, and
all four are pure. A change in RIS's plain-text shape fails here, next to the
text it failed on, instead of in an end-to-end test that says only "no passage".
"""

from __future__ import annotations

from ris_adapter.lookup.grammar import PASSAGE_MAX_CHARS
from ris_adapter.lookup.grammar import absatz_body
from ris_adapter.lookup.grammar import cut_on_absatz
from ris_adapter.lookup.grammar import headings_index
from ris_adapter.lookup.grammar import split_sections

_LAW = """Bauordnung für Wien

Bauansuchen
§ 63. (1) Dem Ansuchen sind anzuschließen:
a) der Nachweis des Eigentums.
(2) Die Baupläne müssen von einem Befugten verfasst sein.

Bauverhandlung
§ 64. (1) Über das Bauansuchen ist zu verhandeln.

Artikel 5
Art. 5. Dieser Artikel tritt in Kraft.
"""


class TestSplitting:
    def test_each_paragraph_becomes_one_section_in_document_order(self):
        sections = split_sections(_LAW)

        assert [(s.kind, s.number) for s in sections] == [("§", "63"), ("§", "64"), ("Art", "5")]

    def test_a_section_carries_the_heading_above_it(self):
        assert split_sections(_LAW)[0].heading == "Bauansuchen"

    def test_a_sentence_above_a_section_is_not_mistaken_for_a_heading(self):
        text = "Dies ist ein ganzer Satz.\n§ 1. Der Inhalt."

        assert split_sections(text)[0].heading == ""

    def test_a_bare_artikel_line_above_a_section_is_not_a_second_section(self):
        """ "Artikel 5" as a heading matches the same grammar as "Art. 5." — a
        marker with no text under it is a heading, not a provision."""
        sections = split_sections("Artikel 5\nArt. 5. Dieser Artikel tritt in Kraft.")

        assert len(sections) == 1
        assert "tritt in Kraft" in sections[0].body

    def test_a_document_with_no_paragraphs_splits_into_nothing(self):
        """A court decision has no § grammar — the caller then returns it whole."""
        assert split_sections("Der Verwaltungsgerichtshof hat entschieden: …") == []

    def test_a_section_body_runs_to_the_next_section_and_no_further(self):
        """The next section's Überschrift stays in the previous body on purpose:
        guessing wrong about a heading must not DELETE text a citation rests on.
        The next section's own text is what must not be there."""
        body = split_sections(_LAW)[0].body

        assert "Die Baupläne" in body
        assert "ist zu verhandeln" not in body

    def test_the_header_block_before_each_section_is_folded_into_it(self):
        """RIS prints ``§ 63`` / ``Text`` / Überschrift, then ``§ 63.`` and the text."""
        text = (
            "§ 63\n\nText\n\nBelege für das Baubewilligungsverfahren\n"
            "§ 63.\n(1)\nFür das Baubewilligungsverfahren hat der Bauwerber vorzulegen:\n"
            "§ 64\n\nText\n\nBaupläne\n§ 64.\n(1) Die Baupläne haben zu enthalten:"
        )
        sections = split_sections(text)
        assert [s.label for s in sections] == ["§ 63", "§ 64"]
        assert sections[0].heading == "Belege für das Baubewilligungsverfahren"
        assert "hat der Bauwerber vorzulegen" in sections[0].body

    def test_a_sentence_opening_with_a_cross_reference_starts_nothing(self):
        text = "§ 65.\n(1) Baupläne müssen unterfertigt sein.\n§ 66.\n(1) Anderes.\n§ 65 Abs. 2 gilt sinngemäß."
        sections = split_sections(text)
        assert [s.label for s in sections] == ["§ 65", "§ 66"]
        assert sections[1].body.endswith("§ 65 Abs. 2 gilt sinngemäß.")

    def test_a_table_of_contents_entry_is_not_a_second_section(self):
        """The Tiroler Bauordnung opens with its §§ listed, far from § 8 itself."""
        text = (
            "§ 7\nAbstellmöglichkeiten für Fahrräder\n§ 8\nAbstellmöglichkeiten für Kraftfahrzeuge\n"
            "§ 7\nAbstellmöglichkeiten für Fahrräder\n(1) Beim Neubau sind Fahrradabstellplätze zu schaffen.\n"
            "§ 8\nAbstellmöglichkeiten für Kraftfahrzeuge\n(1) Beim Neubau von Gebäuden sind Stellplätze zu schaffen."
        )
        sections = split_sections(text)
        assert [s.label for s in sections] == ["§ 7", "§ 8"]
        assert "Stellplätze zu schaffen" in sections[1].body
        # The heading under the marker, not the table of contents' previous entry.
        assert sections[1].heading == "Abstellmöglichkeiten für Kraftfahrzeuge"

    def test_an_absatz_under_the_marker_is_not_a_heading(self):
        assert split_sections("Dies ist Text.\n§ 1.\n(1)\nDer Inhalt.")[0].heading == ""


class TestAbsaetze:
    def test_the_named_absatz_is_cut_out_of_the_section(self):
        section = split_sections(_LAW)[0]

        body, absatz = absatz_body(section, "2")

        assert absatz == "2"
        assert body.startswith("(2) Die Baupläne")
        assert "Nachweis des Eigentums" not in body

    def test_the_run_in_first_absatz_is_found_too(self):
        """RIS writes "§ 63. (1) Dem …" on one line — Abs 1 has no line of its own."""
        body, absatz = absatz_body(split_sections(_LAW)[0], "1")

        assert absatz == "1"
        assert "Nachweis des Eigentums" in body
        assert "Die Baupläne" not in body

    def test_an_absatz_the_section_does_not_have_returns_the_whole_section(self):
        """Never an empty passage, and never the wrong Absatz."""
        body, absatz = absatz_body(split_sections(_LAW)[0], "9")

        assert absatz == ""
        assert "Nachweis des Eigentums" in body


class TestCutting:
    def test_a_short_passage_is_returned_untouched(self):
        assert cut_on_absatz("(1) Kurz.") == "(1) Kurz."

    def test_a_long_passage_is_cut_on_an_absatz_boundary(self):
        text = "\n".join(f"({index}) " + "Wort " * 120 for index in range(1, 12))

        cut = cut_on_absatz(text)

        assert len(cut) <= PASSAGE_MAX_CHARS + len("... [truncated]")
        assert cut.endswith("... [truncated]")
        # The cut landed between Absätze: no Absatz is half-present.
        kept = cut.removesuffix("... [truncated]")
        assert kept.count("(") == kept.count(")")

    def test_one_enormous_absatz_still_gets_cut(self):
        """The boundary is preferred, not required — a 900 kB single Absatz
        must not reach the transcript because no boundary was available."""
        cut = cut_on_absatz("(1) " + "Wort " * 200_000)

        assert len(cut) <= PASSAGE_MAX_CHARS + len("... [truncated]")


class TestTheIndex:
    def test_the_index_is_id_plus_heading_per_paragraph(self):
        index = headings_index(split_sections(_LAW))

        assert "§ 63 — Bauansuchen" in index
        assert "§ 64 — Bauverhandlung" in index

    def test_a_long_law_says_that_its_index_was_cut(self):
        sections = split_sections("\n".join(f"§ {n}. Der Inhalt." for n in range(1, 200)))

        index = headings_index(sections)

        assert "index truncated" in index
