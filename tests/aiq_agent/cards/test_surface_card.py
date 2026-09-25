"""A composed surface (ADR-0065): valid A2UI, and every card inside it a valid card.

The structure is checked by `a2ui-core` (the protocol's own validators), each
card inside by the model it would be checked by on its own. What these pin is
that neither check can be walked around: a surface is not a way to smuggle a
card shape the validator refuses, a tool's card, or a component the renderer
does not have.
"""

from __future__ import annotations

import copy
import re
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
        assert "the surface 2 to 6 leaves" in contract


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

        # sanitize's map: every SURVIVING number, old → new. [2] and [4] were removed.
        text = "REI 90 [3], Rauchabzug [5]. Siehe [[card:1]] und [OIB](https://oib.or.at)."
        assert (
            recite_text(text, {1: 1, 3: 2, 5: 3}, {2})
            == "REI 90 [2], Rauchabzug. Siehe [[card:1]] und [OIB](https://oib.or.at)."
        )

    def test_a_removed_number_never_lands_on_the_survivor_renumbered_onto_it(self):
        from aiq_agent.cards.surface_citations import recite_text

        # [2] was removed; [3] became [2]. A tab's [2] meant the removed source.
        assert recite_text("A [1], B [2], C [3].", {1: 1, 3: 2}, {1, 2}) == "A [1], B, C [2]."

    def test_only_surfaces_are_touched(self):
        from aiq_agent.cards.surface_citations import recite_surface

        basis = {"type": "legal_basis", "summary": "[9]"}
        assert recite_surface(basis, {}, set()) is basis
        surface = {"type": "surface", "components": [{"id": "root"}, _text("a", "x [2]")]}
        assert recite_surface(surface, {}, {2})["components"][1]["text"] == "x [2]"


