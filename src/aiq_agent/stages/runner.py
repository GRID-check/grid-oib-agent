"""Scheduling and execution of post-answer stages.

Everything the ten non-negotiables ask for lives here **once**, rather than once
per stage:

- **Fault isolation.** Stages are ``create_task``, never awaited by the turn, and
  every handler runs inside ``asyncio.wait_for`` with the stage's declared hard
  timeout. A stage cannot raise into the turn because the turn is not awaiting it.
- **Backpressure.** One shared, per-event-loop semaphore across all stages, plus
  a pending cap beyond which stages are **dropped, not queued** — and the drop is
  recorded (``reason="pending_cap"``), so load-shedding is a number rather than a
  silent absence. Shared and not per-stage on purpose: the resource under
  pressure is the event loop that is also delivering live answers.
- **Observability.** Every terminal state emits a profiler span carrying
  ``metadata.outcome`` — *including* the states where nothing happened, which is
  the data that makes a deterministic gate falsifiable.
- **Cost.** The handler's LLM traffic is wrapped in ``track_llm_costs`` with an
  empty budget snapshot: a post-answer stage is never hard-stopped by a budget it
  did not spend against, but its spend **is** attributed to the tenant.
- **Idempotency.** At most one run per ``(conversation_id, ws_parent_id,
  stage_id)``.

No function in this module branches on a stage id.

See docs/architecture/post-answer-stages.md.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import weakref
from collections import OrderedDict
from collections.abc import Mapping
from datetime import UTC
from datetime import datetime
from typing import Any

from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.stages.delivery import deliver_stage_frame
from aiq_agent.stages.registry import iter_stages
from aiq_agent.stages.spec import StageContext
from aiq_agent.stages.spec import StageEmpty
from aiq_agent.stages.spec import StageOutcome
from aiq_agent.stages.spec import StageSpec
from aiq_agent.stages.spec import TurnFacts

logger = logging.getLogger(__name__)

#: Shared across ALL stages, not per stage: two stages with four slots each is
#: eight background LLM calls competing with live turns.
_MAX_CONCURRENCY = int(os.environ.get("GRID_STAGE_MAX_CONCURRENCY", "4"))
#: Beyond this many in-flight handlers, further stages are dropped rather than
#: queued — a stage is a best-effort enhancement of an already-delivered answer.
_MAX_PENDING = int(os.environ.get("GRID_STAGE_MAX_PENDING", "16"))

#: Strong references to in-flight tasks so the event loop's weak bookkeeping does
#: not garbage-collect a stage mid-run.
_background_tasks: set[asyncio.Task] = set()
#: The subset that is actually running a handler — what the pending cap counts.
#: Recording-only tasks (a skip, a disabled stage) do no LLM work and must not
#: shed real work.
_handler_tasks: set[asyncio.Task] = set()

#: Semaphores are loop-bound; keyed weakly per loop, because the chat process
#: and the Dask workers run separate event loops.
_semaphores: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = weakref.WeakKeyDictionary()

#: Bounded LRU of ``(conversation_id, ws_parent_id, stage_id)`` keys already
#: claimed. Bounded rather than unbounded because it is a re-entrancy guard on a
#: long-lived process, not an audit log.
_MAX_REMEMBERED_KEYS = 1024
_claimed_keys: OrderedDict[tuple[str, str, str], None] = OrderedDict()

#: Contract version of the stage frame envelope; bump on a breaking change.
STAGE_FRAME_VERSION = 1
STAGE_FRAME_TYPE = "grid_stage_message"


def _loop_semaphore(loop: asyncio.AbstractEventLoop) -> asyncio.Semaphore:
    semaphore = _semaphores.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)
        _semaphores[loop] = semaphore
    return semaphore


def _claim(spec: StageSpec, facts: TurnFacts) -> bool:
    """Claim this stage for this turn, or report that it is already claimed.

    Returns ``True`` when there is nothing to be idempotent against — a turn with
    no ``ws_parent_id`` (CLI, REST, job worker) has no identity, and keying on the
    conversation alone would suppress every turn after the first.
    """
    turn_key = facts.turn_key
    if turn_key is None:
        return True
    key = (turn_key[0], turn_key[1], spec.id)
    if key in _claimed_keys:
        return False
    _claimed_keys[key] = None
    while len(_claimed_keys) > _MAX_REMEMBERED_KEYS:
        _claimed_keys.popitem(last=False)
    return True


def build_stage_frame(spec: StageSpec, facts: TurnFacts, outcome: StageOutcome) -> dict[str, Any]:
    """The wire frame for one stage outcome (contract §4.1).

    ``parent_id`` is the correlation key and the only one: it is the id both
    halves genuinely share. A frame whose ``parent_id`` matches no message is
    dropped client-side. ``status`` rides even when there is nothing to show —
    ``empty`` is not the same fact as "no frame arrived", and only the former
    lets a client stop reserving space. A ``failed`` frame carries no reason:
    failure reasons are machine keys for the ledger, not user-facing text.
    """
    status = "failed" if outcome.status == "timeout" else outcome.status
    frame: dict[str, Any] = {
        "type": STAGE_FRAME_TYPE,
        "v": STAGE_FRAME_VERSION,
        "conversation_id": facts.conversation_id,
        "parent_id": facts.ws_parent_id,
        "stage": spec.id,
        "status": status,
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    }
    if outcome.status == "ready" and outcome.payload is not None:
        frame["payload"] = outcome.payload
    return frame


def _resolve_llm(spec: StageSpec, llms: Mapping[AgentGroup, Any] | None) -> Any:
    """The stage's LLM with the org's model override and BYOK credential applied.

    Applied HERE — synchronously, at schedule time — and not inside the task,
    because both transforms read the request context, which is torn down by the
    time the task runs. Fails open to the un-transformed model: a stage running
    on the workflow default is better than a stage that does not run.
    """
    base = (llms or {}).get(spec.agent_group)
    if base is None:
        return None
    try:
        from aiq_agent.common import apply_model_override
        from aiq_agent.common import apply_org_credential

        llm = apply_org_credential(apply_model_override(base, spec.agent_group))
    except Exception:
        logger.warning("Stage %s: model override/credential swap failed; using the configured model", spec.id)
        llm = base
    if spec.max_output_tokens is not None:
        try:
            llm = llm.bind(max_tokens=spec.max_output_tokens)
        except Exception:
            logger.warning("Stage %s: could not bind max_tokens=%s", spec.id, spec.max_output_tokens)
    return llm


def _pre_run_outcome(spec: StageSpec, facts: TurnFacts) -> StageOutcome | None:
    """The terminal outcome reached without running anything, or ``None`` to run.

    The flag is checked before the gate deliberately: evaluating a gate for a
    stage that is switched off would report ``skipped`` reasons for a stage that
    was never going to run, and the skip reasons are the numbers the gate is
    judged by.
    """
    if not facts.stage_enabled(spec.id):
        return StageOutcome(stage_id=spec.id, status="disabled", reason="flag_off")
    decision = spec.gate(facts)
    if not decision.run:
        return StageOutcome(stage_id=spec.id, status="skipped", reason=decision.reason or "gate")
    return None


def schedule_post_answer_stages(
    facts: TurnFacts,
    *,
    llms: Mapping[AgentGroup, Any] | None = None,
) -> list[asyncio.Task]:
    """Schedule every registered stage for one finished turn. Never blocks.

    Returns the created tasks (one per stage, including the tasks that only
    record a skip). The caller does not await them: the answer is already
    written, and the whole point of a stage is that the answer path never waits
    on it.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.debug("Post-answer stages skipped: no running event loop")
        return []

    tasks: list[asyncio.Task] = []
    for spec in iter_stages():
        try:
            task = _schedule_one(loop, spec, facts, llms)
        except Exception:
            # Scheduling runs inline on the answer path. Nothing it does may
            # surface as a user-facing failure, including a gate that raises.
            logger.exception("Could not schedule post-answer stage %s (non-fatal)", spec.id)
            continue
        if task is not None:
            tasks.append(task)
    return tasks


