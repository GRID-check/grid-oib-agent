"""Tests for ClarificationResponse model."""

from aiq_agent.agents.clarifier.models import ClarificationResponse


class TestClarificationResponse:
    """Tests for the ClarificationResponse model."""

    def test_create_needs_clarification_true(self):
        """Test creating response when clarification is needed."""
        response = ClarificationResponse(needs_clarification=True, clarification_question="What aspect interests you?")
        assert response.needs_clarification is True
        assert response.clarification_question == "What aspect interests you?"

    def test_create_needs_clarification_false(self):
        """Test creating response when clarification is complete."""
        response = ClarificationResponse(needs_clarification=False, clarification_question=None)
        assert response.needs_clarification is False
        assert response.clarification_question is None

    def test_is_complete_when_not_needed(self):
        """Test is_complete returns True when clarification not needed."""
        response = ClarificationResponse(needs_clarification=False, clarification_question=None)
        assert response.is_complete() is True

    def test_is_complete_when_needed(self):
        """Test is_complete returns False when clarification is needed."""
        response = ClarificationResponse(needs_clarification=True, clarification_question="What scope?")
        assert response.is_complete() is False

    def test_is_valid_with_question_mark(self):
        """Test is_valid returns True when question contains '?'."""
        response = ClarificationResponse(needs_clarification=True, clarification_question="What aspect interests you?")
        assert response.is_valid() is True

    def test_is_valid_without_question_mark(self):
        """Test is_valid returns True even without '?' - only checks question exists."""
        response = ClarificationResponse(needs_clarification=True, clarification_question="Please provide more details")
        assert response.is_valid() is True

    def test_is_valid_with_empty_question(self):
        """Test is_valid returns False when question is empty."""
        response = ClarificationResponse(needs_clarification=True, clarification_question="")
        assert response.is_valid() is False

    def test_is_valid_with_none_question_when_needed(self):
        """Test is_valid returns False when question is None but needed."""
        response = ClarificationResponse(needs_clarification=True, clarification_question=None)
        assert response.is_valid() is False

    def test_is_valid_when_not_needed(self):
        """Test is_valid returns True when clarification not needed."""
        response = ClarificationResponse(needs_clarification=False, clarification_question=None)
        assert response.is_valid() is True

    def test_model_dump_json(self):
        """Test JSON serialization."""
        response = ClarificationResponse(needs_clarification=True, clarification_question="What scope?")
        json_str = response.model_dump_json()
        assert "needs_clarification" in json_str
        assert "clarification_question" in json_str

    def test_model_validate(self):
        """Test validation from dict."""
        data = {"needs_clarification": True, "clarification_question": "What focus area?"}
        response = ClarificationResponse.model_validate(data)
        assert response.needs_clarification is True
        assert response.clarification_question == "What focus area?"

    def test_default_clarification_question_is_none(self):
        """Test clarification_question defaults to None."""
        response = ClarificationResponse(needs_clarification=False)
        assert response.clarification_question is None

    def test_options_default_to_empty(self):
        """Options are optional: a prose-only clarification is still valid."""
        response = ClarificationResponse(needs_clarification=True, clarification_question="Which period?")
        assert response.options == []
        assert response.is_valid() is True

    def test_options_are_kept_when_present(self):
        """The short labels must survive validation as structured data."""
        response = ClarificationResponse(
            needs_clarification=True,
            clarification_question="**Focus**: which area?\n\n1. Foo: explanation\n2. Bar: explanation",
            options=["Foo", "Bar"],
        )
        assert response.options == ["Foo", "Bar"]
        assert response.is_valid() is True

    def test_options_from_model_validate(self):
        """The field has to round-trip through the JSON envelope the LLM returns."""
        data = {
            "needs_clarification": True,
            "clarification_question": "Which one?",
            "options": ["A", "B"],
        }
        response = ClarificationResponse.model_validate(data)
        assert response.options == ["A", "B"]

    def test_options_absent_from_envelope_is_valid(self):
        """A model that omits the key entirely must not be treated as malformed."""
        response = ClarificationResponse.model_validate(
            {"needs_clarification": True, "clarification_question": "Which one?"}
        )
        assert response.options == []
        assert response.is_valid() is True

    def test_is_valid_false_when_options_without_question(self):
        """Options with nothing being asked would render a picker under no question."""
        response = ClarificationResponse(needs_clarification=False, clarification_question=None, options=["A"])
        assert response.is_valid() is False

    def test_model_dump_json_includes_options(self):
        """The agent replays this JSON through the graph; the field must survive."""
        response = ClarificationResponse(needs_clarification=True, clarification_question="Which one?", options=["A"])
        assert '"options":["A"]' in response.model_dump_json()
