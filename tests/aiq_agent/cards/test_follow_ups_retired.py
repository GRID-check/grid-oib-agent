"""``follow_ups`` is RETIRED, and retired has two halves that must both hold.

The post-answer ``follow_ups`` stage now computes the next questions after the
answer is written, gated by deterministic Python, and delivers them as a
``grid_stage_message`` frame rendered below the answer
(``aiq_agent/stages/follow_ups.py``; docs/architecture/post-answer-stages.md
§7.10). The card it replaces is retired through ``SYSTEM_CARD_TYPES`` rather than
deleted, and the whole reason that constant exists is that those are two
different things:

* **The model loses the ability to emit a new one.** All three emission paths —
  the ``emit_card`` tool, post-hoc batch generation (``validate_cards``) and the
  DSML salvage — read ``SYSTEM_CARD_TYPES``, and none of them may let one
  through. A path that still accepted the card would put chips back INSIDE the
  answer on some turns and below it on others, which is the one outcome worse
  than either placement.
* **Every card already stored keeps working.** Thousands of ``follow_ups`` cards
  sit in ``messages.metadata.cards`` and are re-validated on every render. If
  retiring the card cost a historical thread its chips, this would be a deletion
  wearing a retirement's clothes — and the honest version of that is removing the
  union member, which the design explicitly refuses.

The second half is the one that fails quietly, so it is asserted first and
against the same adapter the render path uses.
"""

from __future__ import annotations

import json
import logging
from unittest.mock import MagicMock

import pytest

from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_doctrine
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.models import validate_cards
from aiq_agent.cards.prompt import build_card_generation_prompt
from aiq_agent.cards.registry import get_or_create_card_registry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry

#: A `follow_ups` card exactly as one sits in a stored message's metadata today,
#: taken from the shape `FollowUpsCard` has always validated: a title, and
#: between two and four items each with a question and an optional hint.
STORED_CARD = {
    "type": "follow_ups",
    "title": "Weiterführende Fragen",
    "items": [
        {"question": "Wie wird das Fluchtniveau gemessen?", "hint": "Messpunkt und Bezugsebene"},
        {"question": "Ändert sich die Einstufung, wenn das Dachgeschoß ausgebaut wird?"},
    ],
}


class TestAStoredCardStillParsesAndRenders:
    """Half one: nothing already written down may break."""

    def test_the_union_still_accepts_a_stored_follow_ups_card(self):
        # `grid_card_adapter` is what every read path goes through, so this is
        # the assertion that a stored card is still a card at all. Removing the
        # union member instead of retiring the type is exactly what this fails on.
        card = grid_card_adapter.validate_python(STORED_CARD)

        assert card.type == "follow_ups"
        assert [item.question for item in card.items] == [
            "Wie wird das Fluchtniveau gemessen?",
            "Ändert sich die Einstufung, wenn das Dachgeschoß ausgebaut wird?",
        ]
        assert card.items[0].hint == "Messpunkt und Bezugsebene"

    def test_a_stored_card_round_trips_through_serialization_unchanged(self):
        # The render path re-serializes what it validated. A retirement that
        # dropped a field on the way out would lose a reader's hints without
        # ever failing validation.
        card = grid_card_adapter.validate_python(STORED_CARD)

        assert card.model_dump(exclude_none=True) == STORED_CARD

    def test_the_type_is_still_a_member_of_the_union(self):
        from aiq_agent.cards.models import GridCard

        types = {getattr(c.model_fields["type"].annotation, "__args__", ("?",))[0] for c in GridCard.__args__}
        assert "follow_ups" in types


class TestTheModelCanNoLongerEmitOne:
    """Half two: every emission path refuses a NEW one."""

    def test_it_is_declared_retired(self):
        assert "follow_ups" in SYSTEM_CARD_TYPES

    @pytest.mark.asyncio
    async def test_emit_card_refuses_it(self):
        from aiq_agent.cards.register import EmitCardConfig
        from aiq_agent.cards.register import emit_card

        registry = get_or_create_card_registry("conv-emit-retired-follow-ups")
        registry.clear()
        token = set_card_registry(registry)
        try:
            async with emit_card(EmitCardConfig(), MagicMock()) as info:
                message = await info.single_fn(card_json=json.dumps(STORED_CARD))
        finally:
            reset_card_registry(token)

        # It validated as a real union member — that is half one — and was
        # refused anyway, which is the whole shape of a retirement.
        assert message.startswith("Error")
        assert "follow_ups" in message
        assert registry.snapshot() == []

    def test_post_hoc_generation_drops_it(self, caplog):
        # `validate_cards` is the deep-research batch path. It must drop the card
        # rather than store it, or a report would still ship chips inside itself.
        # A good card rides along so a pass cannot come from validate_cards
        # returning nothing at all.
        good = {"type": "callout", "kind": "frist", "text": "Die Bauverhandlung ist binnen acht Wochen anzuberaumen."}
        with caplog.at_level(logging.WARNING):
            kept = validate_cards([STORED_CARD, good])

        assert [card["type"] for card in kept] == ["callout"]
        assert any("follow_ups" in record.getMessage() for record in caplog.records)

    def test_the_dsml_salvage_drops_it(self):
        # Leaked DSML tool-call text is the third emission path: a `follow_ups`
        # block scraped out of the answer must not be registered either.
        from aiq_agent.agents.shallow_researcher.dsml import _salvage_card

        registry = get_or_create_card_registry("conv-dsml-retired-follow-ups")
        registry.clear()
        token = set_card_registry(registry)
        try:
            _salvage_card(json.dumps(STORED_CARD))
            assert registry.snapshot() == []
            # The same salvage still works for a card that is not retired, so
            # this asserts the refusal and not a broken salvage.
            _salvage_card(json.dumps({"type": "callout", "kind": "tipp", "text": "Fruh mit der Behorde sprechen."}))
            assert [card["type"] for card in registry.snapshot()] == ["callout"]
        finally:
            reset_card_registry(token)


class TestItIsAdvertisedNowhere:
    """A retired card the catalog still describes is a card the model will try."""

    def test_it_is_not_a_model_facing_type(self):
        assert "follow_ups" not in model_facing_card_types()

    @pytest.mark.parametrize(
        "surface",
        [
            pytest.param(lambda: render_card_index(), id="l1_index"),
            pytest.param(lambda: render_card_doctrine(include_ifc_triggers=True), id="chat_doctrine"),
            pytest.param(lambda: render_card_doctrine(include_ifc_triggers=False), id="post_hoc_doctrine"),
            pytest.param(lambda: build_card_generation_prompt(), id="post_hoc_prompt"),
        ],
    )
    def test_no_model_facing_surface_names_it(self, surface):
        assert "follow_ups" not in surface()

    def test_describe_card_will_not_hand_back_its_shape(self):
        # `render_card_details` is what `describe_card` and the skills substrate's
        # `grid-cards` block both render. A shape it still returned would let a
        # skill author put the card back into context by naming it.
        assert render_card_details(["follow_ups"]) == ""
        assert render_card_details(["callout", "follow_ups"]).count("follow_ups") == 0