def _schedule_one(
    loop: asyncio.AbstractEventLoop,
    spec: StageSpec,
    facts: TurnFacts,
    llms: Mapping[AgentGroup, Any] | None,
) -> asyncio.Task | None:
    outcome = _pre_run_outcome(spec, facts)
    llm: Any = None
    if outcome is None:
        llm = _resolve_llm(spec, llms)
        if llm is None:
            # The capability bit: a stage whose agent group resolves no LLM is a
            # no-op, exactly as reflection is today with no reflection LLM built.
            outcome = StageOutcome(stage_id=spec.id, status="disabled", reason="no_llm")
    if outcome is None and len(_handler_tasks) >= _MAX_PENDING:
        outcome = StageOutcome(stage_id=spec.id, status="skipped", reason="pending_cap")
    if outcome is None and not _claim(spec, facts):
        outcome = StageOutcome(stage_id=spec.id, status="skipped", reason="duplicate")

    if outcome is not None:
        # Recorded from a task rather than inline: the span post is blocking I/O
        # and the answer's first token is still waiting behind this function.
        return _track(loop.create_task(_record_only(spec, facts, outcome)), handler=False)

    return _track(loop.create_task(_run_stage(spec, StageContext(facts=facts, llm=llm))), handler=True)


def _track(task: asyncio.Task, *, handler: bool) -> asyncio.Task:
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    if handler:
        _handler_tasks.add(task)
        task.add_done_callback(_handler_tasks.discard)
    return task


