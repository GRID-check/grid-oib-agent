"""Tests for the models the clarifier asks its two LLMs to return."""

import pytest
from pydantic import ValidationError

from aiq_agent.agents.clarifier.models import ClarificationResponse
from aiq_agent.agents.clarifier.models import PlanResponse
from aiq_agent.common import strict_json_response_format


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

    def test_complete_is_the_sentinel_the_graph_writes(self):
        """The "nothing more to ask" reply, built in one place."""
        response = ClarificationResponse.complete()
        assert response.needs_clarification is False
        assert response.clarification_question is None
        assert response.options == []

    def test_an_omitted_optional_key_is_filled_in(self):
        """The tool-bound path carries no schema, so a two-key reply still parses."""
        response = ClarificationResponse(needs_clarification=False)
        assert response.clarification_question is None
        assert response.options == []

    def test_an_unknown_key_is_rejected(self):
        """extra=forbid is what puts additionalProperties:false in the schema."""
        with pytest.raises(ValidationError):
            ClarificationResponse.model_validate({"needs_clarification": False, "surprise": 1})

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


class TestStrictSchemas:
    """Both models are sent as strict json_schema; strict mode has rules."""

    @pytest.mark.parametrize("schema", [ClarificationResponse, PlanResponse])
    def test_every_property_is_required(self, schema):
        """A property missing from `required` is a provider 400, not a warning."""
        emitted = strict_json_response_format(schema)["json_schema"]

        assert emitted["strict"] is True
        assert sorted(emitted["schema"]["required"]) == sorted(emitted["schema"]["properties"])
        assert emitted["schema"]["additionalProperties"] is False


class TestPlanResponse:
    """The planner's reply."""

    def test_title_and_sections(self):
        plan = PlanResponse(title="A Plan", sections=["One", "Two"])

        assert plan.title == "A Plan"
        assert plan.sections == ["One", "Two"]

    def test_sections_must_be_strings(self):
        with pytest.raises(ValidationError):
            PlanResponse(title="A Plan", sections=[1, 2])

    def test_both_keys_are_required(self):
        """Nothing sensible to default a plan to; a half plan is a parse failure."""
        with pytest.raises(ValidationError):
            PlanResponse(title="A Plan")