class TestTextRecital:
    """What the prose's citation steps do to a tab's markers, and nothing else."""

    def test_a_group_is_expanded_before_it_is_renumbered(self):
        from aiq_agent.cards.surface_citations import recite_text

        # The prose's groups are expanded first; a tab's must be, or [2, 3]
        # stays in the numbering from before verification.
        assert recite_text("REI 90 [2, 3]. Und [3].", {2: 1, 3: 2}, {1, 2}) == "REI 90 [1][2]. Und [2]."

    def test_a_merged_duplicate_is_rewritten_not_dropped(self):
        from aiq_agent.cards.surface_citations import recite_text

        # [1] and [2] cite one page: the prose's [2] became [1], [2]'s line
        # went, and sanitize kept {1: 1, 3: 2}. The tab's [2] is that source.
        assert recite_text("A [2], B [3].", {1: 1, 3: 2}, {1, 2}, merged={2: 1}) == "A [1], B [2]."

    def test_merged_duplicates_are_read_off_the_removals(self):
        from aiq_agent.common.citation_verification import merged_citations

        removed = [
            {"number": 2, "line": "- [2] oib.pdf, p.3", "reason": "duplicate_of_citation_1"},
            {"number": 4, "line": "- [4] x", "reason": "url_not_in_registry"},
        ]
        assert merged_citations(removed) == {2: 1}

    def test_nothing_but_the_markers_changes(self):
        from aiq_agent.cards.surface_citations import recite_text

        text = (
            "| Punkt | Wert |\n| :--- | ---: |\n| REI [4] | ( a ) |\n\n"
            "```mermaid\nsequenceDiagram\n  A->>B : hi\n```\n"
            "Die Wand [4] trägt [1]."
        )
        assert recite_text(text, {}, {1}) == (
            "| Punkt | Wert |\n| :--- | ---: |\n| REI | ( a ) |\n\n"
            "```mermaid\nsequenceDiagram\n  A->>B : hi\n```\n"
            "Die Wand trägt [1]."
        )

    def test_a_removed_marker_mid_sentence_leaves_one_space(self):
        from aiq_agent.cards.surface_citations import recite_text

        assert recite_text("Die Wand [4] trägt.", {}, set()) == "Die Wand trägt."

    def test_a_text_left_blank_is_dropped_with_its_tab(self):
        from aiq_agent.cards.surface_citations import recite_surface

        card = _tabs(
            components=[
                {
                    "id": "root",
                    "component": "Tabs",
                    "tabs": [
                        {"title": "GK 4", "child": "a"},
                        {"title": "GK 5", "child": "b"},
                        {"title": "Quellen", "child": "q"},
                    ],
                },
                copy.deepcopy(BASIS_A),
                copy.deepcopy(BASIS_B),
                _text("q", "[4] [5]"),
            ]
        )
        recited = recite_surface(card, {}, {1})

        assert recited is not None
        assert [component["id"] for component in recited["components"]] == ["root", "a", "b"]
        assert [tab["child"] for tab in recited["components"][0]["tabs"]] == ["a", "b"]
        grid_card_adapter.validate_python(recited)

    def test_a_surface_left_with_one_card_is_that_card(self):
        from aiq_agent.cards.surface_citations import recite_surface

        card = _tabs(components=[_tabs()["components"][0], copy.deepcopy(BASIS_A), _text("b", "[4]")])

        recited = recite_surface(card, {}, {1})

        assert recited["type"] == "legal_basis" and recited["law"] == BASIS_A["law"]
        grid_card_adapter.validate_python(recited)

    def test_a_surface_left_with_one_text_keeps_the_blank_marked_and_recites_the_rest(self):
        from aiq_agent.cards.surface_citations import BLANK_TEXT
        from aiq_agent.cards.surface_citations import recite_surface

        card = _tabs(components=[_tabs()["components"][0], _text("a", "[3]"), _text("b", "REI 90 [5]")])

        recited = recite_surface(card, {1: 1, 5: 2}, {1, 2})

        texts = {c["id"]: c["text"] for c in recited["components"] if c.get("component") == "Text"}
        # Never the stored [5]: after sanitize it is [2], or the tab names a different source.
        assert texts == {"a": BLANK_TEXT, "b": "REI 90 [2]"}
        grid_card_adapter.validate_python(recited)

    def test_a_marker_inside_code_is_code(self):
        from aiq_agent.cards.surface_citations import recite_text

        text = "Siehe `x[1]` [4].\n\n```mermaid\nflowchart LR\n  S[1] --> T[2]\n```\nWand [1]."
        assert recite_text(text, {}, {1}) == (
            "Siehe `x[1]`.\n\n```mermaid\nflowchart LR\n  S[1] --> T[2]\n```\nWand [1]."
        )


class TestSurfaceIntegrity:
    """What `a2ui-core` lets through and the surface does not."""

    @pytest.mark.parametrize(("prop", "value"), [("justify", "between"), ("align", "spaceBetween")])
    def test_a_layout_value_the_renderer_does_not_take_is_refused(self, prop, value):
        # The frontend's RowApi takes an enum; anything else fails its preflight and the surface degrades.
        card = _tabs(
            components=[{"id": "root", "component": "Row", "children": ["a", "b"], prop: value}, BASIS_A, BASIS_B]
        )
        assert f"`{prop}` is one of" in _refusal(card)

    def test_a_layout_value_the_renderer_takes_is_accepted(self):
        root = {"id": "root", "component": "Row", "children": ["a", "b"], "justify": "spaceBetween", "align": "start"}
        assert grid_card_adapter.validate_python(_tabs(components=[root, BASIS_A, BASIS_B]))

    @pytest.mark.parametrize("marker", ["[[card:2]]", "[[callout]]", "[[ card : 1 ]]"])
    def test_a_prose_marker_in_a_text_is_refused(self, marker):
        card = _tabs(components=[_tabs()["components"][0], _text("a", f"Siehe {marker}."), BASIS_B])
        assert "Reference cards from the prose, not inside a tab" in _refusal(card)

    def test_a_child_listed_twice_is_refused(self):
        card = _tabs(
            components=[
                {"id": "root", "component": "Row", "children": ["a", "b", "a"]},
                copy.deepcopy(BASIS_A),
                copy.deepcopy(BASIS_B),
            ]
        )
        assert "'a' is referenced more than once" in _refusal(card)

    def test_two_tabs_on_one_leaf_are_refused(self):
        root = {
            "id": "root",
            "component": "Tabs",
            "tabs": [{"title": "GK 4", "child": "a"}, {"title": "GK 5", "child": "a"}, {"title": "B", "child": "b"}],
        }
        card = _tabs(components=[root, copy.deepcopy(BASIS_A), copy.deepcopy(BASIS_B)])
        assert "'a' is referenced more than once" in _refusal(card)

    def test_a_leaf_in_a_tab_and_in_a_row_is_refused(self):
        root = {"id": "root", "component": "Tabs", "tabs": [{"title": "A", "child": "a"}, {"title": "R", "child": "r"}]}
        row = {"id": "r", "component": "Row", "children": ["a", "b"]}
        card = _tabs(components=[root, row, copy.deepcopy(BASIS_A), copy.deepcopy(BASIS_B)])
        assert "'a' is referenced more than once" in _refusal(card)

    def test_a_cycle_is_reported_as_a_cycle(self):
        card = _tabs(
            components=[
                {"id": "root", "component": "Row", "children": ["c1", "a"]},
                {"id": "c1", "component": "Column", "children": ["root", "a"]},
                _text("a", "x"),
            ]
        )
        # One leaf, so the count fails too; it ran first and named the wrong fault.
        refusal = _refusal(card)
        assert "Circular reference" in refusal
        assert "cards or Text blocks" not in refusal


