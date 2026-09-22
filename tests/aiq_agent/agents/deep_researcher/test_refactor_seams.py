"""The seams the refactor introduced, pinned.

The first test is the one that matters: the skill resolver is a synchronous
HTTP round trip to the BFF, and running it on the event loop inside
``_prepare_run`` stalled the Dask worker's heartbeat for as long as the BFF
took to answer — the ghost reaper then failed healthy jobs
(``docs/contributing/gotchas.md``). The rest pin the pure functions that were
carved out of ``_finalize``, ``run``, the batch tool and the middleware.
"""

from __future__ import annotations

import threading
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphRecursionError

from aiq_agent.agents.deep_researcher.agent import DeepResearcherAgent
from aiq_agent.agents.deep_researcher.custom_middleware import _evictions
from aiq_agent.agents.deep_researcher.cutoff import classify_cutoff
from aiq_agent.agents.deep_researcher.finalize import _apply_renumbering
from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.deep_researcher.tools.research import _batch_failure_message
from aiq_agent.agents.deep_researcher.tools.research import _largest_string_leaf
from aiq_agent.agents.deep_researcher.tools.source_registry import dedupe_sources
from aiq_agent.agents.deep_researcher.tools.source_registry import render_source_list
from aiq_agent.common.budget_guard import RunBudgetExceededError
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.turn_status import CUTOFF_RUN_BUDGET
from aiq_agent.common.turn_status import CUTOFF_STEP_LIMIT
from aiq_agent.common.turn_status import CUTOFF_UPSTREAM_TIMEOUT
from aiq_agent.common.turn_status import CUTOFF_WALL_CLOCK


@pytest.mark.asyncio
async def test_the_skill_resolver_never_runs_on_the_event_loop_thread():
    """A sync HTTP call inside ``_build_skill_runtime`` must run in a worker thread."""
    loop_thread = threading.get_ident()
    seen: dict[str, object] = {}

    def _resolver(agent: str, organization_id: str | None):
        seen["thread"] = threading.get_ident()
        seen["args"] = (agent, organization_id)
        return ()

    state = DeepResearchAgentState(messages=[HumanMessage(content="q")], organization_id="org-1")
    with patch("aiq_agent.agents.deep_researcher.agent.resolve_served_skills", side_effect=_resolver):
        runtime = await DeepResearcherAgent._build_skill_runtime(state)

    assert seen["args"] == ("deep_researcher", "org-1")
    assert seen["thread"] != loop_thread, "resolve_served_skills ran on the event loop: the heartbeat stalls"
    assert runtime.prompt_block() is None


def test_classify_cutoff_names_each_cause():
    assert classify_cutoff(RunBudgetExceededError(ceiling=1, used=2), elapsed_seconds=1, max_run_seconds=100)[0] == (
        CUTOFF_RUN_BUDGET
    )
    assert classify_cutoff(GraphRecursionError("x"), elapsed_seconds=1, max_run_seconds=100)[0] == CUTOFF_STEP_LIMIT
    reason, original = classify_cutoff(TimeoutError("read"), elapsed_seconds=3, max_run_seconds=100)
    assert reason == CUTOFF_UPSTREAM_TIMEOUT
    assert "upstream timeout" in str(original)
    reason, original = classify_cutoff(TimeoutError("budget"), elapsed_seconds=100, max_run_seconds=100)
    assert reason == CUTOFF_WALL_CLOCK
    assert "wall-clock budget" in str(original)


def test_apply_renumbering_leaves_its_input_alone():
    sources = [{"number": 1, "url": "a"}, {"number": 2, "url": "b"}, {"number": 3, "url": "c"}]
    result = _apply_renumbering(sources, {1: 1, 3: 2}, {2})
    assert result == [{"number": 1, "url": "a"}, {"number": 2, "url": "c"}]
    assert sources == [{"number": 1, "url": "a"}, {"number": 2, "url": "b"}, {"number": 3, "url": "c"}]


def _tool_msg(msg_id: str, size: int) -> ToolMessage:
    return ToolMessage(content="x" * size, tool_call_id=msg_id, id=msg_id)


def test_evictions_truncate_outside_the_window_then_the_budget():
    messages = [_tool_msg("a", 100), _tool_msg("b", 100), _tool_msg("c", 100), _tool_msg("small", 5)]
    evicted = _evictions(messages, keep_last_n=2, max_chars=10, total_char_budget=0, already={})
    assert set(evicted) == {"a"}
    assert evicted["a"].startswith("x" * 10)
    budgeted = _evictions(messages, keep_last_n=2, max_chars=10, total_char_budget=150, already={"a": "done"})
    assert set(budgeted) == {"b"}, "the oldest in-window result goes first, and 'a' is not decided twice"


def test_batch_failure_message_names_what_was_retained():
    message = _batch_failure_message(["q1: boom"], total_queries=3, successful_count=2, registered=True, persisted=True)
    assert "failed for 1 of 3" in message
    assert "2 successful researcher worker(s) were registered and persisted under /shared/" in message
    bare = _batch_failure_message(["q1: boom"], total_queries=1, successful_count=0, registered=True, persisted=True)
    assert "successful" not in bare


def test_largest_string_leaf_walks_nested_containers():
    data = {"a": "xx", "b": ["y", {"c": "zzzz"}]}
    container, key = _largest_string_leaf(data)
    assert container[key] == "zzzz"
    assert _largest_string_leaf({"n": 1}) is None


def test_dedupe_sources_keys_urls_and_citation_keys_once():
    rows = dedupe_sources(
        [
            SourceEntry(url="https://example.com/a", title="A"),
            SourceEntry(url="https://example.com/a/", title="A again"),
            SourceEntry(citation_key="doc.pdf, p.3"),
            SourceEntry(citation_key="doc.pdf, p.3"),
        ]
    )
    assert rows == [{"title": "A", "url": "https://example.com/a"}, {"title": "doc.pdf, p.3", "url": "doc.pdf, p.3"}]


def test_render_source_list_raises_on_a_broken_template_instead_of_claiming_no_sources():
    entries = [SourceEntry(url="https://example.com/a", title="A")]
    with patch(
        "aiq_agent.agents.deep_researcher.tools.source_registry._source_registry_template",
        MagicMock(side_effect=OSError("gone")),
    ):
        with pytest.raises(OSError):
            render_source_list(entries)
    assert render_source_list([]) is None
