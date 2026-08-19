"""Tests for the ``emit_card`` tool description and validation hints.

These guard the two things that made cards fail to emit in practice: the tool
description must expose the *nested* shapes (not just top-level field names), and
the worked examples must stay valid against the live card models.
"""

import pytest

from aiq_agent.cards.catalog import _CARD_HONESTY
from aiq_agent.cards.catalog import _CARD_RESTRAINT
from aiq_agent.cards.catalog import _CARD_TRIGGER_TABLE
from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_doctrine
from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.register import _CARD_EXAMPLES
from aiq_agent.cards.register import _build_tool_description
from aiq_agent.cards.register import _shape_hint_for

_CARD_TYPES = [getattr(c.model_fields["type"].annotation, "__args__", ("?",))[0] for c in GridCard.__args__]


# Card types deliberately shipped WITHOUT a worked example — flat/simple shapes
# the model reliably produces from the one-line shape spec alone. Adding a new
# card type forces a choice: give it an example or list it here (see coverage
# test below), so a hard-to-nest type can't slip in with no guidance.
_EXAMPLE_EXEMPT = {
    # The three model-backed cards carry an identifier and nothing else: the
    # frontend reads every number from the model, so there is no nesting for an
    # example to disambiguate. `ifc_viewer` IS exampled, because its highlight
    # groups are nested.
    "ifc_schedule",
    "ifc_element",
    "ifc_diff",
    "summary",
    "legal_basis",
    "stair_diagram",
    "dimension_diagram",
    "setback_plan",
    "egress_diagram",
    "guardrail_check",
    "density_check",
    "fire_access_plan",
    "acoustic_check",
    "energy_performance",
    "elevator_requirement",
    # System-emitted (by the remember tool); never advertised to the model, so it
    # ships without a worked example on purpose.
    "memory_proposal",
    # System-emitted (by the surface_documents tool) from a real corpus search;
    # never advertised to the model, so it ships without a worked example.
    "document_grid",
}


class TestWorkedExamples:
    @pytest.mark.parametrize("card_type", list(_CARD_EXAMPLES))
    def test_example_validates(self, card_type):
        # A drifted example would teach the model the wrong shape — fail loudly.
        grid_card_adapter.validate_python(_CARD_EXAMPLES[card_type])

    def test_every_card_type_has_example_or_is_exempt(self):
        # A new card type must not silently ship with neither an example nor a
        # deliberate exemption.
        documented = set(_CARD_EXAMPLES) | _EXAMPLE_EXEMPT
        missing = [t for t in _CARD_TYPES if t not in documented]
        assert not missing, f"New card type(s) need a worked example or an _EXAMPLE_EXEMPT entry: {missing}"


class TestModelFacingCardTypes:
    def test_is_the_union_minus_system_cards(self):
        # The one answer to "may this card be asked for by name?" — used by the
        # tool description here and by the skills substrate's `grid-cards`
        # validation, so the two can never disagree about a new card type.
        assert model_facing_card_types() == set(_CARD_TYPES) - SYSTEM_CARD_TYPES
        assert model_facing_card_types().isdisjoint(SYSTEM_CARD_TYPES)


