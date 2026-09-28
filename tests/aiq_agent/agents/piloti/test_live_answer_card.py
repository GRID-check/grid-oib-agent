"""A card streamed before the pipeline runs, gated as the pipeline gates it (ADR-0066)."""

from __future__ import annotations

import copy

from aiq_agent.agents.piloti.answer_pipeline import LiveAnswer
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

_BASIS = {"id": "a", "component": "legal_basis", "law": "OIB-Richtlinie 2", "article": "3.1", "summary": "GK 4."}


def _registry() -> SourceRegistry:
    registry = SourceRegistry()
    registry.add(
        SourceEntry(
            citation_key="oib-rl_2_ausgabe_mai_2023.pdf, p.12",
            source_type="knowledge_layer",
            collection="oib_knowledge",
            tool_name="knowledge_search",
        )
    )
    return registry


def _surface(text: str) -> dict:
    return {
        "type": "surface",
        "title": "Tragende Wände",
        "components": [
            {
                "id": "root",
                "component": "Tabs",
                "tabs": [{"title": "GK 4", "child": "a"}, {"title": "Wand", "child": "t"}],
            },
            copy.deepcopy(_BASIS),
            {"id": "t", "component": "Text", "text": text},
        ],
    }


def _with_tool_cards(*cards: dict) -> tuple[CardRegistry, object]:
    registry = CardRegistry()
    for card in cards:
        registry.add(card)
    return registry, set_card_registry(registry)


def test_a_card_streams_after_a_tool_registered_one_and_the_tools_head_the_list():
    # The terminal lists the tools' cards first, then the envelope's: the live
    # list is the same, so [[card:N]] and a decision's key mean one card.
    _cards, token = _with_tool_cards({"type": "document_draft", "path": "a.md"})
    try:
        live = LiveAnswer(_registry())
        assert live.tool_cards() == [{"type": "document_draft", "path": "a.md"}]
        assert live.card(_surface("REI 60.")) is not None
    finally:
        reset_card_registry(token)


def test_the_envelope_markers_move_behind_the_tool_cards():
    _cards, token = _with_tool_cards({"type": "document_draft"}, {"type": "task_created"})
    try:
        live = LiveAnswer(_registry())
        assert live.place("Oben.\n\n[[card:1]]\n\nUnten [[card:2]].") == "Oben.\n\n[[card:3]]\n\nUnten [[card:4]]."
    finally:
        reset_card_registry(token)


def test_a_marker_a_tool_handed_out_keeps_its_number():
    _cards, token = _with_tool_cards({"type": "document_draft"})
    try:
        live = LiveAnswer(_registry(), handed={1})
        # [[card:1]] is the tool's own; the model continued after it, so 2 is array card 1.
        assert live.place("[[card:1]] [[card:2]]") == "[[card:1]] [[card:2]]"
    finally:
        reset_card_registry(token)


def test_without_tool_cards_the_markers_are_untouched():
    assert LiveAnswer(_registry()).place("[[card:1]] [[card:2]]") == "[[card:1]] [[card:2]]"


def test_the_tool_cards_are_read_once_per_call():
    cards, token = _with_tool_cards({"type": "document_draft"})
    try:
        live = LiveAnswer(_registry())
        assert live.place("[[card:1]]") == "[[card:2]]"
        cards.add({"type": "task_created"})
        assert len(live.tool_cards()) == 1 and live.place("[[card:1]]") == "[[card:2]]"
    finally:
        reset_card_registry(token)


async def test_the_live_positions_are_the_terminals():
    """``place`` and the finished answer's renumbering read the model's numbers the same way."""
    from aiq_agent.agents.piloti.answer_pipeline import _register_envelope_cards
    from aiq_agent.common.answer_envelope import AnswerMeta

    prose = "Die Tabelle:\n\n[[card:1]]\n\nDie Karte:\n\n[[card:2]]"
    envelope = [
        {"type": "legal_basis", "law": "OIB-Richtlinie 2", "article": "3.1", "summary": "GK 4."},
        {"type": "legal_basis", "law": "OIB-Richtlinie 2", "article": "5.1", "summary": "Fluchtweg."},
    ]
    cards, token = _with_tool_cards({"type": "document_draft", "path": "a.md"})
    try:
        live = LiveAnswer(_registry())
        placed = live.place(prose)
        streamed = [*live.tool_cards(), *(live.card(payload) for payload in envelope)]
        terminal = await _register_envelope_cards(AnswerMeta(cards=envelope), prose, [], None)
    finally:
        reset_card_registry(token)
    assert placed == terminal
    # The live card carries its wording check early (``cards/legal_proof``); the
    # terminal stamps it in ``finalize_answer``, after registration. Everything
    # else about the card is the terminal's.
    unstamped = [{key: value for key, value in card.items() if key != "verification"} for card in streamed]
    assert unstamped == cards.snapshot()


def test_a_surface_after_the_prose_settles_carries_the_settled_numbers():
    live = LiveAnswer(_registry())
    sources = "**Quellen:**\n- [1] erfunden.pdf, p.1\n- [2] oib-rl_2_ausgabe_mai_2023.pdf, p.12"
    settled = live.settle("Erfunden [1], die Wand REI 60 [2].", sources, None)
    assert settled is not None and settled.renumber_map == {2: 1}

    card = live.card(_surface("Die Wand REI 60 [2]."))

    assert card is not None
    assert [c["text"] for c in card["components"] if c["component"] == "Text"] == ["Die Wand REI 60 [1]."]
