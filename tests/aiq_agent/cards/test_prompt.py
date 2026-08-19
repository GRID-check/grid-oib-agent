"""Tests for the post-hoc card generation prompt builder."""

import pytest

from aiq_agent.cards.catalog import MODEL_BACKED_CARD_TYPES
from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.catalog import render_card_doctrine
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


class TestTheDoctrineReachesThePostHocPath:
    """The trigger vocabulary must be in front of the model that builds these cards.

    This path produces cards for the LONGEST answers Grid writes, and its whole
    instruction used to be "only include a card when it adds real value" — the
    disclaimer that left fifteen diagram renderers unused until commit 6302033a
    replaced it with a trigger table on the OTHER surface. Losing it again here
    would look like nothing in a diff and would silently take the takeaway
    block, the callout and the follow-ups back out of every deep-research
    report, which is the exact regression these assertions exist to catch.
    """

    def test_the_trigger_table_is_rendered(self):
        prompt = build_card_generation_prompt()
        assert "WHEN TO EMIT ONE" in prompt
        # A sample across the table's kinds: a schematic trigger, the two
        # generic ones that fire on an ordinary answer, and the closer.
        assert "a riser, tread or stair width" in prompt
        assert "-> stair_diagram" in prompt
        assert "the two to five points the reader must leave with" in prompt
        assert "changes what the reader DOES" in prompt
        assert "-> follow_ups" in prompt

    def test_the_negative_default_survives(self):
        # The trigger table without its counterweight is an instruction to
        # decorate every report. The counterweight is now two blocks — what may
        # go on a card, and how many — and this path pays for both.
        prompt = build_card_generation_prompt()
        assert "WHEN NOT TO" in prompt
        assert "Two content cards is a turn's ceiling" in prompt
        assert "Never fabricate a field, a reference or a number" in prompt

    def test_the_volume_rule_is_stated_once_across_the_two_blocks(self):
        # This module used to close its craft block with its own copy of the
        # two-card ceiling, written before the shared doctrine carried one. Two
        # numbers a paragraph apart is how they drift; the doctrine owns it.
        prompt = build_card_generation_prompt()
        assert prompt.count("Two content cards") == 1
        assert "Two content cards is the ceiling and one is often right" not in prompt

    def test_the_follow_ups_rule_survives(self):
        prompt = build_card_generation_prompt()
        assert "follow_ups closes a subject-matter answer by default" in prompt
        assert "LAST" in prompt

    def test_both_surfaces_render_the_one_doctrine(self):
        # The pairing that keeps this from becoming a copy: neither surface
        # holds the trigger table, both render it, and the only difference is
        # the IFC triggers the post-hoc path cannot act on.
        assert render_card_doctrine() in _build_tool_description()
        assert render_card_doctrine(include_ifc_triggers=False) in build_card_generation_prompt()


class TestWhatThePostHocPathIsNotToldToDo:
    """Doctrine that is FALSE here, and what replaces it."""

    def test_the_placement_contract_is_withheld(self):
        # There is no answer being written: the runner attaches the returned
        # list to a finished report. A marker instruction here would ask the
        # model to edit text it was only shown.
        prompt = build_card_generation_prompt()
        assert "[[card:" not in prompt
        assert "WHERE IT GOES" not in prompt

    def test_ordering_replaces_it(self):
        # List order IS render order, which is the only placement this path
        # has — and the doctrine's "put it LAST" needs it to mean anything.
        prompt = build_card_generation_prompt()
        assert "in the order you list them" in prompt

    def test_describe_card_is_not_offered(self):
        # There is no tool loop here; the shapes are already inline.
        assert "describe_card" not in build_card_generation_prompt()

    def test_the_model_picker_trigger_is_withheld_but_not_its_shape(self):
        # The picker names no file and carries no id, so there is nothing in it
        # to invent and it is deliberately NOT in MODEL_BACKED_CARD_TYPES. Only
        # its TRIGGER goes: it fires on a live "show me the model" intent and
        # says to emit the card instead of writing the file names as prose,
        # which is a trade only a surface still writing the answer can make.
        prompt = build_card_generation_prompt()
        assert "ifc_model_picker" not in MODEL_BACKED_CARD_TYPES
        assert '"ifc_model_picker"' in prompt  # the shape, from the catalog
        assert "zeig mir das Modell" not in prompt
        assert "-> ifc_model_picker" not in prompt


