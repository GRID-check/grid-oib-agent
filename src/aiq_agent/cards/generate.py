"""Reusable Grid response card generation from a query and research context."""

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.cards.models import validate_cards
from aiq_agent.cards.prompt import build_card_generation_prompt

logger = logging.getLogger(__name__)

# Cards are a progressive enhancement, not the deliverable — the report is
# already complete when this runs. Bound the call so a stalled provider cannot
# strand an otherwise-finished job (the langchain client's own timeout may be
# unset, and this runs after the job's cancellation monitor has stopped).
_CARD_LLM_TIMEOUT_S = 30.0

# The card schema is a deep, mostly-optional 20-way union — too complex for
# `strict` json_schema enforcement, and on OpenRouter/DeepSeek a non-strict
# json_schema is largely ignored while costing the most tokens. `json_object`
# mode is widely honored and guarantees syntactic validity, which is all the
# tolerant parser needs; the card SHAPE is taught via the prompt's worked
# examples, and correctness is enforced downstream by validate_cards.
_CARDS_RESPONSE_FORMAT: dict[str, Any] = {"type": "json_object"}


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

    # Salvage the first balanced top-level array or object from surrounding
    # prose. On a span that fails to parse, keep scanning later matches (a valid
    # array can follow a decoy) rather than abandoning the bracket type.
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
    """Invoke the card LLM, requesting JSON output when the provider supports it.

    Chat models get a request-scoped ``response_format`` binding (json_object)
    so OpenAI-compatible providers guarantee syntactically valid JSON. Providers
    that reject the parameter fall back to a plain call (the tolerant parser
    then handles prose-wrapped JSON).
    """
    if isinstance(llm, BaseChatModel):
        try:
            return await llm.bind(response_format=_CARDS_RESPONSE_FORMAT).ainvoke(messages)
        except Exception as e:
            logger.warning(
                "JSON-mode card generation failed (%s); retrying without response_format",
                str(e).split("\n")[0],
            )
    return await llm.ainvoke(messages)


@dataclass(frozen=True)
class CardGenerationResult:
    """What post-hoc card generation produced, and whether it was TRIED and lost.

    ``cards`` is ``None`` whenever nothing usable came out. ``failed`` separates
    the two ways that happens: the model was never asked (no LLM, empty inputs)
    or answered that the report warrants no cards — ordinary, not failed — from a
    timeout, a provider error, unparseable output or a batch in which no card
    survived validation. The job runner records the second kind as a degraded
    reason on the answer; the first kind is not a caveat.
    """

    cards: list[dict[str, Any]] | None
    failed: bool = False


async def generate_cards(llm: Any, query: str, research_context: str) -> list[dict[str, Any]] | None:
    """:func:`generate_cards_result` reduced to its cards; ``None`` on any miss."""
    return (await generate_cards_result(llm, query, research_context)).cards


async def generate_cards_result(llm: Any, query: str, research_context: str) -> CardGenerationResult:
    """Generate validated Grid response cards from a query and research context.

    Best-effort helper shared by the synchronous chat path and the async job
    runner: returns ``None`` (never raises) when the LLM is missing, the
    inputs are empty, or generation/validation fails.

    Args:
        llm: A LangChain-compatible chat model exposing ``ainvoke``.
        query: The original user question.
        research_context: The final answer/report to derive cards from.

    Returns:
        The validated cards, or ``cards=None`` if none could be produced —
        with ``failed`` saying whether that was an outcome or an accident.
    """
    # Known follow-up (pre-existing gap): the card LLM is passed in already-built
    # and is NOT run through the org BYOK credential swap
    # (aiq_agent.common.llm_credentials.apply_org_credential), so card generation
    # always uses the platform credential even for BYOK orgs. Wiring it would mean
    # applying the credential where this llm is constructed/handed in (chat path +
    # async job runner), which is out of scope for the unified-resolution change.
    if llm is None or not query or not research_context:
        return CardGenerationResult(cards=None)

    prompt = build_card_generation_prompt()
    messages = [
        SystemMessage(content=prompt),
        HumanMessage(content=f"Question: {query}\n\nResearch context:\n{research_context}"),
    ]

    try:
        response = await asyncio.wait_for(_ainvoke_card_llm(llm, messages), timeout=_CARD_LLM_TIMEOUT_S)
    except TimeoutError:
        logger.warning("Card generation timed out after %ss; returning no cards", _CARD_LLM_TIMEOUT_S)
        return CardGenerationResult(cards=None, failed=True)
    except Exception as e:
        logger.exception("Card generation failed: %s", e)
        return CardGenerationResult(cards=None, failed=True)

    try:
        raw_text = response.content if hasattr(response, "content") else str(response)
        parsed = _parse_cards_text(raw_text)
        if parsed is None:
            # The model answered, but with nothing a card could be read from.
            return CardGenerationResult(cards=None, failed=True)
        if not parsed:
            # The model's own verdict that the report warrants no proposals.
            return CardGenerationResult(cards=[])
        validated = validate_cards(parsed)
        if not validated:
            # It proposed cards and not one of them was well-formed.
            return CardGenerationResult(cards=None, failed=True)
        return CardGenerationResult(cards=validated)
    except Exception as e:
        logger.exception("Card validation failed: %s", e)
        return CardGenerationResult(cards=None, failed=True)
