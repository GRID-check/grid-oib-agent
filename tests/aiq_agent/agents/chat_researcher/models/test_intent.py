"""Tests for IntentResult model."""

import pytest
from pydantic import ValidationError

from aiq_agent.agents.chat_researcher.models.intent import IntentResult


class TestIntentResult:
    """Tests for the IntentResult Pydantic model."""

    def test_intent_result_meta(self):
        """Test creating IntentResult with meta intent."""
        result = IntentResult(intent="meta")
        assert result.intent == "meta"
        assert result.raw is None

    def test_intent_result_research(self):
        """Test creating IntentResult with research intent."""
        result = IntentResult(intent="research")
        assert result.intent == "research"
        assert result.raw is None

    def test_intent_result_with_raw_data(self):
        """Test creating IntentResult with raw classification data."""
        raw_data = {"confidence": 0.95, "reasoning": "Query asks for information"}
        result = IntentResult(intent="research", raw=raw_data)
        assert result.intent == "research"
        assert result.raw == raw_data

    def test_intent_result_invalid_intent(self):
        """Test that invalid intent values raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            IntentResult(intent="invalid")

        errors = exc_info.value.errors()
        assert len(errors) == 1
        assert "intent" in str(errors[0]["loc"])

    def test_intent_result_missing_intent(self):
        """Test that missing intent raises ValidationError."""
        with pytest.raises(ValidationError):
            IntentResult()

    def test_intent_result_dict_conversion(self):
        """Test IntentResult can be converted to dict."""
        result = IntentResult(intent="meta", raw={"key": "value"})
        result_dict = result.model_dump()

        assert result_dict["intent"] == "meta"
        assert result_dict["raw"] == {"key": "value"}

    def test_intent_result_json_serialization(self):
        """Test IntentResult can be serialized to JSON."""
        result = IntentResult(intent="research", raw={"score": 0.9})
        json_str = result.model_dump_json()

        assert '"intent":"research"' in json_str
        assert '"raw":' in json_str

    def test_intent_result_from_dict(self):
        """Test creating IntentResult from a dictionary."""
        data = {"intent": "meta", "raw": None}
        result = IntentResult.model_validate(data)

        assert result.intent == "meta"
        assert result.raw is None
