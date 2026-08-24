"""Tests for deep-research phase-progress event detection (backlog T4-4).

Covers: subagent-name based phase detection off the "task" tool (planning /
writing), batch-size reporting off "run_research_batch" (research), the
writer-task-end -> citation-verification-started inference, dedup semantics
(each of the four "entered once" phases fires exactly once; research_started
fires on every batch), and the job.phase event schema written to the event
store.
"""

from __future__ import annotations

from aiq_api.jobs.phase_events import JOB_PHASE_EVENT_TYPE
from aiq_api.jobs.phase_events import PHASE_CITATION_VERIFICATION_STARTED
from aiq_api.jobs.phase_events import PHASE_DONE
from aiq_api.jobs.phase_events import PHASE_PLANNING_STARTED
from aiq_api.jobs.phase_events import PHASE_RESEARCH_STARTED
from aiq_api.jobs.phase_events import PHASE_WRITING_STARTED
from aiq_api.jobs.phase_events import PhaseProgressCallback
from aiq_api.jobs.phase_events import emit_phase_event


class FakeEventStore:
    """Records every stored event dict, mirroring EventStore/BatchingEventStore.store()."""

    def __init__(self) -> None:
        self.events: list[dict] = []

    def store(self, event: dict) -> None:
        self.events.append(event)


class RaisingEventStore:
    def store(self, event: dict) -> None:
        raise RuntimeError("db unavailable")


def _task_start(callback: PhaseProgressCallback, subagent_type: str, run_id: str, *, via_input_str: bool = False):
    """Fire on_tool_start for the "task" tool the way DeepAgents' subagent
    dispatcher (deepagents.middleware.subagents._build_task_tool) invokes it.
    """
    if via_input_str:
        callback.on_tool_start(
            {"name": "task"},
            f"{{'description': 'do the thing', 'subagent_type': '{subagent_type}'}}",
            run_id=run_id,
        )
    else:
        callback.on_tool_start(
            {"name": "task"},
            "irrelevant-when-inputs-kwarg-present",
            run_id=run_id,
            inputs={"description": "do the thing", "subagent_type": subagent_type},
        )


def _task_end(callback: PhaseProgressCallback, run_id: str, output: str = "done") -> None:
    callback.on_tool_end(output, run_id=run_id)


