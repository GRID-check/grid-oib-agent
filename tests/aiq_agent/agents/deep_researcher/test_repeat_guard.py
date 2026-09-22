"""A run fetches each passage once: the second identical query is not researched.

An orchestrator that loses track of its own submitted-query ledger (prompt prose
is the only thing that kept it) re-submits a query the run already has notes
for, and the batch spends a whole researcher worker on it. The guard is the chat
loop's, lifted: ``common.retrieval_rounds.repeat_fetches`` over the call each
query stands for.

Withholding means ANSWERING. The repeat gets the note its first execution
returned, in the array the orchestrator reads back — never a short array, which
it reads as a partial failure and resubmits.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest

from aiq_agent.agents.deep_researcher.models import ResearchQuery
from aiq_agent.agents.deep_researcher.tools.research import RetrievalRounds
from aiq_agent.agents.deep_researcher.tools.research import build_research_batch_tool


def _query(text: str, *, tool: str = "knowledge_search", rationale: str = "coverage") -> ResearchQuery:
    return ResearchQuery(
        query=text,
        subqueries=[],
        preferred_tools=[tool],
        fallback_tools=[],
        target_components=["fire_safety"],
        rationale=rationale,
    )


def _note(topic: str) -> dict[str, Any]:
    return {
        "structured_response": {
            "query_topic": topic,
            "target_components": ["fire_safety"],
            "summary": f"Notes on {topic}.",
            "findings": [],
            "gaps": [],
            "sources": [],
            "narrative_notes": f"Narrative on {topic}.",
            "language": "Deutsch",
            "evidence_judgment": None,
        }
    }


def _counting_runnable() -> Any:
    """A worker that answers with a note naming the call that produced it."""
    calls: list[str] = []

    async def _invoke(state: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
        calls.append(str(state["messages"][0].content))
        return _note(f"run {len(calls)}")

    runnable = MagicMock()
    runnable.ainvoke = AsyncMock(side_effect=_invoke)
    runnable.calls = calls
    return runnable


def _batch_tool(runnable: Any, rounds: RetrievalRounds):
    return build_research_batch_tool(
        researcher_runnable=runnable,
        callbacks=[],
        max_research_concurrency=4,
        researcher_tool_names={"knowledge_search", "advanced_web_search"},
        rounds=rounds,
    )


class TestTheSecondSubmissionIsAnswered:
    @pytest.mark.asyncio
    async def test_the_same_query_twice_runs_once_and_gets_the_first_result(self):
        runnable = _counting_runnable()
        rounds = RetrievalRounds()
        tool = _batch_tool(runnable, rounds)

        first = json.loads(await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4")], "conclusion": ""}))
        second = json.loads(await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4")], "conclusion": "Nochmal."}))

        assert len(runnable.calls) == 1, "the repeat spawned a second researcher worker"
        assert second == first
        assert second[0]["query_topic"] == "run 1"

    @pytest.mark.asyncio
    async def test_a_withheld_round_announces_nothing(self):
        """A batch of only repeats fetched nothing, so it is no layer of the spine."""
        runnable = _counting_runnable()
        rounds = RetrievalRounds()
        tool = _batch_tool(runnable, rounds)

        await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4")], "conclusion": ""})
        await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4")], "conclusion": "Nochmal."})

        assert [entry["index"] for entry in rounds.announcements] == [0]

    @pytest.mark.asyncio
    async def test_a_same_batch_duplicate_is_answered_by_its_first_occurrence(self):
        """Two identical queries in one batch are the same guess said twice."""
        runnable = _counting_runnable()
        rounds = RetrievalRounds()
        tool = _batch_tool(runnable, rounds)

        payload = json.loads(
            await tool.ainvoke(
                {"queries": [_query("Fluchtweglänge GK4"), _query("Fluchtweglänge GK4")], "conclusion": ""}
            )
        )

        assert len(runnable.calls) == 1
        assert [note["query_topic"] for note in payload] == ["run 1", "run 1"]


class TestWhatTheGuardLeavesAlone:
    @pytest.mark.asyncio
    async def test_a_different_query_still_runs(self):
        runnable = _counting_runnable()
        tool = _batch_tool(runnable, RetrievalRounds())

        await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4")], "conclusion": ""})
        await tool.ainvoke({"queries": [_query("Brandabschnitt Trennung")], "conclusion": ""})

        assert len(runnable.calls) == 2

    @pytest.mark.asyncio
    async def test_an_unsignable_query_is_never_withheld(self):
        """A web query is not the same bytes twice, so nothing signs it."""
        runnable = _counting_runnable()
        tool = _batch_tool(runnable, RetrievalRounds())

        for _ in range(2):
            await tool.ainvoke({"queries": [_query("Zaha Hadid", tool="advanced_web_search")], "conclusion": ""})

        assert len(runnable.calls) == 2

    @pytest.mark.asyncio
    async def test_a_failed_query_signs_nothing_so_its_retry_runs(self):
        """The rule the chat loop applies to a failed fetch: no result, no signature."""
        attempts: list[str] = []

        async def _invoke(state: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
            attempts.append(str(state["messages"][0].content))
            if len(attempts) == 1:
                raise RuntimeError("store unreachable")
            return _note("recovered")

        runnable = MagicMock()
        runnable.ainvoke = AsyncMock(side_effect=_invoke)
        tool = _batch_tool(runnable, RetrievalRounds())

        with pytest.raises(RuntimeError):
            await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4")], "conclusion": ""})
        payload = json.loads(await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4")], "conclusion": ""}))

        assert len(attempts) == 2
        assert payload[0]["query_topic"] == "recovered"
