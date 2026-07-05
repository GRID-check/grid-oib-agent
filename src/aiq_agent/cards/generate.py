"""Reusable Grid response card generation from a query and research context."""

import json
import logging
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.cards.models import validate_cards
from aiq_agent.cards.prompt import build_card_generation_prompt

logger = logging.getLogger(__name__)


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
        response = await llm.ainvoke(messages)
        raw_text = response.content if hasattr(response, "content") else str(response)
        raw_text = raw_text.strip()
        if raw_text.startswith("```"):
            raw_text = raw_text.split("\n", 1)[-1].rsplit("\n```", 1)[0].strip()
        parsed = json.loads(raw_text)
        if not isinstance(parsed, list):
            parsed = [parsed]
        return validate_cards(parsed)
    except Exception as e:
        logger.exception("Card generation failed: %s", e)
        return None
