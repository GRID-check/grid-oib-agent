"""``emit_card`` with an array: several cards, one call, one reply.

Two cards used to cost two rounds, each one a full pass over the turn's
context — and a description saying "one call each, in the same round" did not
move the fleet, because nothing stops a model issuing those calls one round
apart. An array cannot be issued serially.

What the array must not buy is a softer standard: every element goes through
the same validation and the same closed channels as a card emitted on its own,
and a refusal names the element's index so the model knows which object to fix
rather than re-sending the whole array over cards that already registered.
"""

import json
from unittest.mock import MagicMock

from aiq_agent.cards.register import EmitCardConfig
from aiq_agent.cards.register import emit_card
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry

#: Two cards the model may emit, filled the way it would fill them. `summary`
#: is deliberately not one of them: it travels in the answer envelope, and the
#: refusal that says so is one of the paths an array element must still meet.
PICKER = {"type": "ifc_model_picker", "title": "Treppe"}
BASIS = {
    "type": "legal_basis",
    "law": "OIB-Richtlinie 2",
    "article": "3.1.1",
    "summary": "Brandabschnitte in GK 4 fassen höchstens 1.200 m².",
}


async def _emit(registry: CardRegistry, payload) -> str:
    """The real tool against a bound registry."""
    token = set_card_registry(registry)
    try:
        async with emit_card(EmitCardConfig(), MagicMock()) as info:
            return await info.single_fn(card_json=json.dumps(payload))
    finally:
        reset_card_registry(token)


class TestAnArrayRegistersEveryCard:
    async def test_two_valid_cards_register_as_two_and_come_back_as_two_markers(self):
        registry = CardRegistry()

        message = await _emit(registry, [PICKER, BASIS])

        assert [card["type"] for card in registry.snapshot()] == ["ifc_model_picker", "legal_basis"]
        assert "[[card:1]]" in message
        assert "[[card:2]]" in message
        # The markers are in emission order, which is the order the frontend
        # resolves them in.
        assert message.index("[[card:1]]") < message.index("[[card:2]]")
        # The model still has to be told what to DO with them.
        assert "line of its own" in message

    async def test_the_positions_continue_the_turn_s_registry(self):
        # A card emitted on its own earlier in the turn already holds card 1.
        registry = CardRegistry()

        await _emit(registry, PICKER)
        message = await _emit(registry, [BASIS, PICKER])

        assert len(registry) == 3
        assert "[[card:2]]" in message
        assert "[[card:3]]" in message
        assert "[[card:1]]" not in message

    async def test_an_array_of_one_is_an_array(self):
        registry = CardRegistry()

        message = await _emit(registry, [PICKER])

        assert len(registry) == 1
        assert "[[card:1]]" in message


class TestARefusedElementNamesItself:
    async def test_the_valid_card_registers_and_the_refusal_carries_index_and_type(self):
        registry = CardRegistry()

        message = await _emit(registry, [PICKER, {"type": "process_map", "title": "Bauverfahren"}])

        assert [card["type"] for card in registry.snapshot()] == ["ifc_model_picker"]
        assert "[[card:1]]" in message
        # Index and type, because the model wrote the whole array in one call:
        # without them it cannot tell which object to fix, and the card that
        # did register is already in the registry, so re-sending both duplicates it.
        assert "Card at index 1 (type 'process_map')" in message
        assert "failed validation" in message

    async def test_a_system_card_in_an_array_is_refused_like_one_on_its_own(self):
        registry = CardRegistry()

        message = await _emit(
            registry,
            [{"type": "memory_proposal", "title": "X", "content": "Y", "kind": "preference"}, BASIS],
        )

        assert [card["type"] for card in registry.snapshot()] == ["legal_basis"]
        assert "Card at index 0 (type 'memory_proposal')" in message
        assert "system-emitted" in message

    async def test_an_element_that_is_not_an_object_is_named_by_its_index(self):
        registry = CardRegistry()

        message = await _emit(registry, [PICKER, "legal_basis"])

        assert len(registry) == 1
        assert "Card at index 1 (type 'str')" in message

    async def test_every_element_refused_comes_back_as_refusals_alone(self):
        registry = CardRegistry()

        message = await _emit(registry, [{"type": "process_map"}, {"type": "calculation"}])

        assert registry.snapshot() == []
        assert "Card at index 0 (type 'process_map')" in message
        assert "Card at index 1 (type 'calculation')" in message
        assert "[[card:" not in message

    async def test_an_empty_array_says_so(self):
        registry = CardRegistry()

        message = await _emit(registry, [])

        assert message.startswith("Error")
        assert registry.snapshot() == []


class TestTheSingleObjectPathIsUnchanged:
    async def test_a_bare_object_still_registers_and_still_says_card_one(self):
        registry = CardRegistry()

        message = await _emit(registry, PICKER)

        assert [card["type"] for card in registry.snapshot()] == ["ifc_model_picker"]
        assert message == (
            "Card 'ifc_model_picker' will be shown with your answer, as card 1. "
            "Write [[card:1]] on a line of its own at the point in your answer where the "
            "card belongs, and it is drawn there instead of after the whole answer. Leave the marker "
            "out and the card lands at the end."
        )

    async def test_a_bare_object_that_fails_validation_still_names_its_type_alone(self):
        registry = CardRegistry()

        message = await _emit(registry, {"type": "process_map", "title": "Bauverfahren"})

        assert message.startswith("Error: card of type 'process_map' failed validation:")
        # No index prefix: there is no array to point into.
        assert "Card at index" not in message
