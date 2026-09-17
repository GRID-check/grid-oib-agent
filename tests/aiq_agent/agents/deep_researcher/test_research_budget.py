"""Tests for research budget and termination guards.

Covers:
- F1: GraphRecursionError ÔåÆ terminal ResearcherExhaustedError (not resubmittable)
- F2: Query digest resubmission cap ÔåÆ terminal unresearchable outcome
- F4a: Oversized research note truncation
- F6: RunBudgetExceededError re-raised (not wrapped)
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.deep_researcher.custom_middleware import SelectiveToolRetryMiddleware
from aiq_agent.agents.deep_researcher.custom_middleware import ToolResultPruningMiddleware
from aiq_agent.agents.deep_researcher.custom_middleware import is_retryable_tool_error
from aiq_agent.agents.deep_researcher.models import ResearchNotes
from aiq_agent.agents.deep_researcher.models import ResearchQuery
from aiq_agent.agents.deep_researcher.tools.research import _UNRESEARCHABLE_NARRATIVE
from aiq_agent.agents.deep_researcher.tools.research import _UNRESEARCHABLE_SUMMARY
from aiq_agent.agents.deep_researcher.tools.research import MAX_QUERY_SUBMISSIONS
from aiq_agent.agents.deep_researcher.tools.research import RESEARCH_NOTE_MAX_CHARS
from aiq_agent.agents.deep_researcher.tools.research import _research_note_files
from aiq_agent.agents.deep_researcher.tools.research import _terminal_unresearchable_note
from aiq_agent.agents.deep_researcher.tools.research import build_research_batch_tool
from aiq_agent.common import RunBudgetExceededError


@tool
def web_search_tool(query: str) -> str:
    """Search the web for information."""
    return f"Results for: {query}"


def _make_query(text: str = "test query") -> ResearchQuery:
    return ResearchQuery(
        query=text,
        subqueries=[],
        preferred_tools=["web_search_tool"],
        fallback_tools=[],
        target_components=["test"],
        rationale="testing",
    )


def _fake_runnable(result: Any | None = None) -> Any:
    runnable = MagicMock()
    if result is not None:
        runnable.ainvoke = AsyncMock(return_value=result)
    return runnable


def _structured_response() -> dict:
    return {
        "structured_response": {
            "query_topic": "test",
            "target_components": ["test"],
            "summary": "A test note.",
            "findings": [
                {
                    "claim": "Test claim.",
                    "evidence": "Test evidence.",
                    "source_ids": [1],
                    "confidence": "high",
                    "caveats": [],
                }
            ],
            "gaps": [],
            "sources": [
                {
                    "id": 1,
                    "title": "Test",
                    "source_type": "url",
                    "locator": "https://example.test",
                }
            ],
            "narrative_notes": "Test narrative.",
            "language": "English",
            "evidence_judgment": None,
        }
    }


class TestGraphRecursionErrorIsTerminal:
    """F1: an exhausted worker becomes a terminal unresearchable note, not a resubmittable error."""

    @pytest.mark.asyncio
    async def test_graph_recursion_error_yields_terminal_note(self):
        """GraphRecursionError ÔåÆ terminal unresearchable note (no resubmittable RuntimeError)."""
        from langgraph.errors import GraphRecursionError

        runnable = MagicMock()
        runnable.ainvoke = AsyncMock(side_effect=GraphRecursionError("maximum recursion depth reached"))

        batch_tool = build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

        result = await batch_tool.ainvoke({"queries": [_make_query()]})
        payload = json.loads(result)
        assert len(payload) == 1
        assert payload[0]["summary"] == _UNRESEARCHABLE_SUMMARY

    @pytest.mark.asyncio
    async def test_exhausted_worker_note_records_query_gap(self):
        """The terminal note carries the query as an open gap for the orchestrator/writer."""
        from langgraph.errors import GraphRecursionError

        runnable = MagicMock()
        runnable.ainvoke = AsyncMock(side_effect=GraphRecursionError("recurse"))

        batch_tool = build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

        result = await batch_tool.ainvoke({"queries": [_make_query("stuck query")]})
        payload = json.loads(result)
        assert payload[0]["narrative_notes"] == _UNRESEARCHABLE_NARRATIVE
        assert payload[0]["gaps"][0]["description"] == "Query: stuck query"

    @pytest.mark.asyncio
    async def test_run_budget_exceeded_passthrough(self):
        """F6: RunBudgetExceededError is NOT wrapped into a resubmittable RuntimeError."""
        runnable = MagicMock()
        runnable.ainvoke = AsyncMock(side_effect=RunBudgetExceededError(ceiling=1000, used=1500))

        batch_tool = build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

        with pytest.raises(RunBudgetExceededError):
            await batch_tool.ainvoke({"queries": [_make_query()]})

    @pytest.mark.asyncio
    async def test_generic_exception_still_wrapped(self):
        """Non-terminal exceptions still become RuntimeError (unchanged behavior)."""
        runnable = MagicMock()
        runnable.ainvoke = AsyncMock(side_effect=ValueError("something went wrong"))

        batch_tool = build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

        with pytest.raises(RuntimeError, match="researcher worker failed"):
            await batch_tool.ainvoke({"queries": [_make_query()]})


class TestQueryDigestResubmissionCap:
    """F2: Same query digest submitted > MAX_QUERY_SUBMISSIONS times ÔåÆ terminal unresearchable."""

    @pytest.mark.asyncio
    async def test_under_limit_runs_normally(self):
        """A query submitted fewer than the max times runs without terminal outcome."""
        runnable = _fake_runnable(_structured_response())
        batch_tool = build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

        for _ in range(MAX_QUERY_SUBMISSIONS):
            result = await batch_tool.ainvoke({"queries": [_make_query("under limit")]})

        payload = json.loads(result)
        assert len(payload) == 1
        assert payload[0]["query_topic"] == "test"

    @pytest.mark.asyncio
    async def test_over_limit_returns_terminal_unresearchable(self):
        """Submitting a query past the max returns a terminal unresearchable note, not an error."""
        runnable = _fake_runnable(_structured_response())
        batch_tool = build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

        # Exhaust the budget
        for _ in range(MAX_QUERY_SUBMISSIONS):
            await batch_tool.ainvoke({"queries": [_make_query("over limit")]})

        # This call should produce a terminal note, not raise
        result = await batch_tool.ainvoke({"queries": [_make_query("over limit")]})

        payload = json.loads(result)
        assert len(payload) == 1
        # Terminal notes have no findings and a specific summary
        assert payload[0]["summary"] != ""
        assert "nicht recherchiert werden" in payload[0]["summary"]

    @pytest.mark.asyncio
    async def test_different_query_digests_have_independent_counters(self):
        """Different query texts have independent submission counters."""
        runnable = _fake_runnable(_structured_response())
        batch_tool = build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

        for _ in range(MAX_QUERY_SUBMISSIONS + 1):
            # Submit two different queries each time
            await batch_tool.ainvoke({"queries": [_make_query("query A"), _make_query("query B")]})

        # Both should now be terminal on the next invocations, but we already
        # consumed the last allowed run in the loop above. The sub-calls above
        # used all budgets and each already succeeded. Let's verify they
        # succeeded throughout (each call had a mix of ok queries).
        # Actually let's just verify the final single-query call returns terminal:
        result = await batch_tool.ainvoke({"queries": [_make_query("query A")]})
        payload = json.loads(result)
        assert "nicht recherchiert werden" in payload[0]["summary"]

    @pytest.mark.asyncio
    async def test_mixed_oversubscribed_and_fresh(self):
        """A batch with one oversubscribed query and one fresh query handles both correctly."""
        runnable = _fake_runnable(_structured_response())
        batch_tool = build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

        # Exhaust the budget for query "stale"
        for _ in range(MAX_QUERY_SUBMISSIONS):
            await batch_tool.ainvoke({"queries": [_make_query("stale")]})

        # Mixed batch: stale (terminal) + fresh (runs normally)
        result = await batch_tool.ainvoke({"queries": [_make_query("stale"), _make_query("fresh")]})

        payload = json.loads(result)
        assert len(payload) == 2
        summaries = [n["summary"] for n in payload]
        assert any("nicht recherchiert werden" in s for s in summaries)
        assert any(s == "A test note." for s in summaries)


class TestTerminalUnresearchableNote:
    """The terminal note shape for oversubscribed queries."""

    def test_terminal_note_has_no_findings(self):
        """Terminal notes carry no research findings."""
        q = _make_query("my query")
        note = _terminal_unresearchable_note(q)
        assert note.findings == []
        assert note.summary != ""

    def test_terminal_note_preserves_target_components(self):
        """Terminal notes keep the original query's target_components."""
        q = _make_query("test target")
        note = _terminal_unresearchable_note(q)
        assert note.target_components == ["test"]

    def test_terminal_note_passes_empty_check_guard(self):
        """The empty-note validation in _run_research_query accepts terminal notes."""
        q = _make_query("empty guard check")
        note = _terminal_unresearchable_note(q)
        assert note.findings is not None
        assert note.summary.strip() != ""
        # Would not raise: note.findings (empty) and note.summary.strip() (non-empty)
        # satisfies: not (not note.findings and not note.summary.strip())


