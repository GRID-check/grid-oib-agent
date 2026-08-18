"""Tests for the ``emit_card`` tool description and validation hints.

These guard the two things that made cards fail to emit in practice: the tool
description must expose the *nested* shapes (not just top-level field names), and
the worked examples must stay valid against the live card models.
"""

import pytest

from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
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
