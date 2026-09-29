"""Heading-aware chunking of tenant PDFs (``llamaindex/section_chunking``).

Before it, every PDF that was not an OIB Richtlinie became one Document per page, cut
by ``SentenceSplitter(1024/128)``: a section beginning at the foot of a page was split
from its body, the overlap never crossed a page, and one window blended several
requirements. These tests pin the three things that can go wrong with a structure-aware
chunker: cutting on something that is not a heading (a list item, ``1.200 m²``, a
running footer), cutting a document that has no real structure (the fallback gates),
and losing the page a chunk cites.

The PDFs are hand-built with real fonts and sizes (``pdf_fixtures``), so the heading
detector reads the same pdfplumber characters it reads in production.
"""

from __future__ import annotations

from typing import Any

import pytest
from knowledge_layer.llamaindex import section_chunking as sc
from knowledge_layer.llamaindex.adapter import _extract_text_from_pdf
from knowledge_layer.llamaindex.adapter import text_documents_for_pages
from knowledge_layer.llamaindex.section_chunking import Line

from tests.knowledge_layer_tests.pdf_fixtures import body_lines
from tests.knowledge_layer_tests.pdf_fixtures import brandschutzkonzept_pages
from tests.knowledge_layer_tests.pdf_fixtures import footer
from tests.knowledge_layer_tests.pdf_fixtures import write_pdf

FILE = "brandschutzkonzept_musterstrasse.pdf"


def _pages_of(path) -> list[dict[str, Any]]:
    extracted = _extract_text_from_pdf(str(path))
    return list(getattr(extracted, "pages", extracted))


@pytest.fixture
def konzept(tmp_path) -> list[Any]:
    pages = _pages_of(write_pdf(tmp_path / FILE, brandschutzkonzept_pages()))
    return text_documents_for_pages(pages, FILE, 1234)


def _by_punkt(docs: list[Any]) -> dict[str, list[Any]]:
    grouped: dict[str, list[Any]] = {}
    for doc in docs:
        grouped.setdefault(doc.metadata.get("punkt_id", ""), []).append(doc)
    return grouped


