# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Tests for the card generation prompt builder."""

from aiq_agent.cards.prompt import build_card_generation_prompt


class TestBuildCardGenerationPrompt:
    """Tests for build_card_generation_prompt."""

    def test_returns_string(self):
        prompt = build_card_generation_prompt()
        assert isinstance(prompt, str)

    def test_contains_all_card_type_names(self):
        prompt = build_card_generation_prompt()
        assert "SummaryCard" in prompt
        assert "LegalBasisCard" in prompt

    def test_contains_each_card_type_description(self):
        prompt = build_card_generation_prompt()
        assert "concise overview" in prompt
        assert "legal norm" in prompt.lower()

    def test_contains_field_descriptions(self):
        prompt = build_card_generation_prompt()
        assert "Short title for the summary card" in prompt
        assert "Name of the law, regulation, or OIB Richtlinie" in prompt

    def test_mentions_cards_object_wrapper_and_schema(self):
        prompt = build_card_generation_prompt()
        # The object wrapper must match the structured-output response_format
        # schema, which requires an object root ({"cards": [...]}).
        assert '{"cards":' in prompt
        assert "JSON Schema" in prompt
