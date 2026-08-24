"""Tests for org-disabled data sources (ADR-0022, x-grid-disabled-sources)."""

import base64
import json
from unittest.mock import MagicMock

import pytest

from aiq_agent.common.data_source_registry import populate_from_config
from aiq_agent.common.data_source_registry import reset_registry
from aiq_agent.common.data_sources import filter_tools_by_sources
from aiq_agent.common.data_sources import parse_disabled_sources


@pytest.fixture(autouse=True)
def _setup_registry():
    reset_registry()
    populate_from_config(
        [
            {
                "id": "web_search",
                "name": "Web Search",
                "description": "Search the web.",
                "tools": ["web_search_tool", "advanced_web_search_tool"],
            },
            {
                "id": "knowledge_layer",
                "name": "Knowledge Base",
                "description": "Search documents.",
                "tools": ["knowledge_search"],
            },
        ]
    )
    yield
    reset_registry()


def _tool(name: str) -> MagicMock:
    tool = MagicMock()
    tool.name = name
    return tool


def _encode(value: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()


class TestParseDisabledSources:
    def test_empty_and_none(self):
        assert parse_disabled_sources(None) == set()
        assert parse_disabled_sources("") == set()

    def test_roundtrip(self):
        assert parse_disabled_sources(_encode(["web_search"])) == {"web_search"}
        assert parse_disabled_sources(_encode(["Web_Search", "  x "])) == {"web_search", "x"}

    def test_malformed_is_ignored(self):
        assert parse_disabled_sources("!!!not-base64url!!!") == set()
        assert parse_disabled_sources(_encode({"web_search": True})) == set()


class TestFilterWithDisabledSources:
    def test_disabled_subtracted_from_all_sources_request(self):
        tools = [_tool("web_search_tool"), _tool("knowledge_search"), _tool("think")]
        # data_sources=None means "all" — the org-disabled source must STILL go.
        selected = filter_tools_by_sources(tools, None, disabled_sources={"web_search"})
        assert [t.name for t in selected] == ["knowledge_search", "think"]

    def test_disabled_beats_explicit_selection(self):
        tools = [_tool("web_search_tool"), _tool("advanced_web_search_tool"), _tool("knowledge_search")]
        selected = filter_tools_by_sources(tools, ["web_search", "knowledge_layer"], disabled_sources={"web_search"})
        assert [t.name for t in selected] == ["knowledge_search"]

    def test_no_disabled_is_the_legacy_behavior(self):
        tools = [_tool("web_search_tool"), _tool("knowledge_search"), _tool("think")]
        assert filter_tools_by_sources(tools, None, disabled_sources=set()) == tools
        selected = filter_tools_by_sources(tools, ["web_search"], disabled_sources=set())
        assert [t.name for t in selected] == ["web_search_tool", "think"]

    def test_unmapped_tools_always_survive(self):
        tools = [_tool("think"), _tool("emit_card")]
        assert filter_tools_by_sources(tools, None, disabled_sources={"web_search"}) == tools
