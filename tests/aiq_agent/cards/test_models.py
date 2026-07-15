"""Tests for Grid card models."""

from aiq_agent.cards.models import MemoryProposalCard
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.models import validate_cards


class TestMemoryProposalCard:
    """The system-emitted memory_proposal card validates and routes correctly."""

    def test_validates_with_defaults(self):
        card = MemoryProposalCard(
            type="memory_proposal",
            title="Save this finding?",
            content="The client requires all facades to be non-combustible.",
            kind="constraint",
        )
        assert card.confidence == "medium"

    def test_adapter_routes_type(self):
        raw = {
            "type": "memory_proposal",
            "title": "Save this finding?",
            "content": "The firm always uses REI 90 for GK4.",
            "kind": "preference",
            "confidence": "high",
        }
        validated = grid_card_adapter.validate_python(raw)
        assert isinstance(validated, MemoryProposalCard)
        assert validated.kind == "preference"
        assert validated.confidence == "high"

    def test_validate_cards_accepts_it(self):
        raw = [
            {
                "type": "memory_proposal",
                "title": "Save this finding?",
                "content": "The site is in a Schutzzone.",
                "kind": "derived_fact",
            }
        ]
        # The default confidence is filled in on validation.
        assert validate_cards(raw) == [{**raw[0], "confidence": "medium"}]


class TestValidateCards:
    """Tests for validate_cards.

    Contract: validation is per-item and tolerant — invalid cards are dropped
    (and logged), never raised, so one bad card can't discard a whole batch or
    fail the answer. Cards are a progressive enhancement.
    """

    def test_accepts_valid_summary_dict(self):
        raw = [{"type": "summary", "title": "Summary title", "content": "Summary content"}]
        result = validate_cards(raw)
        assert result == raw

    def test_accepts_valid_legal_basis_dict(self):
        raw = [{"type": "legal_basis", "law": "OIB Richtlinie 1"}]
        result = validate_cards(raw)
        assert result == raw

    def test_drops_unknown_card_type(self):
        raw = [{"type": "unknown_type", "title": "Unknown"}]
        assert validate_cards(raw) == []

    def test_drops_card_missing_required_field(self):
        raw = [{"type": "summary"}]
        assert validate_cards(raw) == []

    def test_keeps_valid_cards_and_drops_invalid_in_same_batch(self):
        raw = [
            {"type": "summary", "title": "Good"},
            {"type": "summary"},  # missing required title -> dropped
            {"type": "legal_basis", "law": "OIB Richtlinie 3"},
        ]
        result = validate_cards(raw)
        assert result == [
            {"type": "summary", "title": "Good"},
            {"type": "legal_basis", "law": "OIB Richtlinie 3"},
        ]

    def test_accepts_requirement_checklist(self):
        raw = [
            {
                "type": "requirement_checklist",
                "title": "Anforderungen GK 4",
                "items": [
                    {"label": "Tragende Bauteile REI 60", "status": "pass"},
                    {"label": "Zweiter Fluchtweg", "status": "needs_input"},
                ],
            }
        ]
        result = validate_cards(raw)
        assert result == raw

    def test_checklist_requires_items(self):
        raw = [{"type": "requirement_checklist", "title": "Leer", "items": []}]
        assert validate_cards(raw) == []

    def test_comparison_table_pads_and_truncates_rows(self):
        raw = [
            {
                "type": "comparison_table",
                "title": "GK 4 vs. GK 5",
                "options": ["GK 4", "GK 5"],
                "rows": [
                    {"label": "kurz", "values": ["nur GK 4"]},
                    {"label": "lang", "values": ["a", "b", "überzählig"]},
                    {"label": "highlight außerhalb", "values": ["a", "b"], "highlight_index": 5},
                ],
            }
        ]
        [card] = validate_cards(raw)
        assert card["rows"][0]["values"] == ["nur GK 4", ""]
        assert card["rows"][1]["values"] == ["a", "b"]
        # An out-of-range highlight is cleared (None) and then dropped from the dump.
        assert "highlight_index" not in card["rows"][2]

    def test_drops_none_fields(self):
        raw = [
            {
                "type": "legal_basis",
                "law": "OIB Richtlinie 2",
                "article": None,
                "section": None,
                "summary": None,
                "original_text": None,
            }
        ]
        result = validate_cards(raw)
        assert result == [{"type": "legal_basis", "law": "OIB Richtlinie 2"}]
