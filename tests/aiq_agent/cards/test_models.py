# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for Grid card models."""

from aiq_agent.cards.models import validate_cards


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