class TestPdfSections:
    def test_extraction_records_font_size_and_weight_per_line(self, tmp_path):
        pages = _pages_of(write_pdf(tmp_path / FILE, brandschutzkonzept_pages()))
        styles = {text: (size, bold) for text, size, bold in pages[0]["line_styles"]}
        assert styles["1 Allgemeines"] == (14.0, 1.0)
        assert styles["1.1 Gebäudebeschreibung"] == (12.0, 1.0)
        assert styles[pages[0]["text"].splitlines()[1]][1] == 0.0

    def test_a_page_whose_styles_cannot_be_read_keeps_its_text(self, tmp_path, monkeypatch):
        """Styles are read inside the per-page reader, where a raise counts the page as
        unreadable and drops its text. They are optional: the page keeps its text and
        has no styles, and its headings are then read from the numbering alone."""
        import pdfplumber.page

        def _broken(self, *args, **kwargs):
            raise ValueError("malformed font descriptor")

        monkeypatch.setattr(pdfplumber.page.Page, "extract_text_lines", _broken)
        extracted = _extract_text_from_pdf(str(write_pdf(tmp_path / FILE, brandschutzkonzept_pages())))

        assert [page["page_number"] for page in extracted] == [1, 2, 3]
        assert getattr(extracted, "failed_pages", []) == []
        assert all(page["line_styles"] == [] for page in extracted)
        assert "1.1 Gebäudebeschreibung" in extracted[0]["text"]
        sections = _by_punkt(text_documents_for_pages(list(extracted), FILE, 1))
        assert {"1.1", "1.2", "2.1", "§ 3"} <= set(sections)

    def test_a_malformed_char_does_not_raise_either(self):
        class _Page:
            def extract_text_lines(self, return_chars=True):
                return [{"text": "1 Allgemeines", "chars": [{"text": "1", "size": "groß"}]}]

        assert sc.extract_line_styles(_Page()) == []

    def test_every_heading_becomes_an_addressable_section(self, konzept):
        sections = _by_punkt(konzept)
        assert {"1", "1.1", "1.2", "2", "2.1", "§ 3"} <= set(sections)
        assert all(doc.metadata["chunking"] == "section" for doc in konzept)

    def test_chunks_carry_the_heading_breadcrumb(self, konzept):
        first = _by_punkt(konzept)["1.1"][0]
        assert first.text.startswith(
            "Brandschutzkonzept Wohnanlage Musterstraße › 1 Allgemeines › 1.1 Gebäudebeschreibung\n\n"
        )
        assert first.metadata["punkt_path"].endswith("1 Allgemeines › 1.1 Gebäudebeschreibung")
        assert first.metadata["punkt_depth"] == 2

    def test_a_section_spans_pages_and_its_page_label_stays_numeric(self, konzept):
        parts = _by_punkt(konzept)["1.1"]
        assert parts[0].metadata["page_label"] == "1"
        assert parts[-1].metadata["page_end"] == "2"
        assert all(doc.metadata["page_label"].isdigit() for doc in konzept)
        spanning = [doc for doc in parts if doc.metadata["page_label"] != doc.metadata["page_end"]]
        assert spanning, "no chunk crosses the page break inside section 1.1"
        assert "Satz 1.1a-30" in spanning[0].text and "Satz 1.1b-01" in spanning[0].text

    def test_long_sections_are_cut_with_overlap(self, konzept):
        parts = _by_punkt(konzept)["1.1"]
        assert len(parts) >= 2
        assert [doc.metadata["section_part"] for doc in parts] == list(range(1, len(parts) + 1))
        last_line = parts[0].text.splitlines()[-1]
        assert last_line in parts[1].text, "the next chunk does not repeat the tail of the previous"

    def test_a_thousands_number_is_not_a_heading(self, konzept):
        rechtsgrundlagen = "\n".join(doc.text for doc in _by_punkt(konzept)["1.2"])
        assert "1.200 m² Netto-Grundfläche" in rechtsgrundlagen

    def test_a_bare_paragraph_sign_takes_its_title_from_the_next_line(self, konzept):
        paragraph = _by_punkt(konzept)["§ 3"][0]
        assert paragraph.metadata["punkt_title"] == "Fluchtwege"
        assert "Fluchtwege" not in paragraph.text.split("\n\n", 1)[1]

    def test_the_running_footer_is_not_indexed(self, konzept):
        assert not any("Seite 2" in doc.text for doc in konzept)

    def test_an_oib_file_keeps_the_per_page_path(self, tmp_path):
        """The base corpus's non-Punkt files (glossary, list of standards) are not re-cut."""
        name = "oib-rl_begriffsbestimmungen_ausgabe_mai_2023.pdf"
        glossary = [[("B", 14, f"Begriff {n.upper()}"), *body_lines(n, 5)] for n in "abcd"]
        pages = _pages_of(write_pdf(tmp_path / name, [[*glossary[0], *glossary[1]], glossary[2], glossary[3]]))
        assert sc.section_documents(pages, name, 1) is not None, "the sample must be sectionable"
        docs = text_documents_for_pages(pages, name, 1)
        assert [doc.metadata["page_label"] for doc in docs] == ["1", "2", "3"]
        assert "chunking" not in docs[0].metadata

    def test_a_document_without_headings_keeps_the_per_page_path(self, tmp_path):
        plain = [[*body_lines(f"p{page}", 20), footer(page)] for page in (1, 2, 3)]
        pages = _pages_of(write_pdf(tmp_path / "brief.pdf", plain))
        docs = text_documents_for_pages(pages, "brief.pdf", 1)
        assert [doc.metadata["page_label"] for doc in docs] == ["1", "2", "3"]
        assert "punkt_id" not in docs[0].metadata


def _line(text: str, size: float = 10.0, bold: bool = False, position: int = 1) -> Line:
    return Line(position, text, size, bold)


