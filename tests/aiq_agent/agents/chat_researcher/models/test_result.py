"""Tests for ShallowResult model."""

import pytest
from pydantic import ValidationError

from aiq_agent.agents.chat_researcher.models.result import ShallowResult


class TestShallowResult:
    """Tests for the ShallowResult Pydantic model."""

    def test_shallow_result_basic(self):
        """Test creating a basic ShallowResult."""
        result = ShallowResult(
            answer="The answer is 42.",
            confidence="high",
            escalate_to_deep=False,
        )
        assert result.answer == "The answer is 42."
        assert result.confidence == "high"
        assert result.escalate_to_deep is False
        assert result.escalation_reason is None

    def test_shallow_result_with_escalation(self):
        """Test creating ShallowResult with escalation."""
        result = ShallowResult(
            answer="Partial answer found.",
            confidence="low",
            escalate_to_deep=True,
            escalation_reason="Query requires more comprehensive research",
        )
        assert result.answer == "Partial answer found."
        assert result.confidence == "low"
        assert result.escalate_to_deep is True
        assert result.escalation_reason == "Query requires more comprehensive research"

    def test_shallow_result_confidence_levels(self):
        """Test all valid confidence levels."""
        for level in ["low", "medium", "high"]:
            result = ShallowResult(
                answer="Test",
                confidence=level,
                escalate_to_deep=False,
            )
            assert result.confidence == level

    def test_shallow_result_invalid_confidence(self):
        """Test that invalid confidence level raises ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            ShallowResult(
                answer="Test",
                confidence="very_high",
                escalate_to_deep=False,
            )

        errors = exc_info.value.errors()
        assert len(errors) == 1
        assert "confidence" in str(errors[0]["loc"])

    def test_shallow_result_missing_required_fields(self):
        """Test that missing required fields raise ValidationError."""
        with pytest.raises(ValidationError):
            ShallowResult(answer="Test")

        with pytest.raises(ValidationError):
            ShallowResult(confidence="high", escalate_to_deep=False)

    def test_shallow_result_dict_conversion(self):
        """Test ShallowResult can be converted to dict."""
        result = ShallowResult(
            answer="Answer text",
            confidence="medium",
            escalate_to_deep=True,
            escalation_reason="Needs more info",
        )
        result_dict = result.model_dump()

        assert result_dict["answer"] == "Answer text"
        assert result_dict["confidence"] == "medium"
        assert result_dict["escalate_to_deep"] is True
        assert result_dict["escalation_reason"] == "Needs more info"

    def test_shallow_result_json_serialization(self):
        """Test ShallowResult can be serialized to JSON."""
        result = ShallowResult(
            answer="Answer",
            confidence="high",
            escalate_to_deep=False,
        )
        json_str = result.model_dump_json()

        assert '"answer":"Answer"' in json_str
        assert '"confidence":"high"' in json_str
        assert '"escalate_to_deep":false' in json_str

    def test_shallow_result_from_dict(self):
        """Test creating ShallowResult from a dictionary."""
        data = {
            "answer": "Dict answer",
            "confidence": "medium",
            "escalate_to_deep": False,
            "escalation_reason": None,
        }
        result = ShallowResult.model_validate(data)

        assert result.answer == "Dict answer"
        assert result.confidence == "medium"
        assert result.escalate_to_deep is False

    def test_shallow_result_empty_answer(self):
        """Test ShallowResult with empty answer string."""
        result = ShallowResult(
            answer="",
            confidence="low",
            escalate_to_deep=True,
            escalation_reason="Could not find answer",
        )
        assert result.answer == ""

    def test_shallow_result_multiline_answer(self):
        """Test ShallowResult with multiline answer."""
        multiline_answer = """Line 1
Line 2
Line 3"""
        result = ShallowResult(
            answer=multiline_answer,
            confidence="high",
            escalate_to_deep=False,
        )
        assert result.answer == multiline_answer
