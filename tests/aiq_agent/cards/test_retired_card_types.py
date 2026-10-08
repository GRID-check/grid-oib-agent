"""The retired card types are refused, and every channel says what replaces them.

An answer is Markdown prose; a card carries what Markdown cannot (an
interaction, geometry drawn to scale, a computed number, a live model binding).
The table-, list- and quote-shaped cards, the envelope's card twins and
`follow_ups` are not in the `GridCard` union (`catalog.RETIRED_CARD_TYPES`).
Without them every channel refuses them as unknown; the refusal must still TELL
the model what to write instead, and no model-facing surface may offer one.
"""

from __future__ import annotations

import json
import re
from unittest.mock import MagicMock

import pytest

from aiq_agent.cards.catalog import RETIRED_CARD_REPLACEMENTS
from aiq_agent.cards.catalog import RETIRED_CARD_TYPES
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_doctrine
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.envelope import REFUSED_RETIRED_TYPE
from aiq_agent.cards.envelope import render_envelope_cards_contract
from aiq_agent.cards.envelope import validate_model_card
from aiq_agent.cards.models import GridCard
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.models import validate_cards
from aiq_agent.cards.prompt import build_card_generation_prompt
from aiq_agent.cards.registry import get_or_create_card_registry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry

RETIRED = sorted(RETIRED_CARD_TYPES)
GOOD = {"type": "ifc_model_picker", "title": "Welches Modell öffnen?"}


def _payload(card_type: str) -> dict:
    return {"type": card_type, "title": "Titel", "items": [{"label": "x"}]}


def test_the_set_is_the_one_the_product_owner_retired():
    assert RETIRED_CARD_TYPES == {
        "summary",
        "verdict_header",
        "key_takeaways",
        "callout",
        "follow_ups",
        "typed_table",
        "comparison_table",
        "requirement_checklist",
        "document_checklist",
        "deadline_timeline",
        "norm_chain",
        "change_impact",
        "diagram",
        "condition_tree",
        "process_map",
        "legal_basis",
        "fire_compartment",
        "thermal_envelope",
        "energy_performance",
        "acoustic_check",
        "parking_requirement",
        "density_check",
        "elevator_requirement",
    }


@pytest.mark.parametrize("card_type", RETIRED)
class TestEveryChannelRefusesIt:
    def test_it_is_no_union_member(self, card_type):
        members = {card.model_fields["type"].annotation.__args__[0] for card in GridCard.__args__}
        assert card_type not in members
        with pytest.raises(ValueError):
            grid_card_adapter.validate_python(_payload(card_type))

    def test_the_envelope_refuses_it_by_name_with_its_replacement(self, card_type):
        validated, refusal = validate_model_card(_payload(card_type))

        assert validated is None
        assert refusal is not None and refusal.kind == REFUSED_RETIRED_TYPE
        # Refused before the shape check: no shape to repair it into.
        assert refusal.hint is None
        assert RETIRED_CARD_REPLACEMENTS[card_type] in refusal.message

    async def test_emit_card_refuses_it_with_its_replacement(self, card_type):
        from aiq_agent.cards.register import EmitCardConfig
        from aiq_agent.cards.register import emit_card

        registry = get_or_create_card_registry(f"conv-retired-{card_type}")
        registry.clear()
        token = set_card_registry(registry)
        try:
            async with emit_card(EmitCardConfig(), MagicMock()) as info:
                message = await info.single_fn(card_json=json.dumps(_payload(card_type)))
        finally:
            reset_card_registry(token)

        assert message.startswith("Error")
        assert RETIRED_CARD_REPLACEMENTS[card_type] in message
        assert registry.snapshot() == []

    def test_post_hoc_generation_drops_it(self, card_type):
        assert [card["type"] for card in validate_cards([_payload(card_type), GOOD])] == ["ifc_model_picker"]

    def test_the_dsml_salvage_drops_it(self, card_type):
        from aiq_agent.agents.piloti.dsml import _salvage_card

        registry = get_or_create_card_registry(f"conv-dsml-retired-{card_type}")
        registry.clear()
        token = set_card_registry(registry)
        try:
            _salvage_card(json.dumps(_payload(card_type)))
            assert registry.snapshot() == []
            _salvage_card(json.dumps(GOOD))
            assert [card["type"] for card in registry.snapshot()] == ["ifc_model_picker"]
        finally:
            reset_card_registry(token)

    def test_a_surface_refuses_it_as_a_leaf_and_names_the_markdown(self, card_type):
        surface = {
            "type": "surface",
            "title": "Zwei Varianten",
            "components": [
                {
                    "id": "root",
                    "component": "Tabs",
                    "tabs": [{"title": "A", "child": "a"}, {"title": "B", "child": "b"}],
                },
                {"id": "a", "component": card_type, "title": "x"},
                {"id": "b", "component": "Text", "text": "| a | b |\n|---|---|\n| 1 | 2 |"},
            ],
        }
        validated, refusal = validate_model_card(surface)

        assert validated is None
        assert refusal is not None and "no longer exists" in refusal.detail

    def test_no_model_facing_surface_offers_it(self, card_type):
        assert card_type not in model_facing_card_types()
        assert render_card_details([card_type]) == ""
        offered = re.compile(rf'(- "{card_type}":|-> {card_type}\b)')
        for surface in (
            render_card_index(),
            render_card_doctrine(),
            render_card_doctrine(include_ifc_triggers=False, include_craft=False),
            build_card_generation_prompt(),
            render_envelope_cards_contract(),
        ):
            assert not offered.search(surface)


class TestRetiredContentIsKept:
    """A retired card's content, laid out as Markdown (``retired_card_markdown``)."""

    def test_a_legal_basis_becomes_its_title_and_a_quote_line(self):
        from aiq_agent.cards.catalog import retired_card_markdown

        markdown = retired_card_markdown(
            {
                "type": "legal_basis",
                "law": "OIB-RL 2",
                "article": "3.1",
                "original_text": "Fluchtwege führen ins Freie.",
            }
        )
        assert markdown == "**OIB-RL 2** · 3.1\n\n> „Fluchtwege führen ins Freie.“"

    def test_a_list_of_records_becomes_a_table_with_pipes_escaped(self):
        from aiq_agent.cards.catalog import retired_card_markdown

        markdown = retired_card_markdown({"type": "process_map", "steps": [{"name": "A|B"}, {"name": "C"}]})
        assert markdown == "| name |\n|---|\n| A\\|B |\n| C |"

    def test_a_live_type_or_an_empty_card_yields_nothing(self):
        from aiq_agent.cards.catalog import retired_card_markdown

        assert retired_card_markdown({"type": "stair_diagram", "title": "x"}) is None
        assert retired_card_markdown({"type": "typed_table"}) is None


def test_the_refusals_teach_no_dialect_block():
    """They reach deep research and the repair model, whose PDF prints `:::` as text."""
    for replacement in RETIRED_CARD_REPLACEMENTS.values():
        assert ":::" not in replacement and ":energy-class" not in replacement


def test_markdown_first_names_the_blocks_on_chat_and_plain_gfm_elsewhere():
    assert ":::check" in render_card_doctrine(chat=True) and "surface" in render_card_doctrine(chat=True)
    assert ":::" not in render_card_doctrine()
    assert "(surface)" not in render_card_doctrine()
    assert ":::check" in render_envelope_cards_contract()
