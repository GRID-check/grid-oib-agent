"""Per-turn usage rollup in dollars: what one turn spent, in one record.

The per-call ledger (``GridCostTracker`` → ``llm_usage_events``) records every
model call, but its rows carry no turn id — per-turn waste is not a GROUP BY
anywhere. This module is the usage sibling of ``common.citation_events``
(citation health) and mirrors its pattern exactly:

- a pure :func:`build_usage_rollup` the tests exercise directly,
- a best-effort :func:`record_usage_turn` that never raises into the answer path,
- turn identity resolved the same way (explicit args win, then the active
  profiler — which is what links the rollup to the turn's timeline and what
  makes async jobs without request headers work).

The sink differs on purpose: there is NO turn-level BFF endpoint in this
scope (adding one is a BFF migration, not a telemetry passthrough), and the
per-call dollars already land in ``llm_usage_events``. The rollup rides the
trace itself via ``record_trace_metadata`` — per-turn tokens and dollars,
queryable in Langfuse next to the spans they explain — and returns its
payload so a future endpoint can consume the exact shape pinned here.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class UsageRollup:
    """One turn's whole spend: every LLM call the turn's tracker saw."""

    llm_calls: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cost_usd: float
    #: 'usage_field' when dollars were observed, 'missing' when the provider
    #: reported no cost (per-call provenance stays in ``llm_usage_events``).
    cost_source: str
    #: Why this row exists despite no spend: ``NO_CALLS_ERROR`` on a zero row.
    #: None on a spending turn. A turn that spent nothing still records a row —
    #: "no calls" and "the rollup failed" must read differently on the
    #: dashboard, and only a flag on the row itself survives the trace export.
    error: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "llmCalls": self.llm_calls,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "totalTokens": self.total_tokens,
            "costUsd": self.cost_usd,
            "costSource": self.cost_source,
            "error": self.error,
        }


#: The ``error`` flag a zero row carries: the turn made no LLM calls, so there
#: is no spend to attribute — recorded as a row rather than as silence.
NO_CALLS_ERROR = "no_llm_calls"


def build_usage_rollup(
    *,
    llm_calls: int,
    prompt_tokens: int,
    completion_tokens: int,
    total_tokens: int | None = None,
    cost_usd: float = 0.0,
    cost_source: str | None = None,
) -> UsageRollup:
    """Assemble one turn's rollup — a zero row with an error flag when the turn made no LLM calls.

    A call-free turn still records a row: like every other turn, it spent an
    observable zero, and silence on the dashboard reads as "the rollup failed".
    The ``error`` flag (``NO_CALLS_ERROR``) is what tells the two apart. Pure
    and side-effect free.
    """
    calls = max(0, int(llm_calls or 0))
    if calls <= 0:
        return UsageRollup(
            llm_calls=0,
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
            cost_usd=0.0,
            cost_source=cost_source or "missing",
            error=NO_CALLS_ERROR,
        )
    prompt = max(0, int(prompt_tokens or 0))
    completion = max(0, int(completion_tokens or 0))
    total = max(0, int(total_tokens)) if total_tokens is not None else prompt + completion
    cost = max(0.0, float(cost_usd or 0.0))
    return UsageRollup(
        llm_calls=calls,
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        cost_usd=round(cost, 6),
        cost_source=cost_source or ("usage_field" if cost > 0 else "missing"),
    )


def from_tracker(tracker: Any) -> UsageRollup | None:
    """Build the rollup off a ``GridCostTracker``.

    A tracker that saw no calls yields the zero row (see
    :func:`build_usage_rollup`); ``None`` only when the tracker itself is
    missing or unreadable — unknown is not zero, and a fabricated row would
    claim a measurement that never happened.

    Duck-typed (``events_recorded``/``prompt_tokens``/``completion_tokens``/
    ``turn_cost_usd``) like ``stages.runner._cost_metadata``: the tracker is
    the whole turn's accumulator either way, so a turn's cost is the whole
    turn's cost. The tracker aggregates no cached/reasoning split and no
    model list — that detail stays per-call in ``llm_usage_events``.

    ``cost_source`` is read off the tracker when it aggregates one
    (``usage_field``/``estimate``/``mixed``), so the rollup reports the
    provenance the EVENTS carry instead of inferring ``usage_field`` from a
    positive cost; a tracker that states none falls back to that inference.
    """
    try:
        return build_usage_rollup(
            llm_calls=int(getattr(tracker, "events_recorded", 0) or 0),
            prompt_tokens=int(getattr(tracker, "prompt_tokens", 0) or 0),
            completion_tokens=int(getattr(tracker, "completion_tokens", 0) or 0),
            cost_usd=float(getattr(tracker, "turn_cost_usd", 0.0) or 0.0),
            cost_source=getattr(tracker, "cost_source", None),
        )
    except Exception:
        logger.debug("Could not build a usage rollup from the tracker", exc_info=True)
        return None


def _resolve_turn(turn_id: str | None, job_id: str | None, tracker: Any) -> tuple[str | None, str | None]:
    """Turn/job for one rollup: explicit args win, then the tracker, then the profiler.

    Mirrors ``citation_events._resolve_context`` minus the fresh-UUID tier: a
    rollup without a turn to belong to is still worth stamping (its trace
    metadata lands on whatever trace is ambient), so no id is invented here.
    """
    resolved_turn = turn_id
    resolved_job = job_id if job_id is not None else getattr(tracker, "job_id", None)
    if resolved_turn is None:
        try:
            from aiq_agent.common.profiler import agent_profiler_var

            profiler = agent_profiler_var.get()
            if profiler is not None:
                resolved_turn = getattr(profiler, "turn_id", None)
                if resolved_job is None:
                    resolved_job = getattr(profiler, "job_id", None)
        except Exception:
            logger.debug("Could not read the active agent profiler for the usage rollup", exc_info=True)
    return resolved_turn, resolved_job


def record_usage_turn(
    *,
    tracker: Any,
    agent: str = "chat",
    turn_id: str | None = None,
    job_id: str | None = None,
    identity: dict[str, str | None] | None = None,
) -> dict[str, Any] | None:
    """Record one turn's usage rollup. Never raises; None only when the tracker is unreadable.

    Stamps the totals as Langfuse trace metadata (per-turn dollars queryable
    next to the spans) and returns the payload — including the zero row of a
    call-free turn, whose ``error`` flag says it spent nothing. Call once per
    turn, where the turn finalizes — currently ``profiler.flush_after_answer``,
    the single funnel that already holds every turn's ledgers after the answer
    is out.
    """
    try:
        rollup = from_tracker(tracker)
    except Exception:
        logger.warning("Could not build the turn usage rollup", exc_info=True)
        return None
    if rollup is None:
        return None
    try:
        resolved_turn, resolved_job = _resolve_turn(turn_id, job_id, tracker)
        payload: dict[str, Any] = {
            "agent": agent,
            "organizationId": (identity or {}).get("organization_id", getattr(tracker, "organization_id", None)),
            "conversationId": (identity or {}).get("conversation_id", getattr(tracker, "conversation_id", None)),
            "turnId": resolved_turn,
            "jobId": resolved_job,
            "rollup": rollup.to_payload(),
        }
    except Exception:
        logger.warning("Could not assemble the turn usage rollup", exc_info=True)
        return None
    try:
        from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata

        record_trace_metadata(
            usage_llm_calls=rollup.llm_calls,
            usage_prompt_tokens=rollup.prompt_tokens,
            usage_completion_tokens=rollup.completion_tokens,
            usage_total_tokens=rollup.total_tokens,
            usage_cost_usd=rollup.cost_usd,
        )
    except Exception:
        logger.debug("Could not stamp the turn usage rollup onto the trace", exc_info=True)
    return payload
