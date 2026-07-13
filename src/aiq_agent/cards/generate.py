"""Reusable Grid response card generation from a query and research context."""

import json
import logging
import re
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.models import validate_cards
from aiq_agent.cards.prompt import build_card_generation_prompt

logger = logging.getLogger(__name__)


def _build_cards_response_format() -> dict[str, Any]:
    """OpenAI-style ``response_format`` that constrains output to a card array.

    OpenAI-compatible structured output requires the schema root to be an
    object, so the card array is wrapped as ``{"cards": [...]}``. ``strict`` is
    intentionally omitted: the card union is deeply nested and mostly optional
    fields, which strict mode (all-required + additionalProperties:false) would
    reject — best-effort schema adherence plus the tolerant parser below is the
    right trade-off here.
    """
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "grid_cards",
            "schema": {
                "type": "object",
                "properties": {"cards": {"type": "array", "items": grid_card_adapter.json_schema()}},
                "required": ["cards"],
                "additionalProperties": False,
            },
        },
    }


def _coerce_to_card_list(parsed: Any) -> list[Any] | None:
    """Normalize a parsed JSON value into a list of card dicts.

    Accepts the structured-output object wrapper (``{"cards": [...]}``), a bare
    array, or a single card object.
    """
    if isinstance(parsed, dict):
        if isinstance(parsed.get("cards"), list):
            return parsed["cards"]
        return [parsed]
    if isinstance(parsed, list):
        return parsed
    return None


def _parse_cards_text(raw_text: str) -> list[Any] | None:
    """Tolerantly extract a card list from a raw LLM response.

    Handles code-fence wrapping and leading/trailing prose (which would break a
    whole-string ``json.loads``) by salvaging the first balanced ``[...]`` or
    ``{...}`` span. Returns None when nothing parseable is found.
    """
    text = raw_text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        return _coerce_to_card_list(json.loads(text))
    except json.JSONDecodeError:
        pass

    # Salvage the first balanced top-level array or object from surrounding prose.
    for open_ch, close_ch in (("[", "]"), ("{", "}")):
        for start_match in re.finditer(re.escape(open_ch), text):
            start = start_match.start()
            depth = 0
            for i, char in enumerate(text[start:]):
                if char == open_ch:
                    depth += 1
                elif char == close_ch:
                    depth -= 1
                    if depth == 0:
                        try:
                            return _coerce_to_card_list(json.loads(text[start : start + i + 1]))
                        except json.JSONDecodeError:
                            break

    logger.warning("Card generation: no parseable JSON in LLM response")
    return None


async def _ainvoke_card_llm(llm: Any, messages: list[Any]) -> Any:
    """Invoke the card LLM, enforcing the card schema via structured output when possible.

    Chat models get a request-scoped ``response_format`` binding so
    OpenAI-compatible providers constrain the output to the card schema.
    Providers that reject the parameter fall back to a plain call (the tolerant
    parser then handles prose-wrapped JSON).
    """
    if isinstance(llm, BaseChatModel):
        try:
            return await llm.bind(response_format=_build_cards_response_format()).ainvoke(messages)
        except Exception as e:
            logger.warning(
                "Structured-output card generation failed (%s); retrying without response_format",
                str(e).split("\n")[0],
            )
    return await llm.ainvoke(messages)


async def generate_cards(llm: Any, query: str, research_context: str) -> list[dict[str, Any]] | None:
    """Generate validated Grid response cards from a query and research context.

    Best-effort helper shared by the synchronous chat path and the async job
    runner: returns ``None`` (never raises) when the LLM is missing, the
    inputs are empty, or generation/validation fails.

    Args:
        llm: A LangChain-compatible chat model exposing ``ainvoke``.
        query: The original user question.
        research_context: The final answer/report to derive cards from.

    Returns:
        A list of validated card dicts, or None if no cards could be produced.
    """
    if llm is None or not query or not research_context:
        return None

    prompt = build_card_generation_prompt()
    messages = [
        SystemMessage(content=prompt),
        HumanMessage(content=f"Question: {query}\n\nResearch context:\n{research_context}"),
    ]

    try:
        response = await _ainvoke_card_llm(llm, messages)
        raw_text = response.content if hasattr(response, "content") else str(response)
        parsed = _parse_cards_text(raw_text)
        if parsed is None:
            return None
        return validate_cards(parsed)
    except Exception as e:
        logger.exception("Card generation failed: %s", e)
        return None