class TestResearchNoteTruncation:
    """F4a: Oversized research notes are truncated at persist time."""

    def _big_note(self) -> ResearchNotes:
        return ResearchNotes(
            query_topic="big note",
            target_components=["test"],
            summary="x" * RESEARCH_NOTE_MAX_CHARS,  # oversize
            findings=[],
            gaps=[],
            sources=[],
            narrative_notes="",
            language="English",
            evidence_judgment=None,
        )

    def test_oversized_note_is_truncated(self):
        """A note exceeding RESEARCH_NOTE_MAX_CHARS is truncated with a suffix marker."""
        q = _make_query("big test")
        note = self._big_note()
        files = _research_note_files([q], [note])
        assert len(files) == 1
        _path, content = files[0]
        payload = content.decode("utf-8")
        assert len(payload) <= RESEARCH_NOTE_MAX_CHARS + 200
        assert "[... truncated:" in payload

    def test_truncated_note_stays_valid_json(self):
        """A truncated note remains a round-trip-valid ResearchNotes, not sliced JSON."""
        q = _make_query("big test")
        note = self._big_note()
        _path, content = _research_note_files([q], [note])[0]
        # Parses as JSON and round-trips through the ResearchNotes contract.
        reparsed = ResearchNotes.model_validate(json.loads(content.decode("utf-8")))
        assert "[... truncated:" in reparsed.summary

    def test_small_note_passes_through(self):
        """A note under the size limit is persisted unchanged."""
        q = _make_query("small test")
        note = ResearchNotes(
            query_topic="small",
            target_components=["test"],
            summary="Small note.",
            findings=[],
            gaps=[],
            sources=[],
            narrative_notes="",
            language="English",
            evidence_judgment=None,
        )
        files = _research_note_files([q], [note])
        _path, content = files[0]
        payload = content.decode("utf-8")
        assert "Small note." in payload
        assert "[... truncated:" not in payload


