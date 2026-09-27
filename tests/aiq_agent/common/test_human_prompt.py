"""The NAT human prompt, its wire shape, and the answer back (`common/human_prompt.py`)."""

import pytest

from aiq_agent.common import build_human_prompt
from aiq_agent.common import extract_user_response
from aiq_agent.common.human_prompt import DEFAULT_TEXT_PLACEHOLDER
from aiq_agent.common.human_prompt import human_response
from aiq_agent.common.human_prompt import interaction_request
from aiq_agent.common.wire_v2 import InteractionRequestValue
from aiq_agent.common.wire_v2 import OptionAnswer
from aiq_agent.common.wire_v2 import TextAnswer
from nat.plugin_api import Context
from nat.plugin_api import ContextState
from nat.plugin_api import HumanPromptCheckbox
from nat.plugin_api import HumanPromptRadio
from nat.plugin_api import HumanPromptText
from nat.plugin_api import HumanResponseRadio
from nat.plugin_api import HumanResponseText
from nat.plugin_api import InteractionPrompt
from nat.plugin_api import InteractionResponse
from nat.plugin_api import MultipleChoiceOption
from nat.utils import providers


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
    """The two answers `human_response` builds, read back as text."""

    def test_a_typed_answer(self):
        response = InteractionResponse(id="1", timestamp="2026-08-18T10:00:00Z", content=HumanResponseText(text="skip"))

        assert extract_user_response(response) == "skip"

    def test_a_picked_option_reads_as_its_value(self):
        """A picked option arrives as HumanResponseRadio, with no `.text` at all."""
        option = MultipleChoiceOption(value="Castle.ifc", label="Castle.ifc")
        response = InteractionResponse(
            id="1", timestamp="2026-08-18T10:00:00Z", content=HumanResponseRadio(selected_option=option)
        )

        assert extract_user_response(response) == "Castle.ifc"


def _nat_prompt(content, prompt_id: str = "ask_01") -> InteractionPrompt:
    return InteractionPrompt(id=prompt_id, timestamp="2026-08-18T10:00:00Z", content=content)


class TestOnTheWire:
    """The prompt as `interaction_request`, the client's answer back as NAT's response."""

    def test_a_question_without_options_is_a_text_request(self):
        value = interaction_request(_nat_prompt(build_human_prompt("Which period?")), expires_at=1)

        assert value == InteractionRequestValue(
            interaction_id="ask_01",
            input="text",
            text="Which period?",
            placeholder=DEFAULT_TEXT_PLACEHOLDER,
            expires_at=1,
        )

    def test_a_picker_is_a_choice_that_keeps_the_free_text_box(self):
        prompt = build_human_prompt("Which model?", ["Castle.ifc", "Institute.ifc"])

        value = interaction_request(_nat_prompt(prompt), expires_at=1)

        assert value.input == "choice"
        assert [(option.id, option.label) for option in value.options] == [("1", "Castle.ifc"), ("2", "Institute.ifc")]
        # The question says the user may type instead of picking; "skip" is only ever typed.
        assert value.placeholder == DEFAULT_TEXT_PLACEHOLDER

    def test_a_prompt_shape_nobody_builds_has_no_wire_shape(self):
        with pytest.raises(TypeError):
            interaction_request(_nat_prompt(HumanPromptCheckbox(text="?", options=[])), expires_at=1)

    async def test_the_interaction_id_is_nat_s_own_prompt_id(self):
        """NAT 1.9 mints the prompt id; the socket mints none. Pinned through NAT's provider hook."""
        seen: list[InteractionPrompt] = []

        async def callback(prompt: InteractionPrompt):
            seen.append(prompt)
            return HumanResponseText(text="ok")

        state = ContextState.get()
        token = state.user_input_callback.set(callback)
        previous = providers.set_id_provider(lambda: "00000000-0000-4000-8000-000000000001")
        try:
            await Context.get().user_interaction_manager.prompt_user_input(build_human_prompt("?"))
        finally:
            providers.set_id_provider(previous)
            state.user_input_callback.reset(token)

        assert interaction_request(seen[0], expires_at=1).interaction_id == "00000000-0000-4000-8000-000000000001"

    def test_a_typed_answer_to_a_picker_stays_what_was_typed(self):
        prompt = build_human_prompt("Which model?", ["Castle.ifc", "Institute.ifc"])

        response = human_response(prompt, TextAnswer(text="skip"))

        assert response == HumanResponseText(text="skip")

    def test_a_chosen_option_comes_back_as_its_label(self):
        """The clarifier replays the value to the model as the user's turn, so it is the label, not the id."""
        prompt = build_human_prompt("Which model?", ["Castle.ifc", "Institute.ifc"])

        response = human_response(prompt, OptionAnswer(option_id="1"))

        assert isinstance(response, HumanResponseRadio)
        wrapped = InteractionResponse(id="1", timestamp="2026-08-18T10:00:00Z", content=response)
        assert extract_user_response(wrapped) == "Castle.ifc"

    def test_an_option_that_was_not_offered_is_refused(self):
        prompt = build_human_prompt("Which model?", ["Castle.ifc"])

        with pytest.raises(ValueError):
            human_response(prompt, OptionAnswer(option_id="7"))
        with pytest.raises(ValueError):
            human_response(build_human_prompt("Free text?"), OptionAnswer(option_id="1"))