class TestHeadingRecognition:
    @pytest.mark.parametrize(
        ("text", "size", "bold", "expected"),
        [
            ("3.2 Brandabschnitte", 10.0, False, ("3.2", "Brandabschnitte")),
            ("§ 4 Begriffe", 10.0, False, ("§ 4", "Begriffe")),
            ("Artikel 12: Inkrafttreten", 10.0, False, ("Artikel 12", "Inkrafttreten")),
            ("Anhang A Nachweise", 10.0, False, ("Anhang A", "Nachweise")),
            ("1 Allgemeines", 10.0, True, ("1", "Allgemeines")),
            ("Zusammenfassung", 14.0, False, ("", "Zusammenfassung")),
            ("Hinweise zur Ausführung", 10.0, True, ("", "Hinweise zur Ausführung")),
        ],
    )
    def test_headings(self, text, size, bold, expected):
        assert sc.classify(_line(text, size, bold), 10.0) == expected

    @pytest.mark.parametrize(
        ("text", "size", "bold"),
        [
            # A list item: a bare number in body type.
            ("1 Stück Brandschutztür liefern", 10.0, False),
            # German thousands separator.
            ("1.200 m² Netto-Grundfläche je Geschoß", 10.0, False),
            # A sentence, even in bold.
            ("Die Wände sind in REI 90 auszuführen.", 10.0, True),
            # Smaller than the body: a footnote or caption.
            ("Quelle", 8.0, True),
            # A contents-page entry.
            ("3.2 Brandabschnitte ........ 7", 10.0, False),
            ("2.1 im obersten Geschoß", 10.0, False),
        ],
    )
    def test_non_headings(self, text, size, bold):
        assert sc.classify(_line(text, size, bold), 10.0) is None

    def test_without_font_information_a_bare_number_counts(self):
        """An OCR text layer has no styles; its numbering is all there is."""
        assert sc.classify(Line(1, "1 Allgemeines"), None) == ("1", "Allgemeines")

    def test_a_heading_wrapped_over_two_lines_is_one_heading(self):
        lines = [_line("Brandschutzkonzept für die", 16.0), _line("Wohnanlage Musterstraße", 16.0)]
        lines += [_line(f"Text {n} über die Anlage.") for n in range(10)]
        headings = sc.find_headings(lines)
        assert list(headings) == [0]
        assert headings[0].title == "Brandschutzkonzept für die Wohnanlage Musterstraße"
        assert headings[0].span == 2

    def test_levels_follow_numbering_and_font_rank(self):
        lines = [
            _line("Titel", 18.0),
            _line("1 Kapitel", 14.0, True),
            _line("1.1 Abschnitt", 10.0, True),
            _line("Randbemerkung", 10.0, True),
            *[_line(f"Satz {n} im Text.") for n in range(20)],
        ]
        levels = {heading.label: heading.level for heading in sc.find_headings(lines).values()}
        # The title is level 0: every chapter nests under it rather than closing it.
        assert levels == {"Titel": 0, "1 Kapitel": 1, "1.1 Abschnitt": 2, "Randbemerkung": 2}

    def test_repeated_addresses_are_disambiguated(self):
        lines = []
        for chapter in ("Brandschutz", "Schallschutz"):
            lines += [_line(chapter, 14.0), _line("Allgemeines", 12.0), *[_line("Text.") for _ in range(8)]]
        sections = sc.build_sections(lines, sc.find_headings(lines))
        locators = [section.locator for section in sections if section.heading]
        assert locators == ["Brandschutz", "Brandschutz › Allgemeines", "Schallschutz", "Schallschutz › Allgemeines"]


WRAPPED_SENTENCES = [
    "§ 60 Abs. 1 lit. a BO wird nach Maßgabe der mit dem amtlichen",
    "Anlage 3 wird zum Bestandteil dieses Bescheides erklärt und ist",
    "3.2 Die Brandabschnitte sind mit Wänden in REI 90 herzustellen",
    "1. Die Fluchtwege im Erdgeschoß sind mit einer lichten Breite von",
]