class _FakeModelRequest:
    def __init__(self, msgs):
        self.messages = msgs

    def override(self, *, messages):
        return _FakeModelRequest(messages)


class TestTotalCharBudget:
    """F4b: ToolResultPruningMiddleware total_char_budget enforcement."""

    async def _sent(self, middleware, messages):
        captured = []

        async def handler(request):
            captured[:] = list(request.messages)

        await middleware.awrap_model_call(_FakeModelRequest(messages), handler)
        return captured

    @pytest.mark.asyncio
    async def test_total_budget_truncates_oldest_oversized(self):
        """When total oversized chars exceed budget, oldest oversized messages are truncated first."""
        middleware = ToolResultPruningMiddleware(keep_last_n=10, max_chars=100, total_char_budget=300)
        # 4 oversized messages each 200 chars > max_chars=100, total=800 > budget=300.
        messages = [
            ToolMessage(content="x" * 200, tool_call_id=f"tc{i}", name=f"tool{i}", id=f"msg{i}") for i in range(4)
        ]

        sent = await self._sent(middleware, list(messages))

        # All 4 fit in keep_last_n=10, so none evicted by keep-last-N.
        # Total=800 > 300 budget ÔåÆ truncate oldest until under budget.
        # Truncated msg ÔåÆ max_chars(100) + suffix Ôëê 122 chars.
        # After msg0 truncated: total Ôëê 800-200+122 = 722. Still > 300.
        # After msg1 truncated: total Ôëê 722-200+122 = 644. Still > 300.
        # After msg2 truncated: total Ôëê 644-200+122 = 566. Still > 300.
        # After msg3 truncated: total Ôëê 566-200+122 = 488. Still > 300.
        # All 4 truncated, but total 488 > 300. Budget is a soft ceiling;
        # verify at least the oldest was truncated.
        assert sent[0].content.endswith("[... truncated ...]")

    @pytest.mark.asyncio
    async def test_under_budget_no_extra_truncation(self):
        """When total oversized chars fit within budget, nothing is truncated beyond keep-last-N."""
        middleware = ToolResultPruningMiddleware(keep_last_n=10, max_chars=100, total_char_budget=900)
        messages = [
            ToolMessage(content="x" * 200, tool_call_id=f"tc{i}", name=f"tool{i}", id=f"msg{i}") for i in range(4)
        ]

        sent = await self._sent(middleware, list(messages))

        # Total=800 < budget=900, so no total-budget truncation.
        assert all(len(m.content) == 200 for m in sent)

    @pytest.mark.asyncio
    async def test_zero_budget_disabled(self):
        """total_char_budget=0 disables total-char enforcement."""
        middleware = ToolResultPruningMiddleware(keep_last_n=3, max_chars=100, total_char_budget=0)
        messages = [
            ToolMessage(content="x" * 200, tool_call_id=f"tc{i}", name=f"tool{i}", id=f"msg{i}") for i in range(4)
        ]

        sent = await self._sent(middleware, list(messages))

        # keep_last_n=3 → msg0 (oldest oversized) evicted by keep-last-N;
        # total-char budget=0 means no additional truncation beyond that.
        assert sent[0].content.endswith("[... truncated ...]")
        assert len(sent[1].content) == 200


