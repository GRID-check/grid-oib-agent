"""Tests for the shared NAT human-prompt helpers."""

import pytest

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


class TestSharedConversationAnswerPath:
    """The picker must not bypass the multi-user answer path (ADR-0032/0037)."""

    @pytest.mark.asyncio
    async def test_picked_option_normalises_through_the_real_nat_validator(self):
        """End to end: an option label typed or clicked comes back as that label.

        The transport resolves the pending future with a plain string and NAT
        re-wraps it using the *prompt* type, so a radio prompt turns the answer
        into `HumanResponseRadio`. If the two halves disagreed the clarifier
        would reason over `str(<pydantic model>)`.
        """
        from nat.data_models.api_server import TextContent
        from nat.front_ends.fastapi.message_validator import MessageValidator

        prompt = build_human_prompt("Which model?", ["Castle.ifc", "Institute.ifc"])
        response = await MessageValidator().convert_text_content_to_human_response(
            TextContent(text="Castle.ifc"), prompt
        )

        assert extract_user_response(response) == "Castle.ifc"

    @pytest.mark.asyncio
    async def test_free_text_answer_to_a_picker_survives(self):
        """The question still says the user may type instead of picking."""
        from nat.data_models.api_server import TextContent
        from nat.front_ends.fastapi.message_validator import MessageValidator

        prompt = build_human_prompt("Which model?", ["Castle.ifc", "Institute.ifc"])
        response = await MessageValidator().convert_text_content_to_human_response(TextContent(text="skip"), prompt)

        assert extract_user_response(response) == "skip"

    @pytest.mark.asyncio
    async def test_a_colleague_still_cannot_answer_a_picker(self):
        """A picker is answered through the same guarded registry as prose.

        Spectators in a shared conversation are not the addressee; nothing about
        offering options may turn their answer into an accepted one.
        """
        import asyncio

        from aiq_api.websocket_reconnect import WebSocketSessionRegistry
        from nat.data_models.api_server import TextContent

        registry = WebSocketSessionRegistry()
        future: asyncio.Future[TextContent] = asyncio.get_running_loop().create_future()
        await registry.register_pending_interaction("conv-1", future, "user_matthias")

        answer = TextContent(text="Castle.ifc")
        assert await registry.resolve_pending_interaction("conv-1", answer, "user_anna") is False
        assert not future.done()

        assert await registry.resolve_pending_interaction("conv-1", answer, "user_matthias") is True
        assert future.result().text == "Castle.ifc"