def _identity(facts: TurnFacts) -> dict[str, str | None]:
    return {"organization_id": facts.organization_id, "conversation_id": facts.conversation_id}


async def _record_only(spec: StageSpec, facts: TurnFacts, outcome: StageOutcome) -> StageOutcome:
    """Emit the span for a stage that never ran. The reason it did not run is the
    whole value of the row."""
    await _emit_span(spec, facts, outcome)
    return outcome


async def _emit_span(spec: StageSpec, facts: TurnFacts, outcome: StageOutcome) -> None:
    """One profiler span per terminal state, carrying the outcome.

    ``outcome`` and ``reason`` land in the span's ``metadata`` jsonb, which turns
    "how often did this stage fire, succeed, time out, or skip and why" into a
    GROUP BY. Never raises: telemetry may not be the thing that breaks a stage.
    """
    try:
        from aiq_agent.common.profiler import track_agent_profile

        metadata = {"stage": spec.id, "outcome": outcome.status, "reason": outcome.reason}
        with track_agent_profile(agent_name=f"stage:{spec.id}", identity=_identity(facts), metadata=metadata):
            pass
    except Exception:
        logger.warning("Could not record the span for stage %s", spec.id, exc_info=True)


async def _run_stage(spec: StageSpec, ctx: StageContext) -> StageOutcome:
    """Run one stage under the shared semaphore, the declared timeout, cost
    tracking and a span. Records an outcome for every path out."""
    facts = ctx.facts
    started = time.monotonic()
    payload: dict[str, Any] | None = None
    status = "failed"
    reason: str | None = "unknown"

    from aiq_agent.common.cost_tracking import BudgetSnapshot
    from aiq_agent.common.cost_tracking import track_llm_costs
    from aiq_agent.common.profiler import track_agent_profile

    metadata: dict[str, Any] = {"stage": spec.id, "outcome": "failed", "reason": "unknown"}
    try:
        loop = asyncio.get_running_loop()
        async with _loop_semaphore(loop):
            with (
                track_agent_profile(agent_name=f"stage:{spec.id}", identity=_identity(facts), metadata=metadata),
                track_llm_costs(
                    identity={
                        "organization_id": facts.organization_id,
                        "user_id": facts.user_id,
                        "project_id": facts.project_id,
                        "conversation_id": facts.conversation_id,
                    },
                    # Empty on purpose: a post-answer stage is never hard-stopped
                    # by a budget it did not spend against, but its spend is
                    # still written to llm_usage_events.
                    budget=BudgetSnapshot(),
                ) as tracker,
            ):
                try:
                    result = await asyncio.wait_for(spec.handler(ctx), timeout=spec.timeout_s)
                except TimeoutError:
                    status, reason = "timeout", None
                    logger.warning("Stage %s timed out after %ss", spec.id, spec.timeout_s)
                except asyncio.CancelledError:
                    # Loop teardown, not a stage fault. Propagate rather than
                    # recording an outcome nobody is left to read.
                    raise
                except Exception as exc:
                    status, reason = "failed", type(exc).__name__
                    logger.exception("Stage %s failed (non-fatal)", spec.id)
                else:
                    status, reason, payload = _validate(spec, result)
                # Read by track_agent_profile at teardown, which is why it is
                # filled in before leaving the block.
                metadata["outcome"] = status
                metadata["reason"] = reason
                metadata.update(_cost_metadata(tracker))
    except asyncio.CancelledError:
        raise
    except Exception:
        # The semaphore, the trackers, the profiler — anything out here failing
        # is still a stage failure and still gets an outcome.
        status, reason = "failed", "runner_error"
        logger.exception("Stage %s: the runner itself failed (non-fatal)", spec.id)

    outcome = StageOutcome(
        stage_id=spec.id,
        status=status,  # type: ignore[arg-type]
        reason=reason if status in {"skipped", "failed", "disabled", "empty"} else None,
        payload=payload if status == "ready" else None,
        duration_ms=max(0, round((time.monotonic() - started) * 1000)),
    )
    if spec.delivery == "frame" and status in {"ready", "empty", "failed", "timeout"}:
        await deliver_stage_frame(facts.conversation_id, build_stage_frame(spec, facts, outcome))
    return outcome


