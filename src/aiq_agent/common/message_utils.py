"""Message utilities for extracting content from conversation history."""

from __future__ import annotations

import logging

from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage

logger = logging.getLogger(__name__)


def content_to_text(content: object) -> str:
    """Normalize LLM message content to plain text.

    Chat models may return ``content`` as a string or as a list of content
    blocks (e.g. ``[{"type": "text", "text": "..."}]``); the parsing helpers
    below all expect a string.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
            elif isinstance(getattr(block, "text", None), str):
                parts.append(block.text)
        return "\n".join(parts)
    return str(content) if content is not None else ""


def _content_as_text(content: object) -> str:
    """Normalize message content (str or list of content blocks) to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts)
    return str(content) if content is not None else ""


def get_latest_user_query(messages: list[BaseMessage]) -> str:
    """Return the most recent user-authored message content.

    Iterates through messages in reverse order to find the latest
    HumanMessage, which represents the user's most recent query.

    Args:
        messages: List of conversation messages.

    Returns:
        The content of the latest user message, or empty string if none found.
    """
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return _content_as_text(message.content)

    if messages:
        last_message = messages[-1]
        if hasattr(last_message, "content"):
            return _content_as_text(last_message.content)

    logger.warning("No user message found in conversation history, returning empty string")
    return ""