class TestWhereASurfaceIsTaught:
    """Only the chat envelope teaches COMPOSE and recites a tab's [N]; only it offers a surface."""

    def test_the_shape_hint_is_the_compose_rule(self):
        from aiq_agent.cards.catalog import shape_hint_for

        hint = shape_hint_for("surface") or ""
        assert hint.startswith("COMPOSE.")
        assert '"component": "Tabs"' in hint
        # The generic entry told a model every text field is PLAIN TEXT, which a `Text` leaf is not.
        assert "PLAIN TEXT" not in hint

    def test_the_rendered_details_are_the_compose_rule(self):
        # describe_card, a skill's preferred cards and the turn decision's picks all render here.
        from aiq_agent.cards.catalog import render_card_details
        from aiq_agent.cards.envelope import compose_rule

        assert render_card_details(["surface"]) == compose_rule()
        with_another = render_card_details(["surface", "legal_basis"])
        assert with_another.endswith(compose_rule())
        assert '"legal_basis"' in with_another and "`Text` leaf is the one exception" in with_another

    def test_a_leaf_that_fails_is_repaired_from_its_own_shape(self):
        card = _tabs()
        del card["components"][1]["law"]
        validated, refusal = validate_model_card(card)
        assert validated is None and refusal is not None
        assert refusal.hint is not None and "COMPOSE." in refusal.hint
        assert '"legal_basis"' in refusal.hint and "shape:" in refusal.hint

    async def test_emit_card_refuses_a_surface(self):
        import json
        from unittest.mock import MagicMock

        from aiq_agent.cards.register import EmitCardConfig
        from aiq_agent.cards.register import emit_card
        from aiq_agent.cards.registry import CardRegistry
        from aiq_agent.cards.registry import reset_card_registry
        from aiq_agent.cards.registry import set_card_registry

        registry = CardRegistry()
        token = set_card_registry(registry)
        try:
            async with emit_card(EmitCardConfig(), MagicMock()) as info:
                message = await info.single_fn(card_json=json.dumps(_tabs()))
        finally:
            reset_card_registry(token)
        assert message.startswith("Error:") and "'surface'" in message
        assert registry.snapshot() == []

    async def test_describe_card_does_not_offer_a_surface(self):
        from unittest.mock import MagicMock

        from aiq_agent.cards.register import DescribeCardConfig
        from aiq_agent.cards.register import describe_card

        async with describe_card(DescribeCardConfig(), MagicMock()) as info:
            message = await info.single_fn(card_types="surface")
        assert message.startswith("No such card type: surface.")
        assert "surface" not in message.split("Available types:")[1]

    def test_the_post_hoc_validator_drops_a_surface(self):
        from aiq_agent.cards.models import validate_cards

        basis = {key: value for key, value in BASIS_A.items() if key not in ("id", "component")}
        validated = validate_cards([_tabs(), {**basis, "type": "legal_basis"}])
        assert [card["type"] for card in validated] == ["legal_basis"]

    def test_the_chat_contract_s_craft_names_no_card_it_withholds(self):
        from aiq_agent.cards.catalog import MARKDOWN_CARD_TYPES
        from aiq_agent.cards.catalog import render_card_doctrine

        doctrine = render_card_doctrine(markdown_first=True)
        withheld = [card for card in MARKDOWN_CARD_TYPES if re.search(rf"\b{card}\b", doctrine)]
        assert withheld == []
        assert "a table in the answer" in doctrine

    def test_the_post_hoc_prompt_withholds_the_surface(self):
        from aiq_agent.cards.prompt import build_card_generation_prompt

        assert '"surface"' not in build_card_generation_prompt()

    def test_the_emit_card_index_withholds_the_surface(self):
        from aiq_agent.cards.register import _build_tool_description

        assert '"surface"' not in _build_tool_description()

    def test_the_chat_contract_still_offers_it(self):
        assert '"surface"' in render_envelope_cards_contract()

    def test_the_compose_rule_states_the_validators_limits(self):
        from aiq_agent.cards import models

        contract = render_envelope_cards_contract()
        assert f"2 to {models.SURFACE_MAX_CHILDREN} children" in contract
        assert f"2 to {models.SURFACE_MAX_TABS} tabs" in contract
        assert f"at most {models.SURFACE_TEXT_MAX} characters" in contract
        assert "envelope field" in contract