class TestToolDescription:
    def test_returns_string(self):
        assert isinstance(_build_tool_description(), str)

    def test_lists_every_card_type(self):
        desc = _build_tool_description()
        for card_type in _CARD_TYPES:
            if card_type in SYSTEM_CARD_TYPES:
                continue
            assert f'"{card_type}"' in desc

    def test_system_cards_are_not_advertised(self):
        # System cards (memory_proposal) must not appear in the model-facing tool
        # description — the model must never be able to fabricate them.
        desc = _build_tool_description()
        for card_type in SYSTEM_CARD_TYPES:
            assert f'"{card_type}"' not in desc
        assert "memory_proposal" not in desc

    def test_expands_nested_building_blocks_on_demand(self):
        # Nested object shapes must be spelled out, not hidden behind a bare
        # field name like `glass_area`. They moved OFF the always-on tool
        # description (~5,200 tokens every turn, emitted card or not) and onto
        # `describe_card`, which is asked for the one type that is needed.
        detail = render_card_details(["daylight_incidence"])
        assert "DimensionCheck = {" in detail
        assert "NormReference = {" in detail
        assert "needs_input" in detail  # enum options surfaced

    def test_includes_worked_examples_on_demand(self):
        detail = render_card_details(["daylight_incidence"])
        assert "Worked examples" in detail
        assert "daylight_incidence" in detail

    def test_the_index_names_every_card_without_its_shape(self):
        # L1 is one line per type: enough for the model to know a card EXISTS
        # and pick it, not enough to fill it in. That split is what keeps the
        # marginal cost of a new card type at ~23 tokens instead of ~193.
        desc = _build_tool_description()
        assert '"daylight_incidence"' in desc
        assert "DimensionCheck = {" not in desc
        assert "Worked examples" not in desc

    def test_flags_cards_that_ask_the_user_to_confirm(self):
        # An interactive card costs the user a DECISION, not just screen space
        # (ADR-0030). Without saying so, the model emits them speculatively and
        # the answer becomes a pile of consent prompts.
        desc = _build_tool_description()
        assert "Cards that ask the user to CONFIRM something" in desc
        for card_type in INTERACTIVE_CARD_TYPES - SYSTEM_CARD_TYPES:
            assert f'"{card_type}"' in desc
        assert "At most one per turn" in desc


class TestTheDefaultIsPositive:
    """The doctrine has to READ as "emit it", not as "cards are risky".

    The failure this guards is not a missing card type and not a missing
    trigger. Asked „Wie läuft das Baubewilligungsverfahren in Wien ab?" — almost
    the words of the ``process_map`` trigger line — the model answered in a
    numbered prose list, and two turns later named the card it should have
    emitted and built a good one on the first attempt. It knew, and did not
    reach. ``follow_ups`` went missing on the same turn with its shape already
    inlined in ``grid-cards``, so a `describe_card` round-trip was not the cost
    standing in the way either.

    What was in the way was the balance. Measured on the text the model sees,
    the always-on doctrine ran 2.4 : 1 restraint to invitation, and the ONE
    sentence stating a default (`An answer that turns on a dimension gets its
    card by default`) was scoped to the six schematic rows — leaving the other
    twelve triggers as a table of permissions with a `WHEN NOT TO` paragraph
    under it. These assertions pin the rebalance so a later edit cannot walk it
    back a clause at a time, which is exactly how it arrived.
    """

    def test_the_default_covers_the_whole_table_not_one_class_of_card(self):
        doctrine = render_card_doctrine()
        assert "A match in this table IS a card, by default" in doctrine
        # And the scoped version it replaced is gone: it read as a rule about
        # measurements, which `process_map` and `follow_ups` are not.
        assert "An answer that turns on a dimension gets its card by default" not in doctrine

    def test_the_doctrine_names_writing_prose_instead_as_the_failure(self):
        # The observation itself, stated to the model. A trigger table lists
        # what is ALLOWED; only this says which way to err.
        doctrine = render_card_doctrine()
        assert "knowing which one fits and" in doctrine
        assert "writing the answer as prose anyway" in doctrine
        assert "Not emitting on a match is" in doctrine

    def test_the_positive_default_outweighs_the_volume_rule(self):
        # Not a style preference — a measurement. The prose that invites a card
        # must not be shorter than the prose that limits how many, or the whole
        # block reads as a warning with a list attached.
        tiktoken = pytest.importorskip("tiktoken")
        encoding = tiktoken.get_encoding("cl100k_base")

        invitation = _CARD_TRIGGER_TABLE.split("The trigger, then the card:")[0]
        assert len(encoding.encode(invitation)) > len(encoding.encode(_CARD_RESTRAINT))

    def test_the_anti_fabrication_rule_stands_apart_and_outranks_the_triggers(self):
        # The one rule that must NOT be softened to get more cards. It was a
        # sentence inside the volume paragraph, where a model discounting "two
        # is plenty" as tone discounts it too; it is its own block now, and it
        # says out loud that it beats a trigger match.
        doctrine = render_card_doctrine()
        assert "Never fabricate a field, a reference or a number" in _CARD_HONESTY
        assert "outranks every trigger" in _CARD_HONESTY
        assert "needs_input" in _CARD_HONESTY
        assert "never" in _CARD_HONESTY and "estimated" in _CARD_HONESTY
        # Stated once, in its own block, not folded back into the volume rule.
        assert "fabricate" not in _CARD_RESTRAINT
        assert doctrine.count("Never fabricate a field") == 1

    def test_the_volume_rule_is_a_budget_to_spend(self):
        # Same number as before — two — said as a budget rather than as a cap,
        # and with the follow_ups exemption that until now only the German skill
        # carried. A model that counts follow_ups against the two has one slot
        # for the card the answer was actually about.
        assert "there to be SPENT" in _CARD_RESTRAINT
        assert "follow_ups does not count against it" in _CARD_RESTRAINT
        assert "Two cards in a turn is plenty" not in _CARD_RESTRAINT

    def test_looking_a_shape_up_is_not_framed_as_a_cost(self):
        # Cause two, addressed for 20 tokens instead of the ~693 it costs to
        # inline `process_map`'s shape on every turn. The old wording named only
        # what a WRONG guess costs, which prices the round-trip and never prices
        # the card that does not get emitted.
        desc = _build_tool_description()
        assert "never a reason to skip a card" in desc
        assert "guessing the nesting wastes a turn" not in desc


