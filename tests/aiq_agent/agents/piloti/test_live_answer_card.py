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


def test_a_card_is_not_streamed_once_a_tool_registered_one_this_turn():
    # The reader places [[card:N]] against the message's card list; a card a
    # tool already pushed would shift every streamed card by one.
    cards = CardRegistry()
    cards.add({"type": "document_draft"})
    token = set_card_registry(cards)
    try:
        assert LiveAnswer(_registry()).card(_surface("REI 60.")) is None
    finally:
        reset_card_registry(token)


def test_a_surface_after_the_prose_settles_carries_the_settled_numbers():
    live = LiveAnswer(_registry())
    sources = "**Quellen:**\n- [1] erfunden.pdf, p.1\n- [2] oib-rl_2_ausgabe_mai_2023.pdf, p.12"
    settled = live.settle("Erfunden [1], die Wand REI 60 [2].", sources, None)
    assert settled is not None and settled.renumber_map == {2: 1}

    card = live.card(_surface("Die Wand REI 60 [2]."))

    assert card is not None
    assert [c["text"] for c in card["components"] if c["component"] == "Text"] == ["Die Wand REI 60 [1]."]
