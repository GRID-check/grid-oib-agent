"""The writer's verified source list: the tool, and the renderer behind it."""

from __future__ import annotations

import functools
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlparse

from langchain_core.tools import BaseTool
from langchain_core.tools import tool

from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import _normalize_url

if TYPE_CHECKING:
    from ..custom_middleware import SourceRegistryMiddleware

_PROMPTS_DIR = Path(__file__).resolve().parents[1] / "prompts"


@functools.cache
def _source_registry_template() -> str:
    """The list template, read once per process rather than per tool call."""
    return load_prompt(_PROMPTS_DIR, "source_registry")


def _display_title(entry: SourceEntry) -> str:
    if entry.title:
        return entry.title
    return urlparse(entry.url).netloc.replace("www.", "") or entry.url


def dedupe_sources(entries: list[SourceEntry]) -> list[dict[str, str]]:
    """Registry entries as ``{title, url}`` rows, one per URL or citation key, in order."""
    seen: set[str] = set()
    rows: list[dict[str, str]] = []
    for entry in entries:
        key = _normalize_url(entry.url) if entry.url else entry.citation_key
        if not key or key in seen:
            continue
        seen.add(key)
        title = _display_title(entry) if entry.url else key
        rows.append({"title": title, "url": entry.url or key})
    return rows


def render_source_list(entries: list[SourceEntry]) -> str | None:
    """The consolidated source list for the writer, or None when nothing was captured.

    A missing or broken template raises: the tool would otherwise report "No
    sources captured yet" about a run that captured plenty.
    """
    rows = dedupe_sources(entries)
    if not rows:
        return None
    return render_prompt_template(_source_registry_template(), sources=rows)


def build_get_verified_sources_tool(registry_middleware: SourceRegistryMiddleware) -> BaseTool:
    """Build the get_verified_sources tool for the active source registry."""

    @tool
    def get_verified_sources(mode: str = "compact") -> str:
        """Returns verified source URLs captured from search tool calls.

        Call this tool during synthesis BEFORE writing the final answer. It
        returns the compact writer-facing source list by default: sources that
        researcher workers carried forward into ResearchNotes. Pass
        mode="full" only if a needed ResearchNotes source is missing from the
        compact list. Use ONLY returned sources in your final answer. Any
        other URL will be automatically removed.

        Args:
            mode: "compact" for ResearchNotes-backed sources, or "full" for
                every captured source in the registry.
        Returns:
            A numbered list of verified sources with titles and URLs.
        """
        source_mode = "full" if mode == "full" else "compact"
        source_list = render_source_list(registry_middleware.get_source_entries(mode=source_mode))
        if source_list:
            return source_list
        return "No sources captured yet. Run research queries first."

    return get_verified_sources
