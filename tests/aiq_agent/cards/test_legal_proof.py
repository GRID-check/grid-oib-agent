"""The server's check of a ``legal_basis`` card's wording (``cards/legal_proof.py``).

The card says "wörtlich belegt" off this stamp and nothing else, so the
assertions are about which claims it can and cannot make: a wording a passage
holds is located, one no passage holds is not, nothing to check against says
nothing, and the model cannot write the stamp itself.
"""

from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.legal_proof import prove_card
from aiq_agent.cards.legal_proof import verification_for
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.common.citation_verification import SourceEntry

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


def _card(**overrides):
    return {"type": "legal_basis", "law": "OIB-Richtlinie 2", "original_text": QUOTE, **overrides}


class TestTheStamp:
    def test_a_wording_a_cited_passage_holds_is_located_with_its_number(self):
        stamp = verification_for(QUOTE, [(_entry(), 2)], [])
        assert stamp["status"] == "verbatim"
        assert stamp["number"] == 2
        assert stamp["file_name"] == "OIB-RL_2_2023.pdf"
        assert stamp["page"] == 14
        assert stamp["punkt"] == "3.1.1"

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
        # „höchstens 1.500 m²" is a different rule, not a noisy copy of this one.
        altered = QUOTE.replace("1.200", "1.500").replace("höchstens 60", "mindestens 60")
        assert verification_for(altered, [(_entry(), 1)], [])["status"] == "not_found"

    def test_an_invented_wording_is_not_found(self):
        invented = "Jeder Brandabschnitt ist durch Brandwände in REI 90 von den anderen zu trennen."
        assert verification_for(invented, [(_entry(), 1)], []) == {"status": "not_found"}

    def test_nothing_to_check_against_says_nothing(self):
        # A web-only turn has no passage text: unchecked, never verbatim.
        assert verification_for(QUOTE, [(_entry(chunk=None), 1)], []) == {"status": "unchecked"}
        assert verification_for(QUOTE, [], []) == {"status": "unchecked"}

    def test_a_card_without_wording_or_with_a_fragment_is_unchecked(self):
        assert verification_for(None, [(_entry(), 1)], []) == {"status": "unchecked"}
        assert verification_for("1.200 m²", [(_entry(), 1)], []) == {"status": "unchecked"}


class TestProveCard:
    def test_it_stamps_a_legal_basis_card(self):
        proved = prove_card(_card(), [(_entry(), 1)], [])
        assert proved["verification"]["status"] == "verbatim"

    def test_it_leaves_any_other_card_as_it_is(self):
        card = {"type": "summary", "title": "x"}
        assert prove_card(card, [(_entry(), 1)], []) is card

    def test_it_stamps_a_legal_basis_leaf_inside_a_surface(self):
        surface = {
            "type": "surface",
            "components": [
                {"id": "root", "component": "Column", "children": ["a"]},
                {"id": "a", "component": "legal_basis", "law": "OIB-Richtlinie 2", "original_text": QUOTE},
            ],
        }
        proved = prove_card(surface, [(_entry(), 3)], [])
        assert proved["components"][1]["verification"]["number"] == 3
        assert "verification" not in proved["components"][0]


class TestTheModelCannotWriteTheStamp:
    def test_the_validator_discards_a_stamp_the_model_wrote(self):
        forged = _card(verification={"status": "verbatim", "number": 1, "page": 14})
        validated = grid_card_adapter.validate_python(forged).model_dump(exclude_none=True)
        assert "verification" not in validated

    def test_the_stamp_is_not_in_any_shape_the_model_reads(self):
        assert "verification" not in render_card_details(["legal_basis"])
        assert "LegalBasisVerification" not in render_card_catalog()

    def test_the_proof_fields_are(self):
        detail = render_card_details(["legal_basis"])
        for field in ("facts: [LegalBasisFact]", "conclusion: string", "outcome:"):
            assert field in detail
        assert "The card is a PROOF" in detail


class TestTheProofFields:
    def test_a_full_proof_validates(self):
        card = _card(
            facts=[{"label": "Gebäudeklasse", "value": "GK 4", "origin": "Projektprofil"}],
            conclusion="Ein Brandabschnitt genügt.",
            outcome="pass",
        )
        validated = grid_card_adapter.validate_python(card).model_dump(exclude_none=True)
        assert validated["facts"][0]["origin"] == "Projektprofil"
        assert validated["outcome"] == "pass"

    def test_a_bare_citation_still_validates(self):
        validated = grid_card_adapter.validate_python({"type": "legal_basis", "law": "WBO"}).model_dump(
            exclude_none=True
        )
        assert validated == {"type": "legal_basis", "law": "WBO"}