class TestShapeHint:
    @pytest.mark.parametrize("card_type", _CARD_TYPES)
    def test_hint_for_every_type(self, card_type):
        hint = _shape_hint_for(card_type)
        assert hint is not None
        assert card_type in hint

    def test_hint_expands_referenced_blocks(self):
        hint = _shape_hint_for("daylight_incidence")
        assert "DimensionCheck = {" in hint
        assert "NormReference = {" in hint

    def test_unknown_type_returns_none(self):
        assert _shape_hint_for("not_a_real_card") is None


class TestTheDescriptionStaysAffordable:
    """A ceiling on what `emit_card` costs before the model has done anything.

    This description is prepended to every turn on the cost-optimised tier,
    whether or not the answer ends up emitting a card. It was 5,209 tokens when
    every shape and worked example was rendered inline; splitting the catalog
    into an index plus `describe_card` cut it to roughly 700, and it then crept
    back to 2,126 because each new card type added a trigger line AND a
    paragraph of craft — a drift nobody could see in a diff, because every
    individual paragraph was worth its own hundred tokens.

    The ceiling is the guard against that specific failure. It is deliberately
    slack: it does not pin today's number, it fails only when the description
    has grown by roughly a third, which is far too much to arrive by accident.
    A new card type is expected to add its trigger line to the shared doctrine
    and put its paragraph in the `piloti-cards` skill, which is applied on every
    answering turn anyway and is a database row rather than a deploy.

    That doctrine now lives in `cards.catalog` and is rendered by the post-hoc
    card prompt as well, so it is no longer only this description's to spend —
    but it is still PAID here, on every turn, which is why the ceiling still
    measures `_build_tool_description()` end to end rather than the framing
    around it. Text added to the shared doctrine for the benefit of the batch
    generator shows up in this number, and that is the point: the per-turn cost
    is the scarce one. `test_prompt.py` caps what the post-hoc side adds on its
    own account.

    Raising this number is a decision, not a fix. It should come with a
    measurement of what the turn now costs in total.
    """

    #: cl100k_base tokens. Measured at 1,745 when this was written.
    MAX_TOKENS = 2_300

    def test_the_tool_description_stays_under_the_ceiling(self):
        tiktoken = pytest.importorskip("tiktoken")
        encoding = tiktoken.get_encoding("cl100k_base")

        cost = len(encoding.encode(_build_tool_description()))

        assert cost <= self.MAX_TOKENS, (
            f"emit_card's description is {cost} tokens, over the {self.MAX_TOKENS} ceiling. "
            "Every turn pays this whether or not a card is emitted. If you added a card type, "
            "its trigger line belongs in `cards.catalog`'s shared doctrine and its craft paragraph "
            "belongs in the `piloti-cards` platform skill."
        )
