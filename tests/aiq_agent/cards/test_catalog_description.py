"""Tests for ``describe_card_catalog`` — the card catalog as data, for people.

The model-facing catalog (``render_card_catalog``) and this one are rendered
from the same union but answer opposite needs: the model must not learn that
system cards exist, while a human catalog is wrong if it has holes in it. These
tests pin that difference, and pin that the description stays derived from the
models rather than drifting into a hand-maintained list.
"""

from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import describe_card_catalog
from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.models import GridCard

_CARD_TYPES = [getattr(c.model_fields["type"].annotation, "__args__", ("?",))[0] for c in GridCard.__args__]


def test_describes_every_union_member():
    """A new card type is catalogued by adding it to the union — nothing else."""
    described = [card["type"] for card in describe_card_catalog()["cards"]]
    assert described == _CARD_TYPES


def test_includes_system_cards_the_model_catalog_hides():
    """The human catalog lists what the product can render, including system cards."""
    cards = {card["type"]: card for card in describe_card_catalog()["cards"]}
    model_facing = render_card_catalog()

    for card_type in SYSTEM_CARD_TYPES:
        assert cards[card_type]["emittedBy"] == "system"
        assert f'"{card_type}"' not in model_facing

    for card_type in set(_CARD_TYPES) - SYSTEM_CARD_TYPES:
        assert cards[card_type]["emittedBy"] == "agent"


def test_flags_the_cards_that_ask_the_user_to_decide():
    cards = {card["type"]: card for card in describe_card_catalog()["cards"]}
    interactive = {t for t, card in cards.items() if card["interaction"] == "interactive"}
    assert interactive == set(INTERACTIVE_CARD_TYPES)


def test_field_specs_carry_type_requiredness_and_description():
    summary = next(c for c in describe_card_catalog()["cards"] if c["type"] == "summary")
    fields = {field["name"]: field for field in summary["fields"]}

    # `type` is the discriminator, not a value anyone can request — it is the
    # card's identity and would only be noise in a catalog keyed by it.
    assert "type" not in fields
    assert fields["title"] == {
        "name": "title",
        "type": "string",
        "required": True,
        "description": "Short title for the summary card",
        "constraints": ["non-empty"],
    }
    assert fields["key_points"]["type"] == "[string]"
    assert fields["key_points"]["required"] is False


def test_nested_shapes_are_defined_once_as_building_blocks():
    """A card body may name a shape; the catalog must then define that shape."""
    catalog = describe_card_catalog()
    blocks = catalog["buildingBlocks"]

    checklist = next(c for c in catalog["cards"] if c["type"] == "requirement_checklist")
    items = next(f for f in checklist["fields"] if f["name"] == "items")
    assert items["type"] == "[ChecklistItem]"
    assert "ChecklistItem" in blocks

    # A block may name further blocks (ChecklistItem -> NormReference). Those are
    # collected transitively, so the catalog never dead-ends on a shape it names.
    reference = next(f for f in blocks["ChecklistItem"] if f["name"] == "reference")
    assert reference["type"] == "NormReference"
    assert "NormReference" in blocks


def test_examples_come_from_the_shared_worked_examples():
    cards = {card["type"]: card for card in describe_card_catalog()["cards"]}
    assert cards["ifc_compliance"]["example"]["model_file"] == "haus-a.ifc"
    # Cards without a worked example say so explicitly rather than omitting the key.
    assert cards["summary"]["example"] is None


def test_summary_is_the_first_docstring_paragraph_only():
    """Contributor guidance in a docstring is not a description of the card."""
    memory_proposal = next(c for c in describe_card_catalog()["cards"] if c["type"] == "memory_proposal")
    assert memory_proposal["summary"] == ("A proposal to save a finding to long-term memory, confirmed by the user.")
