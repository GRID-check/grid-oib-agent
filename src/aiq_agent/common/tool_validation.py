"""Tool validation utilities for checking tool availability."""

import logging
import os
import re
from typing import Any

from aiq_agent.common.canned_replies import TOOLS_UNAVAILABLE_MESSAGE

logger = logging.getLogger(__name__)

#: How a stub registered in place of a tool marks itself:
#: ``"Web search tool (unavailable - missing TAVILY_API_KEY)"``. Matched as the
#: marker, not as a word: a real tool's description saying what it does about
#: "missing standard property sets" is not a stub (ifc_query was listed as
#: unavailable on every turn for exactly that sentence).
_STUB_MARKER = re.compile(r"\(unavailable\b", re.IGNORECASE)


def _extract_unavailable_reason(description: str) -> str:
    """Extract the reason from a stub tool's description.

    Stub tools typically have descriptions like:
        ``"Web search tool (unavailable - missing TAVILY_API_KEY)"``
    This extracts ``"missing TAVILY_API_KEY"`` from the parenthetical.
    """
    match = re.search(r"\(unavailable\s*[-:]\s*(.+?)\)", description, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    match = re.search(r"(missing\s+\S+)", description, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return "missing or invalid API key"


def validate_tool_availability(
    tools: list[Any],
    research_type: str = "research",
    enable_logging: bool = True,
) -> tuple[bool, int, list[str]]:
    """
    Validate that at least one tool is available.

    Args:
        tools: List of tools to validate
        research_type: Type of research (e.g., "research", "deep research") for logging
        enable_logging: Whether to log tool availability information

    Returns:
        Tuple of (is_valid, available_count, unavailable_tools):
        - is_valid: True if at least one tool is available
        - available_count: Number of available tools
        - unavailable_tools: List of unavailable tool names with reasons
    """
    available_tools_count = 0
    unavailable_tools = []

    if enable_logging:
        logger.info("Checking %d tools for %s", len(tools), research_type)

    for tool in tools:
        tool_name = getattr(tool, "name", "").lower()
        tool_desc_original = getattr(tool, "description", "") or ""

        is_unavailable = bool(_STUB_MARKER.search(tool_desc_original))

        if is_unavailable:
            reason = _extract_unavailable_reason(tool_desc_original)
            if enable_logging:
                logger.info("Tool %s is unavailable: %s", tool_name, reason)
            unavailable_tools.append(f"{tool_name} ({reason})")
        else:
            available_tools_count += 1
            if enable_logging:
                logger.info("Found available tool: %s", tool_name)

    if enable_logging:
        logger.info(
            "Tool availability check: %d available tools out of %d",
            available_tools_count,
            len(tools),
        )

    return available_tools_count > 0, available_tools_count, unavailable_tools


def format_tool_unavailability_error(
    research_type: str,
    unavailable_tools: list[str],
) -> str:
    """
    Format an error message for unavailable tools.

    Args:
        research_type: Type of research (e.g., "research", "deep research")
        unavailable_tools: List of unavailable tool names with reasons

    Returns:
        Formatted error message string
    """
    unavailable_info = ""
    if unavailable_tools:
        unavailable_info = f"\nUnavailable tools: {', '.join(unavailable_tools)}.\n"

    error_msg = (
        f"Cannot start {research_type}: No tools are available."
        f" At least one tool must be configured and available.{unavailable_info}\n"
    )
    return error_msg


def format_user_facing_tool_error(
    research_type: str,
    unavailable_tools: list[str],
    available_count: int = 0,
) -> str:
    """Format a tool-unavailability error appropriate for the current deployment mode.

    In CLI mode (``AIQ_DEV_ENV=cli``), the full tool details are returned so
    developers can diagnose quickly in the terminal.  In all other modes
    (e2e, web, production, unset) a generic message is returned to avoid
    leaking infrastructure details to end users in the web UI.

    The detailed message is **always** logged at WARNING level regardless of
    deployment mode so operators can still diagnose from server logs.

    Args:
        research_type: Type of research (e.g., "research", "deep research")
        unavailable_tools: List of unavailable tool names with reasons
        available_count: Number of tools that passed pre-flight checks

    Returns:
        User-facing error message string
    """
    if available_count == 0:
        detailed = format_tool_unavailability_error(research_type, unavailable_tools)
    else:
        tool_list = ", ".join(unavailable_tools)
        detailed = f"Research did not return any results. Unavailable tools: {tool_list}.\n"

    logger.warning(detailed.strip())

    dev_env = os.environ.get("AIQ_DEV_ENV", "")
    if dev_env == "cli":
        return detailed

    # Detailed diagnostics (tool names, missing keys) are only shown when
    # AIQ_DEV_ENV is "cli" — set automatically by scripts/start_cli.sh.
    return TOOLS_UNAVAILABLE_MESSAGE
