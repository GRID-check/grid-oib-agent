"""Tests for the conversation-scoped CardRegistry and the emit_card tool path."""

import json

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