class TestWrappedSentencesAreNotHeadings:
    """A body line that happens to open with a locator is a sentence, styled or not."""

    @pytest.mark.parametrize("text", WRAPPED_SENTENCES)
    def test_in_body_type(self, text):
        assert sc.classify(_line(text), 10.0) is None

    @pytest.mark.parametrize("text", WRAPPED_SENTENCES)
    def test_without_font_information(self, text):
        assert sc.classify(Line(1, text), None) is None

    def test_a_line_running_on_into_a_lowercase_line_is_not_a_heading(self):
        assert sc.classify(_line("3.2 Brandabschnitte"), 10.0, _line("sind in REI 90 herzustellen.")) is None
        assert sc.classify(Line(1, "§ 4 Fluchtwege"), None, Line(1, "gemäß OIB-Richtlinie 2.")) is None

    def test_a_bold_heading_wrapped_in_its_own_type_still_counts(self):
        heading = _line("3.2 Anforderungen an die", 10.0, True)
        assert sc.classify(heading, 10.0, _line("baulichen Brandschutzmaßnahmen", 10.0, True)) == (
            "3.2",
            "Anforderungen an die",
        )

    def test_a_short_title_in_body_type_is_still_a_heading(self):
        assert sc.classify(_line("3.2 Brandabschnitte"), 10.0, _line("Die Wände sind in REI 90.")) == (
            "3.2",
            "Brandabschnitte",
        )

    def test_unstyled_auflagen_are_not_cut_into_sections(self):
        lines = []
        for number in range(1, 7):
            lines += [
                Line(1, f"{number}. Die Türen im Geschoß {number} sind selbstschließend und in"),
                Line(1, "EI2 30-C auszuführen; der Nachweis ist vor Baubeginn vorzulegen."),
            ]
        assert sc.find_headings(lines) == {}

    @pytest.mark.parametrize(
        ("text", "number"),
        [("§3 Begriffe", "§ 3"), ("§  3 Begriffe", "§ 3"), ("Art.3 Geltungsbereich", "Art. 3"), ("§ 3a Zweck", "§ 3a")],
    )
    def test_legal_locators_have_one_spelling(self, text, number):
        assert sc.classify(_line(text, 10.0, True), 10.0) == (number, text.split()[-1])


def _transcribed_pages() -> list[dict[str, Any]]:
    """Three transcribed pages; each body line differs in words, not only in numbers (running-footer check)."""
    words = ["Fluchtweg", "Brandwand", "Stiegenhaus", "Rauchabzug", "Löschwasser", "Zufahrt", "Türen", "Decken"]

    def body(page: int) -> str:
        return "\n".join(f"Die Auflage zu {word} {page} ist vor Baubeginn nachzuweisen." for word in words)

    return [
        {"page_number": 1, "text": "# Baubescheid\n\n## 1 Befund\n" + body(1)},
        {"page_number": 2, "text": body(2) + "\n## 2 Auflagen\n" + body(3)},
        {"page_number": 3, "text": "### 2.1 Brandschutz\n" + body(4)},
    ]


class TestTranscribedMarkdownPages:
    def test_atx_lines_are_headings_at_their_hash_level(self):
        headings = sc.find_headings(sc.document_lines(_transcribed_pages()))
        assert [(h.label, h.level) for h in headings.values()] == [
            ("Baubescheid", 1),
            ("1 Befund", 2),
            ("2 Auflagen", 2),
            ("2.1 Brandschutz", 3),
        ]

    def test_sections_keep_their_pages_and_lose_the_markers(self):
        docs = sc.section_documents(_transcribed_pages(), "bescheid.pdf", 1)
        assert docs is not None
        by_punkt = _by_punkt(docs)
        assert by_punkt["1"][0].text.startswith("Baubescheid › 1 Befund\n\n")
        assert by_punkt["1"][0].metadata["page_label"] == "1"
        assert by_punkt["1"][-1].metadata["page_end"] == "2"
        assert by_punkt["2.1"][0].metadata["page_label"] == "3"
        assert not any(line.startswith("#") for doc in docs for line in doc.text.splitlines())

    def test_a_hash_on_a_styled_pdf_line_is_text(self):
        page = {"page_number": 1, "text": "# 3 Stück", "line_styles": [["# 3 Stück", 10.0, 0.0]]}
        assert [line.text for line in sc.document_lines([page])] == ["# 3 Stück"]


