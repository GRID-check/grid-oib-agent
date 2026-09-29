"""The server's stamp on each quote line ``> „…“ [N]`` (``common/quote_stamps.py``).

The excerpt says „Wortlaut belegt [N]" off this stamp and nothing else, so the
assertions are about which claims it can and cannot make: a wording a passage
holds is located, one no passage holds is not, a fragment or nothing to check
against says nothing, and the passage the line cites wins a tie.
"""

from __future__ import annotations

from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.quote_stamps import quote_lines
from aiq_agent.common.quote_stamps import stamp_quote_lines
from aiq_agent.common.quote_stamps import verification_for

PASSAGE = (
    "3.1.1 Brandabschnitte dürfen eine Nettogrundfläche von höchstens 1.200 m² und eine "
    "Längenausdehnung von höchstens 60 m aufweisen. Abweichend davon gilt Tabelle 1a."
)
QUOTE = (
    "Brandabschnitte dürfen eine Nettogrundfläche von höchstens 1.200 m² und eine "
    "Längenausdehnung von höchstens 60 m aufweisen."
)


def _entry(chunk: str | None = PASSAGE, key: str = "OIB-RL_2_2023.pdf, p. 14") -> SourceEntry:
    return SourceEntry(citation_key=key, title="OIB-Richtlinie 2", chunk_text=chunk, punkt="3.1.1")


class TestTheStamp:
    def test_a_wording_a_cited_passage_holds_is_located_with_its_number(self):
        stamp = verification_for(QUOTE, [(_entry(), 2)], [])
        assert stamp["status"] == "verbatim"
        assert stamp["number"] == 2
        assert stamp["file_name"] == "OIB-RL_2_2023.pdf"
        assert stamp["page"] == 14
        assert stamp["punkt"] == "3.1.1"
        assert stamp["title"] == "OIB-Richtlinie 2"

    def test_a_passage_read_but_not_cited_still_proves_it_without_a_number(self):
        stamp = verification_for(QUOTE, [], [_entry()])
        assert stamp["status"] == "verbatim"
        assert "number" not in stamp

    def test_the_cited_passage_wins_over_a_read_one_holding_the_same_sentence(self):
        read = _entry(key="Kopie.pdf, p. 3")
        cited = _entry()
        stamp = verification_for(QUOTE, [(cited, 1)], [read, cited])
        assert stamp["file_name"] == "OIB-RL_2_2023.pdf"
        assert stamp["number"] == 1

    def test_a_changed_word_is_not_verbatim(self):
        altered = QUOTE.replace("1.200", "1.500").replace("höchstens 60", "mindestens 60")
        assert verification_for(altered, [(_entry(), 1)], [])["status"] == "not_found"

    def test_an_invented_wording_is_not_found(self):
        invented = "Jeder Brandabschnitt ist durch Brandwände in REI 90 von den anderen zu trennen."
        assert verification_for(invented, [(_entry(), 1)], []) == {"status": "not_found"}

    def test_nothing_to_check_against_says_nothing(self):
        assert verification_for(QUOTE, [(_entry(chunk=None), 1)], []) == {"status": "unchecked"}
        assert verification_for(QUOTE, [], []) == {"status": "unchecked"}

    def test_a_short_span_is_unchecked(self):
        # „1.200 m²" matches half the corpus: the prose check skips it too.
        assert verification_for("1.200 m²", [(_entry(), 1)], []) == {"status": "unchecked"}
        assert verification_for(None, [(_entry(), 1)], []) == {"status": "unchecked"}

    def test_decisive_marks_are_the_models_not_the_sources(self):
        marked = QUOTE.replace("höchstens 1.200 m²", "==höchstens 1.200 m²==")
        assert verification_for(marked, [(_entry(), 1)], [])["status"] == "verbatim"


class TestQuoteLines:
    def test_every_quote_line_outside_code_in_order(self):
        text = (
            f"Die Antwort [1].\n\n> „{QUOTE}“ [1]\n\n"
            "```\n> „Nur Code, kein Zitat, auch wenn es lang genug ist.“ [2]\n```\n\n"
            ":::subsumption\n> »Die zweite Stelle, in Guillemets gesetzt.« [2] [3]\n- Fakt\n:::\n\n"
            "Ein „Zitat im Fließtext“ ist keine Zitatzeile."
        )
        assert list(quote_lines(text)) == [
            (QUOTE, (1,)),
            ("Die zweite Stelle, in Guillemets gesetzt.", (2, 3)),
        ]

    def test_the_unverified_marker_after_the_quote_does_not_hide_it(self):
        text = f"> „{QUOTE}“ [nicht wörtlich in der Quelle belegt] [4]"
        assert list(quote_lines(text)) == [(QUOTE, (4,))]


class TestStampQuoteLines:
    def test_one_stamp_per_line_in_document_order(self):
        invented = "Jeder Brandabschnitt ist durch Brandwände in REI 90 von den anderen zu trennen."
        text = f"> „{QUOTE}“ [1]\n\nDazu:\n\n> „{invented}“ [1]\n\n> „GK 4“ [1]"
        stamps = stamp_quote_lines(text, [(_entry(), 1)], [])
        assert [stamp["status"] for stamp in stamps] == ["verbatim", "not_found", "unchecked"]
        assert stamps[0]["text"] == QUOTE and stamps[0]["number"] == 1
        assert stamps[1] == {"text": invented, "status": "not_found"}

    def test_the_passage_the_line_cites_is_tried_first(self):
        # Two cited pages hold the same sentence; the line says [2], so the stamp names page 22.
        first = _entry()
        second = _entry(key="OIB-RL_2_2019.pdf, p. 22")
        stamps = stamp_quote_lines(f"> „{QUOTE}“ [2]", [(first, 1), (second, 2)], [])
        assert stamps[0]["number"] == 2 and stamps[0]["page"] == 22

    def test_an_answer_that_quotes_nothing_has_no_stamps(self):
        assert stamp_quote_lines("Nur Prosa [1].", [(_entry(), 1)], []) == []
