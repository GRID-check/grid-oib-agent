"""Coarse-grained phase-progress events for deep-research jobs (T4-4).

The UI otherwise shows nothing for several minutes while the deep-research
graph plans, researches, and writes. This module derives phase transitions
from the subagent dispatches the orchestrator already makes through the
``task`` tool (DeepAgents' subagent dispatcher --
``deepagents.middleware.subagents._build_task_tool``) and the
``run_research_batch`` tool (the orchestrator-only batched-research tool
built in ``aiq_agent.agents.deep_researcher.tools.research``) -- WITHOUT
importing or modifying the deep_researcher package itself. The subagent name
strings ("planner-agent", "writer-agent", ...) are a stable, documented
contract owned by ``aiq_agent.agents.deep_researcher.factory`` (PLANNER_AGENT,
WRITER_AGENT, ...); they are duplicated here rather than imported so this
module never needs to import the (off-limits-to-edit) deep_researcher
package.

Detection hook: ``on_tool_start``/``on_tool_end`` on the standard LangChain
callback stack already assembled in ``aiq_api.jobs.runner`` for every
deep-research job (the same stack ``AgentEventCallback`` and
``VerboseTraceCallback`` use). LangChain's ``ToolCallbackManager`` forwards
the tool's original (pre-string-formatting) argument dict as the ``inputs``
kwarg alongside the legacy ``input_str`` -- see
``langchain_core.callbacks.manager.CallbackManagerMixin.on_tool_start``
docstring: "Recommended for usage instead of input_str when the original
input is needed." That gives cheap, reliable access to the task tool's
``subagent_type`` argument and the research batch tool's ``queries`` list
length without any string parsing.

Citation verification has no callback event of its own: ``verify_citations``/
``sanitize_report`` run as plain Python in ``DeepResearcherAgent.run()``
immediately after the writer-agent's ``task`` call returns (see
``agent.py``), so this module infers ``citation_verification_started`` from
that ``task`` call's ``on_tool_end``.

Persisted as ``job.phase`` job_events rows -- ``{"type": "job.phase", "data":
{"phase": ..., ...}}`` -- matching the shape of the other job.* lifecycle
events already emitted directly in ``aiq_api.jobs.runner``
(job.heartbeat, job.error, job.cancelled, job.cancellation_requested) so the
existing SSE surface streams them to the UI unchanged.
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger(__name__)

# Stable subagent-name contract from aiq_agent.agents.deep_researcher.factory
# (PLANNER_AGENT / WRITER_AGENT). Duplicated rather than imported -- see
# module docstring.
PLANNER_AGENT_NAME = "planner-agent"
WRITER_AGENT_NAME = "writer-agent"

TASK_TOOL_NAME = "task"
RESEARCH_BATCH_TOOL_NAME = "run_research_batch"

PHASE_PLANNING_STARTED = "planning_started"
PHASE_RESEARCH_STARTED = "research_started"
PHASE_WRITING_STARTED = "writing_started"
PHASE_CITATION_VERIFICATION_STARTED = "citation_verification_started"
PHASE_DONE = "done"

JOB_PHASE_EVENT_TYPE = "job.phase"


def emit_phase_event(event_store: Any, phase: str, **extra: Any) -> None:
    """Store one ``job.phase`` job_events row.

    Best-effort like the other job.* lifecycle events written directly in
    ``aiq_api.jobs.runner`` -- a phase-event failure must never fail or even
    slow down the underlying research job.
    """
    if event_store is None:
        return
    try:
        event_store.store({"type": JOB_PHASE_EVENT_TYPE, "data": {"phase": phase, **extra}})
    except Exception:
        logger.warning("Failed to store job.phase event %r (non-fatal)", phase, exc_info=True)


class PhaseProgressCallback(BaseCallbackHandler):
    """Detects deep-research phase transitions from tool-call events.

    A single instance is shared for the whole job -- it deliberately does not
    implement ``for_new_run()``. Per the ADR-0018 convention used elsewhere in
    this codebase (see ``DeepResearcherAgent._prepare_run`` and
    ``tools/research.py._run_research_query``), callbacks without
    ``for_new_run`` are forwarded to researcher workers unchanged rather than
    replaced with a fresh instance. That is exactly what this callback needs:
    ``task``/``run_research_batch`` are orchestrator-only tools that
    researcher workers never call themselves, so sharing one instance across
    the whole job (rather than resetting per subagent/worker) is both correct
    and required for the "emit once" phases to actually dedupe.
    """

    def __init__(self, event_store: Any, max_research_concurrency: int | None = None) -> None:
        super().__init__()
        self._event_store = event_store
        self._max_research_concurrency = max_research_concurrency
        self._emitted_once: set[str] = set()
        self._run_id_subagent: dict[str, str] = {}
        self._research_batch_count = 0

    def _emit_once(self, phase: str, **extra: Any) -> None:
        if phase in self._emitted_once:
            return
        self._emitted_once.add(phase)
        emit_phase_event(self._event_store, phase, **extra)

    @staticmethod
    def _tool_name(serialized: dict | None, kwargs: dict) -> str:
        if serialized:
            return serialized.get("name", "") or ""
        return kwargs.get("name", "") or ""

    @staticmethod
    def _inputs_dict(input_str: str, kwargs: dict) -> dict | None:
        """Return the tool's original argument dict, cheaply and defensively.

        Prefers the ``inputs`` kwarg LangChain forwards alongside
        ``input_str`` (the pre-stringification dict -- see module docstring).
        Falls back to best-effort parsing of ``input_str`` for callers/tool
        wrappers that don't populate ``inputs``.
        """
        inputs = kwargs.get("inputs")
        if isinstance(inputs, dict):
            return inputs
        if not input_str:
            return None
        import ast

        try:
            parsed = ast.literal_eval(input_str)
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None

    def on_tool_start(self, serialized: dict | None, input_str: str, **kwargs: Any) -> None:
        tool_name = self._tool_name(serialized, kwargs)
        run_id = str(kwargs.get("run_id", "")) if kwargs.get("run_id") is not None else ""

        if tool_name == TASK_TOOL_NAME:
            inputs = self._inputs_dict(input_str, kwargs)
            subagent_type = inputs.get("subagent_type") if isinstance(inputs, dict) else None
            if not isinstance(subagent_type, str):
                return
            if run_id:
                self._run_id_subagent[run_id] = subagent_type
            if subagent_type == PLANNER_AGENT_NAME:
                self._emit_once(PHASE_PLANNING_STARTED)
            elif subagent_type == WRITER_AGENT_NAME:
                self._emit_once(PHASE_WRITING_STARTED)
            return

        if tool_name == RESEARCH_BATCH_TOOL_NAME:
            inputs = self._inputs_dict(input_str, kwargs)
            queries = inputs.get("queries") if isinstance(inputs, dict) else None
            self._research_batch_count += 1
            extra: dict[str, Any] = {"batch_index": self._research_batch_count}
            if isinstance(queries, list):
                extra["batch_size"] = len(queries)
            if self._max_research_concurrency:
                extra["max_concurrency"] = self._max_research_concurrency
            # Not deduped via _emit_once: unlike the other phases (entered
            # exactly once per job), the orchestrator can call
            # run_research_batch multiple times across planning iterations,
            # and surfacing each batch's size is the point of this event.
            emit_phase_event(self._event_store, PHASE_RESEARCH_STARTED, **extra)

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        run_id = str(kwargs.get("run_id", "")) if kwargs.get("run_id") is not None else ""
        subagent_type = self._run_id_subagent.pop(run_id, None) if run_id else None
        if subagent_type == WRITER_AGENT_NAME:
            self._emit_once(PHASE_CITATION_VERIFICATION_STARTED)