def _stream(headings: int, body_per_section: int, preamble: int = 0) -> list[Line]:
    lines = [_line(f"Einleitung Satz {n}.") for n in range(preamble)]
    for index in range(headings):
        lines.append(_line(f"Kapitel {index + 1}", 14.0))
        lines += [_line(f"Inhalt {index}-{n} mit Text.") for n in range(body_per_section)]
    return lines


class TestFallbackGates:
    """``structure_is_usable``: each gate on its own, at its threshold."""

    def _usable(self, lines: list[Line]) -> bool:
        return sc.structure_is_usable(lines, sc.build_sections(lines, sc.find_headings(lines)))

    def test_three_headings_with_body_are_usable(self):
        assert self._usable(_stream(sc.MIN_HEADINGS, 5))

    def test_fewer_headings_than_the_minimum_are_not(self):
        assert not self._usable(_stream(sc.MIN_HEADINGS - 1, 5))

    def test_headings_covering_too_little_of_the_text_are_not(self):
        # Three short sections after a long unheaded preamble: under half the text is sectioned.
        assert not self._usable(_stream(3, 2, preamble=40))

    def test_mostly_headings_is_a_form_not_an_outline(self):
        # One body line per heading: half the lines are headings, above the share cap.
        assert sc.MAX_HEADING_LINE_SHARE < 0.5
        assert not self._usable(_stream(6, 1))


class TestPacking:
    def test_chunks_respect_the_budget_and_overlap(self):
        lines = [Line(n // 10 + 1, f"Satz {n} mit einigen Worten Inhalt.") for n in range(60)]
        count = lambda text: len(text.split())  # noqa: E731 - a test tokenizer
        chunks = sc.pack(lines, count, budget=60, overlap=12)
        assert len(chunks) > 3
        for chunk, carried in chunks:
            assert sum(count(line.text) + 1 for line in chunk[carried:]) <= 60
        for (previous, _), (following, carried) in zip(chunks, chunks[1:], strict=False):
            assert carried and following[:carried] == previous[-carried:]

    def test_a_chunk_ends_on_a_sentence_where_one_is_near(self):
        lines = [
            Line(1, "Erster Satz geht"),
            Line(1, "weiter und endet."),
            Line(1, "Zweiter Satz ohne"),
            Line(1, "Ende"),
        ]
        count = lambda text: len(text.split())  # noqa: E731
        chunks = sc.pack(lines, count, budget=8, overlap=0)
        assert chunks[0][0][-1].text == "weiter und endet."


class TestUncaptionedTables:
    def test_row_groups_repeat_the_header(self):
        cells = [["Raum", "Fläche", "Nutzung"], *[[f"R{n}", f"{n},5 m²", "Büro mit Besprechung"] for n in range(120)]]
        table = {"page_number": 4, "table_index": 0, "rows": 121, "cols": 3, "table_text": "", "cells": cells}
        docs = sc.uncaptioned_table_documents(table, "plan.pdf", 1)
        assert len(docs) > 1
        assert all("| Raum | Fläche | Nutzung |" in doc.text for doc in docs)
        assert [doc.metadata["table_part"] for doc in docs] == list(range(1, len(docs) + 1))
        assert all(doc.metadata["page_label"] == "4" for doc in docs)
        body = "".join(doc.text for doc in docs)
        assert all(f"| R{n} |" in body for n in range(120))
        assert "table_part" in docs[0].excluded_embed_metadata_keys

    def test_a_table_without_raw_cells_stays_one_document(self):
        table = {"page_number": 2, "table_index": 1, "rows": 2, "cols": 2, "table_text": "| a | b |"}
        docs = sc.uncaptioned_table_documents(table, "plan.pdf", 1)
        assert [doc.text for doc in docs] == ["[TABLE from page 2]\n\n| a | b |"]
