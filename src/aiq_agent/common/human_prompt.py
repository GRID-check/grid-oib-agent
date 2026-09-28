"""NAT human-in-the-loop (HITL) prompts, and how they travel on the chat wire.

Two places stop a run to ask the user something, the clarification step
(`agents/piloti/clarify.py`) and Piloti's `ask_user` tool, and both go through
NAT's ``prompt_user_input``. Four halves have to agree, so all four live here:

1. build the prompt (:func:`build_human_prompt`): a ``HumanPromptText``, or a
   ``HumanPromptRadio`` when there are options, since only the multiple-choice
   prompts have an options field;
2. put it on the wire (:func:`interaction_request`): the prompt's own NAT id is
   the ``interaction_id``, and only these two prompt shapes have a wire shape;
3. read the client's answer back (:func:`human_response`): ``{text}`` becomes a
   ``HumanResponseText``, ``{option_id}`` the ``HumanResponseRadio`` for that
   option;
4. read the text out of it (:func:`extract_user_response`).

A caller that upgraded its prompt to a radio and kept reading ``response.text``
would get ``str(<pydantic model>)`` as the user's answer instead of what they
picked. Keeping all four halves in one module is what stops that drift.
"""

from __future__ import annotations

from collections.abc import Sequence

from aiq_agent.common.wire_v2 import InteractionOption
from aiq_agent.common.wire_v2 import InteractionRequestValue
from aiq_agent.common.wire_v2 import OptionAnswer
from aiq_agent.common.wire_v2 import TextAnswer
from nat.plugin_api import HumanPrompt
from nat.plugin_api import HumanPromptRadio
from nat.plugin_api import HumanPromptText
from nat.plugin_api import HumanResponse
from nat.plugin_api import HumanResponseRadio
from nat.plugin_api import HumanResponseText
from nat.plugin_api import InteractionPrompt
from nat.plugin_api import InteractionResponse
from nat.plugin_api import MultipleChoiceOption

DEFAULT_TEXT_PLACEHOLDER = "Please provide more details..."
"""Placeholder for the free-text box, kept identical for both prompt shapes."""


def build_human_prompt(
    text: str,
    options: Sequence[str] | None = None,
    *,
    placeholder: str = DEFAULT_TEXT_PLACEHOLDER,
) -> HumanPrompt:
    """
    Build the NAT prompt for a question, with a picker when options exist.

    With options it returns a ``HumanPromptRadio``. The question text is carried
    unchanged either way: the radio adds the picker, it does not replace the
    framing sentence or the "or type 'skip'" line, and a picker with no question
    above it is not an improvement.

    Args:
        text: The human-readable question, already in the user's language.
        options: Short labels for the enumerable answers, or None/empty for a
            free-text-only question. Never synthesise these — a label the user
            did not choose puts words in their mouth.
        placeholder: Placeholder for the free-text input.

    Returns:
        ``HumanPromptText`` when there are no options, ``HumanPromptRadio``
        otherwise.
    """
    labels = [str(option).strip() for option in (options or []) if str(option).strip()]
    if not labels:
        return HumanPromptText(text=text, required=True, placeholder=placeholder)

    return HumanPromptRadio(
        text=text,
        options=[
            # `value` is what comes back as the user's answer, so it has to be
            # the label itself: the clarifier replays that string to the LLM as
            # the user's turn, and an opaque id there would read as noise.
            MultipleChoiceOption(id=str(index), label=label, value=label, description="")
            for index, label in enumerate(labels, start=1)
        ],
    )


def interaction_request(prompt: InteractionPrompt, *, expires_at: int) -> InteractionRequestValue:
    """The ``interaction_request`` for a NAT prompt; its id is NAT's own prompt id.

    A choice keeps the free-text box: the question tells the user they may
    type instead of picking, and "skip" is only ever typed.

    Raises:
        TypeError: for a prompt shape :func:`build_human_prompt` never builds.
            The wire has no shape for it, so it is a producer bug.
    """
    content = prompt.content
    if isinstance(content, HumanPromptRadio):
        return InteractionRequestValue(
            interaction_id=prompt.id,
            input="choice",
            text=content.text,
            options=[InteractionOption(id=option.id, label=option.label) for option in content.options],
            placeholder=DEFAULT_TEXT_PLACEHOLDER,
            expires_at=expires_at,
        )
    if isinstance(content, HumanPromptText):
        return InteractionRequestValue(
            interaction_id=prompt.id,
            input="text",
            text=content.text,
            placeholder=content.placeholder,
            expires_at=expires_at,
        )
    raise TypeError(f"No wire shape for a {type(content).__name__}; build prompts with build_human_prompt")


def human_response(prompt: HumanPrompt, answer: TextAnswer | OptionAnswer) -> HumanResponse:
    """NAT's response for the client's answer to ``prompt``.

    Raises:
        ValueError: for an ``option_id`` the prompt did not offer.
    """
    if isinstance(answer, TextAnswer):
        return HumanResponseText(text=answer.text)
    options = prompt.options if isinstance(prompt, HumanPromptRadio) else []
    chosen = next((option for option in options if option.id == answer.option_id), None)
    if chosen is None:
        raise ValueError(f"option {answer.option_id!r} was not offered")
    return HumanResponseRadio(selected_option=chosen)


def extract_user_response(response: InteractionResponse) -> str:
    """The user's answer as text: what they typed, or the value of what they picked.

    Raises:
        TypeError: for a response :func:`human_response` never builds.
    """
    content = response.content
    if isinstance(content, HumanResponseRadio):
        return content.selected_option.value
    if isinstance(content, HumanResponseText):
        return content.text
    raise TypeError(f"No answer text in a {type(content).__name__}")
