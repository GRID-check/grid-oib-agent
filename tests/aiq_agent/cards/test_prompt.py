"""Tests for the post-hoc card generation prompt builder."""

from aiq_agent.cards.catalog import MODEL_BACKED_CARD_TYPES
from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.catalog import render_card_index
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
    """Both surfaces render from the one catalog, and differ in exactly one way.

    The rule used to be "identically". It is now "identically, except that
    post-hoc generation is not shown the cards it cannot fill" — the IFC cards
    are addressed by GlobalId, rule id and model file name, and that path is
    handed only the question and the finished answer text.
    """

    def test_the_tool_embeds_the_card_index(self):
        # The `emit_card` caller has the `ifc_query` rows in context, so it is
        # the surface that may be told about the cards those rows feed — but it
        # gets the INDEX, not every shape. Shapes cost ~5,200 tokens on every
        # turn whether or not a card is emitted; `describe_card` fetches the one
        # that is actually needed.
        description = _build_tool_description()
        assert render_card_index() in description
        assert render_card_catalog() not in description

    def test_the_tool_points_at_the_shape_lookup(self):
        # Without this pointer the model guesses the nesting and burns a turn on
        # a validation error, which costs more than the shapes it saved.
        assert "describe_card" in _build_tool_description()

    def test_post_hoc_generation_embeds_the_catalog_minus_the_model_cards(self):
        assert render_card_catalog(include_model_backed=False) in build_card_generation_prompt()

    def test_post_hoc_generation_is_not_shown_a_card_it_cannot_fill(self):
        prompt = build_card_generation_prompt()
        for card_type in MODEL_BACKED_CARD_TYPES:
            # Neither the shape nor the worked example: an example is a card
            # description too, and one left behind would advertise the exact
            # shape the surrounding text withheld.
            assert f'"{card_type}"' not in prompt, card_type
            assert f"  {card_type}:" not in prompt, card_type

    def test_the_tool_still_is(self):
        # The pair matters: withholding from BOTH surfaces would silently
        # retire five working card renderers, which is the failure this
        # feature was fixing in the first place.
        tool = _build_tool_description()
        for card_type in MODEL_BACKED_CARD_TYPES:
            assert f'"{card_type}"' in tool, card_type

    def test_the_withheld_set_is_real(self):
        # A typo here withholds nothing and reads as protection.
        from aiq_agent.cards.models import GridCard

        real = {getattr(card.model_fields["type"].annotation, "__args__", ("?",))[0] for card in GridCard.__args__}
        assert sorted(MODEL_BACKED_CARD_TYPES - real) == []
