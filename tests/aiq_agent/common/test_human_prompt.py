"""Tests for the shared NAT human-prompt helpers."""

from aiq_agent.common import build_human_prompt
from aiq_agent.common import extract_user_response
from nat.data_models.interactive import HumanPromptRadio
from nat.data_models.interactive import HumanPromptText
from nat.data_models.interactive import HumanResponseRadio
from nat.data_models.interactive import HumanResponseText
from nat.data_models.interactive import InteractionResponse
from nat.data_models.interactive import MultipleChoiceOption


class TestBuildHumanPrompt:
    """Tests for build_human_prompt."""

    def test_without_options_is_a_text_prompt(self):
        """No options must produce the free-text prompt used before options existed."""
        prompt = build_human_prompt("Which period?")

        assert isinstance(prompt, HumanPromptText)
        assert prompt.text == "Which period?"
        assert prompt.required is True
        assert prompt.placeholder == "Please provide more details..."

    def test_empty_options_is_a_text_prompt(self):
        """An empty list means 'no enumerable answers', same as None."""
        assert isinstance(build_human_prompt("Which period?", []), HumanPromptText)

    def test_blank_options_are_dropped(self):
        """Whitespace-only labels would render as empty picker cards."""
        assert isinstance(build_human_prompt("Which?", ["   ", ""]), HumanPromptText)

    def test_with_options_is_a_radio_prompt(self):
        """Options must travel in the structured field, not only in the prose."""
        prompt = build_human_prompt("Which model?", ["Castle.ifc", "Institute.ifc"])

        assert isinstance(prompt, HumanPromptRadio)
        assert prompt.text == "Which model?"
        assert [option.label for option in prompt.options] == ["Castle.ifc", "Institute.ifc"]
        # The value is what comes back as the user's answer, so it must be the
        # label itself rather than an opaque id.
        assert [option.value for option in prompt.options] == ["Castle.ifc", "Institute.ifc"]
        assert [option.id for option in prompt.options] == ["1", "2"]

    def test_question_text_is_preserved_with_options(self):
        """The picker adds to the question, it does not replace it."""
        question = "**Modell**: Welches meinst du?\n\n1. A\n2. B\n\n... oder tippen Sie 'skip'."
        prompt = build_human_prompt(question, ["A", "B"])

        assert prompt.text == question


class TestExtractUserResponse:
    """Tests for extract_user_response across the NAT response shapes."""

    def test_string_passthrough(self):
        assert extract_user_response("typed answer") == "typed answer"

    def test_interaction_response_with_text(self):
        """A typed answer arrives as HumanResponseText."""
        response = InteractionResponse(
            id="1",
            timestamp="2026-08-18T10:00:00Z",
            content=HumanResponseText(text="skip"),
        )

        assert extract_user_response(response) == "skip"

    def test_interaction_response_with_radio_selection(self):
        """A picked option arrives as HumanResponseRadio, with no `.text` at all."""
        response = InteractionResponse(
            id="1",
            timestamp="2026-08-18T10:00:00Z",
            content=HumanResponseRadio(selected_option=MultipleChoiceOption(value="Castle.ifc", label="Castle.ifc")),
        )

        assert extract_user_response(response) == "Castle.ifc"

    def test_bare_radio_response(self):
        """Some callers hand over the HumanResponse without the interaction wrapper."""
        response = HumanResponseRadio(selected_option=MultipleChoiceOption(value="B", label="B"))

        assert extract_user_response(response) == "B"

    def test_selected_option_falls_back_to_label(self):
        """NAT defaults `value` to "default"; a label-only option must still read."""

        class _Option:
            value = None
            label = "Only a label"

        class _Response:
            selected_option = _Option()

        assert extract_user_response(_Response()) == "Only a label"

    def test_unknown_shape_falls_back_to_str(self):
        """Never raise inside a live turn over an unrecognised response."""
        assert extract_user_response(42) == "42"