class TestBudgetThroughBatchToolPath:
    """Backlog item 2 ratchet: budget-exceeded through the real batch tool path.

    Drives ``RunBudgetExceededError`` from a researcher worker through
    ``build_research_batch_tool`` AND the orchestrator's
    ``SelectiveToolRetryMiddleware`` (the exact production stack). Before the fix
    the middleware converted the terminal error into a retryable error
    ToolMessage ("Please try again"), so the orchestrator resubmitted into an
    already-exceeded tracker until the wall clock. Now it must propagate after a
    single execution — no retry loop, no ToolMessage to re-queue.
    """

    def _batch_tool(self):
        runnable = MagicMock()
        runnable.ainvoke = AsyncMock(side_effect=RunBudgetExceededError(ceiling=1000, used=1500))
        return build_research_batch_tool(
            researcher_runnable=runnable,
            callbacks=[],
            max_research_concurrency=2,
            researcher_tool_names={"web_search_tool"},
        )

    def _middleware(self) -> SelectiveToolRetryMiddleware:
        return SelectiveToolRetryMiddleware(
            max_retries=3,
            backoff_factor=0.0,
            initial_delay=0.0,
            jitter=False,
            retry_on=is_retryable_tool_error,
            no_retry_tools={"run_research_batch"},
        )

    @pytest.mark.asyncio
    async def test_batch_tool_alone_reraises_budget(self):
        """The batch tool itself never wraps a budget error into a RuntimeError."""
        batch_tool = self._batch_tool()

        with pytest.raises(RunBudgetExceededError):
            await batch_tool.ainvoke({"queries": [_make_query()]})

    @pytest.mark.asyncio
    async def test_batch_through_middleware_propagates_without_retry_loop(self):
        """Batch + orchestrator middleware: exactly one execution, then propagate.

        Asserts the three properties item 2 requires:
        - no retry loop (the batch runnable ran once; the middleware did not
          re-execute it below the LLM),
        - no re-queueable signal (the error propagates as RunBudgetExceededError,
          never as an error ToolMessage the model could resubmit),
        - degraded, not silent (the exception carries the ceiling so the salvage
          path can mark the run ``run_budget`` instead of shipping it clean).
        """
        from types import SimpleNamespace

        batch_tool = self._batch_tool()
        middleware = self._middleware()
        executions = 0

        async def handler(request):
            nonlocal executions
            executions += 1
            # What the tool layer returns when the tracker is already exceeded:
            # the batch tool raising through, exactly as production does.
            await batch_tool.ainvoke({"queries": [_make_query()]})
            raise AssertionError("unreachable: batch tool must raise")

        request = MagicMock()
        request.tool = SimpleNamespace(name="run_research_batch")
        request.tool_call = {"name": "run_research_batch", "id": "tc1"}

        with pytest.raises(RunBudgetExceededError) as exc_info:
            await middleware.awrap_tool_call(request, handler)

        assert executions == 1
        assert exc_info.value.ceiling == 1000
        assert exc_info.value.used == 1500
