"""``setback_plan`` carries a pure density question without invented geometry.

The craft says a pure Bebauungsgrad / GFZ question leaves ``sides`` empty. The
card used to require the four plan dimensions anyway, so the only way through
the validator (or the repair model) was to invent a parcel, which the renderer
then drew to scale. And a ratio's unit defaulted to ``cm``.
"""

from __future__ import annotations

import pytest

from aiq_agent.cards.models import grid_card_adapter

REF = {"document": "Bebauungsplan", "section": "§ 3"}
GFZ = {"label": "GFZ", "required": 1.5, "comparator": "<=", "status": "needs_input"}


def test_a_pure_density_question_needs_no_plan_dimensions():
    card = grid_card_adapter.validate_python(
        {
            "type": "setback_plan",
            "title": "Dichte",
            "sides": [],
            "parcel_area_m2": 800,
            "gross_floor_area_m2": 1450,
            "density": GFZ,
            "reference": REF,
        }
    ).model_dump(exclude_none=True)
    assert "parcel_width_m" not in card
    assert card["density"]["unit"] == ""


def test_a_plan_with_sides_still_needs_its_dimensions():
    with pytest.raises(ValueError, match="required to draw the plan"):
        grid_card_adapter.validate_python(
            {
                "type": "setback_plan",
                "title": "Lageplan",
                "parcel_area_m2": 800,
                "density": GFZ,
                "reference": REF,
                "sides": [{"side": "front", "required_m": 3, "actual_m": 4, "status": "pass"}],
            }
        )


def test_the_ratio_units_default_to_percent_and_none_never_cm():
    card = grid_card_adapter.validate_python(
        {
            "type": "setback_plan",
            "title": "Lageplan",
            "parcel_width_m": 20,
            "parcel_depth_m": 40,
            "building_width_m": 10,
            "building_depth_m": 20,
            "sides": [],
            "reference": REF,
            "coverage": {"label": "Bebauungsgrad", "required": 40, "status": "needs_input"},
            "density": GFZ,
        }
    ).model_dump(exclude_none=True)
    assert card["coverage"]["unit"] == "%"
    assert card["density"]["unit"] == ""


def test_a_unit_the_model_gave_is_kept():
    card = grid_card_adapter.validate_python(
        {
            "type": "setback_plan",
            "title": "Dichte",
            "sides": [],
            "parcel_area_m2": 800,
            "reference": REF,
            "coverage": {"label": "Bebauungsgrad", "required": 0.4, "unit": "", "status": "needs_input"},
        }
    ).model_dump(exclude_none=True)
    assert card["coverage"]["unit"] == ""