class TestPipelineRecital:
    """`answer_pipeline._recite_surface_cards` applies the recital to the turn's registry."""

    def test_a_surface_that_would_collapse_is_stored_recited_in_place(self):
        from types import SimpleNamespace

        from aiq_agent.agents.piloti.answer_pipeline import _recite_surface_cards
        from aiq_agent.cards.registry import CardRegistry
        from aiq_agent.cards.registry import reset_card_registry
        from aiq_agent.cards.registry import set_card_registry

        before = {"type": "legal_basis", "law": "OIB-Richtlinie 2", "summary": "x"}
        card = _tabs(components=[_tabs()["components"][0], _text("a", "[3]"), _text("b", "REI 90 [5]")])
        registry = CardRegistry()
        registry.add(before)
        registry.add(card)
        token = set_card_registry(registry)
        try:
            _recite_surface_cards({1: 1, 5: 2}, (SimpleNamespace(number=1), SimpleNamespace(number=2)))
        finally:
            reset_card_registry(token)
        stored = registry.snapshot()
        # Positions stay: a later [[card:2]] still names this card.
        assert len(stored) == 2 and stored[0] == before
        assert "[5]" not in str(stored[1]) and "REI 90 [2]" in str(stored[1])
        grid_card_adapter.validate_python(stored[1])

    def test_a_merged_duplicate_in_a_tab_follows_the_prose(self):
        from types import SimpleNamespace

        from aiq_agent.agents.piloti.answer_pipeline import _recite_surface_cards
        from aiq_agent.cards.registry import CardRegistry
        from aiq_agent.cards.registry import reset_card_registry
        from aiq_agent.cards.registry import set_card_registry

        card = _tabs(components=[_tabs()["components"][0], copy.deepcopy(BASIS_A), _text("b", "Brandwand [2].")])
        registry = CardRegistry()
        registry.add(card)
        removed = ({"number": 2, "line": "- [2] oib.pdf, p.3", "reason": "duplicate_of_citation_1"},)
        token = set_card_registry(registry)
        try:
            _recite_surface_cards({1: 1}, (SimpleNamespace(number=1),), removed)
        finally:
            reset_card_registry(token)
        texts = [c["text"] for c in registry.snapshot()[0]["components"] if c.get("component") == "Text"]
        assert texts == ["Brandwand [1]."]
