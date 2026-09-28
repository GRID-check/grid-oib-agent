"""Cards as a field of the answer envelope: one validator, one contract, no round.

``emit_card`` is a tool call and a tool call ends a message, so every
card-bearing answer paid one more full-context call to write the prose after
its cards, and a third on a wrong shape. The envelope's ``cards`` field
carries the same objects in the same message as the answer. What these tests
pin is that the field buys a card no softer standard than the tool would, and
that the contract the model is taught is rendered from the catalog, shapes
included, rather than hand-written beside it.
"""

from __future__ import annotations

import json

from aiq_agent.cards.envelope import ENVELOPE_SHAPE_TYPES
from aiq_agent.cards.envelope import REFUSED_ENVELOPE_TYPE
from aiq_agent.cards.envelope import REFUSED_NOT_AN_OBJECT
from aiq_agent.cards.envelope import REFUSED_SHAPE
from aiq_agent.cards.envelope import REFUSED_SYSTEM_TYPE
from aiq_agent.cards.envelope import envelope_card_objects
from aiq_agent.cards.envelope import render_envelope_cards_contract
from aiq_agent.cards.envelope import validate_model_card

BASIS = {
    "type": "legal_basis",
    "law": "OIB-Richtlinie 2",
    "article": "3.1.1",
    "summary": "Brandabschnitte in GK 4 fassen höchstens 1.200 m².",
}


class TestTheOneValidator:
    def test_a_sound_card_validates_to_its_dump(self):
        validated, refusal = validate_model_card(BASIS)
        assert refusal is None
        assert validated is not None and validated["type"] == "legal_basis"

    def test_a_shape_miss_names_the_type_the_clauses_and_the_full_shape(self):
        """What a retry or a repair needs, and nothing a reader must not see."""
        validated, refusal = validate_model_card(
            {"type": "process_map", "title": "Einreichung", "steps": [{"title": "x"}]}
        )
        assert validated is None
        assert refusal is not None and refusal.kind == REFUSED_SHAPE
        assert refusal.card_type == "process_map"
        assert "label" in refusal.detail
        assert refusal.hint and "process_map" in refusal.hint
        assert "errors.pydantic.dev" not in refusal.for_repair()
        assert refusal.for_repair().startswith("card of type 'process_map' failed validation:")

    def test_a_system_card_is_refused_whatever_its_fields(self):
        validated, refusal = validate_model_card(
            {"type": "document_grid", "title": "fake", "documents": [{"file_name": "x.pdf"}]}
        )
        assert validated is None
        assert refusal is not None and refusal.kind == REFUSED_SYSTEM_TYPE

    def test_an_envelope_field_reached_for_as_a_card_names_the_channel(self):
        validated, refusal = validate_model_card({"type": "summary", "title": "t", "content": "c"})
        assert validated is None
        assert refusal is not None and refusal.kind == REFUSED_ENVELOPE_TYPE
        assert "answer envelope" in refusal.message

    def test_a_non_object_is_refused_by_kind(self):
        validated, refusal = validate_model_card("legal_basis")
        assert validated is None
        assert refusal is not None and refusal.kind == REFUSED_NOT_AN_OBJECT


class TestTheArrayTheModelWrites:
    def test_objects_pass_through_and_json_strings_are_parsed(self):
        """A model that learned `emit_card` writes a card as a JSON string; same card."""
        objects = envelope_card_objects([BASIS, json.dumps(BASIS)])
        assert objects == [BASIS, BASIS]

    def test_a_string_that_is_not_json_stays_a_string_to_be_refused_by_name(self):
        assert envelope_card_objects(["not json"]) == ["not json"]

    def test_nothing_is_nothing(self):
        assert envelope_card_objects(None) == []


class TestTheTaughtContract:
    def test_it_carries_the_doctrine_the_index_and_the_eight_shapes(self):
        contract = render_envelope_cards_contract()
        assert "WHEN TO EMIT ONE" in contract
        assert "WHEN NOT TO" in contract
        assert "Card types:" in contract
        for card_type in ENVELOPE_SHAPE_TYPES:
            assert f'"{card_type}"' in contract or f"{card_type}:" in contract
        # A shape the eight do not cover is index-only: the whole catalog's
        # shapes are ~23 000 tokens and stay on demand.
        assert "fire_compartment" in contract
        assert contract.count("Example:") <= len(ENVELOPE_SHAPE_TYPES) + 1

    def test_it_states_the_placement_rule_once(self):
        contract = render_envelope_cards_contract()
        assert contract.count("[[card:N]]") == 1
        assert "continue after the highest one" in contract

    def test_the_envelope_schema_teaches_the_field(self):
        from aiq_agent.common.answer_envelope import render_envelope_schema

        schema = render_envelope_schema()
        assert "cards: [" in schema
        assert "CARDS (the `cards` field):" in schema

    def test_the_strict_schema_omits_the_field_it_cannot_express(self):
        """Strict mode cannot hold the 40-way union; the truncated turn ships
        without cards rather than with a schema that lies about them."""
        from aiq_agent.common.answer_envelope import render_envelope_response_format

        properties = render_envelope_response_format()["json_schema"]["schema"]["properties"]
        assert "cards" not in properties
        assert "answer" in properties and "verdict" in properties


class TestTheRenderedShapeIsTheValidatedShape:
    def test_a_building_block_field_called_type_is_rendered_when_it_is_a_choice(self):
        """``TypedColumn.type`` is required by the validator and was hidden by the
        renderer, which skipped every field named ``type`` as if it were the
        card discriminator. A model that copied the shape failed on its first
        attempt, every time — the tax the shapes-up-front exist to remove."""
        from aiq_agent.cards.catalog import shape_hint_for

        hint = shape_hint_for("typed_table") or ""
        block = next(line for line in hint.splitlines() if line.strip().startswith("TypedColumn ="))
        assert 'type*: "mass" | "norm" | "verdict" | "date" | "text"' in block
        # The card's own discriminator stays out: the shape line names it.
        assert "shape: { type" not in hint

    def test_a_card_written_from_the_rendered_shape_validates(self):
        card = {
            "type": "typed_table",
            "title": "Teile",
            "columns": [{"label": "Teil", "type": "text"}, {"label": "Inhalt", "type": "text"}],
            "rows": [["OIB 2", "Brand"]],
        }
        validated, refusal = validate_model_card(card)
        assert refusal is None and validated is not None
