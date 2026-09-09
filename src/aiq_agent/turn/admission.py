"""Running the answering agent under admission control, budget and profiling.

A turn OCCUPIES capacity for as long as it runs, so the concurrency slot is
held around the run itself (ADR-0040 L3); outside it, a per-minute rate limit
would still admit an unbounded number of simultaneous research runs at a
steady trickle. Cost capture wraps the same run: every LLM call inside
inherits the tracker through LangChain's configure hook. The profiler root is
the CALLER's (it opens before the setup I/O so the context loads, the ingest
hold and the admission wait all have a row); this module only adds the spans
and hands the cost tracker back for the deferred flush.

A refusal is a VALUE, not an exception that escapes: the caller streams it as
a short response and stops, the same contract as every other refusal in the
system — say WHEN to come back, not just no.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any
from typing import Generic
from typing import Protocol
from typing import TypeVar

from aiq_agent.common import _create_chat_response
from aiq_agent.common.cost_tracking import BudgetExceededError
from aiq_agent.common.cost_tracking import track_llm_costs
from aiq_agent.common.profiler import profiled_span
from aiq_agent.common.turn_admission import TurnAdmissionError
from aiq_agent.common.turn_admission import admit_turn_async
from nat.data_models.api_server import ChatResponse

logger = logging.getLogger(__name__)

#: The name of the profiler ROOT span for a chat turn. A persisted identifier,
#: not a module path: it is stored per turn as `agent_profiler_spans.name` and
#: matched by string in `frontends/ui/src/features/chat/lib/trace-lanes.ts`, so
#: it stayed put when the package that used to be called `chat_researcher` was
#: folded into the researcher. Renaming it re-labels the reasoning view for
#: every turn already stored.
PROFILE_AGENT_NAME = "chat_researcher"

StateT = TypeVar("StateT")
T = TypeVar("T")


class AnsweringAgent(Protocol[StateT]):
    def run(self, state: StateT, thread_id: str | None = None) -> Awaitable[StateT]: ...


async def spanned(name: str, awaitable: Awaitable[T]) -> T:
    """Await inside a profiler span. Each gathered branch runs in its own task
    and therefore its own copy of the context, so the span nests under the
    turn root and never leaks into a sibling."""
    with profiled_span(name):
        return await awaitable


@dataclass(frozen=True)
class TurnRefusal:
    """A turn that started nothing: capacity or budget said no."""

    response_id: str
    message: str
    retry_after_seconds: int | None = None
    #: The profiler's word for how the turn ended.
    outcome: str = "refused"


@dataclass(frozen=True)
class TurnOutcome(Generic[StateT]):
    """What ``answer_turn`` produced: a finished state or a refusal, and the
    cost ledger to flush once the reader has been served."""

    state: StateT | None
    refusal: TurnRefusal | None
    cost_tracker: Any = None


async def run_admitted(
    agent: AnsweringAgent[StateT],
    state: StateT,
    *,
    thread_id: str,
    organization_id: str | None,
    identity: dict[str, str | None] | None = None,
) -> tuple[StateT, Any]:
    """Run the agent inside the admission slot and the cost tracker; return both results.

    The wait for a slot gets its own span: queued time is the one cost a busy
    replica adds that no LLM or tool row would ever explain. ``inline_flush``
    is off: the final usage batch is posted by the caller after the answer is
    on the wire, never between the finished answer and its first delta.
    """
    async with contextlib.AsyncExitStack() as admission:
        with profiled_span("admission.wait"):
            await admission.enter_async_context(admit_turn_async(organization_id))
        with track_llm_costs(identity=identity, inline_flush=False) as cost_tracker:
            return await agent.run(state, thread_id=thread_id), cost_tracker


async def answer_turn(
    agent: AnsweringAgent[StateT],
    state: StateT,
    *,
    thread_id: str,
    organization_id: str | None,
    identity: dict[str, str | None] | None = None,
    metadata: dict[str, Any] | None = None,
) -> TurnOutcome[StateT]:
    """The finished graph state, or the refusal that stopped the turn.

    ``identity`` is who the ledgers bill and attribute the turn to (the parsed
    request, so they need not parse it again); ``metadata`` is the profiler's
    turn metadata, where a refusal records its outcome while the root is open.
    """
    try:
        result, cost_tracker = await run_admitted(
            agent, state, thread_id=thread_id, organization_id=organization_id, identity=identity
        )
    except TurnAdmissionError as error:
        logger.warning("Turn refused by admission control: %s", error)
        refusal = TurnRefusal("turn_admission", str(error), error.retry_after_seconds, outcome="admission_refused")
    except BudgetExceededError as error:
        logger.warning("Turn stopped by budget enforcement: %s", error)
        refusal = TurnRefusal("budget_exceeded", str(error), outcome="budget_exceeded")
    else:
        return TurnOutcome(state=result, refusal=None, cost_tracker=cost_tracker)
    if metadata is not None:
        metadata["outcome"] = refusal.outcome
    return TurnOutcome(state=None, refusal=refusal)


def refusal_response(refusal: TurnRefusal, *, workflow_id: str) -> ChatResponse:
    """The short response a refused turn delivers, with its retry hint when it has one."""
    response = _create_chat_response(refusal.message, response_id=refusal.response_id, model=workflow_id)
    if refusal.retry_after_seconds is not None:
        response.retry_after_seconds = refusal.retry_after_seconds
    return response
