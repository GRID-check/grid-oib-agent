"""Shared helpers for NAT human-in-the-loop (HITL) prompts.

Two places stop a run to ask the user something — the clarifier agent
(`agents/clarifier/register.py`) and the shallow researcher's `ask_user`
tool — and both need the same two halves of NAT's HITL protocol:

1. build the prompt, choosing the prompt type that can actually carry answer
   options (`HumanPromptText` has no options field at all; only the
   multiple-choice prompts do), and
2. read the answer back out of whichever ``HumanResponse`` variant the
   transport produced for that prompt type.

Those two halves must agree: NAT picks the response variant from the prompt
variant (``message_validator.convert_text_content_to_human_response``), so a
caller that upgrades its prompt to a radio and keeps reading ``response.text``
silently gets ``str(<pydantic model>)`` as the user's answer instead of what
they picked. Keeping both halves in one module is what stops that drift.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from nat.data_models.interactive import HumanPrompt
from nat.data_models.interactive import HumanPromptRadio
from nat.data_models.interactive import HumanPromptText
from nat.data_models.interactive import MultipleChoiceOption

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

    With no options this returns exactly the ``HumanPromptText`` the callers
    used before options existed — the free-text path is the fallback for every
    question we cannot enumerate, so it must stay byte-identical.

    With options it returns a ``HumanPromptRadio``, whose ``options`` field is
    the only structured channel NAT offers for answer choices. The question
    text is carried unchanged either way: the radio adds the picker, it does
    not replace the framing sentence or the "or type 'skip'" line, and a
    picker with no question above it is not an improvement.

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


def extract_user_response(response: Any) -> str:
    """
    Extract the user's answer text from a NAT ``HumanResponse``.

    Handles both answer shapes a picker prompt can produce: a typed free-text
    answer (``HumanResponseText.text``) and a chosen option
    (``HumanResponse{Radio,Checkbox,Dropdown,Binary}.selected_option.value``).
    Both must keep working — the prompt tells the user they may type instead of
    picking, and "skip" is only ever typed.

    Args:
        response: ``InteractionResponse`` (``.content`` holds the response), a
            bare ``HumanResponse``, or a plain string.

    Returns:
        The user's answer as text; ``str(response)`` if nothing recognisable is
        found, which keeps this total rather than raising inside a live turn.
    """
    if isinstance(response, str):
        return response

    # InteractionResponse wraps the actual HumanResponse in `.content`.
    content = getattr(response, "content", None)
    for candidate in (content, response):
        if candidate is None:
            continue
        text = getattr(candidate, "text", None)
        if text is not None:
            return str(text)
        selected = getattr(candidate, "selected_option", None)
        if selected is not None:
            # `value` is what we put in the option; `label` is the fallback for
            # options built elsewhere (NAT defaults value to "default").
            value = getattr(selected, "value", None) or getattr(selected, "label", None)
            if value is not None:
                return str(value)

    return str(response)
