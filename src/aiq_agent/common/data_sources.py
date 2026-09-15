"""Shared utilities for data source handling across agents.

A DISABLED source does not lose its tool. Piloti binds the same tools on every
turn and REFUSES a call to a source this conversation switched off
(:func:`disabled_source_notice`), instead of dropping the tool from the
binding. Two reasons, both measured. The provider's prompt cache is keyed on
the tool payload (``common/prompt_caching.py``), so a tool set that varies with
the toggles makes one cache shard per toggle combination on a workload that is
~99 % input tokens and re-sends its prefix 3-8 times per turn. And a refusal is
a fact the model can say out loud — "I could not check the web" — where an
absent tool is one it has to infer, and the prompt had to teach it to.

:func:`filter_tools_by_sources` is still how the OTHER agents narrow, and it is
unchanged: deep research fans out to workers with no interception point to
refuse at, so for them absence remains the enforcement.
"""

import base64
import json
import logging
from collections.abc import Iterable
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from langchain_core.messages import BaseMessage

from .data_source_registry import get_all_sources
from .data_source_registry import get_source
from .data_source_registry import get_source_id_for_tool

# Default to web_search when no data sources specified
DEFAULT_DATA_SOURCES: list[str] = ["web_search"]

# Org-disabled data sources (ADR-0022): the BFF resolves the org's web-search
# setting at the WS upgrade and forwards the disabled ids base64url-encoded.
DISABLED_SOURCES_HEADER = "x-grid-disabled-sources"

logger = logging.getLogger(__name__)


