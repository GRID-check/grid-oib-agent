"""Waiting on a run's plan, and turning the plan into what the agent reads (ADR-0068).

The run was commissioned with its plan, and its block shows the plan from the
first second. The worker takes its slot and then waits here: until the plan's
clock passes or the reader presses „Starten". While it waits the ledger says
``wartet`` — the status the vocabulary reserved for a run that waits on a
person — and the reader's cancel ends the wait the way it ends a run, because
this coroutine runs inside the same cancellation wrapper as the agent.

Once started, the plan read at that instant is the plan the run runs: its
sections, genre and depth become the prompt text every deep-research prompt
reads, and its Unterlagen the agent state's documents. The Rahmen is not read
here: the tools were filtered by the sources the run was submitted with.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol

from aiq_agent.common.plan_documents import PlanDocuments
from aiq_agent.common.research_plan import ResearchPlan

from .plan_client import PlanClaim
from .plan_client import PlanUnavailableError

logger = logging.getLogger(__name__)

#: How long the worker keeps trying through transient failures (no BFF, a 5xx)
#: before it gives the run up. A reader's hold is not a failure and never
#: counts here.
MAX_UNAVAILABLE_SECONDS = 600.0


class _Claims(Protocol):
    async def claim_start(self, plan_id: str) -> PlanClaim: ...


class _Waiting(Protocol):
    def note_waiting(self) -> None: ...

    def note_resumed(self) -> None: ...


@dataclass(frozen=True)
class StartedPlan:
    """What the run is handed once its plan starts."""

    plan: ResearchPlan
    clarifier_result: str
    documents: PlanDocuments | None


async def await_plan_start(
    plan_id: str,
    client: _Claims,
    ledger: _Waiting,
    *,
    sleep=asyncio.sleep,
    max_unavailable_seconds: float = MAX_UNAVAILABLE_SECONDS,
) -> ResearchPlan:
    """Poll the plan's claim until it starts. Raises what the claim raises when it gives up.

    ``PlanReplacedError`` ends the wait at once. ``PlanUnavailableError`` is
    retried until ``max_unavailable_seconds`` of consecutive failures.
    """
    waiting = False
    unavailable_for = 0.0
    while True:
        try:
            claim = await client.claim_start(plan_id)
        except PlanUnavailableError:
            if unavailable_for >= max_unavailable_seconds:
                raise
            logger.warning("Plan %s: the start claim failed; retrying", plan_id, exc_info=True)
            unavailable_for += 5.0
            await sleep(5.0)
            continue
        unavailable_for = 0.0
        if claim.started:
            if waiting:
                ledger.note_resumed()
            return claim.plan
        # Only a HELD plan is a run waiting on a person. A proposed plan
        # counting down waits on nobody, and ``wartet`` there would put an
        # inbox row in front of every requester for the length of the grace.
        on_a_person = claim.plan.status == "held"
        if on_a_person and not waiting:
            logger.info("Plan %s: held, waiting for the reader to start it", plan_id)
            ledger.note_waiting()
        elif waiting and not on_a_person:
            ledger.note_resumed()
        waiting = on_a_person
        await sleep(claim.retry_after_seconds)


def started_plan(plan: ResearchPlan, clarifier_result: str | None) -> StartedPlan:
    """The plan as the agent reads it: the Q&A the turn settled, then the plan."""
    context = plan.context()
    settled = (clarifier_result or "").strip()
    return StartedPlan(
        plan=plan,
        clarifier_result=f"{settled}\n\n{context}" if settled else context,
        documents=plan.documents(),
    )
