# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for Grid card models."""

import pytest

from aiq_agent.cards.models import validate_cards


class TestValidateCards:
    """Tests for validate_cards."""

    def test_accepts_valid_summary_dict(self):
        raw = [{"type": "summary", "title": "Summary title", "content": "Summary content"}]
        result = validate_cards(raw)
        assert result == raw

    def test_accepts_valid_legal_basis_dict(self):
        raw = [{"type": "legal_basis", "law": "OIB Richtlinie 1"}]
        result = validate_cards(raw)
        assert result == raw

    def test_rejects_unknown_card_type(self):
        raw = [{"type": "unknown_type", "title": "Unknown"}]
        with pytest.raises(Exception):
            validate_cards(raw)

    def test_rejects_missing_required_field(self):
        raw = [{"type": "summary"}]
        with pytest.raises(Exception):
            validate_cards(raw)

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