def parse_disabled_sources(raw: str | None) -> set[str]:
    """Decode the disabled-sources header into a lowercase id set.

    Malformed values are ignored (nothing disabled) — the org toggle must
    never take chat down; the BFF-side listing filter still hides the tool.
    """
    if not raw:
        return set()
    try:
        padded = raw + "=" * (-len(raw) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception:
        logger.warning("Ignoring malformed %s header", DISABLED_SOURCES_HEADER, exc_info=True)
        return set()
    if not isinstance(data, list):
        return set()
    return {str(item).strip().lower() for item in data if str(item).strip()}


def get_disabled_sources_from_context() -> set[str]:
    """Read the current request's org-disabled sources from NAT context."""
    from aiq_agent.project_context import _read_header

    return parse_disabled_sources(_read_header(DISABLED_SOURCES_HEADER))


#: The sources THIS turn may not consult, for the tools that run inside it.
#: A ContextVar and not an argument, because a tool signature is the model's
#: contract and a turn-scoped fact is not the model's business. Set in Piloti's
#: TOOLS node, around the ``ToolNode`` call — LangGraph runs each node in a task
#: built with ``copy_context()``, so a value set beside the LLM call is written
#: to a copy that dies at the node boundary, while the tools are children of the
#: tools node and do inherit it.
_turn_disabled_sources: ContextVar[frozenset[str]] = ContextVar("grid_turn_disabled_sources", default=frozenset())


def get_turn_disabled_sources() -> frozenset[str]:
    """The source ids this turn may not consult; empty outside a bound turn."""
    return _turn_disabled_sources.get()


@contextmanager
def turn_disabled_sources_scope(source_ids: Iterable[str]) -> Iterator[None]:
    """Bind the turn's switched-off sources for the tools running inside."""
    token = _turn_disabled_sources.set(frozenset(str(s).strip().lower() for s in source_ids if str(s).strip()))
    try:
        yield
    finally:
        _turn_disabled_sources.reset(token)


def unavailable_source_ids(
    data_sources: list[str] | None,
    disabled_sources: set[str] | None = None,
) -> frozenset[str]:
    """Every configured source this turn may not consult, as one set.

    Two things the caller used to express by deleting tools, said once as data:
    what the ORGANIZATION turned off (ADR-0022, the ``x-grid-disabled-sources``
    header) and what this REQUEST did not select. ``data_sources=None`` selects
    everything, so only the org's toggles remain; ``[]`` selects nothing and
    every registered source comes back.

    Pure given its arguments. ``disabled_sources=None`` reads the current
    request's header, exactly as :func:`filter_tools_by_sources` does.
    """
    if disabled_sources is None:
        disabled_sources = get_disabled_sources_from_context()
    unavailable = {str(source_id).strip().lower() for source_id in disabled_sources if str(source_id).strip()}
    if data_sources is None:
        return frozenset(unavailable)
    selected = {source_id.strip().lower() for source_id in data_sources if source_id.strip()}
    unavailable |= {meta.id.lower() for meta in get_all_sources() if meta.id.lower() not in selected}
    return frozenset(unavailable)


def disabled_source_notice(tool_name: str, disabled: Iterable[str] | None = None) -> str | None:
    """What a call to a switched-off source is answered with; ``None`` to run it.

    The ONE place that decides, so a tool, an interception point at the
    ``ToolNode`` boundary and anything added later cannot disagree about which
    tool belongs to which source — the registry already knows
    (:func:`get_source_id_for_tool`), and a second mapping would drift.

    German, like the duplicate-fetch notice beside it, and an INSTRUCTION for
    the same reason: the useful next move is to answer from what the turn holds
    and to SAY the source went unconsulted, not to try the same tool again.

    ``disabled=None`` reads the turn's ContextVar, so a tool can call this with
    nothing but its own name.
    """
    unavailable = frozenset(disabled) if disabled is not None else get_turn_disabled_sources()
    if not unavailable:
        return None
    source_id = get_source_id_for_tool(tool_name)
    if source_id is None or source_id.lower() not in unavailable:
        return None
    meta = get_source(source_id)
    label = meta.name if meta else source_id.replace("_", " ").title()
    return (
        f"Nicht ausgeführt: {label} ist für dieses Gespräch abgeschaltet. "
        f"Antworte mit dem, was du bereits hast, und schreib im Text, dass {label} nicht konsultiert wurde."
    )


def parse_data_sources(raw: Any) -> list[str] | None:
    """Parse data sources from various input formats.

    Args:
        raw: Can be None, a list of strings, or a comma-separated string.

    Returns:
        - None if input is None (not specified, use all tools)
        - Empty list [] if input was explicitly empty (no data-source tools)
        - List of data source IDs if specified
    """
    if raw is None:
        return None
    if isinstance(raw, list):
        if len(raw) == 0:
            return []
        parsed = [str(value).strip() for value in raw]
        return [value for value in parsed if value] or []
    if isinstance(raw, str):
        if not raw.strip():
            return []
        parsed = [value.strip() for value in raw.split(",")]
        return [value for value in parsed if value] or []
    return None


def filter_tools_by_sources(
    tools: list[Any],
    data_sources: list[str] | None,
    disabled_sources: set[str] | None = None,
) -> list[Any]:
    """Filter tools based on selected data sources.

    Uses the tool->source map built at startup from config ``data_source`` fields.
    Tools without a mapping (e.g. "think", calculator) are always included.
    Source ID matching is case-insensitive.

    Org-disabled sources (ADR-0022) are subtracted unconditionally — even a
    ``data_sources=None`` ("all tools") request never sees a tool whose
    source the organization turned off. ``disabled_sources`` defaults to the
    current request's ``x-grid-disabled-sources`` header; async workers pass
    the submit-time capture explicitly instead.

    Args:
        tools: List of LangChain tools.
        data_sources: List of selected data source IDs, None for all data-source
            tools, or [] for no data-source tools.
        disabled_sources: Org-disabled source IDs (lowercase); None = read
            from the request context.

    Returns:
        Filtered list of tools matching the selected data sources.
    """
    if disabled_sources is None:
        disabled_sources = get_disabled_sources_from_context()

    if data_sources is None and not disabled_sources:
        return tools

    selected = (
        None if data_sources is None else {source_id.strip().lower() for source_id in data_sources if source_id.strip()}
    )
    filtered = []
    for tool in tools:
        name = getattr(tool, "name", "")
        source_id = get_source_id_for_tool(name)
        if source_id is None:
            # Not a data source tool (e.g., "think", calculator) -> always include.
            filtered.append(tool)
            continue
        source_key = source_id.lower()
        if source_key in disabled_sources:
            continue
        if selected is None or source_key in selected:
            filtered.append(tool)
    return filtered


def all_mapped_tools_filtered_out(
    tools: list[Any],
    selected_tools: list[Any],
    data_sources: list[str] | None,
) -> bool:
    """Return True when filtering dropped every data-source-mapped tool.

    Useful for emitting a diagnostic when a caller passed ``data_sources`` but
    the filter produced no mapped tools (e.g. ``data_sources=[]`` with mapped
    tools configured, or ``data_sources=["unknown"]`` that matched nothing).
    Returns False when ``data_sources is None`` (no filtering requested) or
    when the original tool list had no mapped tools to filter in the first
    place.

    Args:
        tools: Full tool list before filtering.
        selected_tools: Tool list after ``filter_tools_by_sources``.
        data_sources: The ``data_sources`` argument passed to the filter.

    Returns:
        True if ``data_sources`` was specified, ``tools`` contained at least
        one mapped tool, and zero mapped tools survived the filter.
    """
    if data_sources is None:
        return False
    had_mapped = any(get_source_id_for_tool(getattr(t, "name", "")) is not None for t in tools)
    if not had_mapped:
        return False
    still_has_mapped = any(get_source_id_for_tool(getattr(t, "name", "")) is not None for t in selected_tools)
    return not still_has_mapped


def extract_messages_and_sources(payload: Any) -> tuple[list[BaseMessage], list[str] | None]:
    """Extract messages and data sources from a payload.

    Args:
        payload: Can be a dict with 'payload' key, a dict with 'messages', or a list.

    Returns:
        Tuple of (messages, data_sources).

    Raises:
        ValueError: If payload format is invalid.
    """
    if isinstance(payload, dict):
        if "payload" in payload and isinstance(payload["payload"], dict):
            payload = payload["payload"]
        messages = payload.get("messages")
        if isinstance(messages, list):
            return messages, parse_data_sources(payload.get("data_sources"))
    if isinstance(payload, list):
        return payload, None
    raise ValueError("Invalid payload format: expected dict with 'messages' or list")


def format_data_source_tools(data_sources: list[str]) -> list[dict[str, str]]:
    """Format data sources as tool info for meta chatter.

    Looks up display metadata from the registry first; falls back to
    title-cased IDs for unregistered sources.

    Args:
        data_sources: List of data source IDs.

    Returns:
        List of tool info dicts with 'name' and 'description'.
    """
    tools_info: list[dict[str, str]] = []
    for source_id in data_sources:
        meta = get_source(source_id)
        if meta:
            tools_info.append({"name": meta.name, "description": meta.description})
        else:
            label = source_id.replace("_", " ").title()
            tools_info.append({"name": label, "description": f"Search {source_id.replace('_', ' ')}."})
    return tools_info
