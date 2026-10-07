"""Every tool the chat binds is either a data source or knowingly not one.

A tool result is captured as a citable source only when the tool resolves to a
configured data source (`get_source_id_for_tool`, `piloti/agent.py
::_capture_sources`). A tool that returns passages but is missing from the
`data_sources` registry is silently uncitable. Its passages never reach the
registry, its sources never become chips, and a turn whose only finding came
from it is replaced by the canned "search unavailable" reply, because the
answer pipeline sees a lookup with nothing captured. `project_lookup` shipped
exactly like that, and the precedent eval found it
(docs/roadmap/office-experience.md, step A).

So a new chat tool has to be put in one of two places, and this test is
what makes that a decision instead of an accident.
"""

from __future__ import annotations

from pathlib import Path

import yaml

CONFIG = Path(__file__).resolve().parents[4] / "configs" / "config_oib_openrouter.yml"

#: The tools that render passages a reader cites: a grounding block
#: (`render_grounding_block`) or a registered source parser. Each must be a data source.
PASSAGE_TOOLS = {"knowledge_search", "read_passage", "ris_lookup_tool", "project_lookup"}

#: Chat tools that are deliberately NOT data sources, and why. Adding a tool
#: here says its result is never evidence an answer cites.
NOT_SOURCES = {
    "remember": "writes project memory; its confirmation is not evidence",
    "surface_documents": "shows documents as a card; the documents are read through knowledge_search",
    "propose_file_change": "proposes an edit for a person to accept",
    "file_draft": "files a draft from the working directory",
    "create_task": "hands work over; the confirmation is not evidence",
    "ask_user": "asks the reader a question",
    "ifc_query": "answers from the building model through cards, not passages",
    "ifc_measure": "measures in the building model; its numbers arrive through cards",
    "view_knowledge_image": "shows an image of a passage already captured by the knowledge search",
}


def _config() -> dict:
    return yaml.safe_load(CONFIG.read_text(encoding="utf-8"))


def _source_tools(config: dict) -> set[str]:
    sources = config["functions"]["data_sources"]["sources"]
    return {tool for source in sources for tool in source.get("tools") or []}


def _chat_tools(config: dict) -> list[str]:
    return list(config["functions"]["shallow_research_agent"]["tools"])


def test_every_tool_that_returns_passages_is_a_data_source():
    missing = PASSAGE_TOOLS - _source_tools(_config())

    assert not missing, (
        f"These tools return citable passages but are no data source, so nothing they find is cited: {missing}"
    )


def test_every_chat_tool_is_a_data_source_or_knowingly_not_one():
    config = _config()
    sources = _source_tools(config)
    unclassified = [tool for tool in _chat_tools(config) if tool not in sources and tool not in NOT_SOURCES]

    assert not unclassified, (
        f"Classify {unclassified}: add each to a source in `data_sources` (its results become citable) "
        "or to NOT_SOURCES here with the reason it is never evidence."
    )


def test_nothing_is_both():
    both = _source_tools(_config()) & set(NOT_SOURCES)

    assert not both, f"{both} cannot be a data source and declared not one"
