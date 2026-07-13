"""Tests for the ``emit_card`` tool description and validation hints.

These guard the two things that made cards fail to emit in practice: the tool
description must expose the *nested* shapes (not just top-level field names), and
the worked examples must stay valid against the live card models.
"""

import pytest

from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.register import _CARD_EXAMPLES
from aiq_agent.cards.register import _build_tool_description
from aiq_agent.cards.register import _shape_hint_for

_CARD_TYPES = [
    getattr(c.model_fields["type"].annotation, "__args__", ("?",))[0] for c in GridCard.__args__
]


# Card types deliberately shipped WITHOUT a worked example — flat/simple shapes
# the model reliably produces from the one-line shape spec alone. Adding a new
# card type forces a choice: give it an example or list it here (see coverage
# test below), so a hard-to-nest type can't slip in with no guidance.
_EXAMPLE_EXEMPT = {
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


class TestToolDescription:
    def test_returns_string(self):
        assert isinstance(_build_tool_description(), str)

    def test_lists_every_card_type(self):
        desc = _build_tool_description()
        for card_type in _CARD_TYPES:
            assert f'"{card_type}"' in desc

    def test_expands_nested_building_blocks(self):
        # The whole point: nested object shapes must be spelled out, not hidden
        # behind a bare field name like `glass_area`.
        desc = _build_tool_description()
        assert "DimensionCheck = {" in desc
        assert "NormReference = {" in desc
        assert "needs_input" in desc  # enum options surfaced

    def test_includes_worked_examples(self):
        desc = _build_tool_description()
        assert "Worked examples" in desc
        assert "daylight_incidence" in desc


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
