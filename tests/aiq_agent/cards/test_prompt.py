"""Tests for the post-hoc card generation prompt builder."""

from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.prompt import build_card_generation_prompt
from aiq_agent.cards.register import _build_tool_description


class TestBuildCardGenerationPrompt:
    """Tests for build_card_generation_prompt."""

    def test_returns_string(self):
        assert isinstance(build_card_generation_prompt(), str)

    def test_contains_card_type_values(self):
        prompt = build_card_generation_prompt()
        assert '"summary"' in prompt
        assert '"legal_basis"' in prompt

    def test_contains_card_type_descriptions(self):
        prompt = build_card_generation_prompt()
        assert "concise overview" in prompt
        assert "legal norm" in prompt.lower()

    def test_expands_nested_building_blocks(self):
        # The nested shapes (the thing that made cards fail to emit when hidden)
        # must be spelled out with their field descriptions.
        prompt = build_card_generation_prompt()
        assert "DimensionCheck = {" in prompt
        assert "NormReference = {" in prompt
        assert "needs_input" in prompt

    def test_includes_worked_examples(self):
        prompt = build_card_generation_prompt()
        assert "Worked examples" in prompt
        assert "daylight_incidence" in prompt

    def test_asks_for_cards_object_wrapper(self):
        # Must match the {"cards": [...]} wrapper the tolerant parser and the
        # json_object response coalesce on.
        assert '{"cards":' in build_card_generation_prompt()

    def test_does_not_dump_raw_json_schema(self):
        # Regression: the old builder dumped the full ~42KB json schema ($defs
        # / $ref), which is expensive and worse for the model than examples.
        prompt = build_card_generation_prompt()
        assert "$defs" not in prompt
        assert "$ref" not in prompt


class TestCatalogSharedAcrossSurfaces:
    """The tool and the post-hoc prompt must describe the schema identically."""

    def test_both_surfaces_embed_the_same_catalog(self):
        catalog = render_card_catalog()
        assert catalog in build_card_generation_prompt()
        assert catalog in _build_tool_description()
