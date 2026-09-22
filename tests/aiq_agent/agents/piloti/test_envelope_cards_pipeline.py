"""The envelope's cards reach the turn's registry, and the prose's markers reach them.

Through ``finalize_answer``, because the seam is the order: registration is
what turns the array's numbers into registry positions, and it has to run
before the suppression floor and the callout resolver read the prose. A card
the validator refuses is repaired ONCE on the small model and never by a
round; a card that still fails is dropped, recorded, and its marker removed
so no later card slides onto its place.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import ToolMessage

from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

BASIS = {
    "type": "legal_basis",
    "law": "OIB-Richtlinie 2",
    "article": "3.1.1",
    "summary": "Brandabschnitte in GK 4 fassen höchstens 1.200 m².",
}
TABLE_WRONG = {"type": "typed_table", "title": "Teile", "columns": ["Teil", "Inhalt"], "rows": [["OIB 2", "Brand"]]}
TABLE_RIGHT = {
    "type": "typed_table",
    "title": "Teile",
    "columns": [{"label": "Teil", "type": "text"}, {"label": "Inhalt", "type": "text"}],
    "rows": [["OIB 2", "Brand"]],
}
PROSE = (
    "x" * 900 + " Die Antwort [1].\n\n[[card:1]]\n\nWeiter.\n\n[[card:2]]\n\n## References\n- [1] https://example.com"
)


@pytest.fixture
def card_registry():
    registry = CardRegistry()
    token = set_card_registry(registry)
    yield registry
    reset_card_registry(token)


def _messages(cards: list, *tool_replies: str) -> list:
    envelope = {"answer": PROSE, "kind": "walkthrough", "cards": cards}
    return [
        *(ToolMessage(content=reply, name="write_file", tool_call_id=f"t{i}") for i, reply in enumerate(tool_replies)),
        AIMessage(content="```answer_json\n" + json.dumps(envelope, ensure_ascii=False) + "\n```"),
    ]


def _sources() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(SourceEntry(url="https://example.com", tool_name="web"))
    return registry


@pytest.mark.asyncio
async def test_sound_cards_register_in_array_order_and_the_markers_stay(card_registry):
    final = await finalize_answer(_messages([BASIS, TABLE_RIGHT]), registry=_sources(), tools=[], repair=None)

    assert [card["type"] for card in card_registry.snapshot()] == ["legal_basis", "typed_table"]
    assert "[[card:1]]" in final.content and "[[card:2]]" in final.content


@pytest.mark.asyncio
async def test_the_array_lands_after_the_tool_cards_and_its_markers_follow(card_registry):
    """A draft the turn filed sits at position 1; the model's two cards become 2 and 3."""
    card_registry.add({"type": "document_draft", "title": "Aktenvermerk"})
    handed = "Draft written. Write [[card:1]] where the file belongs."

    final = await finalize_answer(_messages([BASIS, TABLE_RIGHT], handed), registry=_sources(), tools=[], repair=None)

    assert [card["type"] for card in card_registry.snapshot()] == ["document_draft", "legal_basis", "typed_table"]
    # `[[card:1]]` was handed by the tool and stays the draft's; `[[card:2]]` is
    # the array's second card, now at position 3.
    assert "[[card:1]]" in final.content
    assert "[[card:3]]" in final.content
    assert "[[card:2]]" not in final.content


@pytest.mark.asyncio
async def test_a_shape_miss_is_repaired_once_on_the_small_model(card_registry):
    repair = AsyncMock(return_value=TABLE_RIGHT)
    with patch("aiq_agent.common.turn_status.push_custom_step") as steps:
        final = await finalize_answer(
            _messages([BASIS, TABLE_WRONG]), registry=_sources(), tools=[], repair=None, card_repair=repair
        )

    repair.assert_awaited_once()
    card, refusal, answer = repair.await_args.args
    assert card == TABLE_WRONG
    assert refusal.startswith("card of type 'typed_table' failed validation:")
    assert "shape:" in refusal  # the type's full shape rides along for the repair
    assert answer.startswith("x" * 100)
    assert [card["type"] for card in card_registry.snapshot()] == ["legal_basis", "typed_table"]
    assert "[[card:2]]" in final.content
    recorded = [call.args[1]["values"] for call in steps.call_args_list if "card:invalid" in call.args[0]]
    assert recorded == [{"cardType": "typed_table", "outcome": "repaired"}]


@pytest.mark.asyncio
async def test_a_card_that_still_fails_is_dropped_recorded_and_its_marker_removed(card_registry):
    repair = AsyncMock(return_value=None)
    with patch("aiq_agent.common.turn_status.push_custom_step") as steps:
        final = await finalize_answer(
            _messages([TABLE_WRONG, BASIS]), registry=_sources(), tools=[], repair=None, card_repair=repair
        )

    assert [card["type"] for card in card_registry.snapshot()] == ["legal_basis"]
    # The dropped card's marker is gone; the second card is now position 1.
    assert "[[card:2]]" not in final.content
    assert final.content.count("[[card:1]]") == 1
    recorded = [call.args[1]["values"] for call in steps.call_args_list if "card:invalid" in call.args[0]]
    assert recorded == [{"cardType": "typed_table", "outcome": "dropped"}]


@pytest.mark.asyncio
async def test_a_system_card_in_the_envelope_is_refused_and_never_repaired(card_registry):
    repair = AsyncMock(return_value=None)
    fake = {"type": "document_grid", "title": "fake", "documents": [{"file_name": "x.pdf"}]}

    await finalize_answer(_messages([fake]), registry=_sources(), tools=[], repair=None, card_repair=repair)

    repair.assert_not_awaited()
    assert card_registry.snapshot() == []


@pytest.mark.asyncio
async def test_no_registry_bound_ships_the_answer_without_cards():
    final = await finalize_answer(_messages([BASIS]), registry=_sources(), tools=[], repair=None)
    assert final.answered


@pytest.mark.asyncio
async def test_a_marker_a_tool_handed_out_last_turn_is_not_taken_this_turn(card_registry):
    """The transcript carries the previous turn; its `[[card:1]]` belongs to that turn's registry."""
    from langchain_core.messages import HumanMessage

    previous_turn = [
        HumanMessage(content="Schreib den Aktenvermerk."),
        ToolMessage(
            content="Draft written. Write [[card:1]] where the file belongs.", name="write_file", tool_call_id="t0"
        ),
        AIMessage(content="Erledigt. [[card:1]]"),
        HumanMessage(content="Und die Brandabschnitte?"),
    ]
    final = await finalize_answer([*previous_turn, *_messages([BASIS])], registry=_sources(), tools=[], repair=None)

    assert [card["type"] for card in card_registry.snapshot()] == ["legal_basis"]
    assert "[[card:1]]" in final.content
