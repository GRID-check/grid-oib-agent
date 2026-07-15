"""Utility functions for clarifier agent."""

from typing import Any


def extract_user_response(response: Any) -> str:
    """
    Extract user response text from a NAT HumanResponse object.

    Args:
        response: HumanResponse object from NAT user interaction.

    Returns:
        The user's response text.
    """
    # Handle string responses directly
    if isinstance(response, str):
        return response

    # Handle NAT HumanResponse with nested content structure
    # response.content is HumanResponseText with a text attribute
    if hasattr(response, "content"):
        content = response.content
        if hasattr(content, "text"):
            return str(content.text)

    # Fallback: check for direct text attribute
    if hasattr(response, "text"):
        return str(response.text)

    return str(response)
