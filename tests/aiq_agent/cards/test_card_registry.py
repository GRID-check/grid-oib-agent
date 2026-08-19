"""Tests for the conversation-scoped CardRegistry and the emit_card tool path."""

import json
import logging

import pytest

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import get_card_registry
from aiq_agent.cards.registry import get_or_create_card_registry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry


def _emit(card_json: str) -> str:
    """Mirror the emit_card tool body against the active registry."""
    try:
        payload = json.loads(card_json)
    except (json.JSONDecodeError, TypeError) as exc:
        return f"Error: card_json is not valid JSON ({exc})."
    if not isinstance(payload, dict):
        return "Error: card_json must be a single JSON object with a 'type' field."
    try:
        validated = grid_card_adapter.validate_python(payload).model_dump(exclude_none=True)
    except Exception as exc:
        return f"Error: card failed validation: {exc}."
    registry = get_card_registry()
    if registry is None:
        return "Noted, but no card channel is available."
    registry.add(validated)
    return f"Card '{validated['type']}' will be shown with your answer."


class TestCardRegistry:
    def test_add_and_snapshot(self):
        reg = CardRegistry()
        reg.add({"type": "summary", "title": "A"})
        reg.add({"type": "legal_basis", "law": "OIB-2"})
        assert [c["type"] for c in reg.snapshot()] == ["summary", "legal_basis"]

    def test_len_is_the_position_of_the_next_card(self):
        # emit_card hands the model `[[card:N]]` with N read off this count.
        reg = CardRegistry()
        assert len(reg) == 0
        reg.add({"type": "summary", "title": "A"})
        assert len(reg) == 1

    def test_clear(self):
        reg = CardRegistry()
        reg.add({"type": "summary", "title": "A"})
        reg.clear()
        assert reg.snapshot() == []

    def test_snapshot_is_a_copy(self):
        reg = CardRegistry()
        reg.add({"type": "summary", "title": "A"})
        snap = reg.snapshot()
        snap.append({"type": "summary", "title": "B"})
        assert len(reg.snapshot()) == 1

    def test_same_conversation_shares_registry(self):
        a = get_or_create_card_registry("conv-1")
        b = get_or_create_card_registry("conv-1")
        assert a is b

    def test_none_conversation_is_isolated(self):
        a = get_or_create_card_registry(None)
        b = get_or_create_card_registry(None)
        assert a is not b


class TestEmitCardBody:
    def test_valid_card_is_registered(self):
        reg = get_or_create_card_registry("conv-emit-1")
        reg.clear()
        token = set_card_registry(reg)
        try:
            msg = _emit('{"type": "summary", "title": "Answer", "content": "Quick."}')
        finally:
            reset_card_registry(token)
        assert "will be shown" in msg
        cards = reg.snapshot()
        assert len(cards) == 1
        assert cards[0]["type"] == "summary"

    def test_invalid_json_registers_nothing(self):
        reg = get_or_create_card_registry("conv-emit-2")
        reg.clear()
        token = set_card_registry(reg)
        try:
            msg = _emit("not valid json")
        finally:
            reset_card_registry(token)
        assert msg.startswith("Error")
        assert reg.snapshot() == []

    def test_unknown_card_type_registers_nothing(self):
        reg = get_or_create_card_registry("conv-emit-3")
        reg.clear()
        token = set_card_registry(reg)
        try:
            msg = _emit('{"type": "not_a_real_card", "foo": "bar"}')
        finally:
            reset_card_registry(token)
        assert msg.startswith("Error")
        assert reg.snapshot() == []

    def test_no_active_registry_does_not_raise(self):
        # No set_card_registry -> get_card_registry() is None
        msg = _emit('{"type": "summary", "title": "A"}')
        assert "no card channel" in msg

    @pytest.mark.parametrize(
        "card_json",
        [
            '{"type": "summary", "title": "Egress widths"}',
            '{"type": "legal_basis", "law": "OIB-Richtlinie 2", "article": "2.1"}',
        ],
    )
    def test_multiple_real_types(self, card_json):
        reg = get_or_create_card_registry("conv-emit-multi")
        reg.clear()
        token = set_card_registry(reg)
        try:
            msg = _emit(card_json)
        finally:
            reset_card_registry(token)
        assert "will be shown" in msg
        assert len(reg.snapshot()) == 1


class TestEmitCardRejectsSystemCards:
    """The real emit_card tool must refuse to emit a system-only card type."""

    @pytest.mark.asyncio
    async def test_memory_proposal_is_rejected(self):
        from unittest.mock import MagicMock

        from aiq_agent.cards.register import EmitCardConfig
        from aiq_agent.cards.register import emit_card

        reg = get_or_create_card_registry("conv-emit-system")
        reg.clear()
        token = set_card_registry(reg)
        payload = json.dumps(
            {
                "type": "memory_proposal",
                "title": "Save this finding?",
                "content": "The firm always uses REI 90 for GK4.",
                "kind": "preference",
            }
        )
        try:
            async with emit_card(EmitCardConfig(), MagicMock()) as info:
                msg = await info.single_fn(card_json=payload)
        finally:
            reset_card_registry(token)
        # It validated as a real union member but was rejected as system-emitted.
        assert msg.startswith("Error")
        assert "system-emitted" in msg
        # Nothing was added to the registry.
        assert reg.snapshot() == []