class TestPlanningPhase:
    def test_planner_task_start_emits_planning_started(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        _task_start(callback, "planner-agent", run_id="run-1")

        assert store.events == [{"type": JOB_PHASE_EVENT_TYPE, "data": {"phase": PHASE_PLANNING_STARTED}}]

    def test_planner_task_repeated_calls_dedup(self):
        """The planner subagent can be invoked more than once across an
        orchestrator's iterations; planning_started must fire only once."""
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        _task_start(callback, "planner-agent", run_id="run-1")
        _task_start(callback, "planner-agent", run_id="run-2")

        planning_events = [e for e in store.events if e["data"]["phase"] == PHASE_PLANNING_STARTED]
        assert len(planning_events) == 1

    def test_falls_back_to_input_str_when_inputs_kwarg_missing(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        _task_start(callback, "planner-agent", run_id="run-1", via_input_str=True)

        assert store.events == [{"type": JOB_PHASE_EVENT_TYPE, "data": {"phase": PHASE_PLANNING_STARTED}}]


class TestWritingAndCitationVerificationPhase:
    def test_writer_task_start_emits_writing_started(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        _task_start(callback, "writer-agent", run_id="run-1")

        assert store.events == [{"type": JOB_PHASE_EVENT_TYPE, "data": {"phase": PHASE_WRITING_STARTED}}]

    def test_writer_task_end_emits_citation_verification_started(self):
        """DeepResearcherAgent.run() runs verify_citations/sanitize_report as
        plain Python immediately after the writer-agent task returns -- no
        callback event of its own, so this is inferred from the task ending."""
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        _task_start(callback, "writer-agent", run_id="run-1")
        _task_end(callback, run_id="run-1")

        phases = [e["data"]["phase"] for e in store.events]
        assert phases == [PHASE_WRITING_STARTED, PHASE_CITATION_VERIFICATION_STARTED]

    def test_citation_verification_started_fires_once(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        _task_start(callback, "writer-agent", run_id="run-1")
        _task_end(callback, run_id="run-1")
        # A second, unrelated task call ending must not re-trigger it.
        _task_start(callback, "planner-agent", run_id="run-2")
        _task_end(callback, run_id="run-2")

        citation_events = [e for e in store.events if e["data"]["phase"] == PHASE_CITATION_VERIFICATION_STARTED]
        assert len(citation_events) == 1

    def test_non_writer_task_end_does_not_emit_citation_verification(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        _task_start(callback, "planner-agent", run_id="run-1")
        _task_end(callback, run_id="run-1")

        phases = [e["data"]["phase"] for e in store.events]
        assert PHASE_CITATION_VERIFICATION_STARTED not in phases

    def test_source_router_task_emits_no_tracked_phase(self):
        """source-router-agent isn't one of the four tracked subagent phases."""
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        _task_start(callback, "source-router-agent", run_id="run-1")
        _task_end(callback, run_id="run-1")

        assert store.events == []


class TestResearchPhase:
    def test_run_research_batch_emits_research_started_with_batch_size(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store, max_research_concurrency=6)

        callback.on_tool_start(
            {"name": "run_research_batch"},
            "irrelevant",
            run_id="run-1",
            inputs={"queries": [{"query": "a"}, {"query": "b"}, {"query": "c"}]},
        )

        assert store.events == [
            {
                "type": JOB_PHASE_EVENT_TYPE,
                "data": {
                    "phase": PHASE_RESEARCH_STARTED,
                    "batch_index": 1,
                    "batch_size": 3,
                    "max_concurrency": 6,
                },
            }
        ]

    def test_run_research_batch_not_deduped_across_calls(self):
        """Unlike the other phases, each batch call is a fresh unit of
        progress and must be surfaced every time -- not just the first."""
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        callback.on_tool_start(
            {"name": "run_research_batch"}, "irrelevant", run_id="run-1", inputs={"queries": [{"query": "a"}]}
        )
        callback.on_tool_start(
            {"name": "run_research_batch"},
            "irrelevant",
            run_id="run-2",
            inputs={"queries": [{"query": "b"}, {"query": "c"}]},
        )

        research_events = [e for e in store.events if e["data"]["phase"] == PHASE_RESEARCH_STARTED]
        assert [e["data"]["batch_index"] for e in research_events] == [1, 2]
        assert [e["data"]["batch_size"] for e in research_events] == [1, 2]

    def test_omits_batch_size_when_queries_not_a_list(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        callback.on_tool_start({"name": "run_research_batch"}, "irrelevant", run_id="run-1", inputs={})

        assert store.events[0]["data"] == {"phase": PHASE_RESEARCH_STARTED, "batch_index": 1}

    def test_max_concurrency_omitted_when_not_provided(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)  # no max_research_concurrency

        callback.on_tool_start(
            {"name": "run_research_batch"}, "irrelevant", run_id="run-1", inputs={"queries": [{"query": "a"}]}
        )

        assert "max_concurrency" not in store.events[0]["data"]


class TestUnrelatedToolsIgnored:
    def test_non_task_non_batch_tool_emits_nothing(self):
        store = FakeEventStore()
        callback = PhaseProgressCallback(store)

        callback.on_tool_start({"name": "web_search"}, "irrelevant", run_id="run-1", inputs={"query": "x"})
        callback.on_tool_end("result", run_id="run-1")

        assert store.events == []


class TestEmitPhaseEvent:
    def test_stores_job_phase_event(self):
        store = FakeEventStore()
        emit_phase_event(store, PHASE_DONE)
        assert store.events == [{"type": JOB_PHASE_EVENT_TYPE, "data": {"phase": PHASE_DONE}}]

    def test_extra_fields_merged_into_data(self):
        store = FakeEventStore()
        emit_phase_event(store, PHASE_RESEARCH_STARTED, batch_index=2, batch_size=4)
        assert store.events == [
            {
                "type": JOB_PHASE_EVENT_TYPE,
                "data": {"phase": PHASE_RESEARCH_STARTED, "batch_index": 2, "batch_size": 4},
            }
        ]

    def test_none_event_store_is_a_noop(self):
        emit_phase_event(None, PHASE_DONE)  # must not raise

    def test_store_failure_is_swallowed(self):
        emit_phase_event(RaisingEventStore(), PHASE_DONE)  # must not raise
