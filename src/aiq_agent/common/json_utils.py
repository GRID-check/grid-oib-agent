"""JSON utility functions."""

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def extract_json(text: str) -> dict[str, Any] | None:
    """
    Extract JSON from text, handling markdown code blocks and other formats.

    Tries multiple strategies to extract JSON:
    1. Parse as raw JSON
    2. Extract from ```json code blocks
    3. Find first { to last } substring

    Args:
        text: Text that may contain JSON.

    Returns:
        Parsed JSON dict, or None if extraction fails.
    """
    if not text:
        return None

    text = text.strip()

    # Try direct JSON parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code block. The closing fence is optional
    # so a response truncated after the JSON body still parses.
    json_match = re.search(r"```(?:json)?\s*(\{.*?)\s*(?:```|$)", text, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    # Try each '{' as a candidate start and match braces from there, so stray
    # braces in surrounding prose don't permanently derail extraction.
    for start_match in re.finditer(r"\{", text):
        start = start_match.start()
        depth = 0
        for i, char in enumerate(text[start:]):
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : start + i + 1])
                    except json.JSONDecodeError:
                        break

    logger.warning("Failed to extract JSON from text")
    return None
