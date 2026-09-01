"""Tests for stripping and salvaging leaked DeepSeek DSML tool-call blocks."""

from __future__ import annotations

import pytest

from aiq_agent.agents.shallow_researcher.dsml import strip_and_salvage_dsml_tool_calls
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry

# Fullwidth vertical bar (U+FF5C) — the DSML delimiter.
BAR = "｜"


def _open(inner: str) -> str:
    """Build an opening DSML tag: ``<｜DSML｜{inner}>``."""
    return "<" + BAR + "DSML" + BAR + inner + ">"


def _close(inner: str) -> str:
    """Build a closing DSML tag: ``</｜DSML｜{inner}>``."""
    return "</" + BAR + "DSML" + BAR + inner + ">"


# The exact production shape from the design: an emit_card invoke whose
# card_json parameter is followed by a raw JSON object.
INVOKE_OPEN = _open('invoke name="emit_card"')
CARD_PARAM_OPEN = _open('parameter name="card_json" string="true"')


def _leaked_emit_card(card_json: str) -> str:
    return INVOKE_OPEN + "\n" + CARD_PARAM_OPEN + card_json


@pytest.fixture
def card_registry():
    """Bind a fresh conversation card registry for the duration of a test."""
    registry = CardRegistry()
    token = set_card_registry(registry)
    try:
        yield registry
    finally:
        reset_card_registry(token)


class TestConservativeStripping:
    def test_plain_text_untouched(self):
        text = "The maximum building height here is 12 m, per OIB [1]."
        assert strip_and_salvage_dsml_tool_calls(text) is text

    def test_text_discussing_tool_calls_untouched(self):
        # No DSML marker → conservative no-op even though it mentions the words.
        text = 'I would call emit_card with a "card_json" parameter, but I will not.'
        assert strip_and_salvage_dsml_tool_calls(text) == text

    def test_empty_input(self):
        assert strip_and_salvage_dsml_tool_calls("") == ""


class TestStripLeakedBlock:
    def test_strips_trailing_leaked_invoke_without_closers(self, card_registry):
        answer = "Here is the grounded answer [1]."
        leaked = _leaked_emit_card('{"type": "ifc_model_picker", "title": "Height check"}')
        result = strip_and_salvage_dsml_tool_calls(answer + "\n\n" + leaked)
        assert result == answer
        assert BAR not in result

    def test_preserves_prose_after_wellformed_block(self, card_registry):
        block = (
            _open("tool_calls")
            + INVOKE_OPEN
            + CARD_PARAM_OPEN
            + '{"type": "ifc_model_picker", "title": "T"}'
            + _close("parameter")
            + _close("invoke")
            + _close("tool_calls")
        )
        result = strip_and_salvage_dsml_tool_calls("Answer body.\n" + block + "\nTrailing note.")
        assert "Answer body." in result
        assert "Trailing note." in result
        assert BAR not in result


class TestCardSalvage:
    def test_salvages_emit_card_into_registry(self, card_registry):
        leaked = _leaked_emit_card('{"type": "ifc_model_picker", "title": "Egress width"}')
        strip_and_salvage_dsml_tool_calls("Answer.\n" + leaked)
        cards = card_registry.snapshot()
        assert len(cards) == 1
        assert cards[0]["type"] == "ifc_model_picker"
        assert cards[0]["title"] == "Egress width"

    def test_invalid_card_json_is_stripped_but_not_registered(self, card_registry):
        leaked = _leaked_emit_card('{"type": "ifc_model_picker"}')  # missing required title
        result = strip_and_salvage_dsml_tool_calls("Answer.\n" + leaked)
        assert "Answer." in result
        assert BAR not in result
        assert card_registry.snapshot() == []

    def test_salvage_no_registry_bound_is_fail_soft(self):
        # No card registry in context → still strips, just cannot register.
        leaked = _leaked_emit_card('{"type": "summary", "title": "T", "content": "C"}')
        result = strip_and_salvage_dsml_tool_calls("Answer.\n" + leaked)
        assert result == "Answer."
