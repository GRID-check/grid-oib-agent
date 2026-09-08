"""Tests for ShallowResult model."""

import pytest
from pydantic import ValidationError

from aiq_agent.agents.chat_researcher.models.result import ShallowResult


class TestShallowResult:
    """The shallow agent's structured verdict: an answer and whether it asked for deep research."""

    def test_shallow_result_basic(self):
        result = ShallowResult(answer="The answer is 42.", escalate_to_deep=False)
        assert result.answer == "The answer is 42."
        assert result.escalate_to_deep is False
        assert result.escalation_reason is None

    def test_shallow_result_with_escalation(self):
        result = ShallowResult(
            answer="Partial answer found.",
            escalate_to_deep=True,
            escalation_reason="Query requires more comprehensive research",
        )
        assert result.escalate_to_deep is True
        assert result.escalation_reason == "Query requires more comprehensive research"

    def test_shallow_result_missing_required_fields(self):
        with pytest.raises(ValidationError):
            ShallowResult(answer="Test")
        with pytest.raises(ValidationError):
            ShallowResult(escalate_to_deep=False)

    def test_the_internal_confidence_proxy_is_gone_and_a_checkpointed_one_is_ignored(self):
        """``confidence`` had no reader. A checkpoint written before its removal
        still restores: the stray key is ignored, not rejected."""
        assert "confidence" not in ShallowResult.model_fields
        restored = ShallowResult.model_validate({"answer": "a", "confidence": "low", "escalate_to_deep": True})
        assert restored.escalate_to_deep is True

    def test_shallow_result_round_trips_through_dict_and_json(self):
        result = ShallowResult(answer="Answer text", escalate_to_deep=True, escalation_reason="Needs more info")
        assert ShallowResult.model_validate(result.model_dump()) == result
        assert ShallowResult.model_validate_json(result.model_dump_json()) == result

    def test_shallow_result_empty_and_multiline_answers(self):
        assert ShallowResult(answer="", escalate_to_deep=True).answer == ""
        assert ShallowResult(answer="Line 1\nLine 2", escalate_to_deep=False).answer == "Line 1\nLine 2"
