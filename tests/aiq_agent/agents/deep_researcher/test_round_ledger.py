"""A deep research run keeps the same per-round account a chat turn keeps.

Each ``run_research_batch`` call is one round: it states what it is about to
fetch (``record_round_announcement``), stamps every hit its workers return with
that round (``retrieval_round_scope``), and at the end of the run the two are
joined into the ``retrieval_ledger`` the reader's Herleitung renders. Deep
research had none of it — the longest answers the product writes were the ones
whose derivation could not be read back.

The join itself is pinned by the chat suite. What these tests pin is that the
deep researcher FEEDS it: two batches are two rounds, the hits land under the
round that fetched them, and the result is the wire shape the shared fixture
holds.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest

from aiq_agent.agents.deep_researcher.models import ResearchQuery
from aiq_agent.agents.deep_researcher.tools.research import RetrievalRounds
from aiq_agent.agents.deep_researcher.tools.research import build_research_batch_tool
from aiq_agent.common.retrieval_ledger import build_retrieval_ledger
from aiq_agent.common.turn_status import begin_lane_capture
from aiq_agent.common.turn_status import end_lane_capture
from aiq_agent.common.turn_status import get_lane_captures
from aiq_agent.common.turn_status import lane_tool_scope
from aiq_agent.common.turn_status import record_lane_hit

FIXTURE = Path(__file__).resolve().parents[4] / "tests/fixtures/herleitung/retrieval_ledger_wire.json"


def _query(text: str, tool: str = "knowledge_search") -> ResearchQuery:
    return ResearchQuery(
        query=text,
        subqueries=[],
        preferred_tools=[tool],
        fallback_tools=[],
        target_components=["fire_safety"],
        rationale="coverage",
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


def _runnable_recording(hits: dict[str, list[tuple[str, str]]]) -> Any:
    """A researcher worker that records the lane hits its query is mapped to."""

    async def _invoke(state: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, Any]:
        text = str(state["messages"][0].content)
        topic = next(key for key in hits if key in text)
        with lane_tool_scope("knowledge_search"):
            for name, detail in hits[topic]:
                record_lane_hit(name, detail=detail)
        return _note(topic)

    runnable = MagicMock()
    runnable.ainvoke = AsyncMock(side_effect=_invoke)
    return runnable


def _batch_tool(runnable: Any, rounds: RetrievalRounds):
    return build_research_batch_tool(
        researcher_runnable=runnable,
        callbacks=[],
        max_research_concurrency=4,
        researcher_tool_names={"knowledge_search"},
        rounds=rounds,
    )


class TestTwoBatchesAreTwoRounds:
    @pytest.mark.asyncio
    async def test_each_batch_announces_its_own_round(self):
        """Two dispatches, two announcements, indexed in dispatch order."""
        rounds = RetrievalRounds()
        tool = _batch_tool(_runnable_recording({"Fluchtweg": [], "Brandabschnitt": []}), rounds)

        await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4 Fluchtweg")], "conclusion": ""})
        await tool.ainvoke(
            {"queries": [_query("Brandabschnitt Trennung")], "conclusion": "Die Grundregel steht."},
        )

        assert [entry["index"] for entry in rounds.announcements] == [0, 1]
        assert rounds.announcements[0]["corpora"] == ["knowledge"]
        # The conclusion argument is the round's checkpoint, ranked by
        # ``_resolve_conclusion`` exactly as the chat loop ranks it.
        assert "reason" not in rounds.announcements[0]
        assert rounds.announcements[1]["reason"] == "Die Grundregel steht."

    @pytest.mark.asyncio
    async def test_the_hits_of_a_batch_land_under_the_round_that_fetched_them(self):
        """A worker's hits carry the round its batch announced, not the run's last one."""
        rounds = RetrievalRounds()
        runnable = _runnable_recording(
            {
                "Fluchtweg": [("OIB-RL_2.pdf", "p.12")],
                "Brandabschnitt": [("Brandschutzkonzept.pdf", "p.3")],
            }
        )
        tool = _batch_tool(runnable, rounds)

        token = begin_lane_capture()
        try:
            await tool.ainvoke({"queries": [_query("Fluchtweglänge GK4 Fluchtweg")], "conclusion": ""})
            await tool.ainvoke({"queries": [_query("Brandabschnitt Trennung")], "conclusion": "Weiter."})
            captures = get_lane_captures()
        finally:
            end_lane_capture(token)

        assert [(hit["round"], hit["name"]) for hit in captures] == [
            (0, "OIB-RL_2.pdf"),
            (1, "Brandschutzkonzept.pdf"),
        ]

        ledger = build_retrieval_ledger(rounds.announcements, captures)
        assert [entry["new_docs"] for entry in ledger] == [["OIB-RL_2.pdf"], ["Brandschutzkonzept.pdf"]]


class TestTheLedgerIsTheSharedWireShape:
    """The crossing test: deep research writes what the chat turn writes.

    ``tests/fixtures/herleitung/retrieval_ledger_wire.json`` is the wire the
    frontend's sanitizer and the chat suite both read. A second producer that
    drifted from it would render as an unknown round, and nothing in either
    suite alone would say so.
    """

    @pytest.mark.asyncio
    async def test_every_key_the_run_writes_is_a_key_the_fixture_holds(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        entry_keys = {key for entry in fixture for key in entry}
        doc_keys = {key for entry in fixture for doc in entry["docs"] for key in doc}

        rounds = RetrievalRounds()
        runnable = _runnable_recording({"Fluchtweg": [("OIB-RL_2.pdf", "p.12")]})
        tool = _batch_tool(runnable, rounds)
        token = begin_lane_capture()
        try:
            await tool.ainvoke(
                {"queries": [_query("Fluchtweglänge GK4 Fluchtweg")], "conclusion": "Die Grundregel steht."}
            )
            ledger = build_retrieval_ledger(rounds.announcements, get_lane_captures())
        finally:
            end_lane_capture(token)

        assert ledger is not None
        for entry in ledger:
            assert set(entry) <= entry_keys, f"unknown ledger key: {set(entry) - entry_keys}"
            for doc in entry["docs"]:
                assert set(doc) <= doc_keys, f"unknown doc key: {set(doc) - doc_keys}"
            assert isinstance(entry["hits"], int)
            assert isinstance(entry["documents"], int)
        assert ledger[0]["docs"] == [{"name": "OIB-RL_2.pdf", "detail": "p.12", "repeat": False}]
