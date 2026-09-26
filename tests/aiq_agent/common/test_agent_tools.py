"""A blank string for a numeric tool argument is an omitted argument, for every tool (#656).

Driven through NAT's real builder and LangChain tool wrapper, because that is
where the ``InputArgsSchema`` that rejected ``page=''`` is made.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from pydantic import BaseModel

import nat.plugins.langchain.tool_wrapper  # noqa: F401  registers the LangChain wrapper
from aiq_agent.common.agent_tools import blank_is_omitted
from aiq_agent.common.agent_tools import load_agent_tools
from nat.builder.builder import Builder
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.builder.function_info import FunctionInfo
from nat.builder.workflow_builder import WorkflowBuilder
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

_SRC = Path(__file__).resolve().parents[3] / "src" / "aiq_agent"


class _PagedSearchConfig(FunctionBaseConfig, name="grid_test_paged_search"):
    pass


@register_function(config_type=_PagedSearchConfig)
async def _paged_search(config: _PagedSearchConfig, builder: Builder):
    async def _search(query: str, page: int = 1, note: str = "") -> str:
        """Search, like ris_search: an int page with a default."""
        return f"{query}|{page}|{note}"

    yield FunctionInfo.from_fn(_search, description="Search.")


@pytest.fixture
async def builder():
    async with WorkflowBuilder() as workflow_builder:
        await workflow_builder.add_function("paged_search", _PagedSearchConfig())
        yield workflow_builder


async def test_nat_alone_rejects_a_blank_page(builder):
    # The failure #656 filed, reproduced on NAT's own tool.
    raw = (await builder.get_tools(tool_names=["paged_search"], wrapper_type=LLMFrameworkEnum.LANGCHAIN))[0]
    with pytest.raises(Exception, match="InputArgsSchema"):
        await raw.ainvoke({"query": "q", "page": ""})


async def test_an_agent_tool_reads_a_blank_page_as_omitted(builder):
    tool = (await load_agent_tools(builder, ["paged_search"]))[0]
    assert await tool.ainvoke({"query": "q", "page": ""}) == "q|1|"
    assert await tool.ainvoke({"query": "q", "page": "  "}) == "q|1|"
    assert await tool.ainvoke({"query": "q", "page": "3"}) == "q|3|"
    # A string field keeps its blank: it is a value, not an omission.
    assert await tool.ainvoke({"query": "q", "note": ""}) == "q|1|"


async def test_the_schema_the_model_sees_is_unchanged(builder):
    raw = (await builder.get_tools(tool_names=["paged_search"], wrapper_type=LLMFrameworkEnum.LANGCHAIN))[0]
    before = raw.tool_call_schema.model_json_schema()
    tool = (await load_agent_tools(builder, ["paged_search"]))[0]
    assert tool.tool_call_schema.model_json_schema() == before


async def test_exclude_drops_a_tool(builder):
    assert await load_agent_tools(builder, ["paged_search"], exclude=["paged_search"]) == []


def test_a_blank_required_field_is_still_a_missing_field():
    class Args(BaseModel):
        page: int

    with pytest.raises(Exception, match="Field required"):
        blank_is_omitted(Args).model_validate({"page": ""})


def test_every_agent_loads_its_tools_through_the_one_seam():
    # The ratchet: a fifth `builder.get_tools(` would load tools that reject
    # blank arguments again, which is how ris_search kept failing after
    # read_passage was fixed on its own.
    offenders = [
        str(path.relative_to(_SRC))
        for path in _SRC.rglob("*.py")
        if path.name != "agent_tools.py" and re.search(r"\bbuilder\.get_tools\(", path.read_text(encoding="utf-8"))
    ]
    assert offenders == [], f"load tools with aiq_agent.common.agent_tools.load_agent_tools: {offenders}"