def _cost_metadata(tracker: Any) -> dict[str, Any]:
    """What the stage actually spent, for the span that already carries its
    outcome and duration.

    It goes HERE and not only into ``llm_usage_events`` because that ledger has
    no stage dimension — it records model, tokens and cost against the
    conversation, so two stages on one turn are one undifferentiated pair of
    rows. "What does this stage cost per turn" is only a GROUP BY if the number
    sits on the span that already knows which stage it was.
    """
    if tracker is None:
        return {}
    try:
        return {
            "prompt_tokens": tracker.prompt_tokens,
            "completion_tokens": tracker.completion_tokens,
            "cost_usd": round(tracker.turn_cost_usd, 6),
            "llm_calls": tracker.events_recorded,
        }
    except Exception:
        logger.warning("Could not read stage cost from the tracker", exc_info=True)
        return {}


def _validate(spec: StageSpec, result: Any) -> tuple[str, str | None, dict[str, Any] | None]:
    """Classify a handler's return value, validating it against the declared
    payload model. ``None`` is ``empty`` — a first-class success: a stage that
    cannot say "nothing, on purpose" forces its handler to invent output, and
    :class:`StageEmpty` lets it say WHICH nothing without inventing a status."""
    if result is None:
        return "empty", None, None
    if isinstance(result, StageEmpty):
        return "empty", result.reason, None
    if spec.payload_model is not None:
        try:
            validated = spec.payload_model.model_validate(result)
        except Exception:
            logger.warning("Stage %s returned a payload its own model rejects", spec.id, exc_info=True)
            return "failed", "invalid_payload", None
        return "ready", None, validated.model_dump(mode="json")
    if not isinstance(result, dict):
        return "failed", "invalid_payload", None
    return "ready", None, result