class TestARefusedCardIsVisibleAfterTheTurn:
    """ "The model never tried" and "we refused it" must not look the same in a log.

    Diagnosing a turn that shipped without its card ran into this: only the
    SUCCESS path logged, so a turn where the model called ``emit_card`` and got a
    validation error back left exactly the same silence as one where it never
    called at all. The two have opposite fixes — the first is a shape the model
    cannot fill in, the second is a doctrine that never got the card named — and
    with nothing to separate them the choice is a guess.

    ``warning`` rather than ``info``: each of these is a card the reader was
    meant to get and did not, and it is invisible from the answer, which reads
    as a perfectly ordinary reply with no card on it.
    """

    @staticmethod
    async def _emit_real(registry, payload) -> str:
        from unittest.mock import MagicMock

        from aiq_agent.cards.register import EmitCardConfig
        from aiq_agent.cards.register import emit_card

        token = set_card_registry(registry)
        try:
            async with emit_card(EmitCardConfig(), MagicMock()) as info:
                return await info.single_fn(card_json=payload if isinstance(payload, str) else json.dumps(payload))
        finally:
            reset_card_registry(token)

    @pytest.mark.asyncio
    async def test_a_validation_failure_logs_the_type_the_model_reached_for(self, caplog):
        reg = get_or_create_card_registry("conv-refusal-1")
        reg.clear()
        with caplog.at_level(logging.WARNING, logger="aiq_agent.cards.register"):
            msg = await self._emit_real(reg, {"type": "process_map", "title": "Bauverfahren"})

        assert msg.startswith("Error")
        records = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert records, "a refused card left no trace at all — the exact gap this closes"
        # The TYPE is the load-bearing half: it says which card the model knew it
        # wanted, which is the one thing a silent turn cannot tell you.
        assert "process_map" in records[0].getMessage()
        assert "rejected" in records[0].getMessage()

    @pytest.mark.asyncio
    async def test_unparseable_json_logs_too(self, caplog):
        reg = get_or_create_card_registry("conv-refusal-2")
        reg.clear()
        with caplog.at_level(logging.WARNING, logger="aiq_agent.cards.register"):
            msg = await self._emit_real(reg, "{not json")

        assert msg.startswith("Error")
        assert any("not valid JSON" in r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)

    @pytest.mark.asyncio
    async def test_a_system_card_refusal_logs_too(self, caplog):
        reg = get_or_create_card_registry("conv-refusal-3")
        reg.clear()
        with caplog.at_level(logging.WARNING, logger="aiq_agent.cards.register"):
            msg = await self._emit_real(
                reg, {"type": "memory_proposal", "title": "X", "content": "Y", "scope": "project"}
            )

        assert msg.startswith("Error")
        assert any("memory_proposal" in r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)

    @pytest.mark.asyncio
    async def test_a_successful_card_logs_at_info_and_not_as_a_warning(self, caplog):
        # The success line predates this and stays where it is: a refusal is the
        # abnormal outcome and has to be greppable apart from the normal one.
        reg = get_or_create_card_registry("conv-refusal-4")
        reg.clear()
        with caplog.at_level(logging.INFO, logger="aiq_agent.cards.register"):
            msg = await self._emit_real(reg, {"type": "summary", "title": "Treppe"})

        assert not msg.startswith("Error")
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert any("registered a 'summary' card" in r.getMessage() for r in caplog.records)


class TestEmitCardPlacementMarker:
    """The marker is how a card reaches the paragraph it belongs to.

    Without it every card renders as a block after the answer, which is where a
    stair diagram helps least — so ``emit_card`` must hand the agent the exact
    marker to write, and it must name the card's own position.
    """

    @staticmethod
    async def _emit_real(registry, payload: dict) -> str:
        from unittest.mock import MagicMock

        from aiq_agent.cards.register import EmitCardConfig
        from aiq_agent.cards.register import emit_card

        token = set_card_registry(registry)
        try:
            async with emit_card(EmitCardConfig(), MagicMock()) as info:
                return await info.single_fn(card_json=json.dumps(payload))
        finally:
            reset_card_registry(token)

    @pytest.mark.asyncio
    async def test_first_card_is_card_one(self):
        reg = get_or_create_card_registry("conv-marker-1")
        reg.clear()
        msg = await self._emit_real(reg, {"type": "summary", "title": "Treppe"})
        assert "[[card:1]]" in msg
        # The agent has to be told what to DO with it, not just handed it.
        assert "line of its own" in msg

    @pytest.mark.asyncio
    async def test_marker_counts_with_the_registry(self):
        reg = get_or_create_card_registry("conv-marker-2")
        reg.clear()
        first = await self._emit_real(reg, {"type": "summary", "title": "Eins"})
        second = await self._emit_real(reg, {"type": "summary", "title": "Zwei"})
        assert "[[card:1]]" in first
        assert "[[card:2]]" in second
        # The number IS the position in the array the frontend receives; the two
        # drifting apart would draw the wrong card at the marker.
        assert [c["title"] for c in reg.snapshot()] == ["Eins", "Zwei"]

    @pytest.mark.asyncio
    async def test_a_rejected_card_does_not_consume_a_number(self):
        reg = get_or_create_card_registry("conv-marker-3")
        reg.clear()
        await self._emit_real(reg, {"type": "summary", "title": "Eins"})
        rejected = await self._emit_real(reg, {"type": "summary"})
        assert rejected.startswith("Error")
        assert "[[card:2]]" in await self._emit_real(reg, {"type": "summary", "title": "Zwei"})

    def test_doctrine_tells_the_agent_where_to_put_the_marker(self):
        from aiq_agent.cards.register import _CARD_DOCTRINE

        assert "[[card:" in _CARD_DOCTRINE
        assert "line of its own" in _CARD_DOCTRINE
