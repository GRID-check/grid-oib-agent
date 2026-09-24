"""A composed surface (ADR-0065): valid A2UI, and every card inside it a valid card.

The structure is checked by `a2ui-core` (the protocol's own validators), each
card inside by the model it would be checked by on its own. What these pin is
that neither check can be walked around: a surface is not a way to smuggle a
card shape the validator refuses, a tool's card, or a component the renderer
does not have.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest
from pydantic import ValidationError

from aiq_agent.cards.envelope import render_envelope_cards_contract
from aiq_agent.cards.envelope import validate_model_card
from aiq_agent.cards.models import SURFACE_EXCLUDED_LEAVES
from aiq_agent.cards.models import grid_card_adapter

BASIS_A = {
    "id": "a",
    "component": "legal_basis",
    "law": "OIB-Richtlinie 2",
    "article": "3.1",
    "summary": "GK 4: REI 60.",
}
BASIS_B = {"id": "b", "component": "legal_basis", "law": "OIB-Richtlinie 2", "article": "3.1", "summary": "GK 5: R 90."}


def _tabs(**overrides: Any) -> dict[str, Any]:
    card = {
        "type": "surface",
        "title": "Tragende Bauteile nach Gebäudeklasse",
        "components": [
            {
                "id": "root",
                "component": "Tabs",
                "tabs": [{"title": "GK 4", "child": "a"}, {"title": "GK 5", "child": "b"}],
            },
            copy.deepcopy(BASIS_A),
            copy.deepcopy(BASIS_B),
        ],
    }
    card.update(overrides)
    return card


def _refusal(card: dict[str, Any]) -> str:
    with pytest.raises(ValidationError) as caught:
        grid_card_adapter.validate_python(card)
    return str(caught.value)


class TestAValidSurface:
    def test_tabs_of_two_cards_validate_and_keep_their_ids(self):
        card = grid_card_adapter.validate_python(_tabs())
        assert [component["id"] for component in card.components] == ["root", "a", "b"]

    def test_a_card_inside_is_normalised_by_its_own_model(self):
        # The leaf comes back as its card model dumps it: defaults applied,
        # nulls dropped, and still addressed by the model's own id.
        leaf = grid_card_adapter.validate_python(_tabs()).components[1]
        assert leaf["id"] == "a" and leaf["component"] == "legal_basis"
        assert "type" not in leaf
        assert leaf["law"] == "OIB-Richtlinie 2"

    def test_nested_containers_validate(self):
        card = _tabs()
        card["components"][0] = {"id": "root", "component": "Column", "children": ["row", "c"]}
        card["components"].append({"id": "row", "component": "Row", "children": ["a", "b"]})
        card["components"].append({**copy.deepcopy(BASIS_B), "id": "c"})
        assert grid_card_adapter.validate_python(card)

    def test_it_passes_the_envelope_validator_as_one_card(self):
        validated, refusal = validate_model_card(_tabs())
        assert refusal is None and validated is not None
        assert validated["type"] == "surface"


class TestTheStructureIsA2uiChecked:
    def test_a_reference_to_nothing_is_refused(self):
        card = _tabs()
        card["components"][0]["tabs"][1]["child"] = "missing"
        assert "non-existent component 'missing'" in _refusal(card)

    def test_a_component_nothing_reaches_is_refused(self):
        card = _tabs()
        card["components"].append({**copy.deepcopy(BASIS_B), "id": "stray"})
        assert "not reachable from 'root'" in _refusal(card)

    def test_a_cycle_is_refused(self):
        card = _tabs()
        card["components"][0]["tabs"][0]["child"] = "loop1"
        card["components"] += [
            {"id": "loop1", "component": "Column", "children": ["a", "loop2"]},
            {"id": "loop2", "component": "Column", "children": ["b", "loop1"]},
        ]
        assert "Circular reference" in _refusal(card)

    def test_a_duplicate_id_is_refused(self):
        card = _tabs()
        card["components"][2]["id"] = "a"
        card["components"][0]["tabs"][1]["child"] = "a"
        assert "Duplicate component ID" in _refusal(card)

    def test_the_root_must_be_a_container(self):
        card = _tabs()
        card["components"][0] = {**copy.deepcopy(BASIS_A), "id": "root"}
        assert "must be a Row, Column or Tabs" in _refusal(card)


class TestTheCardsInsideAreCardChecked:
    def test_a_card_its_own_model_refuses_is_refused_here(self):
        card = _tabs()
        del card["components"][1]["law"]
        message = _refusal(card)
        assert "'a' (legal_basis)" in message and "law" in message

    @pytest.mark.parametrize("excluded", sorted(SURFACE_EXCLUDED_LEAVES))
    def test_tool_interactive_and_envelope_cards_cannot_be_leaves(self, excluded):
        card = _tabs()
        card["components"][1] = {"id": "a", "component": excluded}
        assert "cannot sit inside a surface" in _refusal(card)

    def test_a_component_the_catalog_does_not_have_is_refused(self):
        card = _tabs()
        card["components"][1]["component"] = "Carousel"
        assert _refusal(card)

    def test_one_card_is_not_a_surface(self):
        card = _tabs()
        card["components"] = [
            {"id": "root", "component": "Row", "children": ["a", "b"]},
            copy.deepcopy(BASIS_A),
        ]
        assert _refusal(card)


class TestTheModelIsTaughtToCompose:
    def test_the_contract_carries_the_shape_and_its_limits(self):
        contract = render_envelope_cards_contract()
        assert "COMPOSE." in contract
        assert '"component": "Tabs"' in contract
        assert "Two to six leaves" in contract


def _text(component_id: str, text: str, **extra: Any) -> dict[str, Any]:
    return {"id": component_id, "component": "Text", "text": text, **extra}


class TestTextLeaves:
    """`Text` is how a tab holds what the Markdown-first answer writes in prose."""

    TABLE = "| Kriterium | Status | Fundstelle |\n|---|---|---|\n| **Rauchabzug** | offen | [2] |"

    def _variants(self, a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
        return _tabs(components=[_tabs()["components"][0], a, b])

    def test_a_tab_of_markdown_keeps_its_markup(self):
        card = grid_card_adapter.validate_python(self._variants(_text("a", self.TABLE), BASIS_B))
        # Card fields are flattened to plain text; a Text leaf IS Markdown and is not.
        assert card.components[1]["text"] == self.TABLE

    def test_text_counts_as_a_leaf(self):
        card = grid_card_adapter.validate_python(self._variants(_text("a", "x"), _text("b", "y")))
        assert [c["component"] for c in card.components] == ["Tabs", "Text", "Text"]

    def test_an_empty_text_is_refused(self):
        assert "empty" in _refusal(self._variants(_text("a", "  "), BASIS_B))

    def test_text_takes_no_other_prop(self):
        assert "takes only `text`" in _refusal(self._variants(_text("a", "x", variant="h1"), BASIS_B))

    def test_the_contract_teaches_text_in_tabs(self):
        contract = render_envelope_cards_contract()
        assert '"component": "Text"' in contract
        assert "Tabs" in contract


class TestTextCitations:
    """A tab's `[N]` follows the prose's renumbering, or goes."""

    def test_renumbered_with_the_prose_and_uncited_dropped(self):
        from aiq_agent.cards.surface_citations import recite_text

        text = "REI 90 [3], Rauchabzug [5]. Siehe [[card:1]] und [OIB](https://oib.or.at)."
        assert (
            recite_text(text, {3: 1, 5: 4}, {1})
            == "REI 90 [1], Rauchabzug. Siehe [[card:1]] und [OIB](https://oib.or.at)."
        )

    def test_only_surfaces_are_touched(self):
        from aiq_agent.cards.surface_citations import recite_surface

        basis = {"type": "legal_basis", "summary": "[9]"}
        assert recite_surface(basis, {}, set()) is basis
        surface = {"type": "surface", "components": [{"id": "root"}, _text("a", "x [2]")]}
        assert recite_surface(surface, {}, {2})["components"][1]["text"] == "x [2]"