class TestNothingOnACardWasInvented:
    """The anti-fabrication rule, which this path needs more than the other one.

    ``emit_card`` is called while the tool rows that produced the numbers are in
    context. This call is handed the question and the report text and nothing
    else, so a figure it invents is contradicted by nothing and checked by
    nothing before it reaches the card a user screenshots into a submission.
    """

    def test_the_grounding_rule_leads(self):
        prompt = build_card_generation_prompt()
        assert "WHAT A CARD MAY BE BUILT OUT OF" in prompt
        assert "traceable to a sentence in the text you were given" in prompt
        assert "never fabricate" in prompt
        assert "never estimate" in prompt
        # Before the shapes: the rule about what may go on a card has to be
        # read before the list of slots to fill.
        assert prompt.index("WHAT A CARD MAY BE BUILT OUT OF") < prompt.index("Card types:")

    def test_it_forbids_the_two_post_hoc_specific_moves(self):
        prompt = build_card_generation_prompt()
        assert "never complete a half-stated one from your own" in prompt
        assert "never sharpen a hedged statement" in prompt


class TestTheCraftThatCouldNotBeInherited:
    """`piloti-cards` applies to the answering agents; this is a bare LLM call.

    The skill body is ~2,600 tokens of German and most of it teaches the
    division of labour between a card and the prose beside it — moves that edit
    an answer this path cannot edit. What is inlined instead is the part that is
    a TEST over a finished text, which is a fraction of the cost and all of the
    applicable judgement.
    """

    def test_the_generic_cards_carry_their_test(self):
        prompt = build_card_generation_prompt()
        assert "WHICH ONE EARNS ITS PLACE" in prompt
        assert "would a reader who reads ONLY this card" in prompt  # key_takeaways
        assert "ONE headline value" in prompt  # verdict_header
        assert "A second callout" in prompt  # callout
        assert "must NAME something the report" in prompt  # follow_ups

    def test_the_three_table_shaped_cards_are_told_apart(self):
        prompt = build_card_generation_prompt()
        for card_type in ("condition_tree", "typed_table", "comparison_table"):
            assert card_type in prompt
        assert "what the reader does with the rows" in prompt

    def test_the_skill_body_itself_is_not_inlined(self):
        # Inlining it would add a third to the prompt to teach moves this path
        # cannot make. Two of its headings, as a canary.
        prompt = build_card_generation_prompt()
        assert "Welche Karte eine gewöhnliche Antwort besser macht" not in prompt
        assert "Löschen Sie gedanklich alle Karten" not in prompt


class TestTheFramingStaysAffordable:
    """A ceiling on everything this builder adds AROUND the shared catalog.

    The catalog is the bulk of this prompt (~6,850 tokens) and grows ~190 per
    card type we add — real, but it is the schema, it is measured by the shapes
    themselves, and capping the total here would fail on catalog growth while
    saying nothing about this file. What drifts in THIS module is prose: the
    grounding rule, the craft block and the ordering note, which went from 122
    tokens (a single disclaimer sentence) to roughly 1,300 in one commit and
    would go on accreting a paragraph at a time if nothing watched.

    This is the post-hoc twin of the ``emit_card`` ceiling in
    ``test_tool_description.py``. The budgets are different on purpose: that one
    is paid on every turn of every conversation, this one once per finished
    deep-research report, so it can afford more — but not without a decision.
    """

    #: cl100k_base tokens, catalog excluded. Measured at 1,318 when written.
    MAX_FRAMING_TOKENS = 1_700

    def test_the_framing_stays_under_the_ceiling(self):
        tiktoken = pytest.importorskip("tiktoken")
        encoding = tiktoken.get_encoding("cl100k_base")

        total = len(encoding.encode(build_card_generation_prompt()))
        catalog = len(encoding.encode(render_card_catalog(include_model_backed=False)))
        framing = total - catalog

        assert framing <= self.MAX_FRAMING_TOKENS, (
            f"The post-hoc prompt's framing is {framing} tokens, over the {self.MAX_FRAMING_TOKENS} "
            "ceiling. The trigger doctrine is shared and measured on the other surface; what is "
            "capped here is what this module adds around it. Craft that only the answering agents "
            "need belongs in the `piloti-cards` skill, not in this prompt."
        )
